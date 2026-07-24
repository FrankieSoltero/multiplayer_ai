# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-24, just before v2 execution start.*

## 1. Goal & current task

**Project goal:** Startup exploration of YC's Fall 2026 "Multiplayer AI" RFS (dev-tools vertical). v1 (DONE, merged to main) proved one shared live agent session. **Current task: execute the v2 plan** — "Project Hub with Agent-Side Awareness": multiple engineers each drive their own agent session in their own git worktree within one project; agents declare intent via a `set_intent` MCP tool and receive a `<teammates>` digest of other sessions at prompt time.

## 2. Status

- v1: **complete** — merged to main at `ad791fb`, 19/19 tests, live Playwright acceptance PASSED.
- Research report: **complete** — `docs/research-report.md` (conditional GO).
- v2 spec + plan: **committed** (`df1c713`, `b5235d4`), user-approved.
- v2 execution: **COMPLETE on `feature/project-hub`** (8 commits, 82f1cd9..4a4faff): all 6 tasks done + reviewed; live acceptance PASSED decisively (Ben's agent unprompted flagged the concrete conflict with Ana's in-flight work); 31/31 server tests, tsc clean, client builds. Live runs caught + fixed: agent inheriting personal MCP servers (strictMcpConfig + settingSources []), skipped set_intent (first-action mandate), stale sidebar on agent_error/control_change. **Stopped exactly at: user chose to review the branch personally (Option 3 — keep as-is). Branch `feature/project-hub` is unmerged, preserved at 4a4faff. Next session: collect the user's review feedback, address it (subagent-driven, with re-review), then re-offer merge/PR. Do NOT merge or delete anything until the user gives a verdict.**

## 3. Decisions + why (do not re-litigate)

- **Awareness = Approach 2 + 1** (agent self-declared intent + raw activity digest floor). Observer agent (Approach 3) is explicitly phase-3 — user likes it; the derivation seam in `projectSnapshot` is where it plugs in later.
- **A-shape architecture** (own agent + own worktree per engineer + shared awareness), NOT one shared filesystem — avoids file-locking/CRDT warfare; git stays the merge substrate. v1's drop-in/take-the-wheel is the "same room" escape hatch at session granularity.
- **Digest injected at prompt time only** (deterministic, demoable); async mid-turn injection deferred with the observer agent.
- **Log stays clean:** digest goes to the SDK prompt only; session log records raw user text.
- **`tools` vs `allowedTools` (hard-won):** `tools` restricts built-in tool set; `allowedTools` only auto-approves. MCP tool id is `mcp__awareness__set_intent` — goes in `allowedTools`, NOT in `tools`.
- **SDK user-message shape** is nested: `{type:"user", message:{role:"user", content:[...]}, parent_tool_use_id: null}` (installed sdk.d.ts, not the flat docs shape).
- **Visual design polish deferred** until the v2 demo works (user's explicit call).
- **Process:** subagent-driven-development — fresh implementer per task (haiku for verbatim-transcription tasks, sonnet for judgment/integration), sonnet reviewers, review gate per task, fix→re-review loops, final whole-branch review on the most capable model. This caught 5 real bugs in v1; keep it.

## 4. Ordered next steps

1. `git checkout -b feature/project-hub` (from main at `b5235d4`).
2. Run SDD per `docs/superpowers/plans/2026-07-24-project-hub-awareness.md` (6 tasks): for each task N — `<superpowers-skill-dir>/subagent-driven-development/scripts/task-brief docs/superpowers/plans/2026-07-24-project-hub-awareness.md N`, dispatch implementer (Task 1: sonnet — SDK boundary; 2: haiku; 3: sonnet — integration; 4: haiku; 5: haiku; 6: controller-run), then `scripts/review-package BASE HEAD`, dispatch reviewer, fix→re-review until approved, append to ledger `.superpowers/sdd/progress.md`.
3. Task 6 acceptance is controller-run via Playwright MCP tools (two tabs, `?project=demo&session=ana|ben`); `ANTHROPIC_API_KEY` is set in this environment so real agents work.
4. Final whole-branch review (fable/opus) with deferred-minors triage → one fix subagent → re-review.
5. finishing-a-development-branch skill (tests → 4 options → likely merge to main per user pattern).

## 5. Files with line refs (current state on main)

- Plan (v2, execute this): `docs/superpowers/plans/2026-07-24-project-hub-awareness.md` (full code per task; Tasks 1–6)
- Spec (v2): `docs/superpowers/specs/2026-07-24-project-hub-awareness-design.md`
- `poc/server/src/agentDriver.ts:31-33` RunQuery type (Task 1 changes to 2-param with hooks); `:35-60` runAgentQuery (gets MCP server + mcpServers option); `:62-88` AgentDriver ctor + sendPrompt (ctor gains workdir, sendPrompt gains contextBlock); `:65` dead flag (Task 1 adds `isDead` getter)
- `poc/server/src/server.ts:19-31` startServer + session map (Task 3 replaces file wholesale — plan has full replacement); `:58-83` join handler; `:87-99` prompt handler
- `poc/server/src/session.ts:8` participants Map (Task 3 adds `participantList` getter after `:36`)
- `poc/server/src/events.ts:9` last union member (Task 1 appends `intent_update`)
- `poc/client/src/App.tsx:41-42` URL parsing (Task 5 adds project param); `:44-64` ws effect (join gains projectId; onmessage gains project case); `:70-81` derived state (add myIntent); `:118-163` transcript (add intent_update case; wrap in `.workspace` flex with teammates aside)
- v1 spec/plan for reference: `docs/superpowers/specs/2026-07-23-multiplayer-ai-design.md`, `docs/superpowers/plans/2026-07-23-multiplayer-ai.md`
- SDD ledger: `.superpowers/sdd/progress.md` (gitignored via .git/info/exclude; v1 history + minors deferred list lives here)
- Skill scripts: `/Users/franciscosoltero/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development/scripts/{task-brief,review-package}`

## 6. Gotchas / constraints

- **`Docs/` == `docs/`** on this macOS FS — always write lowercase `docs/` (git tracks that casing).
- **SDD reviewers sometimes derail into a GitHub-PR workflow** — every reviewer prompt must say "LOCAL review, no gh, your final message IS the review, read-only". One v1 reviewer also stalled on SendMessage resume; prefer fresh reviewer dispatches over resuming.
- **v1 fakes stay assignable** after RunQuery gains the hooks param (fewer-params functions are assignable in TS) — do not "fix" them.
- **Existing v1 tests must pass unmodified** (21 tests after v2 Task 1-2 additions; v1 baseline was 19).
- The client has **no auto-reconnect**; server restart (tsx watch on edit) drops tabs — reload tabs during acceptance.
- zod v4 required for `tool()` shapes (`npm install zod` in poc/server is plan Task 1 Step 1).
- Background security scans fire on commits touching server.ts — missing-auth findings are spec-accepted PoC scope; don't churn on them.
- `.superpowers/` is git-excluded; review packages/briefs/reports live there and survive nothing — the ledger is the recovery map (`git log` corroborates).
- Demo worktrees: `poc/scripts/demo-setup.sh` creates `poc/demo-project` + `poc/demo-worktrees/{ana,ben}`; server needs `AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees`.

## 7. Open questions

- Whether the live agent reliably calls `set_intent` from the system-prompt instruction alone — Task 6 acceptance will tell; if it doesn't, options are stronger prompt wording or forcing an intent on first prompt. Not resolvable before live testing.
- Whether `tools: [...]` restriction coexists cleanly with `mcpServers` tools in the installed SDK (typed OK per sdk.d.ts, unverified live). Task 6 verifies; fallback is dropping `tools` and using `disallowedTools`.
- v2 report update (research-report.md §3 mentions only v1) — decide at final review whether to append a v2 findings paragraph or leave for a later pass.

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git checkout feature/project-hub
git log --oneline | head -3        # expect 4a4faff (final fix), bc4fd36, 94b5d29
cat .superpowers/sdd/progress.md   # v1 AND v2 complete through final review; branch merge-ready
cd poc/server && npx vitest run    # expect 31 passed (31); main still has 19
```

Branch: `feature/project-hub` exists, complete, unmerged — user is reviewing it personally. Trust the ledger + `git log` over memory. Demo: `poc/scripts/demo-setup.sh`, then server with `AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees npm run dev` (poc/server), client `npm run dev` (poc/client), URLs `?project=demo&session=ana` / `session=ben`.
