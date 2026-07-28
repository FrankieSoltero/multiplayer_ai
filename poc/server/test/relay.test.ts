import { describe, expect, it, vi } from "vitest";
import { Relay, type RelaySocket } from "../src/relay.js";
import { Session } from "../src/session.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relayProtocol.js";

/** A socket that records what was sent and lets the test drive the far end. */
function fakeSocket() {
  const sent: any[] = [];
  const handlers = new Map<string, (arg?: unknown) => void>();
  const socket: RelaySocket = {
    send: (data) => sent.push(JSON.parse(data)),
    close: () => handlers.get("close")?.(),
    on: (event, fn) => void handlers.set(event, fn),
  };
  return {
    socket,
    sent,
    open: () => handlers.get("open")?.(),
    deliver: (frame: unknown) => handlers.get("message")?.(JSON.stringify(frame)),
    drop: () => handlers.get("close")?.(),
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
      connect: () => fake.socket,
      newRunId: () => `run-${++n}`,
      ...over,
    },
    { createConnection: () => ({ handleMessage: () => {}, close: () => {} }) },
  );
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

    relay.publishFacts("auth", {
      id: "auth", participants: ["ana"], driverName: "ana", intent: null,
      lastActivityTs: null, ended: false, pendingGate: null, skills: [],
      repoKey: "github.com/acme/api", lifecycle: "open",
    });
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
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
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
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
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
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
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
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
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
    expect(() => fake.deliver({ t: "tunnel", channelId: "c1" })).not.toThrow();
    expect(() => fake.deliver("not json at all")).not.toThrow();
  });
});

describe("Relay reconnect", () => {
  it("reconnects after the socket drops and re-handshakes", () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    let connects = 0;
    const relay = relayWith(fake, {
      connect: () => { connects++; return fake.socket; },
      reconnectDelayMs: 500,
    });
    relay.start();
    fake.open();
    expect(connects).toBe(1);
    fake.drop();
    vi.advanceTimersByTime(500);
    expect(connects).toBe(2);
    relay.stop();
    vi.useRealTimers();
  });

  it("stops reconnecting once stopped", () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    let connects = 0;
    const relay = relayWith(fake, { connect: () => { connects++; return fake.socket; }, reconnectDelayMs: 500 });
    relay.start();
    fake.open();
    relay.stop();
    fake.drop();
    vi.advanceTimersByTime(5000);
    expect(connects).toBe(1);
    vi.useRealTimers();
  });
});
