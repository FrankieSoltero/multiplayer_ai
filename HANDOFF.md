# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (late evening): v5a COMPLETE on `feature/v5a-harness` — fix re-review clean, live re-test passed, final whole-branch review clean (one trivial fix applied, commit 3527d9a), plan workspace deleted. BLOCKED ON USER: merge menu (merge local / PR / keep) + batched §7 decisions. Then the queued ask: `Multiplayer AI 90s Terminal UI.zip`.*

## 0. WHERE WE ARE — v5a done, awaiting integration decision

All 12 plan tasks complete; fix loop closed (re-review of `0022a80` ADDRESSED, no new breakage); live re-test of the two fixed surfaces PASSED (session v5a-retest-3: TaskCreate/TaskUpdate mirror incl. post-delete fresh id #4, Agent subagent group with real label flipping to done — screenshot `v5a-tasks-subagent-retest.jpeg`, repo root, untracked). Final whole-branch review (d67f386..3575463): **no Critical, no Important; verdict "ready to merge with fixes"** — the one FIX BEFORE MERGE item (misleading test comment) applied with a spec-deviation note in commit `3527d9a`. Gates re-verified on final tree: server tsc clean + 89/89; client 18/18 + build clean.

**Branch:** `feature/v5a-harness` off main at `d67f386`, HEAD `3527d9a`.
**The SDD workspace `.superpowers/sdd/2026-07-25-harness-capabilities/` was deleted after the clean final review (per plan); its load-bearing facts are folded into this file.**

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration. v1–v4 merged to main (PR #1). v5a (harness capabilities) = THIS branch, complete. v5b (game roster + party high score) not started; needs own spec/plan cycle.

**CURRENT TASK (blocked on user):** present/execute the finishing-a-development-branch menu — (1) merge to main locally, (2) push + PR, (3) keep as-is — plus the batched user decisions in §7. Then the queued ask: unzip and study `Multiplayer AI 90s Terminal UI.zip` (repo root) — the user's UI blueprints; treat as design input for a brainstorm → spec discussion, do NOT silently restyle.

**PROCESS NOTE (standing):** context-watch hook at ~40% = HARD STOP (refresh this file, tell user to /clear, end turn).

## 2. What v5a shipped (verified live 2026-07-25)

- Wire: 7 append-only events (skill_roster/suggest/decision, todo_update, plan_request/decision, permission_mode_change) + toolUseId/parentToolUseId lineage (`poc/server/src/events.ts:61-85`).
- Server: lineage plumbing + `forwardSubagentText: true`; task-tool todo mirror (live SDK TaskCreate/TaskUpdate, monotonic `nextTaskId` — `agentDriver.ts:189-196`); per-session skill roster (seq-0 event); suggest/decide flow (driver auto-run); plan gate on canUseTool (ExitPlanMode held; approve auto-switches mode back, logged by decider); 4 driver-guarded messages in `server.ts`.
- Client: `deriveTranscriptGroups` (spawner = Task|Agent, `derive.ts:1059-1101`); grouped Transcript with collapsible ⚒ subagent blocks + ⚡ skill cards + suggest chips + PlanCard; TodoPanel; PromptBar slash autocomplete (passenger=suggest, driver=auto-run); Header plan toggle.
- Live acceptance + re-test PASSED (details previously in ledger, now §0). Screenshots at repo root: `v5a-plan-approved-ben.jpeg`, `v5a-tasks-subagent-retest.jpeg` (both untracked — decision 7).

## 3. Decisions + why (do not re-litigate)

- All v1–v4 decisions stand. v5a = append-only wire + client derivation (server entity model rejected — breaks replay).
- Passenger slash = suggest_skill; driver decision validated at DECISION time (mirrors permission gate). Driver's own suggest auto-runs server-side (one message, two events).
- `runSkill` appends NO user_message — the suggest/decision pair is the record.
- Live-SDK corrections (spec amended): no TodoWrite → mirror TaskCreate/TaskUpdate; spawner tool named `Agent` (derive accepts both); bookkeeping tools auto-approved.
- Final-review triage (do not re-open): deferred minors #2,3,4,5,7,8,13,15 DEFER post-merge; #1,9,10,11,12,14 DROP; #6 fixed (3527d9a). New residual minors, all adjudicated POC-acceptable/defer: suggest-chip args preview shows 120 of 500 chars on an approval surface (fold into decision batch); typo'd slash submit clears input before server error round-trips; dead-driver suggest logs decision:run before agent_error; skill-card collapsible-output deviation ratified in spec (3527d9a).
- Final-review inline fix (comment reword + docs) intentionally got NO re-review round — docs/comment-only, gates green.

## 4. Ordered next steps

1. **USER: pick integration option** — merge to main locally / push + create PR (v4 precedent) / keep branch. Execute per finishing-a-development-branch (on merge: checkout main, merge, re-run both suites, delete branch only after green).
2. **USER: batched decisions** (§7) — can ride along with step 1 or after.
3. Commit or drop the untracked images per decision 7 (`v5a-*.jpeg`, `ana-live.png`, old step*.png if any remain).
4. **Queued user ask:** unzip `Multiplayer AI 90s Terminal UI.zip` (repo root) into scratchpad, study, then discuss application (restyle v5a UI? feeds v5b? separate cycle). Brainstorm → spec; frontend-design skill relevant. No restyle without a spec.
5. v5b (game roster + party high score) when the user wants it — fresh spec/plan cycle.

## 5. Files with line refs (HEAD 3527d9a)

- Server: `events.ts:51-85` (union + SkillInfo/TodoItem); `agentDriver.ts` (parent_tool_use_id :33, nextTaskId ~:35+189-196, runSkill, onPlanRequest, resolvePlan/setPermissionMode, task mirror ~:513-551); `permissions.ts` (AGENT_BOOKKEEPING_TOOLS :60-65, ExitPlanMode branch :123-131); `server.ts` (4 new handlers after set_model ~:273-296; roster :76-103); `project.ts:9-13`; `skillRoster.ts`.
- Client: `derive.ts` (harness state ~:100-183, groups :1059-1101); `components/{Transcript,PromptBar,Header,TodoPanel}.tsx` (suggest chip slice at Transcript.tsx:125); `App.tsx` wiring; `terminal.css` (todopanel ~:101, subagent/skillcard/slashmenu/planmode blocks).
- Tests: `poc/server/test/{agentDriver,permissions,server,skillRoster}.test.ts` (attribution comment fixed at server.test.ts:583); `poc/client/src/derive.test.ts`.
- Spec (amended ×3): `docs/superpowers/specs/2026-07-25-harness-capabilities-design.md`. Plan: `docs/superpowers/plans/2026-07-25-harness-capabilities.md`.

## 6. Gotchas / constraints

- All v3/v4 gotchas stand (worktree containment, canUseTool never-null, `Docs/`==`docs/`, no client auto-reconnect, `.superpowers/` git-excluded, subagent sandbox CANNOT launch the SDK binary — controller starts the stack).
- tsx watch hot-reloads on server edits → kills live SDK query mid-turn. Never edit server code during a live demo turn.
- **Fresh demo sessions need a worktree FIRST**: `cd poc/demo-project && git worktree add ../demo-worktrees/<session> -b <session>` — otherwise the SDK spawn fails on the nonexistent cwd with a MISLEADING "native binary failed to launch" banner and the session ends. (Cost 2 dead sessions v5a-retest-1/2 to rediscover.) Also: stack processes from a dead controller session go stale — kill by port and restart (unsandboxed).
- Stack: server :3001 `AGENT_WORKDIR_ROOT=$(pwd)/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev` (from poc/server), vite :5173 (from poc/client). Check `lsof -nP -iTCP:3001 -iTCP:5173 -sTCP:LISTEN`.
- Live SDK facts (documented, NOT bugs): Skill tool "Unknown skill" under settingSources:[] (agent self-recovers reading SKILL.md); meta-tools (ToolSearch, TaskCreate/TaskUpdate, Agent) bypass canUseTool; AskUserQuestion routes through it; a/d shortcuts ignore keypresses while an input is focused.
- Speculative (from final review, unproven — diagnose fast if task mirror misbehaves): if the live SDK's task numbering is session-global across subagents, main-agent TaskUpdate ids could drift from the mirror's counter (mirror excludes subagent creates by design).
- Test counts: server 89, client 18.

## 7. Open questions / USER DECISIONS (batched — present at merge)

Carried v3: (1) worktree-containment Write/Edit approval; (2) Bash-allowlist two-hop residual risk; (3) skill discovery under settingSources:[] confirmed broken — accept self-recovery or investigate SDK versions.
Carried v4: (4) party pane <900px hide (TodoPanel same); (5) stale skill name in v4 spec text; (6) 4 structural polish items in frontend-design-skill-notes; (7) images: `ana-live.png` + `v5a-plan-approved-ben.jpeg` + `v5a-tasks-subagent-retest.jpeg` — commit or drop.
New v5a: (8) deferred minors marked DEFER in §3 triage — schedule post-merge or drop; (9) meta-tools bypassing the permission gate — accept or raise upstream; (10) suggest-chip args preview 120/500 chars on an approval surface — widen to 300+ or accept; (11) `Multiplayer AI 90s Terminal UI.zip` — how blueprints map to work (restyle v5a? feeds v5b? separate cycle) — ask after studying it.

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout feature/v5a-harness
git log --oneline | head -3   # 3527d9a docs+test: final-review fixes …
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 89 passed
cd ../client && npm test && npm run build             # 18 passed, clean build
```

Resume at §4 step 1: the user's integration choice + §7 batch. Everything before it is DONE — do not re-run reviews or re-dispatch plan tasks.
