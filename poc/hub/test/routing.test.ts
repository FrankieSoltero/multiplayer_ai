import { afterEach, describe, expect, it } from "vitest";
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
async function attachedUplink(port: number, sessionId = "auth") {
  const up = await connect(`ws://127.0.0.1:${port}/uplink`);
  const seen: any[] = [];
  collect(up, seen);
  up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", projectId: "default", repoKey: "k" }));
  up.send(JSON.stringify({ t: "facts", sessionId, runId: "run-a", facts: facts(sessionId) }));
  await wait(40);
  return { up, seen };
}

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
    expect(upSeen.filter((f) => f.t === "publish")).toHaveLength(0);

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

describe("hub presence", () => {
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
