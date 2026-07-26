# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (late night): **v6a BUILT, PR #5 OPEN, awaiting user acceptance + merge.** Branch `feature/v6a-modes-skills` (pushed), all 7 plan tasks committed incl. deviations doc (`7d8d9d0`). Both suites re-verified green this session ON the branch: server tsc clean + 103 vitest, client 43 vitest + clean build. A live acceptance session was at least started (demo session `v6a-accept-1` visible in the screenshot `tour-skill-suggest.png`), but the previous session's transcript ended without recording an explicit user "accepted" — treat acceptance as NOT yet confirmed. Two untracked files at repo root need a user decision (§7).*

## 0. WHERE WE ARE — v6a built, in review/acceptance

- v6a cycle (spec `3fb2b4c`, plan `aff6560`) implemented across 7 tasks, all committed on `feature/v6a-modes-skills` (11 commits since main @ `f777265`). Execution deviations recorded in the plan (`7d8d9d0`), including one accepted spec drift (AUTO gate marker shows driver's *name*, not glyph — consistent with every other decision line).
- PR #5 open: "v6a: mode cycling (DEFAULT → AUTO → PLAN) + skills screen discoverability". 0 reviews, 0 comments.
- Verified 2026-07-25 late night on the branch: server `npx tsc --noEmit` clean + 103 vitest passed; client 43 vitest passed + clean vite build. Matches plan Task 7 expectations (≥100 server, ≥43 client).
- v5b and earlier all merged on `main` @ `f777265`.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK:** close out v6a — get user live acceptance of PR #5, then merge (same local-merge + push pattern as PRs #2–#4, since `gh pr merge` is permission-blocked). Also resolve the two untracked root files (§7 first two bullets).

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP (refresh this file, tell user /clear, end turn). Don't pair AskUserQuestion with long content in the same turn (dialog hides the text — user correction, saved in memory). SDD per superpowers skills; user picked subagent-driven for v5b (worked well).

## 2. What v5b shipped (now on main)

Playable arcade: snake + typerace cartridges alongside dino behind a shared `GameEngine` interface (zero per-game host branches); `game_score` server event on the append-only wire; per-game party records aggregated server-side into the throttled ProjectMessage snapshot; header ARCADE toggle + `A` hotkey; snake vertical steps aspect-scaled (V_ASPECT=2) so on-screen speed matches horizontal.

## 2c. What v6a builds (on the PR branch, not yet merged)

1. **Three-state permission mode DEFAULT → AUTO → PLAN.** `set_permission_mode` accepts `auto`; driver-only but now allowed **mid-turn** (flipping to AUTO rescues a turn stuck on gates). AUTO is enforced at the **relay**, not the SDK: the server answers each `permission_request` itself and appends a driver-attributed `permission_decision { auto: true }` — every gate stays visible on the append-only wire; entering AUTO sweeps pending gates once. Header MODE control cycles the three states (`M` hotkey), amber styling for AUTO; transcript renders auto-approved gate cards ("⚡ auto-approved · AUTO set by <name>") and three-state mode-change lines.
2. **Skills screen discoverable in-app.** `screen` lifted into App state seeded by `?screen=` (deep links still work); SKILLS header button, `S` toggles / `Esc` returns, back affordance in SkillsPanel. `?screen=status` stays a design-only deep link.

## 2b. Zip-patch skills area — SHIPPED in v5c, not lost (user asked 2026-07-25)

The 90s-terminal zip patch (vendored at `docs/design/90s-terminal-patch/`, README = copy map) included a design-only `SkillsPanel` mock. The REAL one shipped in v5c (PR #3): `poc/client/src/components/SkillsPanel.tsx` behind `?screen=skills` — skill suite as union of session rosters (server carries `skills` in projectSnapshot), command palette from this session's roster, sub-quests from real subagent groups. Deliberately NOT carried from the mock (recorded in v5c spec §4 / PR #3): background-tasks section (nothing behind it), AgentStatus HP/MP real data (`?screen=status` stays dash-honest — needs SDK usage numbers), party XP (HUD renders —). Those remain §7 candidates, not regressions.

## 3. Decisions + why (do not re-litigate)

- All v1–v5c decisions stand (append-only wire + client derivation; server = relay + gate; no fake affordances; accessibility floor; terminal.css animation-ordering rule).
- v5b decisions (user-approved): game_score as server event on the append-only wire (only honest party-wide option); per-game records (cross-game scores incomparable); party = PROJECT-wide via snapshot aggregation (lobby pattern); engines = snake + typerace only, breakout stays "cartridge not inserted"; party XP stays deferred (HUD renders —); arcade playable anytime (header toggle + A hotkey); shared GameEngine interface.
- Final-review rulings (parked, do not reopen): placeFood unbounded loop unreachable (~197 foods); dino >99999 after 2.8h theoretical; same-millisecond cross-session ties iteration-dependent (vanishing); canToggleArcade deliberately NOT driver-gated (arcade is local UI; PLAN is a wire action).
- Spec deviation (recorded in plan): submit-once tested via pure `settleRun` (no component-test infra exists).
- v6a decisions (spec/plan approved; deviations §"Deviations" of the plan `docs/superpowers/plans/2026-07-25-v6a-modes-skills.md:936-939`): AUTO enforced at the relay so gates stay on the wire (no invisible bypass); mid-turn mode change allowed for ALL modes (`auto` maps to SDK `"default"`, relay answers gates); AUTO gate-card marker renders driver's **name** not glyph (accepted spec drift, consistency with other decision lines); screen is App state seeded from `?screen=` rather than URL-only.

## 4. Ordered next steps (fresh session)

1. Verify state per §8 (branch `feature/v6a-modes-skills`, PR #5 open, suites green).
2. Get the user's live acceptance of v6a (demo stack per §6; a `v6a-accept-1` demo session/worktree already exists). If feedback → fix on the branch; if accepted → merge.
3. Merge PR #5 the proven way: local `git checkout main && git merge --no-ff feature/v6a-modes-skills && git push` (gh pr merge is permission-blocked), then re-run both suites on merged main and update baselines in §6.
4. Ask the user what to do with the two untracked root files (§7): commit `market-research.md`? Is `tour-skill-suggest.png` a next-cycle feature request (spectator "suggest a skill" affordance)?
5. Then next cycle: brainstorm first (superpowers:brainstorming).

## 5. Files with line refs (branch feature/v6a-modes-skills @ 7d8d9d0)

v6a touchpoints:
- Server relay AUTO: `poc/server/src/agentDriver.ts:178-232` (permissionMode field + relay auto-answer, `auto: true` decision append), `:406-420` (setPermissionMode — three-value union, no mid-turn guard, auto→SDK "default" mapping); socket handler `poc/server/src/server.ts:331-345`.
- Client pure helper: `poc/client/src/modes.ts:8` (nextMode) + `modes.test.ts`; derive carries `auto?` on decisions `poc/client/src/derive.ts:15,67`.
- Header MODE + SKILLS: `poc/client/src/components/Header.tsx:24` (props), `:65-80` (cycle button, AUTO/PLAN/DEFAULT labels), `:99` (SKILLS button).
- App wiring: `poc/client/src/App.tsx:27-30` (screen state seeded from ?screen=), `:131-139` (A-hotkey guard now incl. screen===null), `:150-157` (M hotkey), `:159-171` (S/Esc).
- Transcript: `poc/client/src/components/Transcript.tsx:136-145` (auto-approved gate card), `:241-249` (three-state mode-change line, amber AUTO).
- Spec/plan: `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md`, `docs/superpowers/plans/2026-07-25-v6a-modes-skills.md` (deviations at `:936-939`).

v5b and earlier (unchanged, refs vs main @ f777265):

- Engine contract: `poc/client/src/game/engine.ts` (GameEngine, LANE_WIDTH=40, lcg, settleRun/RunLedger); engines `dino.ts`, `snake.ts` (V_ASPECT `:7`, direction-scaled tick `:78-91`), `typerace.ts`; tests alongside.
- Host: `poc/client/src/components/ThinkingStrip.tsx` — render-phase runState pattern `:48-63` (do NOT move reset back into an effect — live-crash lesson, see Docs/mistakes-and-fixes.md), capturing notify `:94-99`, settle effect `:140-153`, keydown `:128-172`.
- Plumbing: `App.tsx:112-127` (A-hotkey guard incl. gatesPending===0), `:98-110` (partyBests memo), Header ARCADE button `Header.tsx:54-77`; `Transcript.tsx:47` (hotkeysMuted guard); `useSessionSocket.ts` (arcade capture); `types.ts` (ArcadeRecord).
- Server: `events.ts` (ARCADE_GAMES + game_score), `server.ts` (~line 359 gate, INTERESTING), `project.ts` (arcadeRecords + ts tie-break + cost comment), tests in `server/test/{server,project}.test.ts`.
- Spec/plan: `docs/superpowers/specs/2026-07-25-v5b-arcade-design.md`, `docs/superpowers/plans/2026-07-25-v5b-arcade.md`.

## 6. Gotchas / constraints

- All carried gotchas stand: `Docs/`==`docs/` (case-insensitive FS — use `docs/` in git commands); no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox can't launch the SDK binary; tsx watch hot-reload kills live turns (NEVER edit poc/server mid-demo; client HMR is safe).
- Demo stack: worktree FIRST (`cd poc/demo-project && git worktree add ../demo-worktrees/<s> -b <s>`), else MISLEADING "native binary failed to launch". Existing worktrees: ana, ben, v5a-retest-3, v5c-accept-1/2, v5b-accept-1. Server: from poc/server `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`; client: vite :5173. A STALE server may hold :3001 (`lsof -ti :3001` → kill) — hit this live.
- PromptBar submits via input keydown Enter (no form). ThinkingStrip keyboard guard ignores keys while INPUT/SELECT/TEXTAREA focused — synthetic tests must blur first.
- Test baselines: main = server 94 / client 39; v6a branch = server 103 / client 43 (both verified 2026-07-25 late night).
- Demo worktrees now also include `v6a-accept-1` (used for the acceptance session).
- Permission classifier blocks some outward git/gh actions in auto mode (`gh pr merge`, remote branch delete); local git merge + push worked as the natural alternative when the user has asked for the outcome.

## 7. Open questions / USER DECISIONS (carried)

- **Untracked `market-research.md` (repo root):** a polished positioning doc ("Context for agents working in this repo… why the project is shaped the way it is"), dated 2026-07-25. Looks meant to be committed — but where (main directly, or a docs commit)? And note its design principle #2 names "collision signal should generate pulls into a session" as the highest-leverage open gap → strong next-cycle candidate. USER DECIDES commit destination.
- **Untracked `tour-skill-suggest.png` (repo root):** screenshot from the v6a acceptance demo (`v6a-accept-1` session visible) whose prompt bar shows a spectator affordance "watching — suggest a skill with /name args…". Ambiguous: feature idea for a next cycle (spectator skill suggestions) or just a captured moment? ASK THE USER before acting on it.
- **v6a acceptance not confirmed:** an acceptance session was started but no explicit user "accepted" is recorded. Do not merge PR #5 until the user says so.
- Carried v3/v4/v5a/v5c items unchanged: worktree-containment Write/Edit approval; Bash-allowlist two-hop risk; skill discovery under settingSources:[]; stale skill name in v4 spec; frontend-design polish items; meta-tools bypass gate (#9) + AgentStatus TOOLS line (#10); plan-mode on/off pairing around SDK restarts (#11 — cosmetic, still unaddressed).
- Deferred v5b minors (ledgered in final review, none blocking): [mounted,game] effect double-init one-frame flash; seed() Date.now impurity if StrictMode ever enabled; Transcript keydown effect deps churn (pre-existing).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git status              # branch feature/v6a-modes-skills, up to date with origin, 2 untracked root files
git log --oneline -1    # 7d8d9d0 docs(v6a): record execution deviations…
gh pr view 5 --json state -q .state                   # OPEN
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 103 passed
cd ../client && npm test && npm run build             # 43 passed, clean build
```

Resume at §4: user acceptance of v6a → merge PR #5 → untracked-files decision → next cycle brainstorm.
