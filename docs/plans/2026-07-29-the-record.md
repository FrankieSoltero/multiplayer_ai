# The Record (PRD §8.7) Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd (or
> superpowers:subagent-driven-development). The Task Dependency Table below is
> the scheduling and review-depth contract. Spec of record:
> `docs/specs/2026-07-29-the-record-design.md` (including its §8a owner rulings 1–5) — where
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
- **At-rest posture (recorded decision, not an omission):** the DB is an unencrypted local file
  holding prompts, userIds and file paths, in a `0700` home dotdir, with no retention or backup
  mechanism until §8.10 — a corrupt `hub.db` therefore loses the record to that point unless the
  operator kept copies. Acceptable for the v7b1 trusted-network hub; revisit with v7b2 auth /
  §8.10.
- `HubStore.publish`/`eventsFor` results stay allocation-light; the record path is request/reply
  and MAY copy.
- New deps (poc/hub only): `"better-sqlite3": "^13.0.2"`, devDep `"@types/better-sqlite3": "^7.6.13"`.

**Done criteria (plan-level):** every per-task Verify has passed and, on the final tree,
`cd poc/server && npx tsc --noEmit && npx vitest run`, `cd poc/hub && npx tsc --noEmit && npx
vitest run`, and `cd poc/client && npx tsc -b && npx vitest run` are all green, plus Task 13's
browser-walk record (with contrast ratios and both-mode observations) exists in the execution
ledger.

## Task Dependency Table

| Task | Files touched | Depends on | Risk tier |
|------|---------------|------------|-----------|
| 1. record derivation module | `poc/server/src/record.ts`, `poc/server/test/record.test.ts`, `poc/server/package.json` | — | standard |
| 2. HubStore persister seam | `poc/hub/src/hubStore.ts`, `poc/hub/test/hubStore.test.ts` | — | judgment |
| 3. HubStore hydration | `poc/hub/src/hubStore.ts`, `poc/hub/test/hubStore.test.ts` | 2 | standard |
| 4. HubDb (SQLite + lock) | `poc/hub/src/hubDb.ts`, `poc/hub/test/hubDb.test.ts`, `poc/hub/package.json` | 2, 3 | standard |
| 5. uplink test-harness extraction | `poc/hub/test/helpers/uplinkHarness.ts`, `poc/hub/test/relayIntegration.test.ts` | — | mechanical |
| 6. boot-config helpers | `poc/hub/src/bootConfig.ts`, `poc/hub/test/bootConfig.test.ts` | — | standard |
| 7. startHub wiring + fail-stop | `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/hubBoot.test.ts` | 3, 4, 6 | judgment |
| 8. restart continuity integration | `poc/hub/test/hubRestart.test.ts` | 5, 7 | judgment |
| 9. hub `get_record` | `poc/hub/src/hub.ts`, `poc/hub/src/hubStore.ts`, `poc/hub/test/routing.test.ts`, `poc/hub/test/hubStore.test.ts` | 1, 3 | standard |
| 10. standalone `get_record` parity | `poc/server/src/server.ts`, `poc/server/test/serverRecord.test.ts` | 1 | standard |
| 11. record view-model | `poc/client/src/recordView.ts`, `poc/client/src/recordView.test.ts` | 1 | standard |
| 12. RECORD panel | `poc/client/src/components/RecordPanel.tsx`, `poc/client/src/components/RecordPanel.test.tsx`, `poc/client/src/components/SessionPicker.tsx` | 9, 10, 11 | standard |
| 13. browser walk | (no source files — execution-ledger record only) | 7, 12 | standard |
| 14. docs sweep | `docs/PRD.md`, `docs/tech-debt.md` | 1–13 | mechanical |

Concurrency notes: Tasks 1, 2, 5 and 6 are mutually disjoint and may run concurrently. Task 3
follows 2 on the same files. Task 9 writes `hub.ts` and `hubStore.ts`, so **Task 9 must not run
concurrently with 2, 3, or 7** (either order works). Task 8 touches only its own new test file
and is disjoint from 9. Tasks 10 and 11 are disjoint from everything hub-side and from each
other. Task 13 is a pure verification task: it launches Task 7's hub wiring (`HUB_DB`,
`dist/main.js`) end-to-end — that is why 7 is in its Depends-on.

---

## Task 1: Record derivation module *(spec §4.1–4.2, §8a.4)*

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
| driver — user message | turn contains a `user_message` | driver = first `user_message`'s `userId` |
| driver — controller fallback | turn has no `user_message`; a `control_change` occurred anywhere earlier in the session scan (any earlier turn or earlier in this one) | driver = most recent `control_change.userId` seen before the turn's first event |
| driver — none | no `user_message` in turn, no prior `control_change` | driver = null |
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
| rollup approvals | decisions: allow×2 (u1), deny×1 (u1), approve×1 (u2), one allow with `auto:true` | u1 `{approvalsGiven:2, denialsGiven:1}`; u2 `{approvalsGiven:1}`; the `auto` decision counts for NOBODY |
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

**Verify:** `cd poc/hub && npx vitest run test/hubStore.test.ts && npx tsc --noEmit` → green
(old + new tests).
**Commit:** `feat(hub): persister seam in HubStore — durable before applied`

---

## Task 3: HubStore hydration *(spec §3.4, §7)*

**Files:**
- Modify: `poc/hub/src/hubStore.ts`
- Test: `poc/hub/test/hubStore.test.ts` (extend)

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
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| hydration equivalence (property test, spec §7 "arbitrary realistic mutation sequences") | a seeded PRNG generator produces ≥ 25 random mutation sequences (length 10–60) over the ops {createProject, ensureProject, joinProject, leaveProject, setLifecycle, attach, setRepos, setFacts, publish} with valid-shaped args (≥2 uplinks, ≥2 sessions, publishes that hit BOTH the implicit-creation and existing-session paths); for each sequence: build store A while capturing persister output as a `HubHydration`; `new HubStore(undefined, hydration)` → B | for every sequence: `listProjects()`, `snapshot(p)`, `eventsFor(p, s, 0)`, `resumeOffsets(u)`, `ownerOf(p, s)` deep-equal between A and B — except every hydrated machine reads `online: false` and every session's `presence` reads `"offline"`. Fixed base seed (deterministic run); the failing sequence's seed/index is included in the assertion message |
| hydrated ids continue | hydrated session has 3 events | next accepted publish stores `id: 4` |
| re-attach after hydration | hydrated machine's uplink re-attaches | reads `online: true` again; sessions reclaim per existing ownership rules |
| members order | hydration members array | applied in array order |

**Verify:** `cd poc/hub && npx vitest run test/hubStore.test.ts && npx tsc --noEmit` → green.
**Commit:** `feat(hub): hydration — rebuild HubStore from persisted state`

---

## Task 4: HubDb — the SQLite journal + single-writer lock *(spec §3.1–3.2, §3.6, §8a.3, §8a.5)*

**Files:**
- Create: `poc/hub/src/hubDb.ts`
- Test: `poc/hub/test/hubDb.test.ts`
- Modify: `poc/hub/package.json` (deps per Global Constraints)

**Interfaces:**
- Consumes (from Tasks 2–3, verbatim): `HubPersister`, `HubHydration` from `./hubStore.js`.
- Produces (`HubDb` is the spec §3.3 `SqlitePersister` — deliberate rename; this plan's name
  governs and Tasks 7–8 reference it):

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
| round trip | apply a persister-call sequence, `close()`, reopen, `load()` | `HubHydration` deep-equals what Task 3's hydration-equivalence test would rebuild from — events per session ordered by `id` asc |
| crash-abandoned handle | apply a persister-call sequence; do NOT `close()`; open a SECOND `HubDb` on the same file with `{skipLock: true}` | `load()` returns every committed write — this is the plan's named in-process stand-in for a killed hub process (WAL: committed = survives process death) |
| single-writer lock | `HubDb` open on a file; second `new HubDb(samePath)` (no skipLock) | throws `` hub.db is in use by pid <pid> — refusing to start `` (lockfile `<dbPath>.lock` holds the owner's PID) |
| stale lock — silent reclaim (spec §8a.5) | lockfile exists with a dead PID or unparsable content | reclaimed silently; construction succeeds. Accepted blast radius per ruling 5: PID reuse could fool the liveness check; the dual failure (boot refused though nobody holds the DB) recovers by deleting `<dbPath>.lock` — documented in Task 14 |
| lock released | `close()` then reopen | succeeds; lockfile gone after close |
| :memory: no lock | `":memory:"` twice concurrently | both work; no lockfile, nothing on disk |
| upserts | `projectSaved`/`machineSaved`/`sessionSaved` twice for one key | single row, last write wins |
| member idempotence | `memberAdded` twice, `memberRemoved` of absent | no throw; one row / no row |
| events atomic | `eventsAppended` with 3 events, `newSession` undefined | 3 `events` rows + `sessions.last_run_id/last_seq` updated in ONE transaction |
| implicit session atomic | `eventsAppended(…, newSession)` | session row + events rows + last_run_id/last_seq in ONE transaction (spec §3.3) |
| newer schema | `meta.schema_version = '2'` | constructor throws `hub.db schema is v2; this hub understands v1 — refusing to start` |
| corrupt file | path holding non-SQLite bytes | constructor throws (propagated, not swallowed) |
| unopenable | `dbPath` names an existing DIRECTORY | constructor throws (spec §3.6 "DB unopenable") |

**Exact values:** schema DDL verbatim from spec §3.2; `PRAGMA journal_mode = WAL`; JSON columns
via `JSON.stringify`/`JSON.parse` (`repos_json`, `facts_json`, `event_json`); lockfile path
`<dbPath>.lock`, content = owner PID as decimal text; lock error string verbatim as in the row.

**Verify:** `cd poc/hub && npx vitest run test/hubDb.test.ts && npx tsc --noEmit` → green.
**Commit:** `feat(hub): SQLite write-through journal (HubDb) with single-writer lock`

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
| pure extraction | — | `relayIntegration.test.ts` imports the helpers and every one of its tests passes unchanged; no helper logic edited |

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → whole hub suite green (this task
refactors a shared test file, so the full suite is the check).
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
| no dbPath | neither `dbPath` nor `db` | exactly today's behavior — plain `new HubStore()`; every existing startHub caller/test unchanged |
| runtime fail-stop | persister throws during a publish (inject via `db` seam + `fatal` spy) | error caught at the hub layer and routed to `fatal(err)`; NO event fanned out; NO `{type:"error"}` frame sent; store memory unchanged (Task 2's invariant observed at hub level) |
| defaultFatal | `defaultFatal` invoked with an Error, `vi.spyOn(console, "error")` and `vi.spyOn(process, "exit").mockImplementation(() => undefined as never)` in place | `console.error` called with the error, `process.exit` called with `1`; and `startHub` with `fatal` unset uses `defaultFatal` (assert by identity on the resolved option or by spying as above) |
| blast radius (recorded) | any single persister write failure | whole-hub outage for every connected uplink and browser — deliberate (spec §3.6, no catch-and-carry-on). Disk-full (the endpoint of the unbounded journal, Task 14's debt entry) crash-loops on the next publish after restart. Operator recovery, in order: (1) BACK UP first — copy the `hub.db` + `hub.db-wal` + `hub.db-shm` trio to safe storage (the journal is the product's sole record; a botched recovery loses it permanently); (2) free disk space, or move/compact the trio TOGETHER (moving `hub.db` alone strands committed WAL data); or (3) `HUB_DB=:memory:` for degraded ephemeral service. A CORRUPT `hub.db` has no recovery before §8.10's backups: the record to that point is lost unless the operator kept copies. A newer-schema refusal (hub version rollback) recovers by running the newer hub or restoring the pre-upgrade backup — establish the backup-before-upgrade convention now. All documented again in Task 14 |

**Exact values:** env var `HUB_DB`; default path `~/.mpai/hub.db` honoring `MPAI_HOME` (spec
§8a.2 — home-anchored, so the launch directory never decides where the record lives and no
gitignore dependence exists); log lines verbatim per Task 6's `storeLogLine`.

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → whole hub suite green,
including the new `test/hubBoot.test.ts`.
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

**Verify:** `cd poc/hub && npx vitest run test/routing.test.ts test/hubStore.test.ts && npx tsc
--noEmit` → green.
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
- Produces: pure, React-free view-model helpers; proposed shape *(implementer may adjust at
  review — deliberate delegation, not an omission)*:
  `rollupLines(record: ProjectRecord): string[]` and
  `sessionBlocks(record: ProjectRecord, machines: MachineInfo[]): { header: string; turnLines: string[] }[]`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| rollup line | perUser rows | one line per user: turns driven, approvals, denials — real names/ids as provided, no invented copy |
| session header | each session | sessionId, machine (name if resolvable from `machines`, else the raw machineId), repoKey, lifecycle, closedBy when set |
| turn line | each turn | driver, start time, prompt (already capped server-side), tool summary, filesChanged, approvals with decider (auto marked), `errors` count when > 0; `inProgress` turn visibly marked |
| empty | record with no sessions | exactly one line: `nothing recorded yet` |
| purity | same inputs twice | deep-equal output; inputs not mutated; no React imports in the module |

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
- Produces: `RecordPanel` props are `{ record: ProjectRecord | null; machines: MachineInfo[] }`
  *(remaining presentation props, if any — implementer's choice, reviewer confirms)*.

**Behavior:** (each row below has a named test in `RecordPanel.test.tsx` or the SessionPicker
portion of the suite)

| Case | Input / state | Expected |
|------|---------------|----------|
| entry point | project screen | a `RECORD` toggle alongside the existing panels; a render test asserts the toggle appears and opens the panel (spec §7) |
| fetch on open | toggle opened | test: opening the toggle sends `{type:"get_record", projectId}` on the ws; the panel renders on `{type:"record"}` whose `projectId` matches |
| refresh | panel open, a `{type:"project"}` push arrives | test: `get_record` is re-sent (throttling beyond the push cadence not required — pushes are already 1s-throttled) |
| rendering | record data | rendered from Task 11's helpers — content contracts live there |
| error | `{type:"error"}` after fetch | test: the message appears on the picker's existing error line (SessionPicker.tsx:34) |
| a11y/theme | — | AA contrast floor; arcade styling consistent with sibling panels; no information carried only by the decorative layer (terminal.css:11-16 rule) — verified by Task 13's walk |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run` → green, including
`RecordPanel.test.tsx`.
**Commit:** `feat(client): RECORD panel — the project record on the project screen`

---

## Task 13: browser walk *(spec §5, §7 — verification only, no source changes)*

**Files:** none (the deliverable is the walk record in the execution ledger).

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
4. Styling consistency: screenshot the open RECORD panel beside one named sibling panel (e.g.
   MACHINES) and record the file + observation in the ledger.
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

## Task 14: docs sweep *(spec §6.2–6.3, §8a)*

**Files:**
- Modify: `docs/PRD.md` (§8.7 *Today*), `docs/tech-debt.md`

**Interfaces:** none.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| PRD §8.7 Today | current text (PRD.md:456-461) | rewritten to reflect this branch: durable SQLite store (`HUB_DB`, default `~/.mpai/hub.db`, single-writer lock with silent stale-reclaim per spec §8a.5 — false-alive recovery: delete `<dbPath>.lock`), turn-boundary record derived + surfaced, fail-stop on write failure (whole-hub outage by design; recovery: back up the `hub.db`/`-wal`/`-shm` trio FIRST, then free disk / move the trio together / `HUB_DB=:memory:`; corrupt DB = record lost absent copies, backups arrive with §8.10; backup-before-upgrade convention for schema bumps); the closed-lid/graceful-shutdown gap EXPLICITLY remains open (spec §6.3) |
| tech-debt | — | one new numbered entry: no retention/compaction/backup — the events table grows without bound toward disk-full, whose failure mode is the documented crash-loop; §8.10's job (spec §6.2). Follow the file's existing numbering/format |

**Verify:** `grep -n 'HUB_DB' docs/PRD.md` hits the new §8.7 Today text;
`grep -ni 'closed lid\|graceful' docs/PRD.md` still names the gap as open;
`git diff docs/tech-debt.md | grep -cE '^\+[0-9]+\.'` → exactly 1, and
`git diff docs/tech-debt.md | grep -E '^\+' | grep -ci 'retention\|compaction'` ≥ 1;
`git diff --stat docs/` touches only `PRD.md` and `tech-debt.md`.
**Commit:** `docs: PRD §8.7 Today + retention debt entry for the record`
