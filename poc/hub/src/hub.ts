import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { staticHandler } from "multiplayer-ai-server/staticFiles";
import { slugify } from "multiplayer-ai-server/workspace";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseUpFrame,
  type DownFrame,
} from "multiplayer-ai-server/relayProtocol";
import { HubStore, type MachineInfo } from "./hubStore.js";

const SLUG = /^[a-z0-9-]{1,40}$/;
const PROJECT_PUSH_INTERVAL_MS = 1000;

/** Answered from the hub's own store rather than tunnelled: only the hub sees
 *  every laptop, so only the hub can answer them (spec §3.2). */
const HUB_HANDLED = new Set(["watch_project", "peek"]);

interface BrowserChannel {
  channelId: string;
  socket: WebSocket;
  projectId: string | null;
  sessionId: string | null;
  identity: { userId: string; name: string } | null;
  /** Set the moment the hub routes a `create_session` to a specific uplink
   *  (spec §5.3 step 4). A narrower capability than session ownership: this
   *  one uplink, this one channel, exactly once — for the case a reply must
   *  reach a channel that has joined no session, which `sessionId`-based
   *  ownership cannot express because no session exists yet to own.
   *
   *  Cleared on ACCEPTANCE, not on delivery: the reply-narrowcast branch
   *  spends the grant before it looks at `frame.payload`, so a payload-less
   *  reply still burns the single use even though nothing is sent to the
   *  browser. Also cleared by `join` (the grant must not survive rebinding
   *  the channel to a different machine's session) and by the browser's
   *  socket closing. A grant that gets neither a reply nor a join — the
   *  routed machine crashed or simply never answers — has no other expiry:
   *  it lives, unusable by anything but that one uplink, until this socket
   *  closes. That is a deliberately accepted bound, not an oversight; adding
   *  a time-based expiry for it was considered and rejected as unneeded
   *  complexity for an edge case this plan does not need to close further. */
  pendingReplyFrom: string | null;
}

export interface HubOptions {
  port: number;
  host?: string;
  /** Built client directory. The hub serves the browser surface; laptops
   *  serve nothing once they are hub-attached. */
  staticDir?: string;
}

export interface RunningHub {
  port: number;
  close: () => Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<RunningHub> {
  const store = new HubStore();
  const uplinks = new Map<string, WebSocket>();
  const channels = new Map<string, BrowserChannel>();
  const lastPush = new Map<string, number>();
  const pushTimers = new Map<string, NodeJS.Timeout>();
  const serveStatic = opts.staticDir ? staticHandler(opts.staticDir) : null;

  const send = (socket: WebSocket, msg: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };
  const down = (socket: WebSocket, frame: DownFrame) => send(socket, frame);

  function pushProject(projectId: string): void {
    const timer = pushTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      pushTimers.delete(projectId);
    }
    const payload = store.snapshot(projectId);
    for (const channel of channels.values()) {
      if (channel.projectId === projectId) send(channel.socket, payload);
    }
    lastPush.set(projectId, Date.now());
  }

  /** The project directory changed. Every browser sees every project (spec
   *  P2), so this is a broadcast rather than a per-project narrowcast. */
  function pushProjects(): void {
    const payload = { type: "projects", projects: store.listProjects() };
    for (const channel of channels.values()) send(channel.socket, payload);
  }

  /** The same 1s leading+trailing throttle the server uses (server.ts's
   *  `schedulePush`) and for the same reason: a hot event stream must not
   *  become a snapshot storm. Keeping the interval identical also keeps the A3
   *  lesson true — anything whose display changes with elapsed time needs a
   *  client tick. */
  function schedulePush(projectId: string): void {
    if (pushTimers.has(projectId)) return;
    const elapsed = Date.now() - (lastPush.get(projectId) ?? 0);
    if (elapsed >= PROJECT_PUSH_INTERVAL_MS) {
      pushProject(projectId);
      return;
    }
    pushTimers.set(
      projectId,
      setTimeout(() => {
        pushTimers.delete(projectId);
        pushProject(projectId);
      }, PROJECT_PUSH_INTERVAL_MS - elapsed),
    );
  }

  /** `stored` holds the store's own live instances (see `HubStore.publish`) —
   *  read, never written. */
  function fanOut(
    projectId: string,
    sessionId: string,
    stored: readonly { event: unknown }[],
  ): void {
    for (const channel of channels.values()) {
      if (channel.projectId !== projectId || channel.sessionId !== sessionId) continue;
      for (const item of stored) send(channel.socket, { type: "event", event: item.event });
    }
  }

  const httpServer = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // BEFORE the static handler, for the reason A1a documented at
    // staticFiles.ts:51-53: the SPA fallback serves index.html for any
    // extensionless path, so a health route wired after it returns HTML with
    // a 200 and the probe passes forever while the hub is broken.
    if (pathname === "/healthz" || pathname === "/healthz/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      return;
    }
    if (serveStatic) {
      serveStatic(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  // maxPayload is applied here, before any gate, because the upgrade completes
  // before authentication — a limit that only protects authenticated peers
  // protects nothing (spec §10.2). `ws` otherwise defaults to 100MB.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES });

  wss.on("connection", (socket: WebSocket, req) => {
    // Without a listener an "error" is an unhandled EventEmitter error and
    // crashes the process; "close" always follows and does the cleanup.
    socket.on("error", () => {});
    if ((req.url ?? "/").startsWith("/uplink")) handleUplink(socket);
    else handleBrowser(socket);
  });

  function handleUplink(socket: WebSocket): void {
    let uplinkId: string | null = null;
    let projectId: string | null = null;
    /** Session ids this socket has already been told it does not own. One
     *  identity per socket, so this IS a `(uplinkId, sessionId)` latch. A
     *  collision is permanent — ownership never expires — while `server.ts`
     *  republishes facts for every session on every throttled push, so without
     *  a latch the report repeats once a second for as long as the losing
     *  laptop is active. Scoped to the socket rather than the store so it dies
     *  with the connection and leaks nothing. */
    const reportedCollisions = new Set<string>();

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, "invalid JSON");
        return;
      }
      const frame = parseUpFrame(parsed);
      if (!frame) {
        // A frame this hub cannot understand is a protocol fault, not a
        // recoverable message. 1008 = policy violation.
        socket.close(1008, "bad frame");
        return;
      }
      if (frame.t === "hello") {
        // One identity per socket, the mirror of "hello first" below. A second
        // hello would register a second id in `uplinks` that the close handler
        // (which only knows the last one) can never reclaim — leaving a dead
        // socket registered and its sessions reading `online` forever, while
        // every command tunnelled to it is silently dropped.
        if (uplinkId) {
          socket.close(1008, "already identified");
          return;
        }
        // Replacing a live socket under the same id is CORRECT — a laptop
        // whose connection died must be able to reconnect before the hub has
        // noticed the old one is gone. It is also indistinguishable, from
        // here, from two daemons sharing one MPAI_HOME: both read the same
        // persisted machineId, so each hello evicts the other and the two flap
        // forever, with every browser watching a machine blink. Nothing else
        // in the system can name that cause, so this line does (spec §12.2).
        const superseded = uplinks.get(frame.uplinkId);
        if (superseded && superseded !== socket && superseded.readyState === WebSocket.OPEN) {
          console.error(
            `uplink ${frame.uplinkId}: superseded by a new connection (same machineId from two daemons? check MPAI_HOME)`,
          );
        }
        uplinkId = frame.uplinkId;
        projectId = frame.projectId;
        uplinks.set(frame.uplinkId, socket);
        store.attach(
          frame.uplinkId,
          frame.projectId,
          frame.name,
          frame.repos,
          new Date().toISOString(),
        );
        down(socket, {
          t: "welcome",
          v: RELAY_PROTOCOL_VERSION,
          have: store.resumeOffsets(frame.uplinkId),
        });
        schedulePush(frame.projectId);
        return;
      }
      if (!uplinkId || !projectId) {
        socket.close(1008, "hello first");
        return;
      }
      if (frame.t === "repos") {
        // Wholesale replacement, never a merge — the frame is the machine's
        // full authoritative list (spec §5.2). The push matters as much as the
        // store write: the repo picker in every open browser is built from
        // this, so an attach that lands and is never pushed is an attach
        // nobody can use until something else happens to trigger a snapshot.
        store.setRepos(uplinkId, frame.repos);
        schedulePush(projectId);
        return;
      }
      if (frame.t === "publish") {
        // A laptop may publish only for sessions it owns; the store checks
        // ownership and returns nothing for a session it does not own
        // (spec §3.5 rule 2).
        const accepted = store.publish(uplinkId, frame.sessionId, frame.runId, frame.events);
        if (accepted.length > 0) {
          fanOut(projectId, frame.sessionId, accepted);
          schedulePush(projectId);
        }
        return;
      }
      if (frame.t === "facts") {
        const result = store.setFacts(uplinkId, frame.sessionId, frame.runId, frame.facts);
        if (!result.ok) {
          // Drop the FRAME, never the socket. A name collision is a permanent,
          // PER-SESSION condition (ownership never expires), and two engineers
          // naming a session "auth" in the default project is the ordinary
          // case for a cross-repo hub — as is a same-machine restart, which is
          // indistinguishable from it. Closing the transport would punish
          // every OTHER session that laptop owns: `server.ts`'s throttled push
          // republishes facts for every session roughly once a second, so the
          // close re-fires on that cadence while `relay.ts` reconnects every
          // 2s and swallows it, and the laptop flaps ONLINE/OFFLINE in every
          // browser forever with no log line on either side.
          //
          // Reported ONCE per (uplinkId, sessionId), and only to the hub's
          // console. Deliberately NOT narrowcast to browsers: the channels
          // joined to this sessionId belong to the laptop that legitimately
          // OWNS it, so an error there would tell the users whose session is
          // working fine that it is broken — once a second, into a client
          // error list that has no cap and no dedup. The party that needs to
          // know is the losing laptop's operator, and this is the surface they
          // have until the protocol carries a per-frame rejection.
          if (!reportedCollisions.has(frame.sessionId)) {
            reportedCollisions.add(frame.sessionId);
            console.error(`uplink ${uplinkId}: ${result.error} (facts frame dropped)`);
          }
          return;
        }
        schedulePush(projectId);
        return;
      }
      // frame.t === "reply" — narrowcast back to the browser that asked.
      const channel = channels.get(frame.channelId);
      if (!channel) return;
      // A laptop may answer only on a channel it has a standing right to
      // answer on — either of two, and only two, shapes of that right.
      // `channels` is hub-wide, so without one of these two checks a laptop
      // that learns another's channel id could inject any message into that
      // browser's socket. Cheap now, load-bearing once the trust inversion
      // lands (spec §3.5).
      //
      // 1. Joined a session it owns — the ordinary case, unbounded in time
      //    for as long as it owns the session.
      const sessionOwned =
        !!channel.projectId &&
        !!channel.sessionId &&
        store.ownerOf(channel.projectId, channel.sessionId) === uplinkId;
      // 2. Routed here by `create_session` (spec §5.3 step 4) — the channel
      //    has joined no session, so there is no session to own yet. This is
      //    a narrower capability than #1: single-use (cleared the instant it
      //    is spent, below) and scoped to the one uplink the hub actually
      //    tunnelled the request to, not any uplink that later claims the
      //    resulting session name.
      const routedHere = channel.pendingReplyFrom === uplinkId;
      if (routedHere) channel.pendingReplyFrom = null;
      if (!sessionOwned && !routedHere) return;
      // `parseUpFrame` admits a reply with no payload, and `JSON.stringify`
      // turns that into a zero-length frame the browser's JSON.parse throws on.
      if (frame.payload !== undefined) send(channel.socket, frame.payload);
    });

    socket.on("close", () => {
      if (!uplinkId) return;
      // A laptop that reconnected under the same uplinkId has already replaced
      // this socket, so the late close of the superseded one must neither
      // unregister nor mark offline the live uplink.
      if (uplinks.get(uplinkId) !== socket) return;
      uplinks.delete(uplinkId);
      // The sessions stay — that is the hub's payoff. What must not stay is
      // the illusion that they can be driven (spec §8).
      store.detach(uplinkId);
      if (projectId) schedulePush(projectId);
    });
  }

  function handleBrowser(socket: WebSocket): void {
    // Assigned here and never read from the client: a client-chosen channel id
    // would let one browser address another's tunnel (spec §10.4).
    const channelId = randomUUID();
    const channel: BrowserChannel = {
      channelId,
      socket,
      projectId: null,
      sessionId: null,
      identity: null,
      pendingReplyFrom: null,
    };
    channels.set(channelId, channel);

    const error = (message: string) => send(socket, { type: "error", message });

    const tunnel = (payload: unknown): void => {
      if (!channel.projectId || !channel.sessionId || !channel.identity) {
        error("join a session first");
        return;
      }
      const owner = store.ownerOf(channel.projectId, channel.sessionId);
      const uplink = owner ? uplinks.get(owner) : undefined;
      if (!uplink) {
        error(`no machine is running session "${channel.sessionId}" right now`);
        return;
      }
      down(uplink, { t: "tunnel", channelId, identity: channel.identity, payload });
    };

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return error("invalid JSON");
      }

      /** Identity is per CONNECTION, not per join (spec P4): `create_session`
       *  is routed to a machine before any session exists, and `tunnel()`
       *  requires an identity to stamp. Same validation as `join`, in the same
       *  order — the hub must reject precisely what the laptop rejects. */
      if (msg?.type === "identify") {
        // Mirrors `join`'s "already joined" guard, for the same reason. A join
        // binds this channel's identity; without this, a later `identify`
        // could rebind it at will, and every membership decision that follows
        // — `join_project`, `create_session`, `set_project_lifecycle` — would
        // be attributed to whoever the channel most recently claimed to be.
        // Spec §5.1 makes this the field the hub will VERIFY later; a field
        // that can be overwritten mid-connection cannot become that.
        if (channel.sessionId) return error("already joined");
        if (typeof msg.userId !== "string" || typeof msg.name !== "string") {
          return error("identify requires userId, name");
        }
        const userId = msg.userId.slice(0, 64);
        const name = msg.name.slice(0, 40);
        // An empty userId produces a `tunnel` frame the laptop's
        // parseDownFrame drops on the floor — identity that fails in silence.
        if (!userId) return error("identify requires userId");
        channel.identity = { userId, name };
        send(socket, { type: "identified", userId, name });
        return;
      }

      if (msg?.type === "list_projects") {
        send(socket, { type: "projects", projects: store.listProjects() });
        return;
      }

      if (msg?.type === "create_project") {
        if (!channel.identity) return error("identify first");
        if (typeof msg.name !== "string") return error("create_project requires name");
        const projectId = slugify(msg.name.slice(0, 200));
        if (!SLUG.test(projectId)) return error("create_project requires a usable name");
        const created = store.createProject(
          projectId,
          msg.name.slice(0, 60),
          channel.identity.userId,
          new Date().toISOString(),
        );
        if (!created.ok) return error(created.error);
        send(socket, { type: "project_created", projectId });
        pushProjects();
        return;
      }

      if (msg?.type === "join_project" || msg?.type === "leave_project") {
        if (!channel.identity) return error("identify first");
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error(`${msg.type} requires a valid projectId`);
        if (store.lifecycleOf(projectId) === null) return error(`no project "${projectId}"`);
        if (msg.type === "join_project" && store.lifecycleOf(projectId) !== "active") {
          return error(`project "${projectId}" is not open to new members`);
        }
        if (msg.type === "join_project") store.joinProject(projectId, channel.identity.userId);
        else store.leaveProject(projectId, channel.identity.userId);
        pushProjects();
        return;
      }

      if (msg?.type === "set_project_lifecycle") {
        if (!channel.identity) return error("identify first");
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error("set_project_lifecycle requires a valid projectId");
        const lifecycle = msg.lifecycle;
        if (lifecycle !== "active" && lifecycle !== "closed" && lifecycle !== "archived") {
          return error("lifecycle must be active, closed or archived");
        }
        // Participation is membership-scoped (spec P2). Visibility is not.
        if (!store.isMember(projectId, channel.identity.userId)) {
          return error("join this project before changing it");
        }
        const result = store.setLifecycle(projectId, lifecycle);
        if (!result.ok) return error(result.error);
        pushProjects();
        return;
      }

      if (msg?.type === "join") {
        // The browser-facing protocol is the standalone server's, byte for
        // byte, so a second join is refused exactly as server.ts's join
        // handler refuses one. Without this the hub would rebind the channel
        // to a new session BEFORE tunnelling — and if that session lives on a
        // different laptop, the first laptop never receives a `detach` (the
        // close handler only notifies the current owner) and its roster keeps
        // a ghost participant for the life of the process.
        if (channel.sessionId) return error("already joined");
        // The same typeof triple, in the same order, as server.ts's join
        // handler — which runs it BEFORE the relay identity stamp overwrites
        // userId/name. A join the hub accepts and the laptop rejects is a
        // divergence between the two, so the hub must reject exactly what the
        // laptop rejects. The payload is still forwarded untouched, which is
        // `DownFrame`'s contract.
        if (
          typeof msg.sessionId !== "string" ||
          typeof msg.userId !== "string" ||
          typeof msg.name !== "string"
        ) {
          return error("join requires sessionId, userId, name");
        }
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId) || !SLUG.test(msg.sessionId)) {
          return error("projectId and sessionId must be 1-40 chars of a-z, 0-9, -");
        }
        const sessionId: string = msg.sessionId;
        // v7b1 runs with auth OFF and takes the browser's word, exactly as a
        // standalone server does with auth off. v7b2 replaces these two lines
        // with the hub's cookie-verified GitHub login, which is what makes the
        // trust inversion (spec §3.5 rule 1) real. Until then this hub must
        // not be exposed to the internet.
        const userId = msg.userId.slice(0, 64);
        const name = msg.name.slice(0, 40);
        // An empty userId would produce a `tunnel` frame the laptop's
        // parseDownFrame drops on the floor — a join that fails in silence.
        if (!userId) return error("join requires userId");

        const owner = store.ownerOf(projectId, sessionId);
        if (!owner || !uplinks.has(owner)) {
          return error(`no machine is running session "${sessionId}" right now`);
        }
        channel.projectId = projectId;
        channel.sessionId = sessionId;
        channel.identity = { userId, name };
        // A create_session this channel routed earlier and never got a reply
        // for (crashed machine, hung machine, browser gave up and joined
        // something else) must not survive into this new binding. Without
        // this, the originally-routed machine could still push one arbitrary
        // payload into a session that now belongs to a different machine.
        channel.pendingReplyFrom = null;

        // Replay from the HUB's store, not from the laptop (spec §3.2). This
        // is what makes a watcher free: the laptop never learns this browser
        // exists, so watchers joining and leaving cost its uplink nothing.
        // These are the store's live instances — read, never written.
        for (const stored of store.eventsFor(projectId, sessionId, 0)) {
          send(socket, { type: "event", event: stored.event });
        }
        send(socket, store.snapshot(projectId));
        // Still tunnelled, because presence, the roster and the wheel are
        // laptop-owned facts (spec §3.1) — the hub does not invent them.
        tunnel(msg);
        return;
      }

      /** Routed to a machine, not answered here: provisioning a worktree needs
       *  the repo, which only a machine has. It cannot use `tunnel()` either —
       *  that presupposes a joined session (spec P5).
       *
       *  The payload is forwarded UNTOUCHED (`DownFrame`'s contract). The
       *  browser has already picked a free name (spec P6); this only refuses a
       *  name a different machine owns.
       *
       *  The `session_created` reply DOES need handling here, and this is the
       *  one line of it: `channel.pendingReplyFrom = target.machineId` below.
       *  The reply itself still travels over the pre-existing `reply` frame
       *  (relay.ts:252) and lands in the same narrowcast branch every other
       *  reply does — but that branch's guard authorizes by SESSION OWNERSHIP
       *  (`store.ownerOf`), and the session being created does not exist yet,
       *  so nobody owns it. In the browser's flow the channel has also joined
       *  no session at all (spec P5, again) — but nothing here ENFORCES that:
       *  unlike `join` and `identify`, this branch does not check
       *  `channel.sessionId`, so a channel that has already joined can
       *  legitimately reach it, and then `sessionOwned` authorizes only its
       *  OWN session's replies, never this one's. Either way the grant below
       *  is what carries the reply. Without it the guard has nothing to
       *  authorize on and drops the reply every time — which is exactly the
       *  bug this comment used to claim couldn't happen. Do not delete
       *  `pendingReplyFrom` as
       *  "redundant" with `sessionOwned`: it is the only thing that makes a
       *  create-flow reply deliverable at all. */
      if (msg?.type === "create_session") {
        if (!channel.identity) return error("identify first");
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error("create_session requires a valid projectId");
        if (!store.isMember(projectId, channel.identity.userId)) {
          return error("join this project before creating a session");
        }
        if (store.lifecycleOf(projectId) !== "active") {
          return error(`project "${projectId}" is not open`);
        }
        if (typeof msg.name !== "string" || msg.name.length === 0) {
          return error("create_session requires name");
        }
        const repoKey = typeof msg.repoKey === "string" ? msg.repoKey : "";
        if (!repoKey) return error("create_session requires repoKey");
        // `machineId` is OPTIONAL (spec §5.2). Two machines can offer the same
        // repo, so first-online-match is a coin toss between them; naming one
        // is how a user says "run it over there". Absent, the old behaviour
        // stands — which is what keeps a one-machine project a two-field form.
        const requestedMachine =
          typeof msg.machineId === "string" && msg.machineId ? msg.machineId : null;
        // ATTACHED only: a candidate is a repo this machine could work in, not
        // one it can host a session in yet — it has no workspace, so routing
        // there produces a refusal the browser cannot explain.
        const offers = (m: MachineInfo) => m.repos.some((r) => r.attached && r.key === repoKey);
        const machines = store.machinesIn(projectId);
        let target: MachineInfo | undefined;
        if (requestedMachine) {
          const named = machines.find((m) => m.machineId === requestedMachine);
          // Three distinct refusals, deliberately: "that machine is gone" and
          // "that machine does not have this repo" send a user to completely
          // different fixes, and collapsing either into the generic "nobody is
          // offering it" would send them looking for a problem elsewhere while
          // another machine sits there holding the repo.
          if (!named || !named.online || !uplinks.get(named.machineId)) {
            return error(`machine "${requestedMachine}" is not online right now`);
          }
          if (!offers(named)) return error(`that machine is not offering repo "${repoKey}"`);
          target = named;
        } else {
          target = machines.find((m) => m.online && offers(m));
        }
        const uplink = target ? uplinks.get(target.machineId) : undefined;
        if (!target || !uplink) {
          return error(`no machine is offering repo "${repoKey}" right now`);
        }
        const desired = slugify(msg.name.slice(0, 200));
        // SLUG.test(), not a truthiness check: every id reaching HubStore is
        // shape-validated at the point of use (Task 5), not by inheriting a
        // guarantee from slugify's current internals. Mirrors create_project
        // (hub.ts:339-340), which validates the same way after the same call.
        if (!SLUG.test(desired)) return error("create_session requires a usable name");
        const owner = store.ownerOf(projectId, desired);
        if (owner !== null && owner !== target.machineId) {
          return error(`session "${desired}" is already used by another machine in this project`);
        }
        // Grants the single-use reply capability checked at hub.ts's reply
        // handler (`routedHere`): this channel has joined no session, so
        // ownership cannot authorize the coming `session_created` reply —
        // only "the hub itself just routed a request to this exact uplink"
        // can (spec §5.3 step 4).
        channel.pendingReplyFrom = target.machineId;
        down(uplink, { t: "tunnel", channelId, identity: channel.identity, payload: msg });
        return;
      }

      if (HUB_HANDLED.has(msg?.type)) {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error(`${msg.type} requires a valid projectId`);
        // Never re-home a channel that has joined a session: `fanOut` keys on
        // projectId AND sessionId, so re-homing would silently cut the joined
        // session's event stream. Such a socket still gets the snapshot it
        // asked for; it just keeps receiving pushes for its session's project.
        if (msg.type === "watch_project" && !channel.sessionId) channel.projectId = projectId;
        send(socket, store.snapshot(projectId));
        return;
      }

      tunnel(msg);
    });

    socket.on("close", () => {
      channels.delete(channelId);
      if (!channel.projectId || !channel.sessionId) return;
      const owner = store.ownerOf(channel.projectId, channel.sessionId);
      const uplink = owner ? uplinks.get(owner) : undefined;
      // Tell the laptop, or presence_leave never fires and the roster keeps a
      // ghost for the rest of that process's life.
      if (uplink) down(uplink, { t: "detach", channelId });
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    wss.once("error", onError);
    httpServer.once("listening", () => {
      httpServer.removeListener("error", onError);
      wss.removeListener("error", onError);
      resolve();
    });
    httpServer.listen(opts.port, opts.host);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of pushTimers.values()) clearTimeout(timer);
        pushTimers.clear();
        for (const client of wss.clients) client.terminate();
        // Detaches the `upgrade` listener from the http server. The http
        // server owns the socket, so this is not what stops the listening —
        // it just leaves nothing attached to reason about.
        wss.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
