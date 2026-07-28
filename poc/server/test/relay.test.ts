import { describe, expect, it, vi } from "vitest";
import { Relay, type RelaySocket } from "../src/relay.js";
import { Session } from "../src/session.js";
import { MAX_FRAME_BYTES, RELAY_PROTOCOL_VERSION, type SessionFacts } from "../src/relayProtocol.js";

/** One end of one socket: what the relay sent on it, and the levers to drive
 *  the far end. */
interface FakeEnd {
  socket: RelaySocket;
  sent: any[];
  /** True once the relay asked for a close. The `close` EVENT is separate and
   *  fired by `drop()`, because `ws` reports it asynchronously — the gap
   *  between the two is where the stale-handler bug lives. */
  closeRequested: boolean;
  open: () => void;
  deliver: (frame: unknown) => void;
  /** Hands the handler a raw value, bypassing the JSON encoding `deliver`
   *  does — the only way to exercise the parse failure path. */
  deliverRaw: (data: unknown) => void;
  drop: () => void;
}

/** A fake hub end that mints a GENUINELY NEW socket per connect, each with its
 *  own handler map — a reconnect must produce a distinct object, as `ws` does,
 *  or the multi-socket lifecycle cannot be tested at all. The bare accessors
 *  address the latest socket, which is what every single-connection test means;
 *  tests about the lifecycle across a reconnect reach into `sockets[]`. */
function fakeSocket() {
  const sockets: FakeEnd[] = [];
  const connect = (): RelaySocket => {
    const sent: any[] = [];
    const handlers = new Map<string, (arg?: unknown) => void>();
    const socket: RelaySocket = {
      send: (data) => sent.push(JSON.parse(data)),
      close: () => void (end.closeRequested = true),
      on: (event, fn) => void handlers.set(event, fn),
    };
    const end: FakeEnd = {
      socket,
      sent,
      closeRequested: false,
      open: () => handlers.get("open")?.(),
      deliver: (frame) => handlers.get("message")?.(JSON.stringify(frame)),
      deliverRaw: (data) => handlers.get("message")?.(data),
      drop: () => handlers.get("close")?.(),
    };
    sockets.push(end);
    return socket;
  };
  const latest = (): FakeEnd => sockets[sockets.length - 1]!;
  return {
    connect,
    sockets,
    get sent() {
      return latest().sent;
    },
    open: () => latest().open(),
    deliver: (frame: unknown) => latest().deliver(frame),
    deliverRaw: (data: unknown) => latest().deliverRaw(data),
    drop: () => latest().drop(),
  };
}

function relayWith(fake: ReturnType<typeof fakeSocket>, over: Record<string, unknown> = {}) {
  let n = 0;
  return new Relay(
    {
      hubUrl: "ws://hub.test",
      projectId: "default",
      repoKey: "github.com/acme/api",
      uplinkId: "lap-1",
      connect: fake.connect,
      newRunId: () => `run-${++n}`,
      ...over,
    },
    { createConnection: () => ({ handleMessage: () => {}, close: () => {} }) },
  );
}

function factsFor(intent: string): SessionFacts {
  return {
    id: "auth", participants: ["ana"], driverName: "ana", intent,
    lastActivityTs: null, ended: false, pendingGate: null, skills: [],
    repoKey: "github.com/acme/api", lifecycle: "open",
  };
}

describe("Relay handshake", () => {
  it("sends hello with the protocol version, project and repo key on open", () => {
    const fake = fakeSocket();
    relayWith(fake).start();
    fake.open();
    expect(fake.sent[0]).toEqual({
      t: "hello",
      v: RELAY_PROTOCOL_VERSION,
      uplinkId: "lap-1",
      projectId: "default",
      repoKey: "github.com/acme/api",
    });
  });

  it("replays only the gap the hub says it is missing", () => {
    // The payoff of the append-only design (spec §3.2): the hub reports what
    // it holds and the laptop replays from there. No diffing, no reconciling.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    session.append({ type: "intent_update", text: "a" });
    session.append({ type: "intent_update", text: "b" });
    session.append({ type: "intent_update", text: "c" });
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: { auth: { runId: "run-1", lastSeq: 0 } } });

    const publish = fake.sent.find((f) => f.t === "publish" && f.sessionId === "auth");
    expect(publish.runId).toBe("run-1");
    expect(publish.events.map((e: any) => e.seq)).toEqual([1, 2]);
  });

  it("replays from zero when the hub holds a different run", () => {
    // A restarted laptop mints a new runId, so its seq 0 is genuinely new
    // history rather than an overwrite of the hub's run.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    session.append({ type: "intent_update", text: "fresh" });
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: { auth: { runId: "run-from-a-dead-process", lastSeq: 99 } } });

    const publish = fake.sent.find((f) => f.t === "publish");
    expect(publish.runId).toBe("run-1");
    expect(publish.events.map((e: any) => e.seq)).toEqual([0]);
  });
});

describe("Relay publish plane", () => {
  it("publishes an event once, regardless of how many browsers are watching", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    relay.publishEvent("auth", session.append({ type: "intent_update", text: "one" }));
    const publishes = fake.sent.filter((f) => f.t === "publish");
    expect(publishes).toHaveLength(1);
    expect(publishes[0].events).toHaveLength(1);
  });

  it("publishes facts as a separate frame from events", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.trackSession("auth", new Session("auth"));
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    relay.publishFacts("auth", factsFor("shipping the uplink"));
    expect(fake.sent.filter((f) => f.t === "facts")).toHaveLength(1);
  });

  it("loses nothing that happened before the socket was open", () => {
    // Events produced while the uplink is down must still reach the hub. They
    // do so through the handshake replay, which reads the live log — so this
    // asserts the outcome, not the mechanism.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    relay.publishEvent("auth", session.append({ type: "intent_update", text: "early" }));
    expect(fake.sent).toHaveLength(0);
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    const published = fake.sent.filter((f) => f.t === "publish").flatMap((f: any) => f.events);
    expect(published.map((e: any) => e.text)).toEqual(["early"]);
  });

  it("publishes a session's backlog when it is created while the uplink is already up", () => {
    // The gap this closes: a session created after the handshake gets no
    // second `welcome`, so the skill_roster appended at creation — before any
    // subscriber exists — would otherwise never reach the hub at all.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    const late = new Session("late");
    late.append({ type: "skill_roster", skills: [{ name: "x", description: "d" }] });
    relay.trackSession("late", late);

    const published = fake.sent.filter((f) => f.t === "publish" && f.sessionId === "late");
    expect(published).toHaveLength(1);
    expect(published[0].events.map((e: any) => e.type)).toEqual(["skill_roster"]);
  });
});

describe("Relay command plane", () => {
  it("feeds a tunnelled payload to a connection and replies on the same channel", () => {
    const handled: unknown[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: fake.connect },
      {
        createConnection: (io) => ({
          handleMessage: (msg) => {
            handled.push(msg);
            io.send({ type: "error", message: "nope" });
          },
          close: () => {},
        }),
      },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    const payload = { type: "prompt", text: "hi" };
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload });

    expect(handled).toEqual([payload]);
    expect(fake.sent).toContainEqual({ t: "reply", channelId: "c1", payload: { type: "error", message: "nope" } });
  });

  it("reuses one connection per channel, so a browser's join survives its next command", () => {
    const created: unknown[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: fake.connect },
      { createConnection: (io) => { created.push(io); return { handleMessage: () => {}, close: () => {} }; } },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload: { type: "join" } });
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload: { type: "prompt", text: "x" } });
    expect(created).toHaveLength(1);
  });

  it("stamps the connection with the hub's identity and never with the payload's", () => {
    const ios: any[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: fake.connect },
      { createConnection: (io) => { ios.push(io); return { handleMessage: () => {}, close: () => {} }; } },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.deliver({
      t: "tunnel", channelId: "c1",
      identity: { userId: "ana", name: "ana" },
      payload: { type: "join", userId: "mallory", name: "Mallory" },
    });
    expect(ios[0].mode).toBe("relay");
    expect(ios[0].stampedIdentity).toEqual({ userId: "ana", name: "ana" });
    expect(ios[0].watcher).toBeUndefined();
    expect(ios[0].cookieHeader).toBeUndefined();
  });

  it("closes and forgets a channel on detach, so the roster keeps no ghost", () => {
    const closed: string[] = [];
    const created: unknown[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: fake.connect },
      {
        createConnection: () => {
          created.push(1);
          return { handleMessage: () => {}, close: () => closed.push("c") };
        },
      },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload: { type: "join" } });
    fake.deliver({ t: "detach", channelId: "c1" });
    expect(closed).toHaveLength(1);
    // A later tunnel on the same id is a NEW browser, not the old one.
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ben", name: "ben" }, payload: { type: "join" } });
    expect(created).toHaveLength(2);
  });

  it("ignores a malformed down-frame rather than crashing the uplink", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.start();
    fake.open();
    // Well-formed JSON, unusable frame: rejected by parseDownFrame.
    expect(() => fake.deliver({ t: "tunnel", channelId: "c1" })).not.toThrow();
    // Not JSON at all: rejected by the parse guard. Delivered raw, because
    // `deliver` would encode it into a perfectly valid JSON string and never
    // reach that guard.
    expect(() => fake.deliverRaw("not json at all")).not.toThrow();
    expect(fake.sent.filter((f) => f.t === "reply")).toHaveLength(0);
  });
});

describe("Relay reconnect", () => {
  it("reconnects on a fresh socket, re-handshakes, and delivers what happened during the outage", () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    const relay = relayWith(fake, { reconnectDelayMs: 500 });
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    fake.sockets[0]!.open();
    fake.sockets[0]!.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    expect(fake.sockets).toHaveLength(1);

    fake.sockets[0]!.drop();
    // Produced with the uplink down — the whole point of reconnecting is that
    // this still lands.
    relay.publishEvent("auth", session.append({ type: "intent_update", text: "during" }));
    vi.advanceTimersByTime(500);
    expect(fake.sockets).toHaveLength(2);

    const second = fake.sockets[1]!;
    second.open();
    expect(second.sent[0]).toEqual({
      t: "hello",
      v: RELAY_PROTOCOL_VERSION,
      uplinkId: "lap-1",
      projectId: "default",
      repoKey: "github.com/acme/api",
    });
    second.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    const events = second.sent.filter((f) => f.t === "publish").flatMap((f: any) => f.events);
    expect(events.map((e: any) => e.text)).toEqual(["during"]);

    relay.stop();
    vi.useRealTimers();
  });

  it("stops reconnecting once stopped", () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    const relay = relayWith(fake, { reconnectDelayMs: 500 });
    relay.start();
    fake.sockets[0]!.open();
    relay.stop();
    expect(fake.sockets[0]!.closeRequested).toBe(true);
    fake.sockets[0]!.drop();
    vi.advanceTimersByTime(5000);
    expect(fake.sockets).toHaveLength(1);
    vi.useRealTimers();
  });

  it("opens no second uplink when start() is called twice", () => {
    // Two live sockets would both handshake and both feed onMessage —
    // duplicating every tunnelled command — while only the later one is
    // reachable by `write` and the earlier one is never closed.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.start();
    relay.start();
    expect(fake.sockets).toHaveLength(1);
    relay.stop();
  });

  it("ignores a stale socket's late close, so a restart cannot orphan the live uplink", () => {
    // `ws` reports a close asynchronously, so stop() then start() delivers the
    // OLD socket's close AFTER the new socket is assigned. Unguarded, that
    // stale handler nulls out the live socket and every later frame — hello
    // included — is written into the void.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    fake.sockets[0]!.open();

    relay.stop();
    relay.start();
    expect(fake.sockets).toHaveLength(2);

    fake.sockets[0]!.drop(); // the stale close, finally landing
    const live = fake.sockets[1]!;
    live.open();
    live.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    relay.publishEvent("auth", session.append({ type: "intent_update", text: "after restart" }));

    expect(live.sent[0]).toMatchObject({ t: "hello" });
    const events = live.sent.filter((f) => f.t === "publish").flatMap((f: any) => f.events);
    expect(events.map((e: any) => e.text)).toEqual(["after restart"]);
    relay.stop();
  });

  it("forgets frames buffered in a previous life when stopped", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.trackSession("auth", new Session("auth"));
    relay.start();
    relay.publishFacts("auth", factsFor("from the previous life")); // buffered: never opened
    relay.stop();

    relay.start();
    fake.sockets[1]!.open();
    fake.sockets[1]!.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    expect(fake.sockets[1]!.sent.filter((f) => f.t === "facts")).toHaveLength(0);
    relay.stop();
  });
});

describe("Relay bounds", () => {
  it("splits a replay too big for one frame, so an oversized session cannot livelock the uplink", () => {
    // One frame over the hub's maxPayload is answered with a 1009 close; the
    // relay reconnects, sees the same `have`, and sends the same oversized
    // frame forever. The session would never sync.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    const big = "x".repeat(100_000);
    for (let i = 0; i < 15; i++) session.append({ type: "intent_update", text: big });
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });

    const publishes = fake.sent.filter((f) => f.t === "publish");
    expect(publishes.length).toBeGreaterThan(1);
    for (const frame of publishes) {
      expect(JSON.stringify(frame).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
    // Chunking must not lose, duplicate or reorder anything.
    expect(publishes.flatMap((f: any) => f.events).map((e: any) => e.seq)).toEqual([
      ...Array(15).keys(),
    ]);
  });

  it("bounds the offline buffer by evicting the OLDEST, so the hub gets the freshest facts", () => {
    // Facts are latest-wins. A buffer that stayed full by rejecting new frames
    // would keep the stalest view of every session — and flush() runs AFTER
    // the replay, so that stale view would land on top of fresh events.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.trackSession("auth", new Session("auth"));
    relay.start(); // socket exists but never opens: everything buffers
    const filler = "y".repeat(200_000);
    for (let i = 0; i < 10; i++) {
      relay.publishFacts("auth", factsFor(`${filler}#${String(i).padStart(2, "0")}`));
    }

    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    const kept = fake.sent
      .filter((f) => f.t === "facts")
      .map((f: any) => f.facts.intent.slice(-3));
    expect(kept.length).toBeLessThan(10); // 2MB offered, ~1MB kept
    expect(JSON.stringify(fake.sent).length).toBeLessThanOrEqual(2 * MAX_FRAME_BYTES);
    expect(kept).toContain("#09"); // the freshest survived
    expect(kept).not.toContain("#00"); // the stalest was evicted
  });

  it("closes every open channel on stop, so no connection is left holding a session", () => {
    const closed: string[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: fake.connect },
      {
        createConnection: (io) => ({
          handleMessage: () => {},
          close: () => closed.push(io.mode === "relay" ? io.stampedIdentity.userId : "direct"),
        }),
      },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload: { type: "join" } });
    fake.deliver({ t: "tunnel", channelId: "c2", identity: { userId: "ben", name: "ben" }, payload: { type: "join" } });

    relay.stop();
    expect(closed).toEqual(["ana", "ben"]);
  });
});
