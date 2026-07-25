# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (evening): v5a harness capabilities IMPLEMENTED on `feature/v5a-harness` — all 12 plan tasks complete, live acceptance done, 2 live-SDK fixes landed; stopped mid-Task-12 wrap-up at the context hook. NEXT USER ASK QUEUED: examine `Multiplayer AI 90s Terminal UI.zip` (repo root) — the user's UI blueprints.*

## 0. WHERE WE ARE — v5a wrap-up (Task 12, ~90% done)

Spec: `docs/superpowers/specs/2026-07-25-harness-capabilities-design.md` (user-approved; amended twice — permission_mode_change/toolUseId during planning, live-SDK tool names during acceptance).
Plan: `docs/superpowers/plans/2026-07-25-harness-capabilities.md` (12 tasks, ALL complete via subagent-driven-development; every task review clean).
Ledger (trust it + `git log` over memory): `.superpowers/sdd/2026-07-25-harness-capabilities/progress.md` — has all task completions, ~12 deferred minors, live-acceptance findings, fix rounds 1–2.

**Branch:** `feature/v5a-harness` off main at `d67f386`, HEAD `0022a80`. Gates green: server `npx tsc --noEmit` clean + vitest 89/89; client 18/18 + build clean.

**Stopped exactly at:** round-2 fix commit `0022a80` (monotonic task-mirror ids) landed and gates verified, but its **scoped re-review has NOT run yet** — that is the first resume step. After that: 3 wrap-up steps + final whole-branch review + finishing-a-development-branch (§4).

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration. v1–v4 merged to main (PR #1). v5 split into v5a (harness capabilities — THIS branch) and v5b (game roster + party high score — not started; needs own spec/plan cycle).

**CURRENT TASK:** finish v5a Task 12 wrap-up + merge flow (§4), then the queued user ask: unzip and study `Multiplayer AI 90s Terminal UI.zip` at repo root — "blueprints for how I want the UI to look" (user, 2026-07-25). Treat that as design input for a UI-restyle discussion (likely brainstorm → spec); do NOT silently restyle.

**PROCESS NOTE (standing):** context-watch hook at ~40% = HARD STOP (refresh this file, tell user to /clear, end turn).

## 2. What v5a shipped (verified live 2026-07-25)

- Wire: 7 append-only events (skill_roster/suggest/decision, todo_update, plan_request/decision, permission_mode_change) + toolUseId/parentToolUseId lineage fields (`poc/server/src/events.ts:61-85`).
- Server: lineage plumbing + `forwardSubagentText: true`; task-tool todo mirror; per-session skill roster (`skillRoster.ts`, appended as seq-0 event); suggest/decide flow (`runSkill`, driver auto-run); plan gate (`onPlanRequest` hook, `resolvePlan`, `setPermissionMode` — setModel pattern); 4 driver-guarded messages in `server.ts` (~:120-210 region).
- Client: derive.ts harness state + `deriveTranscriptGroups`; grouped Transcript with collapsible `⚒ subagent` blocks + `⚡` skill cards + suggest chips + PlanCard; TodoPanel; PromptBar slash autocomplete (passenger=suggest, driver=auto-run); Header plan toggle.
- Live acceptance PASSED: slash autocomplete (real SKILL.md descriptions), passenger suggest→driver run→skill card→activity, a/d shortcuts, worktree Write auto-approve, full plan cycle incl. "request revision" loop, wheel-handoff plan approval ("approved by ben" + auto "ben switched plan mode off"), post-approval execution. Screenshot: `v5a-plan-approved-ben.jpeg` (repo root, untracked).

## 3. Decisions + why (do not re-litigate)

- All v1–v4 decisions stand. v5a approach = append-only wire + client derivation (server stays relay+gate; server entity model rejected — breaks replay).
- Passenger slash = suggest_skill; driver decision validated at DECISION time (wheel-handoff inheritance, mirrors permission gate). Driver's own suggest auto-runs server-side (one message, two events).
- `runSkill` appends NO user_message — the suggest/decision event pair is the transcript record.
- Plan gate rides canUseTool (ExitPlanMode held); approve auto-switches mode back to default, logged as permission_mode_change by the decider.
- **Live-SDK corrections (fix wave, spec amended):** installed SDK has NO TodoWrite → mirror TaskCreate/TaskUpdate (monotonic `nextTaskId` counter — length-based ids collide after delete, caught in re-review); subagent spawner tool is `Agent` not `Task` (derive accepts both); bookkeeping tools (TodoWrite/TaskCreate/TaskUpdate/TaskGet/TaskList) auto-approved in permissions.ts.

## 4. Ordered next steps

1. **Scoped re-review of `0022a80`** (the round-2 collision fix): `scripts/review-package PLAN d64449e HEAD` from the SDD skill dir, dispatch re-review-prompt.md (sonnet) with the single finding "length-based ids collide after delete" + `.superpowers/sdd/2026-07-25-harness-capabilities/task-12-fix-report.md`. Expect ADDRESSED; ledger it.
2. Quick live re-test of the two fixed surfaces (stack: §6): fresh session tab, prompt the agent to create tasks via TaskCreate + spawn one Agent subagent → TodoPanel appears with statuses; subagent group shows real description label and flips to done. Screenshot alongside `v5a-plan-approved-ben.jpeg`; decide with user whether to commit screenshots (v4 committed theirs).
3. Ledger `Task 12: complete`, commit HANDOFF + ledger-relevant artifacts (`git add HANDOFF.md v5a-*.jpeg` as chosen).
4. **Final whole-branch review**: `scripts/review-package PLAN d67f386 HEAD` (merge-base = d67f386), dispatch requesting-code-review's code-reviewer.md on the most capable model; point it at the ledger's deferred-minor + parked lines for merge triage. If findings: ONE fix subagent (all findings) + ONE scoped re-review, adjudicate residuals.
5. Delete the plan workspace (`rm -rf .superpowers/sdd/2026-07-25-harness-capabilities`) after a clean final review, then superpowers:finishing-a-development-branch (user picks merge/PR; v4 went via PR).
6. **Queued user ask:** unzip `Multiplayer AI 90s Terminal UI.zip` (repo root) into scratchpad, study contents (UI blueprints), then discuss with user how they want them applied (expect brainstorm → v5c/restyle spec; frontend-design skill likely relevant). Do not restyle without a spec.

## 5. Files with line refs (v5a HEAD 0022a80)

- Server: `events.ts` (union + SkillInfo/TodoItem :51-85); `agentDriver.ts` (SdkMessage.parent_tool_use_id :33, taskPanel+nextTaskId fields ~:188, runSkill after sendPrompt, onPlanRequest hook in ctor, resolvePlan/setPermissionMode after resolvePermission, TodoWrite/TaskCreate/TaskUpdate mirror in handleMessage assistant branch ~:513-551); `permissions.ts` (AGENT_BOOKKEEPING_TOOLS :60-65, ExitPlanMode branch after it); `server.ts` (suggest_skill/decide_skill/set_permission_mode/decide_plan handlers after set_model; roster build in getOrCreateSession :76-103; INTERESTING extended); `project.ts:9-13` (skills+pendingSuggests); `skillRoster.ts` (new).
- Client: `derive.ts` (DerivedState + deriveTranscriptGroups :~100-183; spawner = Task|Agent); `types.ts` (flat LoggedEvent); `components/{Transcript,PromptBar,Header,TodoPanel}.tsx`; `App.tsx` (planMode/onTogglePlan/onSuggestSkill/onDecideSkill/onDecidePlan wiring); `terminal.css` (todopanel ~:101, subagent/skillcard, slashmenu, planmode/plan-body blocks).
- Tests: `poc/server/test/{agentDriver,permissions,server,skillRoster}.test.ts`; `poc/client/src/derive.test.ts`.

## 6. Gotchas / constraints

- All v3/v4 gotchas stand (worktree containment, canUseTool never-null, `Docs/`==`docs/`, no client auto-reconnect, `.superpowers/` git-excluded, subagent sandbox CANNOT launch the SDK binary — controller starts the stack).
- **tsx watch hot-reloads on server edits → kills the live SDK query mid-turn.** Never edit server code while a live demo turn is running.
- Demo stack (currently RUNNING from this session as background tasks): server :3001 `AGENT_WORKDIR_ROOT=$(pwd)/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev` (from poc/server), vite :5173. On resume, check `lsof -nP -iTCP:3001 -iTCP:5173 -sTCP:LISTEN`; kill/restart if stale. `poc/scripts/demo-setup.sh` rebuilds demo worktrees (rm -rf's them).
- **Live SDK facts (documented, NOT bugs to "fix" in our code):** Skill tool returns "Unknown skill" even with `skills:` option + SKILL.md on disk under `settingSources:[]` — the v3 open ratification item, reproduced live; agent recovers by reading SKILL.md directly. SDK meta-tools (ToolSearch, TaskCreate/TaskUpdate, Agent) bypass canUseTool entirely; AskUserQuestion does route through it. Keyboard a/d shortcuts ignore keypresses while an input is focused (by design).
- Test counts: server 89, client 18 — update expectations, not the old 68/11.

## 7. Open questions / USER DECISIONS (batched — present before/at merge)

Carried v3 ratification: (1) worktree-containment Write/Edit approval; (2) Bash-allowlist two-hop residual risk; (3) project-skill discovery under settingSources:[] — now CONFIRMED live broken; decide: accept (agent self-recovers), or investigate SDK versions/options.
Carried v4: (4) party pane <900px summary+toggle vs display:none (TodoPanel copied the same hide — same decision covers it); (5) stale skill name in v4 spec text; (6) 4 structural polish items in frontend-design-skill-notes; (7) old step*.png + `ana-live.png` + new `v5a-plan-approved-ben.jpeg` — commit or drop.
New v5a: (8) ~12 deferred minors in the ledger (final review will triage); (9) meta-tools bypassing the permission gate — accept as SDK behavior or raise upstream; (10) `Multiplayer AI 90s Terminal UI.zip` — how the blueprints map to work (restyle v5a UI? feeds v5b? separate cycle) — ASK THE USER after studying it.

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout feature/v5a-harness
git log --oneline | head -4      # 0022a80 fix(server): monotonic task-mirror ids …
cat .superpowers/sdd/2026-07-25-harness-capabilities/progress.md   # full state
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 89 passed
cd ../client && npm test && npm run build             # 18 passed, clean build
```

Live demo: §6 stack; tabs `?project=demo&session=<fresh>&name=ana` (+ `&name=ben` same session for passenger flows). Resume at §4 step 1 (scoped re-review of 0022a80) — do not re-dispatch completed plan tasks (ledger has completion lines for all 12).
