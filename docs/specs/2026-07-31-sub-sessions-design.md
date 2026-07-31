# Sub-sessions (PRD §8.4) — design of record

*2026-07-31. Approved rulings from the question round are §0; everything else follows from them
plus PRD D8. Supersedes nothing — sub-sessions had no prior spec.*

---

## 0. Rulings (user-approved, session #26)

- **R1 — Shared worktree.** A sub-session runs in its parent session's worktree, on the parent's
  branch. No per-sub-session worktrees, no merge-back machinery, no branch naming. This matches
  Claude Code's model and the SDK default. *Accepted bound:* parallel sub-agents can write the
  same tree; work is typically partitioned by prompt, and everything lands on the session's one
  branch. The PRD §8.4 "Open" question is hereby CLOSED: shared.
- **R2 — Agent-initiated spawning only.** Sub-sessions come into existence when the agent uses
  its Task/Agent tool — the driver steers by prompting. No UI spawn control this cycle.
- **R3 — Transcript + gates only.** The sub-session view shows that sub-session's transcript and
  its attributed permission gates. Subagent TodoWrite/TaskCreate bookkeeping stays dropped
  (`agentDriver.ts` gates the todo mirror on `!parentId` — unchanged). The todo panel remains
  main-agent-only.
- **D8 consequences restated as requirements:** sub-sessions never appear at project level; a
  sub-session's permission gate surfaces (and is decided) on the parent; take-the-wheel operates
  on the parent only. The prompt bar always addresses the main agent regardless of active view.

## 1. What already exists (verified 2026-07-31, main @ 0a5ae4a)

The SDK + driver plumbing is largely in place; §8.4 is a surfacing cycle.

- `forwardSubagentText: true` is already set (`poc/server/src/agentDriver.ts:246`): the full
  subagent conversation arrives with `parent_tool_use_id`, read at `:808` and stamped as
  `parentToolUseId` onto three wire events — `agent_text_delta` (`:815`), `tool_call` (`:824`),
  `tool_result` (`:895`). Main-agent events omit the field.
- Task lifecycle events exist: `task_event` (`poc/server/src/events.ts:44-48` — `taskId`,
  `subtype started|progress|updated|done`, `subagentType?`, `workflowName?`, status/summary/
  tokens/toolUses/lastTool) and `task_stop` (`:49`). `stopTask` is wired (`agentDriver.ts:673-679`)
  and the client's Workflows panel already renders the task map with a driver-only ■ STOP.
- The client derives subagent groups from the one flat log: `deriveTranscriptGroups`
  (`poc/client/src/derive.ts:172-214`) keys groups on `parentToolUseId`, labels them from the
  spawning `Task`/`Agent` `tool_call.input.description` (`:176-184`), and flips status to done on
  the spawning call's top-level `tool_result` (`:185-187`). `Transcript.tsx:300-311` renders them
  as collapsible "⚒ SUB-QUEST" `<details>` blocks inline.
- Subagent tool calls pass through the SAME permission gate as main-agent calls
  (`permissions.ts:277-352`; no branch on parent) — decided by the parent session's driver. The
  SDK's `canUseTool` options carry `toolUseID` and, for sub-agent calls, `agentID`.

**The three gaps this cycle closes:**

1. **No swappable view.** Sub-agent output only renders as inline collapsibles; there is no way
   to view one sub-session as its own surface, and heavy sub-agent traffic buries the main
   transcript.
2. **Gates are unattributed.** `permission_request`/`permission_decision` events carry no
   sub-session marker (`events.ts:31`), so the gate UI cannot say WHICH sub-session is asking.
3. **(Deliberately kept, not closed:)** subagent bookkeeping dropped — R3.

## 2. Design

### 2.1 Sub-session identity

A **sub-session** is one spawned subagent run, keyed by the spawning `Task`/`Agent` tool call's
`toolUseId` — the same value nested events carry as `parentToolUseId`. Label = the spawning
call's `input.description`, falling back to `subagentType`, then the key. Status = running until
the spawning call's top-level `tool_result` arrives (existing derive logic). Where a `task_event`
maps to the same run (background tasks), its status/summary/tokens enrich the row; the exact
`taskId ↔ toolUseId` join is pinned at plan time from the SDK's task system messages.

### 2.2 Server/driver: gate attribution (the one wire change)

`permission_request` and `permission_decision` events gain an **optional** `parentToolUseId`
field, populated when the gate was raised by a sub-agent's tool call. Source: the `canUseTool`
options (`agentID`/`toolUseID`) mapped to the spawning tool_use id; the mapping table lives in
the driver beside the existing task bookkeeping. Optional field ⇒ wire-compatible both
directions; hub relays it opaquely (zero hub changes). A gate the driver cannot attribute is
emitted exactly as today (no field) and renders exactly as today — attribution is best-effort
display metadata, never load-bearing for the gate decision itself.

### 2.3 Client: the swap

- **Sub-session rail.** The session view gains a compact rail (header strip under the stats bar):
  `MAIN` plus one chip per sub-session — glyph ⚒, label, running/done state, and a pending-gate
  badge when that sub-session has an undecided gate. Ordered by spawn time; done chips decay to
  muted styling but remain for the session's lifetime (the log is append-only; the record IS the
  product).
- **The view is a filter, not a fork.** Clicking a chip swaps the transcript area to a projection
  of the same flat event log: events whose `parentToolUseId` equals the key, plus that
  sub-session's attributed gate events, plus its `task_event` rows. `MAIN` shows what it shows
  today, except sub-agent runs render as ONE compact row each (label · status · row count ·
  "open ▸") instead of the full nested `<details>` body — the detail moved to the view.
- **View state is client-local** (component state; not synced, not persisted, not in the
  protocol). Every participant swaps independently — a sub-session is a view, not a peer (D8).
  Deep-linking/URL state is explicitly out: refresh lands on MAIN.
- **The prompt bar, wheel, and gate DECIDING stay parent-scoped and view-independent.** Gates
  render in the gate surface regardless of which view is active, prefixed `⚒ <label>` when
  attributed. Whatever view you're in, prompting prompts the main agent.
- **STOP.** When a sub-session row maps to a stoppable task (`taskId` known), the view header
  carries the existing driver-only stop control (`stop_task` — protocol unchanged).

### 2.4 What does NOT change

- **Hub:** nothing. All events already flow through the parent session's single append-only log
  and relay; the new optional field rides along opaquely.
- **Record (§8.7):** nothing. Sub-session activity is already inside the parent session's log and
  therefore the record; attribution enrichment of the record is future work, not this cycle.
- **Project level:** nothing renders. Sub-sessions never appear in project lists or session rows
  (D8).
- **Permission gate semantics:** identical policy path for sub-agent and main-agent calls
  (existing behavior, now with display attribution).
- **Solo/standalone parity:** the standalone server uses the same driver and event union; the
  feature works identically without a hub.

### 2.5 Defaults chosen (flagged for approval)

- Rail chips: no hard cap; if the count is absurd the rail scrolls horizontally. (Typical counts
  are single digits.)
- A sub-session with zero forwarded text (heartbeat-only) still gets a chip — it can still raise
  gates.
- Arcade skin keeps the existing "SUB-QUEST" vocabulary for sub-sessions; PRD terminology
  ("sub-session") is used in Clean-facing copy and code identifiers.
- `permission_decision` inherits attribution from its `permission_request` (same gate id) rather
  than being independently attributed by the driver.

## 3. Testing

- **Driver (server suite):** attributed `permission_request` carries `parentToolUseId` for a
  sub-agent tool call and omits it for main-agent calls; unattributable gates emit today's shape
  byte-for-byte; the agentID→toolUseId mapping survives interleaved concurrent sub-agents.
- **Derive (client suite):** view projection filters correctly (nested events + attributed gates
  + task rows; nothing else); MAIN's compact rows replace nested bodies; pending-gate badge
  derivation.
- **Components:** rail renders/swaps; gate card prefix; STOP visibility driver-only; prompt bar
  unaffected by active view.
- **Relay integration (existing harness):** the optional field round-trips the hub unchanged.

## 4. Out of scope (explicit)

UI spawn control (R2); per-sub-session todos (R3); per-sub-session worktrees or merge-back (R1);
sub-session-level wheel or prompting; project-level surfacing (D8); persisting or syncing view
state; record-schema attribution enrichment; subagent nested-sub-agent recursion in the UI (a
sub-agent's own children render flat inside its view).
