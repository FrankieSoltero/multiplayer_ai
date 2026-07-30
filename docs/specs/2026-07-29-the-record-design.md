# The Record — durable hub storage + project-scoped record (PRD §8.7, D11)

*Spec of record for the §8.7 branch. Written 2026-07-29 via soltero-skills:lean-brainstorming.
User-approved choices: durability = everything; summary = derived/deterministic; storage =
SQLite (better-sqlite3); scope includes a record UI view.*

## 1. Problem

The hub's entire state is in memory (`poc/hub/src/hubStore.ts:74-78`). A hub restart loses every
project, membership, session, and event. PRD §8.7 makes two things product requirements:

1. **Durable hub-side storage** — survives a hub restart and a laptop vanishing mid-work.
2. **A record built continuously at turn boundaries, not written at close** — a project-scoped
   answer to "what happened, who drove what, what changed, what was approved and by whom" (D11:
   the project is the unit of record).

## 2. Shape of the solution

Two layers, cleanly separated:

- **Durability** (§3): a write-through SQLite journal under the existing `HubStore`, plus boot-time
  hydration. The in-memory store stays the read path and the source of truth for live routing;
  SQLite makes it survive restarts. No behavior change visible to laptops or browsers except that
  history is still there after a restart.
- **The record** (§4): a **pure function** over the stored events — no LLM, no new state — exposed
  through one new request/reply pair on the browser protocol and rendered by a new panel on the
  project screen (§5).

"Built continuously at turn boundaries" is satisfied by construction: every event (including
`turn_end`) is durable at the moment it is accepted, so the record is always current up to the last
accepted event — nothing waits for session close.

## 3. Durability

### 3.1 Storage engine and location

- `better-sqlite3` (+ `@types/better-sqlite3`), WAL mode. Synchronous API matches `HubStore`'s
  synchronous design. (`node:sqlite` rejected: still experimental on Node 22.)
- DB path from env `HUB_DB`; default `.mpai-hub/hub.db` relative to the hub's cwd (directory
  created if missing). `HUB_DB=:memory:` gives an ephemeral hub (tests, throwaway dev).
- `startHub` opts gain `dbPath?: string` so tests inject temp files / `:memory:` directly.

### 3.2 Schema (v1)

```sql
meta            (key TEXT PRIMARY KEY, value TEXT)          -- schema_version = '1'
projects        (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                 created_by TEXT, created_at TEXT NOT NULL, lifecycle TEXT NOT NULL)
project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL,
                 PRIMARY KEY (project_id, user_id))
machines        (uplink_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                 name TEXT NOT NULL, repos_json TEXT NOT NULL)
sessions        (project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 uplink_id TEXT NOT NULL, facts_json TEXT NOT NULL,
                 last_run_id TEXT, last_seq INTEGER NOT NULL,
                 PRIMARY KEY (project_id, session_id))
events          (project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 id INTEGER NOT NULL, run_id TEXT NOT NULL, event_json TEXT NOT NULL,
                 PRIMARY KEY (project_id, session_id, id))
```

Boot refuses a DB whose `schema_version` is newer than it understands (fail fast, §3.6).

### 3.3 Write path

A `HubPersister` interface with a no-op default injected into `HubStore` (constructor arg), so the
existing test suite runs untouched. `SqlitePersister` implements it. Persisted mutations:

| Store mutation | Persisted as |
|---|---|
| `createProject` / `ensureProject` | upsert `projects` row (+ creator into `project_members`) |
| `joinProject` / `leaveProject` | insert/delete `project_members` row |
| `setLifecycle` | update `projects.lifecycle` |
| `attach` / `setRepos` | upsert `machines` row (wholesale `repos_json`, mirroring memory) |
| `setFacts` | upsert `sessions` row (`facts_json`) |
| `publish` | insert accepted `events` rows + update `sessions.last_run_id/last_seq`, **one transaction per frame** |

**Invariant — durable before visible:** within `publish`, accepted events are committed to SQLite
*before* they are applied to memory and fanned out to watchers. A browser can never see an event a
restarted hub would have forgotten.

Not persisted (runtime-only, by design): uplink `online` flags, sockets, watcher sets,
`pendingReplyFrom`. After a restart every hydrated machine reads `offline` until it re-attaches.

### 3.4 Boot hydration

`main.ts`/`startHub` opens the DB, hydrates a `HubStore` (projects, members, machines-as-offline,
sessions with facts + `lastRunId`/`lastSeq`, events), then serves. Hydration must reconstruct a
store whose `snapshot()`, `listProjects()`, `eventsFor()` and `resumeOffsets()` answers are
byte-equivalent to the pre-restart store's (modulo `presence: offline`) — this equivalence is the
core property test (§7).

### 3.5 Crash-repair via the existing resume protocol

`resumeOffsets` already tells a reconnecting laptop the hub's high-water mark per session, and the
laptop replays only the gap. With hydration, a hub crash between accept-and-commit boundaries heals
automatically: the hub reports its last *durable* seq, the laptop re-sends from there, dedup in
`publish` (`hubStore.ts:338`) drops overshoot. No new protocol needed — this is the §8.7 "laptop
vanishing mid-work" story too: its events up to the last delivered frame are already durable.

### 3.6 Error handling

- **Boot:** DB unopenable / newer schema / corrupt → the hub refuses to start, loudly. A hub that
  silently runs non-durable would present a record it cannot honor (PRD: "not infrastructure to be
  deferred"). `:memory:` is the explicit way to opt out.
- **Runtime write failure** (disk full, I/O error): the error propagates — the hub process exits
  rather than continuing with memory ahead of disk. §3.5 makes restart-after-crash cheap and
  correct. No catch-and-carry-on path.

## 4. The record — pure derivation

New pure module in the server package (beside `arcadeRecordsFrom`, same reuse pattern):
`poc/server/src/record.ts`, exported as `multiplayer-ai-server/record`, consumed by hub, standalone
server, and (types) client.

### 4.1 Turn segmentation

Per session, events split into **turns**: a turn opens at the first event after the previous
`turn_end` (or log start) and closes at `turn_end`. A trailing unclosed group is one **in-progress**
turn. Derived per turn:

- `driver`: userId of the turn's opening `user_message`; else the most recent `control_change`
  user at that point; else `null` (system/auto turns).
- `prompt`: first `user_message` text in the turn (truncated to a fixed cap, exact cap in the plan).
- `startTs` / `endTs`: first / last event `ts` in the turn.
- `toolCounts`: `toolName → count` from `tool_call`.
- `filesChanged`: best-effort `input.file_path` strings from `tool_call` where `toolName` ∈
  {Edit, Write, NotebookEdit} — deduped, order-preserving. Best-effort is acceptable and stated;
  a Bash `mv` is invisible and that is fine for v1.
- `approvals`: `permission_decision` (requestId, toolName resolved from its `permission_request`,
  decision, userId, `auto` flag carried) and `plan_decision` (decision, userId).
- `errors`: count of `agent_error`.

### 4.2 Project record shape

```
ProjectRecord = {
  projectId,
  sessions: [{ sessionId, machineId, repoKey, lifecycle, intent,
               turns: TurnRecord[], closedBy: userId | null }],
  rollup: { perUser: [{ userId, turnsDriven, approvalsGiven, denialsGiven }],
            totalTurns, totalSessions }
}
```

Exact TypeScript types live in `record.ts` and are the contract; the plan pins them.

### 4.3 Protocol

- Browser → hub: `{ type: "get_record", projectId }`.
- Hub → browser: `{ type: "record", projectId, record: ProjectRecord }` (or the standard error
  shape on refusal).
- **Access rule: `get_record` is allowed exactly where `watch_project` is allowed** — the record
  exposes nothing `watch_project`'s event stream doesn't already stream. Unauthenticated access
  follows whatever gate `watch_project` has today; no new gate class is invented.
- **Standalone-server parity** (standing ruling from §8.2): the solo server answers `get_record`
  from its own in-memory log via the same pure module. No SQLite on the laptop server — PRD §8.7
  places durability hub-side only.
- v1 is request/reply: the client fetches on panel open and refetches on each `project` push it
  already receives. No live record stream (non-goal §6).

## 5. UI — the record view

- New `poc/client/src/components/RecordPanel.tsx` + pure view-model helpers in
  `poc/client/src/recordView.ts` (testable without React, house pattern).
- Entry point: a `RECORD` toggle on the project screen (`SessionPicker.tsx`), sibling to the
  existing panels. Shows: per-user rollup line, then sessions (machine, repo, lifecycle) with
  their turn timeline — driver, time, prompt (truncated), tools, files changed, approvals with
  decider, in-progress marker on an open turn.
- Solo mode shows the same panel for its single project (parity, §4.3).
- Arcade theme only, matching everything else today; AA contrast floor applies. No new theme work
  (§8.9's job).

## 6. Non-goals (explicit, so nobody rediscovers them as gaps)

1. **LLM prose summaries** — the record is deterministic; prose can layer on later.
2. **Retention / compaction / size caps** — §8.10 (operating a hub). Unbounded growth is accepted
   for this section and recorded in `docs/tech-debt.md` when the branch lands.
3. **Graceful-shutdown signal for a closed lid** (laptop vanishing vs cleanly restarting still look
   identical) — laptop-side lifecycle work, orthogonal to storage; stays on §8.7's "Today" list.
4. **Hub-scoped session ids** — pre-existing bound (`hubStore.ts:270-278`), unchanged.
5. **Solo-laptop durability** — the standalone server's log stays in-memory.
6. **Live record streaming** — request/reply + refetch is v1.

## 7. Testing

- **Hydration equivalence property** (the load-bearing test): build a store through arbitrary
  realistic mutation sequences → persist → hydrate fresh → `snapshot()` / `listProjects()` /
  `eventsFor()` / `resumeOffsets()` byte-equivalent (modulo presence).
- **Restart integration on the real relay↔hub harness** (`relayIntegration.test.ts` — the harness
  that has caught a Critical on first contact twice): publish through a real uplink, stop the hub,
  restart on the same file, laptop reconnects and replays the gap, a browser replay from 0 sees
  identical history exactly once.
- **Durable-before-visible**: a watcher never receives an event that isn't committed (ordering
  pinned by test).
- **Record derivation**: pure tests over event fixtures — turn segmentation (incl. unclosed turn,
  zero `turn_end`, driver fallback chain), approvals resolution, filesChanged dedup.
- **Protocol + gating**: `get_record` parity between hub and standalone server; access rule matches
  `watch_project`; unknown project answered with an empty record, not a creating read
  (`readSessionsOf` discipline, `hubStore.ts:236-245`).
- **UI**: `recordView.ts` pure tests; render test for the panel toggle.
- All game/turn/derivation tests follow house rules: revert-and-rerun (every new test must fail on
  the old code), no predicted suite totals.

## 8. Open questions (not blocking this branch)

1. Should a machine's *repo history* (repos it used to offer) persist, or only its latest set?
   v1 persists latest-only, mirroring memory's wholesale-replacement rule (`hubStore.ts:170`).
2. When hub-scoped session ids arrive (spec §9 sibling), the `(project_id, session_id)` PK gains a
   migration — schema_version exists for exactly that.
