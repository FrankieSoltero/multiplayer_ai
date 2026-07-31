# Operating a Hub (PRD §8.10, Branch B) Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd (or
> superpowers:subagent-driven-development). The Task Dependency Table below is
> the scheduling and review-depth contract. **Base: `feature/identity-and-access`
> (PR #29).** If PR #29 has merged, branch off `main` instead; if not, branch off
> the feature branch (stacked) and re-target after the merge.

**Goal:** a hub that can be exposed beyond a trusted network — validated
config with a fail-closed HOST check, backups and opt-in retention for the
now-unbounded journal, disk-headroom refusal instead of the crash-loop, rate
limiting and backpressure, an Origin check, and (unverifiable) deploy
artifacts.

**Architecture:** all operating controls hang off a validated `hubConfigFrom`
(extending Branch A's `hubEnv.ts`) that `main.ts` resolves before `startHub`;
`HubDb` gains retention/backup primitives (boot-time prune + hot `VACUUM INTO`);
`hub.ts` gains the runtime guards (headroom gate on publish, rate limits via a
new pure `limits.ts`, Origin check, backpressure close) at its existing choke
points (`send` at `hub.ts:217`, the `createServer` handler, `wss.on("connection")`
at `hub.ts:503`). Deploy artifacts land under `deploy/hub/` clearly marked
unverified (spec B4 — there is no box to verify against).

**Tech stack / test runner:** TypeScript, Node (`fs.statfsSync` available),
`ws`, `better-sqlite3`, vitest.
`cd poc/server && npx tsc --noEmit && npx vitest run` ·
`cd poc/hub && npx tsc --noEmit && npx vitest run` ·
`cd poc/client && npx tsc -b && npx vitest run`.
Hub checks need `poc/server` built first (`cd poc/server && npm run build`).
Suite baselines at branch base `268ab23`: server 748 · hub 266 · client 390.
Counts only grow; a task's Verify must show its NAMED new cases in run output —
use `npx vitest run --reporter=verbose` (the default reporter does not print
individual passing test names); exact totals are read from runs, never
predicted.

**Canonical boot order (all tasks agree on this, stated once):**
open/migrate → **backup** (Task 4, when configured) → **prune** (Task 3, when
retention set) → `load()` → serve. The backup precedes the prune so a
retention deletion is always recoverable when backups are configured;
retention WITHOUT backups configured is the operator's explicit double opt-in
to unrecoverable deletion (documented in env.example and the RUNBOOK).

**Plan-level done criterion:** all 9 task Verify lines pass on the final tree,
the HUB suite strictly above its 266 baseline, server and client suites green
at ≥ their baselines (no Branch B task touches those packages), every behavior
row covered by a test visible in a verbose run's output.

## Global Constraints

- Spec of record: `docs/specs/2026-07-31-identity-and-operating-design.md` §3
  (APPROVED; B1 retention is OPT-IN — unset means keep forever — per the
  user's recorded decision). Spec beats plan code.
- **The record is the product (§8.7):** nothing deletes event rows unless
  `HUB_RETENTION_DAYS` is explicitly set; when backups are configured they run
  BEFORE the prune in the same boot sequence (canonical boot order above), so
  every configured-backup deployment can recover pruned rows; retention with
  no backup dir is the operator's explicit choice to delete unrecoverably.
- **Out of scope (explicit, not silent):** `staticFiles.ts` security headers
  (spec §1 names the gap; §3 assigns it to no B-item — headers stay
  Caddyfile-only this branch; flagged to the owner as a possible ride-along).
- Refusal close codes: rate-limit/overload → **1013** reason `"rate limited"`
  (upgrade) / `"backpressure"` (stalled socket); protocol misuse (message
  flood, bad origin) → **1008**. 4401 stays credentials-only (Branch A).
- All new env vars validated in `hubConfigFrom` — a malformed value REFUSES
  BOOT with a named error; nothing silently defaults on a typo.
- Timers created by the hub (`backup`, headroom cache) are `unref()`d and
  cleared in `close()` — tests and shutdown must never hang on them.
- Standing gotchas: never `git add -A` (user WIP in tree); client typecheck is
  `npx tsc -b`; TDD per soltero-skills:lean-tdd; every guard gets a refusal
  test AND a pass-through test; injectable clocks/seams over real time/disk.

## Task Dependency Table

| Task | Files touched | Depends on | Risk tier |
|------|---------------|------------|-----------|
| 1. Validated hub config + HOST fail-closed (B6) | `poc/hub/src/hubEnv.ts`, `poc/hub/src/main.ts`, `poc/hub/test/hubEnv.test.ts` | — | standard |
| 2. defaultFatal flush (B5) | `poc/hub/src/hub.ts`, `poc/hub/test/hubBoot.test.ts` | — | mechanical |
| 3. Retention prune + id continuity (B1) | `poc/hub/src/hubDb.ts`, `poc/hub/src/hubStore.ts`, `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/hubDb.test.ts`, `poc/hub/test/operations.test.ts` (new) | 1, 2 | judgment |
| 4. Backup via VACUUM INTO (B1) | `poc/hub/src/hubDb.ts`, `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/hubDb.test.ts`, `poc/hub/test/operations.test.ts` | 3 | judgment |
| 5. Disk-headroom preflight (B1) | `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/operations.test.ts` | 4 | judgment |
| 6. Rate limits, caps, backpressure (B2) | `poc/hub/src/limits.ts` (new), `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/limits.test.ts` (new), `poc/hub/test/operations.test.ts` | 5 | judgment |
| 7. Origin check (B3) | `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/operations.test.ts` | 6 | standard |
| 8. Deploy artifacts (B4) | `deploy/hub/Caddyfile` (new), `deploy/hub/multiplayer-ai-hub.service` (new), `deploy/hub/env.example` (new), `deploy/hub/RUNBOOK.md` (new) | 1 (env names; operator sections are written from THIS PLAN's contracts — design-known, not from landed code — which is what makes it parallel-safe after 1) | standard |
| 9. Docs sweep: today-state | `docs/PRD.md`, `docs/tech-debt.md` | 1–8 | mechanical |

`poc/hub/src/hub.ts` is shared by tasks 2, 3, 4, 5, 6, 7 — SERIAL in that
order; `main.ts` is shared by 1, 3, 4, 5, 6, 7 (each task wires its own
`HubOptions` field through main.ts — inside the same serial chain, so no new
contention). Task 1 runs first or alongside task 2 (disjoint files). Task 8 is
parallel-safe any time after task 1 fixes the env-var names. Task 9 last.
`operations.test.ts` is created by task 3 and extended serially by 4–7.

---

## Task 1: Validated hub config + HOST fail-closed *(spec B6)*

**Files:**
- Modify: `poc/hub/src/hubEnv.ts`, `poc/hub/src/main.ts`
- Test: `poc/hub/test/hubEnv.test.ts`

**Interfaces:**
- Consumes: `hubAuthFrom(env)` (existing, `hubEnv.ts:31` — unchanged).
- Produces:
  - `export interface HubOpsConfig { port: number; host: string; origin: string | null; retentionDays: number | null; backup: { dir: string; intervalMs: number; keep: number } | null; minFreeBytes: number; trustProxy: boolean }`
  - `export function hubConfigFrom(env: NodeJS.ProcessEnv, auth: AuthConfig | undefined): { ok: true; config: HubOpsConfig } | { ok: false; error: string }`
  - `main.ts` calls `hubAuthFrom` then `hubConfigFrom` and passes the pieces
    into `startHub` (later tasks add the corresponding `HubOptions` fields —
    main.ts wiring for those lands with each task; this task wires `port`/`host`
    which already exist on `HubOptions`).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| defaults | no ops vars set, HOST unset, auth undefined | ok; port 4000, host "127.0.0.1", origin null, retentionDays null, backup null, minFreeBytes 104_857_600, trustProxy false |
| PORT typo | `PORT=41a2` | `{ ok: false, error: "PORT must be an integer between 1 and 65535 (got \"41a2\")" }` — closes the `Number()`→NaN→port-0 hole (`main.ts:15`) |
| PORT range | `PORT=0` or `70000` | same error shape |
| HOST fail-closed | `HOST=0.0.0.0` (or any non-loopback), auth undefined | `{ ok: false, error: "HOST=0.0.0.0 is not loopback and auth is not configured — refusing to boot; set the GITHUB_* auth vars or keep HOST on 127.0.0.1" }` |
| HOST + auth | non-loopback host, auth configured | ok |
| loopback set | `HOST` ∈ {"127.0.0.1", "::1", "localhost"} , auth undefined | ok — dev flow unchanged |
| origin | `HUB_ORIGIN=https://hub.example.com` | ok, `origin` carries the value verbatim; a value that does not parse as a URL with empty pathname-or-"/" (i.e. not a bare origin) → `{ ok:false, error: "HUB_ORIGIN must be a bare origin like https://hub.example.com (got ...)" }` |
| retention | `HUB_RETENTION_DAYS=30` | ok, retentionDays 30; `0`, negative, or non-integer → error naming the var; unset/empty → null (keep forever) |
| backup | `HUB_BACKUP_DIR=/var/backups/mpai` | ok, backup `{ dir, intervalMs: 86_400_000, keep: 7 }`; `HUB_BACKUP_INTERVAL_MS` (min 60_000) and `HUB_BACKUP_KEEP` (≥1 integer) override; either set WITHOUT `HUB_BACKUP_DIR` → error "HUB_BACKUP_INTERVAL_MS/HUB_BACKUP_KEEP require HUB_BACKUP_DIR" |
| headroom | `HUB_MIN_FREE_BYTES=52428800` | ok, 52_428_800; non-integer/negative → error |
| proxy | `HUB_TRUST_PROXY=1` | trustProxy true; unset/anything else → false |
| boot refusal | main.ts with any `{ok:false}` | process exits non-zero printing `config error: <error>` (same shape as the existing auth refusal, `main.ts:10`) |
| boot line | host fail-closed passed with auth on non-loopback | boot output unchanged plus one line per enabled/non-default control, exactly: `` `retention: ${days}d` `` / `` `backups: ${dir} every ${intervalMs}ms keep ${keep}` `` / `` `origin check: ${origin}` `` / `` `min free bytes: ${minFreeBytes}` `` (only when ≠ default) / `` `trusting proxy headers for client ip` `` (only when true) — nothing printed for disabled/default controls |

**Exact values:** loopback set = `"127.0.0.1" | "::1" | "localhost"`; defaults
`PORT=4000`, `minFreeBytes=104_857_600`, `intervalMs=86_400_000`, `keep=7`.
Env is always a parameter, never read inside (house rule, `hubEnv.ts:28-30`).

**Verify:** `cd poc/server && npm run build && cd ../hub && npx tsc --noEmit && npx vitest run` → green, hub suite strictly above 266; run output shows the PORT-typo, HOST-fail-closed, loopback-pass, and per-var validation cases
**Commit:** `feat(hub): validated ops config — PORT/HOST fail-closed, operating knobs (B6)`

## Task 2: defaultFatal flush *(spec B5)*

**Files:**
- Modify: `poc/hub/src/hub.ts`
- Test: `poc/hub/test/hubBoot.test.ts`

**Interfaces:**
- Produces: `export function fatalMessage(err: Error): string` — the exact
  string written; `defaultFatal` (`hub.ts:124-127`) becomes
  `fs.writeSync(2, fatalMessage(err))` then `process.exit(1)`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| with stack | Error with a stack | `fatalMessage` returns `` `hub fatal: ${err.stack}\n` `` |
| no stack | Error whose `stack` is undefined | `` `hub fatal: ${err.message}\n` `` |
| flush semantics | defaultFatal | uses `fs.writeSync(2, ...)` (synchronous — guaranteed flushed before `process.exit(1)`, closing tech-debt §2.8's diagnostic half); `console.error` no longer on this path |

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above task 1's count; run output shows both `fatalMessage` cases
**Commit:** `fix(hub): defaultFatal writes synchronously to stderr before exiting (B5)`

## Task 3: Retention prune + id continuity *(spec B1)*

**Files:**
- Modify: `poc/hub/src/hubDb.ts`, `poc/hub/src/hubStore.ts`, `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`
- Test: `poc/hub/test/hubDb.test.ts`, create `poc/hub/test/operations.test.ts`

**Interfaces:**
- Consumes: `HubOpsConfig.retentionDays` (Task 1).
- Produces:
  - `HubDb.pruneEventsBefore(cutoffIso: string): number` — deletes event rows
    older than the cutoff, returns rows deleted.
  - `HubOptions` gains `retentionDays?: number` (plus `now?: () => number`
    test seam if not already present); `startHub` runs the prune ONCE at boot,
    after open/migration, BEFORE `db.load()`.
  - `main.ts` passes `config.retentionDays`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| opt-in only | `retentionDays` undefined/null | NO delete ever runs — keep forever (the user's recorded B1 decision) |
| prune | rows with `json_extract(event_json,'$.ts') < cutoffIso` | deleted; newer rows untouched; cutoff = `new Date(now() - days*86_400_000).toISOString()` |
| malformed ts | event_json without a `ts`, or non-string | row KEPT (json_extract → NULL compares false) — fail-safe toward retention |
| boot order | canonical boot order (header): open/migrate → backup → **prune** → `load()` | memory hydrates from the already-pruned record — memory and record never diverge (no mid-run pruning; a long-running hub prunes at next restart); when Task 4's backup is configured it has ALREADY run, so pruned rows are recoverable from it |
| **id continuity (THE TRAP)** | session had events ids 1..100; retention pruned 1..50; a new publish arrives | new event gets id **101**, NOT 51 — `HubStore.publish` currently derives `nextId` from `events.length + 1` (`hubStore.ts:489`), which after a prune COLLIDES with surviving rows' PRIMARY KEY (project_id, session_id, id) → the persister throws → `fatal` → crash-loop. Fix: `HubSession` gains `nextEventId`, seeded at hydration from the max stored id + 1 (`HubHydration` sessions carry their events — derive there), `1` for fresh sessions, incremented per accepted event; `publish` uses it |
| replay after prune | browser joins a pruned session | `eventsFor(..., 0)` returns only surviving events; no error |
| resume protocol | laptop reconnects after prune | `resumeOffsets` unchanged (keyed on lastRunId/lastSeq, not event ids) — no re-send storm |
| boot log | retention enabled, prune ran | one line IN ADDITION to Task 1's config-announce line: `` `retention: pruned ${n} event row(s) older than ${days}d` `` (0 rows still prints) |

**Exact values:** delete statement operates on `events` only — `sessions`
rows (facts, last_run_id, last_seq) are never touched by retention.
`PRAGMA journal_size_limit = 67108864` added at open — bundled here
deliberately: the pragma and the prune are the two halves of the same B1
unbounded-journal blast radius (WAL growth between checkpoints; main-file
growth over time), and both land in `hubDb.ts`'s open path.

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above task 2's count; run output shows the opt-in-off case, the prune case, the malformed-ts keep, and the id-continuity case (publish after prune, no PK violation)
**Commit:** `feat(hub): opt-in retention — boot-time prune with id continuity (B1)`

## Task 4: Backup via VACUUM INTO *(spec B1)*

**Files:**
- Modify: `poc/hub/src/hubDb.ts`, `poc/hub/src/hub.ts`, `poc/hub/src/main.ts` (wire `config.backup` through)
- Test: `poc/hub/test/hubDb.test.ts`, `poc/hub/test/operations.test.ts`

**Interfaces:**
- Consumes: `HubOpsConfig.backup` (Task 1); boot ordering from Task 3.
- Produces:
  - `HubDb.backupTo(destPath: string): void` — `VACUUM INTO ?` on the live
    handle (atomic, hot-safe, single self-contained output file — sidesteps
    the `.db`/`-wal`/`-shm` trio-copy hazard, spec §8a ruling 7); throws if
    dest exists (SQLite's own behavior — surfaced, not swallowed).
  - `HubOptions` gains `backup?: { dir: string; intervalMs: number; keep: number }`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| opt-in only | `backup` undefined | no backup, no timer, no dir created |
| boot backup | backup configured, file-backed db | dir created (mode 0700) if missing; one backup taken at boot per the canonical order — AFTER open/migration, **BEFORE the retention prune** (so a prune's deletions are always recoverable from this backup), before `load()`; file mode 0600 |
| filename | injectable `now()` | `` `hub-${YYYYMMDD}-${HHmmss}Z.db` `` (UTC, from `now()`) |
| interval | timer every `intervalMs` | subsequent backups on the live handle (hot — no lock conflict with concurrent publishes; assert a publish during/after backup still lands); timer `unref()`d and cleared in `close()` |
| keep-N | more than `keep` files matching `hub-*.db` in dir | oldest (by filename sort) deleted until `keep` remain — only files matching the exact pattern are ever deleted |
| dest exists | same-second double boot / name collision | that backup attempt SKIPPED with one `console.error` naming the path; hub keeps serving (backup failure is never fatal — the record is still live) |
| backup fails | dir unwritable | same: log once per attempt, never `fatal` |
| in-memory | `:memory:` db or no db | backup silently disabled even if configured (nothing durable to back up) — one boot line saying so |
| restore story | (docs row) | `deploy/hub/RUNBOOK.md` (Task 8) documents: stop hub, replace `hub.db` with the backup file, delete `-wal`/`-shm` leftovers, start |

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above task 3's count; run output shows the boot-backup, keep-N prune, dest-exists skip, hot-backup-during-publish, and opt-in-off cases
**Commit:** `feat(hub): backups — hot VACUUM INTO, keep-N, never fatal (B1)`

## Task 5: Disk-headroom preflight *(spec B1)*

**Files:**
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/main.ts` (wire `config.minFreeBytes` through)
- Test: `poc/hub/test/operations.test.ts`

**Interfaces:**
- Consumes: `HubOpsConfig.minFreeBytes` (Task 1).
- Produces: `HubOptions` gains `minFreeBytes?: number` and the test seam
  `freeBytes?: (dir: string) => number` (default implementation:
  `fs.statfsSync(dir)` → `bsize * bavail`; dir = dirname of the db path;
  in-memory/no-db hubs never check).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| boot refusal | file-backed db, free < minFreeBytes at boot | `startHub` rejects with `` `insufficient disk headroom: ${free} bytes free at ${dir}, floor is ${minFreeBytes} — free space or lower HUB_MIN_FREE_BYTES` `` — the loud refusal that replaces the disk-full crash-loop (`hub.ts:98-122`'s documented blast radius) |
| runtime gate | free drops below floor while running | `publish` frames are REFUSED before `store.publish`: nothing written, nothing fanned out, no error frame to the browser; ONE `console.error` on entering the low state (and one on recovery) — not per frame |
| recovery | free rises above floor | publishes resume; the resume protocol back-fills (laptop's next reconnect replays from the hub's high-water mark, which never advanced past the dropped frames) |
| check cadence | many publishes | `freeBytes` consulted at most once per 10_000ms (cached verdict between) — no per-frame syscall storm |
| scope bound | facts/attach/membership writes while low | still applied (small, bounded; the floor defends against the unbounded journal, and refusing identity/membership writes would break the UI for no headroom gain) — stated in a code comment |
| default off-path | in-memory db | no checks, no boot refusal |

**Exact values:** `HEADROOM_CHECK_INTERVAL_MS = 10_000` (module const).

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above task 4's count; run output shows the boot-refusal, runtime-drop (with log-once), recovery, and cadence cases (all via the `freeBytes` seam)
**Commit:** `feat(hub): disk-headroom preflight — refuse loudly instead of crash-looping (B1)`

## Task 6: Rate limits, caps, backpressure *(spec B2)*

**Files:**
- Create: `poc/hub/src/limits.ts`, `poc/hub/test/limits.test.ts`
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/main.ts` (wire `config.trustProxy` through)
- Test: `poc/hub/test/operations.test.ts`

**Interfaces:**
- Consumes: `HubOpsConfig.trustProxy` (Task 1).
- Produces (`limits.ts`, pure, injectable clock):
  - `export class TokenBucket { constructor(capacity: number, refillPerMs: number, now?: () => number); take(key: string): boolean }` — per-key bucket map with lazy refill; eviction is INLINE in `take()`: when the map exceeds 10_000 keys, entries whose bucket is back at full capacity are dropped during that call (no separate prune method, no timer).
  - `export function clientIp(remoteAddress: string | undefined, xForwardedFor: string | undefined, trustProxy: boolean): string` — trustProxy true → first comma-separated XFF entry trimmed (fallback remoteAddress); else remoteAddress; undefined → `"unknown"`.
  - Exported constants (exact): `MAX_SOCKETS = 512`, `UPGRADES_PER_MIN_PER_IP = 30`, `HTTP_AUTH_PER_MIN_PER_IP = 30`, `MSGS_PER_WINDOW = 200`, `MSG_WINDOW_MS = 10_000`, `BUFFERED_MAX_BYTES = 4_000_000`.
- `HubOptions` gains `trustProxy?: boolean` (and reuses `now?`).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| socket cap | connection #513 (browser or uplink) | closed **1013** `"rate limited"` immediately at `wss.on("connection")`, before any dispatch; count decremented on every close |
| upgrade rate | 31st WS connection from one IP within a minute | closed 1013 `"rate limited"`; other IPs unaffected |
| HTTP rate | 31st request to `/auth/*` or `/pair/*` from one IP within a minute | **429** `{"error":"rate limited"}` — checked in the `createServer` handler BEFORE `handleAuth`/pairing routes; `/healthz` and static NEVER rate-limited |
| msg flood (browser) | a browser socket's 201st message inside 10s | closed **1008** `"message rate exceeded"` |
| uplink exempt | an uplink replays a large backlog fast | NO message-rate close — uplinks are authenticated (Branch A) and chunked by `MAX_FRAME_BYTES`; a comment states this exemption and why |
| backpressure | `socket.bufferedAmount > BUFFERED_MAX_BYTES` at `send` (`hub.ts:217`) | socket closed **1013** `"backpressure"` instead of buffering further — a reconnect replays; applies to browsers AND uplinks |
| ip derivation | trustProxy false + XFF present | XFF ignored (an untrusted client must not choose its own bucket) |
| pass-through | traffic under every limit | byte-for-byte today's behavior; all existing tests green |

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above task 5's count; run output shows every row above (bucket unit tests in limits.test.ts with a fake clock; wiring tests in operations.test.ts with real sockets)
**Commit:** `feat(hub): rate limits, connection caps, backpressure (B2)`

## Task 7: Origin check *(spec B3)*

**Files:**
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/main.ts` (wire `config.origin` through)
- Test: `poc/hub/test/operations.test.ts`

**Interfaces:**
- Consumes: `HubOpsConfig.origin` (Task 1). `HubOptions` gains `origin?: string`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| mismatch | `origin` configured; WS upgrade with `Origin` header ≠ the configured value | closed **1008** `"origin not allowed"` at `wss.on("connection")`, before uplink/browser dispatch (after the Task 6 caps — cheapest checks first) |
| match | Origin header equals the configured value exactly (string compare) | admitted |
| no header | connection without an Origin header (uplinks, CLI clients, non-browser tools) | admitted — the check defends against cross-site browser hijacking; non-browsers can forge anything, so refusing them buys nothing and breaks every uplink (comment states this) |
| unset | `origin` null | no check — today's behavior, all existing tests green |

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above task 6's count; run output shows mismatch/match/no-header/unset
**Commit:** `feat(hub): Origin check on the WS upgrade (B3)`

## Task 8: Deploy artifacts *(spec B4 — UNVERIFIED, disclosed)*

**Files:**
- Create: `deploy/hub/Caddyfile`, `deploy/hub/multiplayer-ai-hub.service`, `deploy/hub/env.example`, `deploy/hub/RUNBOOK.md`

**Interfaces:**
- Consumes: Task 1's env-var names (exact); the hub's build story
  (`poc/hub/package.json`: `npm run build` → `tsc -p tsconfig.build.json`,
  so the unit runs `node dist/main.js` — mirror `deploy/multiplayer-ai.service`'s
  conventions for user/dirs/hardening).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| header | every one of the four files | first line: `# NOT YET VERIFIED against a real box — written for §8.10 (B4); verify before first use.` (RUNBOOK.md uses a bold paragraph instead of `#` comment) — the spec's honest can't-verify disclosure; never claimed deployable |
| Caddyfile | reverse proxy | site block keyed on the placeholder `hub.example.com  # ← replace with your hub's hostname` → `127.0.0.1:4000`, WebSocket-aware, security headers mirroring the existing `deploy/Caddyfile`'s set |
| service | systemd unit | `EnvironmentFile=/etc/multiplayer-ai/hub.env`, `ExecStart` on `node dist/main.js` from the hub dir, `User=mpai` `Group=mpai`, `Restart=on-failure`, and exactly these hardening directives: `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `ReadWritePaths=` for the MPAI_HOME and backup dirs |
| env.example | all hub vars, each with a one-line comment | `HOST`, `PORT`, `CLIENT_DIST`, `HUB_DB`/`MPAI_HOME`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `GITHUB_ALLOWLIST`, `OAUTH_CALLBACK_URL`, `HUB_ORIGIN`, `HUB_RETENTION_DAYS`, `HUB_BACKUP_DIR`, `HUB_BACKUP_INTERVAL_MS`, `HUB_BACKUP_KEEP`, `HUB_MIN_FREE_BYTES`, `HUB_TRUST_PROXY` — names character-for-character from Task 1; secrets left blank; "never commit a filled-in copy" note like `deploy/env.example:3` |
| RUNBOOK | operator procedures | sections: install, pairing a laptop (Branch A flow), backup/restore (the Task 4 restore story: stop → replace `hub.db` → delete `-wal`/`-shm` → start), disk-full recovery (now: loud boot refusal + the §8a ruling 7 order), revoking a device, upgrading (back-up-before-upgrade; newer-schema refusal is the designed fail-stop) |

**Verify:** `command grep -l "NOT YET VERIFIED" deploy/hub/* | wc -l` → 4; `command grep -c "HUB_" deploy/hub/env.example` → ≥ 7; hub suite unchanged-green (`cd poc/hub && npx vitest run`)
**Commit:** `docs(deploy): hub deploy artifacts — Caddyfile, unit, env, runbook (B4, unverified)`

## Task 9: Docs sweep — today-state *(PRD §8.10 Today; tech-debt §2.8)*

**Files:** Modify: `docs/PRD.md` (§8.10 *Today* block), `docs/tech-debt.md` (§2.8)

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| PRD §8.10 Today | describes pre-Branch-B state | rewritten: config validated + HOST fail-closed, opt-in retention + hot backups + headroom refusal, rate limits/caps/backpressure, Origin check, deploy artifacts present but explicitly UNVERIFIED (no box); D12's exposure gate satisfied at the code level — real-box verification remains the open item |
| tech-debt §2.8 | unbounded journal / undiagnosable crash-loop | updated: diagnostic half closed (B5 sync stderr), crash-loop replaced by loud refusal (B1c), journal bounded only when retention opted in — the keep-forever default is a deliberate product stance, not debt |
| new debt | anything discovered during the branch | recorded with file:line |

**Verify:** `command grep -q "UNVERIFIED" docs/PRD.md && command grep -q "loud" docs/tech-debt.md` (content actually changed — adjust the second grep to the exact §2.8 wording written) AND all three suites green (server ≥748, hub > task-7 count, client ≥390) — full commands per the header
**Commit:** `docs: §8.10 shipped at code level — today-state sweep (deploy artifacts unverified)`
