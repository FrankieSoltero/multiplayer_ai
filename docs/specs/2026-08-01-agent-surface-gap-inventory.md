# §8.6 The agent surface — gap inventory (design input, 2026-08-01)

**Why this exists:** PRD §8.6 ("Claude Code parity, in the UI", D9) says the section "cannot be
scoped from memory — needs a gap inventory against Claude Code as its first task." This is that
inventory: a three-way diff of what the Claude Agent SDK exposes, what our driver wires, what
Claude Code's TUI surfaces, and what our session UI shows today. Sources: SDK
`@anthropic-ai/claude-agent-sdk@^0.3.218` (`poc/server/node_modules/.../sdk.d.ts`), driver
`poc/server/src/agentDriver.ts`, client `poc/client/src`, Claude Code v2.1.220 + official docs.

Verdicts: **WIRED** (end to end), **PARTIAL** (some of it reaches the wire), **DROPPED** (the SDK
emits it, the driver reads nothing), **ABSENT** (neither SDK nor we have it; TUI-only).

## 1. Usage / cost / context — the biggest hole, and our own UI is waiting for it

| Capability | Status | Evidence |
|---|---|---|
| result `total_cost_usd`, `usage`, `modelUsage`, durations, `num_turns` | **DROPPED** — `result` only triggers `turn_end`, zero fields read | agentDriver.ts:920-931; sdk.d.ts:4239-4290 |
| `SDKResultError` subtypes + `errors[]` + `permission_denials[]` + `terminal_reason` | **DROPPED** — error results indistinguishable from success | sdk.d.ts:4239-4257 |
| `rate_limit_event` (5h/7d utilization) | **DROPPED** | sdk.d.ts:4207-4237 |
| `Query.getContextUsage()`, `usage_EXPERIMENTAL` | **UNUSED** | sdk.d.ts:2411, 2425 |
| assistant-message `usage`, `SDKThinkingTokensMessage` | **DROPPED** | agentDriver.ts:841-849, 996-998 |
| Our CONTEXT HUD segment, PARTY XP, TURN elapsed | **placeholders, never fed** | Header.tsx:10-21 |
| `?screen=status` HP/MP bars | **self-described design screen, "bars await usage wiring"** | AgentStatus.tsx:29-49 |
| Claude Code: `/usage` ($, durations, per-model tokens, 5h/7d plan bars, per-skill attribution), `/context` grid, context-low warnings | reference parity target | docs.claude.com costs/commands |

**Read:** every number our HUD was designed to show is already on the wire inside the SDK; the
driver folds it all into a bare `turn_end`. This is surfacing, not machinery — and it completes
UI we shipped as placeholders.

## 2. Session control — the missing STOP

| Capability | Status | Evidence |
|---|---|---|
| `Query.interrupt()` | **UNUSED** — no human "stop the turn" path; only `stopTask` for sub-tasks | sdk.d.ts:2274; agentDriver.ts:705-726 |
| resume / checkpoints / rewind / fork / persistSession | **UNUSED** — dead driver = "restart the server" (agentDriver.ts:538) | sdk.d.ts:1784-1796, 2467 |
| Claude Code: Esc interrupts mid-stream keeping completed work | reference | interactive-mode docs |

**Read:** interrupt is one driver call + one wire message + one button, and it is load-bearing
for the wheel primitive (you cannot hand back a turn you can't stop). Rewind/checkpoints are a
real design (driver persistence, the record's relationship to rewound history) — NOT this cycle.

## 3. Errors & status signals — the transcript lies by omission

`SDKResultError` subtypes, `terminal_reason`, assistant `error` field, `system/api_retry`,
`system/permission_denied`, `system/status` (compacting/requesting), model refusal-fallback pair
(`supersedes`/`aborted` on assistant frames) — all **DROPPED** (agentDriver.ts:835-951,
996-998). The client shows a generic error line or nothing; a rate-limited, budget-killed, or
interrupted turn looks exactly like a finished one. Refused-then-retried content can sit in the
transcript with no eviction signal.

## 4. Compaction — invisible

`system/compact_boundary` (pre/post tokens), `system/status` compacting — **DROPPED**
(sdk.d.ts:2922, 4369). Claude Code warns + shows auto-compact; we show nothing, and any future
context meter lies without it.

## 5. Subagents / tasks — one boolean and one dropped path away

| Capability | Status | Evidence |
|---|---|---|
| `Options.agentProgressSummaries` | **UNUSED** — `task_event.summary` is wired end to end but stays empty without this flag | sdk.d.ts:1780; agentDriver.ts:1011-1021 |
| `task_notification.output_file` (full subagent transcript path) | **DROPPED** | sdk.d.ts:4430; agentDriver.ts:1030-1044 |
| `tool_use_result` structured outputs on user messages | **DROPPED** (only ≤2000-char text extracted) | agentDriver.ts:932-949; sdk.d.ts:4549-4633 |
| `backgroundTasks()` + `background_tasks_changed` | **UNUSED/DROPPED** | sdk.d.ts:2556, 2894 |
| `tool_progress` heartbeat, `tool_use_summary` | **DROPPED** | sdk.d.ts:4519, 4540 |

## 6. Roster freshness — a real bug, small fix

Driver fetches the skill roster once (`supportedCommands()`, agentDriver.ts:518-532) and ignores
`system/commands_changed`; `reloadSkills()`/`reloadPlugins()` exist but are never called, so
`plugin_change` (events.ts:43) never hot-reloads the running SDK session. New skills are
invisible until restart.

## 7. Permissions — parity beyond our three modes

SDK offers six modes (`default/acceptEdits/bypassPermissions/plan/dontAsk/auto`); driver only
ever sets `default`/`plan` (relay `auto` is answered driver-side). Gate enrichments —
`suggestions`/`updatedPermissions` ("always allow" rules), `title`/`displayName`/`description`,
`matchedAskRule` — all **DROPPED** (sdk.d.ts:206-266; permissions.ts reads signal/toolUseID/
agentID only). Claude Code's "Yes, don't ask again" has no equivalent. This is a design cycle of
its own (rule storage, multiplayer rule ownership) — named for a later phase.

## 8. Streaming & transcript fidelity

`includePartialMessages` token streaming **UNUSED** ("deltas" are whole assistant blocks);
`thinking`/`redacted_thinking` blocks **DROPPED**; `prompt_suggestion` **UNUSED**. Token
streaming changes event volume and the record's shape — a design decision, not a patch.

## 9. MCP / hooks / effort

SDK hooks (30 events) entirely **UNUSED** (`PostToolUse` would be the natural touched-set
invalidator — today it's an event-log heuristic). MCP lifecycle (`mcpServerStatus`, elicitations)
**UNUSED** (we run one in-process server by design). `effort`/thinking budgets **UNUSED**;
Claude Code ships `/effort`, thinking toggle, `/fast`, `/advisor`.

## 10. Consciously out of scope (product shape, not neglect)

Claude Code TUI idioms that don't map to a multiplayer web product: image paste, vim mode,
voice dictation, `/theme` variants (our two-theme system is the answer), custom statusline
scripts, fullscreen transcript viewer, `/diff` viewer, `/copy` picker, `Ctrl+R` history search,
`/btw`, `/desktop`/`/teleport`/`/mobile` handoffs, workspace-trust dialog (our pairing model is
the answer), `/chrome`, agent teams. Prompt history/multiline are reasonable web-input
improvements but are UX polish, not agent-surface parity — not this cycle.
