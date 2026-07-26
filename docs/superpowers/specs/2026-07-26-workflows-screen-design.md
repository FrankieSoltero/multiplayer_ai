# Workflows Screen — Design

**Date:** 2026-07-26 · **Branch:** `feature/workflows-screen` (off main post-PR-#9)
**Status:** user-approved in brainstorm (scope, placement, wire approach, stop governance all locked 2026-07-26)

## 1. Goal

A `/workflows`-style live view of what the session agent has fanned out: every subagent /
background task the SDK runs, as a session-scoped tree with live progress and a driver-gated
STOP per running task. Sub-project A of the post-v6c arc (B = session initiation + directory
choice, C = launch-anywhere CLI — separate specs later).

## 2. Requirements (locked)

- **Separate screen** `?screen=workflows` using the v6a screen machinery: header button,
  `W` toggles (scoped off the arcade/input guards like `S`), `Esc` returns to the session.
- **Header button is the awareness signal**: shows `WORKFLOWS ▸ N` while N tasks are
  running, plain `WORKFLOWS` otherwise.
- **Watch + manage:** live task rows (description, subagent type / workflow name, status,
  tokens, tool uses, elapsed, last tool) plus a **STOP button on running rows, driver-only,
  attributed on the wire**. Stop is the only management primitive — the SDK exposes
  `stopTask(taskId)` and nothing else per-task (no pause/resume/re-run). Backgrounding is
  out of scope for v1.
- **Session-scoped.** This session's tasks only; cross-session awareness is v6b territory.
- **Append-only wire + client derivation** (standing architecture decision — approach
  chosen over server-side snapshot folding).

## 3. Wire

Two new members of `SessionEvent` (`poc/server/src/events.ts:14-36`):

```ts
| { type: "task_event"; taskId: string;
    subtype: "started" | "progress" | "updated" | "done";
    description?: string; subagentType?: string; workflowName?: string;
    status?: string; summary?: string; error?: string;
    tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string }
| { type: "task_stop"; taskId: string; userId: string }
```

- The relay (AgentDriver's message loop, `poc/server/src/agentDriver.ts:475` /
  handleMessage `:573ff`) gains a `message.type === "system"` branch mapping the SDK's four
  task subtypes onto `task_event`:
  - `task_started` → `started` (description, subagent_type, workflow_name; task_type
    ignored beyond workflow_name presence)
  - `task_progress` → `progress` (usage.total_tokens → tokens, usage.tool_uses → toolUses,
    usage.duration_ms → durationMs, last_tool_name → lastTool, summary)
  - `task_updated` → `updated` (patch.status → status, patch.description → description,
    patch.error → error)
  - `task_notification` → `done` (status — completed | failed | stopped, summary, usage
    fields as above)
- **Throttle `progress` only**: per-task latest-wins, at most one `task_event/progress`
  appended per 2s per taskId (the timer flushes the latest pending one). A task's `done`
  supersedes any pending progress and clears its timer (the terminal notification carries
  final usage, so nothing is lost); `started`/`updated` don't touch the throttle.
  `started`/`updated`/`done` are never throttled — terminal state is always exact.
- `task_stop` is appended **before** calling the SDK (wire honesty — the request is a fact
  even if the task finishes first).
- `skip_transcript` tasks are forwarded like any other — the SDK's own guidance is that a
  tasks panel is where they belong; the transcript already ignores what it ignores.

## 4. Server stop path

- New WS message `stop_task { taskId: string }` handled in `server.ts` beside
  `set_permission_mode` (`poc/server/src/server.ts:366ff`): **driver-only** (same rejection
  shape as the mode handler), append `task_stop { taskId, userId }`, then call
  `driver.stopTask(taskId)`.
- `AgentDriver.stopTask` delegates to `stream.stopTask?.(taskId)` — `stopTask?(taskId:
  string): Promise<void>` is added to the AgentStream interface as **optional** (like
  `supportedCommands?`, `poc/server/src/agentDriver.ts:74`); absent on a fake/old stream →
  no-op, failures caught and logged, never thrown into the WS handler.
- No synthesized confirmation: the SDK emits its own `task_notification` with status
  `stopped`, which flows through §3. Stopping an already-terminal task is harmless — the
  attributed attempt is on the wire; no `stopped` notification will follow and the row is
  already terminal.

## 5. Client derivation (`derive.ts`)

- `DerivedState.tasks: Map<string, TaskInfo>` — insertion-ordered fold of `task_event`:
  `TaskInfo { id, description, subagentType?, workflowName?, status, tokens, toolUses,
  durationMs, lastTool?, summary?, error?, stoppedBy? }`. `status` starts `"running"` on
  `started`, follows `updated`/`done` statuses; numeric fields update on any event carrying
  them. An `updated`/`progress`/`done` for an unknown taskId **creates** the row (events
  can interleave across turns; replay makes it whole).
- `task_stop` folds `stoppedBy` (userId) onto the row — resolved to a participant name at
  render time, shown as `⛔ stopped by <name>` once the status lands on `stopped` (and as a
  pending "stop requested by <name>" note while still running).
- Late joiners derive the complete history from replay; no snapshot needed.

## 6. Screen (`WorkflowsPanel.tsx`)

SkillsPanel idiom (pixel-frame panels, `.pix` labels, mono content), fed
`tasks`, `participants`, `isDriver`, `onStopTask`, `onBack`:

- **RUNNING section first**: status glyph (▶), description, tag line (`subagentType`, plus
  `workflowName` when present), live line `tokens · toolUses tools · elapsed · lastTool`,
  STOP button (rendered only for the driver; sends `stop_task`).
- **FINISHED section**: ✓ completed / ✗ failed (with error) / ⛔ stopped (+ `stopped by
  <name>`), summary line, final usage.
- Render cap: most recent 50 tasks (running always shown; cap trims oldest finished).
- Empty state: `no workflows this session — the agent spawns them when work fans out.`
- `taskLine.ts` pure formatter (the `pluginLine.ts` pattern) carries the testable string
  logic: status glyph selection, usage line formatting (token abbreviation `12.3k`,
  duration `1m 05s`), stop-attribution line.
- `App.tsx`: `screen` union gains `"workflows"`; header button with running count
  (`WORKFLOWS ▸ N`); `W` hotkey mirroring the `S` wiring (`poc/client/src/App.tsx:165-170`)
  incl. Esc-return and main-screen scoping; `useSessionSocket` gains the `stop_task` sender.
- Transcript untouched.

## 7. Error handling / edge cases

- Out-of-order arrival: any subtype creates the row (see §5); unknown statuses render
  verbatim rather than being dropped.
- Throttled progress: intermediate values may skip; terminals never do (§3).
- STOP for non-drivers: button not rendered (consistent with existing driver-only
  affordances); server still enforces (defense in depth, tested).
- `stopTask` SDK rejection (task already gone): caught server-side, no event — the wire
  keeps the attributed request; the row's terminal state comes from whatever the SDK
  actually emitted.

## 8. Testing

- **Server** (fake stream emitting SDK-shaped system messages): one forwarding test per
  subtype mapping; progress throttle (two rapid progresses → one event, latest values;
  `done` flushes immediately and clears the timer); `stop_task` handler — driver-only
  rejection, `task_stop` appended, fake's `stopTask` captured; absent `stopTask` on the
  stream → no throw.
- **Client**: derive folds (create-on-any-subtype, status transitions, stoppedBy,
  insertion order), `taskLine` formatter units, `modes`-style screen helpers if any.
- Baselines going in: server 123 / client 57. Manual demo: fan a subagent out from the live
  session, watch running → done; stop one mid-flight and see ⛔ + attribution.

## 9. Out of scope (YAGNI)

Pause/resume/re-run (no SDK support), backgrounding foreground tasks, cross-session task
views (v6b), task output/transcript inspection (output_file exists on the notification but
surfacing file contents is a different feature), server-side task snapshots, transcript
changes.
