# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25: v5b DONE — snake vertical-speed feedback implemented (`057fb6d`), branch pushed, **PR #4 open against main** (user chose push+PR). Suites: server 94, client 39, builds clean. Nothing in flight; next session starts at PR merge or the next cycle.*

## 0. WHERE WE ARE — v5b complete, PR #4 awaiting merge

- v5b cycle fully closed this session: the last user feedback (snake vertical speed) implemented TDD-style, finishing menu answered (push + PR, matching v5a #2 / v5c #3 precedent).
- Branch `feature/v5b-arcade` pushed; PR: https://github.com/FrankieSoltero/multiplayer_ai/pull/4 (base `main` @ `185404a`). NOT merged.
- Local branch/checkout preserved for PR-feedback iteration.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK:** none in flight. Next session either (a) handles PR #4 feedback / merge, or (b) starts the next cycle (brainstorm first, per process).

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP (refresh this file, tell user /clear, end turn). Don't pair AskUserQuestion with long content in the same turn (dialog hides the text — user correction, saved in memory). SDD process per superpowers skills; user picked subagent-driven for v5b.

## 2. Snake vertical-speed fix (DONE — `057fb6d`)

User feedback "same speed when going up vs sideways" implemented: `V_ASPECT = 2` in `poc/client/src/game/snake.ts:7`; `tick()` scales step time by pending direction (`snake.ts:85` — `(cur.pendingDir[1] !== 0 ? V_ASPECT : 1) / speed`), keeping the per-iteration speed recompute (review fix `0a86b30`). New test `snake.test.ts:73-79`; the pre-existing self-collision test's tick duration updated 0.2→0.3s (`snake.test.ts:55`) because its single step is now vertical (0.25s). Client baseline 38 → 39.

## 3. Decisions + why (do not re-litigate)

- All v1–v5c decisions stand (append-only wire + client derivation; server = relay + gate; no fake affordances; accessibility floor; terminal.css animation-ordering rule).
- v5b decisions (user-approved in brainstorm): game_score as server event on the append-only wire (only honest party-wide option); per-game records (cross-game scores incomparable); party = PROJECT-wide, aggregated server-side into the throttled ProjectMessage snapshot (lobby pattern); engines = snake + typerace only, breakout stays "cartridge not inserted"; party XP stays deferred (HUD renders —); arcade playable anytime via header toggle + `A` hotkey (user chose this over ThinkingStrip-only); shared GameEngine interface, zero per-game host branches.
- Finishing choice: push + PR against main (user answered the menu this session; PR #4).
- Final-review rulings (parked, do not reopen): placeFood unbounded loop unreachable (~197 foods); dino >99999 after 2.8h theoretical; same-millisecond cross-session ties iteration-dependent (vanishing); canToggleArcade deliberately NOT driver-gated (arcade is local UI; PLAN is a wire action).
- Spec deviation (recorded in plan): submit-once tested via pure `settleRun` (no component-test infra exists).

## 4. Ordered next steps (fresh session)

1. Check PR #4 state (`gh pr view 4`). If review feedback exists, iterate on `feature/v5b-arcade` (checkout, fix, push).
2. If/when user merges: `git checkout main && git pull`, then optionally delete the local branch.
3. Next cycle: brainstorm first (superpowers:brainstorming) — carried open items in §7 are candidates.

## 5. Files with line refs (branch, post-`057fb6d`)

- Snake: `poc/client/src/game/snake.ts:7` (V_ASPECT), `:78-91` (tick, direction-scaled stepTime), `:49-54` (steer); tests `snake.test.ts:73-79` (vertical-speed), `:49-58` (self-collision, 0.3s tick).
- Engine contract: `poc/client/src/game/engine.ts` (GameEngine, LANE_WIDTH=40, lcg, settleRun/RunLedger); adapters at bottom of `dino.ts`, `snake.ts`, `typerace.ts`.
- Host: `poc/client/src/components/ThinkingStrip.tsx` — render-phase runState pattern `:48-63` (do NOT move reset back into an effect — live-crash lesson, see Docs/mistakes-and-fixes.md), capturing notify `:94-99`, settle effect `:140-153`, keydown `:128-172`.
- Plumbing: `App.tsx:112-127` (A-hotkey guard incl. gatesPending===0), `:98-110` (partyBests memo), Header ARCADE button `Header.tsx:54-77`; `Transcript.tsx:47` (hotkeysMuted guard); `useSessionSocket.ts` (arcade capture); `types.ts` (ArcadeRecord).
- Server: `events.ts` (ARCADE_GAMES + game_score), `server.ts` (~line 359 gate, INTERESTING), `project.ts` (arcadeRecords + ts tie-break + cost comment), tests in `server/test/{server,project}.test.ts`.
- Spec/plan: `docs/superpowers/specs/2026-07-25-v5b-arcade-design.md`, `docs/superpowers/plans/2026-07-25-v5b-arcade.md`.

## 6. Gotchas / constraints

- All carried gotchas stand: `Docs/`==`docs/` (case-insensitive FS — use `docs/` in git commands); no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox can't launch the SDK binary; tsx watch hot-reload kills live turns (NEVER edit poc/server mid-demo; client HMR is safe).
- Demo stack: worktree FIRST (`cd poc/demo-project && git worktree add ../demo-worktrees/<s> -b <s>`), else MISLEADING "native binary failed to launch". Existing worktrees: ana, ben, v5a-retest-3, v5c-accept-1/2, v5b-accept-1. Server: from poc/server `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`; client: vite :5173. A STALE server may hold :3001 (`lsof -ti :3001` → kill) — hit this live.
- PromptBar submits via input keydown Enter (no form). ThinkingStrip keyboard guard ignores keys while INPUT/SELECT/TEXTAREA focused — synthetic tests must blur first.
- Test baselines on branch: server 94, client 39.
- terminal.css: no new animations were added in v5b; the ordering rule stands.
- Playwright acceptance evidence: all 6 checks passed incl. WPM formula exact (370 = 372−2×1 miss) and busy-flip survival. (The snake aspect fix landed after acceptance; covered by unit test, not re-run live.)

## 7. Open questions / USER DECISIONS (carried)

- Carried v3/v4/v5a/v5c items unchanged: worktree-containment Write/Edit approval; Bash-allowlist two-hop risk; skill discovery under settingSources:[]; stale skill name in v4 spec; frontend-design polish items; meta-tools bypass gate (#9) + AgentStatus TOOLS line (#10); plan-mode on/off pairing around SDK restarts (#11 — still unaddressed in v5b, cosmetic).
- Deferred minors (ledgered in final review, none blocking): [mounted,game] effect double-init one-frame flash; seed() Date.now impurity if StrictMode ever enabled; Transcript keydown effect deps churn (pre-existing).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout feature/v5b-arcade
git log --oneline -2   # <HANDOFF commit> / 057fb6d fix(v5b): snake — aspect-scaled vertical step time…
gh pr view 4           # v5b: arcade — playable snake + typerace with party-wide records (open, base main)
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 94 passed
cd ../client && npm test && npm run build             # 39 passed, clean build
```

Resume at §4: PR #4 feedback/merge, then next cycle.
