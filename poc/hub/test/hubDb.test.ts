import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubDb, SCHEMA_VERSION } from "../src/hubDb.js";
import type { HubPersister, StoredEvent } from "../src/hubStore.js";
import type { RepoDecl, SessionFacts } from "multiplayer-ai-server/relayProtocol";
import { captureHydration } from "./helpers/hydrationCapture.js";

/** Every temp dir and open handle this file made, torn down after each test so
 *  a failing assertion can never leave a locked DB behind for the next one. */
const tmpDirs: string[] = [];
const open: HubDb[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubdb-"));
  tmpDirs.push(dir);
  return dir;
}

function openDb(dbPath: string, opts?: { skipLock?: boolean }): HubDb {
  const db = new HubDb(dbPath, opts);
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test itself; teardown is best-effort.
    }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const decl = (key: string, over: Partial<RepoDecl> = {}): RepoDecl => ({
  key,
  label: key.split("/").pop() ?? key,
  attached: true,
  defaultBranch: "origin/main",
  ...over,
});

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  id: "auth",
  participants: ["ana"],
  driverName: "ana",
  intent: null,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: "github.com/acme/api",
  // NON-NULL on purpose: this builder's facts are serialized into `facts_json`
  // and hydrated back through an unchecked cast, so a real list is what proves
  // `touched` survives the SQLite round trip rather than being dropped.
  touched: ["src/auth.ts"],
  lifecycle: "open",
  ...over,
});

const stored = (id: number, seq: number, runId = "run-a"): StoredEvent => ({
  id,
  runId,
  event: {
    type: "user_message",
    seq,
    ts: `2026-07-29T00:00:${String(seq).padStart(2, "0")}.000Z`,
    userId: "ana",
    text: "x",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
});

/** A read-only second connection, for the facts `load()` deliberately does not
 *  report: pragmas, the `meta` row, and raw row counts. WAL lets it read while
 *  the writer is still open. */
function raw<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const isDir = (p: string) => fs.statSync(p).isDirectory();

describe("HubDb — fresh file", () => {
  it("creates the file, the v2 schema, WAL mode and a 0700 parent dir", () => {
    const dbPath = path.join(tmp(), "nested", "deep", "hub.db");
    openDb(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);
    const dir = path.dirname(dbPath);
    expect(isDir(dir)).toBe(true);
    // Recursively created AND private: the journal holds prompts, userIds and
    // file paths (spec §8a.7 at-rest posture).
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect((fs.statSync(path.dirname(dir)).mode & 0o777).toString(8)).toBe("700");

    raw(dbPath, (db) => {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(tables).toEqual([
        "devices",
        "events",
        "machines",
        "meta",
        "project_members",
        "projects",
        "sessions",
      ]);
    });
  });

  it("takes no .v1.bak for a fresh file — nothing to lose (spec §3.2 blast radius)", () => {
    const dbPath = path.join(tmp(), "hub.db");
    openDb(dbPath);
    expect(fs.existsSync(`${dbPath}.v1.bak`)).toBe(false);
  });

  it("tightens a parent dir and a db file that ALREADY existed (spec §8a.7)", () => {
    // The shape this actually takes on a real laptop: `~/.mpai` is already
    // there — created 0755 by the server's machine identity
    // (`poc/server/src/machineIdentity.ts`) — so `mkdirSync`'s `mode` never
    // runs, and SQLite creates the DB itself 0644 under a default umask.
    // Neither is the posture the record's contents deserve.
    const dbPath = path.join(tmp(), "mpai", "hub.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.chmodSync(path.dirname(dbPath), 0o755);
    new Database(dbPath).close();
    fs.chmodSync(dbPath, 0o644);

    openDb(dbPath);

    const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);
    expect(mode(path.dirname(dbPath))).toBe("700");
    expect(mode(dbPath)).toBe("600");
    // The WAL side files carry the same rows, so they carry the same posture.
    // Both exist while the handle is open — this is not a vacuous loop.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
    expect(mode(`${dbPath}-wal`)).toBe("600");
    expect(mode(`${dbPath}-shm`)).toBe("600");
  });

  it("reopens an existing file without complaint or duplicate meta rows", () => {
    const dbPath = path.join(tmp(), "hub.db");
    openDb(dbPath).close();
    openDb(dbPath);
    raw(dbPath, (db) => {
      expect((db.prepare("SELECT count(*) AS n FROM meta").get() as { n: number }).n).toBe(1);
    });
  });
});

/** The one persister-call sequence both the DB and the oracle see. Deliberately
 *  exercises every method, both upsert paths, a membership that is added,
 *  removed and re-added (order-bearing), an implicitly created session and a
 *  second append onto an existing one. */
function applySequence(p: HubPersister): void {
  p.projectSaved({
    id: "acme",
    name: "Acme",
    createdBy: "ana",
    createdAt: "2026-07-29T10:00:00.000Z",
    lifecycle: "active",
  });
  p.memberAdded("acme", "ana");
  p.memberAdded("acme", "bo");
  p.memberAdded("acme", "cy");
  p.memberRemoved("acme", "bo");
  p.memberAdded("acme", "bo");
  // Auto-created by an attaching machine: no members, name == id.
  p.projectSaved({
    id: "side",
    name: "side",
    createdBy: null,
    createdAt: "2026-07-29T10:05:00.000Z",
    lifecycle: "active",
  });
  // setLifecycle: an upsert onto a row that already exists.
  p.projectSaved({
    id: "acme",
    name: "Acme",
    createdBy: "ana",
    createdAt: "2026-07-29T10:00:00.000Z",
    lifecycle: "closed",
  });
  p.machineSaved({
    uplinkId: "lap-1",
    projectId: "acme",
    name: "ana-mbp",
    repos: [decl("github.com/acme/api")],
  });
  p.machineSaved({ uplinkId: "lap-2", projectId: "side", name: "bo-mbp", repos: [] });
  // setRepos: wholesale replacement of lap-1's declared set.
  p.machineSaved({
    uplinkId: "lap-1",
    projectId: "acme",
    name: "ana-mbp",
    repos: [decl("github.com/acme/api"), decl("github.com/acme/web", { attached: false })],
  });
  p.sessionSaved({
    projectId: "acme",
    sessionId: "auth",
    uplinkId: "lap-1",
    facts: facts(),
    lastRunId: null,
    lastSeq: -1,
  });
  p.eventsAppended("acme", "auth", [stored(1, 0), stored(2, 1)], "run-a", 1);
  // setFacts landing after the first events: the offsets must survive it.
  p.sessionSaved({
    projectId: "acme",
    sessionId: "auth",
    uplinkId: "lap-1",
    facts: facts({ intent: "ship auth", participants: ["ana", "bo"] }),
    lastRunId: "run-a",
    lastSeq: 1,
  });
  p.eventsAppended("acme", "auth", [stored(3, 0, "run-b")], "run-b", 0);
  // A session this very frame created (spec §3.3).
  p.eventsAppended("side", "chores", [stored(1, 0, "run-c"), stored(2, 4, "run-c")], "run-c", 4, {
    uplinkId: "lap-2",
    facts: facts({ id: "chores", repoKey: null, participants: [] }),
  });
}

describe("HubDb — round trip", () => {
  it("reloads, after a close and reopen, exactly what the record was told", () => {
    const dbPath = path.join(tmp(), "hub.db");
    const capture = captureHydration();
    const db = openDb(dbPath);

    applySequence(db);
    applySequence(capture.persister);
    db.close();

    const reopened = openDb(dbPath);
    const hydration = reopened.load();
    expect(hydration).toEqual(capture.hydration());
    // Spelled out rather than left to the oracle: the orders `listProjects()`
    // and `snapshot()` inherit.
    expect(hydration.projects.map((pr) => pr.id)).toEqual(["acme", "side"]);
    expect(hydration.projects[0]?.members).toEqual(["ana", "cy", "bo"]);
    expect(hydration.projects[0]?.lifecycle).toBe("closed");
    expect(hydration.machines.map((m) => m.uplinkId)).toEqual(["lap-1", "lap-2"]);
    expect(hydration.machines[0]?.repos).toHaveLength(2);
    expect(hydration.sessions.map((s) => s.sessionId)).toEqual(["auth", "chores"]);
    expect(hydration.sessions[0]?.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(hydration.sessions[0]?.events.map((e) => e.runId)).toEqual(["run-a", "run-a", "run-b"]);
    expect(hydration.sessions[0]?.lastRunId).toBe("run-b");
    expect(hydration.sessions[0]?.lastSeq).toBe(0);
    expect(hydration.sessions[1]?.uplinkId).toBe("lap-2");
    expect(hydration.sessions[1]?.lastSeq).toBe(4);
  });

  it("hands a killed hub's replacement every committed write (crash-abandoned handle)", () => {
    // The in-process stand-in for `kill -9`: the first handle is never closed,
    // so its lock is never released and its WAL is never checkpointed. What a
    // second handle can read is exactly what survives process death.
    const dbPath = path.join(tmp(), "hub.db");
    const crashed = openDb(dbPath);
    const capture = captureHydration();
    applySequence(crashed);
    applySequence(capture.persister);

    const survivor = openDb(dbPath, { skipLock: true });
    expect(survivor.load()).toEqual(capture.hydration());
  });
});

describe("HubDb — single-writer lock", () => {
  it("refuses a second hub on the same file, naming the running pid", () => {
    const dbPath = path.join(tmp(), "hub.db");
    openDb(dbPath);

    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));
    expect(() => openDb(dbPath)).toThrow(
      `hub.db is in use by pid ${process.pid} — refusing to start`,
    );
  });

  it("names the file it was actually given, not a hardcoded hub.db", () => {
    const dbPath = path.join(tmp(), "team-record.sqlite");
    openDb(dbPath);
    expect(() => openDb(dbPath)).toThrow(
      `team-record.sqlite is in use by pid ${process.pid} — refusing to start`,
    );
  });

  it("silently reclaims a lockfile whose pid is dead", () => {
    const dbPath = path.join(tmp(), "hub.db");
    openDb(dbPath).close();
    // A pid that has provably exited: spawnSync only returns once the child is
    // gone and reaped.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(dead).toBeGreaterThan(0);
    fs.writeFileSync(`${dbPath}.lock`, String(dead));

    const db = openDb(dbPath);
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));
    expect(db.load().projects).toEqual([]);
  });

  it("silently reclaims a lockfile whose contents are not a pid at all", () => {
    const dbPath = path.join(tmp(), "hub.db");
    fs.writeFileSync(`${dbPath}.lock`, "not-a-pid\n");
    const db = openDb(dbPath);
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));
    expect(db.load().sessions).toEqual([]);
  });

  it("refuses when the stale lock it judged was reclaimed before it could unlink it", () => {
    // The race: this hub reads a dead pid and judges the lock stale, and in the
    // window before it unlinks, ANOTHER hub reclaims the lock and writes its own
    // live pid. Unlinking on the old judgement would delete a live hub's lock
    // and put two writers on one journal — the exact failure the lock exists to
    // prevent. Reclaiming is only safe for the bytes that were judged.
    const dbPath = path.join(tmp(), "hub.db");
    const lockPath = `${dbPath}.lock`;
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(lockPath, String(dead));
    // A genuinely running process to stand in for the winner: its pid is alive
    // for as long as this test needs it to be.
    const racer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    expect(racer.pid).toBeGreaterThan(0);

    // Rewrites the lockfile the instant HubDb reads it — i.e. exactly inside the
    // window between the staleness judgement and the unlink. One shot: every
    // read after it is the real thing, seeing the racer's pid on disk.
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: Parameters<typeof fs.readFileSync>[0],
      ...rest: unknown[]
    ) => {
      const out = (realRead as (...a: unknown[]) => unknown)(p, ...rest);
      if (String(p) === lockPath) {
        spy.mockRestore();
        fs.writeFileSync(lockPath, String(racer.pid));
      }
      return out;
    }) as never);

    try {
      expect(() => openDb(dbPath)).toThrow(
        `hub.db is in use by pid ${racer.pid} — refusing to start`,
      );
      // And the winner's lock is still on disk: nothing deleted it.
      expect(fs.readFileSync(lockPath, "utf8")).toBe(String(racer.pid));
    } finally {
      spy.mockRestore();
      racer.kill();
    }
  });

  it("releases the lock on close, so the next hub starts", () => {
    const dbPath = path.join(tmp(), "hub.db");
    const first = openDb(dbPath);
    first.close();
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    expect(() => openDb(dbPath)).not.toThrow();
  });

  it("leaves no lockfile behind when it refuses to start", () => {
    // A refusal must not consume the running hub's lock — the second process
    // exits, and the first must still be protected.
    const dbPath = path.join(tmp(), "hub.db");
    openDb(dbPath);
    expect(() => openDb(dbPath)).toThrow(/refusing to start/);
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));
  });
});

describe("HubDb — :memory:", () => {
  it("runs twice concurrently, locks nothing and writes nothing to disk", () => {
    const before = fs.readdirSync(process.cwd());
    const a = openDb(":memory:");
    const b = openDb(":memory:");

    a.projectSaved({
      id: "a-only",
      name: "A",
      createdBy: "ana",
      createdAt: "2026-07-29T10:00:00.000Z",
      lifecycle: "active",
    });
    expect(a.load().projects.map((p) => p.id)).toEqual(["a-only"]);
    // Two ephemeral hubs are two separate databases, not one shared file.
    expect(b.load().projects).toEqual([]);

    expect(fs.existsSync(path.resolve(":memory:"))).toBe(false);
    expect(fs.existsSync(path.resolve(":memory:.lock"))).toBe(false);
    expect(fs.readdirSync(process.cwd())).toEqual(before);
  });
});

describe("HubDb — upserts and idempotence", () => {
  it("keeps one row per key and lets the last write win", () => {
    const db = openDb(":memory:");
    db.projectSaved({
      id: "acme",
      name: "Acme",
      createdBy: "ana",
      createdAt: "2026-07-29T10:00:00.000Z",
      lifecycle: "active",
    });
    db.projectSaved({
      id: "acme",
      name: "Acme Renamed",
      createdBy: "ana",
      createdAt: "2026-07-29T10:00:00.000Z",
      lifecycle: "archived",
    });
    db.machineSaved({ uplinkId: "lap-1", projectId: "acme", name: "old", repos: [decl("a")] });
    db.machineSaved({ uplinkId: "lap-1", projectId: "acme", name: "new", repos: [] });
    db.sessionSaved({
      projectId: "acme",
      sessionId: "auth",
      uplinkId: "lap-1",
      facts: facts(),
      lastRunId: null,
      lastSeq: -1,
    });
    db.sessionSaved({
      projectId: "acme",
      sessionId: "auth",
      uplinkId: "lap-1",
      facts: facts({ intent: "later" }),
      lastRunId: "run-a",
      lastSeq: 7,
    });

    const h = db.load();
    expect(h.projects).toHaveLength(1);
    expect(h.projects[0]?.name).toBe("Acme Renamed");
    expect(h.projects[0]?.lifecycle).toBe("archived");
    expect(h.machines).toHaveLength(1);
    expect(h.machines[0]?.name).toBe("new");
    expect(h.machines[0]?.repos).toEqual([]);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]?.facts.intent).toBe("later");
    expect(h.sessions[0]?.lastRunId).toBe("run-a");
    expect(h.sessions[0]?.lastSeq).toBe(7);
  });

  it("survives a membership added twice and one removed that was never there", () => {
    const db = openDb(":memory:");
    db.projectSaved({
      id: "acme",
      name: "Acme",
      createdBy: "ana",
      createdAt: "2026-07-29T10:00:00.000Z",
      lifecycle: "active",
    });
    expect(() => {
      db.memberAdded("acme", "ana");
      db.memberAdded("acme", "bo");
      db.memberAdded("acme", "ana");
      db.memberRemoved("acme", "ghost");
    }).not.toThrow();
    // One row, and still in ITS original position: a repeat add that rewrote the
    // row would send ana to the end and reorder what `listProjects()` reports.
    expect(db.load().projects[0]?.members).toEqual(["ana", "bo"]);

    db.memberRemoved("acme", "ana");
    expect(db.load().projects[0]?.members).toEqual(["bo"]);
  });
});

describe("HubDb — one transaction per frame", () => {
  it("writes events and the session's offsets together", () => {
    const dbPath = path.join(tmp(), "hub.db");
    const db = openDb(dbPath);
    db.sessionSaved({
      projectId: "acme",
      sessionId: "auth",
      uplinkId: "lap-1",
      facts: facts(),
      lastRunId: null,
      lastSeq: -1,
    });
    db.eventsAppended("acme", "auth", [stored(1, 0), stored(2, 1), stored(3, 2)], "run-a", 2);

    const h = db.load();
    expect(h.sessions[0]?.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(h.sessions[0]?.lastRunId).toBe("run-a");
    expect(h.sessions[0]?.lastSeq).toBe(2);
  });

  it("rolls the whole frame back — events included — when the offsets update finds no session", () => {
    // The offsets update is the LAST statement of the frame, so a failure there
    // proves the event inserts before it shared its transaction: two
    // transactions would leave the events behind, orphaned under a session id
    // nothing mentions and invisible to `load()` forever.
    const dbPath = path.join(tmp(), "hub.db");
    const db = openDb(dbPath);
    expect(() => db.eventsAppended("acme", "ghost", [stored(1, 0)], "run-a", 0)).toThrow(/ghost/);

    expect(db.load().sessions).toEqual([]);
    raw(dbPath, (rdb) => {
      expect((rdb.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(0);
    });
  });

  it("leaves the previous high-water mark intact when a frame fails mid-batch", () => {
    const db = openDb(":memory:");
    db.sessionSaved({
      projectId: "acme",
      sessionId: "auth",
      uplinkId: "lap-1",
      facts: facts(),
      lastRunId: null,
      lastSeq: -1,
    });
    db.eventsAppended("acme", "auth", [stored(1, 0)], "run-a", 0);
    // Two events claiming id 2: the second insert violates the primary key.
    expect(() =>
      db.eventsAppended("acme", "auth", [stored(2, 1), stored(2, 2)], "run-a", 2),
    ).toThrow();

    const h = db.load();
    expect(h.sessions[0]?.events.map((e) => e.id)).toEqual([1]);
    expect(h.sessions[0]?.lastSeq).toBe(0);
  });

  it("writes an implicitly created session's row with its first events", () => {
    const dbPath = path.join(tmp(), "hub.db");
    const db = openDb(dbPath);
    db.eventsAppended("acme", "chores", [stored(1, 0), stored(2, 3)], "run-a", 3, {
      uplinkId: "lap-2",
      facts: facts({ id: "chores", repoKey: null }),
    });
    db.close();

    const h = openDb(dbPath).load();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]?.uplinkId).toBe("lap-2");
    expect(h.sessions[0]?.facts.id).toBe("chores");
    expect(h.sessions[0]?.events.map((e) => e.id)).toEqual([1, 2]);
    expect(h.sessions[0]?.lastRunId).toBe("run-a");
    expect(h.sessions[0]?.lastSeq).toBe(3);
  });

  it("rolls the implicit session row back with its events when the frame fails", () => {
    const dbPath = path.join(tmp(), "hub.db");
    const db = openDb(dbPath);
    expect(() =>
      db.eventsAppended("acme", "chores", [stored(1, 0), stored(1, 1)], "run-a", 1, {
        uplinkId: "lap-2",
        facts: facts({ id: "chores" }),
      }),
    ).toThrow();

    // A session row without its events would be a session browsers can see and
    // a restarted hub reports empty.
    expect(db.load().sessions).toEqual([]);
    raw(dbPath, (rdb) => {
      expect((rdb.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
      expect((rdb.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(0);
    });
  });

  it("ignores the newSession row for a session the record already holds", () => {
    const db = openDb(":memory:");
    db.sessionSaved({
      projectId: "acme",
      sessionId: "auth",
      uplinkId: "lap-1",
      facts: facts({ intent: "declared" }),
      lastRunId: null,
      lastSeq: -1,
    });
    db.eventsAppended("acme", "auth", [stored(1, 0)], "run-a", 0, {
      uplinkId: "lap-9",
      facts: facts({ intent: "invented" }),
    });
    const h = db.load();
    expect(h.sessions[0]?.uplinkId).toBe("lap-1");
    expect(h.sessions[0]?.facts.intent).toBe("declared");
  });
});

describe("HubDb — boot refusals (spec §3.6)", () => {
  it("refuses a DB whose schema is newer than it understands", () => {
    const dbPath = path.join(tmp(), "hub.db");
    openDb(dbPath).close();
    // A stamp ABOVE the current version: migration runs forward only, so a v3
    // record is refused with the existing message shape rather than downgraded.
    const bump = new Database(dbPath);
    bump.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    bump.close();

    expect(() => openDb(dbPath)).toThrow(
      `hub.db schema is v3; this hub understands v${SCHEMA_VERSION} — refusing to start`,
    );
    // And it did not consume its own lock on the way out.
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    // The stamp is left exactly as found — a newer record is refused, never
    // rewritten on the way out.
    raw(dbPath, (db) => {
      const meta = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(meta.value).toBe("3");
    });
  });

  it("propagates the failure of a file that is not a database", () => {
    const dbPath = path.join(tmp(), "hub.db");
    fs.writeFileSync(dbPath, "this is not a SQLite file, it is a note\n");
    expect(() => openDb(dbPath)).toThrow();
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it("refuses a dbPath that names a directory", () => {
    const dir = path.join(tmp(), "hub.db");
    fs.mkdirSync(dir);
    expect(() => openDb(dir)).toThrow();
    expect(fs.existsSync(`${dir}.lock`)).toBe(false);
  });
});

/** The v1 schema, VERBATIM as it shipped — the pre-`devices` table set — so a
 *  test can forge a genuine v1 record with raw SQL and prove the forward
 *  migration leaves every v1 row exactly where it found it. */
const V1_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta
                (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects
                (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                 created_by TEXT, created_at TEXT NOT NULL, lifecycle TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_members
                (project_id TEXT NOT NULL, user_id TEXT NOT NULL,
                 PRIMARY KEY (project_id, user_id));
CREATE TABLE IF NOT EXISTS machines
                (uplink_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                 name TEXT NOT NULL, repos_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions
                (project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 uplink_id TEXT NOT NULL, facts_json TEXT NOT NULL,
                 last_run_id TEXT, last_seq INTEGER NOT NULL,
                 PRIMARY KEY (project_id, session_id));
CREATE TABLE IF NOT EXISTS events
                (project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 id INTEGER NOT NULL, run_id TEXT NOT NULL, event_json TEXT NOT NULL,
                 PRIMARY KEY (project_id, session_id, id));
`;

/** Forges a v1 record on disk with raw SQL and a representative row in every v1
 *  table, then closes it — exactly the file a pre-branch hub left behind. */
function writeV1File(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(V1_SCHEMA_DDL);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    db.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, lifecycle) VALUES (?, ?, ?, ?, ?)",
    ).run("acme", "Acme", "ana", "2026-07-29T10:00:00.000Z", "active");
    db.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)").run("acme", "ana");
    db.prepare(
      "INSERT INTO machines (uplink_id, project_id, name, repos_json) VALUES (?, ?, ?, ?)",
    ).run("lap-1", "acme", "ana-mbp", JSON.stringify([decl("github.com/acme/api")]));
    db.prepare(
      "INSERT INTO sessions (project_id, session_id, uplink_id, facts_json, last_run_id, last_seq) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("acme", "auth", "lap-1", JSON.stringify(facts()), "run-a", 1);
    const insertEvent = db.prepare(
      "INSERT INTO events (project_id, session_id, id, run_id, event_json) VALUES (?, ?, ?, ?, ?)",
    );
    insertEvent.run("acme", "auth", 1, "run-a", JSON.stringify(stored(1, 0).event));
    insertEvent.run("acme", "auth", 2, "run-a", JSON.stringify(stored(2, 1).event));
  } finally {
    db.close();
  }
}

describe("HubDb — v1→v2 forward migration", () => {
  it("migrates a genuine v1 record: adds devices, bumps meta, leaves every v1 row untouched", () => {
    const dbPath = path.join(tmp(), "hub.db");
    writeV1File(dbPath);

    const db = openDb(dbPath);

    // The stamp is now v2 and the devices table exists — empty, because a
    // migration is additive and invents no rows.
    raw(dbPath, (rdb) => {
      const meta = rdb
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(meta.value).toBe(String(SCHEMA_VERSION));
      const hasDevices = rdb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'devices'")
        .get();
      expect(hasDevices).toBeDefined();
      expect((rdb.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n).toBe(0);
    });

    // Every v1 row survives, and load() hands back exactly what the v1 record
    // held — the migration disturbs nothing it did not add.
    const h = db.load();
    expect(h.projects.map((p) => p.id)).toEqual(["acme"]);
    expect(h.projects[0]?.members).toEqual(["ana"]);
    expect(h.projects[0]?.lifecycle).toBe("active");
    expect(h.machines.map((m) => m.uplinkId)).toEqual(["lap-1"]);
    expect(h.machines[0]?.repos).toHaveLength(1);
    expect(h.sessions.map((s) => s.sessionId)).toEqual(["auth"]);
    expect(h.sessions[0]?.events.map((e) => e.id)).toEqual([1, 2]);
    expect(h.sessions[0]?.lastRunId).toBe("run-a");
    expect(h.sessions[0]?.lastSeq).toBe(1);
  });

  it("copies the pure-v1 file to <dbPath>.v1.bak BEFORE migrating (blast radius / rollback)", () => {
    const dbPath = path.join(tmp(), "hub.db");
    writeV1File(dbPath);

    openDb(dbPath);

    const bakPath = `${dbPath}.v1.bak`;
    expect(fs.existsSync(bakPath)).toBe(true);
    // Owner-only: the snapshot carries the same prompts, userIds and file paths
    // the live record does (spec §8a.7).
    expect((fs.statSync(bakPath).mode & 0o777).toString(8)).toBe("600");
    // And it is a PRE-migration snapshot — still stamped v1, still without the
    // devices table — so a rollback restores an intact v1 record.
    const bak = new Database(bakPath);
    try {
      const meta = bak
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(meta.value).toBe("1");
      const hasDevices = bak
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'devices'")
        .get();
      expect(hasDevices).toBeUndefined();
      // The v1 rows are all there — it is a full copy, not an empty shell.
      expect((bak.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n).toBe(1);
      expect((bak.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(2);
    } finally {
      bak.close();
    }
  });

  it("reopening a migrated file is a plain v2 open — no second backup, no re-migration", () => {
    const dbPath = path.join(tmp(), "hub.db");
    writeV1File(dbPath);
    openDb(dbPath).close();
    // The migration already ran; delete its backup so a second one would show.
    fs.rmSync(`${dbPath}.v1.bak`);

    const reopened = openDb(dbPath);
    expect(fs.existsSync(`${dbPath}.v1.bak`)).toBe(false);
    expect(reopened.load().projects.map((p) => p.id)).toEqual(["acme"]);
  });
});

describe("HubDb — DeviceStore", () => {
  const approve = (
    db: HubDb,
    over: Partial<{
      machineId: string;
      name: string;
      tokenHash: string;
      approvedBy: string;
      approvedAt: string;
    }> = {},
  ) =>
    db.deviceApproved({
      machineId: "m1",
      name: "ana-mbp",
      tokenHash: "hash-a",
      approvedBy: "ana",
      approvedAt: "2026-07-31T10:00:00.000Z",
      ...over,
    });

  it("inserts an approved device with revoked = 0 and looks it up by token hash", () => {
    const db = openDb(":memory:");
    approve(db);
    expect(db.deviceByTokenHash("hash-a")).toEqual({ machineId: "m1", name: "ana-mbp" });
  });

  it("returns null for an unknown token hash", () => {
    const db = openDb(":memory:");
    approve(db);
    expect(db.deviceByTokenHash("nope")).toBeNull();
  });

  it("returns true and revokes a known device; false for an unknown machineId", () => {
    const db = openDb(":memory:");
    approve(db);
    expect(db.deviceRevoked("m1")).toBe(true);
    expect(db.deviceRevoked("ghost")).toBe(false);
  });

  it("hides a revoked device from token-hash lookup (revocation enforced in the query)", () => {
    const db = openDb(":memory:");
    approve(db);
    db.deviceRevoked("m1");
    expect(db.deviceByTokenHash("hash-a")).toBeNull();
  });

  it("re-pairs a revoked device: new token hash, revoked reset to 0, rowid preserved", () => {
    const dbPath = path.join(tmp(), "hub.db");
    const db = openDb(dbPath);
    approve(db, { tokenHash: "hash-old" });
    const rowidBefore = raw(dbPath, (rdb) =>
      (rdb.prepare("SELECT rowid AS r FROM devices WHERE machine_id = 'm1'").get() as { r: number })
        .r,
    );
    db.deviceRevoked("m1");

    // Re-pair with a fresh token, approver and timestamp.
    db.deviceApproved({
      machineId: "m1",
      name: "ana-mbp-2",
      tokenHash: "hash-new",
      approvedBy: "bo",
      approvedAt: "2026-07-31T12:00:00.000Z",
    });

    // The old hash is gone, the new one is live again, and the fields updated.
    expect(db.deviceByTokenHash("hash-old")).toBeNull();
    expect(db.deviceByTokenHash("hash-new")).toEqual({ machineId: "m1", name: "ana-mbp-2" });
    // Upsert, not replace: the rowid — the record's arrival order — is preserved.
    const rowidAfter = raw(dbPath, (rdb) =>
      (rdb.prepare("SELECT rowid AS r FROM devices WHERE machine_id = 'm1'").get() as { r: number })
        .r,
    );
    expect(rowidAfter).toBe(rowidBefore);
    raw(dbPath, (rdb) => {
      const row = rdb
        .prepare("SELECT approved_by, approved_at, revoked FROM devices WHERE machine_id = 'm1'")
        .get() as { approved_by: string; approved_at: string; revoked: number };
      expect(row.approved_by).toBe("bo");
      expect(row.approved_at).toBe("2026-07-31T12:00:00.000Z");
      expect(row.revoked).toBe(0);
    });
  });

  it("survives a close and reopen — devices persist, and are NOT hydrated into load()", () => {
    const dbPath = path.join(tmp(), "hub.db");
    const db = openDb(dbPath);
    approve(db);
    db.close();

    const reopened = openDb(dbPath);
    expect(reopened.deviceByTokenHash("hash-a")).toEqual({ machineId: "m1", name: "ana-mbp" });
    // load() is untouched by devices: no field of HubHydration exposes them.
    const h = reopened.load();
    expect(Object.keys(h).sort()).toEqual(["machines", "projects", "sessions"]);
  });
});
