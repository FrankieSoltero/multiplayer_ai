import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startHub, type RunningHub } from "../src/hub.js";
import { HubDb } from "../src/hubDb.js";
import { RELAY_PROTOCOL_VERSION, type RepoDecl } from "multiplayer-ai-server/relayProtocol";
import type { OversightInput, Summarize } from "multiplayer-ai-server/overseer";

const decl = (key: string, over: Partial<RepoDecl> = {}): RepoDecl => ({
  key,
  label: key.split("/").pop() ?? key,
  attached: true,
  defaultBranch: "origin/main",
  ...over,
});

const openDbs: HubDb[] = [];
const tmpDirs: string[] = [];
let closeHub: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHub?.();
  closeHub = undefined;
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed by the hub */
    }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memDb(): HubDb {
  const db = new HubDb(":memory:");
  openDbs.push(db);
  return db;
}

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huboversight-"));
  tmpDirs.push(dir);
  return path.join(dir, "hub.db");
}

async function hubOn(opts: Parameters<typeof startHub>[0]): Promise<RunningHub> {
  const hub = await startHub(opts);
  closeHub = hub.close;
  return hub;
}

/** A summarizer stand-in: records every input and can be flipped between
 *  resolving a value, rejecting, or hanging forever (so a scenario can assert
 *  the toggle persisted BEFORE any summary landed). No real API is ever hit. */
function summarizerSpy(initial = "S1") {
  const calls: OversightInput[] = [];
  let mode: "resolve" | "reject" | "hang" = "resolve";
  let value = initial;
  const summarize: Summarize = (input) => {
    calls.push(input);
    if (mode === "reject") return Promise.reject(new Error("boom"));
    if (mode === "hang") return new Promise<string>(() => {});
    return Promise.resolve(value);
  };
  return {
    summarize,
    calls,
    reject() {
      mode = "reject";
    },
    hang() {
      mode = "hang";
    },
    resolve(v: string) {
      mode = "resolve";
      value = v;
    },
  };
}

const facts = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  participants: ["ana"],
  driverName: "ana",
  intent: null,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: "github.com/acme/api",
  lifecycle: "open",
  ...over,
});

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

/** An attached uplink owning one session `sessionId`, collecting every frame it
 *  receives so a scenario can assert which `oversight_update`s reached it. */
async function attachUplink(
  port: number,
  sessionId: string,
  uplinkId = "lap-1",
  projectId = "default",
) {
  const up = await connect(`ws://127.0.0.1:${port}/uplink`);
  const seen: any[] = [];
  collect(up, seen);
  up.send(
    JSON.stringify({
      t: "hello",
      v: RELAY_PROTOCOL_VERSION,
      uplinkId,
      name: uplinkId,
      projectId,
      repos: [decl("github.com/acme/api")],
    }),
  );
  up.send(JSON.stringify({ t: "facts", sessionId, runId: "run-a", facts: facts(sessionId) }));
  await wait(40);
  const oversightFrames = () => seen.filter((m) => m?.t === "oversight_update");
  return { up, seen, oversightFrames };
}

/** A browser that has identified and joined `projectId` — a member, so it may
 *  toggle oversight. Returns a helper to send `set_oversight` and read snapshots. */
async function member(port: number, projectId = "default", userId = "ana") {
  const ws = await connect(`ws://127.0.0.1:${port}`);
  const seen: any[] = [];
  collect(ws, seen);
  ws.send(JSON.stringify({ type: "identify", userId, name: userId }));
  ws.send(JSON.stringify({ type: "join_project", projectId }));
  await wait(40);
  return {
    ws,
    seen,
    setOversight(enabled: boolean, over: Record<string, unknown> = {}) {
      ws.send(JSON.stringify({ type: "set_oversight", projectId, enabled, ...over }));
    },
    raw(msg: unknown) {
      ws.send(JSON.stringify(msg));
    },
    async snapshot(): Promise<any> {
      seen.length = 0;
      ws.send(JSON.stringify({ type: "watch_project", projectId }));
      await wait(40);
      return seen.find((m) => m?.type === "project");
    },
    lastError() {
      return [...seen].reverse().find((m) => m?.type === "error");
    },
  };
}

describe("hub oversight — capability gate", () => {
  it("refuses enable with the exact capability string when unavailable; disable still accepted", async () => {
    const db = memDb();
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      oversightAvailable: false,
      summarize: summarizerSpy().summarize,
    });
    await attachUplink(hub.port, "auth");
    const m = await member(hub.port);

    m.seen.length = 0;
    m.setOversight(true);
    await wait(40);
    expect(m.lastError()?.message).toBe(
      "oversight is unavailable on this hub — no ANTHROPIC_API_KEY configured",
    );
    expect(db.getOversight("default")).toBeNull();

    m.seen.length = 0;
    m.setOversight(false);
    await wait(40);
    expect(m.lastError()).toBeUndefined();
  });

  it("snapshot carries oversight.available: false on a hub without a key", async () => {
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: false,
      summarize: summarizerSpy().summarize,
    });
    await attachUplink(hub.port, "auth");
    const m = await member(hub.port);
    const snap = await m.snapshot();
    expect(snap.oversight).toEqual({ enabled: false, latest: null, available: false });
  });

  it("snapshot carries oversight.available: true on a capable hub", async () => {
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: true,
      summarize: summarizerSpy().summarize,
    });
    await attachUplink(hub.port, "auth");
    const m = await member(hub.port);
    const snap = await m.snapshot();
    expect(snap.oversight.available).toBe(true);
  });
});

describe("hub oversight — shape and membership gates", () => {
  it("refuses a bad projectId and a non-boolean enabled with the exact strings", async () => {
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: true,
      summarize: summarizerSpy().summarize,
    });
    await attachUplink(hub.port, "auth");
    const m = await member(hub.port);

    m.seen.length = 0;
    m.raw({ type: "set_oversight", projectId: "Bad Slug!", enabled: true });
    await wait(30);
    expect(m.lastError()?.message).toBe("set_oversight requires a valid projectId");

    m.seen.length = 0;
    m.raw({ type: "set_oversight", projectId: "default", enabled: "yes" });
    await wait(30);
    expect(m.lastError()?.message).toBe("set_oversight requires enabled: true|false");
  });

  it("refuses an identified non-member with the uncoded membership string", async () => {
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: true,
      summarize: summarizerSpy().summarize,
    });
    await attachUplink(hub.port, "auth");
    // Identify but do NOT join.
    const ws = await connect(`ws://127.0.0.1:${hub.port}`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "mallory", name: "mallory" }));
    await wait(30);
    seen.length = 0;
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(30);
    const err = [...seen].reverse().find((m) => m?.type === "error");
    expect(err?.message).toBe("join this project before changing it");
    expect(err?.code).toBeUndefined(); // uncoded, like set_project_lifecycle
    ws.close();
  });
});

describe("hub oversight — toggle persistence and refresh", () => {
  it("writes the enabled row durable before the snapshot shows it", async () => {
    const spy = summarizerSpy();
    spy.hang(); // never produce a summary, so only the toggle is under test
    const db = memDb();
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      oversightAvailable: true,
      summarize: spy.summarize,
    });
    await attachUplink(hub.port, "auth");
    const m = await member(hub.port);

    m.setOversight(true);
    await wait(40);

    // Durable: the row is on disk with enabled=1 and no summary yet.
    expect(db.getOversight("default")).toEqual({
      enabled: true,
      summary: null,
      seq: 0,
      ts: null,
    });
    // Visible: the browser snapshot reflects it.
    const snap = await m.snapshot();
    expect(snap.oversight.enabled).toBe(true);
    expect(snap.oversight.latest).toBeNull();
  });

  it("saves the summary durable before push, snapshot shows it, and emits to the owning uplink", async () => {
    const spy = summarizerSpy("S1");
    const db = memDb();
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      oversightAvailable: true,
      summarize: spy.summarize,
    });
    const uplink = await attachUplink(hub.port, "auth");
    const m = await member(hub.port);

    m.setOversight(true);
    await wait(60); // enable → immediate refresh → summary lands

    const row = db.getOversight("default");
    expect(row?.summary).toBe("S1");
    expect(row?.seq).toBe(1);
    expect(typeof row?.ts).toBe("string");

    const snap = await m.snapshot();
    expect(snap.oversight.latest.text).toBe("S1");
    expect(snap.oversight.latest.seq).toBe(1);

    const frames = uplink.oversightFrames();
    const latestFrame = frames[frames.length - 1];
    expect(latestFrame).toMatchObject({
      t: "oversight_update",
      projectId: "default",
      enabled: true,
      latest: { text: "S1", seq: 1 },
    });
  });

  it("a refresh that fails saves no summary row and emits no summary frame", async () => {
    const spy = summarizerSpy();
    spy.reject();
    const db = memDb();
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      oversightAvailable: true,
      summarize: spy.summarize,
    });
    const uplink = await attachUplink(hub.port, "auth");
    const m = await member(hub.port);

    m.setOversight(true);
    await wait(60);

    // The enable toggle persisted; the failed refresh added no summary.
    expect(db.getOversight("default")).toMatchObject({ enabled: true, summary: null, seq: 0 });
    // No frame carries a non-null latest.
    expect(uplink.oversightFrames().every((f) => f.latest === null)).toBe(true);
  });

  it("disabling emits enabled:false with latest:null even though the row keeps its summary", async () => {
    const spy = summarizerSpy("S1");
    const db = memDb();
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      oversightAvailable: true,
      summarize: spy.summarize,
    });
    const uplink = await attachUplink(hub.port, "auth");
    const m = await member(hub.port);

    m.setOversight(true);
    await wait(60); // produce S1
    m.setOversight(false);
    await wait(40);

    const frames = uplink.oversightFrames();
    const last = frames[frames.length - 1];
    expect(last).toMatchObject({ t: "oversight_update", enabled: false, latest: null });
    // The row still holds the summary; only the wire nulls it.
    expect(db.getOversight("default")?.summary).toBe("S1");
  });
});

describe("hub oversight — cross-machine digest and activity", () => {
  it("summarizes ONE input carrying every session across both uplinks", async () => {
    const spy = summarizerSpy("S1");
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: true,
      summarize: spy.summarize,
    });
    await attachUplink(hub.port, "auth", "lap-1");
    await attachUplink(hub.port, "ui", "lap-2");
    const m = await member(hub.port);

    m.setOversight(true);
    await wait(60);

    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
    const ids = spy.calls[0].sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["auth", "ui"]);
  });

  it("an INTERESTING published event triggers a debounced re-summarize on an enabled project", async () => {
    const spy = summarizerSpy("S1");
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: true,
      summarize: spy.summarize,
      oversightDebounceMs: 15,
    });
    const uplink = await attachUplink(hub.port, "auth");
    const m = await member(hub.port);

    m.setOversight(true);
    await wait(60); // initial refresh from enable
    const before = spy.calls.length;

    uplink.up.send(
      JSON.stringify({
        t: "publish",
        sessionId: "auth",
        runId: "run-a",
        events: [
          { type: "user_message", seq: 0, ts: new Date().toISOString(), userId: "ana", text: "hi" },
        ],
      }),
    );
    await wait(80); // debounce (15ms) + refresh

    expect(spy.calls.length).toBeGreaterThan(before);
  });
});

describe("hub oversight — replay and self-heal", () => {
  it("a browser that watches after a refresh gets the latest in its snapshot", async () => {
    const spy = summarizerSpy("S1");
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: true,
      summarize: spy.summarize,
    });
    await attachUplink(hub.port, "auth");
    const m = await member(hub.port);
    m.setOversight(true);
    await wait(60);

    // A DIFFERENT browser joining later reads the summary straight from the snapshot.
    const late = await member(hub.port);
    const snap = await late.snapshot();
    expect(snap.oversight.enabled).toBe(true);
    expect(snap.oversight.latest.text).toBe("S1");
    late.ws.close();
  });

  it("re-emits the current oversight state to an uplink that (re)attaches while enabled", async () => {
    const spy = summarizerSpy("S1");
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db: memDb(),
      oversightAvailable: true,
      summarize: spy.summarize,
    });
    const first = await attachUplink(hub.port, "auth", "lap-1");
    const m = await member(hub.port);
    m.setOversight(true);
    await wait(60);
    first.up.close();
    await wait(40);

    // The laptop reconnects (same uplinkId, same session). It cleared its map
    // on disconnect, so the hub must re-push the current state.
    const again = await attachUplink(hub.port, "auth", "lap-1");
    const frames = again.oversightFrames();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[frames.length - 1]).toMatchObject({
      t: "oversight_update",
      projectId: "default",
      enabled: true,
      latest: { text: "S1", seq: 1 },
    });
  });
});

describe("hub oversight — restart restore", () => {
  it("seeds enabled + latest + seq from the record without firing a boot refresh", async () => {
    const dbPath = tmpFile();

    // First hub: enable and produce a summary, then shut down.
    {
      const spy = summarizerSpy("S1");
      const hub = await hubOn({
        port: 0,
        host: "127.0.0.1",
        dbPath,
        oversightAvailable: true,
        summarize: spy.summarize,
      });
      await attachUplink(hub.port, "auth");
      const m = await member(hub.port);
      m.setOversight(true);
      await wait(60);
      m.ws.close();
      await closeHub?.();
      closeHub = undefined;
    }

    // Second hub over the same record: the overseer must come up seeded.
    const spy2 = summarizerSpy("S2");
    const hub2 = await hubOn({
      port: 0,
      host: "127.0.0.1",
      dbPath,
      oversightAvailable: true,
      summarize: spy2.summarize,
    });
    const m2 = await member(hub2.port); // "ana" is a persisted member
    const snap = await m2.snapshot();
    expect(snap.oversight.enabled).toBe(true);
    expect(snap.oversight.latest.text).toBe("S1");
    expect(snap.oversight.latest.seq).toBe(1);
    // Boot itself summarized nothing.
    expect(spy2.calls.length).toBe(0);
  });
});
