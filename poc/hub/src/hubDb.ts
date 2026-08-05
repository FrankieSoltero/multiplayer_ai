import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
 *  rather than read with the wrong assumptions (spec §3.2, §3.6); a DB stamped
 *  LOWER is migrated forward at open (v1→v2 adds `devices`, v2→v3 adds the
 *  project-invite tables, v3→v4 adds `project_oversight`). */
export const SCHEMA_VERSION = 4;

/** The v2 addition (spec §A2, §A3): revocable device records for uplink auth,
 *  read per-lookup and never hydrated into `HubStore`. Its own constant so the
 *  fresh-file DDL sweep and the v1→v2 migration create it from ONE source of
 *  truth. `revoked` is an integer flag (SQLite has no boolean); a token hash is
 *  an opaque hex string this class only stores and compares — hashing is the
 *  caller's job (Task 7). */
const DEVICES_DDL = `CREATE TABLE IF NOT EXISTS devices
                (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                 token_hash TEXT NOT NULL, approved_by TEXT NOT NULL,
                 approved_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);`;

/** The v3 addition (plan 2026-08-01-project-invites §1.2): project-scoped
 *  invites and their redemptions, the hub-held half of the invite protocol.
 *  Like `DEVICES_DDL`, its own constant so the fresh-file sweep and the v2→v3
 *  migration create both tables from ONE source of truth. The token is stored
 *  PLAINTEXT — a deliberate choice (plan §1.2): the hub operator already holds
 *  every project's events, and the panel's copy-link-later UX needs the token
 *  back. `revoked` is an integer flag, as on `devices`. Redemptions are keyed
 *  on (invite_id, user_id) because a seat is a DISTINCT userId — a reload
 *  mints a fresh browser identity, so counting raw joins would burn seats on
 *  the same human. No FK cascade on purpose: the lazy prune deletes both
 *  tables' dead rows itself. */
const INVITES_DDL = `CREATE TABLE IF NOT EXISTS invites
                (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL,
                 project_id TEXT NOT NULL, created_by TEXT NOT NULL,
                 created_by_name TEXT NOT NULL, created_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL,
                 revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS invite_redemptions
                (invite_id TEXT NOT NULL, user_id TEXT NOT NULL,
                 PRIMARY KEY (invite_id, user_id));`;

/** The v4 addition (plan 2026-08-04-hub-oversight §2a): one row per project
 *  holding whether oversight is on and the latest rolled-up summary. Like the
 *  DDL constants above, its own constant so the fresh-file sweep and the v3→v4
 *  migration create it from ONE source of truth. `enabled` is an integer flag
 *  (SQLite has no boolean), defaulting off so a project with no row and a
 *  project explicitly disabled read the same. `summary`/`ts` are nullable —
 *  no summary has been produced yet — and `seq` monotonically stamps each
 *  saved summary so a later write cannot be shadowed by a stale one. */
const OVERSIGHT_DDL = `CREATE TABLE IF NOT EXISTS project_oversight
                (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
                 summary TEXT, seq INTEGER NOT NULL DEFAULT 0, ts TEXT);`;

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
${DEVICES_DDL}
${INVITES_DDL}
${OVERSIGHT_DDL}
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
interface OversightRowOut {
  enabled: number;
  summary: string | null;
  seq: number;
  ts: string | null;
}

/** The revocable-device record (spec §A2, §A3), served per-lookup and never
 *  hydrated into `HubStore` — the uplink auth path reads a device row on demand,
 *  it does not hold the set in memory. A token hash is an opaque hex string the
 *  caller produces (`crypto.createHash("sha256")…`, Task 7); this store only
 *  writes and matches it. */
export interface DeviceStore {
  /** Approve a machine, or RE-pair an existing one: an upsert on `machineId`
   *  that installs the new token hash, approver and timestamp and clears
   *  `revoked`, keeping the row's rowid (its arrival order) intact. */
  deviceApproved(d: {
    machineId: string;
    name: string;
    tokenHash: string;
    approvedBy: string;
    approvedAt: string;
  }): void;
  /** The live device holding this token hash, or `null` — a revoked device is a
   *  miss, because revocation is enforced in the query itself. */
  deviceByTokenHash(tokenHash: string): { machineId: string; name: string } | null;
  /** Revoke a device; `true` if one by that `machineId` existed, `false` if
   *  none did. */
  deviceRevoked(machineId: string): boolean;
}

interface DeviceRowOut {
  machine_id: string;
  name: string;
}

/** base64url of 24 bytes is always exactly 32 chars. Anything else is rejected
 *  before it reaches the table — the same pre-check the standalone server's
 *  InviteStore runs, so the two refuse byte-identically. */
const INVITE_TOKEN_LEN = 32;
/** The seat defaults, mirrored from the standalone server (plan §1.3): a
 *  24 h TTL and 10 distinct-userId seats per invite. */
const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INVITE_MAX_USES = 10;
/** Dead invites linger this long past expiry so failures can still say *why*
 *  rather than collapsing to "not found". */
const INVITE_PRUNE_GRACE_MS = 60 * 60 * 1000;

/** The invite row with its seat count resolved in the same query, so a
 *  classify and a view can never disagree about `uses`. Shared by the
 *  token lookup and `listFor`. */
const INVITE_SELECT = `SELECT i.id, i.token, i.project_id, i.created_by, i.created_by_name,
                i.created_at, i.expires_at, i.max_uses, i.revoked,
                (SELECT COUNT(*) FROM invite_redemptions r WHERE r.invite_id = i.id) AS uses
              FROM invites i`;

/** The exact refusal strings of the invite protocol — the same four the
 *  standalone server sends, so one client speaks one protocol (plan §2.1). */
export type InviteFailure =
  | "invite not found"
  | "invite expired"
  | "invite revoked"
  | "invite is full";

/** What a project member sees — and all the wire ever carries. The token is
 *  in this shape, which is why it only ever leaves the hub in an `invite_list`
 *  reply to the socket that asked (plan §2.2). */
export interface HubInviteView {
  id: string;
  token: string;
  projectId: string;
  createdByName: string;
  expiresAt: number;
  uses: number;
  maxUses: number;
}

export type HubInviteResult =
  | { ok: true; invite: HubInviteView }
  | { ok: false; error: InviteFailure };

/** Project-scoped invites, served per-lookup like the device record and never
 *  hydrated into `HubStore` (plan §1.2). The durable hub half of the invite
 *  protocol the standalone server answers from memory: same shapes, same seat
 *  semantics, same refusal strings — one protocol, two answerers. */
export interface HubInviteStore {
  /** Mint an invite for a project. `createdByName` is the inviter's stamped
   *  (verified) display name. Returns the member-facing view, token included. */
  mint(args: { projectId: string; createdBy: string; createdByName: string }): HubInviteView;
  /** Non-consuming preview, open to anyone holding the token — the invitee is
   *  by definition not a member and maybe not even signed in, so the token
   *  itself is the capability (plan §2.3). */
  peek(token: unknown): HubInviteResult;
  /** Consuming check: takes a seat for `userId` unless they already hold one
   *  (a re-join is free). A token that exists for ANOTHER project reports
   *  "invite not found" rather than confirming it is real somewhere else. */
  redeem(token: unknown, userId: string, projectId: string): HubInviteResult;
  /** The live invites of ONE project, full ones included (they show zero
   *  seats left); revoked and expired ones are hidden. */
  listFor(projectId: string): HubInviteView[];
  /** Revoke one invite of ONE project; `true` if a row changed. The
   *  projectId is in the WHERE clause, so an id from another project is a
   *  no-op, never a cross-project mutation. */
  revoke(id: string, projectId: string): boolean;
}

interface InviteRowOut {
  id: string;
  token: string;
  project_id: string;
  created_by: string;
  created_by_name: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  revoked: number;
  /** Seat count, resolved in the same query as the row itself. */
  uses: number;
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
export class HubDb implements HubPersister, DeviceStore, HubInviteStore {
  private readonly db: Database.Database;
  /** Clock for invite TTL/expiry/prune — injectable so a test can pin time and
   *  walk an invite through live → expired → pruned without waiting. */
  private readonly nowFn: () => number;
  /** `true` for a `:memory:` record — nothing durable, so there is nothing to
   *  back up (spec B1). Read by the hub to decide whether a configured backup
   *  runs at all; `lockPath` can't answer this, since `{ skipLock: true }` is
   *  also lock-less yet very much file-backed. */
  readonly inMemory: boolean;
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
   *  recursively and set to `0700`, and the DB and its WAL side files to
   *  `0600`: the journal holds prompts, userIds and file paths (spec §8a.7).
   *  @param opts.skipLock the crash-test seam ONLY — it lets a test open a
   *  second handle on a file whose first handle was abandoned without closing,
   *  standing in for a killed hub process. Never set in production wiring: two
   *  live writers on one record is the failure the lock exists to prevent.
   *  @param opts.now the invite clock (test seam). Defaults to `Date.now`; a
   *  test pins it so TTL, expiry and the lazy prune are deterministic. */
  constructor(dbPath: string, opts?: { skipLock?: boolean; now?: () => number }) {
    this.nowFn = opts?.now ?? Date.now;
    const inMemory = dbPath === MEMORY_PATH;
    this.inMemory = inMemory;
    if (!inMemory) {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // `mode` above only applies to a directory this call CREATES, and the
      // usual parent — `~/.mpai` — is routinely already there at 0755, made by
      // the server's machine identity (`poc/server/src/machineIdentity.ts`). So
      // the mode is SET, not merely requested: the journal holds prompts,
      // userIds and file paths either way (spec §8a.7). A directory this
      // process cannot chmod is one it cannot make private, and refusing to
      // start is the honest answer to that.
      fs.chmodSync(dir, 0o700);
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
      // an `IF NOT EXISTS` sweep on the way to refusing it. A stamp BELOW this
      // build's is the migratable case and is returned, not refused.
      const found = this.assertSchemaUnderstood(dbPath);
      // Forward-only, and BEFORE the WAL pragma and the DDL sweep so the backup
      // it takes is of a still-pure v1 file. A newer stamp already refused
      // above; a fresh file (`found === null`) has nothing to migrate.
      if (found !== null && found < SCHEMA_VERSION) {
        this.migrateForward(dbPath, found, inMemory);
      }
      if (!inMemory) {
        // WAL is what makes "committed" mean "survives process death" for a
        // reader that opens the file afterwards. Meaningless for `:memory:`.
        this.db.pragma("journal_mode = WAL");
        // The other half of B1's unbounded-journal blast radius (the prune is
        // the first): cap the WAL at 64 MiB so a burst between checkpoints
        // cannot grow the journal without bound. Only meaningful in WAL, so it
        // rides alongside the pragma above and skips `:memory:`.
        this.db.pragma("journal_size_limit = 67108864");
      }
      this.db.exec(SCHEMA_DDL);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING")
        .run(String(SCHEMA_VERSION));
      // After the first write, so the WAL side files this tightens exist.
      if (!inMemory) tightenAtRest(dbPath);
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

  /** Reads the stamp and decides what this build may do with the record, WITHOUT
   *  writing a byte. Returns the stamped version — `null` for a fresh or
   *  unstamped file — so the caller can migrate a lower one forward. A NEWER
   *  stamp is refused rather than guessed: it means columns this build does not
   *  know about and rows it would half-read, and the record is the product, so
   *  the honest move is to stop (spec §3.6). */
  private assertSchemaUnderstood(dbPath: string): number | null {
    const hasMeta = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get();
    if (!hasMeta) return null;
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string | null } | undefined;
    if (row?.value == null) return null;
    const found = Number(row.value);
    // At or below this build's version is understood: equal is opened as-is,
    // lower is migrated forward by the caller. Only a higher stamp refuses.
    if (found <= SCHEMA_VERSION) return found;
    const basename = path.basename(dbPath);
    throw new Error(
      `${basename} schema is v${found}; this hub understands v${SCHEMA_VERSION} — refusing to start`,
    );
  }

  /** Migrates an older record up to `SCHEMA_VERSION`, forward only and additive:
   *  v1→v2 adds the `devices` table, v2→v3 adds the invite tables, v3→v4 adds
   *  `project_oversight`, each landing with the stamp bump. Two invariants make
   *  a crash mid-migration a non-event:
   *
   *  1. **Backup first.** A file (never `:memory:`, which has nothing to lose)
   *     is copied to `<dbPath>.v<found>.bak` while it is still pure v<found> —
   *     BEFORE the transaction opens — so a rollback is a file copy back. The
   *     WAL is checkpointed into the main file first, because the backup is a
   *     main-file copy and an un-checkpointed frame would otherwise be lost
   *     from it. The copy is tightened to `0600`: it holds the same prompts,
   *     userIds and file paths the live record does (spec §8a.7).
   *  2. **One transaction.** Every pending step's DDL and the meta bump commit
   *     together or not at all, so a crash leaves the file stamped v<found> and
   *     untouched — the backup is belt to that braces. */
  private migrateForward(dbPath: string, found: number, inMemory: boolean): void {
    if (!inMemory) {
      // Flush any committed-but-un-checkpointed frames into the main file so the
      // main-file copy below is the whole record. A no-op on a non-WAL file.
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      const backupPath = `${dbPath}.v${found}.bak`;
      fs.copyFileSync(dbPath, backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
    const migrate = this.db.transaction(() => {
      // Each step keyed on the stamp the file actually carries, so a v1 file
      // picks up BOTH arms on its way to current.
      if (found < 2) this.db.exec(DEVICES_DDL);
      if (found < 3) this.db.exec(INVITES_DDL);
      if (found < 4) this.db.exec(OVERSIGHT_DDL);
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
        .run(String(SCHEMA_VERSION));
    });
    migrate();
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

  /** A hot, atomic backup of the live record to `destPath` (spec B1, §8a
   *  ruling 7). `VACUUM INTO` runs against the open handle — no lock conflict
   *  with a concurrent publish — and writes ONE self-contained database file,
   *  sidestepping the `.db`/`-wal`/`-shm` trio-copy hazard a plain file copy
   *  would have. The copy is tightened to `0600`: it holds the same prompts,
   *  userIds and file paths the live record does (spec §8a.7).
   *
   *  THROWS if `destPath` already exists — that is SQLite's own refusal to
   *  overwrite, surfaced here rather than swallowed; the caller (the hub) treats
   *  a failed backup as non-fatal and logs it. */
  backupTo(destPath: string): void {
    this.db.prepare("VACUUM INTO ?").run(destPath);
    fs.chmodSync(destPath, 0o600);
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

  /** Retention prune (spec B1, OPT-IN): delete every event row whose payload
   *  timestamp is strictly older than `cutoffIso`, returning how many rows went.
   *  Called ONCE at boot, after open/migration and BEFORE `load()`, so memory
   *  hydrates from the already-pruned record and never diverges from it.
   *
   *  `events` ONLY — `sessions` rows (facts, last_run_id, last_seq) are left
   *  exactly as they were, so a pruned session still reports its offsets and
   *  `resumeOffsets` does not ask its laptop to re-send a run it already has.
   *
   *  Two guards make the comparison fail-safe TOWARD retention (a doubtful row
   *  is kept, never dropped): `json_type(...) = 'text'` is required, so a row
   *  with NO `ts` (`json_type` → NULL) and a row with a NON-STRING `ts` (a
   *  number sorts BELOW any string in SQLite and would otherwise delete) are
   *  both kept; only a real ISO string is ever compared. Comparisons are
   *  lexicographic, which is exactly chronological for the zero-padded ISO-8601
   *  the log writes. */
  pruneEventsBefore(cutoffIso: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM events
           WHERE json_type(event_json, '$.ts') = 'text'
             AND json_extract(event_json, '$.ts') < ?`,
      )
      .run(cutoffIso);
    return result.changes;
  }

  /** Approve or re-pair a device (spec §A2). `ON CONFLICT DO UPDATE`, never
   *  `INSERT OR REPLACE`: re-pairing a machine must reuse its row — replace
   *  would delete it and re-insert with a NEW rowid, reordering the record's
   *  arrival order (the same rule the `machines` upsert lives by,
   *  `hubDb.ts` header). A re-pair installs the new hash, approver and
   *  timestamp and clears `revoked`, so a previously revoked machine becomes
   *  live again. */
  deviceApproved(d: {
    machineId: string;
    name: string;
    tokenHash: string;
    approvedBy: string;
    approvedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO devices (machine_id, name, token_hash, approved_by, approved_at, revoked)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(machine_id) DO UPDATE SET
             name = excluded.name, token_hash = excluded.token_hash,
             approved_by = excluded.approved_by, approved_at = excluded.approved_at,
             revoked = 0`,
      )
      .run(d.machineId, d.name, d.tokenHash, d.approvedBy, d.approvedAt);
  }

  /** `revoked = 0` in the WHERE clause is the enforcement point: a revoked
   *  device is indistinguishable from an unknown one to the auth path — both are
   *  `null` — so revocation cannot be bypassed by a lookup that forgets to check
   *  a flag afterwards. */
  deviceByTokenHash(tokenHash: string): { machineId: string; name: string } | null {
    const row = this.db
      .prepare("SELECT machine_id, name FROM devices WHERE token_hash = ? AND revoked = 0")
      .get(tokenHash) as DeviceRowOut | undefined;
    return row ? { machineId: row.machine_id, name: row.name } : null;
  }

  /** `true` only when a row by that `machineId` existed to revoke — an unknown
   *  machine changes nothing and reports `false`, so a caller can tell "revoked"
   *  from "there was nothing to revoke". */
  deviceRevoked(machineId: string): boolean {
    const result = this.db
      .prepare("UPDATE devices SET revoked = 1 WHERE machine_id = ?")
      .run(machineId);
    return result.changes > 0;
  }

  /** Mint a project invite (plan §1.2). Synchronous and write-through, like
   *  every method on this class: if this returns, the row is committed.
   *  Separate draws for id and token: a public id must never be derived from a
   *  secret. */
  mint(args: { projectId: string; createdBy: string; createdByName: string }): HubInviteView {
    this.pruneInvites();
    const now = this.nowFn();
    const id = randomBytes(6).toString("base64url");
    const token = randomBytes(24).toString("base64url");
    const expiresAt = now + DEFAULT_INVITE_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO invites
           (id, token, project_id, created_by, created_by_name, created_at, expires_at, max_uses, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(id, token, args.projectId, args.createdBy, args.createdByName, now, expiresAt,
        DEFAULT_INVITE_MAX_USES);
    return {
      id,
      token,
      projectId: args.projectId,
      createdByName: args.createdByName,
      expiresAt,
      uses: 0,
      maxUses: DEFAULT_INVITE_MAX_USES,
    };
  }

  /** Non-consuming preview (plan §2.3: open — the token is the capability). */
  peek(token: unknown): HubInviteResult {
    this.pruneInvites();
    const row = this.inviteByToken(token);
    const failure = this.classifyInvite(row);
    return failure ? { ok: false, error: failure } : { ok: true, invite: this.inviteView(row!) };
  }

  /** Consuming redeem (plan §1.3). ONE transaction: the seat is written and
   *  committed before the caller hears "ok", and the classify-then-seat
   *  sequence cannot interleave with another redeem — durable before visible,
   *  the same ordering rule the frame writer lives by. */
  redeem(token: unknown, userId: string, projectId: string): HubInviteResult {
    this.pruneInvites();
    const spend = this.db.transaction((): HubInviteResult => {
      const row = this.inviteByToken(token);
      // Checked BEFORE classify, exactly like the standalone store: a token
      // that exists for another project reports "not found", so its
      // revoked/expired/full state doesn't leak across projects either.
      if (row && row.project_id !== projectId) {
        return { ok: false, error: "invite not found" };
      }
      const failure = this.classifyInvite(row, userId);
      if (failure) return { ok: false, error: failure };
      // `OR IGNORE` is the free re-join: a userId that already holds a seat
      // changes nothing and burns nothing.
      this.db
        .prepare("INSERT OR IGNORE INTO invite_redemptions (invite_id, user_id) VALUES (?, ?)")
        .run(row!.id, userId);
      // Re-read AFTER the seat write: the view's `uses` must count the seat
      // this call just took, and the row above predates it.
      return { ok: true, invite: this.inviteView(this.inviteByToken(row!.token)!) };
    });
    return spend();
  }

  /** The live invites of one project (plan §1.3): full invites included (they
   *  show zero seats left), revoked and expired hidden — the standalone
   *  `listFor`'s exact filter, in SQL. */
  listFor(projectId: string): HubInviteView[] {
    this.pruneInvites();
    const rows = this.db
      .prepare(
        `${INVITE_SELECT} WHERE i.project_id = ? AND i.revoked = 0 AND i.expires_at > ?
         ORDER BY i.expires_at`,
      )
      .all(projectId, this.nowFn()) as InviteRowOut[];
    return rows.map((row) => this.inviteView(row));
  }

  /** `project_id` in the WHERE clause is the cross-project guard: an id that
   *  belongs to another project changes nothing and reports `false`, so
   *  revocation can never reach across projects. */
  revoke(id: string, projectId: string): boolean {
    this.pruneInvites();
    const result = this.db
      .prepare("UPDATE invites SET revoked = 1 WHERE id = ? AND project_id = ?")
      .run(id, projectId);
    return result.changes > 0;
  }

  /** The oversight row for a project, or `null` when none has been written —
   *  the same "unknown is null" contract the device and invite lookups keep.
   *  `enabled` is decoded from its integer flag back to a boolean here, so no
   *  caller has to remember SQLite stores it as 0/1. */
  getOversight(
    projectId: string,
  ): { enabled: boolean; summary: string | null; seq: number; ts: string | null } | null {
    const row = this.db
      .prepare("SELECT enabled, summary, seq, ts FROM project_oversight WHERE project_id = ?")
      .get(projectId) as OversightRowOut | undefined;
    return row
      ? { enabled: row.enabled !== 0, summary: row.summary, seq: row.seq, ts: row.ts }
      : null;
  }

  /** Turn oversight on or off for a project. An upsert on `project_id` that
   *  touches `enabled` ONLY: a first write mints the row (summary null, seq 0,
   *  ts null by DDL default), a later write flips the flag and leaves any saved
   *  summary exactly where it was. */
  setOversightEnabled(projectId: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO project_oversight (project_id, enabled) VALUES (?, ?)
           ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(projectId, enabled ? 1 : 0);
  }

  /** Save the latest rolled-up summary for a project. An upsert on `project_id`
   *  that writes summary, seq and ts together and leaves `enabled` alone (a
   *  first write mints the row at the DDL default of off), so persisting a
   *  summary never silently turns oversight on. */
  saveOversightSummary(projectId: string, summary: string, seq: number, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO project_oversight (project_id, summary, seq, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             summary = excluded.summary, seq = excluded.seq, ts = excluded.ts`,
      )
      .run(projectId, summary, seq, ts);
  }

  /** Token-shape check first (exactly 32 base64url chars — anything else is
   *  "not found" before it reaches the table), then the row with its seat
   *  count resolved in the same query. */
  private inviteByToken(token: unknown): InviteRowOut | undefined {
    if (typeof token !== "string" || token.length !== INVITE_TOKEN_LEN) return undefined;
    return this.db.prepare(`${INVITE_SELECT} WHERE i.token = ?`).get(token) as
      | InviteRowOut
      | undefined;
  }

  /** Revoked before expired: a human action is the more useful explanation
   *  when both are true. A `userId` that already holds a seat passes even a
   *  full invite — the free re-join, checked before the seat count. */
  private classifyInvite(row: InviteRowOut | undefined, userId?: string): InviteFailure | null {
    if (!row) return "invite not found";
    if (row.revoked) return "invite revoked";
    if (row.expires_at <= this.nowFn()) return "invite expired";
    if (userId !== undefined) {
      const held = this.db
        .prepare("SELECT 1 AS x FROM invite_redemptions WHERE invite_id = ? AND user_id = ?")
        .get(row.id, userId);
      if (held) return null;
    }
    if (row.uses >= row.max_uses) return "invite is full";
    return null;
  }

  private inviteView(row: InviteRowOut): HubInviteView {
    return {
      id: row.id,
      token: row.token,
      projectId: row.project_id,
      createdByName: row.created_by_name,
      expiresAt: row.expires_at,
      uses: row.uses,
      maxUses: row.max_uses,
    };
  }

  /** Called from every public entry point, so the store needs no sweep timer —
   *  and therefore no teardown path to get wrong. Dead invites linger
   *  `INVITE_PRUNE_GRACE_MS` past expiry first, so a failure can still say
   *  *why*; their redemptions go with them (orphan rows would count against
   *  nothing, but they would pile up forever). */
  private pruneInvites(): void {
    const cutoff = this.nowFn() - INVITE_PRUNE_GRACE_MS;
    const prune = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM invite_redemptions WHERE invite_id IN (SELECT id FROM invites WHERE expires_at <= ?)")
        .run(cutoff);
      this.db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(cutoff);
    });
    prune();
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

/** Owner-only, on the file SQLite made and on the side files that share its
 *  rows: the record is prompts, userIds and file paths (spec §8a.7), and SQLite
 *  creates a fresh DB 0644 under a default umask.
 *
 *  The main file FIRST, deliberately: SQLite copies the database file's mode
 *  onto every `-wal`/`-shm` it creates afterwards, so tightening it also covers
 *  the side files of every later checkpoint. The two that exist right now are
 *  tightened by hand, guarded with `existsSync` because a hub that has not
 *  written yet may not have them. */
function tightenAtRest(dbPath: string): void {
  fs.chmodSync(dbPath, 0o600);
  for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(side)) fs.chmodSync(side, 0o600);
  }
}

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
      discardStaleLock(lockPath, contents);
    }
  }
  throw new Error(`${path.basename(dbPath)} lock could not be taken — refusing to start`);
}

/** Unlinks a lockfile ONLY if it still holds the bytes that were judged stale.
 *
 *  Judging takes a read, a parse and a liveness syscall, and another hub can
 *  reclaim the lock in that window — a blind `rmSync` would then delete a LIVE
 *  hub's fresh lock and leave two writers on one journal, which is the single
 *  failure this whole mechanism exists to prevent. Re-reading first means a
 *  reclaim that already happened is seen: this call becomes a no-op, and the
 *  caller's next attempt reads the new pid and refuses properly.
 *
 *  A window remains between this read and the unlink below — unlink-by-path
 *  cannot close it — but it is now two adjacent syscalls wide instead of
 *  spanning the whole judgement, and losing it requires a second reclaim inside
 *  it. Not silent, either: whoever loses that race still holds a lock nobody
 *  deleted, and the third attempt's bound turns a persistent racer into a
 *  refusal to start rather than a shared journal. */
function discardStaleLock(lockPath: string, judged: string): void {
  let current: string;
  try {
    current = fs.readFileSync(lockPath, "utf8");
  } catch {
    // Gone already — the caller's next attempt takes it or finds its successor.
    return;
  }
  if (current !== judged) return;
  fs.rmSync(lockPath, { force: true });
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
