import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Relay, type RelaySocket } from "multiplayer-ai-server/relay";
import { MAX_FRAME_BYTES, RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";
import { Session } from "multiplayer-ai-server/session";
import { startHub } from "../src/hub.js";

/** The real laptop against the real hub.
 *
 *  WHY THIS FILE EXISTS. Until it did, `relay.ts` was only ever tested against
 *  a fake hub written by the relay's author and `hub.ts` only ever against a
 *  fake laptop written by the hub's author — so each side was verified against
 *  the other's *expected* behaviour. The one place they disagreed (the relay's
 *  comment claimed the hub "keys on (runId, seq)"; the hub keys on a
 *  per-session high-water mark) was a permanent, silent event-loss bug that
 *  eight task reviews and two fix rounds all passed over. Every scenario below
 *  is one neither side's unit suite can express.
 *
 *  It lives in `poc/hub/test/` because that is the only package that can see
 *  both: the hub depends on `multiplayer-ai-server` through a `file:` link, so
 *  the server's `exports` map reaches `relay` and `session` from here.
 *  `poc/server/test/` has no dependency on the hub and cannot import it.
 *
 *  It drives a real `startHub({ port: 0 })` over loopback rather than wiring
 *  `Relay` straight into a `HubStore`, because two of the three scenarios are
 *  about things that live in `hub.ts` and in the socket layer, not in the
 *  store: `maxPayload` enforcement on the uplink, and the browser plane's
 *  replay. Determinism comes from controlling the RELAY's socket callbacks
 *  (see `relayConnect`) and from polling to a deadline, never from a bare
 *  sleep standing in for an assertion.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A plain browser-facing socket, mirroring `routing.test.ts` — this file's
 *  own scenarios only ever need the uplink-facing `relayConnector` below, but
 *  the create_session round trip is driven from the browser side. */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collect(ws: WebSocket, sink: any[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

interface ConnectHooks {
  /** Runs SYNCHRONOUSLY after the relay's own `open` handler returns — i.e.
   *  after `hello` has been written and long before any `welcome` could have
   *  made a round trip. This is the open→welcome window, and holding it open
   *  from the socket adapter is what makes it deterministic without a sleep. */
  afterOpen?: (n: number) => void;
}

/** A real `ws` socket wearing the `RelaySocket` shape the relay injects. */
function relayConnector(url: string, hooks: ConnectHooks = {}) {
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

function laptop(
  hubPort: number,
  over: Record<string, unknown> = {},
  hooks: ConnectHooks = {},
) {
  const wire = relayConnector(`ws://127.0.0.1:${hubPort}/uplink`, hooks);
  const relay = new Relay(
    {
      hubUrl: `ws://127.0.0.1:${hubPort}/uplink`,
      projectId: "default",
      repoKey: "github.com/acme/api",
      uplinkId: "lap-1",
      connect: wire.connect,
      newRunId: () => "run-1",
      reconnectDelayMs: 40,
      ...over,
    },
    // The command plane is not what these scenarios are about; a no-op handle
    // keeps a tunnelled `join` from mattering either way.
    { createConnection: () => ({ handleMessage: () => {}, close: () => {} }) },
  );
  return { relay, wire };
}

/** `laptop()` injects a no-op command plane, so nothing ever replies to a
 *  tunnelled command. This variant records what arrived and answers it, which
 *  is what makes the routed-create round trip observable. */
function laptopThatAnswers(hubPort: number, over: Record<string, unknown> = {}) {
  const wire = relayConnector(`ws://127.0.0.1:${hubPort}/uplink`);
  const arrived: any[] = [];
  const relay = new Relay(
    {
      hubUrl: `ws://127.0.0.1:${hubPort}/uplink`,
      projectId: "default",
      repoKey: "github.com/acme/api",
      uplinkId: "lap-1",
      connect: wire.connect,
      newRunId: () => "run-1",
      reconnectDelayMs: 40,
      ...over,
    },
    {
      createConnection: (io) => ({
        handleMessage: (msg: any) => {
          arrived.push(msg);
          if (msg?.type === "create_session") {
            io.send({ type: "session_created", sessionId: msg.name });
          }
        },
        close: () => {},
      }),
    },
  );
  return { relay, wire, arrived };
}

/** What a browser actually sees: join the session on a fresh socket and read
 *  the hub's replay back. This is the only honest measure of "the hub has it" —
 *  it is the same path a real teammate takes. */
async function browserReplay(port: number, sessionId = "auth"): Promise<any[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const seen: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
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
async function replayOnceAtLeast(port: number, n: number, sessionId = "auth"): Promise<any[]> {
  const deadline = Date.now() + 8000;
  let events = await browserReplay(port, sessionId);
  while (events.length < n && Date.now() < deadline) {
    await wait(25);
    events = await browserReplay(port, sessionId);
  }
  return events;
}

/** Generous, because every assertion below is a poll-to-deadline rather than a
 *  sleep: a green run finishes in a fraction of this, and a red one wants room
 *  to produce the real assertion failure instead of a timeout that names
 *  nothing. */
const TIMEOUT = 30_000;

describe("laptop ↔ hub, real Relay against a real hub", () => {
  it("loses nothing when an event is appended inside the open→welcome window of a reconnect", async () => {
    // C1, end to end. The shape: laptop and hub in sync; the uplink drops; the
    // agent keeps appending; the relay reconnects and sends `hello`; the hub
    // computes `have` from what it holds and replies `welcome` — and in the
    // round trip before that `welcome` lands, one more event is appended.
    //
    // Written straight to an open socket, that one event arrives AHEAD of the
    // replay the `welcome` is about to authorise, and `hubStore.publish`'s
    // high-water mark (`seq <= session.lastSeq`) then discards the entire
    // outage backlog as "already seen". The laptop believes it synced. Every
    // browser renders a transcript with a hole and no indication of it, and
    // the hub's stored history is wrong for every future joiner, permanently.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    const session = new Session("auth");
    let windowEvent: (() => void) | null = null;
    const { relay, wire } = laptop(hub.port, {}, {
      afterOpen: (n) => {
        // Only on the RECONNECT, and only once.
        if (n === 1) windowEvent?.();
      },
    });

    for (let i = 0; i < 5; i++) session.append({ type: "intent_update", text: `synced-${i}` });
    relay.trackSession("auth", session);
    relay.start();
    expect(await replayOnceAtLeast(hub.port, 5)).toHaveLength(5); // seq 0-4 landed

    // The uplink drops. The hub keeps the session and its five events.
    wire.sockets[0]!.close();
    await wait(20);

    // The agent keeps working through the outage: 30 more events, buffered.
    for (let i = 5; i < 35; i++) {
      relay.publishEvent("auth", session.append({ type: "intent_update", text: `outage-${i}` }));
    }

    // Armed to fire inside the reconnect's open→welcome window.
    windowEvent = () => {
      relay.publishEvent("auth", session.append({ type: "intent_update", text: "in-the-window" }));
    };

    const stored = await replayOnceAtLeast(hub.port, 36);
    relay.stop();

    // The laptop holds 36 events; so must the hub, in order, with no hole.
    expect(session.eventsFrom(0)).toHaveLength(36);
    expect(stored.map((e) => e.seq)).toEqual([...Array(36).keys()]);
    expect(stored.map((e) => e.text)).toEqual(session.eventsFrom(0).map((e: any) => e.text));
    expect(stored.at(-1).text).toBe("in-the-window");
  }, TIMEOUT);

  it("reassembles a chunked replay into exactly the laptop's log, multi-byte content included", async () => {
    // Two things at once, because they are one failure in practice. A replay
    // larger than `MAX_FRAME_BYTES` must be split, or `ws` answers 1009, the
    // relay reconnects, sees the same `have`, and re-sends the same oversized
    // frame forever — the session never syncs. And the split must be measured
    // in BYTES: this payload is emoji, so counting UTF-16 code units puts the
    // whole log under budget in ONE frame that is 1.2MB on the wire.
    //
    // The hub's real `maxPayload` is the judge here, which no relay-side unit
    // test can be.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    const session = new Session("auth");
    const emoji = "🙂".repeat(30_000); // 60_000 UTF-16 units, 120_000 bytes
    for (let i = 0; i < 10; i++) session.append({ type: "intent_update", text: `${i}${emoji}` });
    expect(Buffer.byteLength(JSON.stringify(session.eventsFrom(0)))).toBeGreaterThan(
      MAX_FRAME_BYTES,
    );

    const { relay } = laptop(hub.port);
    relay.trackSession("auth", session);
    relay.start();

    const stored = await replayOnceAtLeast(hub.port, 10);
    relay.stop();

    expect(stored.map((e) => e.seq)).toEqual([...Array(10).keys()]);
    expect(stored.map((e) => e.text)).toEqual(session.eventsFrom(0).map((e: any) => e.text));
  }, TIMEOUT);

  it("replays to a joining browser exactly what the laptop published, and reports it online", async () => {
    // The spine's whole point: one browser on the hub sees a session whose
    // agent runs on another machine. The browser never talks to the laptop —
    // the hub answers the replay and the snapshot from its own store, which is
    // what makes a watcher free.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    const session = new Session("auth");
    const { relay } = laptop(hub.port);
    relay.trackSession("auth", session);
    relay.start();
    await wait(60);

    relay.publishFacts("auth", {
      id: "auth", participants: ["ana"], driverName: "ana", intent: "ship the uplink",
      lastActivityTs: null, ended: false, pendingGate: null, skills: [],
      repoKey: "github.com/acme/api", lifecycle: "open",
    });
    for (const text of ["first", "second", "third"]) {
      relay.publishEvent("auth", session.append({ type: "intent_update", text }));
    }

    const stored = await replayOnceAtLeast(hub.port, 3);
    expect(stored.map((e) => e.text)).toEqual(["first", "second", "third"]);
    expect(stored.map((e) => e.seq)).toEqual([0, 1, 2]);

    // And the team view the laptop could never assemble on its own.
    const browser = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    await new Promise<void>((resolve, reject) => {
      browser.on("open", () => resolve());
      browser.on("error", reject);
    });
    browser.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    browser.send(JSON.stringify({ type: "peek", projectId: "default" }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.some((m) => m.type === "project")) await wait(10);
    browser.close();
    relay.stop();

    const snap = seen.find((m) => m.type === "project");
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].id).toBe("auth");
    expect(snap.sessions[0].intent).toBe("ship the uplink");
    expect(snap.sessions[0].repoKey).toBe("github.com/acme/api");
    expect(snap.sessions[0].presence).toBe("online");
  }, TIMEOUT);
});

describe("creating a session through the hub", () => {
  it("routes the create to the laptop untouched and lands the reply on the asking browser", async () => {
    // The whole point of this section: you could not create a session from the
    // hub at all. The last cross-component break in this seam survived eight
    // task reviews because no real-relay-against-real-hub harness existed.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const lap = laptopThatAnswers(hub.port);
    lap.relay.start();
    await wait(80);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(60);
    seen.length = 0;

    const create = {
      type: "create_session", projectId: "default",
      name: "billing", repoKey: "github.com/acme/api",
    };
    browser.send(JSON.stringify(create));
    await wait(150);

    expect(lap.arrived).toContainEqual(create);
    expect(seen.find((m) => m.type === "session_created")?.sessionId).toBe("billing");
    browser.close();
    lap.relay.stop();
  });

  it("does not deliver that reply to a second browser watching the same project", async () => {
    // `reply` is a narrowcast. If it fanned out, every watcher would navigate
    // into a session somebody else just created.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const lap = laptopThatAnswers(hub.port);
    lap.relay.start();
    await wait(80);

    const asking = await connect(`ws://127.0.0.1:${hub.port}/`);
    const other = await connect(`ws://127.0.0.1:${hub.port}/`);
    const askingSeen: any[] = [];
    const otherSeen: any[] = [];
    collect(asking, askingSeen);
    collect(other, otherSeen);
    asking.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    asking.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    other.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(60);
    otherSeen.length = 0;

    asking.send(JSON.stringify({
      type: "create_session", projectId: "default",
      name: "billing", repoKey: "github.com/acme/api",
    }));
    await wait(150);

    expect(askingSeen.some((m) => m.type === "session_created")).toBe(true);
    expect(otherSeen.some((m) => m.type === "session_created")).toBe(false);
    asking.close();
    other.close();
    lap.relay.stop();
  });

  it("refuses a reply from a different uplink on the routed channel's id — a laptop cannot inject into another's create_session", async () => {
    // The whole reason `pendingReplyFrom` is scoped to one uplink, not any
    // uplink: a channel awaiting a create_session reply has joined no
    // session, so the ownership check (`store.ownerOf`) cannot authorize it —
    // there is no session yet to own. Without a check tying the reply to the
    // exact uplink the hub routed to, ANY attached machine that learned or
    // guessed this channelId could hand the asking browser a fabricated
    // `session_created` for a session it never created.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    // Machine A: the one the hub will actually route to, because it is the
    // one offering this repo.
    const a = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const aSeen: any[] = [];
    collect(a, aSeen);
    a.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-a",
      projectId: "default", repoKey: "github.com/acme/api",
    }));

    // Machine B: a live, attached uplink in the same project — just not the
    // one offering this repo, so the hub never routes this request to it.
    const b = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    b.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-b",
      projectId: "default", repoKey: "github.com/acme/other",
    }));
    await wait(40);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(60);
    seen.length = 0;

    browser.send(JSON.stringify({
      type: "create_session", projectId: "default",
      name: "billing", repoKey: "github.com/acme/api",
    }));
    await wait(60);

    const channelId = aSeen.find((f) => f.t === "tunnel")?.channelId;
    expect(channelId).toBeTruthy();

    // B — not the machine the hub routed to — tries to answer on A's channel.
    b.send(JSON.stringify({
      t: "reply", channelId,
      payload: { type: "session_created", sessionId: "billing" },
    }));
    await wait(60);
    expect(seen.some((m) => m.type === "session_created")).toBe(false);

    // A, the machine actually routed to, can still answer on that same
    // channel — the guard rejects the wrong uplink, not the right one.
    a.send(JSON.stringify({
      t: "reply", channelId,
      payload: { type: "session_created", sessionId: "billing" },
    }));
    await wait(60);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);

    a.close();
    b.close();
    browser.close();
  });
});
