import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";
import { defaultFatal, startHub } from "../src/hub.js";
import { HubDb, SCHEMA_VERSION } from "../src/hubDb.js";
import { HubStore } from "../src/hubStore.js";
import { browserReplay, collect, connect, wait } from "./helpers/uplinkHarness.js";

/** Every `new HubDb(...)` in this file's process, arguments included. The
 *  skipLock row needs the CONSTRUCTOR ARGS, not just the effect: "no second
 *  argument" is the claim, and a subclass that records and delegates is the
 *  only way to read them without changing what the hub does. Everything else
 *  about the class is the real one — `importOriginal` — so every other test in
 *  this file still exercises real SQLite on a real file. */
const ctor = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../src/hubDb.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hubDb.js")>();
  class RecordingHubDb extends actual.HubDb {
    constructor(...args: ConstructorParameters<typeof actual.HubDb>) {
      ctor.calls.push(args);
      super(...args);
    }
  }
  return { ...actual, HubDb: RecordingHubDb };
});

const tmpDirs: string[] = [];
const openDbs: HubDb[] = [];
let closeHub: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHub?.();
  closeHub = undefined;
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // Best-effort teardown: the test itself may already have closed it.
    }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  ctor.calls.length = 0;
  vi.restoreAllMocks();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubboot-"));
  tmpDirs.push(dir);
  return dir;
}

/** A fresh path inside a fresh temp dir — nothing exists there yet. */
function tmpDbPath(): string {
  return path.join(tmpDir(), "hub.db");
}

function openDb(dbPath: string): HubDb {
  const db = new HubDb(dbPath);
  openDbs.push(db);
  return db;
}

async function hubOn(opts: Parameters<typeof startHub>[0]) {
  const hub = await startHub(opts);
  closeHub = hub.close;
  return hub;
}

/** One project written into the record by a hub that is no longer running —
 *  the state a restarting hub must boot from. */
function seedProject(db: HubDb, id = "acme", name = "Acme"): void {
  const store = new HubStore(db, db.load());
  const created = store.createProject(id, name, "ana", "2026-07-29T00:00:00.000Z");
  expect(created.ok).toBe(true);
}

async function attachedUplink(port: number, uplinkId = "lap-1"): Promise<WebSocket> {
  const up = await connect(`ws://127.0.0.1:${port}/uplink`);
  up.send(
    JSON.stringify({
      t: "hello",
      v: RELAY_PROTOCOL_VERSION,
      uplinkId,
      name: uplinkId,
      projectId: "default",
      repos: [],
    }),
  );
  await wait(40);
  return up;
}

function publish(up: WebSocket, seq: number, text: string, sessionId = "auth"): void {
  up.send(
    JSON.stringify({
      t: "publish",
      sessionId,
      runId: "run-a",
      events: [
        {
          type: "intent_update",
          text,
          seq,
          ts: `2026-07-29T00:00:${String(seq).padStart(2, "0")}.000Z`,
        },
      ],
    }),
  );
}

async function projectsSeenBy(port: number): Promise<string[]> {
  const ws = await connect(`ws://127.0.0.1:${port}/`);
  const seen: any[] = [];
  collect(ws, seen);
  ws.send(JSON.stringify({ type: "list_projects" }));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !seen.some((m) => m.type === "projects")) await wait(10);
  ws.close();
  return (seen.find((m) => m.type === "projects")?.projects ?? []).map((p: any) => p.id);
}

/** A port nothing is listening on, obtained by binding and releasing it. Used
 *  to prove a REFUSED boot never bound: an ephemeral port cannot answer that
 *  question, because a hub that failed before `listen` has no port to name. */
async function freePort(): Promise<number> {
  const probe = await startHub({ port: 0, host: "127.0.0.1" });
  const port = probe.port;
  await probe.close();
  return port;
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

describe("startHub store wiring", () => {
  it("boots from the record the dbPath names", async () => {
    const dbPath = tmpDbPath();
    const seed = openDb(dbPath);
    seedProject(seed);
    seed.close();

    const hub = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    // The proof is a BROWSER read, not a store poke: hydration that does not
    // reach the surface the hub serves is hydration nobody can use.
    expect(await projectsSeenBy(hub.port)).toEqual(["acme"]);
  });

  it("writes published events through to the record, and close() releases it", async () => {
    const dbPath = tmpDbPath();
    const hub = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    const up = await attachedUplink(hub.port);
    publish(up, 0, "durable");
    await wait(60);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(true);

    await hub.close();
    closeHub = undefined;
    // A hub that closed the DB left neither a handle nor a lock: opening the
    // record again WITHOUT skipLock is the honest test of both.
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    const reopened = openDb(dbPath);
    const loaded = reopened.load();
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0]?.events.map((e: any) => e.event.text)).toEqual(["durable"]);
  });

  it("constructs HubDb with the path and NOTHING else — skipLock stays test-only", async () => {
    const dbPath = tmpDbPath();
    const hub = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    expect(ctor.calls).toEqual([[dbPath]]);
    // The effect of that missing second argument, so the row fails even if the
    // seam above ever stops observing the real constructor: the lock is HELD.
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));
    expect(hub.port).toBeGreaterThan(0);
  });

  it("prefers the db option over dbPath and opens nothing at dbPath", async () => {
    const given = openDb(":memory:");
    seedProject(given, "seam", "Seam");
    const dbPath = tmpDbPath();

    const hub = await hubOn({ port: 0, host: "127.0.0.1", dbPath, db: given });
    expect(await projectsSeenBy(hub.port)).toEqual(["seam"]);
    // dbPath ignored means ignored: no file, no lock, and the only HubDb this
    // process built is the one the test handed in.
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    expect(ctor.calls).toEqual([[":memory:"]]);
  });

  it("opens no database at all with neither dbPath nor db, and behaves as it always has", async () => {
    const hub = await hubOn({ port: 0, host: "127.0.0.1" });
    const up = await attachedUplink(hub.port);
    publish(up, 0, "ephemeral");
    await wait(60);

    expect(ctor.calls).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${hub.port}/healthz`)).status).toBe(200);
    expect((await browserReplay(hub.port)).map((e: any) => e.text)).toEqual(["ephemeral"]);
  });
});

describe("startHub boot failures", () => {
  it("rejects when another live process holds the record's lock", async () => {
    const dbPath = tmpDbPath();
    openDb(dbPath);
    await expect(startHub({ port: 0, host: "127.0.0.1", dbPath })).rejects.toThrow(
      /in use by pid/,
    );
  });

  it("rejects a corrupt record", async () => {
    const dbPath = tmpDbPath();
    fs.writeFileSync(dbPath, "this is not a database");
    await expect(startHub({ port: 0, host: "127.0.0.1", dbPath })).rejects.toThrow(
      /not a database/i,
    );
  });

  it("rejects a record stamped with a newer schema", async () => {
    const dbPath = tmpDbPath();
    const raw = new Database(dbPath);
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION + 1),
    );
    raw.close();
    await expect(startHub({ port: 0, host: "127.0.0.1", dbPath })).rejects.toThrow(
      /refusing to start/,
    );
  });

  it("rejects a dbPath sqlite cannot open", async () => {
    // A directory: the parent mkdir succeeds and the lock is takeable, so the
    // refusal comes from sqlite itself — the "unopenable" case, not a variant
    // of the corrupt one.
    const dbPath = tmpDir();
    await expect(startHub({ port: 0, host: "127.0.0.1", dbPath })).rejects.toThrow();
  });

  it("does not serve when boot fails — nothing is left bound to the port", async () => {
    const port = await freePort();
    const dbPath = tmpDbPath();
    openDb(dbPath);
    await expect(startHub({ port, host: "127.0.0.1", dbPath })).rejects.toThrow(/in use by pid/);
    expect(await canBind(port)).toBe(true);
  });
});

describe("runtime fail-stop", () => {
  it("routes a persister failure during publish to fatal, fans nothing out, and leaves memory as it was", async () => {
    const db = openDb(":memory:");
    const fatal = vi.fn();
    const hub = await hubOn({ port: 0, host: "127.0.0.1", db, fatal });
    const up = await attachedUplink(hub.port);
    publish(up, 0, "kept");
    await wait(60);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    // Participation is membership-gated now (spec A4): identify and join the
    // project before joining a session in it.
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    browser.send(
      JSON.stringify({
        type: "join",
        sessionId: "auth",
        projectId: "default",
        userId: "ana",
        name: "ana",
      }),
    );
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !seen.some((m) => m.type === "project")) await wait(10);
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["kept"]);

    const boom = new Error("disk full");
    db.eventsAppended = () => {
      throw boom;
    };
    publish(up, 1, "lost");
    await wait(80);

    expect(fatal.mock.calls).toEqual([[boom]]);
    // Durable before visible, observed at the hub layer: no second event frame
    // on the joined channel, and no error frame either — the hub stops rather
    // than reporting a failed write to the browser as a recoverable error.
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["kept"]);
    expect(seen.filter((m) => m.type === "error")).toEqual([]);
    browser.close();
    // Memory unchanged: a fresh reader sees exactly the events that were
    // durable before the failure.
    expect((await browserReplay(hub.port)).map((e: any) => e.text)).toEqual(["kept"]);
  });

  it("uses defaultFatal when no fatal is given", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const db = openDb(":memory:");
    const hub = await hubOn({ port: 0, host: "127.0.0.1", db });
    const up = await attachedUplink(hub.port);
    const boom = new Error("disk full");
    db.eventsAppended = () => {
      throw boom;
    };
    publish(up, 0, "lost");
    await wait(80);

    expect(errorSpy).toHaveBeenCalledWith(boom);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaultFatal logs the error and exits 1", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const boom = new Error("io error");
    defaultFatal(boom);
    expect(errorSpy).toHaveBeenCalledWith(boom);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
