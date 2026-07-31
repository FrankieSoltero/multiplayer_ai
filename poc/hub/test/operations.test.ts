import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHub, type RunningHub } from "../src/hub.js";
import { HubDb } from "../src/hubDb.js";
import { HubStore } from "../src/hubStore.js";
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
