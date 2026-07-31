import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHub, type RunningHub } from "../src/hub.js";
import { HubDb } from "../src/hubDb.js";
import { HubStore } from "../src/hubStore.js";
import { MAX_SOCKETS } from "../src/limits.js";
import { connect, collect, wait, decl } from "./helpers/uplinkHarness.js";
import { RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";
import type { AuthConfig } from "multiplayer-ai-server/auth";
import type { LoggedEvent } from "multiplayer-ai-server/events";

/** Every DB and hub this file opens, torn down after each test so a failing
 *  assertion never strands an open handle or a listening port. */
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
      // Best-effort: the hub's close() may already have closed a seam db.
    }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function memDb(): HubDb {
  const db = new HubDb(":memory:");
  openDbs.push(db);
  return db;
}

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubops-"));
  tmpDirs.push(dir);
  return dir;
}

/** A file-backed HubDb under a throwaway temp dir, tracked for teardown. */
function fileDb(): { db: HubDb; dbPath: string } {
  const dbPath = path.join(tmp(), "hub.db");
  const db = new HubDb(dbPath);
  openDbs.push(db);
  return { db, dbPath };
}

/** The backup filenames a hub wrote into `dir`, sorted — matches only the
 *  `hub-YYYYMMDD-HHmmssZ.db` pattern the hub emits. */
const BACKUP_NAME = /^hub-\d{8}-\d{6}Z\.db$/;
const backupsIn = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort() : [];

async function hubOn(opts: Parameters<typeof startHub>[0]): Promise<RunningHub> {
  const hub = await startHub(opts);
  closeHub = hub.close;
  return hub;
}

/** A monotonic ISO timestamp `s` seconds past a fixed epoch — lexicographic
 *  order equals chronological order, which is exactly what the prune relies on. */
const isoAt = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

/** One `LoggedEvent` at seq `s`, timestamped `isoAt(s)`. */
const eventAt = (s: number): LoggedEvent =>
  ({ type: "user_message", seq: s, ts: isoAt(s), userId: "ana", text: "x" }) as unknown as LoggedEvent;

/** Attaches one machine and publishes `count` events (seq 0..count-1) into one
 *  session, so the record holds ids 1..count with monotonically increasing ts. */
function seedSession(db: HubDb, count: number): HubStore {
  const store = new HubStore(db);
  store.attach("lap-1", "acme", "lap-1", [], isoAt(0));
  store.publish(
    "lap-1",
    "auth",
    "run-a",
    Array.from({ length: count }, (_, i) => eventAt(i)),
  );
  return store;
}

describe("retention — id continuity after a prune (THE TRAP, spec B1)", () => {
  it("a publish after a prune gets max-stored-id + 1, never events.length + 1", () => {
    const db = memDb();
    seedSession(db, 100); // ids 1..100, seqs 0..99, lastSeq 99

    // Prune ids 1..50 (seqs 0..49): their ts is strictly < isoAt(50).
    expect(db.pruneEventsBefore(isoAt(50))).toBe(50);

    // A restarted hub hydrates from the pruned record. `nextEventId` must seed
    // from the max SURVIVING id (100) + 1, not the surviving COUNT (50) + 1.
    const restarted = new HubStore(db, db.load());
    const accepted = restarted.publish("lap-1", "auth", "run-a", [eventAt(100)]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.id).toBe(101); // NOT 51 — 51 would collide with a survivor
  });

  it("the new id is durable — no PRIMARY KEY collision reaches the persister", () => {
    const db = memDb();
    seedSession(db, 100);
    db.pruneEventsBefore(isoAt(50));

    const restarted = new HubStore(db, db.load());
    // If nextEventId regressed to 51, `eventsAppended` would INSERT id 51 over a
    // surviving row and the persister would THROW — a fatal crash-loop. It must
    // not.
    expect(() => restarted.publish("lap-1", "auth", "run-a", [eventAt(100)])).not.toThrow();
    // And the write really landed: reloading shows id 101 among the survivors.
    const ids = db.load().sessions[0]?.events.map((e) => e.id);
    expect(ids?.[ids.length - 1]).toBe(101);
  });

  it("replay after a prune returns only surviving events, with no error", () => {
    const db = memDb();
    seedSession(db, 100);
    db.pruneEventsBefore(isoAt(50));

    const restarted = new HubStore(db, db.load());
    const replay = restarted.eventsFor("acme", "auth", 0);
    expect(replay.map((e) => e.id)).toEqual(Array.from({ length: 50 }, (_, i) => 51 + i));
  });

  it("resume offsets are unchanged by a prune — no re-send storm (keyed on run/seq)", () => {
    const db = memDb();
    const before = seedSession(db, 100).resumeOffsets("lap-1");
    expect(before).toEqual({ auth: { runId: "run-a", lastSeq: 99 } });

    db.pruneEventsBefore(isoAt(50));
    const restarted = new HubStore(db, db.load());
    expect(restarted.resumeOffsets("lap-1")).toEqual(before);
  });

  it("a fresh session with no prune still numbers events from 1", () => {
    const db = memDb();
    const store = seedSession(db, 3);
    expect(store.eventsFor("acme", "auth", 0).map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe("retention — boot-time prune wiring (spec B1)", () => {
  const NOW = Date.UTC(2026, 6, 20, 0, 0, 0); // 2026-07-20T00:00:00Z

  /** Seeds two OLD events (ids 1,2) and one RECENT event (id 3) so a
   *  30-day cutoff prunes exactly the two old ones. */
  function seedForBoot(db: HubDb): void {
    const store = new HubStore(db);
    store.attach("lap-1", "acme", "lap-1", [], "2026-06-01T00:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [
      { type: "user_message", seq: 0, ts: "2026-06-01T00:00:00.000Z", userId: "ana", text: "x" },
      { type: "user_message", seq: 1, ts: "2026-06-05T00:00:00.000Z", userId: "ana", text: "x" },
      { type: "user_message", seq: 2, ts: "2026-07-15T00:00:00.000Z", userId: "ana", text: "x" },
    ] as unknown as LoggedEvent[]);
  }

  it("opt-in OFF (retentionDays undefined) never prunes — the record is kept forever", async () => {
    const db = memDb();
    seedForBoot(db);
    const pruneSpy = vi.spyOn(db, "pruneEventsBefore");

    await hubOn({ port: 0, host: "127.0.0.1", db });

    expect(pruneSpy).not.toHaveBeenCalled();
    expect(db.load().sessions[0]?.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("prunes rows older than the cutoff at boot, keeping newer ones", async () => {
    const db = memDb();
    seedForBoot(db);

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    // cutoff = NOW - 30d = 2026-06-20; ids 1,2 (June 1 & 5) go, id 3 (Jul 15) stays.
    expect(db.load().sessions[0]?.events.map((e) => e.id)).toEqual([3]);
  });

  it("runs the prune BEFORE load() so memory hydrates from the already-pruned record", async () => {
    const db = memDb();
    seedForBoot(db);
    const pruneSpy = vi.spyOn(db, "pruneEventsBefore");
    const loadSpy = vi.spyOn(db, "load");

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    expect(pruneSpy).toHaveBeenCalledTimes(1);
    expect(pruneSpy.mock.invocationCallOrder[0]).toBeLessThan(loadSpy.mock.invocationCallOrder[0]!);
  });

  it("computes the cutoff as now() - days*86_400_000, ISO-formatted", async () => {
    const db = memDb();
    seedForBoot(db);
    const pruneSpy = vi.spyOn(db, "pruneEventsBefore");

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    expect(pruneSpy).toHaveBeenCalledWith(new Date(NOW - 30 * 86_400_000).toISOString());
  });

  it("prints one boot log line naming the rows pruned and the window", async () => {
    const db = memDb();
    seedForBoot(db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    expect(logSpy).toHaveBeenCalledWith("retention: pruned 2 event row(s) older than 30d");
  });

  it("still prints the boot log line when 0 rows were pruned", async () => {
    const db = memDb();
    seedForBoot(db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // A 1000-day window is older than anything seeded, so nothing is pruned.
    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 1000, now: () => NOW });

    expect(logSpy).toHaveBeenCalledWith("retention: pruned 0 event row(s) older than 1000d");
  });
});

describe("backups — hot VACUUM INTO, keep-N, never fatal (spec B1)", () => {
  // 2026-07-31T14:05:09Z → the boot-backup filename is fixed and checkable.
  const BOOT = Date.UTC(2026, 6, 31, 14, 5, 9);
  const BOOT_NAME = "hub-20260731-140509Z.db";
  const DISABLED_LINE = "backups: disabled — no durable record to back up";

  /** Attaches one machine and publishes `count` events into "auth", writing
   *  through to the file record so a backup has real rows to copy. */
  function seed(db: HubDb, count: number): HubStore {
    const store = new HubStore(db);
    store.attach("lap-1", "acme", "lap-1", [], isoAt(0));
    store.publish(
      "lap-1",
      "auth",
      "run-a",
      Array.from({ length: count }, (_, i) => eventAt(i)),
    );
    return store;
  }

  const eventIdsIn = (dbFile: string): number[] => {
    const rdb = new Database(dbFile, { readonly: true });
    try {
      return (rdb.prepare("SELECT id FROM events ORDER BY id").all() as { id: number }[]).map(
        (r) => r.id,
      );
    } finally {
      rdb.close();
    }
  };

  it("opt-in OFF (backup undefined) takes no backup and starts no timer", async () => {
    const { db, dbPath } = fileDb();
    seed(db, 1);
    const backupSpy = vi.spyOn(db, "backupTo");
    const intervalSpy = vi.spyOn(global, "setInterval");

    await hubOn({ port: 0, host: "127.0.0.1", db });

    expect(backupSpy).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    // No stray backup directory was made next to the record either.
    expect(fs.readdirSync(path.dirname(dbPath))).not.toContain("backups");
  });

  it("takes one backup at boot — 0700 dir, 0600 file, name from now()", async () => {
    const { db, dbPath } = fileDb();
    seed(db, 3);
    const backupDir = path.join(path.dirname(dbPath), "backups");

    await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      backup: { dir: backupDir, intervalMs: 3_600_000, keep: 10 },
      now: () => BOOT,
    });

    expect(backupsIn(backupDir)).toEqual([BOOT_NAME]);
    const dest = path.join(backupDir, BOOT_NAME);
    expect((fs.statSync(backupDir).mode & 0o777).toString(8)).toBe("700");
    expect((fs.statSync(dest).mode & 0o777).toString(8)).toBe("600");
    // The backup is a real DB holding the seeded rows.
    expect(eventIdsIn(dest)).toEqual([1, 2, 3]);
  });

  it("runs the boot backup BEFORE the prune, so pruned rows are recoverable (§8.7)", async () => {
    const { db, dbPath } = fileDb();
    // Two OLD events (ids 1,2) and one RECENT (id 3); a 30-day cutoff prunes 1,2.
    const store = new HubStore(db);
    store.attach("lap-1", "acme", "lap-1", [], "2026-06-01T00:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [
      { type: "user_message", seq: 0, ts: "2026-06-01T00:00:00.000Z", userId: "ana", text: "x" },
      { type: "user_message", seq: 1, ts: "2026-06-05T00:00:00.000Z", userId: "ana", text: "x" },
      { type: "user_message", seq: 2, ts: "2026-07-15T00:00:00.000Z", userId: "ana", text: "x" },
    ] as unknown as LoggedEvent[]);
    const backupDir = path.join(path.dirname(dbPath), "backups");
    const backupSpy = vi.spyOn(db, "backupTo");
    const pruneSpy = vi.spyOn(db, "pruneEventsBefore");

    await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      backup: { dir: backupDir, intervalMs: 3_600_000, keep: 10 },
      retentionDays: 30,
      now: () => BOOT,
    });

    // Ordering: the backup is taken before the prune deletes anything.
    expect(backupSpy.mock.invocationCallOrder[0]).toBeLessThan(
      pruneSpy.mock.invocationCallOrder[0]!,
    );
    // The live record was pruned to id 3, but the backup still holds 1,2,3.
    expect(db.load().sessions[0]?.events.map((e) => e.id)).toEqual([3]);
    expect(eventIdsIn(path.join(backupDir, BOOT_NAME))).toEqual([1, 2, 3]);
  });

  it("the interval timer takes hot backups; a publish around it still lands", async () => {
    const { db, dbPath } = fileDb();
    const store = seed(db, 1); // id 1
    const backupDir = path.join(path.dirname(dbPath), "backups");
    let nowMs = BOOT;

    vi.useFakeTimers();
    try {
      await hubOn({
        port: 0,
        host: "127.0.0.1",
        db,
        backup: { dir: backupDir, intervalMs: 60_000, keep: 10 },
        now: () => nowMs,
      });
      expect(backupsIn(backupDir)).toEqual([BOOT_NAME]); // boot backup

      // A minute later the interval fires; a publish lands on the hot handle.
      nowMs = Date.UTC(2026, 6, 31, 14, 6, 9);
      await vi.advanceTimersByTimeAsync(60_000);
      store.publish("lap-1", "auth", "run-a", [eventAt(1)]); // id 2

      expect(backupsIn(backupDir)).toEqual([BOOT_NAME, "hub-20260731-140609Z.db"]);
      // The concurrent publish still reached the live record.
      expect(db.load().sessions[0]?.events.map((e) => e.id)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep-N deletes the oldest matching backups only — decoys are never touched", async () => {
    const { db, dbPath } = fileDb();
    seed(db, 1);
    const backupDir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    // Three older pattern-matching backups, plus two decoys that must survive.
    for (const name of [
      "hub-20260101-000000Z.db",
      "hub-20260102-000000Z.db",
      "hub-20260103-000000Z.db",
    ]) {
      fs.writeFileSync(path.join(backupDir, name), "old");
    }
    fs.writeFileSync(path.join(backupDir, "keepme.txt"), "notes");
    fs.writeFileSync(path.join(backupDir, "hub-manual-notes.db"), "manual"); // wrong shape

    await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      backup: { dir: backupDir, intervalMs: 3_600_000, keep: 2 },
      now: () => BOOT,
    });

    // 3 seeded + 1 boot = 4 matching; keep 2 newest, delete the 2 oldest.
    expect(backupsIn(backupDir)).toEqual(["hub-20260103-000000Z.db", BOOT_NAME]);
    // Neither decoy was pruned — only the exact pattern is ever deleted.
    expect(fs.existsSync(path.join(backupDir, "keepme.txt"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "hub-manual-notes.db"))).toBe(true);
  });

  it("a same-name collision is SKIPPED with one console.error naming the path, hub keeps serving", async () => {
    const { db, dbPath } = fileDb();
    seed(db, 1);
    const backupDir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, BOOT_NAME);
    fs.writeFileSync(dest, "pre-existing"); // the exact name this boot would write
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      backup: { dir: backupDir, intervalMs: 3_600_000, keep: 10 },
      now: () => BOOT,
    });

    // Exactly one error, and it names the colliding path.
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain(dest);
    // The pre-existing file was NOT overwritten, and the hub is serving.
    expect(fs.readFileSync(dest, "utf8")).toBe("pre-existing");
    expect(hub.port).toBeGreaterThan(0);
  });

  it("an unwritable backup dir is never fatal — logs once, hub keeps serving", async () => {
    const { db, dbPath } = fileDb();
    seed(db, 1);
    // A file where a directory is expected: mkdir under it fails with ENOTDIR.
    const blocker = path.join(path.dirname(dbPath), "blocker");
    fs.writeFileSync(blocker, "not a dir");
    const backupDir = path.join(blocker, "backups");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      backup: { dir: backupDir, intervalMs: 3_600_000, keep: 10 },
      now: () => BOOT,
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(hub.port).toBeGreaterThan(0);
    // The record is untouched and still serving from memory.
    expect(db.load().sessions[0]?.events.map((e) => e.id)).toEqual([1]);
  });

  it("an in-memory record disables backups — one boot line, no dir, no backupTo", async () => {
    const db = memDb();
    const backupDir = path.join(tmp(), "backups");
    const backupSpy = vi.spyOn(db, "backupTo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      backup: { dir: backupDir, intervalMs: 60_000, keep: 10 },
      now: () => BOOT,
    });

    expect(logSpy).toHaveBeenCalledWith(DISABLED_LINE);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it("no record at all (dbPath/db absent) disables backups with the same one line", async () => {
    const backupDir = path.join(tmp(), "backups");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await hubOn({
      port: 0,
      host: "127.0.0.1",
      backup: { dir: backupDir, intervalMs: 60_000, keep: 10 },
      now: () => BOOT,
    });

    expect(logSpy).toHaveBeenCalledWith(DISABLED_LINE);
    expect(fs.existsSync(backupDir)).toBe(false);
  });
});

describe("disk-headroom preflight and runtime gate (spec B1)", () => {
  // The cadence const the hub caches its verdict for — kept in step with
  // hub.ts's `HEADROOM_CHECK_INTERVAL_MS` (a module const, not exported).
  const INTERVAL = 10_000;
  const FLOOR = 100_000_000;
  const HIGH = 500_000_000;
  const LOW = 10;

  /** A `publish` up-frame (the one write path the headroom gate refuses). */
  const publish = (sessionId: string, runId: string, events: LoggedEvent[]): string =>
    JSON.stringify({ t: "publish", sessionId, runId, events });

  /** A `facts` up-frame — small and bounded, so it is NEVER gated by headroom. */
  const factsFor = (id: string, over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      t: "facts",
      sessionId: id,
      runId: "run-a",
      facts: {
        id,
        participants: ["ana"],
        driverName: "ana",
        intent: null,
        lastActivityTs: null,
        ended: false,
        pendingGate: null,
        skills: [],
        repoKey: "github.com/acme/api",
        touched: null,
        lifecycle: "open",
        ...over,
      },
    });

  /** An attached uplink that has said hello for the default project. */
  async function uplink(port: number) {
    const up = await connect(`ws://127.0.0.1:${port}/uplink`);
    const seen: any[] = [];
    collect(up, seen);
    up.send(
      JSON.stringify({
        t: "hello",
        v: RELAY_PROTOCOL_VERSION,
        uplinkId: "lap-1",
        name: "lap-1",
        projectId: "default",
        repos: [decl("github.com/acme/api")],
      }),
    );
    await wait(40);
    return { up, seen };
  }

  /** A browser that has identified, joined the default project and joined the
   *  named session — so anything the hub fans out for that session reaches it. */
  async function browserJoined(port: number, sessionId = "auth") {
    const ws = await connect(`ws://127.0.0.1:${port}/`);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    ws.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    ws.send(JSON.stringify({ type: "join", sessionId, projectId: "default", userId: "ana", name: "ana" }));
    await wait(60);
    return { ws, seen };
  }

  const eventIds = (db: HubDb): number[] | undefined =>
    db.load().sessions.find((s) => s.sessionId === "auth")?.events.map((e) => e.id);

  it("boot refusal: a file-backed hub below the floor rejects with the exact message", async () => {
    const { db, dbPath } = fileDb();
    const dir = path.dirname(dbPath);

    await expect(
      startHub({
        port: 0,
        host: "127.0.0.1",
        db,
        dbPath,
        minFreeBytes: 1000,
        freeBytes: () => 500,
      }),
    ).rejects.toThrow(
      `insufficient disk headroom: 500 bytes free at ${dir}, floor is 1000 — free space or lower HUB_MIN_FREE_BYTES`,
    );
  });

  it("default off-path: an in-memory record never checks headroom and never refuses boot", async () => {
    const db = memDb();
    const freeSpy = vi.fn(() => 0); // would refuse at boot if it were ever consulted

    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      minFreeBytes: 1_000_000,
      freeBytes: freeSpy,
    });

    expect(hub.port).toBeGreaterThan(0);
    expect(freeSpy).not.toHaveBeenCalled();
  });

  it("runtime gate: a publish while low is refused before store.publish — nothing written, no fan-out, no error frame, one log", async () => {
    const { db, dbPath } = fileDb();
    let free = HIGH;
    let nowMs = 1_000_000;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      dbPath,
      minFreeBytes: FLOOR,
      freeBytes: () => free,
      now: () => nowMs,
    });
    const { up, seen: upSeen } = await uplink(hub.port);

    // Healthy: this publish creates the session and lands (id 1).
    up.send(publish("auth", "run-a", [eventAt(0)]));
    await wait(40);
    expect(eventIds(db)).toEqual([1]);

    // A browser joins and watches; clear its replay so only NEW frames count.
    const { ws, seen: browserSeen } = await browserJoined(hub.port);
    browserSeen.length = 0;

    // Disk drops below the floor; the cached healthy verdict is re-consulted
    // only after the interval elapses.
    free = LOW;
    nowMs += INTERVAL;
    up.send(publish("auth", "run-a", [eventAt(1)]));
    await wait(40);

    // The dropped frame never reached the record...
    expect(eventIds(db)).toEqual([1]);
    // ...nothing was fanned out to the joined browser...
    expect(browserSeen.filter((m) => m.type === "event")).toEqual([]);
    // ...no error frame invited a retry (browser or uplink)...
    expect(browserSeen.filter((m) => m.type === "error")).toEqual([]);
    expect(upSeen.filter((m) => m.t === "error" || m.type === "error")).toEqual([]);
    // ...and exactly one console.error announced entering the low state.
    expect(errSpy).toHaveBeenCalledTimes(1);

    up.close();
    ws.close();
  });

  it("recovery: publishes resume once free rises, back-filling from the unmoved high-water mark, with one log each way", async () => {
    const { db, dbPath } = fileDb();
    let free = HIGH;
    let nowMs = 1_000_000;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      dbPath,
      minFreeBytes: FLOOR,
      freeBytes: () => free,
      now: () => nowMs,
    });
    const { up } = await uplink(hub.port);

    up.send(publish("auth", "run-a", [eventAt(0)]));
    await wait(40);
    expect(eventIds(db)).toEqual([1]);

    // Low: seq 1 is dropped, so the high-water mark stays at seq 0.
    free = LOW;
    nowMs += INTERVAL;
    up.send(publish("auth", "run-a", [eventAt(1)]));
    await wait(40);
    expect(eventIds(db)).toEqual([1]);

    // Recovered: the resume protocol replays from lastSeq (0) — seq 1 was never
    // accepted, so re-sending it now lands exactly once, id 2, no gap.
    free = HIGH;
    nowMs += INTERVAL;
    up.send(publish("auth", "run-a", [eventAt(1)]));
    await wait(40);
    expect(eventIds(db)).toEqual([1, 2]);

    // One log entering low, one on recovery — two total, never per frame.
    expect(errSpy).toHaveBeenCalledTimes(2);
    up.close();
  });

  it("cadence: freeBytes is consulted at most once per interval no matter how many publishes", async () => {
    const { db, dbPath } = fileDb();
    let nowMs = 1_000_000;
    const freeSpy = vi.fn(() => HIGH);
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      dbPath,
      minFreeBytes: FLOOR,
      freeBytes: freeSpy,
      now: () => nowMs,
    });
    const { up } = await uplink(hub.port);

    // The boot preflight is the one and only consult so far.
    expect(freeSpy).toHaveBeenCalledTimes(1);

    // Ten publishes inside one interval consult freeBytes zero further times.
    for (let i = 0; i < 10; i += 1) {
      up.send(publish("auth", "run-a", [eventAt(i)]));
      await wait(15);
    }
    expect(freeSpy).toHaveBeenCalledTimes(1);
    // The whole burst still landed (the cached verdict was healthy).
    expect(eventIds(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Crossing the interval, the next publish consults exactly once more.
    nowMs += INTERVAL;
    up.send(publish("auth", "run-a", [eventAt(10)]));
    await wait(30);
    expect(freeSpy).toHaveBeenCalledTimes(2);
    up.close();
  });

  it("scope bound: a facts frame is still applied while headroom is low — the floor guards only the journal", async () => {
    const { db, dbPath } = fileDb();
    let free = HIGH;
    let nowMs = 1_000_000;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      db,
      dbPath,
      minFreeBytes: FLOOR,
      freeBytes: () => free,
      now: () => nowMs,
    });
    const { up } = await uplink(hub.port);

    up.send(publish("auth", "run-a", [eventAt(0)]));
    await wait(40);
    expect(eventIds(db)).toEqual([1]);

    // Go low: a publish is refused, but a facts write still lands.
    free = LOW;
    nowMs += INTERVAL;
    up.send(publish("auth", "run-a", [eventAt(1)]));
    await wait(40);
    expect(eventIds(db)).toEqual([1]); // journal held at the floor

    up.send(factsFor("auth", { intent: "low-disk" }));
    await wait(40);
    const session = db.load().sessions.find((s) => s.sessionId === "auth");
    expect(session?.facts.intent).toBe("low-disk"); // identity/facts write applied
    up.close();
  });
});

// --- Rate limits, connection caps, backpressure (spec §8.10 B2) ---

const AUTH: AuthConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  sessionSecret: "test-secret",
  allowlist: "alice",
};

/** A dist dir with an index.html so the static handler (and its SPA fallback)
 *  is active — used to prove static assets are never rate-limited. */
function limitsStaticDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hublimits-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>spa</title>");
  return dir;
}

/** Open a raw WS with optional headers; resolve `{ code }` if the hub closes it
 *  (a refusal fires open→close), or `{ code: null }` if it is still open after a
 *  short grace window. Kept sockets are pushed into `kept` for teardown. */
function probeWs(
  url: string,
  kept: WebSocket[],
  headers?: Record<string, string>,
  graceMs = 60,
): Promise<{ code: number | null; reason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    kept.push(ws);
    let settled = false;
    ws.on("error", () => {});
    ws.on("close", (code, reason) => {
      if (!settled) {
        settled = true;
        resolve({ code, reason: reason.toString() });
      }
    });
    ws.on("open", () => {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ code: null, reason: "" });
        }
      }, graceMs);
    });
  });
}

/** The `_socket` a `ws` client exposes after upgrade — pausing its reader is how
 *  a test builds server-side backpressure without a real slow consumer. */
const rawSocket = (ws: WebSocket): { pause(): void; resume(): void } =>
  (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;

const helloFrame = (): string =>
  JSON.stringify({
    t: "hello",
    v: RELAY_PROTOCOL_VERSION,
    uplinkId: "lap-1",
    name: "lap-1",
    projectId: "default",
    repos: [decl("github.com/acme/api")],
  });

describe("rate limits — connection cap (spec B2)", () => {
  it("refuses the 513th socket with 1013 'rate limited' before dispatch, and reclaims a slot on close", async () => {
    let nowMs = 1_000_000;
    const hub = await hubOn({ port: 0, host: "127.0.0.1", now: () => nowMs });
    const kept: WebSocket[] = [];

    // Fill to MAX_SOCKETS. Advance the injected clock generously between each so
    // the per-IP UPGRADE bucket (30/min) never runs dry — this row is about the
    // hard socket CAP, which is checked first and is clock-independent.
    for (let i = 0; i < MAX_SOCKETS; i += 1) {
      nowMs += 5_000;
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
      kept.push(ws);
      ws.on("error", () => {});
      await new Promise<void>((res, rej) => {
        ws.on("open", () => res());
        ws.on("close", (code) => rej(new Error(`socket ${i} unexpectedly refused (${code})`)));
      });
    }

    // The 513th is refused immediately with 1013 'rate limited'.
    nowMs += 5_000;
    const refused = await probeWs(`ws://127.0.0.1:${hub.port}/`, kept);
    expect(refused.code).toBe(1013);
    expect(refused.reason).toBe("rate limited");

    // Closing one admitted socket decrements the count; a fresh connection fits.
    kept[0]!.close();
    await wait(200);
    nowMs += 5_000;
    const readmitted = await probeWs(`ws://127.0.0.1:${hub.port}/`, kept, undefined, 120);
    expect(readmitted.code).toBeNull(); // stayed open — the slot was reclaimed

    for (const ws of kept) ws.close();
  }, 30_000);
});

describe("rate limits — per-IP upgrade rate (spec B2)", () => {
  it("refuses the 31st upgrade from one IP within a minute (1013); other IPs unaffected", async () => {
    const hub = await hubOn({ port: 0, host: "127.0.0.1", trustProxy: true });
    const kept: WebSocket[] = [];
    const url = `ws://127.0.0.1:${hub.port}/`;

    // 30 upgrades from one proxied IP all pass.
    for (let i = 0; i < 30; i += 1) {
      const r = await probeWs(url, kept, { "x-forwarded-for": "1.1.1.1" }, 25);
      expect(r.code).toBeNull();
    }
    // The 31st from that same IP is refused with 1013 'rate limited'.
    const refused = await probeWs(url, kept, { "x-forwarded-for": "1.1.1.1" }, 25);
    expect(refused.code).toBe(1013);
    expect(refused.reason).toBe("rate limited");
    // A different IP has its own untouched bucket.
    const other = await probeWs(url, kept, { "x-forwarded-for": "2.2.2.2" }, 60);
    expect(other.code).toBeNull();

    for (const ws of kept) ws.close();
  }, 20_000);

  it("ignores X-Forwarded-For when trustProxy is false — every forged IP shares one bucket", async () => {
    // trustProxy defaults off: an untrusted client cannot pick its own bucket, so
    // 30 upgrades under DIFFERENT forged XFF values still drain the single
    // loopback bucket, and the 31st is refused regardless of the header it sends.
    const hub = await hubOn({ port: 0, host: "127.0.0.1" });
    const kept: WebSocket[] = [];
    const url = `ws://127.0.0.1:${hub.port}/`;

    for (let i = 0; i < 30; i += 1) {
      const r = await probeWs(url, kept, { "x-forwarded-for": `10.0.0.${i}` }, 25);
      expect(r.code).toBeNull();
    }
    const refused = await probeWs(url, kept, { "x-forwarded-for": "203.0.113.9" }, 25);
    expect(refused.code).toBe(1013);

    for (const ws of kept) ws.close();
  }, 20_000);
});

describe("rate limits — per-IP /auth and /pair HTTP rate (spec B2)", () => {
  it("returns 429 {error:'rate limited'} on the 31st /auth or /pair request from one IP", async () => {
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      trustProxy: true,
      auth: AUTH,
      dbPath: ":memory:",
      staticDir: limitsStaticDir(),
    });
    const base = `http://127.0.0.1:${hub.port}`;
    const H = { "x-forwarded-for": "1.1.1.1" };

    // 30 /auth/me requests from one IP all pass (200/401 — never rate-limited).
    for (let i = 0; i < 30; i += 1) {
      const r = await fetch(`${base}/auth/me`, { headers: H });
      expect(r.status).not.toBe(429);
    }
    // The 31st — a /pair request — proves /auth and /pair share ONE per-IP bucket.
    const refused = await fetch(`${base}/pair/request`, {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "lap-1", name: "x" }),
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).toBe("application/json");
    expect(await refused.json()).toEqual({ error: "rate limited" });
  }, 20_000);

  it("never rate-limits /healthz or static assets, even from a drained IP", async () => {
    const hub = await hubOn({
      port: 0,
      host: "127.0.0.1",
      trustProxy: true,
      auth: AUTH,
      dbPath: ":memory:",
      staticDir: limitsStaticDir(),
    });
    const base = `http://127.0.0.1:${hub.port}`;
    const H = { "x-forwarded-for": "1.1.1.1" };

    // Drain the /auth bucket for this IP.
    for (let i = 0; i < 31; i += 1) await fetch(`${base}/auth/me`, { headers: H });
    expect((await fetch(`${base}/auth/me`, { headers: H })).status).toBe(429);

    // /healthz is checked before the limiter and is never counted.
    for (let i = 0; i < 40; i += 1) {
      expect((await fetch(`${base}/healthz`, { headers: H })).status).toBe(200);
    }
    // A static asset falls through unlimited too.
    expect((await fetch(`${base}/index.html`, { headers: H })).status).toBe(200);
  }, 20_000);
});

describe("rate limits — browser message flood, uplink exemption (spec B2)", () => {
  it("closes a browser on its 201st message inside the window with 1008 'message rate exceeded'", async () => {
    const hub = await hubOn({ port: 0, host: "127.0.0.1" });
    const ws = await connect(`ws://127.0.0.1:${hub.port}/`);
    ws.on("error", () => {});
    const closed = new Promise<{ code: number; reason: string }>((res) =>
      ws.on("close", (code, reason) => res({ code, reason: reason.toString() })),
    );
    for (let i = 0; i < 201; i += 1) ws.send(JSON.stringify({ type: "noop", i }));
    const c = await closed;
    expect(c.code).toBe(1008);
    expect(c.reason).toBe("message rate exceeded");
  }, 15_000);

  it("leaves a browser sending exactly 200 messages open (pass-through)", async () => {
    const hub = await hubOn({ port: 0, host: "127.0.0.1" });
    const ws = await connect(`ws://127.0.0.1:${hub.port}/`);
    ws.on("error", () => {});
    let closedCode: number | null = null;
    ws.on("close", (code) => {
      closedCode = code;
    });
    for (let i = 0; i < 200; i += 1) ws.send(JSON.stringify({ type: "noop", i }));
    await wait(200);
    expect(closedCode).toBeNull();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 15_000);

  it("does NOT message-rate an uplink replaying a large backlog fast (exempt — authenticated)", async () => {
    const hub = await hubOn({ port: 0, host: "127.0.0.1" });
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    up.on("error", () => {});
    let closedCode: number | null = null;
    up.on("close", (code) => {
      closedCode = code;
    });
    up.send(helloFrame());
    await wait(40);
    // 250 publish frames back to back — well past MSGS_PER_WINDOW — must not close.
    for (let i = 0; i < 250; i += 1) {
      up.send(JSON.stringify({ t: "publish", sessionId: "auth", runId: "run-a", events: [eventAt(i)] }));
    }
    await wait(250);
    expect(closedCode).toBeNull();
    expect(up.readyState).toBe(WebSocket.OPEN);
    up.close();
  }, 15_000);
});

describe("backpressure — bufferedAmount ceiling (spec B2)", () => {
  const bigEvent = (seq: number): LoggedEvent =>
    ({
      type: "user_message",
      seq,
      ts: isoAt(seq),
      userId: "ana",
      text: "x".repeat(90_000),
    }) as unknown as LoggedEvent;

  const joinFrames = (ws: WebSocket): void => {
    ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    ws.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    ws.send(
      JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }),
    );
  };

  it("closes a BROWSER whose bufferedAmount exceeds BUFFERED_MAX_BYTES with 1013 'backpressure'", async () => {
    const hub = await hubOn({ port: 0, host: "127.0.0.1" });
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    up.on("error", () => {});
    up.send(helloFrame());
    await wait(40);
    up.send(JSON.stringify({ t: "publish", sessionId: "auth", runId: "run-a", events: [eventAt(0)] }));
    await wait(40);
    const ws = await connect(`ws://127.0.0.1:${hub.port}/`);
    ws.on("error", () => {});
    let closed: { code: number; reason: string } | null = null;
    ws.on("close", (code, reason) => {
      closed = { code, reason: reason.toString() };
    });
    joinFrames(ws);
    await wait(150);

    // Stop the browser from draining, then flood large events down to it. With
    // the reader paused, the hub's send buffer to it climbs past 4 MB.
    rawSocket(ws).pause();
    for (let f = 0; f < 30; f += 1) {
      const events = Array.from({ length: 10 }, (_, k) => bigEvent(f * 10 + k + 1));
      up.send(JSON.stringify({ t: "publish", sessionId: "auth", runId: "run-a", events }));
      await wait(5);
    }
    await wait(100);
    rawSocket(ws).resume();

    const deadline = Date.now() + 4000;
    while (!closed && Date.now() < deadline) await wait(20);
    expect(closed).not.toBeNull();
    expect(closed!.code).toBe(1013);
    expect(closed!.reason).toBe("backpressure");
    up.close();
  }, 20_000);

  it("closes an UPLINK whose bufferedAmount exceeds BUFFERED_MAX_BYTES with 1013 'backpressure'", async () => {
    const hub = await hubOn({ port: 0, host: "127.0.0.1" });
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    up.on("error", () => {});
    let closed: { code: number; reason: string } | null = null;
    up.on("close", (code, reason) => {
      closed = { code, reason: reason.toString() };
    });
    up.send(helloFrame());
    await wait(40);
    up.send(JSON.stringify({ t: "publish", sessionId: "auth", runId: "run-a", events: [eventAt(0)] }));
    await wait(40);
    const ws = await connect(`ws://127.0.0.1:${hub.port}/`);
    ws.on("error", () => {});
    joinFrames(ws);
    await wait(150);

    // Pause the uplink's reader, then drive large tunnel payloads at it via the
    // browser: each browser message becomes one hub->uplink `tunnel` frame. The
    // browser stays well under its own 200-message cap.
    rawSocket(up).pause();
    const blob = "z".repeat(700_000);
    for (let i = 0; i < 30; i += 1) {
      ws.send(JSON.stringify({ type: "cmd", blob }));
      await wait(5);
    }
    await wait(100);
    rawSocket(up).resume();

    const deadline = Date.now() + 4000;
    while (!closed && Date.now() < deadline) await wait(20);
    expect(closed).not.toBeNull();
    expect(closed!.code).toBe(1013);
    expect(closed!.reason).toBe("backpressure");
    ws.close();
  }, 20_000);
});
