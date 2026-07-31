import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { staticHandler } from "multiplayer-ai-server/staticFiles";
import { authRoutes, requireAuth, type AuthConfig } from "multiplayer-ai-server/auth";
import { slugify } from "multiplayer-ai-server/workspace";
import { projectRecordFrom } from "multiplayer-ai-server/record";
import { collisionsFrom, TOUCH_CAP, TOUCH_SENTINEL } from "multiplayer-ai-server/collisions";
import type { Collision } from "multiplayer-ai-server/collisions";
import type { ProjectMessage } from "multiplayer-ai-server/project";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseUpFrame,
  type DownFrame,
} from "multiplayer-ai-server/relayProtocol";
import { HubStore, type MachineInfo } from "./hubStore.js";
import { HubDb } from "./hubDb.js";

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
  /** Where the record lives (spec §3.1). Absent → no record at all: the hub is
   *  the ephemeral in-memory one it has always been. `":memory:"` is the
   *  explicit way to ask for that on purpose (spec §3.6). */
  dbPath?: string;
  /** Test seam: an already-open record. Takes precedence over `dbPath`, which
   *  is then never even opened. Production wiring passes `dbPath` and lets this
   *  function do the opening — that is what keeps `hubDb.ts`'s lock-skipping
   *  crash-test option out of every path a real hub takes (this file must never
   *  name it; a repo-wide grep pins that). */
  db?: HubDb;
  /** How the hub dies when a write to the record fails. Defaults to
   *  `defaultFatal`; a test passes a spy so the failure is observable without
   *  killing the runner. */
  fatal?: (err: Error) => void;
  /** GitHub auth (spec §4). Undefined → auth off: `authRoutes` is still mounted
   *  so /auth/me answers `{enabled:false}` instead of the SPA fallback. The
   *  hub reuses the server package's auth module unchanged. */
  auth?: AuthConfig;
}

/** Fail-stop (spec §3.6): log the error and stop the process. No catch-and-
 *  carry-on, because carrying on means memory ahead of the record — the hub
 *  would keep serving and fanning out history the record cannot back, and
 *  `resumeOffsets` would tell the owning laptop not to re-send it.
 *
 *  **Blast radius, deliberately (spec §8a.7, recorded policy).** One failed
 *  write takes the whole hub down — every connected uplink and every browser,
 *  not just the session that was publishing. Disk-full (the endpoint of the
 *  unbounded journal) therefore crash-loops on the first publish after each
 *  restart. Operator recovery, in this order (spec §8a ruling 7):
 *
 *  1. **BACK UP FIRST** — copy the `hub.db` + `hub.db-wal` + `hub.db-shm` trio
 *     to safe storage. The journal is the product's sole record; a botched
 *     recovery loses it permanently.
 *  2. Free disk space, or move/compact the trio TOGETHER — moving `hub.db`
 *     alone strands committed WAL data.
 *  3. `HUB_DB=:memory:` for degraded, ephemeral service while the record is
 *     being repaired.
 *
 *  A CORRUPT `hub.db` has no recovery before §8.10's backups land: the record
 *  to that point is lost unless the operator kept copies. A newer-schema
 *  refusal (a hub version rollback) recovers by running the newer hub again or
 *  restoring the pre-upgrade backup — the back-up-before-upgrade convention,
 *  ruling 7 again. */
export function defaultFatal(err: Error): void {
  console.error(err);
  process.exit(1);
}

export interface RunningHub {
  port: number;
  close: () => Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<RunningHub> {
  const fatal = opts.fatal ?? defaultFatal;
  // `opts.db` first, and `new HubDb(dbPath)` with NO SECOND ARGUMENT: the
  // constructor's options object is the crash-test seam only (hubDb.ts), and a
  // production hub that opted out of the PID lock would let two writers
  // interleave one journal.
  //
  // Anything thrown here — unopenable file, corrupt file, newer schema, lock
  // held by a live hub — rejects this promise before a socket is created, so a
  // hub that cannot honor the record it was pointed at never serves (spec §3.6).
  const db = opts.db ?? (opts.dbPath === undefined ? null : new HubDb(opts.dbPath));
  let store: HubStore;
  if (db) {
    try {
      store = new HubStore(db, db.load());
    } catch (err) {
      // A read that fails AFTER the handle opened still refuses the boot — and
      // must not leave the lock behind, or an in-process retry would report a
      // holder that is this very process. Only what this function opened is
      // closed; a caller's `db` stays the caller's to close.
      if (!opts.db) db.close();
      throw err;
    }
  } else {
    store = new HubStore();
  }
  const uplinks = new Map<string, WebSocket>();
  /** The last `contested` frame sent for each session, so a push only writes
   *  down an uplink when that session's collision state actually CHANGED
   *  (spec §6a). Without it every push would re-send every session's frame once
   *  a second, forever, to every attached laptop.
   *
   *  Keyed by (projectId, sessionId) rather than by the bare sessionId the
   *  plan's shape names: session ids are unique per PROJECT, not per hub — two
   *  projects each holding an "auth" would otherwise share one entry and
   *  suppress each other's frames — and both operations over this map
   *  (`emitContested`'s prune, `forgetContested`'s purge) are project-scoped,
   *  exactly like `store.snapshot` and `store.ownerOf` themselves.
   *
   *  In-memory only, never journaled, which is why a hub restart is allowed one
   *  duplicate frame per contested session: the record holds `touched`, and the
   *  first post-restart push recomputes from it with nothing to compare against
   *  (`hubRestart.test.ts`). One duplicate is acceptable; a silently missing
   *  frame is not.
   *
   *  THREE states, not two — the absent/present pair is not enough:
   *    absent  — nothing has ever been sent for this session. The producer's
   *              "still nothing contested" shortcut applies.
   *    `null`  — something WAS sent, and `forgetContested` has since purged
   *              what the laptop is believed to know. The next push must send
   *              unconditionally, INCLUDING an empty frame.
   *    a frame — the exact frame the laptop last received; compare by value.
   *  A purge that simply deleted the key would collapse `null` into `absent`
   *  and hand a purged session the shortcut, so a collision that cleared while
   *  the uplink was down would never be cleared on the laptop. */
  const lastContestedSent = new Map<
    string,
    { paths: string[]; collisions: { path: string; sessionIds: string[] }[] } | null
  >();
  const channels = new Map<string, BrowserChannel>();
  const lastPush = new Map<string, number>();
  const pushTimers = new Map<string, NodeJS.Timeout>();
  const serveStatic = opts.staticDir ? staticHandler(opts.staticDir) : null;
  // Mounted even when `opts.auth` is undefined: `authRoutes` then answers
  // /auth/me with `{enabled:false}` rather than letting it fall through to the
  // SPA fallback, which would return index.html with a 200 and leave the
  // client unable to tell "auth is off" from "auth is broken" (spec §4.2).
  const handleAuth = authRoutes(opts.auth);

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
      if (channel.projectId !== projectId) continue;
      // Membership is re-checked at fan-out, not just at watch/join time (spec
      // A5): a `leave_project` leaves `channel.projectId` set but drops the
      // membership, so a departed member is silenced here — pushes stop without
      // the socket being disconnected. `channel.identity` is always set once a
      // channel is homed onto a project (watch and join both require it).
      if (!channel.identity || !store.isMember(projectId, channel.identity.userId)) continue;
      send(channel.socket, payload);
    }
    lastPush.set(projectId, Date.now());
    // Last, on the same throttled beat as the browser snapshot and off the
    // same value: the collision set is derived from exactly the facts a
    // browser was just shown, so the two surfaces can never disagree about
    // which files are contested.
    emitContested(projectId, payload);
  }

  /** `lastContestedSent`'s key. NUL cannot appear in either half — a projectId
   *  is `SLUG`-validated here and a sessionId by `parseUpFrame` — so no pair of
   *  distinct ids can ever collide on one key. */
  const contestedKey = (projectId: string, sessionId: string) => `${projectId}\u0000${sessionId}`;

  /** PRECONDITION, and the reason a stringify is enough: both sides are built
   *  by the SAME construction below, off `collisionsFrom` output that is fully
   *  sorted (repoKey, then path, then sessionIds) with a fixed key order and no
   *  optional fields. Equality is therefore positional — a reordering would be a
   *  real change in what the hub computed, not a formatting difference — and two
   *  frames are the same frame exactly when their JSON is. */
  const sameContested = (
    a: { paths: string[]; collisions: { path: string; sessionIds: string[] }[] },
    b: { paths: string[]; collisions: { path: string; sessionIds: string[] }[] },
  ): boolean => JSON.stringify(a) === JSON.stringify(b);

  /** The `contested` down-frame (spec §6a as amended by §8a ruling 6): which of
   *  a session's files ANOTHER live session is also touching, and whose. Only
   *  the hub sees every laptop, so this is the only way a hub-attached laptop
   *  can name a peer at all — its own derivation covers just the sessions in
   *  its own process.
   *
   *  Thesis bound (§1.1): a session id, paths, and peer session ids. Nothing
   *  here reads a transcript, a prompt or a participant name, and nothing may
   *  be added that does.
   *
   *  One frame per session whose state CHANGED, written down the uplink that
   *  OWNS that session and no other — a laptop learns about its own sessions,
   *  never about a peer's. */
  function emitContested(projectId: string, payload: ProjectMessage): void {
    const collisions = collisionsFrom(
      payload.sessions.map((session) => ({
        sessionId: session.id,
        repoKey: session.repoKey,
        lifecycle: session.lifecycle,
        touched: session.touched,
      })),
    );
    // One pass over the collision list instead of one filter PER SESSION: the
    // per-session `mine` below was O(sessions × collisions) on every push. The
    // insertion order of each list is `collisions`' own order, which is already
    // (repoKey, path) ascending — the property the `paths` construction below
    // relies on — because a Map preserves the order values were appended in.
    const mineBySession = new Map<string, Collision[]>();
    for (const collision of collisions) {
      for (const id of collision.sessionIds) {
        const list = mineBySession.get(id);
        if (list === undefined) mineBySession.set(id, [collision]);
        else list.push(collision);
      }
    }
    const live = new Set<string>();
    for (const session of payload.sessions) {
      const key = contestedKey(projectId, session.id);
      live.add(key);
      const owner = store.ownerOf(projectId, session.id);
      const uplink = owner ? uplinks.get(owner) : undefined;
      // No owner, or no live socket: skip this session entirely. Nothing is
      // queued and nothing is recorded as sent — there is no replay
      // obligation, because the next push recomputes the whole thing from
      // stored facts and the reconnect purge below guarantees it is re-sent.
      if (!uplink) continue;
      // `collisionsFrom` sorts by (repoKey, path) and a session lives in
      // exactly one repo, so this is already the distinct path set in
      // ascending order — no second sort, and no chance the two lists disagree
      // about which paths were retained.
      const mine = mineBySession.get(session.id) ?? [];
      const over = mine.length > TOUCH_CAP;
      const kept = over ? mine.slice(0, TOUCH_CAP) : mine;
      const paths = kept.map((c) => c.path);
      // The producer's promise the validator deliberately does not enforce
      // (relayProtocol's `contested` note): a truncated frame ends in the
      // "…and more" sentinel, exactly as an over-cap `touched` does, so a
      // laptop can tell "nothing else is contested" from "the rest did not
      // fit". Length is then TOUCH_CAP + 1 — the widest frame the validator
      // admits, by construction.
      if (over) paths.push(TOUCH_SENTINEL);
      const next = {
        paths,
        collisions: kept.map((c) => ({ path: c.path, sessionIds: [...c.sessionIds] })),
      };
      const previous = lastContestedSent.get(key);
      // Never contested and still not: say nothing. An empty frame is the
      // CLEAR signal, and a clear that nothing preceded is noise on every
      // uplink for every session on every push. `null` is deliberately NOT
      // this case — a purged session has been told something, so its clear is
      // owed (see `lastContestedSent`'s three states).
      if (previous === undefined && next.paths.length === 0) continue;
      if (previous && sameContested(previous, next)) continue;
      down(uplink, {
        t: "contested",
        sessionId: session.id,
        paths: next.paths,
        collisions: next.collisions,
      });
      lastContestedSent.set(key, next);
    }
    // A session that left the snapshot takes its change-detection state with
    // it, or the map grows for the life of the process. Scoped to THIS
    // project's keys: another project's sessions are not in this snapshot and
    // are not gone.
    const prefix = `${projectId}\u0000`;
    for (const key of lastContestedSent.keys()) {
      if (key.startsWith(prefix) && !live.has(key)) lastContestedSent.delete(key);
    }
  }

  /** An uplink went away or re-registered: drop the change-detection state for
   *  every session it owns, so the next push re-sends that session's current
   *  frame unconditionally.
   *
   *  The hub's change detection is state the LAPTOP cannot see. A restarted
   *  laptop process has lost its `entry.contestedFrame` while the hub still
   *  holds a matching `lastContestedSent`, so comparing by value alone would
   *  suppress the resend and leave hub-sourced contested state silently empty
   *  until the collision set happened to change on its own. One redundant frame
   *  after a reconnect is acceptable; a silently missing one is not.
   *
   *  MARKED, never deleted. Deleting would make a purged session indistinguish-
   *  able from one that was never contested, and the producer's "still nothing
   *  contested" shortcut would then swallow the CLEAR frame for a collision
   *  that ended while the uplink was down — leaving that laptop showing a dead
   *  collision until the set happened to change again. `null` says "this laptop
   *  was told something; send the next state whatever it is, empty included".
   *
   *  Only keys that EXIST are marked, which keeps the shortcut intact for its
   *  real case: a session that was never contested was never sent a frame, so
   *  it has no key, so a reconnect owes it nothing and emits nothing.
   *
   *  Called from the disconnect handler BEFORE `store.detach` and from the
   *  hello/supersede path — the second is not redundant: a superseded socket's
   *  late close is guarded out of the disconnect handler entirely. */
  function forgetContested(projectId: string, uplinkId: string): void {
    for (const session of store.snapshot(projectId).sessions) {
      if (store.ownerOf(projectId, session.id) === uplinkId) {
        const key = contestedKey(projectId, session.id);
        if (lastContestedSent.has(key)) lastContestedSent.set(key, null);
      }
    }
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
    // AFTER /healthz, BEFORE serveStatic (spec §4.2): a returned `true` means
    // authRoutes consumed the request. Any /auth/* path is answered here — with
    // auth on or off — so none reaches the SPA fallback below.
    if (handleAuth(req, res)) return;
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
    // The cookie is read ONCE, here at the upgrade, and held on the channel
    // for the life of the connection: WS messages carry no cookies, so a
    // per-message re-read would have nothing to read (spec §3.5 rule 1).
    else handleBrowser(socket, req.headers.cookie);
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
        // A re-registering laptop has lost whatever contested state it held
        // (it is in-memory on its side too), so the hub must forget what it
        // believes that laptop already knows. Not redundant with the
        // disconnect hook: a supersede leaves the old socket's close guarded
        // out entirely, so nothing else on this path would ever fire.
        forgetContested(frame.projectId, frame.uplinkId);
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
        //
        // The one guarded write path, because it is the one with a fan-out
        // waiting on the other side of it. `HubStore.publish` is durable before
        // visible — a persister that throws leaves the store exactly as it was —
        // so catching HERE is what keeps that true of the WIRE too: `fatal` runs
        // and this handler returns, so no `event` frame reaches a browser, no
        // `{type:"error"}` frame invites a retry, and no snapshot is scheduled.
        // Exactly one `fatal` call per failed frame; a `fatal` that returns
        // (only a test's does — `defaultFatal` exits) still fans nothing out.
        let accepted: readonly { event: unknown }[];
        try {
          accepted = store.publish(uplinkId, frame.sessionId, frame.runId, frame.events);
        } catch (err) {
          fatal(err instanceof Error ? err : new Error(String(err)));
          return;
        }
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
      // BEFORE `detach` and before the push below. The enumeration is defined
      // in terms of the ownership the store still holds here; `detach` only
      // flips `online` today, but nothing about this purge should depend on
      // that staying true, and after the push it would be too late — the push
      // is the very one that must re-send.
      if (projectId) forgetContested(projectId, uplinkId);
      // The sessions stay — that is the hub's payoff. What must not stay is
      // the illusion that they can be driven (spec §8).
      store.detach(uplinkId);
      if (projectId) schedulePush(projectId);
    });
  }

  function handleBrowser(socket: WebSocket, cookieHeader: string | undefined): void {
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
    // The membership refusal (spec A4/A5). Carries `code: "not_a_member"` on top
    // of the standard `{type:"error", message}` shape (spec §4.2) so the browser
    // can turn "you are not in this project" into a join affordance rather than a
    // generic failure — the ONLY refusal that adds a code, and only where a
    // membership gate rejects.
    const denyMember = (message: string) =>
      send(socket, { type: "error", message, code: "not_a_member" });

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
        // Auth gate (spec §4.3, §3.5 rule 1). The cookie was read once at the
        // upgrade; on success the browser's claim is DISCARDED and the verified
        // GitHub login is stamped as both id and display name (the name lock,
        // spec §3.4). Same two rejections, in the same order, as `join` below
        // and as the standalone server's join gate — the hub must reject
        // exactly what a laptop with auth on would. Auth off → `login` is null
        // and the client's claim (with its truncation) stands verbatim.
        const auth = requireAuth(cookieHeader, opts.auth);
        if (!auth.ok) return error(auth.error);
        const userId = auth.login !== null ? auth.login : msg.userId.slice(0, 64);
        const name = auth.login !== null ? auth.login : msg.name.slice(0, 40);
        // An empty userId produces a `tunnel` frame the laptop's
        // parseDownFrame drops on the floor — identity that fails in silence.
        // A verified login is never empty, so this only guards the auth-off arm.
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
        // The trust inversion, now real (spec §3.5 rule 1). The hub verifies
        // the cookie it read once at the upgrade and stamps the verified
        // GitHub login as BOTH userId and display name, DISCARDING the
        // browser's claim above — this is the verifier the laptop's relay arm
        // assumes has already run (`server.ts`'s `io.mode === "relay"` stamp),
        // so the two never diverge. Run BEFORE the owner check and before
        // `tunnel()`, so a rejected join never reaches a laptop and the
        // identity that does is the verified one. Same two rejections, in the
        // same order, as the standalone join gate (spec §4.3). Auth off →
        // `login` is null and the browser's claim (with its truncation) stands
        // verbatim, exactly as v7b1 behaved. The join PAYLOAD is still
        // forwarded untouched (`DownFrame`'s contract); only the tunnelled
        // `identity` carries the login.
        const auth = requireAuth(cookieHeader, opts.auth);
        if (!auth.ok) return error(auth.error);
        const userId = auth.login !== null ? auth.login : msg.userId.slice(0, 64);
        const name = auth.login !== null ? auth.login : msg.name.slice(0, 40);
        // An empty userId would produce a `tunnel` frame the laptop's
        // parseDownFrame drops on the floor — a join that fails in silence.
        // A verified login is never empty, so this only guards the auth-off arm.
        if (!userId) return error("join requires userId");

        // Participation is membership-scoped (spec A4). Checked AFTER the
        // identity stamp above and BEFORE any binding, replay, snapshot or
        // tunnel, so a non-member's join dies here having touched nothing —
        // and, with auth on, the check sees the VERIFIED login, never the
        // browser's claim. This is the gate provisioning already has
        // (`create_session` hub.ts, `attach_repo`, `set_project_lifecycle`);
        // participation was the one hole (relayProtocol's "bound is project
        // membership" note, now true).
        if (!store.isMember(projectId, userId)) {
          return denyMember("join this project before joining its sessions");
        }

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

      /** Routes `attach_repo`/`detach_repo` to the named machine, mirroring
       *  `create_session`'s routing above (spec §5.3, §9): validate, set the
       *  one-slot reply grant, tunnel. Deliberately coarser than
       *  `create_session`'s `attached && key` offer check: attach targets a
       *  not-yet-attached candidate, detach targets an attached one, so only
       *  a key the machine never advertised at all is refused here — the
       *  fine-grained candidate/blocker refusals live on the laptop
       *  (Task 6). */
      if (msg?.type === "attach_repo" || msg?.type === "detach_repo") {
        if (!channel.identity) return error("identify first");
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error(`${msg.type} requires a valid projectId`);
        if (!store.isMember(projectId, channel.identity.userId)) {
          return error("join this project before changing its machines");
        }
        if (store.lifecycleOf(projectId) !== "active") {
          return error(`project "${projectId}" is not open`);
        }
        const machineId = typeof msg.machineId === "string" ? msg.machineId : "";
        const repoKey = typeof msg.repoKey === "string" ? msg.repoKey : "";
        if (!machineId || !repoKey) return error(`${msg.type} requires machineId and repoKey`);
        const machine = store.machinesIn(projectId).find((m) => m.machineId === machineId);
        const uplink = machine?.online ? uplinks.get(machineId) : undefined;
        if (!machine || !uplink) return error(`machine "${machineId}" is not online right now`);
        // Refuse before tunneling (spec §9): a key the machine never advertised
        // would only burn the channel's one reply slot on a doomed round trip.
        if (!machine.repos.some((r) => r.key === repoKey)) {
          return error(`machine "${machineId}" does not list repo "${repoKey}"`);
        }
        channel.pendingReplyFrom = machineId;
        down(uplink, { t: "tunnel", channelId, identity: channel.identity, payload: msg });
        return;
      }

      if (HUB_HANDLED.has(msg?.type)) {
        // Identity then membership (spec A5): a snapshot carries every session's
        // full `touched` change-list, so it is members-only, exactly as
        // participation is. The list itself stays hub-wide (`list_projects`) —
        // it is the join affordance — but everything deeper is gated.
        if (!channel.identity) return error("identify first");
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error(`${msg.type} requires a valid projectId`);
        if (!store.isMember(projectId, channel.identity.userId)) {
          return denyMember("join this project to see it");
        }
        // Never re-home a channel that has joined a session: `fanOut` keys on
        // projectId AND sessionId, so re-homing would silently cut the joined
        // session's event stream. Such a socket still gets the snapshot it
        // asked for; it just keeps receiving pushes for its session's project.
        // A refused (non-member) watch above never reaches this line, so it
        // never re-homes — the browser cannot subscribe to a project it is not
        // in.
        if (msg.type === "watch_project" && !channel.sessionId) channel.projectId = projectId;
        send(socket, store.snapshot(projectId));
        return;
      }

      /** The project record (spec §4.3). Hub-answered for the same reason as
       *  `HUB_HANDLED` above — only the hub sees every laptop, so only the hub
       *  can stamp each session with the machine that owns it — but its own
       *  branch rather than a member of that set, because `HUB_HANDLED` replies
       *  with a snapshot and this replies with a record.
       *
       *  `identify` is required (owner ruling, spec §8a.1), which is where this
       *  deliberately differs from the standalone handler's `denyUnauthed()`:
       *  the hub has no auth of its own until v7b2, so this pins the line the
       *  hub's cookie-verified login will replace. Membership is ALSO required
       *  now (spec A5, APPROVED — it supersedes P2's "visibility is hub-wide"):
       *  the record carries every session's `filesChanged`, the same exposure
       *  class as the snapshot's `touched`, so it is members-only, exactly like
       *  `watch_project`/`peek`. Only the project LIST stays hub-wide, as the
       *  join affordance. Everything else — the validation, the error string,
       *  the reply's shape — is the standalone handler's, byte for byte
       *  (server.ts's `get_record`), because one browser bundle talks to both. */
      if (msg?.type === "get_record") {
        if (!channel.identity) return error("identify first");
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error("get_record requires a valid projectId");
        if (!store.isMember(projectId, channel.identity.userId)) {
          return denyMember("join this project to see its record");
        }
        // Never re-homed, for the same reason `watch_project` above never
        // re-homes a joined channel: this is a read, and `fanOut` keys on
        // projectId AND sessionId, so touching either would cut a joined
        // session's event stream.
        send(socket, {
          type: "record",
          projectId,
          record: projectRecordFrom(projectId, store.recordInputs(projectId)),
        });
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
        httpServer.close((err) => {
          // The record's handle and its lock go LAST, after the server has
          // stopped accepting and every client socket is gone: nothing can
          // arrive needing a write once the DB is closed. Closed even when the
          // server's own close failed — a held lock would keep the next hub off
          // this record. `HubDb.close()` is idempotent, so a caller that also
          // closes its own `db` seam is fine.
          let dbErr: unknown;
          try {
            db?.close();
          } catch (thrown) {
            dbErr = thrown;
          }
          const failure = err ?? dbErr;
          if (failure) reject(failure);
          else resolve();
        });
      }),
  };
}
