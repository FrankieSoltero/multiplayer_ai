import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startHub } from "../src/hub.js";
import { RELAY_PROTOCOL_VERSION, type RepoDecl } from "multiplayer-ai-server/relayProtocol";
import { projectRecordFrom } from "multiplayer-ai-server/record";
import { signSession } from "multiplayer-ai-server/auth";

const decl = (key: string, over: Partial<RepoDecl> = {}): RepoDecl => ({
  key,
  label: key.split("/").pop() ?? key,
  attached: true,
  defaultBranch: "origin/main",
  ...over,
});

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
async function attachedUplink(
  port: number,
  sessionId = "auth",
  uplinkId = "lap-1",
  repos: RepoDecl[] = [decl("k")],
) {
  const up = await connect(`ws://127.0.0.1:${port}/uplink`);
  const seen: any[] = [];
  collect(up, seen);
  up.send(JSON.stringify({
    t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId, name: uplinkId, projectId: "default", repos,
  }));
  up.send(JSON.stringify({ t: "facts", sessionId, runId: "run-a", facts: facts(sessionId) }));
  await wait(40);
  return { up, seen };
}

/** A browser that has identified and joined a project — the precondition for
 *  every `create_session` below. */
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

const join = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana", ...over });

describe("hub uplink handshake", () => {
  it("welcomes a laptop with the offsets it already holds", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const seen: any[] = [];
    collect(up, seen);
    up.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", name: "lap-1",
      projectId: "default", repos: [decl("github.com/acme/api")],
    }));
    await wait(50);
    expect(seen[0]).toEqual({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    up.close();
  });

  it("closes an uplink that speaks the wrong protocol version", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    up.send(JSON.stringify({
      t: "hello", v: 99, uplinkId: "lap-1", name: "lap-1", projectId: "default", repos: [decl("k")],
    }));
    expect(await closed).toBe(1008);
  });

  it("replaces a machine's repo set wholesale when it sends a repos frame", async () => {
    // The frame a daemon emits after an attach or detach lands (spec §5.2).
    // Asserting BOTH directions is what makes this discriminate: the newly
    // attached repo becomes routable, and the dropped one stops being — a
    // merge would pass the first assertion and fail the second.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port, "auth", "lap-1", [decl("github.com/acme/api")]);
    const { ws, seen } = await member(hub.port, "default");

    up.send(JSON.stringify({ t: "repos", repos: [decl("github.com/acme/infra")] }));
    await wait(40);

    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "infra-work",
      repoKey: "github.com/acme/infra",
    }));
    await wait(40);
    expect(seen.filter((m) => m.type === "error")).toEqual([]);

    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "api-work",
      repoKey: "github.com/acme/api",
    }));
    await wait(40);
    expect(seen.at(-1).message).toBe('no machine is offering repo "github.com/acme/api" right now');
    up.close();
    ws.close();
  });

  it("logs when a second daemon claims a machineId an open uplink already holds", async () => {
    // spec §12.2. Two daemons sharing one MPAI_HOME read the SAME persisted
    // machineId, so the second silently evicts the first and the two flap
    // forever. The eviction itself is correct — a reconnecting laptop MUST be
    // able to replace its own stale socket — which is exactly why it needs a
    // line: the two cases are indistinguishable from the hub's side, and this
    // names the one cause an operator can act on.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const helloFrame = JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", name: "lap-1",
      projectId: "default", repos: [decl("k")],
    });
    first.send(helloFrame);
    await wait(40);
    // A plain reconnect — the first socket is CLOSED before the second says
    // hello — must stay silent, or the line fires on every ordinary 2s
    // reconnect and means nothing.
    first.close();
    await wait(60);
    const reconnect = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    reconnect.send(helloFrame);
    await wait(40);
    expect(logged.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("superseded"))).toEqual([]);

    // The real trap: a SECOND, still-open socket under the same id.
    const second = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    second.send(helloFrame);
    await wait(40);
    expect(logged.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("superseded"))).toEqual([
      "uplink lap-1: superseded by a new connection (same machineId from two daemons? check MPAI_HOME)",
    ]);
    logged.mockRestore();
    reconnect.close();
    second.close();
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

    const { ws: browser, seen } = await member(hub.port, "default");
    browser.send(join());
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

    const { ws: a, seen: seenA } = await member(hub.port, "default", "ana");
    const { ws: b, seen: seenB } = await member(hub.port, "default", "ben");
    a.send(join());
    b.send(join({ userId: "ben", name: "ben" }));
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

    const { ws: browser } = await member(hub.port, "default");
    browser.send(join());
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

    const { ws: browser } = await member(hub.port, "default");
    browser.send(join({ channelId: "attacker-chosen" }));
    await wait(50);
    expect(upSeen.filter((f) => f.t === "tunnel")[0].channelId).not.toBe("attacker-chosen");
    browser.close(); up.close();
  });

  it("routes a laptop reply back to the one browser that asked", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const { ws: a, seen: seenA } = await member(hub.port, "default", "ana");
    const { ws: b, seen: seenB } = await member(hub.port, "default", "ben");
    a.send(join());
    b.send(join({ userId: "ben", name: "ben" }));
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
    // No machine ever attached, so the auto-created "default" does not exist —
    // the browser creates it (and is auto-joined as its member) so the join
    // clears the membership gate and reaches the no-machine refusal under test.
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "create_project", name: "default" }));
    await wait(40);
    browser.send(JSON.stringify({ type: "join", sessionId: "ghost", projectId: "default", userId: "ana", name: "ana" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /no machine/i.test(m.message))).toBe(true);
    browser.close();
  });

  it("detaches the channel when the browser goes away", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const { ws: browser } = await member(hub.port, "default");
    browser.send(join());
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
    const hello = JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", name: "lap-1",
      projectId: "default", repos: [decl("k")],
    });
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
    // Liveness probe after the null: identify and create the project (auto-join
    // makes the caller its member) so the members-only watch_project can answer
    // — the point is the hub survived the null, still serving this socket.
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "create_project", name: "default" }));
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
    const { ws: browser, seen } = await member(hub.port, "default");
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

    const { ws: browser, seen } = await member(hub.port, "default");
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

    const { ws: browser, seen } = await member(hub.port, "default");
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

    const { ws: browser, seen } = await member(hub.port, "default");
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
    const { ws: browser } = await member(hub.port, "default");
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

    const { ws: browser, seen } = await member(hub.port, "default");
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
    const { ws: browser, seen } = await member(hub.port, "default");
    browser.send(join());
    await wait(40);
    // Not a member of "elsewhere", so this watch is refused — but the point
    // stands: a joined channel is never re-homed (the refusal exits before the
    // re-home line, exactly as the joined-channel guard would), so its own
    // session's stream is never cut.
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

    const { ws: browser, seen } = await member(hub.port, "default");
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

    const { ws: browser, seen } = await member(hub.port, "default");
    browser.send(join());
    await wait(40);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const loser = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    let closedCode: number | null = null;
    loser.on("close", (code) => void (closedCode = code));
    loser.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-2", name: "lap-2",
      projectId: "default", repos: [decl("k2")],
    }));
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
    const { ws: browser, seen } = await member(hub.port, "default");
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

describe("hub verified identity stamping", () => {
  // A throwaway auth config. `alice` is the sole allowlisted login; the
  // session secret is what `signSession` below signs with, so a cookie the
  // hub will accept is `mpai_session=<signSession(login, SECRET)>`. The
  // OAuth fields are present only to satisfy AuthConfig's shape — no route
  // under test ever exchanges a code.
  const SECRET = "test-secret";
  const AUTH = {
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: SECRET,
    allowlist: "alice",
  };
  const cookieFor = (login: string) => ({ cookie: `mpai_session=${signSession(login, SECRET)}` });

  // The `ws` client reads request headers ONCE at the upgrade; the hub holds
  // that cookie for the life of the connection (WS messages carry no cookies).
  function connectWith(url: string, headers?: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  it("stamps the verified login over the browser's identify claim", async () => {
    // The trust inversion (spec §3.5 rule 1): the browser claims `mallory`,
    // the hub discards it and stamps the cookie-verified login as BOTH id and
    // display name. Asserting the full reply — not just that it is not
    // `mallory` — pins the name lock too (spec §3.4).
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: AUTH });
    close = hub.close;
    const ws = await connectWith(`ws://127.0.0.1:${hub.port}`, cookieFor("alice"));
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "mallory", name: "m" }));
    await wait(40);
    expect(seen).toEqual([{ type: "identified", userId: "alice", name: "alice" }]);
    ws.close();
  });

  it("refuses an identify with no cookie and with a forged cookie alike", async () => {
    // Both auth-on refusals of the missing-identity kind resolve to the same
    // string, in the same order the standalone join gate uses (spec §4.3):
    // no cookie and a signature the hub did not sign are both unauthenticated.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: AUTH });
    close = hub.close;
    const none = await connectWith(`ws://127.0.0.1:${hub.port}`);
    const forged = await connectWith(`ws://127.0.0.1:${hub.port}`, {
      cookie: "mpai_session=not.a.real.token",
    });
    const s1: any[] = []; const s2: any[] = [];
    collect(none, s1); collect(forged, s2);
    none.send(JSON.stringify({ type: "identify", userId: "alice", name: "alice" }));
    forged.send(JSON.stringify({ type: "identify", userId: "alice", name: "alice" }));
    await wait(40);
    expect(s1).toEqual([{ type: "error", message: "authentication required" }]);
    expect(s2).toEqual([{ type: "error", message: "authentication required" }]);
    none.close(); forged.close();
  });

  it("refuses an identify for a verified login off the allowlist", async () => {
    // A validly-signed cookie whose login is not allowlisted is the SECOND
    // refusal, distinct from "authentication required" — the cookie verifies,
    // the person is simply not admitted (spec §4.3).
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: AUTH });
    close = hub.close;
    const ws = await connectWith(`ws://127.0.0.1:${hub.port}`, cookieFor("mallory"));
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "mallory", name: "mallory" }));
    await wait(40);
    expect(seen).toEqual([{ type: "error", message: "not on the allowlist" }]);
    ws.close();
  });

  it("stamps the verified login on join, and tunnels it as the identity", async () => {
    // The join path's stamp is what the laptop's relay arm trusts
    // (server.ts's `io.mode === "relay"` branch): the tunnelled `identity`
    // must carry the verified login, not the `mallory` the payload claims.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: AUTH });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connectWith(`ws://127.0.0.1:${hub.port}`, cookieFor("alice"));
    // alice (the verified login) joins the project so the membership gate on
    // `join` passes; the claim in the payload stays "mallory" to prove the
    // stamp still wins.
    browser.send(JSON.stringify({ type: "identify", userId: "mallory", name: "m" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(40);
    browser.send(join({ userId: "mallory", name: "m" }));
    await wait(50);
    const tunnels = upSeen.filter((f) => f.t === "tunnel");
    expect(tunnels.map((f) => f.payload.type)).toEqual(["join"]);
    expect(tunnels[0].identity).toEqual({ userId: "alice", name: "alice" });
    browser.close(); up.close();
  });

  it("refuses a join whose cookie is missing or off the allowlist", async () => {
    // The same two refusals as identify, on the join gate — and BEFORE the
    // tunnel, so a rejected join never reaches the laptop.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: AUTH });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const noCookie = await connectWith(`ws://127.0.0.1:${hub.port}`);
    const offList = await connectWith(`ws://127.0.0.1:${hub.port}`, cookieFor("mallory"));
    const s1: any[] = []; const s2: any[] = [];
    collect(noCookie, s1); collect(offList, s2);
    noCookie.send(join());
    offList.send(join());
    await wait(50);
    expect(s1.map((m) => m.message)).toEqual(["authentication required"]);
    expect(s2.map((m) => m.message)).toEqual(["not on the allowlist"]);
    expect(upSeen.filter((f) => f.t === "tunnel")).toEqual([]);
    noCookie.close(); offList.close(); up.close();
  });

  it("keeps the client's identify/join claim verbatim when auth is off", async () => {
    // Auth off (no `auth`): `requireAuth` admits every request with a null
    // login, so the browser's claim stands byte-for-byte — even the truncation
    // is unchanged — preserving today's behaviour. A stray cookie is ignored.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connectWith(`ws://127.0.0.1:${hub.port}`, cookieFor("alice"));
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "mallory", name: "m" }));
    // Auth off: the claim (mallory) is the identity, so mallory joins the
    // project to clear the membership gate on `join` below.
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(40);
    // Identify with auth off is a no-op guard-wise but proves the claim holds.
    // (A join re-binds identity; assert the tunnelled identity keeps the claim.)
    browser.send(join({ userId: "mallory", name: "m" }));
    await wait(50);
    expect(seen[0]).toEqual({ type: "identified", userId: "mallory", name: "m" });
    const tunnels = upSeen.filter((f) => f.t === "tunnel");
    expect(tunnels[0].identity).toEqual({ userId: "mallory", name: "m" });
    browser.close(); up.close();
  });

  it("refuses a second identify after join even with auth on", async () => {
    // The already-joined guard runs BEFORE the auth gate, so the refusal is
    // "already joined" (not re-verification), and the join-bound identity
    // holds — the auth wiring must not disturb this existing guard.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: AUTH });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connectWith(`ws://127.0.0.1:${hub.port}`, cookieFor("alice"));
    const seen: any[] = [];
    collect(browser, seen);
    // alice (verified) joins the project so the first `join` clears the gate.
    browser.send(JSON.stringify({ type: "identify", userId: "mallory", name: "m" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(40);
    browser.send(join({ userId: "mallory", name: "m" }));
    await wait(40);
    seen.length = 0;
    upSeen.length = 0;
    browser.send(JSON.stringify({ type: "identify", userId: "alice", name: "alice" }));
    await wait(50);
    expect(seen.map((m) => m.message)).toEqual(["already joined"]);
    expect(seen.some((m) => m.type === "identified")).toBe(false);
    browser.send(JSON.stringify({ type: "set_intent", intent: "x" }));
    await wait(50);
    expect(upSeen.filter((f) => f.t === "tunnel").map((f) => f.identity.userId)).toEqual(["alice"]);
    browser.close(); up.close();
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

  it("keeps a non-member's list entry visible but redacts its roster (spec A5)", async () => {
    // Spec A5 (supersedes P2): the list is the join affordance so it stays
    // hub-wide, but a non-member sees no roster — real memberCount, empty
    // members, isMember false. No login of a member may leak in the entry.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ana = await identified(hub.port, "ana");
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    const bo = await identified(hub.port, "bo");
    bo.ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(30);
    const entry = bo.seen[0].projects[0];
    expect(entry.id).toBe("acme"); // still visible
    expect(entry.isMember).toBe(false);
    expect(entry.memberCount).toBe(1); // REAL size, not the redacted array's length
    expect(entry.members).toEqual([]); // no logins disclosed
    expect(JSON.stringify(entry)).not.toContain("ana");
    ana.ws.close();
    bo.ws.close();
  });

  it("gives a member the full roster with memberCount and isMember true (spec A5)", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ana = await identified(hub.port, "ana");
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    const bo = await identified(hub.port, "bo");
    bo.ws.send(JSON.stringify({ type: "join_project", projectId: "acme" }));
    await wait(30);
    bo.seen.length = 0;
    bo.ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(30);
    const entry = bo.seen[0].projects[0];
    expect(entry.isMember).toBe(true);
    expect(entry.memberCount).toBe(2);
    expect(entry.members).toEqual(["ana", "bo"]); // full roster for a member
    ana.ws.close();
    bo.ws.close();
  });

  it("redacts every entry for an unidentified channel (spec A5)", async () => {
    // No identity yet: the list stays the join affordance (entry visible), but
    // every roster is redacted — real memberCount, isMember false, members [].
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ana = await identified(hub.port, "ana");
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(30);
    const entry = seen[0].projects[0];
    expect(entry.id).toBe("acme"); // still visible: the join affordance
    expect(entry.isMember).toBe(false);
    expect(entry.memberCount).toBe(1);
    expect(entry.members).toEqual([]);
    expect(JSON.stringify(entry)).not.toContain("ana");
    ana.ws.close();
    ws.close();
  });

  it("tailors each channel's pushProjects payload to its own membership (spec A5)", async () => {
    // ONE state change fans out ONE push to every channel; each channel's copy
    // is redacted for THAT channel. A member and a non-member watching the same
    // push must receive DIFFERENT payloads for the same project entry.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ana = await identified(hub.port, "ana");
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
    await wait(30);
    const bo = await identified(hub.port, "bo"); // never joins acme
    await wait(30);
    ana.seen.length = 0;
    bo.seen.length = 0;
    // A single directory change (ana creates a second project) → one pushProjects.
    ana.ws.send(JSON.stringify({ type: "create_project", name: "Beta" }));
    await wait(30);
    const anaAcme = ana.seen.at(-1).projects.find((p: any) => p.id === "acme");
    const boAcme = bo.seen.at(-1).projects.find((p: any) => p.id === "acme");
    expect(anaAcme.isMember).toBe(true);
    expect(anaAcme.members).toEqual(["ana"]); // member sees the roster
    expect(boAcme.isMember).toBe(false);
    expect(boAcme.members).toEqual([]); // non-member's copy of the SAME push is redacted
    expect(boAcme.memberCount).toBe(1);
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

  it("matches a repo anywhere in the machine's declared list, and never a candidate", async () => {
    // The match runs over the whole `repos` list (hello v2), not one scalar:
    // the third repo a machine offers must route as readily as the first. A
    // CANDIDATE — discovered by the scan, not attached — must NOT count: it
    // has no workspace, so nothing can be hosted in it yet, and routing there
    // would hand the browser a failure the machine alone could explain.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port, "auth", "lap-1", [
      decl("github.com/acme/api"),
      decl("github.com/acme/web", { attached: false, defaultBranch: null }),
      decl("github.com/acme/infra"),
    ]);
    const { ws, seen } = await member(hub.port, "default");
    upSeen.length = 0;

    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "infra-work",
      repoKey: "github.com/acme/infra",
    }));
    await wait(50);
    expect(upSeen.find((f) => f.t === "tunnel")?.payload.repoKey).toBe("github.com/acme/infra");

    seen.length = 0;
    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "web-work",
      repoKey: "github.com/acme/web",
    }));
    await wait(50);
    expect(seen[0].message).toBe('no machine is offering repo "github.com/acme/web" right now');
    up.close();
    ws.close();
  });

  it("routes to the machine the browser named", async () => {
    // Two machines offer the SAME repo, so first-online-match would be a coin
    // toss — naming one is the only way a user can say "run it over there"
    // (spec §5.2). Asserting the OTHER machine got nothing is what makes this
    // discriminate: an implementation that ignored `machineId` entirely would
    // still have tunnelled to somebody.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up: a, seen: aSeen } = await attachedUplink(hub.port, "auth", "lap-a", [
      decl("github.com/acme/api"),
    ]);
    const { up: b, seen: bSeen } = await attachedUplink(hub.port, "ui", "lap-b", [
      decl("github.com/acme/api"),
    ]);
    const { ws } = await member(hub.port, "default");
    aSeen.length = 0;
    bSeen.length = 0;

    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "billing",
      repoKey: "github.com/acme/api", machineId: "lap-b",
    }));
    await wait(50);
    expect(bSeen.filter((f) => f.t === "tunnel")).toHaveLength(1);
    expect(aSeen.filter((f) => f.t === "tunnel")).toEqual([]);
    a.close();
    b.close();
    ws.close();
  });

  it("refuses a named machine that does not offer the requested repo", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up: a } = await attachedUplink(hub.port, "auth", "lap-a", [decl("github.com/acme/api")]);
    const { up: b } = await attachedUplink(hub.port, "ui", "lap-b", [decl("github.com/acme/web")]);
    const { ws, seen } = await member(hub.port, "default");

    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "billing",
      repoKey: "github.com/acme/api", machineId: "lap-b",
    }));
    await wait(50);
    // Distinct from the no-machine-at-all text on purpose: another machine
    // DOES offer this repo, and telling the user "nobody has it" would send
    // them looking for a problem that is not there.
    expect(seen[0].message).toBe('that machine is not offering repo "github.com/acme/api"');
    a.close();
    b.close();
    ws.close();
  });

  it("refuses a named machine that is offline or unknown", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port, "auth", "lap-a", [decl("github.com/acme/api")]);
    const { ws, seen } = await member(hub.port, "default");

    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "billing",
      repoKey: "github.com/acme/api", machineId: "lap-ghost",
    }));
    await wait(40);
    expect(seen[0].message).toBe('machine "lap-ghost" is not online right now');

    seen.length = 0;
    up.close();
    await wait(60);
    ws.send(JSON.stringify({
      type: "create_session", projectId: "default", name: "billing",
      repoKey: "github.com/acme/api", machineId: "lap-a",
    }));
    await wait(40);
    expect(seen[0].message).toBe('machine "lap-a" is not online right now');
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
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-2", name: "lap-2",
      projectId: "default", repos: [decl("k2")],
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

describe("hub routed attach_repo/detach_repo", () => {
  it("tunnels attach_repo and detach_repo to the named machine with identity stamped and the grant set", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port, "auth", "lap-1", [decl("k")]);
    const { ws } = await member(hub.port, "default");
    upSeen.length = 0;

    const attach = { type: "attach_repo", projectId: "default", machineId: "lap-1", repoKey: "k" };
    ws.send(JSON.stringify(attach));
    await wait(50);
    const tunnelled1 = upSeen.find((f) => f.t === "tunnel");
    expect(tunnelled1).toBeTruthy();
    expect(tunnelled1.payload).toEqual(attach);
    expect(tunnelled1.identity).toEqual({ userId: "ana", name: "ana" });

    upSeen.length = 0;
    const detach = { type: "detach_repo", projectId: "default", machineId: "lap-1", repoKey: "k" };
    ws.send(JSON.stringify(detach));
    await wait(50);
    const tunnelled2 = upSeen.find((f) => f.t === "tunnel");
    expect(tunnelled2).toBeTruthy();
    expect(tunnelled2.payload).toEqual(detach);
    expect(tunnelled2.identity).toEqual({ userId: "ana", name: "ana" });

    up.close();
    ws.close();
  });

  it("refuses a non-member — participation is membership-scoped", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port, "auth", "lap-1", [decl("k")]);
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "bo", name: "bo" }));
    await wait(30);
    seen.length = 0;
    ws.send(JSON.stringify({
      type: "attach_repo", projectId: "default", machineId: "lap-1", repoKey: "k",
    }));
    await wait(40);
    // Message text, not just type: bo is identified but has joined no
    // session, so the fallthrough to tunnel()'s "join a session first" also
    // produces `{ type: "error" }` and would pass a type-only check even
    // without an isMember guard.
    expect(seen[0].message).toBe("join this project before changing its machines");
    up.close();
    ws.close();
  });

  it("refuses attach_repo/detach_repo to a machine that is offline", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port, "auth", "lap-1", [decl("k")]);
    up.close();
    await wait(60);

    const { ws, seen } = await member(hub.port, "default");
    ws.send(JSON.stringify({
      type: "attach_repo", projectId: "default", machineId: "lap-1", repoKey: "k",
    }));
    await wait(40);
    expect(seen[0].message).toBe('machine "lap-1" is not online right now');
    ws.close();
  });

  it("refuses a repo key the machine never advertised", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port, "auth", "lap-1", [decl("k")]);
    const { ws, seen } = await member(hub.port, "default");
    ws.send(JSON.stringify({
      type: "attach_repo", projectId: "default", machineId: "lap-1", repoKey: "ghost",
    }));
    await wait(40);
    expect(seen[0].message).toBe('machine "lap-1" does not list repo "ghost"');
    up.close();
    ws.close();
  });

  it("routes attach_repo to a not-yet-attached candidate — the hub gate does not require `attached`", async () => {
    // Deliberately coarser than create_session's `attached && key` offer
    // check: attach targets a candidate that is NOT attached yet, so
    // requiring `attached` here would make attach_repo permanently
    // unroutable. Only a key the machine never advertised at all is refused
    // at the hub; the laptop (Task 6) enforces candidate/blocker semantics.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port, "auth", "lap-1", [
      decl("k", { attached: false, defaultBranch: null }),
    ]);
    const { ws } = await member(hub.port, "default");
    upSeen.length = 0;
    ws.send(JSON.stringify({
      type: "attach_repo", projectId: "default", machineId: "lap-1", repoKey: "k",
    }));
    await wait(50);
    expect(upSeen.find((f) => f.t === "tunnel")?.payload).toEqual({
      type: "attach_repo", projectId: "default", machineId: "lap-1", repoKey: "k",
    });
    up.close();
    ws.close();
  });

  it("routes the machine's reply back to the asking browser, grant spent on use", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port, "auth", "lap-1", [decl("k")]);
    const { ws, seen } = await member(hub.port, "default");
    ws.send(JSON.stringify({
      type: "attach_repo", projectId: "default", machineId: "lap-1", repoKey: "k",
    }));
    await wait(50);
    const channelId = upSeen.find((f) => f.t === "tunnel").channelId;
    seen.length = 0;

    up.send(JSON.stringify({
      t: "reply", channelId, payload: { type: "repo_attached", repoKey: "k" },
    }));
    await wait(50);
    expect(seen).toEqual([{ type: "repo_attached", repoKey: "k" }]);
    up.close();
    ws.close();
  });
});

/** Hub `get_record` (spec §4.3, §8a.1). The wire pair is byte-shape identical to
 *  the standalone server's (`server/test/serverRecord.test.ts`); the deliberate
 *  asymmetry is the gate — the hub requires `identify` where the laptop reuses
 *  `denyUnauthed()` (owner ruling, spec §8a.1) — and `machineId`, which here is
 *  the OWNING uplink per session rather than one machine for the whole project,
 *  because only the hub sees more than one laptop. */
describe("hub get_record", () => {
  const rec = (
    seq: number,
    over: Record<string, unknown>,
  ): Record<string, unknown> => ({
    seq,
    ts: `2026-07-27T00:00:${String(seq).padStart(2, "0")}.000Z`,
    ...over,
  });

  /** One closed turn: a prompt, an edit, and the `turn_end` that closes it. */
  const turnLog = (userId: string, text: string, path: string) => [
    rec(0, { type: "user_message", userId, text }),
    rec(1, { type: "tool_call", toolName: "Edit", input: { file_path: path } }),
    rec(2, { type: "turn_end" }),
  ];

  it("answers with the whole project record, stamping each session's OWNING machine", async () => {
    // Two laptops, one project: the case a standalone server cannot answer at
    // all. Every session must carry its own owner's uplinkId, so a single
    // shared machineId (or the asker's) would fail here.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up: lap1 } = await attachedUplink(hub.port, "auth", "lap-1");
    const { up: lap2 } = await attachedUplink(hub.port, "chat", "lap-2");
    const authLog = turnLog("ana", "ship the record", "/src/record.ts");
    const chatLog = turnLog("bo", "now the panel", "/src/panel.ts");
    lap1.send(JSON.stringify({ t: "publish", sessionId: "auth", runId: "run-a", events: authLog }));
    lap2.send(JSON.stringify({ t: "publish", sessionId: "chat", runId: "run-a", events: chatLog }));
    await wait(50);

    const { ws, seen } = await member(hub.port, "default");
    ws.send(JSON.stringify({ type: "get_record", projectId: "default" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "record")).toBe(true));

    // The whole reply, against `projectRecordFrom` run over the very inputs the
    // hub holds: the hub derives the record and publishes that answer
    // unaltered, rather than assembling a second, drift-prone version of it.
    const reply = seen.find((m) => m.type === "record");
    expect(reply).toEqual({
      type: "record",
      projectId: "default",
      record: projectRecordFrom("default", [
        { facts: facts("auth") as any, machineId: "lap-1", events: authLog as any },
        { facts: facts("chat") as any, machineId: "lap-2", events: chatLog as any },
      ]),
    });
    // Spelled out too, so a change to `projectRecordFrom` cannot make the
    // assertion above pass by moving both sides at once.
    expect(reply.record.sessions.map((s: any) => [s.sessionId, s.machineId])).toEqual([
      ["auth", "lap-1"],
      ["chat", "lap-2"],
    ]);
    expect(reply.record.rollup).toEqual({
      perUser: [
        { userId: "ana", turnsDriven: 1, approvalsGiven: 0, denialsGiven: 0 },
        { userId: "bo", turnsDriven: 1, approvalsGiven: 0, denialsGiven: 0 },
      ],
      totalTurns: 2,
      totalSessions: 2,
    });
    expect(seen.some((m) => m.type === "error")).toBe(false);
    ws.close(); lap1.close(); lap2.close();
  });

  it("refuses a get_record from a channel that has not identified", async () => {
    // Same gate and the same string as `create_project` (hub.ts:409) — the hub
    // pins the identity line here for v7b2's real auth (spec §8a.1).
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const ws = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "get_record", projectId: "default" }));
    await wait(60);
    expect(seen).toEqual([{ type: "error", message: "identify first" }]);
    ws.close(); up.close();
  });

  it("refuses get_record from an identified non-member (A5 supersedes P2)", async () => {
    // The APPROVED spec A5 REVERSES P2 here: the record carries every session's
    // `filesChanged`, the same exposure class as the snapshot's `touched`, so it
    // is members-only now — an identified non-member is refused, not answered.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: turnLog("ana", "members only?", "/src/a.ts"),
    }));
    await wait(40);

    const ws = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "cy", name: "Cy" }));
    ws.send(JSON.stringify({ type: "get_record", projectId: "default" }));
    await wait(60);

    expect(seen.filter((m) => m.type === "error")).toEqual([
      { type: "error", message: "join this project to see its record", code: "not_a_member" },
    ]);
    expect(seen.some((m) => m.type === "record")).toBe(false);
    ws.close(); up.close();
  });

  it("rejects a projectId that is missing or fails SLUG, with the standalone server's string", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { ws, seen } = await member(hub.port, "default");

    ws.send(JSON.stringify({ type: "get_record", projectId: "BAD SLUG" }));
    ws.send(JSON.stringify({ type: "get_record" }));
    ws.send(JSON.stringify({ type: "get_record", projectId: 7 }));
    await wait(60);

    expect(seen.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "get_record requires a valid projectId",
      "get_record requires a valid projectId",
      "get_record requires a valid projectId",
    ]);
    expect(seen.some((m) => m.type === "record")).toBe(false);
    ws.close();
  });

  it("refuses get_record for an unknown project and creates nothing", async () => {
    // An unknown project has no members, so the membership gate refuses it —
    // and, exactly as before, the read never grows the registry (the old
    // `readSessionsOf` discipline): `list_projects` still shows only "default".
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const { ws, seen } = await member(hub.port, "default");

    ws.send(JSON.stringify({ type: "get_record", projectId: "ghost" }));
    await wait(60);
    expect(seen.filter((m) => m.type === "error")).toEqual([
      { type: "error", message: "join this project to see its record", code: "not_a_member" },
    ]);
    expect(seen.some((m) => m.type === "record")).toBe(false);

    ws.send(JSON.stringify({ type: "list_projects" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "projects")).toBe(true));
    expect(seen.at(-1).projects.map((p: any) => p.id)).toEqual(["default"]);
    ws.close(); up.close();
  });

  it("answers a joined channel without re-homing it", async () => {
    // `fanOut` keys on projectId AND sessionId, so re-homing a joined channel
    // would silently cut its event stream — the same rule `watch_project`
    // observes. The caller is a member of a SECOND project "elsewhere" and reads
    // its record; the joined "default"/"auth" stream must survive intact.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const { ws: browser, seen } = await member(hub.port, "default");
    // A second project the caller belongs to (create_project auto-joins it), so
    // its get_record clears the membership gate without touching "default".
    browser.send(JSON.stringify({ type: "create_project", name: "elsewhere" }));
    await wait(40);
    browser.send(join());
    await wait(40);
    seen.length = 0;

    browser.send(JSON.stringify({ type: "get_record", projectId: "elsewhere" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "record")).toBe(true));

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "still mine", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    await wait(50);
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["still mine"]);
    browser.close(); up.close();
  });
});

describe("hub membership gates on participation", () => {
  // Task 4 (spec A4, A5): participation gets the same membership gate
  // provisioning already has. Every gate below carries a refusal test AND its
  // sibling member pass-through, so the gate is shown to DISCRIMINATE rather
  // than merely to reject. `not_a_member` is the code the browser reads to turn
  // the refusal into a "join this project" affordance (spec §4.2 shape).
  const SECRET = "test-secret";
  const AUTH = { clientId: "cid", clientSecret: "csecret", sessionSecret: SECRET, allowlist: "alice" };
  const cookieFor = (login: string) => ({ cookie: `mpai_session=${signSession(login, SECRET)}` });
  function connectWith(url: string, headers?: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  it("refuses a join from a non-member and sends no replay, snapshot or tunnel", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "history", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    await wait(40);
    upSeen.length = 0;

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    // Identify (auth off, claim stands) but never join_project — the "default"
    // project a machine attach auto-creates has no members.
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(join());
    await wait(50);

    expect(seen.filter((m) => m.type === "error")).toEqual([
      { type: "error", message: "join this project before joining its sessions", code: "not_a_member" },
    ]);
    // No replay, no snapshot: the refusal happens before any binding.
    expect(seen.some((m) => m.type === "event")).toBe(false);
    expect(seen.some((m) => m.type === "project")).toBe(false);
    // And nothing reached the laptop.
    expect(upSeen.filter((f) => f.t === "tunnel")).toEqual([]);
    browser.close(); up.close();
  });

  it("lets a member join, replaying, snapshotting and tunnelling exactly as before", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "history", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    await wait(40);
    upSeen.length = 0;

    const { ws: browser, seen } = await member(hub.port, "default");
    browser.send(join());
    await wait(50);

    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["history"]);
    expect(seen.some((m) => m.type === "project")).toBe(true);
    expect(seen.some((m) => m.type === "error")).toBe(false);
    expect(upSeen.filter((f) => f.t === "tunnel").map((f) => f.payload.type)).toEqual(["join"]);
    browser.close(); up.close();
  });

  it("tells an unidentified channel to identify before watch_project or peek", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    browser.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(50);
    expect(seen).toEqual([
      { type: "error", message: "identify first" },
      { type: "error", message: "identify first" },
    ]);
    expect(seen.some((m) => m.type === "project")).toBe(false);
    browser.close(); up.close();
  });

  it("refuses watch_project and peek from a non-member, and does not re-home the channel", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    await wait(30);
    seen.length = 0;
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    browser.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(50);
    expect(seen.filter((m) => m.type === "error")).toEqual([
      { type: "error", message: "join this project to see it", code: "not_a_member" },
      { type: "error", message: "join this project to see it", code: "not_a_member" },
    ]);
    expect(seen.some((m) => m.type === "project")).toBe(false);

    // NOT re-homed: a refused watch must not set channel.projectId, so a later
    // project push must never reach this non-member.
    seen.length = 0;
    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "members only", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    await wait(50);
    expect(seen.some((m) => m.type === "project")).toBe(false);
    browser.close(); up.close();
  });

  it("answers watch_project and peek for a member", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const { ws, seen } = await member(hub.port, "default");
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    ws.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(50);
    expect(seen.filter((m) => m.type === "project")).toHaveLength(2);
    expect(seen.some((m) => m.type === "error")).toBe(false);
    ws.close(); up.close();
  });

  it("refuses get_record from an identified non-member", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    await wait(30);
    seen.length = 0;
    browser.send(JSON.stringify({ type: "get_record", projectId: "default" }));
    await wait(50);
    expect(seen).toEqual([
      { type: "error", message: "join this project to see its record", code: "not_a_member" },
    ]);
    expect(seen.some((m) => m.type === "record")).toBe(false);
    browser.close(); up.close();
  });

  it("stops fanning a project push to a member that has left, without disconnecting it", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const { ws, seen } = await member(hub.port, "default");
    // Watch to be homed onto the project's push feed (join_project alone does
    // not set channel.projectId).
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    seen.length = 0;

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "while a member", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    // Pushes are throttled to 1s (like the server's), so the first one may be
    // deferred to the next window — wait for it rather than racing it.
    await vi.waitFor(() => expect(seen.some((m) => m.type === "project")).toBe(true), { timeout: 2000 });

    ws.send(JSON.stringify({ type: "leave_project", projectId: "default" }));
    await wait(40);
    seen.length = 0;

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "after leaving", seq: 1, ts: "2026-07-27T00:00:01.000Z" }],
    }));
    // Past a full throttle window: a push would have fired by now if one were
    // going to. Silenced by the fan-out isMember filter — but never disconnected.
    await wait(1300);
    expect(seen.some((m) => m.type === "project")).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close(); up.close();
  });

  it("gates on the VERIFIED login, not the browser's claim, when auth is on", async () => {
    // Auth on: alice is allowlisted and verified, but not a member of "default".
    // The gate must run on the stamped login (alice), refusing even though the
    // payload claims a different user — the whole point of stamping first.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: AUTH });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connectWith(`ws://127.0.0.1:${hub.port}`, cookieFor("alice"));
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(join({ userId: "mallory", name: "m" }));
    await wait(50);
    expect(seen.filter((m) => m.type === "error")).toEqual([
      { type: "error", message: "join this project before joining its sessions", code: "not_a_member" },
    ]);
    expect(upSeen.filter((f) => f.t === "tunnel")).toEqual([]);

    // And once alice — the verified login — joins the project, the same join
    // goes through, proving membership was checked against alice all along
    // (never mallory, who is refused as a non-member above and never joins).
    // A refused join does not stamp identity, so identify (verified as alice)
    // must run before join_project can attribute the membership to alice.
    browser.send(JSON.stringify({ type: "identify", userId: "mallory", name: "m" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(40);
    seen.length = 0; upSeen.length = 0;
    browser.send(join({ userId: "mallory", name: "m" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error")).toBe(false);
    const tunnels = upSeen.filter((f) => f.t === "tunnel");
    expect(tunnels.map((f) => f.payload.type)).toEqual(["join"]);
    expect(tunnels[0].identity).toEqual({ userId: "alice", name: "alice" });
    browser.close(); up.close();
  });
});
