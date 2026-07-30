import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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
  it("creates the file, the v1 schema, WAL mode and a 0700 parent dir", () => {
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
        "events",
        "machines",
        "meta",
        "project_members",
        "projects",
        "sessions",
      ]);
    });
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
    const bump = new Database(dbPath);
    bump.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    bump.close();

    expect(() => openDb(dbPath)).toThrow(
      `hub.db schema is v2; this hub understands v${SCHEMA_VERSION} — refusing to start`,
    );
    // And it did not consume its own lock on the way out.
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
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
