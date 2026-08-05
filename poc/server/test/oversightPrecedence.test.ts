import { describe, it, expect, vi, afterEach } from "vitest";

/** Same capture seam `serverContested.test.ts` uses: the session entries the
 *  server builds are reachable no other way (nothing on the wire carries the
 *  effective-oversight decision, and `startServer` exposes no registry), so the
 *  `Project` the server constructs is captured at construction and read off
 *  directly. */
const { createdProjects } = vi.hoisted(() => ({
  createdProjects: [] as import("../src/project.js").Project[],
}));

vi.mock("../src/project.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/project.js")>();
  class TrackedProject extends actual.Project {
    constructor(id: string) {
      super(id);
      createdProjects.push(this);
    }
  }
  return { ...actual, Project: TrackedProject };
});

import { type RunQuery } from "../src/agentDriver.js";
import { startServer } from "../src/server.js";
import { Relay, type RelaySocket } from "../src/relay.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relayProtocol.js";

// ---------------------------------------------------------------------------
// Relay unit: the hubOversight frame store
// ---------------------------------------------------------------------------

/** One fake hub socket, reused across (re)connects — enough for a single
 *  connection's lifecycle, which is all these store tests exercise. */
function fakeHubSocket() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const state = { closeRequested: false };
  const socket: RelaySocket = {
    send: () => {},
    close: () => void (state.closeRequested = true),
    on: (event, fn) => void handlers.set(event, fn),
  };
  return {
    connect: () => socket,
    state,
    open: () => handlers.get("open")?.(),
    deliver: (frame: unknown) => handlers.get("message")?.(JSON.stringify(frame)),
    drop: (code?: number) => handlers.get("close")?.(code),
  };
}

function relayWith(fake: ReturnType<typeof fakeHubSocket>) {
  return new Relay(
    {
      hubUrl: "ws://hub.test",
      projectId: "default",
      name: "Ana's MacBook",
      repos: () => [],
      uplinkId: "lap-1",
      connect: fake.connect,
      // Large enough that no reconnect timer fires inside a test; each test
      // stop()s the relay to clear it regardless.
      reconnectDelayMs: 1_000_000,
    },
    { createConnection: () => ({ handleMessage: () => {}, close: () => {} }), onContested: () => {} },
  );
}

const frame = (over: Partial<{ projectId: string; enabled: boolean; latest: unknown }> = {}) => ({
  t: "oversight_update",
  projectId: "default",
  enabled: true,
  latest: { text: "H", ts: "2026-08-04T00:00:00.000Z", seq: 1 },
  ...over,
});

describe("relay — hubOversight frame store", () => {
  it("stores the frame's state and reads it back per project", () => {
    const fake = fakeHubSocket();
    const relay = relayWith(fake);
    relay.start();
    fake.open();

    expect(relay.hubOversight("default")).toBeNull();
    fake.deliver(frame());
    expect(relay.hubOversight("default")).toEqual({
      enabled: true,
      latest: { text: "H", ts: "2026-08-04T00:00:00.000Z", seq: 1 },
    });
    // A project this uplink holds no frame for answers null, never another
    // project's state.
    expect(relay.hubOversight("other")).toBeNull();
    relay.stop();
  });

  it("replaces the stored state wholesale on the next frame", () => {
    const fake = fakeHubSocket();
    const relay = relayWith(fake);
    relay.start();
    fake.open();

    fake.deliver(frame());
    // Disable pushes enabled:false + latest:null — the new frame is the whole
    // state, not a merge onto the old one.
    fake.deliver(frame({ enabled: false, latest: null }));
    expect(relay.hubOversight("default")).toEqual({ enabled: false, latest: null });
    relay.stop();
  });

  it("clears every stored frame when the socket closes (self-heal on reconnect)", () => {
    const fake = fakeHubSocket();
    const relay = relayWith(fake);
    relay.start();
    fake.open();

    fake.deliver(frame());
    expect(relay.hubOversight("default")).not.toBeNull();
    // A dropped uplink must forget the hub's state so decision sites fall back
    // to the local overseer until the hub re-pushes on reconnect.
    fake.drop();
    expect(relay.hubOversight("default")).toBeNull();
    relay.stop();
  });
});

// ---------------------------------------------------------------------------
// Server integration: injection / tool-text / snapshot precedence
// ---------------------------------------------------------------------------

/** Records the tool-text callback the driver was wired with, and echoes the
 *  full SDK prompt (context block included) into an agent_text_delta so the
 *  injected `<oversight>` block is observable off the session log. */
function harness() {
  let getOversight: (() => string) | undefined;
  const run: RunQuery = ((prompts, hooks) => {
    getOversight = hooks.getOversight;
    return (async function* () {
      for await (const prompt of prompts) {
        const text = (prompt as { message: { content: { text: string }[] } }).message.content[0]
          .text;
        yield { type: "assistant", content: [{ type: "text", text: `SDK saw: ${text}` }] };
      }
    })();
  }) as RunQuery;
  return { run, teamUpdate: () => getOversight!() };
}

/** A hub end that records what the laptop sent and drives frames back down. */
function fakeHub() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const state = { closeRequested: false };
  return {
    connect: () => ({
      send: () => {},
      close: () => void (state.closeRequested = true),
      on: (event: string, fn: (arg?: unknown) => void) => void handlers.set(event, fn),
    }),
    state,
    open: () => handlers.get("open")?.(),
    deliver: (f: unknown) => handlers.get("message")?.(JSON.stringify(f)),
  };
}

describe("server — oversight precedence", () => {
  let close: (() => Promise<void>) | undefined;
  const conns: { close: () => void }[] = [];

  afterEach(async () => {
    for (const conn of conns.splice(0)) conn.close();
    await close?.();
    close = undefined;
    createdProjects.length = 0;
  });

  /** A live laptop holding one joined session (u1 is the driver — first joiner
   *  takes the wheel). `hub` is null in solo mode. `sent` captures the joining
   *  connection's outbound messages. */
  async function laptop(opts: { hub?: boolean } = {}) {
    const h = opts.hub ? fakeHub() : undefined;
    const { run, teamUpdate } = harness();
    createdProjects.length = 0;
    const server = await startServer({
      port: 0,
      runQuery: run,
      summarize: async () => "LOCAL",
      ...(h ? { hub: { url: "ws://hub.test", projectId: "default", connect: h.connect } } : {}),
    });
    close = server.close;
    if (h) {
      h.open();
      h.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    }
    const sent: any[] = [];
    const conn = server.createConnection({ mode: "direct", send: (m) => sent.push(m) });
    conns.push(conn);
    conn.handleMessage({
      type: "join",
      projectId: "default",
      sessionId: "auth",
      userId: "u1",
      name: "Ana",
    });
    const project = createdProjects.filter((p) => p.id === "default")[0]!;
    const entry = project.sessions.get("auth")!;
    return { hub: h, server, conn, sent, project, entry, teamUpdate };
  }

  const injected = (entry: { session: { eventsFrom: (n: number) => { type: string }[] } }) =>
    (entry.session.eventsFrom(0).find((e) => e.type === "agent_text_delta") as
      | { text: string }
      | undefined)?.text;

  it("hub-attached: team_update reads the hub-pushed summary, not the local overseer", async () => {
    const { hub, teamUpdate } = await laptop({ hub: true });
    hub!.deliver({
      t: "oversight_update",
      projectId: "default",
      enabled: true,
      latest: { text: "H", ts: "2026-08-04T00:00:00.000Z", seq: 1 },
    });
    // Local overseer is disabled (no direct set_oversight) — a read of it would
    // answer "team oversight is disabled". The hub text discriminates.
    expect(teamUpdate()).toBe("H");
  });

  it("hub-attached + hub disabled: team_update says disabled even with a local summary", async () => {
    const { hub, conn, teamUpdate } = await laptop({ hub: true });
    // Turn the LOCAL overseer on and let it summarize "LOCAL": with no hub frame
    // yet, the effective read still falls through to the local overseer.
    conn.handleMessage({ type: "set_oversight", projectId: "default", enabled: true });
    await vi.waitFor(() => expect(teamUpdate()).toBe("LOCAL"));
    // Now the hub pushes DISABLED. The local overseer is still enabled with
    // "LOCAL", so a consumer that read it would answer "LOCAL"; hub precedence
    // must win with the locked disabled string.
    hub!.deliver({ t: "oversight_update", projectId: "default", enabled: false, latest: null });
    expect(teamUpdate()).toBe("team oversight is disabled");
  });

  it("hub-attached: pull_oversight gates on hub state and injects the hub summary", async () => {
    const { hub, conn, entry } = await laptop({ hub: true });
    // Local overseer on with "LOCAL", so a local-read injection would carry the
    // wrong text; the hub frame must win.
    conn.handleMessage({ type: "set_oversight", projectId: "default", enabled: true });
    hub!.deliver({
      t: "oversight_update",
      projectId: "default",
      enabled: true,
      latest: { text: "H", ts: "2026-08-04T00:00:00.000Z", seq: 1 },
    });
    // PULL gates on the effective (hub) state — enabled with a summary — so it
    // flips the one-shot flag rather than refusing "team oversight is disabled".
    conn.handleMessage({ type: "pull_oversight" });
    expect(entry.pendingOversight).toBe(true);

    conn.handleMessage({ type: "prompt", text: "go" });
    await vi.waitFor(() => expect(injected(entry)).toContain("<oversight>\nH\n</oversight>"));
    expect(injected(entry)).not.toContain("LOCAL");
    expect(entry.pendingOversight).toBe(false);
  });

  it("solo: team_update and injection read the local overseer, byte-identically to today", async () => {
    const { conn, entry, teamUpdate } = await laptop();
    conn.handleMessage({ type: "set_oversight", projectId: "default", enabled: true });
    await vi.waitFor(() => expect(teamUpdate()).toBe("LOCAL"));

    conn.handleMessage({ type: "pull_oversight" });
    expect(entry.pendingOversight).toBe(true);
    conn.handleMessage({ type: "prompt", text: "go" });
    await vi.waitFor(() => expect(injected(entry)).toContain("<oversight>\nLOCAL\n</oversight>"));
  });

  it("solo: the project snapshot's oversight gains available:true, additively", async () => {
    const { conn, sent, teamUpdate } = await laptop();
    conn.handleMessage({ type: "set_oversight", projectId: "default", enabled: true });
    await vi.waitFor(() => expect(teamUpdate()).toBe("LOCAL"));

    sent.length = 0;
    conn.handleMessage({ type: "peek", projectId: "default" });
    const snap = sent.find((m) => m.type === "project");
    expect(snap.oversight.available).toBe(true);
    expect(snap.oversight.enabled).toBe(true);
    expect(snap.oversight.latest.text).toBe("LOCAL");
  });
});
