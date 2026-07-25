# v5a — Agent-Harness Capabilities (Design)

Date: 2026-07-25 · Status: user-approved in brainstorm; pending written-spec review
Predecessors: v4 spec `2026-07-24-product-design-terminal-multiplayer.md` (merged, PR #1). All v1–v4 decisions stand.

## Goal

Give the shared multiplayer agent the visible surface of a real agent harness:
slash-command skill invocation (any member suggests, driver approves), first-class
rendering of skill invocations and subagent activity, a live party-visible todo
panel, and a driver-controlled plan-approval gate.

**v5b (games roster + party high score) is explicitly out of scope** — separate
spec → plan → implementation cycle after v5a merges.

## Approach (ratified)

Append-only wire extension; server stays relay + approval gate; client `derive.ts`
builds entities from the flat event stream. Consistent with the v2–v4 event-sourced
architecture; late-joiner replay keeps working by construction. A server-side
stateful entity model was considered and rejected (breaks replay, grows server
responsibility for no added capability).

Live acceptance (2026-07-25) found the installed SDK names these tools
differently than assumed above: it has no `TodoWrite` (task tools —
`TaskCreate`/`TaskUpdate` — instead), and its subagent-spawning tool is named
`Agent`, not `Task`. Corrected against the installed SDK; see §2 and §3 below.

## 1. Wire protocol (append-only additions to `poc/server/src/events.ts`)

```ts
| { type: "skill_roster"; skills: { name: string; description: string }[] }
| { type: "skill_suggest"; suggestId: string; userId: string; skill: string; args: string }
| { type: "skill_decision"; suggestId: string; decision: "run" | "dismiss"; userId: string }
| { type: "todo_update"; todos: { text: string; status: "pending" | "in_progress" | "completed" }[] }
| { type: "plan_request"; requestId: string; plan: string }        // markdown plan body
| { type: "plan_decision"; requestId: string; decision: "approve" | "reject"; userId: string }
| { type: "permission_mode_change"; mode: "plan" | "default"; userId: string }
```

Plus `parentToolUseId?: string` on the existing `tool_call`, `tool_result`, and
`agent_text_delta` events — present iff the traffic originates from a subagent
(the SDK already tags these messages with `parent_tool_use_id`; the driver
currently drops the tag) — and `toolUseId?: string` on `tool_call`/`tool_result`
(the SDK block id), without which a subagent's `parentToolUseId` has no spawning
`Task` call to match for labeling and running/done status.

`permission_mode_change` (added during planning) logs the driver's plan-mode
toggle and the automatic switch back to default on plan approval, so the whole
party — and late joiners via replay — can see the current mode.

- **No new event for skill invocations**: a skill run is a `tool_call` with
  `toolName: "Skill"`; the client promotes it by inspecting the input.
- `todo_update` is snapshot-style (latest wins), so replay converges.
- `skill_roster` is sent to each client on join, built once from `AGENT_SKILLS`.
- Semantics: `skill_suggest` may come from any member. The driver's
  `skill_decision: "run"` makes the server enqueue the skill prompt attributed to
  the **suggesting** user. `plan_request` is emitted when the agent's plan-exit
  tool call arrives at `canUseTool`; `plan_decision` resolves that held gate.

## 2. Server

### `poc/server/src/agentDriver.ts`

- **Lineage plumbing:** copy the SDK's `parent_tool_use_id` onto emitted
  `tool_call` / `tool_result` / `agent_text_delta` events. No behavior change.
- **Todos:** `canUseTool` auto-approves `TodoWrite` — or the live SDK's
  `TaskCreate`/`TaskUpdate` equivalents (today it pauses for driver
  approval — noise for internal bookkeeping); the driver emits `todo_update`
  from the tool input. Only main-agent `TodoWrite`/`TaskCreate`/`TaskUpdate`
  calls mirror to the panel; subagent todo calls (parent id set) are excluded.
- **Plan mode:** driver-toggled, wired exactly like v4's model switch — an
  optional `setPermissionMode` member on `RunQueryResult` so test fakes stay
  assignable. Toggle-on logs optimistically (a trailing `agent_error` means the
  switch may not have taken — the documented `setModel` caveat applies). When
  the agent calls its plan-exit tool, `canUseTool` holds it and emits
  `plan_request`. `approve` → allow the call and `setPermissionMode("default")`;
  `reject` → deny, agent revises (further `plan_request`s in the same turn are
  legal).
- **Skill runs:** on `skill_decision: "run"`, enqueue a prompt on the existing
  prompt queue instructing the agent to invoke the named skill with the given
  args via the Skill tool, attributed to the suggesting user. Busy-agent
  suggestions therefore just queue — no new busy machinery.

### `poc/server/src/server.ts`

Four new client→server messages:

| Message | Sender | Validation |
|---|---|---|
| `suggest_skill` | any member | skill must be in roster. If the sender is the current driver, the server auto-emits the matching `skill_decision: "run"` — a driver slash-run is one message, not two |
| `decide_skill` | driver only | same guard as `set_model`; suggestId pending |
| `decide_plan` | driver only | requestId pending |
| `set_permission_mode` | driver only | mode ∈ {plan, default} |

Rejections error only to the sender (existing validation pattern). Decision
rights validate against the **current** driver at decision time, so a wheel
handoff mid-pending-plan/suggestion transfers decision rights automatically.

### `poc/server/src/session.ts`

No structural change; new events flow through the existing log/replay path.

## 3. Client

### `poc/client/src/derive.ts` (pure module)

- Events with `parentToolUseId` fold into a **subagent group** keyed by the
  spawning `Task`/`Agent` `tool_call`; status = running until the parent
  `tool_result` arrives. Orphan parent ids (no matching Task/Agent call in
  view) render as an "unknown subagent" group — never a derivation crash.
- `tool_call` with `toolName: "Skill"` → **skill entity** (name + args parsed
  from input, paired with its `tool_result`).
- Latest `todo_update` → todo panel state. `plan_request` without a matching
  `plan_decision` → pending plan. `skill_suggest` without a `skill_decision` →
  pending suggestion.

### Components (`poc/client/src/components/`)

- **Transcript:** subagent groups render as collapsible nested blocks
  (collapsed by default: glyph, task description, status, row count). Skill
  entities render as a distinct card (name badge + args, collapsible output)
  instead of a generic tool row.
- **PlanCard (new):** pending plan inline in the transcript like a permission
  request — markdown body, "Approve" / "Request revision" buttons for the
  driver (mapping to wire `approve` / `reject`), read-only for passengers.
- **TodoPanel (new):** checklist with status glyphs, mounted in the right
  column with PartyPane, hidden when empty.
- **PromptBar:** `/` opens roster-driven autocomplete. Driver submit → runs
  immediately (server emits the suggest+decision pair so the transcript record
  is uniform). Passenger submit → `suggest_skill`, rendered as a pending chip
  with Run/Dismiss buttons active only for the driver. Plan-mode toggle sits
  next to the model picker, driver-only.

Styling stays inside the existing `terminal.css` token system; no new
dependencies; components remain verified by build + live acceptance (client
unit tests stay node-env pure-module only).

## 4. Testing

- **Server (vitest):** driver guards on all four new messages; roster
  validation; TodoWrite auto-approve + `todo_update` emission; full plan gate
  (hold → approve/reject → mode switch); skill-run enqueue attribution;
  lineage plumbing.
- **Client (node-env):** `derive.ts` — subagent grouping, skill entity pairing,
  todo latest-wins, pending suggest/plan resolution, orphan fallback.
- **Acceptance:** build clean; live walkthrough — passenger suggests a skill →
  driver runs it; subagent fan-out renders as a collapsed group; plan mode
  toggled, plan revised then approved.

## 5. Delivery order (risk-based, for the plan)

1. Lineage plumbing + derivation + rendering (low risk, no new interaction).
2. Todo mirror + TodoPanel.
3. Skill roster + slash autocomplete + suggest/approve flow.
4. Plan mode toggle + plan gate.

## 6. Open items (carried, not blocking v5a)

- v3 ratification items and v4 §7 decisions (party pane <900px, stale spec
  skill name, structural polish list, old screenshots) remain batched in
  `HANDOFF.md` §7.
- Stream-death-mid-turn busy-stick remains parked (v4 minor).
