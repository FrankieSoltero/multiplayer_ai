import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startHub } from "../src/hub.js";
import { RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const facts = (id: string, over: Record<string, unknown> = {}) => ({
  id, participants: ["ana"], driverName: "ana", intent: null, lastActivityTs: null,
  ended: false, pendingGate: null, skills: [], repoKey: "github.com/acme/api",
  lifecycle: "open", ...over,
});

/** An attached laptop with one declared session — the precondition of most
 *  tests below. */
async function attachedUplink(port: number, sessionId = "auth", uplinkId = "lap-1") {
  const up = await connect(`ws://127.0.0.1:${port}/uplink`);
  const seen: any[] = [];
  collect(up, seen);
  up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId, projectId: "default", repoKey: "k" }));
  up.send(JSON.stringify({ t: "facts", sessionId, runId: "run-a", facts: facts(sessionId) }));
  await wait(40);
  return { up, seen };
}

const join = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana", ...over });

describe("hub uplink handshake", () => {
  it("welcomes a laptop with the offsets it already holds", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const seen: any[] = [];
    collect(up, seen);
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", projectId: "default", repoKey: "github.com/acme/api" }));
    await wait(50);
    expect(seen[0]).toEqual({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    up.close();
  });

  it("closes an uplink that speaks the wrong protocol version", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    up.send(JSON.stringify({ t: "hello", v: 99, uplinkId: "lap-1", projectId: "default", repoKey: "k" }));
    expect(await closed).toBe(1008);
  });
});

describe("hub fan-out", () => {
  it("replays from its own store and streams new events to a joined browser", async () => {
    // The hub owns replay (spec §3.2). A late browser gets the full history
    // from the hub, and the laptop never learns it exists.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "already happened", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    await wait(40);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(50);
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["already happened"]);
    expect(seen.some((m) => m.type === "project")).toBe(true);

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "live", seq: 1, ts: "2026-07-27T00:00:01.000Z" }],
    }));
    await wait(50);
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual([
      "already happened",
      "live",
    ]);
    browser.close();
    up.close();
  });

  it("publishes once from the laptop no matter how many browsers watch", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const a = await connect(`ws://127.0.0.1:${hub.port}/`);
    const b = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seenA: any[] = []; const seenB: any[] = [];
    collect(a, seenA); collect(b, seenB);
    a.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    b.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ben", name: "ben" }));
    await wait(50);
    upSeen.length = 0;

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "one", seq: 5, ts: "2026-07-27T00:00:05.000Z" }],
    }));
    await wait(50);

    // Both browsers saw it; the uplink carried nothing extra. That asymmetry
    // is the entire reason the publish plane is separate from the tunnel.
    expect(seenA.filter((m) => m.type === "event" && m.event.text === "one")).toHaveLength(1);
    expect(seenB.filter((m) => m.type === "event" && m.event.text === "one")).toHaveLength(1);
    // Not "no publish frames" — the hub has no publish frame to send, so that
    // assertion could never fail. NOTHING went down the uplink: no per-watcher
    // tunnel, no echo, no ack. That is the assertion with teeth.
    expect(upSeen).toEqual([]);

    a.close(); b.close(); up.close();
  });
});

describe("hub command routing", () => {
  it("tunnels a browser command with a hub-assigned channel and a stamped identity", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(40);
    browser.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(50);

    const tunnels = upSeen.filter((f) => f.t === "tunnel");
    expect(tunnels.map((f) => f.payload.type)).toEqual(["join", "prompt"]);
    // One browser, one channel — a join and its next command must land on the
    // same connection or the driver state is lost between them.
    expect(new Set(tunnels.map((f) => f.channelId)).size).toBe(1);
    expect(tunnels[0].identity).toEqual({ userId: "ana", name: "ana" });
    browser.close(); up.close();
  });

  it("ignores a client-supplied channelId — a browser must not address another's tunnel", async () => {
    // Spec §10.4. A client-chosen channel id is the whole vulnerability.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    browser.send(JSON.stringify({
      type: "join", sessionId: "auth", projectId: "default",
      userId: "ana", name: "ana", channelId: "attacker-chosen",
    }));
    await wait(50);
    expect(upSeen.filter((f) => f.t === "tunnel")[0].channelId).not.toBe("attacker-chosen");
    browser.close(); up.close();
  });

  it("routes a laptop reply back to the one browser that asked", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const a = await connect(`ws://127.0.0.1:${hub.port}/`);
    const b = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seenA: any[] = []; const seenB: any[] = [];
    collect(a, seenA); collect(b, seenB);
    a.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    b.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ben", name: "ben" }));
    await wait(50);

    const channelA = upSeen.find((f) => f.t === "tunnel" && f.identity.userId === "ana").channelId;
    seenB.length = 0;
    up.send(JSON.stringify({ t: "reply", channelId: channelA, payload: { type: "error", message: "only for ana" } }));
    await wait(50);
    expect(seenA.some((m) => m.type === "error" && m.message === "only for ana")).toBe(true);
    expect(seenB.some((m) => m.type === "error")).toBe(false);

    a.close(); b.close(); up.close();
  });

  it("tells the browser plainly when no machine is running the session", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "join", sessionId: "ghost", projectId: "default", userId: "ana", name: "ana" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /no machine/i.test(m.message))).toBe(true);
    browser.close();
  });

  it("detaches the channel when the browser goes away", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(40);
    const channelId = upSeen.find((f) => f.t === "tunnel").channelId;
    browser.close();
    await wait(60);
    expect(upSeen).toContainEqual({ t: "detach", channelId });
    up.close();
  });
});

describe("hub protocol faults", () => {
  it("closes an uplink that sends a frame before hello", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    up.send(JSON.stringify({ t: "publish", sessionId: "auth", runId: "run-a", events: [] }));
    expect(await closed).toBe(1008);
  });

  it("closes an uplink that says hello twice", async () => {
    // One identity per socket. A second hello registers an id the close
    // handler can never reclaim, so a dead socket stays registered and the
    // sessions it owns read `online` forever while every tunnelled command is
    // dropped in silence.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    const hello = JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", projectId: "default", repoKey: "k" });
    up.send(hello);
    up.send(hello);
    expect(await closed).toBe(1008);
  });

  it("closes an uplink that sends bytes that are not JSON", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    up.send("{not json");
    expect(await closed).toBe(1008);
  });

  it("answers a browser's bad JSON with an error instead of closing", async () => {
    // Asymmetric on purpose: a laptop speaking nonsense is a protocol fault,
    // a browser speaking nonsense is a bug in one tab.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send("{not json");
    await wait(40);
    expect(seen).toEqual([{ type: "error", message: "invalid JSON" }]);
    expect(browser.readyState).toBe(WebSocket.OPEN);
    browser.close();
  });

  it("survives a browser sending the literal JSON null", async () => {
    // Regression for a process-killing bug: `null` is valid JSON, and reading
    // `.type` off it throws inside a ws message listener — an uncaught
    // exception that takes the whole hub down, every browser with it.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send("null");
    await wait(40);
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    expect(seen.some((m) => m.type === "project")).toBe(true);
    browser.close();
  });

  it("tells a browser to join before it sends a command", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(40);
    expect(seen).toEqual([{ type: "error", message: "join a session first" }]);
    browser.close();
  });

  it("drops a reply naming a channel that does not exist", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    up.send(JSON.stringify({ t: "reply", channelId: "no-such-channel", payload: { type: "error", message: "x" } }));
    await wait(40);
    // Still serving: the unknown channel was ignored, not fatal.
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    expect(seen.some((m) => m.type === "project")).toBe(true);
    browser.close();
    up.close();
  });
});

describe("hub join validation", () => {
  it("refuses a join with no name, exactly as the laptop would", async () => {
    // The laptop's join handler runs its typeof triple BEFORE the relay stamp
    // overwrites userId/name, so a name-less join dies there. A hub that
    // accepts what the laptop rejects binds the channel, replays history and
    // sends a snapshot for a session the laptop never joined the browser to.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana" }));
    await wait(50);
    expect(seen).toEqual([{ type: "error", message: "join requires sessionId, userId, name" }]);
    expect(upSeen.filter((f) => f.t === "tunnel")).toEqual([]);
    browser.close(); up.close();
  });

  it("refuses a join whose userId or sessionId is not a string", async () => {
    // `String({})` is "[object Object]", which is non-empty and would sail
    // through an emptiness check as an identity.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join({ userId: {} }));
    browser.send(join({ sessionId: 123 }));
    await wait(50);
    expect(seen).toEqual([
      { type: "error", message: "join requires sessionId, userId, name" },
      { type: "error", message: "join requires sessionId, userId, name" },
    ]);
    expect(upSeen.filter((f) => f.t === "tunnel")).toEqual([]);
    browser.close(); up.close();
  });

  it("refuses a second join on one socket and keeps the first binding", async () => {
    // server.ts refuses a second join on a socket; the hub's browser-facing
    // protocol is that protocol byte for byte. Rebinding would also strand the
    // first laptop with a channel it is never told to detach.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    up.send(JSON.stringify({ t: "facts", sessionId: "billing", runId: "run-a", facts: facts("billing") }));
    await wait(40);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join());
    await wait(40);
    browser.send(join({ sessionId: "billing" }));
    await wait(50);

    expect(seen.filter((m) => m.type === "error")).toEqual([
      { type: "error", message: "already joined" },
    ]);
    expect(upSeen.filter((f) => f.t === "tunnel").map((f) => f.payload.sessionId)).toEqual(["auth"]);
    browser.close(); up.close();
  });

  it("refuses a join to a session whose laptop is known but offline", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    up.close();
    await wait(60);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join());
    await wait(50);
    expect(seen).toEqual([
      { type: "error", message: 'no machine is running session "auth" right now' },
    ]);
    browser.close();
  });
});

describe("hub reply hardening", () => {
  it("refuses a reply from a laptop that does not own the channel's session", async () => {
    // `channels` is hub-wide. Without an ownership check a laptop holding
    // another's channel id could inject any message into that browser.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const { up: other } = await attachedUplink(hub.port, "billing", "lap-2");

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join());
    await wait(50);
    const channelId = upSeen.find((f) => f.t === "tunnel").channelId;
    seen.length = 0;

    other.send(JSON.stringify({ t: "reply", channelId, payload: { type: "error", message: "not yours" } }));
    await wait(50);
    expect(seen).toEqual([]);
    // The owner still gets through on the very same channel.
    up.send(JSON.stringify({ t: "reply", channelId, payload: { type: "error", message: "mine" } }));
    await wait(50);
    expect(seen).toEqual([{ type: "error", message: "mine" }]);

    browser.close(); up.close(); other.close();
  });

  it("sends nothing rather than an empty frame for a reply with no payload", async () => {
    // JSON.stringify(undefined) is undefined, which ws sends as a zero-length
    // frame — and JSON.parse("") throws in the browser.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const raw: string[] = [];
    browser.on("message", (m) => raw.push(m.toString()));
    browser.send(join());
    await wait(50);
    const channelId = upSeen.find((f) => f.t === "tunnel").channelId;
    raw.length = 0;

    up.send(JSON.stringify({ t: "reply", channelId }));
    await wait(50);
    expect(raw).toEqual([]);
    browser.close(); up.close();
  });
});

describe("hub presence", () => {
  it("keeps a laptop online when a superseded socket for the same uplink closes", async () => {
    // A laptop that reconnects before the hub notices the old socket died has
    // two sockets under one uplinkId for a moment. The late close of the
    // superseded one must not unregister or mark offline the live one.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up: first } = await attachedUplink(hub.port);
    const { up: second } = await attachedUplink(hub.port);
    first.close();
    await wait(60);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    expect(seen.at(-1).sessions[0].presence).toBe("online");
    browser.close(); second.close();
  });

  it("keeps feeding a joined session's events after the browser watches another project", async () => {
    // fanOut keys on projectId AND sessionId, so re-homing a joined channel
    // would silently cut its event stream.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join());
    await wait(40);
    browser.send(JSON.stringify({ type: "watch_project", projectId: "elsewhere" }));
    await wait(40);

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "still mine", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    await wait(50);
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["still mine"]);
    browser.close(); up.close();
  });


  it("flips a session offline when its laptop drops, and keeps the session listed", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    expect(seen.at(-1).sessions[0].presence).toBe("online");

    seen.length = 0;
    up.close();
    await wait(1300); // snapshot pushes are throttled to 1s, like the server's
    const last = seen.filter((m) => m.type === "project").at(-1);
    expect(last.sessions[0].presence).toBe("offline");
    expect(last.sessions[0].id).toBe("auth");
    browser.close();
  });
});

describe("hub session-name collisions", () => {
  it("drops a colliding facts frame, keeps the uplink open, and reports it exactly once", async () => {
    // Two engineers naming a session "auth" in the default project is the
    // ORDINARY case for a cross-repo hub, not an edge case — and a
    // same-machine restart under a fresh uplinkId is indistinguishable from
    // it. A collision is a permanent, PER-SESSION condition (ownership never
    // expires), so escalating it to a transport close punishes every other
    // session that laptop owns: `server.ts`'s throttled push republishes facts
    // for every session about once a second, so the close re-fires on that
    // cadence while the relay reconnects every 2s and swallows it. The laptop
    // flaps ONLINE/OFFLINE in every browser, forever, with no log line on
    // either side. Drop the frame; keep the socket.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    await attachedUplink(hub.port, "auth", "lap-1");

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join());
    await wait(40);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const loser = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    let closedCode: number | null = null;
    loser.on("close", (code) => void (closedCode = code));
    loser.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-2", projectId: "default", repoKey: "k2" }));
    const collide = JSON.stringify({ t: "facts", sessionId: "auth", runId: "run-z", facts: facts("auth") });
    // TWICE, because the cadence is the whole problem. `server.ts` republishes
    // facts for every session on every throttled push, so a real losing laptop
    // sends this about once a second for as long as it is active — and the
    // condition is permanent, since ownership never expires.
    loser.send(collide);
    loser.send(collide);
    // A session lap-2 genuinely owns, sent AFTER the collision: it must still
    // register, which is only possible if the socket survived.
    loser.send(JSON.stringify({ t: "facts", sessionId: "ui", runId: "run-z", facts: facts("ui") }));
    await wait(60);

    expect(closedCode).toBeNull();
    expect(loser.readyState).toBe(WebSocket.OPEN);

    // NOT narrowcast to browsers, at any cadence. The channels joined to
    // "auth" belong to lap-1 — the laptop that legitimately owns it — so an
    // error here tells the users whose session is working fine that it is
    // broken. Once a second, into a client error list with no cap and no
    // dedup (`useSessionSocket.ts`), re-firing `SkillsPanel`'s effect and
    // clearing any in-flight plugin add each time.
    expect(seen.filter((m) => m.type === "error")).toEqual([]);

    // Reported to the hub's console exactly ONCE per (uplinkId, sessionId),
    // not once per frame. Asserting the count — not merely that something was
    // logged — is what makes this test discriminate: a latch that never fires,
    // and a latch that fires every time, both fail it.
    const collisionLogs = logged.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("already owned by another machine"));
    expect(collisionLogs).toEqual([
      'uplink lap-2: session "auth" in project "default" is already owned by another machine (facts frame dropped)',
    ]);
    logged.mockRestore();

    browser.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(50);
    const snap = seen.filter((m) => m.type === "project").at(-1);
    expect(snap.sessions.map((s: any) => s.id).sort()).toEqual(["auth", "ui"]);
    // And "auth" still belongs to the laptop that claimed it first.
    expect(snap.sessions.find((s: any) => s.id === "auth").repoKey).toBe("github.com/acme/api");

    browser.close();
    loser.close();
  });
});

describe("hub per-connection identity", () => {
  it("sets identity without joining a session", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "Ana" }));
    await wait(40);
    expect(seen).toEqual([{ type: "identified", userId: "ana", name: "Ana" }]);
    ws.close();
  });

  it("rejects an identify the laptop would reject", async () => {
    // The hub must refuse precisely what the laptop refuses. A join the hub
    // accepts and the laptop drops is a failure that looks like success.
    // Asserting on message text (not just type) discriminates identify's own
    // validation from the fallthrough path that unrecognized types take.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: 7, name: "Ana" }));
    ws.send(JSON.stringify({ type: "identify", userId: "", name: "Ana" }));
    await wait(40);
    expect(seen.map((m) => m.message)).toEqual([
      "identify requires userId, name",
      "identify requires userId",
    ]);
    ws.close();
  });

  it("refuses an identify on a channel that has already joined", async () => {
    // `join` binds this channel's identity and refuses a second join. Without
    // the same guard on `identify`, a joined channel could rebind who it is at
    // any time — and every membership decision that follows (join_project,
    // create_session, set_project_lifecycle) would be attributed to the new
    // claim. Spec §5.1 makes this the field the hub will verify later; a field
    // overwritable mid-connection cannot become that.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join());
    await wait(40);
    seen.length = 0;
    upSeen.length = 0;

    browser.send(JSON.stringify({ type: "identify", userId: "mal", name: "Mal" }));
    await wait(50);

    // Asserted on TEXT, not type: the tunnel() fallthrough that unrecognized
    // messages take also produces `{ type: "error" }`, with the message "join
    // a session first". Only the message distinguishes the refusal below from
    // that path — and this channel HAS joined, so that path would not even be
    // reached; a type-only assertion would pass with the guard deleted, since
    // the deleted guard's `identified` reply is also a message.
    expect(seen.map((m) => m.message)).toEqual(["already joined"]);
    expect(seen.some((m) => m.type === "identified")).toBe(false);

    // The binding actually held: the next tunnelled frame is still stamped ana.
    browser.send(JSON.stringify({ type: "set_intent", intent: "x" }));
    await wait(50);
    expect(upSeen.filter((f) => f.t === "tunnel").map((f) => f.identity.userId)).toEqual(["ana"]);
    browser.close(); up.close();
  });

  it("truncates an over-long userId and name exactly as join does", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "u".repeat(80), name: "n".repeat(60) }));
    await wait(40);
    expect(seen[0].userId).toHaveLength(64);
    expect(seen[0].name).toHaveLength(40);
    ws.close();
  });
});

describe("hub project registry", () => {
  async function identified(port: number, userId = "ana") {
    const ws = await connect(`ws://127.0.0.1:${port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId, name: userId }));
    await wait(30);
    seen.length = 0;
    return { ws, seen };
  }

  it("creates a project and lists it back", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { ws, seen } = await identified(hub.port);
    ws.send(JSON.stringify({ type: "create_project", name: "Acme Migration" }));
    await wait(30);
    expect(seen[0]).toEqual({ type: "project_created", projectId: "acme-migration" });
    seen.length = 0;
    ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(30);
    expect(seen[0].type).toBe("projects");
    expect(seen[0].projects[0]).toMatchObject({
      id: "acme-migration", name: "Acme Migration", members: ["ana"], lifecycle: "active",
    });
    ws.close();
  });

  it("refuses to create a project without identifying first", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    // Asserting on message text, not just type: an unjoined connection's
    // unrecognized-message fallthrough (`tunnel()` -> "join a session first")
    // also produces `{ type: "error" }`, so a type-only assertion here would
    // pass even if create_project's own "identify first" guard were absent.
    expect(seen[0]).toEqual({ type: "error", message: "identify first" });
    ws.close();
  });

  it("refuses a name that slugifies to nothing", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { ws, seen } = await identified(hub.port);
    ws.send(JSON.stringify({ type: "create_project", name: "!!!" }));
    await wait(30);
    // Same fallthrough trap as above: this connection is identified but has
    // joined no session, so an unhandled create_project would also surface
    // as `{ type: "error" }` via tunnel()'s "join a session first". The
    // message text is what proves the slugify guard itself fired.
    expect(seen[0]).toEqual({ type: "error", message: "create_project requires a usable name" });
    ws.close();
  });

  it("lets anyone list projects they are not a member of — visibility is hub-wide", async () => {
    // Spec P2: visibility is hub-wide, participation is membership-scoped.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ana = await identified(hub.port, "ana");
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    const bo = await identified(hub.port, "bo");
    bo.ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(30);
    expect(bo.seen[0].projects[0].id).toBe("acme");
    expect(bo.seen[0].projects[0].members).toEqual(["ana"]);
    ana.ws.close();
    bo.ws.close();
  });

  it("joins and leaves a project", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ana = await identified(hub.port, "ana");
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    const bo = await identified(hub.port, "bo");
    bo.ws.send(JSON.stringify({ type: "join_project", projectId: "acme" }));
    await wait(30);
    expect(bo.seen[0].projects[0].members).toContain("bo");
    bo.seen.length = 0;
    bo.ws.send(JSON.stringify({ type: "leave_project", projectId: "acme" }));
    await wait(30);
    expect(bo.seen[0].projects[0].members).not.toContain("bo");
    ana.ws.close();
    bo.ws.close();
  });

  it("only a member may change a project's lifecycle", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ana = await identified(hub.port, "ana");
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    const bo = await identified(hub.port, "bo");
    bo.ws.send(JSON.stringify({ type: "set_project_lifecycle", projectId: "acme", lifecycle: "closed" }));
    await wait(30);
    // Message text, not just type: bo is identified but has joined no
    // session, so a missing isMember guard would still fall through to
    // tunnel()'s "join a session first" and pass a type-only check.
    expect(bo.seen[0]).toEqual({ type: "error", message: "join this project before changing it" });
    bo.seen.length = 0;
    ana.seen.length = 0;
    ana.ws.send(JSON.stringify({ type: "set_project_lifecycle", projectId: "acme", lifecycle: "closed" }));
    await wait(30);
    expect(ana.seen[0].projects[0].lifecycle).toBe("closed");
    ana.ws.close();
    bo.ws.close();
  });

  it("rejects an unknown lifecycle value", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { ws, seen } = await identified(hub.port);
    ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    seen.length = 0;
    ws.send(JSON.stringify({ type: "set_project_lifecycle", projectId: "acme", lifecycle: "deleted" }));
    await wait(30);
    // Message text, not just type: same fallthrough trap as the membership
    // test above — this connection has joined no session either.
    expect(seen[0]).toEqual({ type: "error", message: "lifecycle must be active, closed or archived" });
    ws.close();
  });
});

describe("hub routed create_session", () => {
  async function member(port: number, projectId: string, userId = "ana") {
    const ws = await connect(`ws://127.0.0.1:${port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId, name: userId }));
    ws.send(JSON.stringify({ type: "join_project", projectId }));
    await wait(40);
    seen.length = 0;
    return { ws, seen };
  }

  it("forwards the create to the machine offering that repo, byte-identical", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const { ws } = await member(hub.port, "default");
    upSeen.length = 0;
    // "Billing Service" slugifies to "billing-service" — deliberately
    // different from the raw `name`, so this test can only pass if the
    // forwarded payload is the untouched original, not a rewritten one.
    const create = { type: "create_session", projectId: "default", name: "Billing Service", repoKey: "k" };
    ws.send(JSON.stringify(create));
    await wait(50);
    const tunnelled = upSeen.find((f) => f.t === "tunnel");
    expect(tunnelled).toBeTruthy();
    expect(tunnelled.payload).toEqual(create);
    expect(tunnelled.identity).toEqual({ userId: "ana", name: "ana" });
    up.close();
    ws.close();
  });

  it("errors when no online machine offers that repo", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const { ws, seen } = await member(hub.port, "default");
    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "billing", repoKey: "not-here",
    }));
    await wait(40);
    expect(seen[0].type).toBe("error");
    expect(seen[0].message).toContain("not-here");
    up.close();
    ws.close();
  });

  it("errors rather than forwarding when the owning machine has gone offline", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const { ws, seen } = await member(hub.port, "default");
    up.close();
    await wait(60);
    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "billing", repoKey: "k",
    }));
    await wait(40);
    // Message text, not just type: an unjoined connection's unrecognized-type
    // fallthrough (`tunnel()` -> "join a session first") also produces
    // `{ type: "error" }`, so a type-only assertion would pass even with
    // create_session unimplemented. This message is specific to the "no
    // online machine offers this repo" branch, the same one "not-here" hits.
    expect(seen[0].message).toBe('no machine is offering repo "k" right now');
    ws.close();
  });

  it("refuses a non-member — participation is membership-scoped", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "bo", name: "bo" }));
    await wait(30);
    seen.length = 0;
    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "billing", repoKey: "k",
    }));
    await wait(40);
    // Message text, not just type: bo is identified but has joined no
    // session, so the fallthrough to tunnel()'s "join a session first" also
    // produces `{ type: "error" }` and would pass a type-only check even
    // without an isMember guard on create_session.
    expect(seen[0].message).toBe("join this project before creating a session");
    up.close();
    ws.close();
  });

  it("refuses a session name already owned by a different machine", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port, "auth", "lap-1");
    const second = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    second.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-2", projectId: "default", repoKey: "k2",
    }));
    await wait(40);
    const { ws, seen } = await member(hub.port, "default");
    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "auth", repoKey: "k2",
    }));
    await wait(40);
    expect(seen[0].type).toBe("error");
    expect(seen[0].message).toContain("auth");
    up.close();
    second.close();
    ws.close();
  });
});
