# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (afternoon): v2+v3+v4 MERGED to main via PR #1 (github.com/FrankieSoltero/multiplayer_ai, private; merge 1c6330d; 71/71+12/12+build verified on main). Branch deleted. CURRENT TASK: v5 design phase — brainstorm below.*

## 0. WHERE WE ARE — v5 DESIGN PHASE (starting)

**User's v5 asks (2026-07-25, verbatim intent):**
1. **Real agent-harness functionality** — "add all the functionality of an actual agent harness, like being able to call skills and workflows and other things along that line." Scope to pin in brainstorming: skills invocation (beyond the current AGENT_SKILLS listing), workflows/subagent orchestration, and what else qualifies (slash commands? hooks? plan mode? background tasks?).
2. **Multiple games to choose from** in the thinking strip (dino is the first; add a small selectable roster).
3. **Party-wide shared high score** — "keeping a highscore amongst everyone in the party." NOTE: v4 deliberately made game state local-only and listed "broadcast game state" as a NON-GOAL; v5 reverses that intentionally → needs wire/event design (e.g. a game_score event or project-level scoreboard) and a decision on per-session vs per-project scope.

**v5 backlog candidates to raise during brainstorming (carried from v4):** party pane <900px summary+toggle (spec gap, user decision pending); 4 structural polish items in docs/design/frontend-design-skill-notes.md; spec text still names soltero-skills:frontend-design (real: frontend-design:frontend-design); stream-death-mid-turn leaves busy stuck until next prompt (parked minor).

**Process:** start with superpowers:brainstorming (one question at a time), likely decompose into two sub-projects (harness capabilities vs games/scoreboard) -> spec -> writing-plans -> subagent-driven-development. All v1-v4 decisions stand (section 3).

**Live demo stack may still be running:** server :3001 (AGENT_WORKDIR_ROOT+AGENT_SKILLS), vite :5173; demo worktree ana has committed landing/future pages (54ad577).

## 1. Goal & current task

**Project goal:** YC Fall 2026 "Multiplayer AI" RFS exploration (dev-tools). v1 merged; v2+v3+v4 on `feature/project-hub`, unmerged.

**CURRENT TASK:** v5 design phase per section 0 — resume by invoking superpowers:brainstorming and driving it from the section-0 asks. v4 is DONE and merged; do not reopen it.

**PROCESS NOTE (2026-07-24, user):** when the context-watch hook fires (~40%), HARD STOP — refresh HANDOFF, tell user to `/clear`, end the turn.

## 2. Status

- v1: merged to main (`ad791fb`). v2+v3: complete on branch, merge-ready, held for §7.
- v4 spec: `docs/superpowers/specs/2026-07-24-product-design-terminal-multiplayer.md` (user-approved; constraint line amended for turn_end/identity/peek).
- v4 plan: `docs/superpowers/plans/2026-07-24-terminal-multiplayer-design.md` (12 tasks, all complete, every task review clean; fix loops: Task 1 one round).
- SDD ledger: `.superpowers/sdd/2026-07-24-terminal-multiplayer-design/progress.md` — deferred minors + surfaced conflicts recorded there; trust it + `git log` over memory.
- **Stopped exactly at: finishing-a-development-branch menu presented (merge local / push+PR / keep) + §7 decisions batched; user did a live co-walkthrough first (all features exercised, incl. deny flow, failover wheel handoff, sonnet switch). Live stack running: server :3001 (AGENT_WORKDIR_ROOT+AGENT_SKILLS), vite :5173.**

## 3. Decisions + why (do not re-litigate)

- All v1–v3 decisions stand (see git history of this file). New in v4:
- **Faithful terminal, two-pane tmux split, inline spinner-strip game (local-only), per-session driver-picked model, all four game motifs** — user-ratified in brainstorm (spec records the table).
- **turn_end / presence glyph+color / peek** — append-only wire additions the design itself requires; spec constraint line amended accordingly.
- **Model switching uses SDK `Query.setModel`** surfaced via optional member on `RunQueryResult` so test fakes stay assignable; model_change logged optimistically (trailing agent_error = switch may not have taken).
- **hashIdentity shift `>>>1` not `>>>3`** — plan's own variation test unsatisfiable with >>>3.
- **Subagent sandbox CANNOT launch the agent SDK native binary** — live stack must be started by the controller session (unsandboxed background Bash); subagents drive Playwright only.

## 4. Ordered next steps

1. `git add v4-*.png HANDOFF.md && git commit -m "test: v4 live acceptance — screenshots + HANDOFF refresh"`.
2. Final whole-branch review: `scripts/review-package PLAN 3cd6515 HEAD`, dispatch requesting-code-review's code-reviewer on the most capable model; include ledger path for deferred-minor triage.
3. If findings: ONE fix subagent (all findings), ONE scoped re-review, adjudicate residuals.
4. Present the batched user decisions (§7), then superpowers:finishing-a-development-branch; delete the plan workspace after a clean final review.

## 5. Files with line refs (v4 state)

- Server: `poc/server/src/models.ts` (MODELS map); `agentDriver.ts` (`RunQueryResult` ~:56-62, turnActive+turn_end in handleMessage result branch, `setModel` ~:251-270); `server.ts` (`set_model` handler after permission handler; glyph/color validation in join ~:162-170; `peek` before the !ctx guard ~:177-191); `events.ts` (union + glyph/color on presence_join); `session.ts:45-59` (join identity param).
- Client: `poc/client/src/{types,identity,derive}.ts` (+tests); `game/dino.ts` (+test); `useSessionSocket.ts`; `components/{Header,PromptBar,Transcript,PartyPane,ThinkingStrip,Lobby}.tsx`; `terminal.css` (design tokens at top; Task 11 refinements incl. :has() selectors, reduced-motion, focus-visible); `App.tsx` = gate (profile precedence ?name= → loadProfile → Lobby) + SessionView.
- Design docs: `docs/design/claude-design-brief.md`, `docs/design/frontend-design-skill-notes.md` (4 structural future-work items listed).
- Screenshots: repo-root `v4-{lobby,shell,thinking-game,permission,party-wheel}.png` (+ old step*.png, still uncommitted from v3 era — decide whether to commit or drop at finish time).

## 6. Gotchas / constraints

- All v3 gotchas stand (worktree containment, canUseTool never-null, Bash allowlist two-hop escape = ratification item, `Docs/`==`docs/`, no client auto-reconnect, `.superpowers/` git-excluded).
- **Subagent sandbox blocks the SDK native binary** — see §3; never let a subagent "debug" that as if it were a code bug.
- Demo stack: `poc/scripts/demo-setup.sh` (idempotent, rm -rf's demo dirs), server env `AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees AGENT_SKILLS=auth-migration-guide`, client vite on :5173 (check banner). Kill stale listeners on 3001/5173/5174 first.
- PARTY pane hides below 900px (`display:none`) — this contradicts spec §2 (summary+toggle); OPEN user decision, don't silently "fix".
- Client tests are node-env pure-module tests only (no jsdom); components verified by build + live acceptance.

## 7. Open questions / USER DECISIONS (batched — present before merge)

v3 ratification (carried): (1) worktree-containment-conditional Write/Edit approval; (2) Bash-allowlist two-hop residual risk acceptance; (3) project-skill discovery under settingSources:[].
New from v4: (4) party-pane <900px: implement spec's summary+toggle (small component task) or ratify display:none; (5) spec/HANDOFF said `soltero-skills:frontend-design` but the real skill is `frontend-design:frontend-design` (official plugin) — fix the spec text; (6) frontend-design-skill-notes lists 4 structural future-work items (perm .decided class, lobby label alignment, turn grouping, party collapse) — schedule or drop; (7) old step*.png v3 screenshots still untracked — commit or delete.

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout feature/project-hub
git log --oneline | head -5          # 7b17151 (Task 11) at/near top until acceptance commit lands
cat .superpowers/sdd/2026-07-24-terminal-multiplayer-design/progress.md
cd poc/server && npx vitest run      # 68 passed
cd ../client && npm test && npm run build   # 11 passed, clean
```

Live demo: §6 stack commands; tabs `?project=demo&session=ana` (fresh tab → lobby) and same-session second viewer `?project=demo&session=ana&name=ben` for wheel/model-switch scenarios. v1–v3 acceptance walkthrough still applies for the permission gate.
