# Project Hub with Agent-Side Awareness (v2) — Design

**Date:** 2026-07-24
**Status:** Approved by user
**Builds on:** v1 PoC (spec `2026-07-23-multiplayer-ai-design.md`) — merged to main; sessions, event logs, steering lock, WS hub, and client are reused unchanged unless stated.

## Context

v1 proved one shared live agent session. v2 proves the fuller vision: several engineers in one project, **each driving their own session/agent in their own git worktree**, with a shared awareness layer so every human and every agent maintains context on what the others are doing. Chosen awareness mechanism: **self-declared intent (Approach 2) grounded by a raw activity digest (Approach 1's floor)**. A dedicated project-observer agent (Approach 3) is explicitly the phase-3 path — the aggregation layer below is designed so an observer can replace/enrich it without schema changes. Visual design polish is deferred until after the demo works.

## Demo target (v2 acceptance)

Two sessions, `ana` and `ben`, separate worktrees of one demo repo, one project `demo`:
1. Ana prompts her agent with an auth-middleware→JWT migration task; her agent calls `set_intent` and the intent appears in Ben's teammates sidebar.
2. Ben prompts his agent for rate-limiting work; **without Ben mentioning Ana**, his agent's reply acknowledges Ana's in-flight migration (via the injected digest) and shapes its plan around it.

## Component design

### 1. Intent events (session log addition)

- New `SessionEvent` variant: `{ type: "intent_update"; text: string }` (text capped at 200 chars).
- Emitted by the agent through a **`set_intent` tool** exposed via the Agent SDK's in-process MCP server (`createSdkMcpServer` / `tool()` — exact API verified against the installed SDK at implementation time, adapting only at the SDK boundary, as in v1).
- Agent system prompt addition: declare intent when starting work; update when direction changes; one short sentence.
- `set_intent` failures degrade silently — intent is enhancement, never a blocker.

### 2. Digest injection (driver addition)

- When a user prompt arrives at session X, the driver prepends a `<teammates>` block to the prompt text before pushing to the SDK. For each *other* session in the project: current intent (latest `intent_update`, if any) + up to 5 most recent file-touching `tool_call` events (tool name + primary path/pattern arg), + a dead/ended marker if that session's driver died.
- Built by a **pure function** `buildTeammateDigest(others: SessionSummary[]): string` for testability.
- Empty when the project has no other sessions (no empty block emitted).
- Injection at prompt time only; async mid-turn injection is future work (with the observer agent).

### 3. Project registry (server addition)

- `Project` = id → set of member sessions. Sessions are created within a project (`join` message gains `projectId`).
- No separate project event log: per-session `intent` / `lastActivityTs` / participants are **derived** from session logs. This derivation seam is where a phase-3 observer agent would plug in.
- New server→client push: `{ type: "project", sessions: [{ id, participants, driverName, intent, lastActivityTs, ended }] }` sent to all connections in the project when any member session appends an interesting event (`intent_update`, presence, `user_message`), throttled to ≥1s between pushes per project.

### 4. Worktrees (per-session working directories)

- Session workdir = `AGENT_WORKDIR_ROOT/<sessionId>` when `AGENT_WORKDIR_ROOT` is set; otherwise v1 behavior (shared cwd) — nothing breaks without config.
- Session ids validated as slugs `[a-z0-9-]{1,40}` (server-side, prevents path traversal).
- `poc/scripts/demo-setup.sh` creates a tiny demo repo plus `ana`/`ben` git worktrees so the demo is one command.

### 5. Client: teammates sidebar

- Session view gains a sidebar: one card per other session in the project — participants, current intent (headline), relative last-activity, "drop in" link (`?project=X&session=Y`, reusing v1 replay/take-the-wheel wholesale), "ended" state for dead sessions.
- Own session's current intent shown under the header.
- URL scheme: `?project=demo&session=ana` (project defaults to `default`, session to `demo` for backward compatibility).

## Error handling

- Solo project → no digest, no sidebar cards, everything else as v1.
- Dead teammate session → card shows "ended", last intent preserved.
- Invalid `projectId`/`sessionId` slug → `{type:"error"}` on join.
- `set_intent` tool errors → logged as `agent_error`, agent continues.

## Testing

- **Unit (vitest):** `intent_update` append path from the tool handler; `buildTeammateDigest` pure-function cases (no teammates / intent only / intent + tool calls / dead session); project snapshot aggregation + throttle; slug validation.
- **Integration:** two WS sessions in one project — intent from one appears in the other's `project` push; digest injected into the second session's outgoing prompt (observable via fake RunQuery).
- **Acceptance (controller-run, Playwright, real agents):** the two-browser demo above; PASS requires Ben's agent's reply to reference Ana's declared work unprompted.

## Out of scope (v2)

Observer agent (phase 3), async mid-turn injection, auth, persistence across restarts, client auto-reconnect, visual design polish (explicitly deferred by user until demo works), cross-session merge tooling.
