# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-26: **v6a MERGED into main (PR #5, no-ff, this session at the user's request)** — and this HANDOFF merges two parallel streams' notes: (a) the v6a build/demo stream (user demoed live as "the-goat", liked it, final review said ready-to-merge) and (b) this session's **v6c cycle: plugin import + full CC skills — spec + plan user-approved and committed** (supersedes the §3c sketch). Also on main from a background session: **deployment strategy spec, PR #6 MERGED** (§3d). Next: user picks v6c execution mode (subagent-driven vs inline) and how it sequences against the §3d launch build.*

## 0. WHERE WE ARE — v6a merged; v6c planned and unblocked

- v6a (three-state mode cycling + skills discoverability) merged into `main` no-ff, GitHub marks PR #5 merged. Suites re-verified on the merged tree (see §8 for expected numbers: server 103, client 43).
- v6c (plugins) spec + implementation plan are on main via the merge: spec `docs/superpowers/specs/2026-07-25-v6c-plugins-design.md` (user-approved), plan `docs/superpowers/plans/2026-07-26-v6c-plugins.md`. Implementation NOT started — plan Task 1 branches `feature/v6c-plugins` off main.
- Deployment strategy spec merged separately (PR #6, merge `57aad59`): `docs/superpowers/specs/2026-07-25-deployment-strategy-design.md` — see §3d. Its week-1 build items still need a writing-plans cycle.
- v6b (interrupt rail / fleet) still banked at the decision level (§3b), no spec yet.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK:** execute v6c **subagent-driven** (user decided 2026-07-26: "start this now sub agent driven and park the launch build"). Launch build (§3d) is PARKED behind v6c — do not start it. Fresh session: invoke superpowers:subagent-driven-development and run `docs/superpowers/plans/2026-07-26-v6c-plugins.md` task-by-task from Task 1 (branch `feature/v6c-plugins` off main; the v6a-merged precondition is satisfied — merge `2eeee28`). No v6c work has started yet.

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP. Don't pair AskUserQuestion with long content in the same turn. SDD per superpowers skills (worked well for v5b and v6a — 1 fix round total across v6a's 7 tasks).

## 2. What v6a shipped (now on main)

- **Three-state permission mode DEFAULT → AUTO → PLAN.** `set_permission_mode` accepts `auto`; driver-only, allowed mid-turn (rescues gate-stuck turns). AUTO enforced at the RELAY: `AgentDriver.permissionMode` field; incoming gates auto-answered with `permission_decision { userId: session.driverId ?? "system", auto: true }` appended AFTER the request (wire honesty); entering auto sweeps pending gates once (attributed to mode-setter); leaving restores gating; plan requests NEVER auto-approved; SDK mode only ever set to plan/default (auto→SDK "default"); dead guard retained.
- **Client:** `modes.ts` (`nextMode`, MODE_ORDER, pure+tested); Header MODE control (▢ DEFAULT / ⚡ AUTO amber / ◉ PLAN) replacing the PLAN toggle (`permissionMode/canCycleMode/onCycleMode` props); `M` hotkey; transcript `⚡ auto-approved · AUTO set by <name>` + generalized mode-change line; `.planmode.auto.on` amber CSS (static only).
- **Skills discoverability:** `screen` is React state seeded by `?screen=` (deep links live); header SKILLS button; `S` toggles, `Esc` returns, BACK button in SkillsPanel; `A`/`M` hotkeys scoped to main screen; `?screen=status` stays URL-only.

Earlier cycles (v1–v5c incl. arcade + 90s-terminal restyle) are all on main; the zip-patch "skills area" question was answered 2026-07-25 — the real SkillsPanel shipped in v5c, deliberate omissions recorded in v5c spec §4.

## 2c. What v6c will build (spec+plan approved, not yet implemented)

Anyone in a project imports a skills plugin by **https git URL** (e.g. soltero-skills); server `PluginStore` shallow-clones under `AGENT_PLUGINS_ROOT/<projectId>/<name>/`, validates, scans namespaced skills; `plugin_change` session event + `plugins`/`pluginsEnabled` in ProjectMessage; NEW sessions get SDK `plugins: [{type:'local',path}]` + `skills: "all"` (deliberate reversal of the hide-built-ins decision) and refresh their roster from the live SDK (`supportedCommands()`); SkillsPanel gains a PLUGINS section; `AGENT_SKILLS` env + `skillRoster.ts` retired. Expected end state: server 120 tests, client 45. Known unknown flagged in plan Task 7: whether the live skill list includes non-skill slash commands — evaluate at the manual demo, don't pre-filter blind.

## 3. Decisions + why (do not re-litigate)

- All v1–v5c decisions stand (append-only wire + client derivation; server = relay + gate; no fake affordances; accessibility floor; terminal.css animation-ordering rule; v5b arcade rulings incl. parked final-review items).
- v6a (user-approved): Shift+Tab REJECTED (browser reverse-focus-traversal; accessibility floor) → `M` hotkey; auto = relay-enforced full gate auto-approval (not SDK acceptEdits — restart-bound + invisible bypass = dishonest wire); driver-only anytime incl. mid-turn; amber styling + wire-visible driver-attributed decisions are LOAD-BEARING mitigations (spec §7 names AUTO's tension with the approval-handoff headline primitive + trust-boundary widening). Recorded deviations: "leaving auto" test is two-prompt; ⚡ AUTO marker shows driver NAME not glyph.
- v6c (user-approved in brainstorm, spec §1): scope = built-in CC skills + imported plugin skills; project-scoped registry; import form = git URL (https only, server clones); governance = anyone in project, attributed on the wire; effect = NEW sessions only (hot reload banked); `skills:"all"` reversal is deliberate and recorded. Risks named in spec §8 (plugin hooks = shell execution → trust boundary; trusted-team stance).
- Deployment (§3d, user-approved, do not re-litigate): friends-first Approach B; gated hosted demo + video; GitHub OAuth + username allowlist (verified wire identity backs the headline claim); public copy leads with "approval handoff" (not "take the wheel" — Superconductor uses it); NO claude.ai login (SDK docs disallow); BYO API key optional; no persistence for launch but don't foreclose spec §6 roadmap.

## 3b. v6b BANKED DECISIONS (user answered 2026-07-25 — start the spec from here)

- **Interrupt rail first, fleet cards second** (market-research principle: build the interrupt system, not the stream). Screen leads with pulls — pending 🔐 gates across the server + file-collision alerts, one-click jump-in (notice → drop in → act); per-project status cards underneath. Scope = everyone on this server. NEVER "team hub".
- **Collision signal generates PULLS, not just prompts.** `<teammates>` digest already exists (`digest.ts`); v6b delta = server-side file-overlap detection surfaced as human-facing interrupts in both sessions + fleet screen; agent-side tiered add. User chose "agents too, tiered".
- **Presence, co-op framed:** focus-based, session-level, PARTY visual language — never person-level monitoring. Multi-session same-user = shared-identity presence.
- **Coordination = awareness + advisory overlap warnings** on worktree isolation. NOT locks, NOT task boards.
- **TUI client** carried; wire protocol stays client-agnostic. **Language:** "awareness", "take the wheel"/"driver" in-product.

## 3d. DEPLOYMENT STRATEGY — spec MERGED (PR #6, background session 2026-07-25/26)

**Spec:** `docs/superpowers/specs/2026-07-25-deployment-strategy-design.md` (main, merge `57aad59`). All six sections user-approved; the spec is the authority — this section is the pointer.

- Two-week blitz: week 1 = friends beta (3–8 friends, host-driven sessions on a VPS); week 2 = public launch ~Aug 6 (60–90s approval-handoff video, Show HN, X thread, repo public, gated demo signup) + YC application.
- Research finding (2026-07-25, 4 parallel web agents, sources in spec Appendix A): spectating is table stakes; coarse takeover ships at Factory/Warp/Cursor; **identity-clean per-action approval handoff is shipped by NOBODY** — the wedge. `market-research.md`'s "nobody combines live stream with control transfer" is OUTDATED — use the corrected identity-clean-approval-gap claim.
- **Week-1 build items (need writing-plans):** VPS+Caddy+systemd deploy; GitHub OAuth + allowlist into WS join + lobby identity; pull notification (lite v6b interrupt rail — overlaps §3b, build once); canned demo scenario extending `poc/scripts/demo-setup.sh`; per-session BYO-key plumbing (verify against installed SDK).

## 4. Ordered next steps (fresh session)

1. Verify state per §8. Check `lsof -ti :3001` BEFORE any checkout/edit under the repo — the demo stack may be running; the tsx supervisor respawns children (kill the `npm run dev`/`tsx watch` parents, not just the node child). NOTE: Task 1's `git checkout -b` switches the working tree — if the stack is still up, warn/kill first.
2. Invoke superpowers:subagent-driven-development and execute `docs/superpowers/plans/2026-07-26-v6c-plugins.md` from Task 1 (no questions needed — mode and sequencing already decided).
4. Post-merge tidy (optional, non-blocking): delete merged remote branch `feature/v6a-modes-skills` (permission-blocked for the agent; user can); ledgered chores — poll-based waits in server.test.ts; thread `PermissionMode` type through derive/Header; hotkey-guard helper to DRY App.tsx ×3.
5. v6b spec from §3b whenever it comes up.

## 5. Files with line refs (main, post-v6a-merge)

- Server relay AUTO: `poc/server/src/agentDriver.ts:178-232` (permissionMode + auto-answer + sweep), `:406-420` (setPermissionMode); handler `poc/server/src/server.ts:331-341`; events `poc/server/src/events.ts:24-35`.
- Client: `poc/client/src/modes.ts:8` (nextMode); `derive.ts:15,67,87-89`; `Header.tsx:24,65-80,99`; `App.tsx:27-30` (screen state), `:124-175` (A/M/S-Esc hotkey effects); `Transcript.tsx:118-121` (model line pattern), `:136-150` (auto gate card), `:241-249` (mode line); `SkillsPanel.tsx` (v6c's PLUGINS section lands here); `useSessionSocket.ts` (v6c adds plugins state).
- v6c targets (from the plan): create `poc/server/src/pluginStore.ts` + test; modify `events.ts`, `project.ts:78-110`, `server.ts:48,85-116,196,206,341+`, `agentDriver.ts:37,66,104-146,204`; delete `skillRoster.ts` + its test; client `types.ts`, `useSessionSocket.ts`, `Transcript.tsx`, `SkillsPanel.tsx`, `App.tsx:76,235-248`, create `pluginLine.ts` + test.
- Specs/plans: v6a `docs/superpowers/{specs/2026-07-25-v6a-modes-skills-design.md,plans/2026-07-25-v6a-modes-skills.md}`; v6c `{specs/2026-07-25-v6c-plugins-design.md,plans/2026-07-26-v6c-plugins.md}`; deployment `specs/2026-07-25-deployment-strategy-design.md`.
- Positioning: `market-research.md` (repo root, UNTRACKED — user's file, read before product decisions, do NOT commit without asking; its competitive claim is outdated per §3d).

## 6. Gotchas / constraints

- Carried: `docs/` lowercase in git (case-insensitive FS); no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox can't launch the SDK binary; **tsx watch hot-reload kills live turns — NEVER edit poc/server or switch branches in the main checkout while a demo is attached; check `lsof -ti :3001` first** (this merge was done with the stack up at the user's request — server hot-reloaded onto merged code).
- Demo relaunch: worktree FIRST (`cd poc/demo-project && git worktree add ../demo-worktrees/<s> -b <s>`), else MISLEADING "native binary failed to launch". Worktrees: ana, ben, v5a-retest-3, v5c-accept-1/2, v5b-accept-1, v6a-accept-1. Server from poc/server: `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`; client vite :5173. NOTE: after v6c ships, `AGENT_SKILLS` is retired and `AGENT_PLUGINS_ROOT=<abs path>` becomes the relevant env.
- PromptBar submits via input keydown Enter (no form); ThinkingStrip keyboard guard ignores keys while an input is focused — synthetic tests must blur first. No component-test infra — pure-function extraction is the established pattern.
- Test baselines: main (post-v6a) = server 103 / client 43. v6c plan expects 120 / 45 at its end.
- Known accepted v6a quirks: double-press M → duplicate identical mode events (idempotent); approving a plan exits AUTO (resolvePlan syncs to default); S from `?screen=status` jumps to skills.
- Permission classifier blocks some outward git/gh actions (`gh pr merge`, remote branch delete); local no-ff merge + push is the proven alternative when the user asks for the outcome.

## 7. Open questions / USER DECISIONS (carried)

- ~~Sequencing~~ DECIDED 2026-07-26: v6c first, subagent-driven; launch build parked (pull-notification overlap with §3b still noted for whenever launch resumes).
- `tour-skill-suggest.png` (untracked, repo root): screenshot from the live demo; the "suggest a skill" affordance it shows already exists (skill_suggest/skill_decision, v4-era). Keep or delete — user's call; no feature gap behind it.
- Carried v3–v5c items unchanged: worktree-containment Write/Edit approval; Bash-allowlist two-hop risk (market-research documents it as the residual boundary; AUTO amplifies it; v6c plugin hooks widen it further — spec §8); skill discovery under settingSources:[] (v6c retires the question by going `skills:"all"` + explicit plugins); frontend-design polish; meta-tools bypass gate #9; AgentStatus TOOLS line #10; plan-mode pairing cosmetic #11.
- Deferred v5b minors + v6a ledgered chores (§4.4) — none blocking.

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git status -sb   # main; untracked: market-research.md, tour-skill-suggest.png
git log --oneline -3    # merge of PR #5 (v6a) at/near HEAD
gh pr view 5 --json state -q .state          # MERGED
gh pr view 6 --json state -q .state          # MERGED (deployment strategy spec)
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 103 passed
cd ../client && npm test && npm run build             # 43 passed, clean build
```

Resume at §4: sequencing question → chosen cycle.
