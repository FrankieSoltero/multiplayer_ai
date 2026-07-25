# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (night): v5c MERGED (PR #3 → main `ee4c8a8`, branch deleted, main green: server 90 / client 22 / clean build). User said "start on v5b". Stopped at the ~40% context hook BEFORE any v5b work — fresh session starts the v5b cycle at brainstorming.*

## 0. WHERE WE ARE — v5c shipped, v5b not started

- v1–v5c all merged to main. v5c history: PR #3 (15 commits + screenshots + fix wave); its SDD ledger was deleted per skill (record is git history).
- ZERO v5b artifacts exist: no brainstorm, no spec, no plan, no branch. Do not look for them.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK:** run the v5b cycle from the very beginning, same shape as v5a/v5c: superpowers:brainstorming (user in the loop) → user-approved spec in `docs/superpowers/specs/` → superpowers:writing-plans → plan committed on a new `feature/v5b-*` branch off main → subagent-driven execution. Nothing is decided yet beyond the one-line concept.

**PROCESS NOTE (standing):** context-watch hook at ~40% = HARD STOP (refresh this file, tell user to /clear, end turn).

## 2. What v5b is (only what's known — everything else is for the brainstorm)

One line carried since v5a: **"game roster + party high score."** Deliberately deferred hooks already in main:
- `ThinkingStrip` has a 4-lane game roster where only dino is playable; snake/breakout/typerace render "cartridge not inserted" (`poc/client/src/components/ThinkingStrip.tsx:10-15` GAMES list, `:152` roster row).
- `ThinkingStrip` already accepts an optional `partyBest?: PartyBest` prop (`ThinkingStrip.tsx:17-19,30,124`) — NEVER passed anywhere; when absent it renders YOUR BEST from localStorage. Party-wide high score needs a wire/server story (brainstorm question).
- HUD `partyXp` field exists and renders `—` (`poc/client/src/components/Header.tsx:8-15`); usage/XP events were explicitly excluded from v5c (spec §8) and earmarked "v5b+".
- Dino engine: `poc/client/src/game/dino.ts:1-65` (pure functions: initialState/jump/tick/renderLane) — the pattern new game engines would follow.

## 3. Decisions + why (do not re-litigate)

- All v1–v5c decisions stand: append-only wire + client derivation; server = relay + gate; no fake affordances / dash-honest surfaces; pixel face = chrome only; accessibility floor (reduced-motion killswitch, --dim ≥ 5.72:1, :focus-visible).
- CSS gotcha now documented in-file: new animations must be declared above the reduced-motion kill list or added to the trailing override block (`poc/client/src/terminal.css` end-of-file comment) — a v5c final-review find; don't regress it.
- Cycle process locked by precedent: brainstorm → spec (user approves) → plan with full code inline → SDD execution with per-task review → final whole-branch review → push + PR (v5a PR #2, v5c PR #3).

## 4. Ordered next steps (fresh session)

1. `git checkout main && git pull` (expect HEAD `ee4c8a8` or later; verify main green per §8).
2. Invoke superpowers:brainstorming for v5b scope. Seed questions the brainstorm must answer: which game(s) get real engines; what "party high score" means (per-game? per-project? persistence: localStorage vs server event on the append-only wire); whether usage/XP events (HUD partyXp, CONTEXT) enter scope or stay deferred; whether the ThinkingStrip-only surface expands.
3. Write user-approved spec to `docs/superpowers/specs/2026-MM-DD-v5b-<name>.md`, commit on main or the feature branch per precedent (v5c committed spec+plan on the feature branch).
4. superpowers:writing-plans → `docs/superpowers/plans/…`, branch `feature/v5b-<name>` off main, then superpowers:subagent-driven-development.
5. Carry §7 open items into the brainstorm agenda where relevant (esp. #9 meta-tools bypass, plan-mode pairing observation).

## 5. Files with line refs (main @ ee4c8a8)

- Game/arcade: `poc/client/src/components/ThinkingStrip.tsx:10-15` (GAMES), `:17-19` (PartyBest iface), `:30` (prop), `:112-113` (g-swap), `:124-133` (best-line render); `poc/client/src/game/dino.ts:1-65` (engine pattern).
- HUD: `poc/client/src/components/Header.tsx:8-15` (HudData incl. partyXp), `App.tsx:80-88` (hud memo), `App.tsx:180` (hud prop).
- Wire (if server events enter v5b): `poc/server/src/events.ts` (event union), `poc/server/src/project.ts:31-60` (ProjectMessage/projectSnapshot — v5c added skills here), `poc/client/src/derive.ts` (client derivation).
- Process reference: `docs/superpowers/specs/2026-07-25-v5c-restyle-design.md`, `docs/superpowers/plans/2026-07-25-v5c-restyle.md` (the shape a v5b spec/plan should follow).

## 6. Gotchas / constraints

- All carried gotchas stand: `Docs/`==`docs/`; no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox CANNOT launch the SDK binary (controller runs the demo stack); tsx watch hot-reload kills live turns (never edit poc/server mid-demo).
- Fresh demo session needs a worktree FIRST: `cd poc/demo-project && git worktree add ../demo-worktrees/<session> -b <session>` — else SDK spawn fails with a MISLEADING "native binary failed to launch" banner. Existing worktrees: ana, ben, v5a-retest-3, v5c-accept-1, v5c-accept-2. Stack: server :3001 `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev` (from poc/server); vite :5173 (from poc/client).
- Test baselines on main: server 90, client 22.
- Live SDK facts (documented, not bugs): Skill "Unknown skill" under settingSources:[] (agent self-recovers); meta-tools (ToolSearch/TaskCreate/TaskUpdate/Agent) bypass canUseTool; a/d keys ignored while an input is focused; server emits paired plan-mode on/off events around SDK session restarts (e.g. after model switch) — pre-existing, single toggle click = exactly one event.
- terminal.css animation ordering (§3) — new animated rules appended after the reduced-motion kill block silently escape it; use the trailing override block.

## 7. Open questions / USER DECISIONS (carried)

Carried v3: (1) worktree-containment Write/Edit approval; (2) Bash-allowlist two-hop residual risk; (3) skill discovery under settingSources:[] broken — accept self-recovery or investigate SDK.
Carried v4/v5a: (5) stale skill name in v4 spec text; (6) 4 polish items in frontend-design-skill-notes; (8) v5a deferred minors (git history of this file @ bf889d4); (9) meta-tools bypassing the gate — accept or raise upstream.
Carried v5c: (10) AgentStatus TOOLS lists "Agent · spawns subagents" ungated — factually correct today because of #9; revisit together. (11) plan-mode on/off pairing around SDK restarts — cosmetic transcript noise; fix in v5b or accept.
v5b scope questions themselves → §4 step 2 (they're brainstorm inputs, not blockers).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout main && git pull
git log --oneline -1                                  # ee4c8a8 Merge pull request #3 …
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 90 passed
cd ../client && npm test && npm run build             # 22 passed, clean build
```

Resume at §4 step 2: superpowers:brainstorming for v5b ("game roster + party high score"). Nothing about v5b is decided — the brainstorm is the first move.
