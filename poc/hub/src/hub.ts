import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { staticHandler } from "multiplayer-ai-server/staticFiles";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseUpFrame,
  type DownFrame,
} from "multiplayer-ai-server/relayProtocol";
import { HubStore } from "./hubStore.js";

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
        uplinkId = frame.uplinkId;
        projectId = frame.projectId;
        uplinks.set(frame.uplinkId, socket);
        store.attach(frame.uplinkId, frame.projectId, frame.repoKey);
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
          console.error(`uplink ${uplinkId}: ${result.error}`);
          socket.close(1008, result.error.slice(0, 100));
          return;
        }
        schedulePush(projectId);
        return;
      }
      // frame.t === "reply" — narrowcast back to the browser that asked.
      const channel = channels.get(frame.channelId);
      if (channel) send(channel.socket, frame.payload);
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

      if (msg?.type === "join") {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "default";
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
        if (!SLUG.test(projectId) || !SLUG.test(sessionId)) {
          return error("projectId and sessionId must be 1-40 chars of a-z, 0-9, -");
        }
        // v7b1 runs with auth OFF and takes the browser's word, exactly as a
        // standalone server does with auth off. v7b2 replaces these three
        // lines with the hub's cookie-verified GitHub login, which is what
        // makes the trust inversion (spec §3.5 rule 1) real. Until then this
        // hub must not be exposed to the internet.
        const userId = String(msg.userId ?? "").slice(0, 64);
        const name = String(msg.name ?? userId).slice(0, 40);
        if (!userId) return error("join requires userId");

        const owner = store.ownerOf(projectId, sessionId);
        if (!owner || !uplinks.has(owner)) {
          return error(`no machine is running session "${sessionId}" right now`);
        }
        channel.projectId = projectId;
        channel.sessionId = sessionId;
        channel.identity = { userId, name };

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

      if (HUB_HANDLED.has(msg?.type)) {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error(`${msg.type} requires a valid projectId`);
        if (msg.type === "watch_project") channel.projectId = projectId;
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
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
