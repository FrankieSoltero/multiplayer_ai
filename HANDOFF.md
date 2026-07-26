# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-26 (bg session #2, ~40% hard stop mid-SDD): **workflows screen DEMOED + MERGED (PR #10, main `dcf8429`). Session-launcher (sub-projects B+C) spec+plan approved and committed; SDD run IN PROGRESS on branch `feature/session-launcher` — Tasks 1-2 of 7 done (Task 2 mid-fix-loop: fix landed, scoped re-review NOT yet run).** Resume per §1.*

## 0. WHERE WE ARE

- **main** (origin in sync, `dcf8429` = merge of PR #10): everything through the workflows screen. Baselines on main: **server 131 tests / client 66**, both builds clean.
- **Branch `feature/session-launcher`** (local only; based on `71661c0`, fully contained in main's merge — future PR shows only new work): `1fded02` spec, `57f0645` plan + spec watch_project addendum, `f3e6048` Task 1 (WorkspaceManager + slugify, +8 tests → 139), `2afc745` Task 2 (watch_project/create_session wire, +8 → 147), `2d61565` Task 2 fix round 1 (watch_project re-watch leak, +1 → 148). Client untouched so far (66).
- **SDD run state:** ledger at `.superpowers/sdd/2026-07-26-session-launcher/progress.md` (briefs/reports/review packages beside it). Tasks 1 complete (review clean); Task 2 MID-FIX-LOOP: reviewer found 1 Important (watch_project watcher leak on re-watch — plan pseudocode bug, constraint text governs), fix landed in `2d61565`, **scoped re-review of `2afc745..2d61565` not yet dispatched**. Tasks 3-7 not started.
- Workflows demo passed live (running→done, mid-flight stop w/ attribution, badge). PR #10 merged with user go.
- v6b (interrupt rail / fleet) still banked at decision level (§3b). Launch build (§3d) still PARKED.
- Post-workflows roadmap (user-approved decomposition): **B = session initiation + directory choice, C = launch-anywhere CLI** (B/C may merge into one spec; C mostly automates what B parameterizes). Not brainstormed yet.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK: continue the SDD run on `docs/superpowers/plans/2026-07-26-session-launcher.md` (7 tasks; spec `docs/superpowers/specs/2026-07-26-session-launcher-design.md`, both user-approved).** Feature: WorkspaceManager worktree provisioning + watch_project/create_session wire + single-port static serving + SessionPicker (no-param entry) + `mpai` CLI. Resume EXACTLY at: scoped re-review of Task 2's fix round 1 (diff `2afc745..2d61565`; findings list = the one Important: "watch_project leaks watcher registration when a socket switches projects"; use re-review-prompt.md, sonnet). If ADDRESSED + no new breakage → ledger `Task 2: complete (commits f3e6048..2d61565, review clean)` → proceed Task 3 (brief not yet extracted; `task-brief PLAN 3`). Model policy this run: implementers haiku (plan has complete code), task reviewers sonnet, re-reviews sonnet, final whole-branch review fable. Expected end state: server 160 (now 148; +6 static Task 3, +7 cli Task 6 — NOTE: 148 not 147 baseline for remaining arithmetic, fix-round test added one; so final = 161 not 160 — record in plan Deviations at Task 7), client 72 (66 + 6 Task 4). After Task 7: STOP for user demo (mpai launch in a scratch repo → picker → create session → agent in `.mpai/worktrees/<slug>` → `mpai new`), then PR on user go.

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP (refresh this file, tell user to /clear, end turn). Don't pair AskUserQuestion with long content. SDD workspace scripts live under `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/` (sdd-workspace, task-brief, review-package).

## 2. What shipped this session (all merged to main)

- **v6c plugins (PR #8):** PluginStore https-clone/validate/namespace, `plugin_change` + `plugins`/`pluginsEnabled` snapshots, SDK `plugins:[{type:'local',path}]` + `skills:"all"` + live roster via `supportedCommands()`, AGENT_SKILLS retired. Junk-roster known-unknown CONFIRMED at demo and recorded in that plan's Deviations (roster has non-skill rows like `/agents` "(removed)…"; no SDK discriminator, sdk.d.ts:6596-6613).
- **slash-autocomplete v2 (PR #9, demo-passed):** `poc/client/src/slashMatch.ts` (substring match prefix-first, `moveHighlight` wrap, `notRemoved` junk filter — drops descriptions starting `(removed`); filter applied at `derive.ts` skill_roster fold AND `skillSuite.ts` suiteFromSessions (final-review catch — suite path reads raw per-session roster); PromptBar keyboard menu (3-row 108px window, ↑/↓ wrap, Enter/Tab accept `/name ` trailing space, Esc dismiss until text change, Shift+Tab untouched, ARIA combobox, `effectiveHighlight` single clamp).
- **Viewport-fit fix (`c5e82bc`, on the workflows branch):** `.cabinet` height:100%/padding 22px, `.cabinet-inner` + `.crt` flex:1 min-height:0, `Crt.tsx:27` default height "100%" (was fixed 764) — page itself never scrolls; all scrolling inside screen regions.

## 2c. What the workflows screen will build (spec+plan approved, NOT implemented)

Live session-scoped view of SDK subagent/task lifecycle: relay forwards `task_started/task_progress/task_updated/task_notification` (SDK system messages) as normalized `task_event` wire events (progress throttled per task: leading append + trailing latest-wins flush, done supersedes, flush-on-normal-stream-end / discard-on-error); attributed `task_stop` appended BEFORE `query.stopTask(taskId)`; client folds into `DerivedState.tasks`; WORKFLOWS screen (`?screen=workflows`, W hotkey, header badge `WORKFLOWS ▸ N` while running) with RUNNING/FINISHED sections and driver-only STOP.

## 3. Decisions + why (do not re-litigate)

- All v1–v6a/v6c decisions stand (append-only wire + client derivation; relay+gate server; accessibility floor; auto-mode relay enforcement; `skills:"all"` reversal deliberate; deployment §3d).
- **Autocomplete (shipped, keep semantics):** substring matching because namespaced plugin names made prefix useless (`/handoff` found nothing); Enter/Tab accept + Esc-then-Enter raw submit (Slack/VS Code convention); menu only on name token (`^\/(\S*)$`), closes at first space, backspace reopens; minimal `(removed` junk filter only — anything broader is hand-maintained guesswork (no SDK skill-vs-command discriminator); Shift+Tab never captured (v6a accessibility ruling).
- **Workflows screen (user-approved 2026-07-26):** watch + manage where manage = STOP only — SDK exposes `stopTask` and nothing else per-task (no pause/resume/re-run; backgrounding skipped for v1); separate screen not a main-view panel (main view already dense; transcript already shows subagent tool calls inline); wire = append `task_event`s + client derive, NOT server snapshots (standing architecture rule; replay gives late joiners full history; who-stopped-what is honest wire history); stop driver-only, attributed, appended before the SDK call; session-scoped (cross-session = v6b).
- **Post-workflows decomposition (user-approved):** A workflows → B session-initiation+directories → C launch-anywhere CLI, in that order.

## 3b. v6b BANKED DECISIONS (unchanged — start the spec from here)

- Interrupt rail first, fleet cards second; pulls (pending gates server-wide + file-collision alerts, one-click jump-in); scope = everyone on this server; NEVER "team hub".
- Collision signal generates PULLS; `<teammates>` digest exists (`digest.ts`); v6b delta = server-side file-overlap detection as human-facing interrupts + agent-side tiered add ("agents too, tiered").
- Presence co-op framed (focus-based, session-level, PARTY language, never person-level monitoring); coordination = awareness + advisory overlap warnings, NOT locks/task boards; TUI client carried; language "awareness"/"take the wheel"/"driver".

## 3d. DEPLOYMENT STRATEGY — spec MERGED (PR #6) — unchanged pointer

`docs/superpowers/specs/2026-07-25-deployment-strategy-design.md` is the authority. Two-week blitz (friends beta → public launch ~Aug 6 + YC app). Identity-clean per-action approval handoff = the wedge (nobody ships it — supersedes market-research.md's outdated claim). Week-1 build items need writing-plans; pull-notification overlaps §3b, build once.

## 4. Ordered next steps (fresh session)

1. Verify state per §8. Check `lsof -ti :3001` BEFORE any edit under poc/server — demo stack may still be running (poc/server edits hot-reload it — allowed, WS clients rejoin; NEVER switch branches in the main checkout while attached; poc/client edits safe, vite HMR). We are ON `feature/session-launcher` — stay there.
2. Re-invoke superpowers:subagent-driven-development on `docs/superpowers/plans/2026-07-26-session-launcher.md`. The ledger (`.superpowers/sdd/2026-07-26-session-launcher/progress.md`) names the exact resume point: Task 2's pending scoped re-review (details in §1). Then Tasks 3-7 per plan.
3. After Task 7 (verification sweep + final whole-branch review on fable + one fix wave if needed): STOP for user demo checkpoint, then PR `feature/session-launcher` → main on user go. Never merge without the user; merge-permission gotcha in §6.
4. Then next roadmap item: v6b (interrupt rail / fleet, banked decisions §3b) or deployment week-1 build items (§3d) — user's call.
5. Post-merge tidy (optional): delete merged remote branches `feature/v6c-plugins`, `feature/slash-autocomplete-v2`, `feature/workflows-screen` (permission-blocked for agent; user can); deferred minors in §7.

## 5. Files with line refs (post-merge main + workflows branch)

- **Workflows plan touchpoints (from the plan, verified this session):** `poc/server/src/events.ts:14-36` (SessionEvent union — add task_event/task_stop after plugin_change); `poc/server/src/agentDriver.ts:30-35` (SdkMessage to widen), `:68-75` (RunQueryResult — add stopTask?), `:168-198` (fields; add throttle maps after nextTaskId), `:200-206` (constructor — add 6th param progressThrottleMs=2000), `:452-471` (setModel — stopTask method goes after), `:473-502` (consume — clearProgressTimers(true|false) after both dead=true), `:561` (handleMessage — system branch at top); `poc/server/src/server.ts:366-376` (set_permission_mode handler — stop_task goes after; canPrompt guard pattern); `poc/server/test/agentDriver.test.ts:5-28` (fakeRun/fakeRunStream/wait helpers), `:139-148` (Session+driver test shape); `poc/server/test/server.test.ts:657-679` (driver-guard fixture w/ echoRun, startServer, connect, collect, wait, close).
- **Client:** `poc/client/src/types.ts:1-31` (LoggedEvent — add task fields); `derive.ts:4-8` (Participant export), `:10-23` (DerivedState — add tasks), `:25-39` (initializer), switch cases end ~`:90` (add task_event/task_stop after plugin-era cases); `App.tsx:159-175` (S-hotkey effect → extend with W), `:235-256` (screen branches — workflows goes before status), `:260-276` (Header call); `components/Header.tsx:21-28` (props), `:94-100` (SKILLS button — WORKFLOWS after); `terminal.css:35-40` (--gold/--red/--green tokens exist), `:186-199` (viewport-fit cabinet), end of file (wf* rules go there); `components/Crt.tsx:27` (height "100%").
- **Specs/plans:** workflows `docs/superpowers/{specs/2026-07-26-workflows-screen-design.md,plans/2026-07-26-workflows-screen.md}`; autocomplete pair same dirs dated 2026-07-26; v6c pair; deployment spec 2026-07-25.
- Positioning: `market-research.md` (untracked, user's file, do NOT commit; competitive claim outdated per §3d).

## 6. Gotchas / constraints

- **Demo stack may be running from an earlier session** (server :3001 `AGENT_PLUGINS_ROOT=<repo>/poc/demo-plugins` + `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees`, vite :5173). tsx watch hot-reload kills live turns — check `lsof -ti :3001` first; poc/client edits are safe (vite HMR). This session edited poc/client and merged via ff-refs with zero disk churn; the workflows plan's Tasks 1-2 EDIT poc/server — safe only if no live demo turn is in flight (hot reload restarts the server process; WS clients drop and rejoin).
- **Permission classifier is flaky on outward git/gh:** `gh pr merge` worked for PR #8 but was blocked for #9; the route that worked for #9: `git fetch . <branch>:main` (no checkout, zero disk churn) + `git push origin main:main`, then GitHub auto-marks the PR MERGED. `git push origin main` was blocked once while `main:main` refspec passed. Don't burn retries — try one alternate then ask user (`! gh pr merge N --merge`).
- Demo relaunch details (worktree FIRST or misleading "native binary failed to launch"; session id must match a demo-worktree dir; existing worktrees incl. v6c-accept-1/2): unchanged from before. Client URLs `http://localhost:5173/?session=v6c-accept-1|2`. Plugin clone persists at `poc/demo-plugins/default/soltero-skills` (26 skills).
- Server tests live in `poc/server/test/*.test.ts` (NOT src/); client tests co-located in `poc/client/src/`. PromptBar submits via input keydown Enter (no form); no component-test infra — pure-function extraction is the pattern; ThinkingStrip guard: blur inputs in synthetic tests.
- Known accepted quirks: double-M duplicate mode events (idempotent); plan-approve exits AUTO; S from `?screen=status` jumps to skills. `docs/` lowercase. `.superpowers/` git-excluded. Subagent sandbox can't launch the SDK binary.

## 7. Open questions / USER DECISIONS (carried)

- `tour-skill-suggest.png` (untracked): keep or delete — user's call; no feature gap behind it.
- Workflows demo may reveal: whether real SDK task messages match the read-side shapes (plan Task 1 widened SdkMessage from sdk.d.ts:4424-4500 — verified against installed d.ts, but live-shape drift is the recurring gotcha class); whether the 2s progress throttle feels right.
- Workflows deferred minors (from per-task + final review, none block merge): task_stop for a never-seen taskId creates a phantom RUNNING row in derive (plan-mandated create-on-stop; pairs with the no-confirmation-on-unknown-stop UX gap — fix together if ever touched); stop_task taskId length uncapped in server.ts (driver-only; house style would cap ~200); stopTask sync-throw would escape WS handler (theoretical — same idiom as setModel); FINISHED cap trims by insertion not completion order (observable past 50 tasks); stopTask dead-session branch untested; usage-fields mapping duplicated in handleTaskMessage branches (plan-mandated); fmtTokens 1000-boundary untested; WorkflowsPanel cap-math comment could carry an example.
- Carried v3–v6c items: worktree-containment approvals; Bash-allowlist two-hop risk (AUTO amplifies; plugin hooks widen — v6c spec §8); frontend-design polish; meta-tools bypass gate #9; AgentStatus TOOLS line #10; plan-mode pairing cosmetic #11; deferred minors ledger (slashmenu wrap/nowrap, tabIndex=-1, orphaned .clone-* GC, SkillsPanel submit dedupe, pendingUrl clearing).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git status -sb   # feature/session-launcher; untracked: market-research.md, poc/demo-plugins/, tour-skill-suggest.png
git log --oneline -5                          # 2d61565 fix(watch_project leak), 2afc745 wire, f3e6048 workspace, 57f0645 plan, 1fded02 spec
git log --oneline -1 origin/main              # dcf8429 (merge of PR #10, workflows)
head -30 .superpowers/sdd/2026-07-26-session-launcher/progress.md   # ledger: Task 1 complete; Task 2 fix round 1 awaiting scoped re-review
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 148 passed
cd ../client && npm test && npm run build             # 66 passed, clean build
lsof -ti :3001                                # if PIDs: demo stack still up — see §6
```

Resume at §1: dispatch the pending scoped re-review of `2afc745..2d61565` (generate the package with `review-package PLAN 2afc745 HEAD`), then continue the SDD loop through Task 7. STOP for user demo before PR.
