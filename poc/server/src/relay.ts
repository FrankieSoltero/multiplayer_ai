import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { LoggedEvent } from "./events.js";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseDownFrame,
  type SessionFacts,
  type UpFrame,
} from "./relayProtocol.js";
import type { Session } from "./session.js";
import type { ConnectionIO } from "./server.js";

/** Structural socket so the whole module is testable with no network — the
 *  same injection pattern as auth.ts's exchangeCode and config.ts's fs probe. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", fn: (arg?: unknown) => void): void;
}

export type ConnectFn = (url: string) => RelaySocket;

export interface RelayOptions {
  hubUrl: string;
  projectId: string;
  repoKey: string;
  uplinkId: string;
  connect?: ConnectFn;
  reconnectDelayMs?: number;
  /** Injected so tests get deterministic run ids. */
  newRunId?: () => string;
}

/** The one thing the relay needs from `server.ts`: the per-connection handler
 *  factory. Injected rather than imported so this module never depends on a
 *  running server, and so tests drive the command plane with a stub. */
export interface RelayDeps {
  createConnection: (io: ConnectionIO) => {
    handleMessage: (msg: any) => void;
    close: () => void;
  };
}

interface Tracked {
  session: Session;
  /** Minted once per session process start. Events are keyed (runId, seq), so
   *  a laptop restart appends a new run to the hub's store instead of letting
   *  a reset `seq` silently overwrite real history (spec §3.2). This is also
   *  v7d's seam: a session resumed from a handoff IS a new run of the same
   *  session. */
  runId: string;
}

export class Relay {
  private socket: RelaySocket | null = null;
  private open = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tracked = new Map<string, Tracked>();
  private channels = new Map<string, { handleMessage: (msg: any) => void; close: () => void }>();
  /** Frames produced before the socket was ready. Bounded by MAX_FRAME_BYTES
   *  worth of accumulated JSON so a hub that never comes up cannot grow the
   *  laptop's memory without limit. */
  private pending: UpFrame[] = [];
  private pendingBytes = 0;

  constructor(
    private opts: RelayOptions,
    private deps: RelayDeps,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const conn of this.channels.values()) conn.close();
    this.channels.clear();
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }

  /** Register a session so it takes part in the handshake replay. Called for
   *  every session this process owns, including ones created after the uplink
   *  is already up. */
  trackSession(sessionId: string, session: Session): void {
    if (this.tracked.has(sessionId)) return;
    const runId = (this.opts.newRunId ?? (() => randomUUID()))();
    this.tracked.set(sessionId, { session, runId });
    // A session created while the uplink is ALREADY up gets no second
    // `welcome`, so its backlog — the `skill_roster` appended at creation,
    // before any subscriber exists — would never reach the hub. Publish what
    // it already holds; the handshake replay covers the other case, and the
    // two cannot double-publish because this method returns early for a
    // session it already tracks.
    const backlog = session.eventsFrom(0);
    if (backlog.length > 0) {
      this.emit({ t: "publish", sessionId, runId, events: backlog });
    }
  }

  publishEvent(sessionId: string, event: LoggedEvent): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    this.emit({ t: "publish", sessionId, runId: tracked.runId, events: [event] });
  }

  publishFacts(sessionId: string, facts: SessionFacts): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    this.emit({ t: "facts", sessionId, runId: tracked.runId, facts });
  }

  private connect(): void {
    const connect = this.opts.connect ?? defaultConnect;
    const socket = connect(this.opts.hubUrl);
    this.socket = socket;
    socket.on("open", () => {
      this.open = true;
      this.write({
        t: "hello",
        v: RELAY_PROTOCOL_VERSION,
        uplinkId: this.opts.uplinkId,
        projectId: this.opts.projectId,
        repoKey: this.opts.repoKey,
      });
    });
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", () => {
      this.open = false;
      this.socket = null;
      // Every channel's browser is now unreachable from here. Dropping them
      // fires the same leave path a closed direct socket does, so the roster
      // stays honest rather than showing ghosts.
      for (const conn of this.channels.values()) conn.close();
      this.channels.clear();
      this.scheduleReconnect();
    });
    // Without a listener an "error" is an unhandled EventEmitter error and
    // crashes the process. "close" always follows, and does the cleanup.
    socket.on("error", () => {});
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, this.opts.reconnectDelayMs ?? 2000);
  }

  private onMessage(data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const frame = parseDownFrame(raw);
    if (!frame) return;

    if (frame.t === "welcome") {
      // The replay below reads the live log and is therefore authoritative:
      // anything buffered while the socket was down is already contained in
      // it. Dropping buffered publishes avoids re-sending events the hub
      // would only discard by (runId, seq) anyway.
      this.pending = this.pending.filter((f) => f.t !== "publish");
      this.pendingBytes = this.pending.reduce((n, f) => n + JSON.stringify(f).length, 0);
      for (const [sessionId, tracked] of this.tracked) {
        const have = frame.have[sessionId];
        // Same run → replay only the gap. Different run (or none) → this is
        // new history and the hub appends it beside what it already holds.
        const from = have && have.runId === tracked.runId ? have.lastSeq + 1 : 0;
        const events = tracked.session.eventsFrom(from);
        if (events.length > 0) {
          this.write({ t: "publish", sessionId, runId: tracked.runId, events });
        }
      }
      this.flush();
      return;
    }

    if (frame.t === "detach") {
      // The browser on this channel is gone. Closing runs the same leave path
      // a closed direct socket runs, so presence_leave fires and the wheel is
      // handed on — without it the roster keeps a ghost forever.
      const conn = this.channels.get(frame.channelId);
      conn?.close();
      this.channels.delete(frame.channelId);
      return;
    }

    // frame.t === "tunnel"
    let conn = this.channels.get(frame.channelId);
    if (!conn) {
      const channelId = frame.channelId;
      conn = this.deps.createConnection({
        mode: "relay",
        send: (msg) => this.write({ t: "reply", channelId, payload: msg }),
        // No watcher and no cookie: the hub owns snapshot fan-out, and it —
        // not this process — verified who is speaking (spec §3.5).
        stampedIdentity: frame.identity,
      });
      this.channels.set(channelId, conn);
    }
    conn.handleMessage(frame.payload);
  }

  private emit(frame: UpFrame): void {
    if (this.open) {
      this.write(frame);
      return;
    }
    const size = JSON.stringify(frame).length;
    if (this.pendingBytes + size > MAX_FRAME_BYTES) return; // drop rather than grow without bound
    this.pending.push(frame);
    this.pendingBytes += size;
  }

  private flush(): void {
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const frame of queued) this.write(frame);
  }

  private write(frame: UpFrame): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      /* the close handler will reconnect */
    }
  }
}

/** Real socket, kept out of the class so tests never reach the network. */
const defaultConnect: ConnectFn = (url) => {
  const socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    on: (event, fn) => void socket.on(event, fn as (...args: unknown[]) => void),
  };
};
