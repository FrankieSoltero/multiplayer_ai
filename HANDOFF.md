# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-24, v3 demo run live for user; pivoting into product design (Claude-Code-shell base + game-feel flourishes).*

## 0. WHERE WE ARE (v3 done + demo'd live; product design phase STARTING)

Three things were queued after v2. Status now:
1. **Full Claude Code capabilities + driver approval gate (v3)** — ✅ **COMPLETE** on `feature/project-hub` (commits `85a3999..6735d4e`). Full `claude_code` tool preset; Bash/Write-outside-worktree/etc. gated by a per-request driver Approve/Deny that is itself multiplayer (any teammate can take the wheel to decide a pending request); allowlisted safe commands auto-run; file writes contained to the agent's worktree; project skills via `AGENT_SKILLS`. 60/60 server tests, tsc clean, client builds. Live Playwright acceptance PASSED all four scenarios. Final whole-branch review (fable): **Merge-ready**.
2. **Research refresh** — ✅ **COMPLETE** — dated addendum appended to `docs/research-report.md` (commit `970e062`). Headlines: Amp shipped "Multiplayer" 2026-07-22; Warp Remote Control clears the co-drive bar (≥3 shipping now); VS Code 1.129 shipped Microsoft's Agent Host Protocol (meets the report's NO-GO precondition sooner than expected); Windsurf→Devin Desktop; GitHub Ace now live technical preview. No competitor combines our shared-session + take-the-wheel + agent-awareness + multiplayer-approval-gate stack. Conditional GO survives; incumbent clock faster.
3. **Product design phase** — ⏳ **STARTING NOW** (the current work). Direction pivoted 2026-07-24 after the live demo. NOT "video game feel" alone, and NOT plain Claude-Code-clone alone — a **MIX**:
   - **Base aesthetic = the Claude Code terminal shell** ("essentially match the same shell as claude code"): monospace, dark, boxed input, the CLI tool-call rendering style, sparse chrome. This is the frame the whole product lives in.
   - **Game-feel flourishes layered on top.** Headline example the user gave: a **Google-Chrome-dino-style offline mini-game shown while the agent is thinking/working** (fills the wait; playable during agent turns). Plus the earlier game motifs still on the table (avatars, intents-as-quest-log, party/lobby framing) — subordinate to the shell, not replacing it.
   - **Agent/model choice is now product vision** — "whatever agent the user chooses is thinking": the user picks which agent/model drives a session; the thinking-state mini-game and identity reflect the chosen agent. (Today the driver is hardcoded to claude-opus-4-8 in agentDriver.ts systemPrompt/model — this becomes user-selectable.)
   - **Two deliverables the user asked for, in parallel:** (a) a **design context file to hand off to "Claude Design"** (an external design agent) — a self-contained brief with product, current UI, the mixed aesthetic, components, constraints, and what to design; (b) **test the `soltero-skills:frontend-design` skill** by actually running it on this UI and comparing/using its output. Do BOTH — the context file and a real frontend-design-skill pass.
   - Design work starts from brainstorming (superpowers:brainstorming) to pin the mixed-aesthetic brief, which feeds both deliverables. Deferred visual-polish backlog still applies (`.app` max-width 860px squeezes transcript+sidebar; duplicate sidebar filter; tool_call renders alongside its permission card — mergeable).
   - **Live demo was run for the user this session** (all 4 scenarios PASSED again on a fresh server): screenshots `step1-autoapprove.png`…`step4-awareness.png` in repo root. Servers may still be running (server :3001 bg, client :5173 bg) — a stale one on 3001 needed a kill first; check `lsof -tiTCP:3001`.

## 1. Goal & current task

**Project goal:** Startup exploration of YC's Fall 2026 "Multiplayer AI" RFS (dev-tools vertical). v1 (merged to main) = one shared live agent session. v2 = project hub with agent-side awareness. v3 = full CC capabilities behind a multiplayer driver-approval gate — built, demo'd live, merge-ready.

**CURRENT TASK (start here): the product design phase — see §0 item 3 for the full direction.** We had just invoked `superpowers:brainstorming` to pin the mixed-aesthetic brief when the user asked to hard-reset context (see below). NOTHING was decided in that brainstorm yet — resume by re-invoking `superpowers:brainstorming` and driving it per §0 item 3 (Claude-Code-shell base + game-feel flourishes incl. the thinking-state mini-game + agent/model choice). The brainstorm feeds two deliverables: (a) a design context file for "Claude Design"; (b) a real `soltero-skills:frontend-design` pass on the UI. v3 ratification (§7) is a still-open SECONDARY thread — mention it, don't let it block design.

**PROCESS NOTE from the user (2026-07-24):** when the context-watch hook fires the handoff reminder (~40%), treat it as a HARD STOP — refresh HANDOFF, tell the user to `/clear`, and END THE TURN. Do not keep working in an overflowing context (this session ran to ~107% before resetting — that's the failure mode to avoid). The hook only *reminds*; the discipline is: handoff → instruct clear → stop.

## 2. Status

- v1: **complete** — merged to main at `ad791fb`, 19/19 tests, live acceptance PASSED.
- Research report + v3 addendum: **complete** — `docs/research-report.md` (conditional GO, faster incumbent clock).
- v2: **COMPLETE, unmerged** on `feature/project-hub` (…4a4faff) — user was reviewing it personally; still held.
- v3 spec + plan: **committed** (`272f1f4` spec, `85a3999` plan), design user-approved.
- v3 execution: **COMPLETE on `feature/project-hub` at `6735d4e`** (Tasks 1–6 + research). All task reviews + final whole-branch review passed; 2 live-acceptance findings fixed (worktree escape, skills leak) + 3 final-review minors fixed. 60/60 server tests, tsc clean, client builds. **Stopped exactly at: v3 complete, branch merge-ready, NOT merged. Next session: surface the three RATIFICATION ITEMS (§7) to the user, collect any review feedback on v2+v3, address it subagent-driven with re-review, then run finishing-a-development-branch (likely merge to main). Do NOT merge or delete anything until the user gives a verdict.**

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

1. **Resume the design brainstorm** — invoke `superpowers:brainstorming`; drive it to a written design spec per §0 item 3. Key open questions to pin: exact scope of "match the Claude Code shell" (which shell elements — the boxed prompt, monospace transcript, tool-call glyphs, status line?); how the thinking-state mini-game triggers/dismisses and whether it's per-session or global; what "agent/model choice" means concretely (a picker at join? which models?); how game-feel and terminal-minimalism coexist without the game undercutting the pro-tool feel. Brainstorming's terminal state is `writing-plans` — but the user ALSO wants a design context file + a frontend-design skill test, so treat those as deliverables of the design phase alongside the spec.
2. **Produce the design context file for "Claude Design"** — a self-contained brief (suggest `docs/design/claude-design-brief.md`): product one-pager, current UI state (point at `poc/client/src/App.tsx` + `App.css` and the `step1..4` screenshots), the mixed aesthetic, component inventory, the thinking-state mini-game concept, agent-choice concept, hard constraints (self-contained, theme-aware, the event/wire model it must render), and an explicit "what to design" list.
3. **Test `soltero-skills:frontend-design`** — run it on this UI, capture what it produces, compare against the context-file approach; keep whichever is better (or merge).
4. **Then** (secondary): surface §7 v3 ratification items; `finishing-a-development-branch` for `feature/project-hub` (v2+v3) when the user's ready to merge.

## 5. Files with line refs (current state on `feature/project-hub` @ 6735d4e)

- v3 plan: `docs/superpowers/plans/2026-07-24-full-capabilities.md`; v3 spec: `docs/superpowers/specs/2026-07-24-full-capabilities-design.md`
- `poc/server/src/permissions.ts` (NEW) — `AUTO_APPROVED_BASH_PREFIXES` + `isAutoApprovedBash` (:17-42, shell-metachar guard); `isContainedWrite`/`FILE_WRITE_TOOLS` (:66-79, reads `file_path ?? notebook_path`); `buildCanUseTool` (SDK canUseTool bridge — never returns null; containment branch before driver-ask; abort→deny backstop)
- `poc/server/src/agentDriver.ts` — `DriverHooks.onPermissionRequest(toolName,input,signal?)` + `onPermissionError` (~:32-52); `runAgentQuery` options (~:70-120: `tools:{preset:"claude_code"}`, `canUseTool`, `skills` from `AGENT_SKILLS`, system prompt states worktree root, `allowedTools` = Read/Glob/Grep/set_intent only — Write/Edit removed); `AgentDriver.resolvePermission` + `denyOnAbort` + `denyAllPending` (flush on stream death, ~:290-304); `pendingPermissions` map
- `poc/server/src/server.ts` — `INTERESTING` gains permission_request/decision (:24-32); `{type:"permission"}` wire handler (~:192-209, driver-at-decision-time via `canPrompt`)
- `poc/server/src/events.ts:9-12` — union has permission_request/permission_decision
- `poc/client/src/App.tsx` — `permissionDecisions` map in derived-state memo (~:91-109); `sendPermission` (~:125); permission_request card + permission_decision line in transcript switch; `App.css` `.msg.permission` styles
- `poc/scripts/demo-setup.sh` — creates `.claude/skills/auth-migration-guide/SKILL.md` before worktree-add (both worktrees get it)
- SDD ledger (THIS increment): `.superpowers/sdd/2026-07-24-full-capabilities/progress.md`; task/fix reports + acceptance evidence in same dir (`task-6-report.md`, `final-fixes-report.md`, research-*.md). v1/v2 ledger is the OLD flat `.superpowers/sdd/progress.md`.
- Skill scripts: `/Users/franciscosoltero/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/{task-brief,review-package,sdd-workspace}`

## 6. Gotchas / constraints

- **`Docs/` == `docs/`** on this macOS FS — always write lowercase `docs/`.
- **SDD reviewers must be told**: "LOCAL review, no gh, final message IS the review, read-only". Prefer fresh reviewer dispatches over SendMessage-resume.
- **Test fakes stay assignable** as `RunQuery` gains params (fewer-params functions assignable in TS) — do not "fix" them. Existing tests pass unmodified; append-only.
- **`canUseTool` must NEVER return null** — fail-closed per sdk.d.ts: null blocks the tool forever. Always a PermissionResult.
- **`skills` option is a listing FILTER, not discovery** — project skills are NOT discovered under `settingSources:[]` (that's ratification item 3). `AGENT_SKILLS` default empty = no skills listed; the demo agent reads `.claude/skills/*/SKILL.md` directly via grep (works today, proven in acceptance).
- **Bash allowlist + in-worktree Write = a documented two-hop escape** (agent authors `package.json` test script / `vitest.config` / `tsc --outDir` / `git --output`, then runs the allowlisted command → runs outside worktree, no approval). Accepted PoC residual risk (README documents it); OS sandboxing is out of scope. Do NOT silently "fix" by editing the allowlist — that's ratification item 2.
- Client has **no auto-reconnect**; a server restart drops tabs — reload during acceptance. If ports 3001/5173-4 are stale from a prior session, `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)` first. Client picked **5174** last run because 5173 was occupied — check the vite banner for the real port.
- Background security scans fire on server commits — missing-auth findings are spec-accepted PoC scope; don't churn.
- `.superpowers/` is git-excluded; reports/briefs live there — the ledger + `git log` is the recovery map.
- Demo: `poc/scripts/demo-setup.sh` → `poc/demo-worktrees/{ana,ben}`; server needs `AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees` and (for the skill demo) `AGENT_SKILLS=auth-migration-guide`.

## 7. Open questions / RATIFICATION ITEMS for the user

These are the three things to put in front of the user before merging (all recorded, none blocking the build):
1. **Write/Edit auto-approval is now worktree-containment-conditional**, not unconditional as the v3 spec text said. Forced by a reproduced live Critical (an agent wrote to `~/src/auth.ts`, outside its worktree). The final review endorsed the deviation as strictly safer. User ratifies keeping it.
2. **Bash allowlist residual-risk acceptance** — the two-hop escape above. Options: accept in writing as PoC scope (README already documents it — recommended), or narrow the list (cheapest cut: drop `npm test`). Do not change the list without the user's call — the six prefixes are spec-mandated.
3. **Project-skill discovery under `settingSources:[]`** — currently discovery doesn't happen; the agent greps SKILL.md directly. Options: `settingSources:["project"]` scoped to the worktree (reopens that repo's project settings/CLAUDE.md — arguably matches the spec's "project-scoped opt-in"), a local `plugins:[{type:'local',path}]` wrapper, or accept the grep fallback. User picks the direction.

Carried minor (non-blocking): unused `_reason` param on `denyAllPending` (cosmetic).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git checkout feature/project-hub
git log --oneline | head -3        # expect 6735d4e, 6527dd4, af5b7be
cat .superpowers/sdd/2026-07-24-full-capabilities/progress.md   # v3 complete through final review; merge-ready
cd poc/server && npx vitest run    # expect 60 passed (60); main still has 19
cd ../client && npm run build      # clean
```

Branch: `feature/project-hub` = v1(merged separately)+v2+v3, complete, **unmerged**, merge-ready, held for the user's verdict on §7. Trust the ledger + `git log` over memory. Demo: `poc/scripts/demo-setup.sh`, then server `AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev` (poc/server), client `npm run dev` (poc/client); URLs `?project=demo&session=ana` / `session=ben`. Acceptance walkthrough: allowlisted cmd auto-runs; a `&&`/non-allowlisted cmd or an out-of-worktree Write raises a 🔐 card; only the current driver decides; take-the-wheel lets a teammate decide a pending card.

**IMMEDIATE RESUME (design phase):** `git log --oneline | head -1` should show the HANDOFF-pivot commit. The current UI to reshape is `poc/client/src/App.tsx` (253 lines) + `poc/client/src/App.css` (36 lines) — plain dark theme today, `.app` max-width 860px. Screenshots of the live product: repo-root `step1-autoapprove.png`…`step4-awareness.png`. Start the design phase by invoking `superpowers:brainstorming` and driving it per §0 item 3 and §4. No decisions are locked yet — the brainstorm is a blank slate.
