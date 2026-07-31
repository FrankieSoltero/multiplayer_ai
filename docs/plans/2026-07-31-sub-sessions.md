# Sub-sessions (PRD §8.4) — implementation plan

**Spec of record:** `docs/specs/2026-07-31-sub-sessions-design.md` (approved 2026-07-31).
**Goal:** surface the SDK's already-forwarded subagent runs as swappable sub-session views with
attributed permission gates — two optional wire fields (`parentToolUseId` on the gate events,
`toolUseId` on `task_event` started), zero hub changes, zero new protocol messages.

**Architecture (3 sentences):** The server stamps an optional `parentToolUseId` onto gate events
by indexing the nested `tool_call` forwards it already emits, and forwards `task_started`'s
`tool_use_id` so the client can join tasks to sub-sessions. The client derives per-sub-session
summaries and event projections from the existing flat log — no server-side view state. The
session UI gains a rail of chips that swaps the transcript between MAIN and filtered sub-session
views, all client-local component state.

**Stack / suites:**
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (baseline 750 passing)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (baseline 350)
- client: `cd poc/client && npx tsc -b && npx vitest run` (baseline 391)
- Never predict post-change totals; read them from runs.

**Plan done gate (objective):** the plan is complete when Tasks 1–5 have landed and all three
suite commands above run fresh with exit code 0, zero failures, tsc clean in each package, and
no count below its baseline.

## Global Constraints

1. **Byte-identical unattributed events.** Every event that is unattributed today must serialize
   byte-identically after this change — no `parentToolUseId` KEY at all when absent. Use the
   conditional-spread pattern already used for `reason` (`agentDriver.ts:380-383`).
2. **Attribution is display metadata, never load-bearing.** No gate policy branch may read
   `parentToolUseId`. A failed attribution degrades to today's rendering, never to an error.
3. **No hub source changes.** `poc/hub/src/**` is frozen this cycle; the hub relays the new
   optional fields opaquely. (One hub TEST file changes — Task 1.)
4. **No protocol additions.** No new message types in either direction. `stop_task` is reused
   as-is.
5. **View state is client-local component state** — not synced, not persisted, not in the URL.
   Refresh lands on MAIN. A sub-session view exposes nothing not already present in the shared
   session log every participant receives — projection is display filtering, never access
   control.
6. **D8 invariants:** prompt bar always addresses the main agent; gates are decided from any
   view; nothing renders at project level; the wheel is untouched.
7. Solo/standalone and hub-relayed sessions behave identically (same driver, same event union).
8. **Rollback = revert the commit.** Every task is code-only and additive: the new fields are
   optional and non-load-bearing, so no data or state migration exists in either direction and
   unattributed events are unaffected by a revert.
9. **No coordinated deploy needed.** A new server sending `parentToolUseId`/`toolUseId` to an
   old client is ignored — true by construction: the client's `LoggedEvent`
   (`poc/client/src/types.ts`) is a loose all-optional-fields type over parsed JSON, so unknown
   keys are carried inertly. A new client reading old events without the fields degrades to
   today's rendering (everything lands on MAIN, unattributed) — pinned by Task 2's
   "old-event fixture" regression row. Server-first and client-first orderings are both safe.

## Task Dependency Table

| # | Task | Files touched | Depends on | Risk tier |
|---|------|--------------|------------|-----------|
| 1 | Server: gate attribution + task join field | `poc/server/src/events.ts`, `poc/server/src/agentDriver.ts`, `poc/server/src/permissions.ts`, `poc/server/test/agentDriver.test.ts`, `poc/server/test/permissions.test.ts`, `poc/hub/test/relayIntegration.test.ts` | — | standard |
| 2 | Client: sub-session derive functions | `poc/client/src/derive.ts`, `poc/client/src/derive.test.ts` | — (shapes pinned here) | standard |
| 3 | Client: Transcript compact rows + view rendering + gate prefix | `poc/client/src/components/Transcript.tsx`, `poc/client/src/components/Transcript.test.tsx` | 2 | standard |
| 4 | Client: SubSessionRail + App wiring + STOP | `poc/client/src/components/SubSessionRail.tsx` (new), `poc/client/src/components/SubSessionRail.test.tsx` (new), `poc/client/src/App.test.tsx` (new), `poc/client/src/App.tsx` | 2, 3 | judgment |
| 5 | Docs: PRD §8.4 update | `docs/PRD.md` | 1–4 landed | mechanical |

Tasks 1 and 2 are disjoint (different packages) and may run concurrently. Task 3 and 4 are
serial after 2 (and 4 after 3: both consume Transcript's new props and App owns the state).

---

## Task 1 — Server: gate attribution + task join field

**Spec:** §2.2 (gate attribution) + §2.1 (task join). Wording reconcile: spec §2.2 titles gate
attribution "the one wire change" — that counts `parentToolUseId` on both gate events as one
mechanism; this plan's "two optional wire fields" adds §2.1's task-join pin (`toolUseId` on
`task_event` started, which §2.1 defers to plan time). Same scope, different bucketing — no
contradiction. The two mechanisms land atomically on purpose: both edit the same three source files and the same test files, and the client's task
join (Task 2) consumes both fields together — splitting them would only serialize two
file-locked micro-commits with no independent review value.

**Files:** modify `poc/server/src/events.ts`, `poc/server/src/agentDriver.ts`,
`poc/server/src/permissions.ts`; tests `poc/server/test/agentDriver.test.ts`,
`poc/server/test/permissions.test.ts`, `poc/hub/test/relayIntegration.test.ts`.

**Interfaces — produces:**

`events.ts` (exact unions after change):
```ts
| { type: "permission_request"; requestId: string; toolName: string; input: unknown; reason?: string; parentToolUseId?: string }
| { type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string; auto?: true; parentToolUseId?: string }
```
`task_event` gains `toolUseId?: string` (populated only on `subtype: "started"`, from the SDK
message's `tool_use_id` — field already exists on `task_started` per sdk.d.ts:4466-4468; add
`tool_use_id?: string` to the `SdkMessage` interface declared in `agentDriver.ts:31-47`; the
mapping site is `handleTaskMessage`, `agentDriver.ts:944`).

`DriverHooks.onPermissionRequest` (agentDriver.ts) gains a 4th parameter:
```ts
onPermissionRequest: (toolName: string, input: unknown, signal?: AbortSignal,
                      meta?: { toolUseId?: string; agentId?: string }) => Promise<"allow" | "deny">;
```
`buildCanUseTool` (permissions.ts) passes `meta` on the final driver-ask path — the
`hooks.onPermissionRequest(toolName, input, options.signal)` call inside the closing
`try` block (currently `permissions.ts:337`): `{ toolUseId: options.toolUseID, agentId:
options.agentID }` (SDK option names verbatim: `toolUseID`, `agentID`).

**Driver mechanism:** maintain a private `Map<string, string>` (`subCallParents`:
inner toolUseId → parentToolUseId). Populate in the streaming handler's branch that appends
`tool_call` events — the site with the `...(parentId ? { parentToolUseId } : {})` conditional
spread (currently `agentDriver.ts:824`) — when BOTH the event's own `toolUseId` and `parentId`
are present; delete the entry in the branch that appends `tool_result` events (the matching
conditional-spread site, currently `agentDriver.ts:895`) for the same toolUseId. Resolution:
`parentToolUseId = meta?.toolUseId ? subCallParents.get(meta.toolUseId) : undefined`. Store the
resolved value in the `pendingPermissions` record — post-change record shape:
`{ toolName, input, contestedPath, resolve, parentToolUseId?: string }` (one new optional key)
— so every decision path can inherit it. Blast radius of the map: entries whose tool_result
never forwards (abort/crash) persist only for the driver instance's lifetime, are bounded by
tool-call volume, and CANNOT misattribute — SDK tool_use ids are unique, so a stale key is
never looked up again (constraint 2: non-load-bearing display metadata either way).

**Behavior table:**

| case | input/state | expected | test file |
|---|---|---|---|
| attributed request | canUseTool fires for a tool call whose toolUseID is in `subCallParents` (auto mode off) | `permission_request` carries `parentToolUseId` = mapped parent (meta pass-through on the driver-ask path itself is additionally unit-covered in `permissions.test.ts`) | `agentDriver.test.ts` |
| decision inherits (driver) | driver resolves that gate via `resolvePermission` (`agentDriver.ts:555`) | its `permission_decision` carries the same `parentToolUseId` | `agentDriver.test.ts` |
| decision inherits (auto) | permissionMode `auto`, uncontested, attributed call | BOTH the `permission_request` and the `auto: true` decision carry the field | `agentDriver.test.ts` |
| decision inherits (abort) | SDK aborts a pending attributed gate | the system-attributed deny (`userId: "system"`) carries the field | `agentDriver.test.ts` |
| main-agent call | toolUseID not in map (or meta absent) | request/decision byte-identical to today — no key present (assert via `JSON.stringify` or `"parentToolUseId" in ev === false`) | `agentDriver.test.ts` |
| interleaved concurrency | TWO sub-agents active at once (parents P1, P2), their tool calls and gates interleaving, deletes arriving out of order | every `permission_request`/`permission_decision` is attributed to its OWN parent — P1's gates never carry P2's id and vice versa (spec §3's named concurrency mandate; this is where a shared map with out-of-order deletes would break) | `agentDriver.test.ts` |
| index lifecycle | nested tool_result forwarded for toolUseId X | `subCallParents` no longer holds X (assert indirectly: a later gate with meta.toolUseId X is unattributed) | `agentDriver.test.ts` |
| plan gate untouched | ExitPlanMode flow | `plan_request`/`plan_decision` unchanged — no attribution | `agentDriver.test.ts` |
| bookkeeping unaffected | TodoWrite from a subagent | still auto-allowed with no gate events (existing behavior) | `permissions.test.ts` |
| task join field | SDK `task_started` message with `tool_use_id: "toolu_X"` | `task_event` (subtype `started`) carries `toolUseId: "toolu_X"`; absent `tool_use_id` ⇒ no key | `agentDriver.test.ts` |
| task join scope | wire `task_event`s of subtype `progress`, `updated`, `done` (the SDK's `task_progress`/`task_updated`/`task_notification` mappings in `handleTaskMessage`, `agentDriver.ts:944`) | never carry `toolUseId` | `agentDriver.test.ts` |
| hub round-trip (gate) | publish a `permission_request` with `parentToolUseId` through the relay integration harness | replayed event carries the field character-identically | `relayIntegration.test.ts` |
| hub round-trip (task) | publish a `task_event` (subtype `started`) with `toolUseId` through the relay integration harness | replayed event carries the field character-identically | `relayIntegration.test.ts` |

**Exact values:** field name `parentToolUseId` (matches the existing streaming-event field);
`meta` shape as above. No new constants.

**TDD:** write each behavior-table row as a failing test FIRST (watch it red), then the
implementation that turns it green.
**Verify:** the server and hub suite commands from the header; both exit 0 with 0 failures and
tsc clean. Row-to-test convention: each behavior row's test title starts `T1-<row-name>`
(e.g. `it("T1-attributed-request …")`) in the test file its row names, so coverage is checked
mechanically — every row name above must appear in a test title (a green suite alone does not
prove new cases are covered).
**Commit:** `feat(server): attribute permission gates and task starts to their sub-session`

---

## Task 2 — Client: sub-session derive functions

**Spec:** §2.1 (identity, label, status, task join) + §2.3 (projection is a filter over the
flat log) + §2.5 (heartbeat-only chip).

**Files:** modify `poc/client/src/derive.ts`, `poc/client/src/derive.test.ts`.
Note: `poc/client/src/types.ts`'s flat `LoggedEvent` already has optional
`parentToolUseId`/`toolUseId`, and `taskId`/`subtype` are already present for WorkflowsPanel —
types.ts should need NO change. If verification shows a field genuinely missing from the flat
type, adding it as `?:` is the ONLY permitted types.ts change.

**Interfaces — produces (exact):**
```ts
export interface SubSessionInfo {
  key: string;                       // spawning Task/Agent tool_use id
  label: string;                     // input.description ?? subagentType ?? key
  status: "running" | "done";
  gatePending: boolean;              // undecided permission_request attributed to key
  taskId?: string;                   // joined via task_event started.toolUseId === key
}
export function deriveSubSessions(events: LoggedEvent[]): SubSessionInfo[];
export function subSessionEvents(events: LoggedEvent[], key: string): LoggedEvent[];
```

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| discovery + order | two top-level `tool_call`s with toolName `Task`/`Agent` and toolUseIds A then B | `deriveSubSessions` returns [A, B] in spawn order |
| label precedence | spawning call has `input.description` "scan tests" | label "scan tests"; if absent, the `subagentType` field of the joined `task_event` (subtype `started`, joined via its `toolUseId`); if both absent, the key itself |
| status | top-level `tool_result` for A present | A.status "done"; else "running" (mirror `deriveTranscriptGroups` logic, derive.ts:172) |
| heartbeat-only chip | events carry `parentToolUseId` C but no top-level spawning call for C | C still listed (label falls back), status "running" — degrade, don't drop |
| gatePending true | `permission_request` with `parentToolUseId` A and no matching `permission_decision` | A.gatePending true |
| gatePending false | matching decision exists (any decider, incl. auto) | false |
| task join | `task_event` started with `toolUseId` A and `taskId` "t1" | A.taskId "t1" |
| projection: nested | `subSessionEvents(events, A)` | every event with `parentToolUseId === A` (streaming events AND attributed gate events), in log order |
| projection: task rows | task join gave A → "t1" | all `task_event`/`task_stop` with `taskId === "t1"` included, merged in log (seq) order |
| projection: exclusion | main-agent events, other sub-sessions' events, unattributed gates | never included |

Notes: (1) projection exposes nothing not already in the shared session log — both functions
are pure filters over events every participant already holds (constraint 5). (2) A NESTED
sub-agent's events carry the OUTER parent's key (the SDK stamps the top-level spawning call's
id), so they render flat inside the outer parent's view — per spec §4, nested hierarchy is
out of scope; no row models it and none should be added.
| no sub-sessions (the "old-event fixture") | a log captured from TODAY's event shapes — no `parentToolUseId` on gates, no `toolUseId` on task_events, no subagent markers | `deriveSubSessions` returns `[]`; existing derive outputs unchanged (this row doubles as the constraint-9 new-client/old-events cross-version proof) |

**TDD:** write each behavior-table row as a failing test FIRST (watch it red), then the
implementation that turns it green.
**Verify:** the client suite command from the header; exits 0 with 0 failures, `tsc -b` clean.
Row-to-test convention: each behavior row's test title starts `T2-<row-name>` in
`derive.test.ts`, so coverage is checked mechanically — every row name above must appear in a
test title.
**Commit:** `feat(client): derive sub-session summaries and view projections`

---

## Task 3 — Client: Transcript compact rows, view rendering, gate prefix

**Spec:** §2.3 (MAIN compact rows, the view as a filter, gate prefix `⚒ <label>`, gates
decidable from any view — D8). The three rendering concerns land together deliberately: all
three are branches of the same render pass over the same grouped event list — the compact row
IS the collapsed form of the view's content, and the gate prefix reads the same label index the
other two consume. Splitting them would put three sequential writers on one component file.

**Files:** modify `poc/client/src/components/Transcript.tsx`,
`poc/client/src/components/Transcript.test.tsx`.

**Interfaces — consumes:** `deriveSubSessions`, `subSessionEvents` (Task 2, signatures above).
**Interfaces — produces (exact new props, all optional so App compiles unchanged until Task 4):**
```ts
interface TranscriptProps {
  // ...existing props unchanged...
  view?: string | null;                    // null/undefined = MAIN; else sub-session key
  onOpenSubSession?: (key: string) => void;
}
```

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| MAIN compact row | `view` null, log has a subagent group for key A labeled "scan tests", 7 rows, running | the group renders as ONE row (no `<details>` body): text contains `⚒ SUB-QUEST`, "scan tests", "running…", "7 rows", "open ▸"; clicking it calls `onOpenSubSession("A")` |
| MAIN done row | same, tool_result arrived | row shows "done", still clickable |
| no handler | `onOpenSubSession` undefined (pre-Task-4 App) | row renders, click is a no-op, nothing throws |
| sub-session view | `view` = A | body renders exactly `subSessionEvents(events, A)` through the existing `renderEvent`, flat (no nesting), auto-scroll behavior preserved |
| view of unknown key | `view` = key with no events | empty body, no crash |
| gate prefix | `permission_request` event with `parentToolUseId` A (label "scan tests") renders in ANY view | its card is prefixed `⚒ scan tests` before the existing gate text |
| unattributed gate | no `parentToolUseId` | card byte-identical to today (regression row) |
| gate decidable in view | `view` = A, undecided gate attributed to A, viewer is driver | the SAME decide controls render as in MAIN and invoke the existing decision callback with that `requestId` — the D8 "decided from any view" invariant, exercised as an action, not just display |
| existing rendering regression | log with main-only events | output unchanged vs today's snapshot expectations |

**Exact values:** compact row text pieces: `⚒ SUB-QUEST`, `<label>`, `running…`/`done`,
`<N> rows`, `open ▸` (existing summary vocabulary — keep the existing `lamp`/`lamp done`
class markers). `⚒ SUB-QUEST` is the deliberate fixed marker carried over from today's
collapsible rendering — a literal, not a placeholder to substitute. Gate prefix format: `⚒ <label>`; label obtained by calling
`deriveSubSessions(props.events)` and indexing the result by the gate event's
`parentToolUseId` (no separate label helper is exported).

**TDD:** write each behavior-table row as a failing test FIRST (watch it red), then the
implementation that turns it green.
**Verify:** the client suite command from the header; exits 0 with 0 failures, `tsc -b` clean.
Row-to-test convention: each behavior row's test title starts `T3-<row-name>` in
`Transcript.test.tsx`, so coverage is checked mechanically — every row name above must appear
in a test title.
**Commit:** `feat(client): swappable sub-session transcript views with attributed gates`

---

## Task 4 — Client: SubSessionRail + App wiring + STOP

**Spec:** §2.3 (rail, chips, badges, client-local swap, STOP) + §2.1 (task-join enrichment) +
§2.5 (no chip cap / horizontal scroll) + D8 invariants. STOP is deliberately co-located with
the rail rather than split out: the STOP control lives in the view header that this task's App
wiring creates, and both consume the same `SubSessionInfo.taskId` join — all three pieces are
rail-centric cohesion, not an accidental bundle. The view-header enrichment is not a rider but
intrinsic to this task: the header does not exist until this task's App wiring creates it, and
creating the header and populating it (label, status, enrichment fields, STOP) are one
behavior — there is no earlier task it could land in. No feature flag is needed: the change is inert for existing
sessions (rail renders null when no sub-sessions exist, view state defaults to MAIN, all new
fields/props are optional, unattributed events are byte-identical).

**Files:** create `poc/client/src/components/SubSessionRail.tsx`,
`poc/client/src/components/SubSessionRail.test.tsx`, and `poc/client/src/App.test.tsx` (new —
no App test exists today; it carries the App-wiring rows); modify `poc/client/src/App.tsx`.

**Interfaces — consumes:** `SubSessionInfo`/`deriveSubSessions` (Task 2); Transcript's
`view`/`onOpenSubSession` props (Task 3); existing `send({type:"stop_task", taskId})` path and
`derived.tasks` map; existing `isDriver`.

**Interfaces — produces (exact):**
```ts
interface SubSessionRailProps {
  subSessions: SubSessionInfo[];
  view: string | null;
  onSelect: (key: string | null) => void;   // null = MAIN
}
export function SubSessionRail(props: SubSessionRailProps): JSX.Element | null;
```

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| hidden when empty | `subSessions: []` | rail renders nothing (null) — today's layout untouched for sessions without sub-agents |
| chips | 2 sub-sessions | rail shows `MAIN` chip + one `⚒ <label>` chip each, spawn order, active chip visually marked (class `active`) |
| swap | click chip A / click MAIN | `onSelect("A")` / `onSelect(null)` |
| gate badge | A.gatePending true | A's chip shows a pending marker (class `gated`, text `!`) |
| done styling | A.status done | chip gets class `done` (muted), remains clickable — done-detection is Task 2's derive, mirroring `deriveTranscriptGroups` (derive.ts:172: done on the spawning call's top-level `tool_result`) |
| App state | user clicks chip A | App holds `subSessionView` state, passes `view`/`onOpenSubSession` to Transcript and `view`/`onSelect` to the rail; MAIN compact-row click opens the same view |
| view reset on session switch | navigating to a different session (URL change remount) | view state resets to MAIN (component state — free; add a row asserting initial state is null) |
| STOP visible | view = A, A.taskId "t1", `derived.tasks.get("t1")` running, viewer is driver | view header area shows `■ STOP`; click sends `{type:"stop_task", taskId:"t1"}` |
| STOP hidden | non-driver, or no taskId join, or task not running | no STOP control |
| view header enrichment | view = A, taskId "t1", `derived.tasks.get("t1")` carries status/summary/tokens | the view header line shows the task's status, plus the summary and token count when present — exact accessor keys pinned: `derived.tasks.get(taskId).status`, `.summary`, `.tokens` (spec §2.1 enrichment — all three named fields) |
| project level untouched | full plan file set | no project-level component (`ProjectPicker.tsx`, `SessionPicker.tsx`, machine/record panels) is touched by any task — the D8 "never at project level" invariant holds by construction; Verify pins it via the scoped-diff check |
| chip overflow | many sub-sessions (e.g. 12) | every chip renders — no cap; the rail container scrolls horizontally (`overflow-x: auto`), never wraps into the transcript area (spec §2.5) |
| prompt bar invariant | any active view | PromptBar props/behavior untouched — prompting still targets the main agent; wheel controls unchanged |
| screens coexist | `screen` = workflows/skills/oversight/invite | rail does not render on those surfaces; only on the default transcript surface |

**Exact values:** chip classes `active`, `gated`, `done`; MAIN chip literal text `MAIN`;
badge text `!`. Mount point: in `App.tsx`, immediately before `<Transcript>` inside the
`<div className="row">` container of the default session surface (currently `App.tsx:560-561`;
`Header` precedes at `:533` — there is no "stats bar" element in the session surface).
View header: rendered by App directly between the rail and `<Transcript>` when `view !== null`,
one line — `⚒ <label> · <status>` then ` · <summary>` and ` · <tokens> tok` when present —
with the `■ STOP` button at its right end when visible (element class `subsession-header`).

**TDD:** write each behavior-table row as a failing test FIRST (watch it red), then the
implementation that turns it green.
**Verify:** the client suite command from the header; exits 0 with 0 failures, `tsc -b` clean.
Row-to-test convention: each behavior row's test title starts `T4-<row-name>` — rail-only rows
in `SubSessionRail.test.tsx`; App-owned rows (App state, view reset, STOP visible/hidden, view
header enrichment, prompt bar invariant, screens coexist) in `App.test.tsx` — so coverage is
checked mechanically: every row name above must appear in a test title. Scoped-diff check:
`git diff --name-only main` for the branch shows no project-level component files (the
"project level untouched" row).
**Commit:** `feat(client): sub-session rail — swap, gate badges, and driver stop`

---

## Task 5 — Docs: PRD §8.4 update

**Spec:** §0 R1–R3 (the rulings the PRD must record) + §2.4 (what did not change).

**Files:** modify `docs/PRD.md`.

**Behavior table:**

| case | expected |
|---|---|
| §8.4 *Today* | rewritten to state: sub-sessions exist as swappable views (rail + filtered projections over the parent's single log), gates attributed `⚒` and decided on the parent, driver STOP, spawn is agent-initiated |
| §8.4 *Open* question (line ~449) | REMOVED as open; replaced with the ruling: shared parent worktree (spec R1, 2026-07-31) |
| §8.4 *Final state* | marked shipped at code level, citing the spec file path |
| No other PRD sections edited | diff touches §8.4 block only |

**Verify:** all four rows, each with a concrete check — (1) `command grep -n "shared parent
worktree" docs/PRD.md` hits inside §8.4 (the ruling row); (2) `command grep -n "swappable
views" docs/PRD.md` hits in §8.4's *Today* block; (3) `command grep -n
"2026-07-31-sub-sessions-design" docs/PRD.md` hits in §8.4's *Final state* line; (4)
`git diff --name-only` for the commit lists `docs/PRD.md` only, and `git diff docs/PRD.md`
touches no hunk outside the §8.4 block. No suite impact.
**Commit:** `docs(prd): §8.4 sub-sessions shipped — worktree fork closed as shared`
