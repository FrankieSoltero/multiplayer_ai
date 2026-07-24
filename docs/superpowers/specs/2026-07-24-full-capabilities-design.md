# Full Claude Code Capabilities + Driver Approval Gate (v3) — Design

**Date:** 2026-07-24
**Status:** Approved by user (design approved verbally; plan not yet written)
**Builds on:** v2 (spec `2026-07-24-project-hub-awareness-design.md`) on branch `feature/project-hub`, including the write-access commit `489b27d` and the proven parallel-build/merge experiment.

## Goal

Give per-session agents the full Claude Code capability set — Bash, subagents (Task), WebSearch/WebFetch, TodoWrite, and project-scoped Skills — governed by a **driver approval gate** that is itself a multiplayer feature. Then: refresh the multiplayer-AI research, and afterwards run a dedicated "video-game feel" design phase (user's locked aesthetic direction; NOT part of this spec's implementation scope).

## Decisions (user-approved, with rationale)

- **Bash safety = driver approval gate** (chosen over auto-approve and over skipping Bash): commands pause the agent and render Approve/Deny in the driving user's UI; the whole session sees what was approved and by whom. Trivially-safe command prefixes auto-approve so agents can test their own code.
- **Skills = project-scoped opt-in** (chosen over mirroring personal config): `.claude/skills/` inside the project repo, versioned with the code, identical for every teammate's agent. The v2 isolation (`settingSources: []`, `strictMcpConfig: true`) stays; skills are the single explicit re-opening.

## Component design

### 1. Capability expansion (agentDriver.ts)

- `tools: { type: "preset", preset: "claude_code" }` — full built-in set (verified shape in installed sdk.d.ts).
- `allowedTools` unchanged in spirit: auto-approve `Read, Glob, Grep, Write, Edit, mcp__awareness__set_intent`; everything else (Bash, Task, WebSearch, WebFetch, ...) routes through `canUseTool`.
- `skills` option (`string[] | 'all'`, sdk.d.ts ~line 1914) loads project skills; implementation must verify exact semantics (names vs paths; interaction with `settingSources: []` and the session's worktree cwd) against the installed SDK and adapt at the boundary only.
- Demo repo (`poc/scripts/demo-setup.sh`) gains a small example skill under `.claude/skills/` so the demo shows an agent invoking one.

### 2. Driver approval gate

- `DriverHooks` gains `onPermissionRequest(toolName: string, input: unknown) => Promise<"allow" | "deny">`, wired to the SDK's `canUseTool` (`CanUseTool` → `Promise<PermissionResult | null>`, sdk.d.ts ~lines 206–266, options key ~1361).
- New session events (shared log = audit trail visible to all):
  - `permission_request { requestId, toolName, input }`
  - `permission_decision { requestId, decision: "allow" | "deny", userId }`
- Wire: driver's client renders a request card with Approve/Deny buttons (enabled only for the current wheel-holder); sends `{ type: "permission", requestId, decision }`; server validates the sender is the CURRENT driver at decision time and resolves the pending promise.
- Wheel handoff mid-request: the new driver can decide — a teammate can drop in specifically to approve something (the harness thesis in one interaction). Pending requests survive driver leave; the agent waits (SDK pauses on the unresolved promise).
- Auto-approve allowlist (configurable const): command prefixes `npx vitest`, `npx tsc`, `npm test`, `git status`, `git diff`, `git log`. Prefix match on the Bash `command` input only; everything else asks.
- Denials return a deny PermissionResult with a short reason so the agent adapts rather than stalls.

### 3. Research refresh (parallel to implementation)

Two research agents: (a) harness-competitor deep-dive — Zed agent collaboration, GitHub Ace maturity re-check, Amp/Factory evolution; (b) general multiplayer-AI sweep since the last report. Findings folded into `docs/research-report.md` as a dated addendum section, including the v2/v3 build-experiment evidence (parallel agents, footprint minimization, predicted merge conflict).

### 4. Game-feel design phase (direction locked, scope deferred)

After capabilities land: dedicated design phase using the frontend-design skill. Direction notes captured for that phase: session-as-party/lobby metaphors, avatars, intents as quest-log entries, project minimap — to be explored properly then, not now.

## Error handling

- `canUseTool` promise rejection/abort → deny with reason, `agent_error` logged, agent continues.
- Permission decision from a non-driver → `{type:"error"}` (same pattern as prompt gating).
- Unknown `requestId` decision → error, ignored.
- Skills dir absent → agent runs without skills, no error.

## Testing

- Unit: allowlist prefix matcher; permission event append flow (fake hooks); driver-only decision enforcement; decision-after-wheel-change accepted from new driver.
- Integration (fake RunQuery extended with a hook-triggered permission request): request event reaches all watchers; non-driver decision rejected; driver decision resolves and `permission_decision` logged.
- Acceptance (controller-run, live): agent runs `npx vitest`-style command via allowlist without asking; agent proposes a non-allowlisted Bash command → driver approves in UI → command runs; a second user takes the wheel and decides a pending request; agent uses the project skill.

## Out of scope (v3)

OS-level sandboxing for Bash (approval gate is the PoC boundary), personal-skills mounting, the game-feel redesign itself, agent-assisted merge (candidate for v4), auth/persistence (unchanged accepted scope).
