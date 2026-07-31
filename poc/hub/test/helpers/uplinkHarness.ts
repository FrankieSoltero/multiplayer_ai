import WebSocket from "ws";
import { Relay, type ContestedFrame, type RelaySocket } from "multiplayer-ai-server/relay";
import {
  MAX_FRAME_BYTES,
  type RepoDecl,
} from "multiplayer-ai-server/relayProtocol";

export const decl = (key: string, over: Partial<RepoDecl> = {}): RepoDecl => ({
  key,
  label: key.split("/").pop() ?? key,
  attached: true,
  defaultBranch: "origin/main",
  ...over,
});

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A plain browser-facing socket, mirroring `routing.test.ts` — this file's
 *  own scenarios only ever need the uplink-facing `relayConnector` below, but
 *  the create_session round trip is driven from the browser side. */
export function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

export function collect(ws: WebSocket, sink: any[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

export interface ConnectHooks {
  /** Runs SYNCHRONOUSLY after the relay's own `open` handler returns — i.e.
   *  after `hello` has been written and long before any `welcome` could have
   *  made a round trip. This is the open→welcome window, and holding it open
   *  from the socket adapter is what makes it deterministic without a sleep. */
  afterOpen?: (n: number) => void;
}

/** A real `ws` socket wearing the `RelaySocket` shape the relay injects. */
export function relayConnector(url: string, hooks: ConnectHooks = {}) {
  const sockets: WebSocket[] = [];
  const connect = (): RelaySocket => {
    const ws = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES });
    const n = sockets.length;
    sockets.push(ws);
    return {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      on: (event, fn) => {
        if (event === "open") {
          ws.on("open", () => {
            fn();
            hooks.afterOpen?.(n);
          });
        } else {
          ws.on(event as "message" | "close" | "error", (arg: unknown) => fn(arg));
        }
      },
    };
  };
  return { connect, sockets };
}

/** The laptop's `contested` consumer, standing in for `server.ts`'s
 *  `applyContested` exactly as `laptopThatAnswers`'s `createConnection` stands
 *  in for its command plane — this package depends on the server for its relay
 *  and its types, not for a process.
 *
 *  RECORDING is the whole point: `RelayDeps.onContested` is required precisely
 *  so nothing can wire an uplink and silently drop the hub's collision frames
 *  (relay.ts), and a sink that keeps every frame IN ARRIVAL ORDER is what lets
 *  a scenario assert "exactly once", "and again after a reconnect" and "never
 *  a duplicate" — claims a fake that only kept the LAST frame could not tell
 *  apart. The frames land here already through the real `parseDownFrame`, so
 *  anything the producer emits that the wire contract rejects never arrives at
 *  all, and the row asserting on it fails. */
function contestedSink(): { contested: ContestedFrame[]; onContested: (f: ContestedFrame) => void } {
  const contested: ContestedFrame[] = [];
  return { contested, onContested: (frame) => void contested.push(frame) };
}

export function laptop(
  hubPort: number,
  over: Record<string, unknown> = {},
  hooks: ConnectHooks = {},
) {
  const wire = relayConnector(`ws://127.0.0.1:${hubPort}/uplink`, hooks);
  const sink = contestedSink();
  const relay = new Relay(
    {
      hubUrl: `ws://127.0.0.1:${hubPort}/uplink`,
      projectId: "default",
      name: "lap",
      repos: () => [decl("github.com/acme/api")],
      uplinkId: "lap-1",
      connect: wire.connect,
      newRunId: () => "run-1",
      reconnectDelayMs: 40,
      ...over,
    },
    // The command plane is not what these scenarios are about; a no-op handle
    // keeps a tunnelled `join` from mattering either way.
    {
      createConnection: () => ({ handleMessage: () => {}, close: () => {} }),
      onContested: sink.onContested,
    },
  );
  return { relay, wire, contested: sink.contested };
}

/** `laptop()` injects a no-op command plane, so nothing ever replies to a
 *  tunnelled command. This variant records what arrived and answers it, which
 *  is what makes the routed-create round trip observable.
 *
 *  `onCommand` is the scenario's own command plane, standing in for the real
 *  `server.ts` handlers this package cannot import. It gets FIRST refusal on
 *  every tunnelled message and a truthy return means "handled" — the built-in
 *  `create_session` answer below is then suppressed, so a scenario about
 *  attach or detach can never accidentally also collect a create reply it did
 *  not ask for. It cannot be a real `createConnection`: that needs a running
 *  server, and `poc/hub` depends on `multiplayer-ai-server` for its types and
 *  its relay, not for a process. */
export function laptopThatAnswers(
  hubPort: number,
  over: Record<string, unknown> = {},
  onCommand?: (msg: any, io: { send: (m: unknown) => void }) => boolean,
) {
  const wire = relayConnector(`ws://127.0.0.1:${hubPort}/uplink`);
  const arrived: any[] = [];
  const sink = contestedSink();
  const relay = new Relay(
    {
      hubUrl: `ws://127.0.0.1:${hubPort}/uplink`,
      projectId: "default",
      name: "lap",
      repos: () => [decl("github.com/acme/api")],
      uplinkId: "lap-1",
      connect: wire.connect,
      newRunId: () => "run-1",
      reconnectDelayMs: 40,
      ...over,
    },
    {
      createConnection: (io) => ({
        handleMessage: (msg: any) => {
          // Recorded BEFORE the handler runs, so a scenario can assert on what
          // the wire delivered even when nothing answers it.
          arrived.push(msg);
          if (onCommand?.(msg, io)) return;
          if (msg?.type === "create_session") {
            io.send({ type: "session_created", sessionId: msg.name });
          }
        },
        close: () => {},
      }),
      onContested: sink.onContested,
    },
  );
  return { relay, wire, arrived, contested: sink.contested };
}

/** What a browser actually sees: join the session on a fresh socket and read
 *  the hub's replay back. This is the only honest measure of "the hub has it" —
 *  it is the same path a real teammate takes. */
export async function browserReplay(port: number, sessionId = "auth"): Promise<any[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const seen: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
  // Participation is membership-gated now (spec A4): a browser must identify and
  // join the project before joining a session in it. Sent on the same socket in
  // order, so the hub commits the membership before it processes the join — no
  // wait needed between them.
  ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
  ws.send(JSON.stringify({ type: "join_project", projectId: "default" }));
  ws.send(
    JSON.stringify({ type: "join", sessionId, projectId: "default", userId: "ana", name: "ana" }),
  );
  // The replay is written in one synchronous burst before the snapshot, so the
  // snapshot's arrival is the end-of-replay marker — no fixed sleep needed. An
  // `error` ends the wait too: while the uplink is down the hub refuses the
  // join outright, and that is a definite answer, not something to wait out.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !seen.some((m) => m.type === "project" || m.type === "error")) {
    await wait(10);
  }
  ws.close();
  return seen.filter((m) => m.type === "event").map((m) => m.event);
}

/** Poll the browser's view until the hub holds `n` events, or give up and let
 *  the caller assert on whatever it actually has. */
export async function replayOnceAtLeast(port: number, n: number, sessionId = "auth"): Promise<any[]> {
  const deadline = Date.now() + 8000;
  let events = await browserReplay(port, sessionId);
  while (events.length < n && Date.now() < deadline) {
    await wait(25);
    events = await browserReplay(port, sessionId);
  }
  return events;
}

/** The project view as a browser reads it, on a throwaway socket. Both message
 *  types are answered from the hub's own store in the same synchronous turn, so
 *  the `project` message's ARRIVAL is the end of the wait — nothing here stands
 *  a fixed sleep up in place of an assertion. `peek` leaves the channel
 *  unbound; `watch_project` homes it, which is the path §11's attach scenario
 *  names. */
export async function snapshotVia(
  port: number,
  type: "peek" | "watch_project",
  projectId = "default",
): Promise<any | undefined> {
  const ws = await connect(`ws://127.0.0.1:${port}/`);
  const seen: any[] = [];
  collect(ws, seen);
  // watch_project/peek are members-only now (spec A5): identify and join the
  // project on the same socket first, in order, so the snapshot request clears
  // the membership gate.
  ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
  ws.send(JSON.stringify({ type: "join_project", projectId }));
  ws.send(JSON.stringify({ type, projectId }));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !seen.some((m) => m.type === "project")) await wait(10);
  ws.close();
  return seen.find((m) => m.type === "project");
}
