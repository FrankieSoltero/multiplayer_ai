# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25, v4 (terminal-multiplayer product design) BUILT + live-acceptance PASSED; final whole-branch review pending.*

## 0. WHERE WE ARE (v4 executed; final review + user decisions remain)

1. **v3 (full CC capabilities + driver approval gate)** — ✅ complete + merge-ready (see §7 ratification items, still open).
2. **v4 (product design: "Terminal, but multiplayer")** — ✅ **ALL 12 TASKS COMPLETE** via subagent-driven development on `feature/project-hub`, commits `992440b..` (spec `992440b`, plan `8291274`, impl `8bbcbd6..7b17151`, acceptance pending commit). Live Playwright acceptance PASSED all 5 scenarios (lobby, terminal shell, thinking-strip dino game mid-turn, gated-command approval with `a` key, take-the-wheel + model switch to sonnet observed cross-tab). Server 68/68 tests, client 11/11, builds clean.
3. **What v4 shipped:** faithful Claude-Code terminal shell (terminal.css, no bubbles); Transcript with CC glyphs + amber 🔐 permission blocks + wheel-flourish + quest-log intents; PARTY pane; ThinkingStrip playable dino game (pure engine `game/dino.ts`); Lobby (name/glyph/color, live `peek` party preview, `?name=` bypass); per-session driver-picked agent/model (server `set_model`→`model_change`, SDK `Query.setModel`, between-turns only); `turn_end` event; presence glyph/color. Design deliverables: `docs/design/claude-design-brief.md` (self-contained brief for "Claude Design") + `docs/design/frontend-design-skill-notes.md` (real frontend-design skill test — verdict: useful as post-build critique/quality floor, weak for direction-setting against a pinned brief).

## 1. Goal & current task

**Project goal:** YC Fall 2026 "Multiplayer AI" RFS exploration (dev-tools). v1 merged; v2+v3+v4 on `feature/project-hub`, unmerged.

**CURRENT TASK:** finish the SDD loop for the v4 plan: (a) commit acceptance artifacts (v4-*.png + this HANDOFF), (b) dispatch the FINAL whole-branch review (most capable model, range `3cd6515..HEAD`, point it at the ledger's deferred-minor/parked lines), (c) one fix wave + one scoped re-review if findings, (d) surface the batched USER DECISIONS (§7), then `finishing-a-development-branch`.

**PROCESS NOTE (2026-07-24, user):** when the context-watch hook fires (~40%), HARD STOP — refresh HANDOFF, tell user to `/clear`, end the turn.

## 2. Status

- v1: merged to main (`ad791fb`). v2+v3: complete on branch, merge-ready, held for §7.
- v4 spec: `docs/superpowers/specs/2026-07-24-product-design-terminal-multiplayer.md` (user-approved; constraint line amended for turn_end/identity/peek).
- v4 plan: `docs/superpowers/plans/2026-07-24-terminal-multiplayer-design.md` (12 tasks, all complete, every task review clean; fix loops: Task 1 one round).
- SDD ledger: `.superpowers/sdd/2026-07-24-terminal-multiplayer-design/progress.md` — deferred minors + surfaced conflicts recorded there; trust it + `git log` over memory.
- **Stopped exactly at: Task 12 scenarios passed; acceptance commit + final whole-branch review NOT yet done.**

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
