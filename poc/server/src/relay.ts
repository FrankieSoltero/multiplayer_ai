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
  /** True only between `welcome` and the socket's death — NOT from `open`.
   *
   *  The distinction is the whole of the reconnect correctness argument. A
   *  socket is `open` one full round trip before `welcome` lands, and the hub
   *  keys accepted events on a per-session HIGH-WATER MARK
   *  (`hubStore.publish`'s `seq <= session.lastSeq` skip), not on the set of
   *  (runId, seq) pairs it has seen. Those two are equivalent only for frames
   *  that arrive in seq order. An event written inside the open→welcome window
   *  arrives BEFORE the gap replay that the already-in-flight `welcome`
   *  authorises — it advances the hub's mark past the whole outage backlog,
   *  and every replayed frame is then discarded as "already seen". The laptop
   *  believes it synced; the hub, and every browser it serves, has a permanent
   *  hole. Gating `emit` on `ready` instead buffers those frames, and the
   *  welcome branch's replay (which reads the live log) carries them in order. */
  private ready = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tracked = new Map<string, Tracked>();
  private channels = new Map<string, { handleMessage: (msg: any) => void; close: () => void }>();
  /** Frames produced before the socket was ready, each with the JSON size in
   *  BYTES it was measured at. Bounded by MAX_FRAME_BYTES worth of JSON so
   *  a hub that never comes up cannot grow the laptop's memory without limit;
   *  the size rides along so eviction never has to re-stringify. */
  private pending: { frame: UpFrame; size: number }[] = [];
  private pendingBytes = 0;

  constructor(
    private opts: RelayOptions,
    private deps: RelayDeps,
  ) {}

  /** Idempotent. A second `start()` must not open a second uplink: two live
   *  sockets would both send `hello` and both feed `onMessage` — duplicating
   *  every tunnelled command — while only the later one is reachable by
   *  `write` and the earlier one is never closed. A pending reconnect counts
   *  as started for the same reason. */
  start(): void {
    if (this.socket || this.reconnectTimer) return;
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
    this.ready = false;
    // Frames buffered in this life must not surface in the next one: after a
    // stop()/start() pair the next `welcome` would otherwise flush facts and
    // replies belonging to a session state that has since moved on.
    this.pending = [];
    this.pendingBytes = 0;
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
    for (const frame of publishFrames(sessionId, runId, session.eventsFrom(0))) {
      this.emit(frame);
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
    // Belt and braces: every path into `connect()` already cleared this, but a
    // new socket is unambiguously not handshaken and nothing may be written
    // live until its `welcome` lands.
    this.ready = false;
    const connect = this.opts.connect ?? defaultConnect;
    const socket = connect(this.opts.hubUrl);
    this.socket = socket;
    // Every handler below is guarded on the identity of the socket that
    // registered it. `ws` reports a socket's `close` ASYNCHRONOUSLY, so a
    // stop()/start() pair delivers the OLD socket's close after the new one is
    // already assigned. Unguarded, that stale handler nulls `this.socket`,
    // tears down the new socket's channels, and leaves `write` sending into
    // the void for the rest of the process's life — with `ready` still true.
    const isCurrent = () => socket === this.socket;
    socket.on("open", () => {
      if (!isCurrent()) return;
      // Deliberately does NOT set `ready`. `hello` is written directly because
      // it is the one frame that must precede the handshake; everything else
      // waits for `welcome`. See the `ready` field's note.
      this.write({
        t: "hello",
        v: RELAY_PROTOCOL_VERSION,
        uplinkId: this.opts.uplinkId,
        projectId: this.opts.projectId,
        repoKey: this.opts.repoKey,
      });
    });
    socket.on("message", (data) => {
      if (isCurrent()) this.onMessage(data);
    });
    socket.on("close", () => {
      if (!isCurrent()) return;
      this.ready = false;
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
      this.pending = this.pending.filter((p) => p.frame.t !== "publish");
      this.pendingBytes = this.pending.reduce((n, p) => n + p.size, 0);
      for (const [sessionId, tracked] of this.tracked) {
        const have = frame.have[sessionId];
        // Same run → replay only the gap. Different run (or none) → this is
        // new history and the hub appends it beside what it already holds.
        const from = have && have.runId === tracked.runId ? have.lastSeq + 1 : 0;
        for (const out of publishFrames(sessionId, tracked.runId, tracked.session.eventsFrom(from))) {
          this.write(out);
        }
      }
      // Only now may `emit` write live. Set BEFORE flush() so the buffered
      // frames go out on the same path everything after them takes, and AFTER
      // the replay so the hub's high-water mark advances in seq order.
      this.ready = true;
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
    if (this.ready) {
      this.write(frame);
      return;
    }
    // Not handshaken: buffer. This covers the socket being down AND the
    // open→welcome window, which is the case that matters — see `ready`.
    // A buffered `publish` is always dropped by the welcome branch and
    // re-derived from the live log, so buffering one is free; a buffered
    // `facts` is latest-wins and lands after the replay, which is the order
    // it needs. `reply` frames never come through here (they go straight to
    // `write` from the tunnel handler), so no command response is delayed.
    const size = Buffer.byteLength(JSON.stringify(frame));
    this.pending.push({ frame, size });
    this.pendingBytes += size;
    // Evict the OLDEST, not the newest. `facts` are latest-wins, so a full
    // buffer that rejected new frames would leave the hub holding the stalest
    // view of every session — and `flush()` runs AFTER the replay, so that
    // stale view would land on top of freshly replayed events. Keeping at
    // least one entry means a single frame larger than the cap still ships
    // rather than vanishing.
    while (this.pendingBytes > MAX_FRAME_BYTES && this.pending.length > 1) {
      this.pendingBytes -= this.pending.shift()!.size;
    }
  }

  private flush(): void {
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const { frame } of queued) this.write(frame);
  }

  private write(frame: UpFrame): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      /* the close handler will reconnect */
    }
  }
}

/** Split a session's events into publish frames that each fit under
 *  MAX_FRAME_BYTES.
 *
 *  Load-bearing, not tidiness. MAX_FRAME_BYTES is the `maxPayload` on the
 *  hub's uplink-facing socket, and a long session's full replay easily exceeds
 *  it. Sent as one frame, `ws` answers with a 1009 close — whereupon the relay
 *  reconnects, receives the same `welcome` with the same `have`, and sends the
 *  same oversized frame again, forever. The session never syncs and the uplink
 *  never stabilises. Chunking costs nothing because the hub keys events on
 *  (runId, seq): many publish frames for one session are equivalent to one. */
function publishFrames(sessionId: string, runId: string, events: LoggedEvent[]): UpFrame[] {
  if (events.length === 0) return [];
  // What the envelope itself costs, so a full chunk plus its wrapper still fits.
  // Measured in BYTES, not UTF-16 code units: `maxPayload` on the far end
  // counts bytes, and `String.length` under-counts every non-Latin-1 character
  // (3 bytes per unit for CJK, 4 for an emoji). Agent output full of either
  // would otherwise build a chunk that looks under budget here and trips a
  // 1009 close there — reopening the replay livelock chunking exists to close.
  const budget =
    MAX_FRAME_BYTES -
    Buffer.byteLength(JSON.stringify({ t: "publish", sessionId, runId, events: [] }));
  const frames: UpFrame[] = [];
  let chunk: LoggedEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1; // +1 for the joining comma
    if (chunk.length > 0 && bytes + size > budget) {
      frames.push({ t: "publish", sessionId, runId, events: chunk });
      chunk = [];
      bytes = 0;
    }
    // A single event over budget still ships alone. Dropping it would punch a
    // permanent hole in an append-only log, which is worse than handing the
    // hub one frame it may reject.
    chunk.push(event);
    bytes += size;
  }
  frames.push({ t: "publish", sessionId, runId, events: chunk });
  return frames;
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
