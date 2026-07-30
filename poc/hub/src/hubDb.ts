import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { LoggedEvent } from "multiplayer-ai-server/events";
import type { RepoDecl, SessionFacts } from "multiplayer-ai-server/relayProtocol";
import type {
  HubHydration,
  HubPersister,
  ProjectLifecycle,
  StoredEvent,
} from "./hubStore.js";

/** Bumped only by a migration. A DB stamped higher than this is refused at boot
 *  rather than read with the wrong assumptions (spec §3.2, §3.6). */
export const SCHEMA_VERSION = 1;

/** Verbatim from spec §3.2. `IF NOT EXISTS` because opening an existing record
 *  is the normal case and creating one is the exception.
 *
 *  Every table is a rowid table on purpose: `load()` reads projects, machines,
 *  sessions and memberships back in rowid order, which IS the order the record
 *  first learned each row, which is the order `listProjects()` and `snapshot()`
 *  report (see `HubHydration`). That is also why every write below is an
 *  `ON CONFLICT DO UPDATE` upsert and never `INSERT OR REPLACE`: replace
 *  deletes the row and re-inserts it with a NEW rowid, so re-declaring one
 *  machine's repos would silently reorder a project's machine list. */
const SCHEMA_DDL = `
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

const MEMORY_PATH = ":memory:";

interface ProjectRowOut {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  lifecycle: string;
}
interface MemberRowOut {
  project_id: string;
  user_id: string;
}
interface MachineRowOut {
  uplink_id: string;
  project_id: string;
  name: string;
  repos_json: string;
}
interface SessionRowOut {
  project_id: string;
  session_id: string;
  uplink_id: string;
  facts_json: string;
  last_run_id: string | null;
  last_seq: number;
}
interface EventRowOut {
  project_id: string;
  session_id: string;
  id: number;
  run_id: string;
  event_json: string;
}

/** The hub's record on disk: a `HubPersister` that writes through to SQLite,
 *  plus the two lifecycle operations only the owner of the file can perform —
 *  `load()` at boot (spec §3.4) and `close()` at shutdown.
 *
 *  **Every method writes through synchronously**, because that is what makes
 *  `HubStore`'s "durable before visible" ordering worth anything: the store
 *  calls the persister and only then touches memory, so if this class returns,
 *  the transaction is committed. Nothing is queued, batched or deferred, and no
 *  write failure is swallowed — a disk error propagates and takes the hub
 *  process down rather than letting memory run ahead of the record (spec §3.6).
 *
 *  **One writer per file.** A PID lockfile beside the DB (`<dbPath>.lock`)
 *  makes a second hub on the same record refuse to start instead of interleaving
 *  two event streams into one journal (spec §3.1, §8a.3). */
export class HubDb implements HubPersister {
  private readonly db: Database.Database;
  /** null for `:memory:` and for `{ skipLock: true }` — the only two ways to
   *  run without one. */
  private readonly lockPath: string | null;
  /** `writeFrame` wrapped in a transaction once, at open: `better-sqlite3`
   *  transactions are prepared functions, and `publish` is the hottest write
   *  path the hub has. */
  private readonly appendFrame: (
    projectId: string,
    sessionId: string,
    events: StoredEvent[],
    lastRunId: string,
    lastSeq: number,
    newSession?: { uplinkId: string; facts: SessionFacts },
  ) => void;
  private closed = false;

  /** @param dbPath a file path, or `":memory:"` for an ephemeral hub that locks
   *  nothing and leaves nothing on disk. A file's parent directory is created
   *  recursively, mode `0700`: the journal holds prompts, userIds and file
   *  paths (spec §8a.7).
   *  @param opts.skipLock the crash-test seam ONLY — it lets a test open a
   *  second handle on a file whose first handle was abandoned without closing,
   *  standing in for a killed hub process. Never set in production wiring: two
   *  live writers on one record is the failure the lock exists to prevent. */
  constructor(dbPath: string, opts?: { skipLock?: boolean }) {
    const inMemory = dbPath === MEMORY_PATH;
    if (!inMemory) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.lockPath = inMemory || opts?.skipLock ? null : acquireLock(dbPath);
    // A local too, because a boot that refuses (corrupt file, newer schema) has
    // to close the handle it opened — and a field of a constructor that threw is
    // not something the catch block can safely read.
    let opened: Database.Database | undefined;
    try {
      opened = new Database(dbPath);
      this.db = opened;
      // Before any DDL: a record stamped with a schema this hub does not
      // understand must be left exactly as it was found, not half-migrated by
      // an `IF NOT EXISTS` sweep on the way to refusing it.
      this.assertSchemaUnderstood(dbPath);
      if (!inMemory) {
        // WAL is what makes "committed" mean "survives process death" for a
        // reader that opens the file afterwards. Meaningless for `:memory:`.
        this.db.pragma("journal_mode = WAL");
      }
      this.db.exec(SCHEMA_DDL);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING")
        .run(String(SCHEMA_VERSION));
      this.appendFrame = this.db.transaction(
        (
          projectId: string,
          sessionId: string,
          events: StoredEvent[],
          lastRunId: string,
          lastSeq: number,
          newSession?: { uplinkId: string; facts: SessionFacts },
        ) => this.writeFrame(projectId, sessionId, events, lastRunId, lastSeq, newSession),
      );
    } catch (err) {
      // A hub that refuses to start must not leave the lock it just took, or
      // the next attempt would report a pid that is already gone.
      this.releaseLock();
      try {
        opened?.close();
      } catch {
        // Nothing to do about a failed close on an already-failing boot.
      }
      throw err;
    }
  }

  /** Refuses rather than guesses. A newer schema means columns this build does
   *  not know about and rows it would half-read; the record is the product, so
   *  the honest move is to stop (spec §3.6). */
  private assertSchemaUnderstood(dbPath: string): void {
    const hasMeta = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get();
    if (!hasMeta) return;
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string | null } | undefined;
    if (row?.value == null) return;
    const found = Number(row.value);
    if (found === SCHEMA_VERSION) return;
    const basename = path.basename(dbPath);
    throw new Error(
      `${basename} schema is v${found}; this hub understands v${SCHEMA_VERSION} — refusing to start`,
    );
  }

  /** Everything a restarting hub boots from (spec §3.4), in the record's own
   *  order: rowid order for projects, machines, sessions and memberships, `id`
   *  order for each session's events. */
  load(): HubHydration {
    const membersByProject = new Map<string, string[]>();
    for (const row of this.db
      .prepare("SELECT project_id, user_id FROM project_members ORDER BY rowid")
      .all() as MemberRowOut[]) {
      const list = membersByProject.get(row.project_id);
      if (list) list.push(row.user_id);
      else membersByProject.set(row.project_id, [row.user_id]);
    }

    const eventsBySession = new Map<string, StoredEvent[]>();
    for (const row of this.db
      .prepare(
        "SELECT project_id, session_id, id, run_id, event_json FROM events ORDER BY project_id, session_id, id",
      )
      .all() as EventRowOut[]) {
      const stored: StoredEvent = {
        id: row.id,
        runId: row.run_id,
        event: JSON.parse(row.event_json) as LoggedEvent,
      };
      const key = sessionKey(row.project_id, row.session_id);
      const list = eventsBySession.get(key);
      if (list) list.push(stored);
      else eventsBySession.set(key, [stored]);
    }

    const projects = (
      this.db
        .prepare("SELECT id, name, created_by, created_at, lifecycle FROM projects ORDER BY rowid")
        .all() as ProjectRowOut[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      lifecycle: row.lifecycle as ProjectLifecycle,
      members: membersByProject.get(row.id) ?? [],
    }));

    const machines = (
      this.db
        .prepare("SELECT uplink_id, project_id, name, repos_json FROM machines ORDER BY rowid")
        .all() as MachineRowOut[]
    ).map((row) => ({
      uplinkId: row.uplink_id,
      projectId: row.project_id,
      name: row.name,
      repos: JSON.parse(row.repos_json) as RepoDecl[],
    }));

    const sessions = (
      this.db
        .prepare(
          "SELECT project_id, session_id, uplink_id, facts_json, last_run_id, last_seq FROM sessions ORDER BY rowid",
        )
        .all() as SessionRowOut[]
    ).map((row) => ({
      projectId: row.project_id,
      sessionId: row.session_id,
      uplinkId: row.uplink_id,
      facts: JSON.parse(row.facts_json) as SessionFacts,
      lastRunId: row.last_run_id,
      lastSeq: row.last_seq,
      events: eventsBySession.get(sessionKey(row.project_id, row.session_id)) ?? [],
    }));

    return { projects, machines, sessions };
  }

  /** Closes the handle and releases the lock, in that order, so the file is
   *  never advertised as free while this process still holds it open.
   *  Idempotent: shutdown paths may reach it twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.releaseLock();
  }

  projectSaved(p: {
    id: string;
    name: string;
    createdBy: string | null;
    createdAt: string;
    lifecycle: ProjectLifecycle;
  }): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, created_by, created_at, lifecycle) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, created_by = excluded.created_by,
             created_at = excluded.created_at, lifecycle = excluded.lifecycle`,
      )
      .run(p.id, p.name, p.createdBy, p.createdAt, p.lifecycle);
  }

  /** `OR IGNORE`, not an upsert: re-adding a member must be a no-op, and it
   *  must not move the row — memberships come back in add order and a store's
   *  `Set` does not reorder on a repeat add either. */
  memberAdded(projectId: string, userId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)")
      .run(projectId, userId);
  }

  memberRemoved(projectId: string, userId: string): void {
    this.db
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .run(projectId, userId);
  }

  machineSaved(m: { uplinkId: string; projectId: string; name: string; repos: RepoDecl[] }): void {
    this.db
      .prepare(
        `INSERT INTO machines (uplink_id, project_id, name, repos_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(uplink_id) DO UPDATE SET
             project_id = excluded.project_id, name = excluded.name,
             repos_json = excluded.repos_json`,
      )
      // Wholesale, mirroring memory (spec §5.2): the machine's own list is the
      // only authority on it, so the column is replaced, never merged.
      .run(m.uplinkId, m.projectId, m.name, JSON.stringify(m.repos));
  }

  /** Deliberately does NOT touch `events`: facts and offsets are this row's
   *  business, and a session's log only ever grows through `eventsAppended`. */
  sessionSaved(s: {
    projectId: string;
    sessionId: string;
    uplinkId: string;
    facts: SessionFacts;
    lastRunId: string | null;
    lastSeq: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (project_id, session_id, uplink_id, facts_json, last_run_id, last_seq)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, session_id) DO UPDATE SET
             uplink_id = excluded.uplink_id, facts_json = excluded.facts_json,
             last_run_id = excluded.last_run_id, last_seq = excluded.last_seq`,
      )
      .run(
        s.projectId,
        s.sessionId,
        s.uplinkId,
        JSON.stringify(s.facts),
        s.lastRunId,
        s.lastSeq,
      );
  }

  /** ONE transaction per frame (spec §3.3): the session row this frame may have
   *  created, its events, and the new high-water mark commit together or not at
   *  all. Two transactions would let a crash land events under a session
   *  nothing mentions, or a high-water mark the record cannot back with events —
   *  and `resumeOffsets` would then tell the owning laptop not to re-send them. */
  eventsAppended(
    projectId: string,
    sessionId: string,
    events: StoredEvent[],
    lastRunId: string,
    lastSeq: number,
    newSession?: { uplinkId: string; facts: SessionFacts },
  ): void {
    this.appendFrame(projectId, sessionId, events, lastRunId, lastSeq, newSession);
  }

  /** The frame's statements, in the order that makes the last of them the one
   *  whose failure proves the atomicity: session row, events, high-water mark.
   *  Only ever called inside `appendFrame`'s transaction. */
  private writeFrame(
    projectId: string,
    sessionId: string,
    events: StoredEvent[],
    lastRunId: string,
    lastSeq: number,
    newSession?: { uplinkId: string; facts: SessionFacts },
  ): void {
    if (newSession) {
      // `OR IGNORE`: the frame's `newSession` is the store's belief that this
      // session is new. If the record already holds the row, the row it holds
      // — with the facts its laptop actually declared — wins.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO sessions
             (project_id, session_id, uplink_id, facts_json, last_run_id, last_seq)
             VALUES (?, ?, ?, ?, NULL, -1)`,
        )
        .run(projectId, sessionId, newSession.uplinkId, JSON.stringify(newSession.facts));
    }
    const insert = this.db.prepare(
      "INSERT INTO events (project_id, session_id, id, run_id, event_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const stored of events) {
      insert.run(projectId, sessionId, stored.id, stored.runId, JSON.stringify(stored.event));
    }
    const updated = this.db
      .prepare(
        "UPDATE sessions SET last_run_id = ?, last_seq = ? WHERE project_id = ? AND session_id = ?",
      )
      .run(lastRunId, lastSeq, projectId, sessionId);
    if (updated.changes === 0) {
      // Loud, and it rolls the events back with it. The frame carries no facts,
      // so no honest session row can be written — and events with no session
      // row are history `load()` can never hand back.
      throw new Error(
        `eventsAppended for unknown session "${sessionId}" in "${projectId}" with no newSession`,
      );
    }
  }

  private releaseLock(): void {
    if (!this.lockPath) return;
    fs.rmSync(this.lockPath, { force: true });
  }
}

/** Session ids are only unique WITHIN a project (`hubStore.ts`'s documented
 *  bound), so a key for one must carry both, joined by a NUL that neither can
 *  contain. Only ever a `Map` key inside `load()` — never written. */
const sessionKey = (projectId: string, sessionId: string) => `${projectId}\u0000${sessionId}`;

/** Takes `<dbPath>.lock` for this process, or refuses. Returns the lockfile
 *  path so `close()` can release exactly what it took.
 *
 *  A lockfile whose pid is dead — or whose contents are not a pid at all — is
 *  reclaimed SILENTLY (spec §8a.5): the overwhelmingly common cause is a hub
 *  that was killed, and making a human delete a file before their own hub will
 *  start is a worse default than the accepted blast radius (a recycled pid could
 *  fool the liveness check; the inverse failure recovers by deleting the file). */
function acquireLock(dbPath: string): string {
  const lockPath = `${dbPath}.lock`;
  // Bounded, because each retry follows an observed stale lock we just deleted.
  // Unbounded, two processes reclaiming the same stale lock could spin.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // `wx` is the whole guard: an atomic create-or-fail, so two hubs racing
      // for a free lock cannot both win.
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let contents: string;
      try {
        contents = fs.readFileSync(lockPath, "utf8");
      } catch {
        // The holder released it between our create and our read. Try again.
        continue;
      }
      const owner = parsePid(contents);
      if (owner !== null && isAlive(owner)) {
        throw new Error(
          `${path.basename(dbPath)} is in use by pid ${owner} — refusing to start`,
        );
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`${path.basename(dbPath)} lock could not be taken — refusing to start`);
}

/** Decimal text and nothing else, which is exactly what this module writes.
 *  Anything else is a corrupt lockfile, i.e. reclaimable. */
function parsePid(contents: string): number | null {
  const trimmed = contents.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to somebody else — alive, and
    // holding the lock just the same.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
