# v7c — Hub Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hub survive its own restart — paired laptops stay paired, host settings stay set, and a team's transcripts are still there tomorrow.

**Architecture:** One SQLite file, opened synchronously via Node's built-in `node:sqlite`, behind four small repository modules. Each of the three in-memory stores v7b built (`DeviceStore`, `HostState`, `HubStore`) keeps its exact public interface and gains a repository underneath, so every call site written in v7b1–v7b3 is untouched and every pure test of those stores keeps running against an in-memory database. `PairingStore` deliberately stays in memory. Nothing about the relay protocol, the laptop, or the client changes in this plan.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `node:sqlite`, `ws`, vitest. **No new runtime dependencies.**

## Global Constraints

- **Prerequisite: v7b1, v7b2 and v7b3 are merged.** Baselines before Task 1: **server 404, hub 118, client 206**, all typechecks clean, client build clean.
- Spec authority: `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md` §7 ("v7c — persistence") and §8 (the bound this plan closes: "with v7b's in-memory hub log, a hub restart still loses history").
- **The laptop and the client do not change in this plan.** If a task requires editing `poc/server/src/` or `poc/client/src/`, stop — persistence is entirely a hub concern, and the relay protocol is deliberately untouched.
- **Every public method of `DeviceStore`, `HostState` and `HubStore` keeps its exact signature.** This plan swaps what is behind them, not what they look like. If a call site in `hub.ts` has to change, the refactor went wrong.
- **Hub tests run against `:memory:`**, never a file on disk. A test that leaves a `.db` behind will corrupt the next run.
- **Server imports use `.js` specifiers**; hub tests live in `poc/hub/test/`.
- **Never log a token hash, a session transcript, or the database path with credentials in it.**
- Do not run `git add -A`. Never commit `market-research.md`, `poc/demo-plugins/`, `tour-skill-suggest.png`, or any `*.db`, `*.db-wal`, `*.db-shm`.

### The dependency decision, verified rather than assumed

**Use `node:sqlite`. Zero new dependencies.** This was checked against the Node actually on the development machine rather than taken from documentation:

```
$ node --version
v22.22.0
$ node -e "const s=require('node:sqlite'); const db=new s.DatabaseSync(':memory:'); …"
node:sqlite OK -> [{"a":1,"b":"hello"}]
(node:25498) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

Two things follow, and both are load-bearing:

1. **It works, synchronously, with no install.** `DatabaseSync` matches how the hub already works — `HostState.settings()` and `HubStore.snapshot()` are synchronous and called from socket handlers, and making them async would ripple through every call site in `hub.ts` for no benefit.
2. **It prints an `ExperimentalWarning` on this Node.** That is noise in the hub's logs and, more importantly, a signal that the API may move. Task 1 pins the behaviour with a test that fails loudly if the constructor or `prepare/run/all` shape changes, and `main.ts` starts the hub with `--no-warnings=ExperimentalWarning` documented in the RUNBOOK rather than silencing all warnings.

**Fallback, if `node:sqlite` turns out to be unusable on the deployment's Node:** `better-sqlite3`. Same synchronous `prepare/run/all` shape, so only `db.ts` changes. It is a native module with a build step, which is why it is the fallback and not the default. **Do not switch pre-emptively** — Task 1 Step 1 is the check.

### What deliberately does NOT persist

- **`PairingStore`.** Pending pairings have a five-minute TTL and a single-use code. A hub restart during those five minutes means one person runs `mpai --hub` again — which is cheaper than persisting a short-lived secret and then having to expire it correctly on the way back in.
- **Live uplink state** (`online`, which socket owns which uplink). It is by definition about right now; a restart means no laptop is attached, and the honest answer on the first snapshot after boot is `offline` for everything until the laptops reconnect.
- **`channels`** (browser connections). Same reason.

### Out of scope, do not build

Handoff continuity (v7d). Collision detection (v7e). Multi-hub or replication. Backups as an automated feature — Task 5 documents the one-line `sqlite3 .backup` a host runs, it does not schedule it. Encryption at rest: the file is `0600` on a box the operator controls, and the threat model (spec §8) already says the hub sees everything relayed through it. An audit log — still Reading B work, and still the first thing a real customer will ask for.

---

### Task 1: `db.ts` — the database, its schema, and its migrations

One module owns opening the file, applying migrations in order, and nothing else. Every other task talks to it through prepared statements.

**Files:**
- Create: `poc/hub/src/db.ts`
- Modify: `poc/hub/.gitignore`
- Test: `poc/hub/test/db.test.ts`

**Interfaces:**
- Consumes: `node:sqlite`.
- Produces:
  - `openDb(path: string): Db` — `Db` is a thin structural wrapper (`exec`, `prepare`, `close`) so the fallback in the note above touches one file.
  - `SCHEMA_VERSION`, `migrate(db): number` (returns the version it reached)
  - Tasks 2–5 call `openDb` and take a `Db`.

- [ ] **Step 1: Verify the runtime before writing anything**

Run: `cd poc/hub && node -e "const s=require('node:sqlite'); const db=new s.DatabaseSync(':memory:'); db.exec('CREATE TABLE t(a INTEGER PRIMARY KEY)'); db.prepare('INSERT INTO t DEFAULT VALUES').run(); console.log(db.prepare('SELECT count(*) c FROM t').get());"`

Expected: prints `{ c: 1 }`, possibly with an `ExperimentalWarning`.
**If this fails**, stop and switch to the `better-sqlite3` fallback named above — the rest of this plan is unchanged apart from `db.ts`. Record the switch in Deviations.

- [ ] **Step 2: Write the failing test**

Create `poc/hub/test/db.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, migrate, openDb } from "../src/db.js";

const fresh = () => openDb(":memory:");

describe("schema", () => {
  it("migrates a blank database to the current version", () => {
    const db = fresh();
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent — running it twice changes nothing and throws nothing", () => {
    // The hub calls migrate() on every boot. If a second run were not safe,
    // the second restart would be the one that failed.
    const db = fresh();
    migrate(db);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("creates every table the repositories need", () => {
    const db = fresh();
    migrate(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["devices", "events", "seats", "sessions", "settings"]);
    db.close();
  });

  it("refuses to open a database from a NEWER schema than this build knows", () => {
    // Rolling the hub back after a migration would otherwise have the old
    // build write rows the new schema's constraints reject — corruption that
    // surfaces days later. Failing at boot is the kind answer.
    const db = fresh();
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer schema/i);
    db.close();
  });

  it("indexes the event lookup a browser join actually performs", () => {
    // Every join replays a session's log from an id. Without this index that
    // is a full scan of every event on the hub, on every join.
    const db = fresh();
    migrate(db);
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE project_id=? AND session_id=? AND id>? ORDER BY id")
      .all("p", "s", 0) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/USING INDEX/);
    db.close();
  });

  it("enforces one row per (project, session)", () => {
    const db = fresh();
    migrate(db);
    const insert = db.prepare(
      "INSERT INTO sessions (project_id, session_id, uplink_id, facts, digest, closed, last_run_id, last_seq) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run("p", "s", "u", "{}", null, 0, null, -1);
    expect(() => insert.run("p", "s", "u2", "{}", null, 0, null, -1)).toThrow();
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/db.test.ts`
Expected: FAIL — `Failed to resolve import "../src/db.js"`.

- [ ] **Step 4: Write the implementation**

Create `poc/hub/src/db.ts`:

```ts
import { DatabaseSync } from "node:sqlite";

/** Bump when a migration is added. The hub refuses to open a database written
 *  by a NEWER build than itself — rolling back after a migration would
 *  otherwise have the old build write rows the new constraints reject, which
 *  surfaces as corruption days later rather than as an error now. */
export const SCHEMA_VERSION = 1;

/** A deliberately tiny structural surface. `node:sqlite` is marked
 *  experimental on Node 22 (it prints an ExperimentalWarning), so the whole
 *  point of this type is that swapping in better-sqlite3 — which has the same
 *  prepare/run/all/get shape — touches this file and nothing else. */
export interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  // WAL: readers never block the writer, which matters because a snapshot push
  // reads while an uplink is writing events. Not applied to :memory:, where it
  // is meaningless and SQLite ignores it anyway.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  // Without this, SQLite silently accepts a write that violates a foreign key.
  db.exec("PRAGMA foreign_keys = ON");
  return db as unknown as Db;
}

/** Ordered, append-only. A migration is never edited once it has shipped —
 *  editing one means a hub that already ran it never gets the change. */
const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    login       TEXT NOT NULL,
    label       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at  INTEGER,
    -- The bearer itself is NEVER stored, only sha256 of it, so a copy of this
    -- file does not yield usable uplink tokens (v7b2 Task 1).
    token_hash  TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS devices_by_login ON devices (login, created_at DESC);

  -- Single-row-per-key store for the host and the settings blob. A blob rather
  -- than a column per setting: settings change shape more often than they are
  -- queried, and nothing ever selects on one.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seats (
    login      TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    project_id  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    uplink_id   TEXT NOT NULL,
    facts       TEXT NOT NULL,
    digest      TEXT,
    closed      INTEGER NOT NULL DEFAULT 0,
    -- The (runId, seq) high-water mark, so a reconnecting laptop that resumes
    -- from a stale offset still cannot duplicate the log (v7b1 Task 4).
    last_run_id TEXT,
    last_seq    INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (project_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    -- Per-session monotonic id, assigned by the repository rather than by
    -- AUTOINCREMENT: browsers resume from it, and a global rowid would make
    -- every session's ids depend on every other session's traffic.
    id         INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id     TEXT NOT NULL,
    ts         TEXT NOT NULL,
    body       TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id, id)
  );
  -- The exact shape of the join replay: everything after an id, in order.
  CREATE INDEX IF NOT EXISTS events_replay ON events (project_id, session_id, id);
  -- Retention deletes by timestamp across every session.
  CREATE INDEX IF NOT EXISTS events_by_ts ON events (ts);
  `,
];

export function migrate(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database was written by a newer schema (v${current}); this build knows v${SCHEMA_VERSION}`,
    );
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    db.exec(MIGRATIONS[version]);
  }
  // PRAGMA cannot be parameterised, and SCHEMA_VERSION is a module constant,
  // never user input.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return SCHEMA_VERSION;
}
```

Add to `poc/hub/.gitignore`:

```
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run test/db.test.ts && npx tsc --noEmit`
Expected: PASS, 6 tests; tsc clean. Hub suite total: **124 passed** (118 + 6).

- [ ] **Step 6: Commit**

```bash
git add poc/hub/src/db.ts poc/hub/test/db.test.ts poc/hub/.gitignore
git commit -m "feat(hub): sqlite schema and migrations (v7c)"
```

---

### Task 2: Devices survive a restart

The most user-visible half of this plan: without it, every hub restart un-pairs every laptop and the whole team runs `mpai --hub` again.

**Files:**
- Modify: `poc/hub/src/pairing.ts` (`DeviceStore` gains a `Db`), `poc/hub/src/hub.ts`
- Test: `poc/hub/test/pairing.test.ts` (add a `describe`; **do not edit existing cases**)

**Interfaces:**
- Consumes: `Db`, `openDb` (Task 1).
- Produces: `DeviceStore`'s constructor gains a `db` dependency. **Every public method keeps its exact signature** — `issue`, `verify`, `listFor`, `revoke`, `touch` are unchanged, so v7b2's call sites in `pairRoutes.ts` and `hub.ts` do not move.

- [ ] **Step 1: Write the failing test**

Append to `poc/hub/test/pairing.test.ts`:

```ts
import { migrate, openDb } from "../src/db.js";

function db() {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

describe("DeviceStore persistence", () => {
  it("keeps devices across a restart, so a paired laptop stays paired", () => {
    // The bound v7b2 shipped with, and the reason this plan exists: without
    // it, every hub restart makes the whole team re-pair.
    const shared = db();
    const before = new DeviceStore({ now: () => 1000, db: shared });
    const { token, device } = before.issue("frankie", "frankie-macbook");

    // A "restart" is a brand new store over the same database.
    const after = new DeviceStore({ now: () => 2000, db: shared });
    expect(after.verify(token)).toEqual({ ok: true, device: expect.objectContaining({ id: device.id }) });
    expect(after.listFor("frankie").map((d) => d.label)).toEqual(["frankie-macbook"]);
  });

  it("keeps a revocation across a restart — the whole point of a revocation", () => {
    const shared = db();
    const before = new DeviceStore({ now: () => 1000, db: shared });
    const { token, device } = before.issue("frankie", "laptop");
    before.revoke(device.id, "frankie");

    const after = new DeviceStore({ now: () => 2000, db: shared });
    expect(after.verify(token)).toEqual({ ok: false, error: "this device has been revoked" });
  });

  it("still stores only the hash, so the file does not leak usable tokens", () => {
    const shared = db();
    const store = new DeviceStore({ now: () => 1000, db: shared });
    const { token } = store.issue("frankie", "laptop");
    const rows = shared.prepare("SELECT * FROM devices").all();
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("persists last-seen so 'last seen 2m ago' survives a restart", () => {
    const shared = db();
    const before = new DeviceStore({ now: () => 1000, db: shared });
    const { device } = before.issue("frankie", "laptop");
    before.touch(device.id, 5000);

    const after = new DeviceStore({ now: () => 9000, db: shared });
    expect(after.listFor("frankie")[0].lastSeenAt).toBe(5000);
  });

  it("still refuses a cross-login revoke after a restart", () => {
    const shared = db();
    const before = new DeviceStore({ now: () => 1000, db: shared });
    const { device } = before.issue("frankie", "laptop");
    const after = new DeviceStore({ now: () => 2000, db: shared });
    expect(after.revoke(device.id, "mallory")).toEqual({ ok: false, error: "unknown device" });
  });
});
```

**Every existing `DeviceStore` test in this file keeps working unedited** because the constructor's `db` is optional and defaults to a fresh in-memory database. That default is what makes this a drop-in change rather than a rewrite of the suite.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/pairing.test.ts`
Expected: FAIL — the constructor rejects `db`, and a second store sees none of the first's devices.

- [ ] **Step 3: Write the implementation**

In `poc/hub/src/pairing.ts`, replace `DeviceStore`'s two Maps with SQL. The public methods do not change shape:

```ts
import { migrate, openDb, type Db } from "./db.js";

export class DeviceStore {
  private db: Db;
  private now: () => number;
  private random: RandomBytes;

  constructor(deps: { now?: () => number; random?: RandomBytes; db?: Db } = {}) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? crypto.randomBytes;
    // Defaulting to a private in-memory database is what lets every pure test
    // written in v7b2 keep running unedited — they never passed a db and now
    // they still do not have to.
    if (deps.db) {
      this.db = deps.db;
    } else {
      this.db = openDb(":memory:");
      migrate(this.db);
    }
  }

  issue(login: string, label: string): { token: string; device: Device } {
    const token = this.random(32).toString("base64url");
    const device: Device = {
      id: this.random(8).toString("hex"),
      login,
      label: label.slice(0, 60),
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO devices (id, login, label, created_at, last_seen_at, revoked_at, token_hash) VALUES (?,?,?,?,?,?,?)",
      )
      .run(device.id, device.login, device.label, device.createdAt, null, null, hash(token));
    return { token, device };
  }

  verify(token: string): VerifyResult {
    const row = this.db
      .prepare("SELECT * FROM devices WHERE token_hash = ?")
      .get(hash(token)) as DeviceRow | undefined;
    if (!row) return { ok: false, error: "unknown device token" };
    if (row.revoked_at !== null) return { ok: false, error: "this device has been revoked" };
    return { ok: true, device: toDevice(row) };
  }

  listFor(login: string): Device[] {
    // Newest first, and revoked devices stay listed — "I revoked that" is
    // information the human needs, and hiding it reads as a failed revoke.
    return (
      this.db
        .prepare("SELECT * FROM devices WHERE login = ? ORDER BY created_at DESC")
        .all(login) as DeviceRow[]
    ).map(toDevice);
  }

  revoke(deviceId: string, login: string): { ok: true } | { ok: false; error: string } {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as
      | DeviceRow
      | undefined;
    // Same message for "not yours" and "does not exist" — a distinct error
    // would confirm the existence of another user's device id.
    if (!row || row.login !== login) return { ok: false, error: "unknown device" };
    if (row.revoked_at === null) {
      this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(this.now(), deviceId);
    }
    return { ok: true };
  }

  touch(deviceId: string, now: number): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, deviceId);
  }
}

interface DeviceRow {
  id: string;
  login: string;
  label: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  token_hash: string;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    login: row.login,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}
```

In `poc/hub/src/hub.ts`, pass the shared database in:

```ts
  const devices = new DeviceStore({ db });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **129 passed** (124 + 5). **The ten pre-existing `DeviceStore` / `PairingStore` cases are unedited.**

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/pairing.ts poc/hub/src/hub.ts poc/hub/test/pairing.test.ts
git commit -m "feat(hub): persist device records and revocations (v7c)"
```

---

### Task 3: Host settings and seats survive a restart

Same shape as Task 2, and the same rule: the public interface of `HostState` does not move.

**Files:**
- Modify: `poc/hub/src/hostSettings.ts`, `poc/hub/src/hub.ts`
- Test: `poc/hub/test/hostSettings.test.ts` (add a `describe`; do not edit existing cases)

**Interfaces:**
- Produces: `HostState`'s constructor gains an optional `db`. `host()`, `claim`, `transfer`, `isHost`, `settings`, `publicSettings`, `update`, `mayAddPlugins`, `allowlistCsv`, `seatSeen`, `seats` are all unchanged.

- [ ] **Step 1: Write the failing test**

Append to `poc/hub/test/hostSettings.test.ts`:

```ts
import { migrate, openDb } from "../src/db.js";

function db() {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

describe("HostState persistence", () => {
  it("keeps the host and every setting across a restart", () => {
    const shared = db();
    const before = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    before.update("frankie", { autoModeAllowed: false, retentionDays: 30 });

    const after = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    expect(after.host()).toBe("frankie");
    expect(after.settings().autoModeAllowed).toBe(false);
    expect(after.settings().retentionDays).toBe(30);
  });

  it("keeps the oversight key, so oversight does not silently stop after a reboot", () => {
    const shared = db();
    const before = new HostState({ allowlist: "frankie", host: "frankie", db: shared });
    before.update("frankie", { oversight: { enabled: true, apiKey: "sk-ant-secret" } });

    const after = new HostState({ allowlist: "frankie", host: "frankie", db: shared });
    expect(after.settings().oversight.apiKey).toBe("sk-ant-secret");
    // And it is still structurally impossible to leak through the public shape.
    expect(JSON.stringify(after.publicSettings())).not.toContain("sk-ant-secret");
  });

  it("keeps a stored host even when the env no longer names one", () => {
    // The env var is a BOOTSTRAP, not the source of truth. Once a hub has a
    // host — configured or claimed — restarting without HUB_HOST set must not
    // silently make the hub ownerless and claimable by the next arrival.
    const shared = db();
    new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    const after = new HostState({ allowlist: "frankie,ana", db: shared });
    expect(after.host()).toBe("frankie");
    expect(after.claim("ana")).toEqual({ ok: false, error: "this hub already has a host" });
  });

  it("keeps a transfer across a restart", () => {
    const shared = db();
    const before = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    before.transfer("frankie", "ana");
    const after = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    // The stored host wins over the env bootstrap, or a restart would hand the
    // hub back to whoever is named in the unit file.
    expect(after.host()).toBe("ana");
  });

  it("keeps the persisted allowlist rather than reverting to the env one", () => {
    const shared = db();
    const before = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    before.update("frankie", { allowlist: ["frankie", "ana", "ben"] });
    const after = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    expect(after.allowlistCsv()).toBe("frankie,ana,ben");
  });

  it("keeps seats counted across a restart", () => {
    const shared = db();
    const before = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    before.seatSeen("frankie");
    before.seatSeen("ana");
    const after = new HostState({ allowlist: "frankie,ana", host: "frankie", db: shared });
    expect(after.seats()).toBe(2);
    after.seatSeen("frankie");
    expect(after.seats()).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/hostSettings.test.ts`
Expected: FAIL — the constructor rejects `db`, and a second state sees the env defaults.

- [ ] **Step 3: Write the implementation**

In `poc/hub/src/hostSettings.ts`, keep the in-memory fields as the working copy and write through on every mutation:

```ts
  constructor(seed: { allowlist: string; host?: string; db?: Db }) {
    if (seed.db) {
      this.db = seed.db;
    } else {
      this.db = openDb(":memory:");
      migrate(this.db);
    }
    const stored = this.load();
    // The env vars are a BOOTSTRAP, not the source of truth. A hub that has
    // already been configured must not silently revert to the unit file's
    // idea of who owns it every time it restarts.
    this.hostLogin = stored?.host ?? (seed.host ? norm(seed.host) : null);
    this.state = stored?.settings ?? {
      allowlist: dedupe(seed.allowlist.split(",")),
      membersMayAddPlugins: true,
      autoModeAllowed: true,
      retentionDays: DEFAULT_RETENTION_DAYS,
      oversight: { enabled: false, apiKey: null },
    };
    this.seatsSeen = new Set(
      (this.db.prepare("SELECT login FROM seats").all() as { login: string }[]).map((r) => r.login),
    );
    // Persist the bootstrap on first boot so the next restart reads it back
    // rather than depending on the env again.
    if (!stored) this.save();
  }

  private load(): { host: string | null; settings: HostSettings } | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'host_state'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      // A hand-mangled row means "start from the bootstrap", never a crash on
      // boot — a hub that will not start is worse than a hub with defaults.
      return null;
    }
  }

  private save(): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('host_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ host: this.hostLogin, settings: this.state }));
  }
```

Call `this.save()` at the end of `claim`, `transfer` and `update` — on their **success** paths only, so a rejected update never writes. And in `seatSeen`:

```ts
  seatSeen(login: string): void {
    const key = norm(login);
    if (this.seatsSeen.has(key)) return;
    this.seatsSeen.add(key);
    this.db
      .prepare("INSERT INTO seats (login, first_seen) VALUES (?, ?) ON CONFLICT(login) DO NOTHING")
      .run(key, Date.now());
  }
```

In `poc/hub/src/hub.ts`:

```ts
  const hosts = new HostState({
    allowlist: opts.auth?.allowlist ?? "",
    host: opts.hostLogin,
    db,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **135 passed** (129 + 6). The fifteen pre-existing `HostState` cases unedited.

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/hostSettings.ts poc/hub/src/hub.ts poc/hub/test/hostSettings.test.ts
git commit -m "feat(hub): persist host, settings and seats (v7c)"
```

---

### Task 4: The event log and session facts survive a restart

The largest of the three, and the one that delivers the headline: a team's transcripts are still there tomorrow.

**Files:**
- Modify: `poc/hub/src/hubStore.ts`, `poc/hub/src/hub.ts`
- Test: `poc/hub/test/hubStore.test.ts` (add a `describe`; do not edit existing cases)

**Interfaces:**
- Produces: `HubStore`'s constructor gains an optional `db`. `attach`, `detach`, `resumeOffsets`, `publish`, `setFacts`, `setDigest`, `setPlugins`, `ownerOf`, `eventsFor`, `snapshot`, `markClosed`, `closedIn`, `digestsFor`, `sweepRetention` all keep their exact signatures.

- [ ] **Step 1: Write the failing test**

Append to `poc/hub/test/hubStore.test.ts`:

```ts
import { migrate, openDb } from "../src/db.js";

function sharedDb() {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

describe("HubStore persistence", () => {
  it("keeps a session's whole log across a restart", () => {
    // Spec §8's bound, closed: "with v7b's in-memory hub log, a hub restart
    // still loses history."
    const db = sharedDb();
    const before = new HubStore({ db });
    before.attach("lap-1", "default", "github.com/acme/api");
    before.setFacts("lap-1", "auth", "run-a", facts());
    before.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);

    const after = new HubStore({ db });
    expect(after.eventsFor("default", "auth", 0).map((e) => e.id)).toEqual([1, 2, 3]);
    expect(after.snapshot("default").sessions[0].id).toBe("auth");
  });

  it("reports every session offline until its laptop reconnects", () => {
    // Live uplink state is by definition about right now. After a restart no
    // laptop is attached, and the honest first snapshot says so rather than
    // showing sessions as drivable.
    const db = sharedDb();
    const before = new HubStore({ db });
    before.attach("lap-1", "default", "k");
    before.setFacts("lap-1", "auth", "run-a", facts());
    expect(before.snapshot("default").sessions[0].presence).toBe("online");

    const after = new HubStore({ db });
    expect(after.snapshot("default").sessions[0].presence).toBe("offline");
  });

  it("keeps the (runId, seq) high-water mark, so a resume cannot duplicate the log", () => {
    // Without persisting this, the first reconnect after a restart would
    // re-append everything the laptop replays — permanently, in an
    // append-only log that every late joiner sees.
    const db = sharedDb();
    const before = new HubStore({ db });
    before.attach("lap-1", "default", "k");
    before.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);

    const after = new HubStore({ db });
    after.attach("lap-1", "default", "k");
    expect(after.resumeOffsets("lap-1")).toEqual({ auth: { runId: "run-a", lastSeq: 2 } });
    after.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(after.eventsFor("default", "auth", 0)).toHaveLength(3);
  });

  it("keeps a new run appending beside the old one after a restart", () => {
    const db = sharedDb();
    const before = new HubStore({ db });
    before.attach("lap-1", "default", "k");
    before.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);

    const after = new HubStore({ db });
    after.attach("lap-1", "default", "k");
    after.publish("lap-1", "auth", "run-b", [ev(0)]);
    expect(after.eventsFor("default", "auth", 0).map((e) => e.runId)).toEqual(["run-a", "run-a", "run-b"]);
  });

  it("keeps a closed session closed", () => {
    const db = sharedDb();
    const before = new HubStore({ db });
    before.attach("lap-1", "default", "k");
    before.setFacts("lap-1", "auth", "run-a", facts());
    before.markClosed("default", "auth");

    const after = new HubStore({ db });
    expect(after.closedIn("default")).toEqual(["auth"]);
  });

  it("keeps ownership, so a returning laptop reclaims its own sessions and a stranger cannot", () => {
    const db = sharedDb();
    const before = new HubStore({ db });
    before.attach("lap-1", "default", "k");
    before.setFacts("lap-1", "auth", "run-a", facts());

    const after = new HubStore({ db });
    after.attach("lap-1", "default", "k");
    after.attach("lap-2", "default", "k2");
    expect(after.setFacts("lap-1", "auth", "run-b", facts())).toEqual({ ok: true });
    expect(after.setFacts("lap-2", "auth", "run-z", facts()).ok).toBe(false);
  });

  it("deletes on retention rather than only forgetting", () => {
    const db = sharedDb();
    const store = new HubStore({ db });
    store.attach("lap-1", "default", "k");
    const day = 24 * 60 * 60 * 1000;
    const at = (ms: number, seq: number) =>
      ({ type: "intent_update", text: "x", seq, ts: new Date(ms).toISOString() }) as any;
    store.publish("lap-1", "auth", "run-a", [at(0, 0), at(day * 10, 1), at(day * 20, 2)]);
    store.sweepRetention(14, day * 20);

    const rows = db.prepare("SELECT count(*) c FROM events").get() as { c: number };
    expect(rows.c).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/hubStore.test.ts`
Expected: FAIL — the constructor rejects `db`, and a second store is empty.

- [ ] **Step 3: Write the implementation**

Replace `HubStore`'s `projects` map with SQL, keeping `uplinks` in memory — it is live connection state and deliberately does not persist.

Key points, each of which a test above pins:

- **Ids stay per-session.** `INSERT` computes `COALESCE(MAX(id), 0) + 1` scoped to `(project_id, session_id)`, so a browser's resume offset means the same thing before and after a restart. A global `AUTOINCREMENT` would make every session's ids depend on every other session's traffic.
- **`last_run_id` / `last_seq` live on the sessions row**, so the dedupe that stops a resuming laptop from duplicating the log survives the restart that most needs it.
- **`presence` is computed from `uplinks`, which is empty after a restart**, so everything reads `offline` until laptops reconnect. Do not persist it.
- **A session row survives without its uplink.** `setFacts`'s ownership check reads `uplink_id` from the row, so a returning `lap-1` reclaims `auth` and a `lap-2` still cannot take it.
- **`publish` returns only the newly accepted events**, exactly as before, because `fanOut` sends precisely those.

```ts
  publish(uplinkId: string, sessionId: string, runId: string, events: LoggedEvent[]): StoredEvent[] {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return [];
    const projectId = uplink.projectId;
    const row = this.sessionRow(projectId, sessionId);
    if (row && row.uplink_id !== uplinkId) return [];
    if (!row) this.insertSession(projectId, sessionId, uplinkId, emptyFacts(sessionId, uplink.repoKey));

    const accepted: StoredEvent[] = [];
    const insert = this.db.prepare(
      "INSERT INTO events (id, project_id, session_id, run_id, ts, body) VALUES ((SELECT COALESCE(MAX(id),0)+1 FROM events WHERE project_id=? AND session_id=?),?,?,?,?,?)",
    );
    let lastRunId = row?.last_run_id ?? null;
    let lastSeq = row?.last_seq ?? -1;
    for (const event of events) {
      const seq = typeof event.seq === "number" ? event.seq : -1;
      // Same run, already-seen seq → a resume overshoot, not new history.
      if (runId === lastRunId && seq <= lastSeq) continue;
      insert.run(projectId, sessionId, projectId, sessionId, runId, event.ts, JSON.stringify(event));
      const id = (this.db
        .prepare("SELECT MAX(id) m FROM events WHERE project_id=? AND session_id=?")
        .get(projectId, sessionId) as { m: number }).m;
      accepted.push({ id, runId, event });
      lastRunId = runId;
      lastSeq = seq;
    }
    if (accepted.length > 0) {
      this.db
        .prepare("UPDATE sessions SET last_run_id=?, last_seq=? WHERE project_id=? AND session_id=?")
        .run(lastRunId, lastSeq, projectId, sessionId);
    }
    return accepted;
  }
```

`eventsFor` becomes `SELECT * FROM events WHERE project_id=? AND session_id=? AND id>? ORDER BY id`, parsing `body` back into a `LoggedEvent`. `sweepRetention` becomes a `DELETE` that keeps the newest row per session and leaves unparseable timestamps alone:

```ts
  sweepRetention(days: number, now: number): number {
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    // The newest row per session is kept regardless: a session whose whole
    // history aged out would render as an empty transcript with no
    // explanation. An unparseable ts sorts unpredictably against an ISO
    // string, so `ts < cutoff` simply does not match it — which is the
    // degrade-don't-destroy behaviour the in-memory version had.
    const result = this.db
      .prepare(
        `DELETE FROM events
         WHERE ts < ?
           AND id <> (SELECT MAX(id) FROM events e2
                      WHERE e2.project_id = events.project_id AND e2.session_id = events.session_id)`,
      )
      .run(cutoff) as { changes?: number };
    return result.changes ?? 0;
  }
```

In `poc/hub/src/hub.ts`, open the database once and hand it to all three:

```ts
  // One file, one connection, three stores. Opened before anything else so a
  // migration failure stops the boot rather than surfacing on the first write.
  const db = opts.db ?? openDb(opts.dbPath ?? ":memory:");
  migrate(db);
```

`HubOptions` gains `dbPath?: string` and `db?: Db` (the latter for tests), and `close()` closes the database last, after the HTTP server.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **142 passed** (135 + 7). Every v7b1/v7b3 `HubStore` case unedited — with no `db` passed they get a private in-memory one and behave exactly as before.

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/hubStore.ts poc/hub/src/hub.ts poc/hub/test/hubStore.test.ts
git commit -m "feat(hub): persist the event log, session facts and ownership (v7c)"
```

---

### Task 5: Restart survival, end to end, and the ops surface

The unit tests above prove each store round-trips. This proves the hub does — with real sockets, over a real file — and gives the operator what they need to run it.

**Files:**
- Modify: `poc/hub/src/main.ts`, `poc/hub/src/hubConfig.ts`, `deploy/RUNBOOK.md`, `deploy/env.example`
- Test: `poc/hub/test/restart.test.ts`

**Interfaces:**
- Produces: `validateHubConfig` returns `dbPath` from `HUB_DB`; `HubOptions.dbPath` is wired from it.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/restart.test.ts`. It is the only test in the hub suite that touches the filesystem, and it cleans up after itself:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startHub } from "../src/hub.js";
import { RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

const authCfg = { clientId: "id", clientSecret: "s", sessionSecret: "testsecret", allowlist: "frankie" };
const cookieFor = (login: string) => `${SESSION_COOKIE}=${signSession(login, "testsecret")}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string | undefined;
afterEach(() => {
  // WAL leaves -wal and -shm siblings; removing the directory takes all three.
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tmpDb(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-hub-"));
  return path.join(dir, "hub.db");
}

const facts = (id: string) => ({
  id, participants: ["ana"], driverName: "ana", intent: "shipping auth", lastActivityTs: null,
  ended: false, pendingGate: null, skills: [], repoKey: "github.com/acme/api", lifecycle: "open",
});

describe("hub restart", () => {
  it("keeps a paired device, the host's settings and a session's transcript", async () => {
    const dbPath = tmpDb();

    // --- first boot ---
    const first = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg, hostLogin: "frankie", dbPath });

    const started: any = await (await fetch(`http://127.0.0.1:${first.port}/pair/start`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "frankie-macbook" }),
    })).json();
    await fetch(`http://127.0.0.1:${first.port}/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieFor("frankie") },
      body: JSON.stringify({ code: started.code }),
    });
    const approved: any = await (await fetch(`http://127.0.0.1:${first.port}/pair/poll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingId: started.pairingId }),
    })).json();

    await fetch(`http://127.0.0.1:${first.port}/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieFor("frankie") },
      body: JSON.stringify({ autoModeAllowed: false }),
    });

    const up = new WebSocket(`ws://127.0.0.1:${first.port}/uplink`, {
      headers: { authorization: `Bearer ${approved.token}` },
    });
    await new Promise<void>((r) => up.on("open", () => r()));
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "ignored", projectId: "default", repoKey: "github.com/acme/api" }));
    up.send(JSON.stringify({ t: "facts", sessionId: "auth", runId: "run-a", facts: facts("auth") }));
    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "before the restart", seq: 0, ts: new Date().toISOString() }],
    }));
    await wait(60);
    up.close();
    await first.close();

    // --- second boot, same file ---
    const second = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg, dbPath });
    try {
      // The setting survived, and HUB_HOST was NOT passed this time.
      const settings: any = await (await fetch(`http://127.0.0.1:${second.port}/settings`, {
        headers: { cookie: cookieFor("frankie") },
      })).json();
      expect(settings.host).toBe("frankie");
      expect(settings.autoModeAllowed).toBe(false);

      // The device is still paired — no re-pairing for the whole team.
      const up2 = new WebSocket(`ws://127.0.0.1:${second.port}/uplink`, {
        headers: { authorization: `Bearer ${approved.token}` },
      });
      const welcomed = new Promise<any>((r) => up2.on("message", (raw) => r(JSON.parse(raw.toString()))));
      await new Promise<void>((r) => up2.on("open", () => r()));
      up2.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "ignored", projectId: "default", repoKey: "github.com/acme/api" }));
      const welcome = await welcomed;
      expect(welcome.t).toBe("welcome");
      // And it is told exactly where to resume from, so it replays nothing.
      expect(welcome.have.auth).toEqual({ runId: "run-a", lastSeq: 0 });

      // The transcript is still there for a browser joining after the restart.
      const browser = new WebSocket(`ws://127.0.0.1:${second.port}/`, { headers: { cookie: cookieFor("frankie") } });
      const seen: any[] = [];
      browser.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
      await new Promise<void>((r) => browser.on("open", () => r()));
      browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "frankie", name: "frankie" }));
      await wait(80);
      expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["before the restart"]);

      browser.close();
      up2.close();
    } finally {
      await second.close();
    }
  });

  it("refuses to boot against a database from a newer build", async () => {
    // Rolling the hub back after a migration must fail at boot, loudly,
    // rather than corrupting rows the old build does not understand.
    const dbPath = tmpDb();
    const first = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg, dbPath });
    await first.close();

    const { openDb } = await import("../src/db.js");
    const raw = openDb(dbPath);
    raw.exec("PRAGMA user_version = 999");
    raw.close();

    await expect(startHub({ port: 0, host: "127.0.0.1", auth: authCfg, dbPath })).rejects.toThrow(/newer schema/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/restart.test.ts`
Expected: FAIL — `dbPath` is not an option, so the second boot starts empty.

- [ ] **Step 3: Wire the path and the boot**

In `poc/hub/src/hubConfig.ts`, return `dbPath: env.HUB_DB?.trim() || undefined`.

In `poc/hub/src/main.ts`:

```ts
const { port: actual } = await startHub({
  port,
  host,
  staticDir: config.staticDir,
  auth: config.auth,
  origin: config.origin,
  hostLogin: config.hostLogin,
  dbPath: config.dbPath,
});
```

```ts
if (!config.dbPath) {
  // Not fatal — a hub with no HUB_DB is a perfectly good development target —
  // but silently losing every pairing on restart would look like a bug.
  console.warn("HUB_DB not set — running with an IN-MEMORY database; every restart un-pairs every laptop");
} else {
  console.log(`state: ${config.dbPath}`);
}
```

- [ ] **Step 4: Write the ops documentation**

Add a hub section to `deploy/RUNBOOK.md` covering, as copy-paste blocks with expected output:

- The seven hub env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `GITHUB_ALLOWLIST`, `HUB_ORIGIN`, `HUB_HOST`, `HUB_DB`.
- **File placement and permissions.** `HUB_DB=/var/lib/multiplayer-ai/hub.db`, directory `0700` owned by the service user, and the reason stated plainly: **this file contains every relayed transcript and every device token hash.** It is the most sensitive thing on the box after the API key.
- **The `ExperimentalWarning`.** `node:sqlite` prints one on Node 22. Start the hub with `node --no-warnings=ExperimentalWarning dist/main.js` so it does not appear once per boot in the journal — and note *why* it is suppressed, so nobody later suppresses all warnings.
- **Backup, as one line the host runs**, not a scheduled feature: `sqlite3 /var/lib/multiplayer-ai/hub.db ".backup '/var/backups/hub-$(date +%F).db'"`. Safe against a live WAL database, which a plain `cp` is not.
- **Restoring** is stopping the unit, replacing the file, and starting it — laptops reconnect on their own.
- The systemd unit needs `ReadWritePaths=/var/lib/multiplayer-ai`.

Add the same variables to `deploy/env.example` with comments.

- [ ] **Step 5: Run everything**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run && npm run build`
Expected: **144 passed** (142 + 2), tsc clean, build clean.

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: **404 passed**, untouched — this plan does not change the laptop.

Run: `cd poc/client && npx tsc --noEmit && npx vitest run && npm run build`
Expected: **206 passed**, untouched.

- [ ] **Step 6: Confirm the test left nothing behind**

Run: `cd poc/hub && git status --short && ls /tmp | grep mpai-hub | head`
Expected: no untracked `*.db` in the repo, and no leftover temp directories.

- [ ] **Step 7: Commit**

```bash
git add poc/hub/src/main.ts poc/hub/src/hubConfig.ts poc/hub/test/restart.test.ts \
        deploy/RUNBOOK.md deploy/env.example
git commit -m "feat(hub): durable state across restarts, and the ops surface for it (v7c)"
```

---

## Verification before calling v7c done

```bash
cd poc/hub    && npx tsc --noEmit && npx vitest run && npm run build   # 144 passed
cd ../server  && npx tsc --noEmit && npx vitest run                    # 404 passed, untouched
cd ../client  && npx tsc --noEmit && npx vitest run && npm run build   # 206 passed, untouched
```

- [ ] All three suites green, all typechecks clean, builds clean.
- [ ] `git diff --stat main -- poc/server/src poc/client/src` is **empty**. Persistence is a hub concern; if either moved, the plan was not followed.
- [ ] Every pre-existing `DeviceStore`, `HostState` and `HubStore` test passes **unedited** — the optional `db` default is what makes that true, and it is the evidence that the public interfaces did not move.
- [ ] **The restart walk, by hand**, on a real file:
  1. Start the hub with `HUB_DB` set. Pair a laptop, run a turn, change a setting.
  2. `Ctrl-C` the hub. Restart it.
  3. The laptop reconnects **without re-pairing**, the setting is still set, and the transcript is still in the browser after a fresh join.
  4. `ls -l` the database: `0600`, owned by the service user, with `-wal` and `-shm` siblings.
  5. Take a backup with `sqlite3 .backup` while the hub is running, stop the hub, restore it, and confirm step 3 again.
- [ ] `grep -c "sk-ant" hub.db` — expect a match if oversight is configured, and confirm the RUNBOOK says so. **The key is stored in plaintext in this file**; the operator has to know that.

## Known bounds this plan ships with

- **The oversight API key is stored in plaintext** in the settings blob. Encrypting it would need a key to encrypt it with, on the same box, which moves the problem rather than solving it. The mitigation is file permissions and the RUNBOOK saying so plainly.
- **The database file holds every relayed transcript.** That follows directly from spec §8's disclosure that the hub sees everything relayed through it — persistence makes it durable rather than making it new. Retention is the only control, and it is per-hub, not per-session.
- **One connection, no pooling, synchronous writes.** Correct for a team-sized hub and consistent with how the rest of the hub works. A write-heavy hub would feel this on the event insert path; the seam to change is `db.ts`.
- **`PairingStore` still does not persist**, so a restart during a five-minute pairing window means starting that one pairing again. Deliberate.
- **No automated backups.** Task 5 documents the one-line command; scheduling it is the operator's call.
- **No audit log.** Still Reading B work, and still the first thing a real customer asks for.
- **Migrations are forward-only.** There is no down-migration and no rollback path other than restoring a backup, which is why the newer-schema check exists.

## Deviations

*Fill this in during execution. Every divergence from the listings above, with the reason.*
