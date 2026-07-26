# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (late night): v5b arcade FULLY IMPLEMENTED on `feature/v5b-arcade` @ `082bea6`, final review clean, suites green. Stopped at the ~40% context hook. TWO things pending: (1) user gave new feedback — snake vertical speed must match horizontal visually; (2) finishing-menu choice never answered (push+PR is precedent).*

## 0. WHERE WE ARE — v5b built, one tweak + finish flow left

- v5b cycle ran end-to-end this session: brainstorm (user-approved) → spec → plan → SDD execution (8 tasks, all reviewed) → live Playwright acceptance (all 6 checks) → final whole-branch review → fix wave → scoped re-review clean.
- Branch `feature/v5b-arcade`, 17 commits, HEAD `082bea6`. NOT pushed, NOT merged. Base is `main` @ `185404a`.
- SDD workspace deleted per skill (record = git history + this file). Suites: server 94, client 38, builds clean.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK (in order):**
1. Implement the user's new snake feedback (§2) on `feature/v5b-arcade`, with a test, suites green.
2. Re-present the finishing menu (merge locally / push+PR / keep). User never answered; v5a/v5c precedent is push + PR (#2, #3).

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP (refresh this file, tell user /clear, end turn). Don't pair AskUserQuestion with long content in the same turn (dialog hides the text — user correction, saved in memory). SDD process per superpowers skills; user picked subagent-driven for v5b.

## 2. USER FEEDBACK TO IMPLEMENT (verbatim + interpretation)

User: **"ok for snake it should be the same speed when going up vs side ways"**

Snake steps at the same CELL rate in all directions, but terminal cells are ~2× taller than wide, so vertical motion LOOKS ~2× faster. Fix: scale the step interval by direction — vertical steps take ~2× the time of horizontal ones (aspect ratio constant, e.g. `V_ASPECT = 2`). Implementation point: `poc/client/src/game/snake.ts` `tick()` (lines ~75-90) — stepTime currently `1 / speed` recomputed per iteration; make it `(dir is vertical ? V_ASPECT : 1) / speed` using `cur.pendingDir` (the direction the NEXT step will take). Keep per-iteration recompute (that was a review fix — commit `0a86b30`). Add a test discriminating vertical vs horizontal distance over the same duration (existing "advances right at ~8 cells/s" test style, `snake.test.ts`). Baseline test count: client 38 → 39.

## 3. Decisions + why (do not re-litigate)

- All v1–v5c decisions stand (append-only wire + client derivation; server = relay + gate; no fake affordances; accessibility floor; terminal.css animation-ordering rule).
- v5b decisions (user-approved in brainstorm): game_score as server event on the append-only wire (only honest party-wide option); per-game records (cross-game scores incomparable); party = PROJECT-wide, aggregated server-side into the throttled ProjectMessage snapshot (lobby pattern); engines = snake + typerace only, breakout stays "cartridge not inserted"; party XP stays deferred (HUD renders —); arcade playable anytime via header toggle + `A` hotkey (user chose this over ThinkingStrip-only); shared GameEngine interface, zero per-game host branches.
- Final-review rulings (parked, do not reopen): placeFood unbounded loop unreachable (~197 foods); dino >99999 after 2.8h theoretical; same-millisecond cross-session ties iteration-dependent (vanishing); canToggleArcade deliberately NOT driver-gated (arcade is local UI; PLAN is a wire action).
- Spec deviation (recorded in plan): submit-once tested via pure `settleRun` (no component-test infra exists).

## 4. Ordered next steps (fresh session)

1. `git checkout feature/v5b-arcade` (expect HEAD `082bea6`; verify per §8).
2. Implement §2 (snake vertical-speed aspect scaling) TDD-style: failing test in `poc/client/src/game/snake.test.ts`, fix in `snake.ts` tick(), `npm test` (39) + `npm run build` from poc/client. Commit `fix(v5b): snake — aspect-scaled vertical step time so up/down matches sideways visually`.
3. Sanity-check live if desired (§6 demo stack; worktree v5b-accept-1 already exists).
4. Present finishing menu (superpowers:finishing-a-development-branch): merge local / push+PR / keep. Precedent: push + PR against main.
5. After merge: HANDOFF refresh for next cycle; carried open items in §7.

## 5. Files with line refs (branch @ 082bea6)

- Snake (the pending change): `poc/client/src/game/snake.ts:75-90` (tick, per-iteration speed recompute), `:40-55` (initialState/DIRS/steer), `snake.test.ts:17-23` (speed test style).
- Engine contract: `poc/client/src/game/engine.ts` (GameEngine, LANE_WIDTH=40, lcg, settleRun/RunLedger); adapters at bottom of `dino.ts`, `snake.ts`, `typerace.ts`.
- Host: `poc/client/src/components/ThinkingStrip.tsx` — render-phase runState pattern `:48-63` (do NOT move reset back into an effect — live-crash lesson, see Docs/mistakes-and-fixes.md), capturing notify `:94-99`, settle effect `:140-153`, keydown `:128-172`.
- Plumbing: `App.tsx:112-127` (A-hotkey guard incl. gatesPending===0), `:98-110` (partyBests memo), Header ARCADE button `Header.tsx:54-77`; `Transcript.tsx:47` (hotkeysMuted guard); `useSessionSocket.ts` (arcade capture); `types.ts` (ArcadeRecord).
- Server: `events.ts` (ARCADE_GAMES + game_score), `server.ts` (~line 359 gate, INTERESTING), `project.ts` (arcadeRecords + ts tie-break + cost comment), tests in `server/test/{server,project}.test.ts`.
- Spec/plan: `docs/superpowers/specs/2026-07-25-v5b-arcade-design.md`, `docs/superpowers/plans/2026-07-25-v5b-arcade.md`.

## 6. Gotchas / constraints

- All carried gotchas stand: `Docs/`==`docs/` (case-insensitive FS — use `docs/` in git commands); no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox can't launch the SDK binary; tsx watch hot-reload kills live turns (NEVER edit poc/server mid-demo; client HMR is safe).
- Demo stack: worktree FIRST (`cd poc/demo-project && git worktree add ../demo-worktrees/<s> -b <s>`), else MISLEADING "native binary failed to launch". Existing worktrees: ana, ben, v5a-retest-3, v5c-accept-1/2, **v5b-accept-1** (new). Server: from poc/server `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`; client: vite :5173. A STALE server may hold :3001 (`lsof -ti :3001` → kill) — hit this live.
- PromptBar submits via input keydown Enter (no form). ThinkingStrip keyboard guard ignores keys while INPUT/SELECT/TEXTAREA focused — synthetic tests must blur first.
- Test baselines on branch: server 94, client 38 (snake fix → 39).
- terminal.css: no new animations were added in v5b; the ordering rule stands.
- Playwright acceptance evidence (this session): all 6 checks passed incl. WPM formula exact (370 = 372−2×1 miss) and busy-flip survival.

## 7. Open questions / USER DECISIONS (carried)

- PENDING NOW: finishing-menu choice for feature/v5b-arcade (§4 step 4).
- Carried v3/v4/v5a/v5c items unchanged: worktree-containment Write/Edit approval; Bash-allowlist two-hop risk; skill discovery under settingSources:[]; stale skill name in v4 spec; frontend-design polish items; meta-tools bypass gate (#9) + AgentStatus TOOLS line (#10); plan-mode on/off pairing around SDK restarts (#11 — still unaddressed in v5b, cosmetic).
- New deferred minors (ledgered in final review, none blocking): [mounted,game] effect double-init one-frame flash; seed() Date.now impurity if StrictMode ever enabled; Transcript keydown effect deps churn (pre-existing).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout feature/v5b-arcade
git log --oneline -3   # 082bea6 docs: capture v5b lessons… / 05645f4 fix(v5b): final-review fixes… / b93aac3 …
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 94 passed
cd ../client && npm test && npm run build             # 38 passed, clean build
```

Resume at §4 step 2: the snake vertical-speed fix (§2), then the finishing menu.
