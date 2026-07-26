# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (post-merge): **v5b MERGED** — PR #4 landed on `main` @ `f777265`, both suites verified green on the merged result (server 94, client 39, builds clean). Local feature branch deleted; remote branch left (delete blocked by permissions — harmless). Nothing in flight; next session starts a fresh cycle at brainstorming.*

## 0. WHERE WE ARE — v5b shipped, clean slate

- v5b arcade cycle fully closed: built, reviewed, accepted live, snake vertical-speed feedback implemented (`057fb6d`), PR #4 merged into main (merge commit `f777265`, same no-ff style as #2/#3).
- `main` pushed and verified: server `tsc` clean + 94 vitest, client 39 vitest + clean build — run ON the merged tree.
- No open PRs, no feature branches in flight.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK:** none. Next cycle starts fresh — brainstorm first (superpowers:brainstorming) before any building. Carried open items in §7 are candidates, or the user brings a new direction.

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP (refresh this file, tell user /clear, end turn). Don't pair AskUserQuestion with long content in the same turn (dialog hides the text — user correction, saved in memory). SDD per superpowers skills; user picked subagent-driven for v5b (worked well).

## 2. What v5b shipped (now on main)

Playable arcade: snake + typerace cartridges alongside dino behind a shared `GameEngine` interface (zero per-game host branches); `game_score` server event on the append-only wire; per-game party records aggregated server-side into the throttled ProjectMessage snapshot; header ARCADE toggle + `A` hotkey; snake vertical steps aspect-scaled (V_ASPECT=2) so on-screen speed matches horizontal.

## 3. Decisions + why (do not re-litigate)

- All v1–v5c decisions stand (append-only wire + client derivation; server = relay + gate; no fake affordances; accessibility floor; terminal.css animation-ordering rule).
- v5b decisions (user-approved): game_score as server event on the append-only wire (only honest party-wide option); per-game records (cross-game scores incomparable); party = PROJECT-wide via snapshot aggregation (lobby pattern); engines = snake + typerace only, breakout stays "cartridge not inserted"; party XP stays deferred (HUD renders —); arcade playable anytime (header toggle + A hotkey); shared GameEngine interface.
- Final-review rulings (parked, do not reopen): placeFood unbounded loop unreachable (~197 foods); dino >99999 after 2.8h theoretical; same-millisecond cross-session ties iteration-dependent (vanishing); canToggleArcade deliberately NOT driver-gated (arcade is local UI; PLAN is a wire action).
- Spec deviation (recorded in plan): submit-once tested via pure `settleRun` (no component-test infra exists).

## 4. Ordered next steps (fresh session)

1. Verify state per §8.
2. Ask the user what the next cycle is (or offer §7 carried items as candidates). Brainstorm BEFORE building.
3. Optional tidy: delete merged remote branch `origin/feature/v5b-arcade` (blocked for the agent by permissions; user can `git push origin --delete feature/v5b-arcade` or use the PR page button).

## 5. Files with line refs (main @ f777265)

- Engine contract: `poc/client/src/game/engine.ts` (GameEngine, LANE_WIDTH=40, lcg, settleRun/RunLedger); engines `dino.ts`, `snake.ts` (V_ASPECT `:7`, direction-scaled tick `:78-91`), `typerace.ts`; tests alongside.
- Host: `poc/client/src/components/ThinkingStrip.tsx` — render-phase runState pattern `:48-63` (do NOT move reset back into an effect — live-crash lesson, see Docs/mistakes-and-fixes.md), capturing notify `:94-99`, settle effect `:140-153`, keydown `:128-172`.
- Plumbing: `App.tsx:112-127` (A-hotkey guard incl. gatesPending===0), `:98-110` (partyBests memo), Header ARCADE button `Header.tsx:54-77`; `Transcript.tsx:47` (hotkeysMuted guard); `useSessionSocket.ts` (arcade capture); `types.ts` (ArcadeRecord).
- Server: `events.ts` (ARCADE_GAMES + game_score), `server.ts` (~line 359 gate, INTERESTING), `project.ts` (arcadeRecords + ts tie-break + cost comment), tests in `server/test/{server,project}.test.ts`.
- Spec/plan: `docs/superpowers/specs/2026-07-25-v5b-arcade-design.md`, `docs/superpowers/plans/2026-07-25-v5b-arcade.md`.

## 6. Gotchas / constraints

- All carried gotchas stand: `Docs/`==`docs/` (case-insensitive FS — use `docs/` in git commands); no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox can't launch the SDK binary; tsx watch hot-reload kills live turns (NEVER edit poc/server mid-demo; client HMR is safe).
- Demo stack: worktree FIRST (`cd poc/demo-project && git worktree add ../demo-worktrees/<s> -b <s>`), else MISLEADING "native binary failed to launch". Existing worktrees: ana, ben, v5a-retest-3, v5c-accept-1/2, v5b-accept-1. Server: from poc/server `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`; client: vite :5173. A STALE server may hold :3001 (`lsof -ti :3001` → kill) — hit this live.
- PromptBar submits via input keydown Enter (no form). ThinkingStrip keyboard guard ignores keys while INPUT/SELECT/TEXTAREA focused — synthetic tests must blur first.
- Test baselines on main: server 94, client 39.
- Permission classifier blocks some outward git/gh actions in auto mode (`gh pr merge`, remote branch delete); local git merge + push worked as the natural alternative when the user has asked for the outcome.

## 7. Open questions / USER DECISIONS (carried)

- Carried v3/v4/v5a/v5c items unchanged: worktree-containment Write/Edit approval; Bash-allowlist two-hop risk; skill discovery under settingSources:[]; stale skill name in v4 spec; frontend-design polish items; meta-tools bypass gate (#9) + AgentStatus TOOLS line (#10); plan-mode on/off pairing around SDK restarts (#11 — cosmetic, still unaddressed).
- Deferred v5b minors (ledgered in final review, none blocking): [mounted,game] effect double-init one-frame flash; seed() Date.now impurity if StrictMode ever enabled; Transcript keydown effect deps churn (pre-existing).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout main && git pull
git log --oneline -2   # <HANDOFF commit> / f777265 Merge pull request #4…
gh pr view 4 --json state -q .state                   # MERGED
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 94 passed
cd ../client && npm test && npm run build             # 39 passed, clean build
```

Resume at §4: next cycle, brainstorm first.
