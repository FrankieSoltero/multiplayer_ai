# The Record (PRD §8.7) Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd (or
> superpowers:subagent-driven-development). The Task Dependency Table below is
> the scheduling and review-depth contract. Spec of record:
> `docs/specs/2026-07-29-the-record-design.md` (including its §8a owner rulings 1–8) — where
> this plan is silent or wrong and the spec is explicit, the spec governs (standing ruling).

**Goal:** the hub survives a restart with nothing lost, and every project answers "who drove what,
what changed, what was approved and by whom" from a durable, deterministically derived record.

**Architecture:** a write-through SQLite journal (`better-sqlite3`, WAL, single-writer PID lock)
behind a `HubPersister` interface injected into the existing in-memory `HubStore` (no-op default
keeps every existing test untouched), with boot-time hydration; on top, a pure
`projectRecordFrom()` module in the server package (the `arcadeRecordsFrom` reuse pattern) exposed
via one `get_record`/`record` protocol pair on both hub and standalone server, rendered by a
RECORD panel on the project screen.

**Tech stack / test runner:** TypeScript ESM, vitest. `cd poc/server && npx vitest run` ·
`cd poc/hub && npx vitest run` (pretest builds server) · `cd poc/client && npx vitest run`.
Typecheck: server/hub `npx tsc --noEmit`; client **`npx tsc -b`** (`--noEmit` is a NO-OP there).

## Global Constraints

- Rebuild `poc/server` (`npm --prefix poc/server run build`) after changing anything it exports —
  hub and client typecheck against its built `dist/`.
- TDD is the implementer's standing discipline (soltero-skills:lean-tdd). Every new test must be
  shown to fail on the pre-task code (revert-and-rerun). Never predict suite totals.
- Never `git add -A`; stage explicit paths and verify each commit with
  `git diff-tree --no-commit-id --name-only -r HEAD`. The tree contains user WIP
  (`poc/client/src/game/tetris.test.ts` modified) and untracked user files — never stage them.
- `SLUG = /^[a-z0-9-]{1,40}$/` — every projectId/sessionId reaching a store is shape-validated at
  the point of use.
- Browser-facing error shape everywhere: `{ type: "error", message: string }`.
- Hub↔standalone `get_record` parity means: identical payload validation, identical error
  strings, and shape-identical `record` replies. Auth gating differs by design (owner ruling,
  spec §8a.1): hub requires `identify` (Task 9); standalone uses `denyUnauthed()` like its
  `watch_project` (server.ts:948, Task 10). The asymmetry is deliberate and recorded — not a
  parity bug; v7b2's real auth must sweep `get_record` together with `watch_project`/`join`.
- Durability invariant (spec §3.3): **durable before visible** — an event is committed to SQLite
  before any browser can see it, in ONE transaction per publish frame (including an
  implicitly-created session's row); a persister failure fail-stops the hub (spec §3.6, Task 7),
  never catch-and-carry-on.
- **At-rest posture (spec §8a ruling 7):** the DB is an unencrypted local file
  holding prompts, userIds and file paths, in a `0700` home dotdir, with no retention or backup
  mechanism until §8.10 — a corrupt `hub.db` therefore loses the record to that point unless the
  operator kept copies. Acceptable for the v7b1 trusted-network hub; revisit with v7b2 auth /
  §8.10.
- **Record exposure (recorded decision, not an omission):** the `record` payload surfaces
  prompts (capped at PROMPT_CAP), userIds, changed-file paths and per-user approval/denial
  tallies for ANY valid projectId to ANY channel that has sent `identify` — and identity is
  self-asserted in v7b1, so on the trusted-network hub any network client can read every
  project's record. Accepted for v7b1 (spec §8a.1); v7b2's real auth must sweep `get_record`
  together with `watch_project`/`join`.
- `HubStore.publish`/`eventsFor` results stay allocation-light; the record path is request/reply
  and MAY copy.
- New deps (poc/hub only): `"better-sqlite3": "^13.0.2"`, devDep `"@types/better-sqlite3": "^7.6.13"`.

**Done criteria (plan-level):** every per-task Verify has passed and, on the final tree,
`cd poc/server && npx tsc --noEmit && npx vitest run`, `cd poc/hub && npx tsc --noEmit && npx
vitest run`, and `cd poc/client && npx tsc -b && npx vitest run` are all green, plus Task 13's
browser-walk record (with contrast ratios and both-mode observations) exists in the execution
ledger.

## Task Dependency Table

| Task | Files touched | Depends on | Conflicts with (no concurrency) | Risk tier |
|------|---------------|------------|---------------------------------|-----------|
| 1. record derivation module | `poc/server/src/record.ts`, `poc/server/test/record.test.ts`, `poc/server/package.json` | — | — | standard |
| 2. HubStore persister seam | `poc/hub/src/hubStore.ts`, `poc/hub/test/hubStore.test.ts` | — | 5, 6 | judgment |
| 3. HubStore hydration | `poc/hub/src/hubStore.ts`, `poc/hub/test/hubStore.test.ts`, `poc/hub/test/helpers/hydrationCapture.ts` | 2 | 5, 6 | standard |
| 4. HubDb (SQLite + lock) | `poc/hub/src/hubDb.ts`, `poc/hub/test/hubDb.test.ts`, `poc/hub/package.json`, `poc/hub/package-lock.json` | 2, 3 | 5, 9 | standard |
| 5. uplink test-harness extraction | `poc/hub/test/helpers/uplinkHarness.ts`, `poc/hub/test/relayIntegration.test.ts` | — | 2, 3, 4, 6, 7, 9 | mechanical |
| 6. boot-config helpers | `poc/hub/src/bootConfig.ts`, `poc/hub/test/bootConfig.test.ts` | — | 2, 3, 5, 9 | standard |
| 7. startHub wiring + fail-stop | `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/hubBoot.test.ts` | 3, 4, 6 | 5, 9 | judgment |
| 8. restart continuity integration | `poc/hub/test/hubRestart.test.ts` | 5, 7 | 9 | judgment |
| 9. hub `get_record` | `poc/hub/src/hub.ts`, `poc/hub/src/hubStore.ts`, `poc/hub/test/routing.test.ts`, `poc/hub/test/hubStore.test.ts` | 1, 3 | 4, 5, 6, 7, 8 | standard |
| 10. standalone `get_record` parity | `poc/server/src/server.ts`, `poc/server/test/serverRecord.test.ts` | 1 | — | standard |
| 11. record view-model | `poc/client/src/recordView.ts`, `poc/client/src/recordView.test.ts` | 1 | — | standard |
| 12. RECORD panel | `poc/client/src/components/RecordPanel.tsx`, `poc/client/src/components/RecordPanel.test.tsx`, `poc/client/src/components/SessionPicker.tsx` | 9, 10, 11 | — | standard |
| 13. browser walk | (no source files — execution-ledger record only) | 7, 10, 12 | — | standard |
| 14. docs sweep | `docs/PRD.md`, `docs/tech-debt.md` | 1–13 | — | mechanical |

The table alone is the scheduling contract: a task may start when its Depends-on tasks are
complete AND no task in its Conflicts-with column is in flight (implementation OR verification —
a whole-package suite run counts as in flight). Conflicts are symmetric and listed on BOTH rows.
Two sources feed the column: shared-file writes (9 vs 2/3/7 on `hub.ts`/`hubStore.ts`) and
whole-package-suite Verify steps (Tasks 2, 3, 5, 7, 8, 9 run the whole hub suite; a concurrent
writer in `poc/hub` would flake them — either serialize per the column or don't start the verify
until the other writer lands).

Concurrency notes (commentary only — the table governs): Task 1 and the client-side tasks
(11, 12) are disjoint from everything hub-side. Task 3 follows 2 on the same files. Task 8
touches only its own new test file. Task 10's Verify runs the whole server suite, but its only
same-package sibling (Task 1) is already in its Depends-on. Task 13 is a pure verification
task: it launches Task 7's hub wiring (`HUB_DB`, `dist/main.js`) end-to-end, its step 7 runs
`mpai` with no `--hub` and exercises Task 10's standalone handler directly (not only through
Task 12's panel), and its panel steps need Task 12 — that is why 7, 10 AND 12 are in its
Depends-on.

---

## Task 1: Record derivation module *(spec §4.1–4.2, §8a.4, §8a.8)*

**Files:**
- Create: `poc/server/src/record.ts`
- Test: `poc/server/test/record.test.ts`
- Modify: `poc/server/package.json` (add `"./record"` to `exports`, same shape as `"./events"`)

**Interfaces:**
- Consumes: `SessionFacts` from `./relayProtocol.js`; `LoggedEvent` from `./events.js`.
- Produces (verbatim — later tasks depend on these names character-for-character).
  `permission_request.requestId` is consumed only as the join key to resolve `toolName` and is
  NOT surfaced in `TurnApproval` — ratified drop, spec §8a ruling 4:

```ts
export interface RecordSessionInput {
  facts: SessionFacts;
  machineId: string | null;
  events: LoggedEvent[];
}
export interface TurnApproval {
  kind: "permission" | "plan";
  decision: "allow" | "deny" | "approve" | "reject";
  userId: string;
  toolName: string | null;
  auto: boolean;
}
export interface TurnRecord {
  turn: number;                 // 1-based within its session
  driver: string | null;
  prompt: string | null;        // first user_message text, sliced to PROMPT_CAP
  startTs: string;              // ts of the turn's first event
  endTs: string;                // ts of the turn's last event
  inProgress: boolean;
  toolCounts: Record<string, number>;
  filesChanged: string[];
  approvals: TurnApproval[];
  errors: number;               // count of agent_error
}
export interface SessionRecord {
  sessionId: string;
  machineId: string | null;
  repoKey: string | null;
  lifecycle: SessionFacts["lifecycle"];
  intent: string | null;
  closedBy: string | null;
  turns: TurnRecord[];
}
export interface UserRollup {
  userId: string;
  turnsDriven: number;
  approvalsGiven: number;
  denialsGiven: number;
}
export interface ProjectRecord {
  projectId: string;
  sessions: SessionRecord[];
  rollup: { perUser: UserRollup[]; totalTurns: number; totalSessions: number };
}
export const PROMPT_CAP = 200;
export function projectRecordFrom(projectId: string, sessions: RecordSessionInput[]): ProjectRecord;
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| segmentation | events …, `turn_end`, …, `turn_end` | one turn per group; each group runs from the event after the previous `turn_end` up to AND INCLUDING its `turn_end`; `inProgress: false` |
| trailing open turn | events after the last `turn_end` (or a session with events and no `turn_end` at all) | one final turn, `inProgress: true` |
| empty session | `events: []` | session appears with `turns: []` |
| consecutive turn_ends | `turn_end` immediately after `turn_end` | second group is a 1-event turn (its `turn_end`) |
| driver — user message | the turn's first event is a `user_message` | driver = that message's `userId` (spec §4.1: the turn's OPENING `user_message` — a `user_message` arriving mid-turn does not set the driver) |
| driver — controller fallback | the turn does not open on a `user_message`; a `control_change` occurred in an earlier turn | driver = most recent `control_change.userId` strictly before the turn's first event (spec §4.1 "at that point") |
| driver — in-turn control_change does not count | turn = [`control_change` (u5), `tool_call`], no `control_change` before the turn's first event | driver = null — a `control_change` inside the turn never sets that turn's own driver (it feeds LATER turns' fallback) |
| driver — none | turn does not open on a `user_message`, no prior `control_change` | driver = null |
| prompt | first `user_message` text of 500 chars | `prompt` = first 200 chars (`.slice(0, PROMPT_CAP)`); no user_message → null |
| toolCounts | 3× `tool_call` Edit, 1× `tool_call` Bash in a turn | `{ Edit: 3, Bash: 1 }` |
| filesChanged | `tool_call` with `toolName` ∈ {"Edit","Write","NotebookEdit"} and `input` an object whose `file_path` is a string | file_path collected; deduped, first-occurrence order; non-object input / missing / non-string `file_path` skipped silently; other toolNames never contribute |
| approvals — permission | `permission_request {requestId r1, toolName "Bash"}` … `permission_decision {requestId r1, decision "allow", userId u1}` | `{kind:"permission", decision:"allow", userId:"u1", toolName:"Bash", auto:false}` in the turn holding the DECISION |
| approvals — unmatched requestId | `permission_decision` with no earlier matching `permission_request` in this session | included with `toolName: null` |
| approvals — auto | `permission_decision` with `auto: true` | included with `auto: true` |
| approvals — plan | `plan_decision {decision "approve", userId u2}` | `{kind:"plan", decision:"approve", userId:"u2", toolName:null, auto:false}` |
| errors | 2× `agent_error` in a turn | `errors: 2` |
| closedBy | session contains `session_closed {userId u3}` | `closedBy: "u3"` (last one wins); none → null |
| session fields | input facts | `repoKey`/`lifecycle`/`intent` copied from `facts`; `machineId` from input |
| session order | inputs in any order | `sessions` sorted by `sessionId` ascending |
| rollup turnsDriven | u1 drives 3 turns across 2 sessions | perUser row `{userId:"u1", turnsDriven:3, …}` |
| rollup approvals | decisions: allow×2 (u1), deny×1 (u1), approve×1 (u2), one allow with `auto:true` | u1 `{approvalsGiven:2, denialsGiven:1}`; u2 `{approvalsGiven:1}`; the `auto` decision counts for NOBODY (spec §8a ruling 8) |
| rollup membership | a user appears only as an approver | still gets a perUser row (`turnsDriven: 0`) |
| rollup order | ties and non-ties | perUser sorted `turnsDriven` desc, then `userId` asc |
| totals | 2 sessions, 5 turns total | `rollup.totalTurns: 5`, `totalSessions: 2` |
| purity | same input twice | deep-equal output; input arrays/objects not mutated |

**Exact values:** `PROMPT_CAP = 200`; export path `multiplayer-ai-server/record`.

**Verify:** `cd poc/server && npx tsc --noEmit && npx vitest run test/record.test.ts` → green;
`npm run build` succeeds (dist gains `record.js`/`record.d.ts`).
**Commit:** `feat(server): pure project-record derivation from the event log`

---

## Task 2: HubStore persister seam *(spec §3.3)*

**Files:**
- Modify: `poc/hub/src/hubStore.ts`
- Test: `poc/hub/test/hubStore.test.ts` (extend)

**Interfaces:**
- Consumes: existing `HubStore` internals (this task owns the file); `RepoDecl`, `SessionFacts`
  from `multiplayer-ai-server/relayProtocol`; `StoredEvent` (already local).
- Produces (verbatim):

```ts
export interface HubPersister {
  projectSaved(p: { id: string; name: string; createdBy: string | null; createdAt: string; lifecycle: ProjectLifecycle }): void;
  memberAdded(projectId: string, userId: string): void;
  memberRemoved(projectId: string, userId: string): void;
  machineSaved(m: { uplinkId: string; projectId: string; name: string; repos: RepoDecl[] }): void;
  sessionSaved(s: { projectId: string; sessionId: string; uplinkId: string; facts: SessionFacts; lastRunId: string | null; lastSeq: number }): void;
  eventsAppended(
    projectId: string,
    sessionId: string,
    events: StoredEvent[],
    lastRunId: string,
    lastSeq: number,
    newSession?: { uplinkId: string; facts: SessionFacts },
  ): void;
  // `newSession` is set exactly when this publish frame implicitly created the
  // session — the persister must write the session row AND the events in ONE
  // transaction (spec §3.3, one transaction per frame).
}
// constructor signature change (backward-compatible — new HubStore() still works;
// the hydration parameter arrives in Task 3):
constructor(persister?: HubPersister)
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| no-op default | `new HubStore()` | every existing test passes unchanged; no persister calls anywhere |
| createProject ok | fresh id | `projectSaved(record)` then `memberAdded(id, createdBy)`; duplicate id → NO persister call |
| ensureProject new | unknown id | `projectSaved` with `createdBy: null`; known id → no call |
| setLifecycle ok | known id | `projectSaved` with the updated lifecycle; unknown id → no call |
| join/leaveProject | returns true | `memberAdded`/`memberRemoved`; returns false → no call |
| attach | any | `machineSaved` (and `projectSaved` via ensureProject if the project is new) |
| setRepos | known uplink | `machineSaved` with the replaced list; unknown uplink → no call |
| setFacts ok | new or existing owned session | `sessionSaved` with current facts + lastRunId/lastSeq; ownership refusal → no call |
| publish accepted, existing session | ≥1 accepted event | ONE `eventsAppended(projectId, sessionId, accepted, runId, lastSeqAfter)` with `newSession` undefined; zero accepted → no call |
| publish accepted, implicit session | publish creates the session | ONE `eventsAppended(…, newSession: { uplinkId, facts: emptyFacts })` — never a separate `sessionSaved` for this frame |
| durable before applied | persister.eventsAppended throws | exception propagates out of `publish`; store memory unchanged (a subsequent `eventsFor` shows none of the batch; `resumeOffsets` unchanged) |

**Exact values:** persister default = no-op object (module-private).

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green — the
"no-op default" row ("every existing test passes unchanged") is observable only on the full
suite, not on `test/hubStore.test.ts` alone.
**Commit:** `feat(hub): persister seam in HubStore — durable before applied`

---

## Task 3: HubStore hydration *(spec §3.4, §7)*

**Files:**
- Modify: `poc/hub/src/hubStore.ts`
- Test: `poc/hub/test/hubStore.test.ts` (extend)
- Create: `poc/hub/test/helpers/hydrationCapture.ts` (shared capture helper — Task 4's
  round-trip test consumes it; keep it free of imports from `hubDb.ts`)

**Interfaces:**
- Consumes: `HubPersister` (Task 2, same file).
- Produces (verbatim):

```ts
export interface HubHydration {
  projects: { id: string; name: string; createdBy: string | null; createdAt: string; lifecycle: ProjectLifecycle; members: string[] }[];
  machines: { uplinkId: string; projectId: string; name: string; repos: RepoDecl[] }[];
  sessions: { projectId: string; sessionId: string; uplinkId: string; facts: SessionFacts; lastRunId: string | null; lastSeq: number; events: StoredEvent[] }[];
}
// final constructor signature:
constructor(persister?: HubPersister, hydration?: HubHydration)
// test helper, poc/hub/test/helpers/hydrationCapture.ts (verbatim signature):
export function captureHydration(): { persister: HubPersister; hydration(): HubHydration }
// — an in-memory HubPersister that records every call and can replay the resulting
//   state as a HubHydration at any moment.
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| hydration equivalence (property test, spec §7 "arbitrary realistic mutation sequences") | a seeded PRNG (inline mulberry32 in the test file; base seed `1337`) produces ≥ 25 random mutation sequences (length 10–60) over the ops {createProject, ensureProject, joinProject, leaveProject, setLifecycle, attach, setRepos, setFacts, publish} with valid-shaped args (≥2 uplinks, ≥2 sessions, publishes that hit BOTH the implicit-creation and existing-session paths); for each sequence: build store A while capturing persister output via `captureHydration()` (this task's helper); `new HubStore(undefined, capture.hydration())` → B | for every sequence: `listProjects()`, `snapshot(p)`, `eventsFor(p, s, 0)`, `resumeOffsets(u)`, `ownerOf(p, s)` deep-equal between A and B — except every hydrated machine reads `online: false` and every session's `presence` reads `"offline"`. Fixed base seed (deterministic run); the failing sequence's seed/index is included in the assertion message |
| hydrated ids continue | hydrated session has 3 events | next accepted publish stores `id: 4` |
| re-attach after hydration | hydrated machine's uplink re-attaches | reads `online: true` again; sessions reclaim per existing ownership rules |
| members order | hydration members array | applied in array order |

**Exact values:** PRNG = mulberry32, inlined in the test file; base seed = `1337`.

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green (this
task edits the shared live `hubStore.ts`).
**Commit:** `feat(hub): hydration — rebuild HubStore from persisted state`

---

## Task 4: HubDb — the SQLite journal + single-writer lock *(spec §3.1–3.2, §3.6, §8a.3, §8a.5–8a.7)*

**Files:**
- Create: `poc/hub/src/hubDb.ts`
- Test: `poc/hub/test/hubDb.test.ts`
- Modify: `poc/hub/package.json`, `poc/hub/package-lock.json` (deps per Global Constraints)

**First step (before any test is written):**
`npm --prefix poc/hub install better-sqlite3@^13.0.2 && npm --prefix poc/hub install -D @types/better-sqlite3@^7.6.13`
— better-sqlite3 is a NATIVE module; confirm it builds on the target Node before investing in
tests.

**Dependency blast radius (recorded):** Task 7 imports `HubDb` unconditionally into `hub.ts`,
so a failed native build / ABI mismatch breaks hub boot even with `HUB_DB` unset — the
`dbPath: undefined` kill switch does NOT cover dependency failure. Recovery is
`npm rebuild better-sqlite3`; Task 14 records it in the docs sweep.

**Interfaces:**
- Consumes (from Tasks 2–3, verbatim): `HubPersister`, `HubHydration` from `./hubStore.js`;
  test-side: `captureHydration` from `./helpers/hydrationCapture.js` (Task 3's helper).
- Produces (`HubDb` is the spec §3.3 `SqlitePersister` — deliberate rename, ratified as spec
  §8a ruling 6; Tasks 7–8 reference this name):

```ts
export class HubDb implements HubPersister {
  constructor(dbPath: string, opts?: { skipLock?: boolean });
  // ":memory:" supported (no lock, nothing on disk); otherwise parent dir mkdir-ed
  // recursively with mode 0700. skipLock is the crash-test seam ONLY — used by this
  // task's crash-abandoned test and Task 8's crash-continuity test; never in
  // production wiring.
  load(): HubHydration;
  close(): void;   // releases the lockfile
  // + every HubPersister method
}
export const SCHEMA_VERSION = 1;
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| fresh file | path in a temp dir | file + schema created; `meta` row `schema_version = '1'`; WAL mode on file-backed DBs; parent dir created mode `0700` (verify via `fs.statSync(dir).mode`) |
| round trip | apply one persister-call sequence to BOTH a `HubDb` and a `captureHydration()` persister; `close()` the db, reopen, `load()` | `load()` deep-equals `capture.hydration()`, with each session's `events` ordered by `id` asc |
| crash-abandoned handle | apply a persister-call sequence; do NOT `close()`; open a SECOND `HubDb` on the same file with `{skipLock: true}` | `load()` returns every committed write — this is the plan's named in-process stand-in for a killed hub process (WAL: committed = survives process death) |
| single-writer lock | `HubDb` open on a file; second `new HubDb(samePath)` (no skipLock) | throws per the lock-error template below — `basename(dbPath)` and the owner PID interpolate (lockfile `<dbPath>.lock` holds the owner's PID) |
| stale lock — silent reclaim (spec §8a.5) | lockfile exists with a dead PID or unparsable content | reclaimed silently; construction succeeds. Accepted blast radius per ruling 5: PID reuse could fool the liveness check; the dual failure (boot refused though nobody holds the DB) recovers by deleting `<dbPath>.lock` — documented in Task 14 |
| lock released | `close()` then reopen | succeeds; lockfile gone after close |
| :memory: no lock | `":memory:"` twice concurrently | both work; no lockfile, nothing on disk |
| upserts | `projectSaved`/`machineSaved`/`sessionSaved` twice for one key | single row, last write wins |
| member idempotence | `memberAdded` twice, `memberRemoved` of absent | no throw; one row / no row |
| events atomic | `eventsAppended` with 3 events, `newSession` undefined | 3 `events` rows + `sessions.last_run_id/last_seq` updated in ONE transaction |
| implicit session atomic | `eventsAppended(…, newSession)` | session row + events rows + last_run_id/last_seq in ONE transaction (spec §3.3) |
| newer schema | `meta.schema_version = '2'` | constructor throws per the schema-error template below — basename and both version numbers interpolate (`2` from the meta row, `1` from `SCHEMA_VERSION`) |
| corrupt file | path holding non-SQLite bytes | constructor throws (propagated, not swallowed) |
| unopenable | `dbPath` names an existing DIRECTORY | constructor throws (spec §3.6 "DB unopenable") |

**Exact values:** schema DDL verbatim from spec §3.2; `PRAGMA journal_mode = WAL`; JSON columns
via `JSON.stringify`/`JSON.parse` (`repos_json`, `facts_json`, `event_json`); lockfile path
`<dbPath>.lock`, content = owner PID as decimal text. Error-string templates (template literals
— `${…}` interpolates, everything else is literal; `basename` = `path.basename(dbPath)`, so
`hub.db` appears only when that IS the file's name):
- lock: `` `${basename} is in use by pid ${pid} — refusing to start` ``
- schema: `` `${basename} schema is v${found}; this hub understands v${SCHEMA_VERSION} — refusing to start` ``

**Verify:** `cd poc/hub && npx vitest run test/hubDb.test.ts && npx tsc --noEmit` → green;
`cd poc/hub && npm rebuild better-sqlite3 && npx vitest run test/hubDb.test.ts` → still green
(native ABI matches the target Node).
**Commit:** `feat(hub): SQLite write-through journal (HubDb) with single-writer lock` — staged
paths exactly: `poc/hub/src/hubDb.ts poc/hub/test/hubDb.test.ts poc/hub/package.json poc/hub/package-lock.json`

---

## Task 5: uplink test-harness extraction *(enables spec §7's restart integration)*

**Files:**
- Create: `poc/hub/test/helpers/uplinkHarness.ts`
- Modify: `poc/hub/test/relayIntegration.test.ts` (import from the new module; no behavior change)

**Interfaces:**
- Produces: the module-level helpers currently local to `relayIntegration.test.ts:11-220`, moved
  verbatim and exported under their existing names: `decl`, `wait`, `connect`, `collect`,
  `relayConnector`, `laptop`, `laptopThatAnswers`, `browserReplay`, `replayOnceAtLeast`,
  `snapshotVia` (plus any types/constants those ten close over). Pure move — signatures unchanged.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| pure extraction | — | `relayIntegration.test.ts` imports the helpers and every one of its tests passes unchanged; no helper logic edited (mechanically checked — see Verify) |

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → whole hub suite green (this task
refactors a shared test file, so the full suite is the check). Mechanical no-logic-edited check
(the green suite alone cannot prove it — a rewritten helper can still pass):

```bash
# every line added to the test file is an import from the new helper module:
git diff HEAD -- poc/hub/test/relayIntegration.test.ts | grep -E '^\+' | grep -v '^\+\+\+' \
  | grep -vE 'import|from ["'\'']\./helpers/uplinkHarness' \
  | grep -vE '^\+\s*$' # → EMPTY
# every line removed from the test file reappears verbatim in the helper module,
# allowing only a leading `export `:
git diff HEAD -- poc/hub/test/relayIntegration.test.ts | sed -n 's/^-//p' | grep -v '^--' \
  | grep -v '^\s*$' | while IFS= read -r l; do
    grep -qxF "$l" poc/hub/test/helpers/uplinkHarness.ts \
      || grep -qxF "export $l" poc/hub/test/helpers/uplinkHarness.ts \
      || echo "EDITED: $l"
  done # → prints nothing
```
**Commit:** `test(hub): extract the real-uplink harness for reuse`

---

## Task 6: boot-config helpers *(spec §3.1, §8a.2)*

**Files:**
- Create: `poc/hub/src/bootConfig.ts`
- Test: `poc/hub/test/bootConfig.test.ts`

**Interfaces:**
- Produces (verbatim):

```ts
export function hubDbPath(env: NodeJS.ProcessEnv): string;
// HUB_DB set → its value verbatim (":memory:" included);
// else `${env.MPAI_HOME || os.homedir() + "/.mpai"}/hub.db` — same dotdir/override
// convention as §8.3's machine.json (owner ruling, spec §8a.2)
export function storeLogLine(dbPath: string | undefined): string;
// undefined → "hub store: in-memory (no dbPath)"; ":memory:" → "hub store: in-memory";
// else `hub store: sqlite ${dbPath}`
// storeLogLine is a boot-observability line — NOT a spec §3.1 requirement; plan-level
// addition per house logging convention (behavior-free), recorded here so the surface
// stays traced.
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| HUB_DB set | `{ HUB_DB: "/x/y.db" }` | `"/x/y.db"` verbatim; `{ HUB_DB: ":memory:" }` → `":memory:"` |
| unset, MPAI_HOME set | `{ MPAI_HOME: "/custom" }` | `"/custom/hub.db"` |
| unset, no MPAI_HOME | `{}` | `` `${os.homedir()}/.mpai/hub.db` `` |
| log lines | each of the three `storeLogLine` shapes | verbatim strings per the contract above |

**Verify:** `cd poc/hub && npx vitest run test/bootConfig.test.ts && npx tsc --noEmit` → green.
**Commit:** `feat(hub): boot config — HUB_DB resolution and the store log line`

---

## Task 7: startHub wiring + fail-stop *(spec §3.1, §3.6)*

*(Wiring and fail-stop are deliberately FUSED, not a bundle: the fail-stop path is the wiring's
error-handling contract — splitting them would put the `fatal` seam's definition and its only
caller in different tasks on the same two files, forcing two serialized same-file writers with
no parallelism gain and a torn contract at the seam.)*

**Files:**
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`
- Test: `poc/hub/test/hubBoot.test.ts` (new)

**Interfaces:**
- Consumes: `HubDb` (Task 4); `HubStore` constructor (Tasks 2–3); `hubDbPath`, `storeLogLine`
  from `./bootConfig.js` (Task 6).
- Produces:

```ts
export interface HubOptions {
  port: number;
  host?: string;
  staticDir?: string;
  dbPath?: string;              // undefined → ephemeral in-memory store (current behavior)
  db?: HubDb;                   // test seam: pre-built db; takes precedence over dbPath
  fatal?: (err: Error) => void; // fail-stop hook; defaults to defaultFatal
}
export function defaultFatal(err: Error): void;  // console.error(err) then process.exit(1)
```
`RunningHub.close()` also closes the DB (when this hub opened or was given one).
`main.ts` calls `startHub({ …, dbPath: hubDbPath(process.env) })` and prints
`console.log(storeLogLine(dbPath))` after the listening line.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| wiring | `startHub({ …, dbPath })` | `new HubDb(dbPath)` → `new HubStore(db, db.load())`; boot error (unopenable/corrupt/newer schema/lock held) rejects startHub's promise — the hub does not serve |
| db seam | `startHub({ …, db })` | uses the given instance; `dbPath` ignored |
| skipLock stays test-only | `startHub({ …, dbPath })` | constructs `new HubDb(dbPath)` with NO second argument — assert the constructor args (constructor spy, or the db seam); the mechanical grep in Verify pins it repo-wide |
| no dbPath | neither `dbPath` nor `db` | exactly today's behavior — plain `new HubStore()`; every existing startHub caller/test unchanged |
| runtime fail-stop | persister throws during a publish (inject via `db` seam + `fatal` spy) | error caught at the hub layer and routed to `fatal(err)`; NO event fanned out; NO `{type:"error"}` frame sent; store memory unchanged (Task 2's invariant observed at hub level) |
| defaultFatal | `defaultFatal` invoked with an Error, `vi.spyOn(console, "error")` and `vi.spyOn(process, "exit").mockImplementation(() => undefined as never)` in place | `console.error` called with the error, `process.exit` called with `1`; and `startHub` with `fatal` unset uses `defaultFatal` (assert by identity on the resolved option or by spying as above) |
| blast radius (recorded) | any single persister write failure | whole-hub outage for every connected uplink and browser — deliberate (spec §3.6, no catch-and-carry-on). Disk-full (the endpoint of the unbounded journal, Task 14's debt entry) crash-loops on the next publish after restart. Operator recovery, in order (spec §8a ruling 7): (1) BACK UP first — copy the `hub.db` + `hub.db-wal` + `hub.db-shm` trio to safe storage (the journal is the product's sole record; a botched recovery loses it permanently); (2) free disk space, or move/compact the trio TOGETHER (moving `hub.db` alone strands committed WAL data); or (3) `HUB_DB=:memory:` for degraded ephemeral service. A CORRUPT `hub.db` has no recovery before §8.10's backups: the record to that point is lost unless the operator kept copies. A newer-schema refusal (hub version rollback) recovers by running the newer hub or restoring the pre-upgrade backup — the backup-before-upgrade convention, also ruling 7. All documented again in Task 14 |

**Exact values:** env var `HUB_DB`; default path `~/.mpai/hub.db` honoring `MPAI_HOME` (spec
§8a.2 — home-anchored, so the launch directory never decides where the record lives and no
gitignore dependence exists); log lines verbatim per Task 6's `storeLogLine`.

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → whole hub suite green,
including the new `test/hubBoot.test.ts`; `grep -rn "skipLock" poc/hub/src` → matches only
`hubDb.ts`'s own signature/implementation, never `hub.ts`/`main.ts`.
**Commit:** `feat(hub): durable boot — SQLite-backed store behind HUB_DB, fail-stop on write failure`

---

## Task 8: restart continuity integration *(spec §3.5, §7)*

**Files:**
- Test: `poc/hub/test/hubRestart.test.ts` (new; imports `helpers/uplinkHarness.ts` from Task 5).
  Pure test task — the wiring it exercises is Task 7's deliverable; if a test here exposes a
  wiring gap, that is a Task 7 defect routed through the executor's fix loop, not a license for
  this task to edit `hub.ts`.

**Interfaces:**
- Consumes: `startHub` with `dbPath`/`db`/`fatal` (Task 7); `HubDb` incl. `{skipLock: true}`
  (Task 4); harness (Task 5).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| restart continuity | real uplink attaches, declares facts, publishes N events; browser joins and sees them; `hub.close()`; `startHub` again on the SAME file | before any uplink reconnects: `list_projects` shows the project; machines read `online: false`; a joining browser is refused (`no machine is running session …` — owner offline) but `watch_project` snapshot lists the session `offline` with its facts |
| resume after restart | the laptop reconnects to the restarted hub | `welcome.have` carries the stored `{runId, lastSeq}`; laptop replays only the gap; a browser joining then replays ALL events exactly once (no duplicates, no holes) |
| crash continuity | as restart continuity, but the first hub is NOT closed — start the second hub via the `db` seam on a second `HubDb(samePath, {skipLock: true})` handle (Task 4's named crash stand-in; skipLock because the abandoned handle's lock deliberately still exists) | same expectations as restart continuity: committed events all present |
| double-start refused | while the first hub is open, `startHub({ dbPath: samePath })` (no seam) | promise rejects with the Task 4 lock error naming the running PID |

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → whole hub suite green.
**Commit:** `test(hub): restart, crash and double-start continuity on the real relay harness`

---

## Task 9: hub `get_record` *(spec §4.3, §8a.1)*

**Files:**
- Modify: `poc/hub/src/hub.ts` (new browser-message branch), `poc/hub/src/hubStore.ts`
  (add `recordInputs`)
- Test: `poc/hub/test/routing.test.ts` (extend — the wire-protocol rows below),
  `poc/hub/test/hubStore.test.ts` (extend — the `recordInputs isolation` row)

**Interfaces:**
- Consumes: `projectRecordFrom`, `RecordSessionInput` from `multiplayer-ai-server/record` (Task 1).
- Produces:

```ts
// HubStore (hubStore.ts):
recordInputs(projectId: string): RecordSessionInput[]
// wire protocol:
// browser → hub:  { type: "get_record", projectId: string }
// hub → browser:  { type: "record", projectId: string, record: ProjectRecord }
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| happy path | identified channel; project with sessions/events | `record` reply; `record.sessions[].machineId` = owning `uplinkId`; derivation matches `projectRecordFrom` |
| access gate | **OWNER RULING (spec §8a.1): `identify` required.** No identity on the channel | `{type:"error", message:"identify first"}` — same string and shape as `create_project`'s gate (hub.ts:409); membership NOT required (deliberate: matches watch_project's visibility while pinning the gate line for v7b2's real auth) |
| access gate — identified | channel has identified, not joined any session/project | answered normally |
| bad projectId | identified; missing / fails SLUG | `{type:"error", message:"get_record requires a valid projectId"}` |
| unknown project | identified; valid slug, never seen | `record` with `sessions: []`, zeroed rollup — and NO project created (readSessionsOf discipline, hubStore.ts:236-245) |
| no re-homing | identified channel joined to a session asks | answered; `channel.projectId`/`sessionId` untouched (mirrors watch_project's joined-channel rule) |
| recordInputs isolation | mutate the returned facts | store state unaffected (facts deep-copied; events may share refs — read-only by contract). Tested in `hubStore.test.ts` |

**Exact values:** error strings `identify first` and `get_record requires a valid projectId`;
the branch handles the message itself — do NOT add it to `HUB_HANDLED` (that set replies with a
snapshot).

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green (this
task edits the live `hub.ts` router and the shared `hubStore.ts`).
**Commit:** `feat(hub): get_record — the project record over the browser protocol`

---

## Task 10: standalone-server `get_record` parity *(spec §4.3)*

**Files:**
- Modify: `poc/server/src/server.ts` (beside `watch_project`, server.ts:947)
- Test: `poc/server/test/serverRecord.test.ts` (new)

**Interfaces:**
- Consumes: `projectRecordFrom`, `RecordSessionInput` from `./record.js` (Task 1); existing
  server internals — mirror how `snapshotFor`/`peek` read state: `projects.get(projectId)`
  (non-creating), `sessionFactsOf(id, entry, entry.repoKey)`, `entry.session.eventsFrom(0)`,
  `machineView()`.
- Produces: the same wire pair as Task 9, byte-shape-identical.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| gate parity | unauthenticated (auth on) | `denyUnauthed()` refusal — same gate as `watch_project` (server.ts:948); the hub/standalone gate asymmetry is the recorded owner ruling (Global Constraints) |
| happy path | project with sessions | `record` reply; `machineId` = `machineView()?.machineId ?? null` for every session |
| bad projectId | fails SLUG | error `get_record requires a valid projectId` (identical string to hub) |
| unknown project | valid slug, absent | empty `record`; `projects` map NOT grown (peek discipline, server.ts:907 — use `projects.get`, never `getOrCreateProject`) |
| relay arm | — | this handler is unreachable when hub-attached (the hub's Task 9 branch answers first, like `peek`/`watch_project`); carry the same routing comment — parity must never be "fixed" by tunnelling |

**Verify:** `cd poc/server && npx tsc --noEmit && npx vitest run` → WHOLE server suite green
(this task edits a live routing file); then `npm run build` (hub/client consume dist).
**Commit:** `feat(server): answer get_record in solo — protocol parity with the hub`

---

## Task 11: record view-model *(spec §5)*

**Files:**
- Create: `poc/client/src/recordView.ts`
- Test: `poc/client/src/recordView.test.ts`

**Interfaces:**
- Consumes: `ProjectRecord`, `TurnRecord`, `SessionRecord`, `UserRollup` types from
  `multiplayer-ai-server/record`; `MachineInfo` from `poc/client/src/types.ts` (the module
  SessionPicker already imports it from, SessionPicker.tsx:3).
- Produces (verbatim — Task 12 depends on these names and the templates below
  character-for-character):
  `rollupLines(record: ProjectRecord): string[]` and
  `sessionBlocks(record: ProjectRecord, machines: MachineInfo[]): { header: string; turnLines: string[] }[]`.
  Any remaining latitude lives in purely internal (non-exported) helpers only.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| rollup line | perUser rows | one line per user, exactly the rollup template below — real ids as provided, no invented copy |
| session header | each session | exactly the header template below; machine label = name resolved from `machines` by `machineId`, else the raw `machineId`, else `unknown machine` when null |
| turn line | each turn | exactly the turn template below: driver, start time, prompt (already capped server-side), tool summary, filesChanged, approvals with decider (auto marked), `errors` segment only when > 0, `IN PROGRESS` marker on an open turn |
| empty | record with no sessions | exactly one line: `nothing recorded yet` |
| purity | same inputs twice | deep-equal output; inputs not mutated; no React imports in the module |

**Exact values — rendered-line templates** (template literals: `${…}` interpolates, everything
else literal; these are the plan's line-format contract — Task 12 renders them unmodified):

```
rollup line:     `${userId} — ${turnsDriven} driven · ${approvalsGiven} approved · ${denialsGiven} denied`
session header:  `${sessionId} — ${machineLabel} · ${repoKey ?? "no repo"} · ${lifecycle}${closedBy ? ` · closed by ${closedBy}` : ""}`
turn line:       `#${turn} ${driver ?? "system"} · ${startTs} · ${prompt ?? "(no prompt)"} · tools: ${toolsSeg} · files: ${filesSeg} · approvals: ${approvalsSeg}${errors > 0 ? ` · errors: ${errors}` : ""}${inProgress ? " · IN PROGRESS" : ""}`
  toolsSeg:      entries of toolCounts as `${name}×${count}` joined by " ", or `none`
  filesSeg:      filesChanged joined by ", ", or `none`
  approvalsSeg:  each approval as `${decision} ${toolName ?? kind} by ${userId}${auto ? " (auto)" : ""}` joined by ", ", or `none`
```

**Verify:** `cd poc/client && npx tsc -b && npx vitest run src/recordView.test.ts` → green.
**Commit:** `feat(client): record view-model — pure lines from a ProjectRecord`

---

## Task 12: RECORD panel *(spec §5, §7)*

**Files:**
- Create: `poc/client/src/components/RecordPanel.tsx`
- Test: `poc/client/src/components/RecordPanel.test.tsx` (new)
- Modify: `poc/client/src/components/SessionPicker.tsx`

**Interfaces:**
- Consumes: `recordView.ts` helpers (Task 11); `ProjectRecord` from
  `multiplayer-ai-server/record`; `MachineInfo` from `poc/client/src/types.ts`; SessionPicker's
  existing ws + message dispatch (SessionPicker.tsx:67-87) and its `machines` state
  (SessionPicker.tsx:32).
- Produces: `RecordPanel` props are exactly `{ record: ProjectRecord | null; machines: MachineInfo[] }`
  — the final prop type, no additional props.

**Behavior:** (each row below has a named test in `RecordPanel.test.tsx` or the SessionPicker
portion of the suite)

| Case | Input / state | Expected |
|------|---------------|----------|
| entry point | project screen | a `RECORD` toggle alongside the existing panels; a render test asserts the toggle appears and opens the panel (spec §7) |
| fetch on open | toggle opened | test: opening the toggle sends `{type:"get_record", projectId}` on the ws; the panel renders on `{type:"record"}` whose `projectId` matches |
| refresh | panel open, a `{type:"project"}` push arrives | test: `get_record` is re-sent (throttling beyond the push cadence not required — pushes are already 1s-throttled) |
| rendering | a `ProjectRecord` fixture | test: render the panel with the fixture; the rendered DOM text contains exactly the lines returned by `rollupLines(record)` and `sessionBlocks(record, machines)` for that fixture, in order — asserted by computing the helper output in the test and comparing (line CONTENT is Task 11's contract; this row pins that the panel renders it unmodified) |
| error | `{type:"error"}` after fetch | test: the message appears on the picker's existing error line (SessionPicker.tsx:34) |
| a11y/theme | — | AA contrast floor; arcade styling consistent with sibling panels; no information carried only by the decorative layer (terminal.css:11-16 rule) — verified by Task 13's walk |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run` → green, including
`RecordPanel.test.tsx`.
**Commit:** `feat(client): RECORD panel — the project record on the project screen`

---

## Task 13: browser walk *(verification only, no source changes — spec §5 covers steps 3 and 6
(AA contrast, arcade consistency) and §4.3 covers the solo-parity step 7; steps 4, 5 and 8 are
house verification convention, not spec-mandated, kept per the sibling machines-repos plan's
live walk)*

**Files:** none (the deliverable is the walk record in the execution ledger).

**Ledgering:** each numbered step is INDEPENDENTLY ledgered — a later step's failure does not
invalidate earlier steps' recorded results (a step-6 contrast failure leaves the step-2/3 hub
walk record standing; the fix routes to the owning task via the executor's fix loop and only
the failed step re-runs).

**Interfaces:**
- Consumes: Task 7's hub wiring (`HUB_DB`, `poc/hub/dist/main.js`), Task 10's solo handler,
  Task 12's panel. Client identity is self-asserted in v7b1 — the walk's browser must have
  identified/signed in the same way the existing project screen requires.

**Steps (verbatim):**
1. Build: `cd poc/client && npm run build && cd ../server && npm run build && cd ../hub && npm run build`
2. Hub mode: `cd <repo root> && HUB_DB="$(mktemp -d)/hub.db" CLIENT_DIST=poc/client/dist PORT=4000 node poc/hub/dist/main.js`;
   launch one laptop via `mpai --hub ws://127.0.0.1:4000/uplink` from a repo directory (it
   attaches to project `default` — the entrance lists it); open `http://127.0.0.1:4000/`, enter
   project `default`, join or create a session, type `say hello` in the prompt bar and submit,
   wait for the turn to finish (agent status idle).
3. Toggle RECORD → the panel shows that turn with its driver and tools (not `nothing recorded
   yet`).
4. Styling consistency (pass/fail): screenshot the open RECORD panel beside one named sibling
   panel (MACHINES), then record, for both panels' chrome, the computed `font-family`,
   `font-size`, `border`, `background` and accent `color` (getComputedStyle). PASS = every
   listed property matches the sibling exactly; any deliberate difference is listed in the
   ledger with its reason, and an unexplained difference is a FAIL routed to Task 12.
5. Decorative layer: enumerate each decorative-only visual element in the panel and confirm a
   text/DOM equivalent exists; record each pair in the ledger.
6. Contrast: in DevTools on the open panel, read each distinct text style's computed
   foreground/background (getComputedStyle) and compute WCAG ratios — every pair ≥ 4.5:1;
   record the ratios in the ledger.
7. Solo mode: stop the hub processes; run `mpai` (no `--hub`) from a repo directory; in the
   opened browser run one short agent turn (same `say hello` prompt), go to the project screen,
   toggle RECORD → the panel shows that solo turn with driver/tools (not `nothing recorded
   yet`, not stale hub data).
8. Shutdown: stop all launched processes;
   `for p in 3001 3002 3003 4000 5173; do lsof -nP -iTCP:$p -sTCP:LISTEN; done` → empty.

**Verify:** the ledger contains the walk record: both-mode observations, the screenshot
reference, the decorative-layer pairs, and the contrast ratios (all ≥ 4.5:1).
**Commit:** none (ledger is git-ignored scratch; any fixes the walk forces belong to the owning
task via the executor's fix loop).

---

## Task 14: docs sweep *(spec §6 non-goals 2–3, §8a)*

**Files:**
- Modify: `docs/PRD.md` (§8.7 *Today*), `docs/tech-debt.md`

**Interfaces:** none.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| PRD §8.7 Today | current text (PRD.md:456-461) | rewritten to reflect this branch: durable SQLite store (`HUB_DB`, default `~/.mpai/hub.db`, single-writer lock with silent stale-reclaim per spec §8a.5 — false-alive recovery: delete `<dbPath>.lock`; native-module recovery: `npm rebuild better-sqlite3`, Task 4's dependency blast radius), turn-boundary record derived + surfaced, fail-stop on write failure (whole-hub outage by design; recovery: back up the `hub.db`/`-wal`/`-shm` trio FIRST, then free disk / move the trio together / `HUB_DB=:memory:`; corrupt DB = record lost absent copies, backups arrive with §8.10; backup-before-upgrade convention for schema bumps); the closed-lid/graceful-shutdown gap EXPLICITLY remains open (spec §6 non-goal 3) |
| tech-debt | — | append `### 2.8 No retention/compaction/backup — the events table grows without bound` under `## 2. Correctness`: growth toward disk-full, whose failure mode is the documented crash-loop; §8.10's job (spec §6 non-goal 2). Follow the file's existing `### N.M` format |

**Verify:** `grep -n 'HUB_DB' docs/PRD.md` hits the new §8.7 Today text;
`grep -ni 'closed lid\|graceful' docs/PRD.md` still names the gap as open;
`git diff docs/tech-debt.md | grep -cE '^\+### [0-9]+\.[0-9]+ '` → exactly 1, and
`git diff docs/tech-debt.md | grep -E '^\+' | grep -ci 'retention\|compaction'` ≥ 1;
`git diff --stat docs/` touches only `PRD.md` and `tech-debt.md`.
**Commit:** `docs: PRD §8.7 Today + retention debt entry for the record`
