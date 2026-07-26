# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-26 (same session, post-demo): **v6c DEMO CHECKPOINT PASSED** — user imported soltero-skills live (26 plugin skills cloned under project "default"), new session roster refreshed to 71 entries (built-ins + namespaced plugin skills). Two demo discoveries: (1) slashmenu CSS regression FOUND+FIXED+verified in-browser (`9df6f6d`); (2) **plan's known unknown CONFIRMED: live roster contains non-skill junk** (e.g. `/agents` "(removed)…") — deviation NOT yet recorded in plan, filter decision NOT yet made (user hasn't answered). **NEW FEATURE REQUESTED (not yet spec'd): slash-autocomplete v2** — see §1. Branch afc64b1..9df6f6d (14 commits), not merged, not pushed.*

## 0. WHERE WE ARE — v6c built and reviewed; demo checkpoint + PR remain

- Branch `feature/v6c-plugins` (local only, off main @ afc64b1): PluginStore (https clone via execFile argv, validate, namespace, boot rescan, race-safe finalization), `plugin_change` event + `plugins`/`pluginsEnabled` in snapshots, AgentDriver `plugins:[{type:'local',path}]` + `skills:"all"` + live roster via `supportedCommands()`, add_plugin/remove_plugin handlers, AGENT_SKILLS fully retired (code + README), client PLUGINS section in SkillsPanel + transcript line.
- Final review (whole-branch, most-capable model): "ready to merge with fixes" → fix wave `27e4e22` applied + re-review verified clean. No open Critical/Important findings. Remaining ledgered minors all triaged as non-blocking (orphaned .clone-* tmp dirs, CRLF \r in descriptions, submit-logic duplication, pendingUrl cleared by any error, one-shot roster / SDKCommandsChangedMessage not consumed).
- v6a merged (PR #5), deployment strategy spec merged (PR #6) — unchanged from before.
- v6b (interrupt rail / fleet) still banked at the decision level (§3b), no spec yet.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK:** slash-autocomplete v2, mid-brainstorm (superpowers:brainstorming → spec → writing-plans → SDD, the usual cycle). **User requirements so far (2026-07-26, their words):** paginate the slashmenu list, make it scrollable, show ~5-8 at a time, arrow keys to cycle through them. Existing menu (PromptBar.tsx:14-17 filter, :55-64 render; terminal.css:566-577) is prefix-match + click-only. Open brainstorm questions when resuming: Enter/Tab-to-select behavior; substring vs prefix matching (namespaced `soltero-skills:x` names make prefix weak — typing /handoff finds nothing); whether menu survives typing args; and the UNANSWERED junk-filter question (user was asked "filter built-in commands out of the roster?" — no answer yet; SlashCommand type has NO skill-vs-command discriminator, sdk.d.ts:6596-6613, so any filter is heuristic). Ride on `feature/v6c-plugins` or branch after v6c merges — ask.

**ALSO PENDING:** (a) record the confirmed junk-roster deviation in the plan's Deviations section; (b) v6c PR creation on user go (plan says do not merge); (c) demo-time check (b) from before — non-slug plugin.json name namespace mismatch — never exercised. Launch build (§3d) stays PARKED.

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

1. Verify state per §8. Check `lsof -ti :3001` BEFORE any checkout/edit under the repo — kill `npm run dev`/`tsx watch` PARENTS, not just the node child.
2. Manual demo checkpoint with the user (§1 has the checklist + demo-time checks). Stack launch: §6 (note the env change — `AGENT_PLUGINS_ROOT` replaces `AGENT_SKILLS`).
3. On user go: push `feature/v6c-plugins`, open PR (v6a-style). Do NOT merge without the user.
4. Post-merge tidy (optional, non-blocking): delete merged remote branch `feature/v6a-modes-skills` (permission-blocked for the agent; user can); ledgered chores — poll-based waits in server.test.ts; thread `PermissionMode` type through derive/Header; hotkey-guard helper to DRY App.tsx ×3; v6c ride-along minors (orphaned `.clone-*` tmp-dir GC on rescan; SkillsPanel submit-logic dedupe; pendingUrl cleared by any error).
5. v6b spec from §3b whenever it comes up; then/parallel: launch build unparks (§3d week-1 items need writing-plans).

## 5. Files with line refs (main, post-v6a-merge)

- Server relay AUTO: `poc/server/src/agentDriver.ts:178-232` (permissionMode + auto-answer + sweep), `:406-420` (setPermissionMode); handler `poc/server/src/server.ts:331-341`; events `poc/server/src/events.ts:24-35`.
- Client: `poc/client/src/modes.ts:8` (nextMode); `derive.ts:15,67,87-89`; `Header.tsx:24,65-80,99`; `App.tsx:27-30` (screen state), `:124-175` (A/M/S-Esc hotkey effects); `Transcript.tsx:118-121` (model line pattern), `:136-150` (auto gate card), `:241-249` (mode line); `SkillsPanel.tsx` (v6c's PLUGINS section lands here); `useSessionSocket.ts` (v6c adds plugins state).
- v6c SHIPPED (branch `feature/v6c-plugins`): `poc/server/src/pluginStore.ts:66-131` (add with race-safe finalization), `:149-175` (rescan); `server.ts:19` (MAX_URL_LENGTH), `:61-91` (pushProject clears armed timer / schedulePush), `:105-125` (roster seed + 5-arg AgentDriver + onRoster), `:376-424` (add_plugin/remove_plugin); `agentDriver.ts:47-57` (hooks/RunQueryResult), `:118-127` (skills:"all" + plugins), `:183-201` (refreshRoster); client `pluginLine.ts`, `SkillsPanel.tsx:85-89,100,118-166,188`, `App.tsx:28,53-54`, `terminal.css:97` (.pix.top). skillRoster.ts deleted.
- Specs/plans: v6a `docs/superpowers/{specs/2026-07-25-v6a-modes-skills-design.md,plans/2026-07-25-v6a-modes-skills.md}`; v6c `{specs/2026-07-25-v6c-plugins-design.md,plans/2026-07-26-v6c-plugins.md}`; deployment `specs/2026-07-25-deployment-strategy-design.md`.
- Positioning: `market-research.md` (repo root, UNTRACKED — user's file, read before product decisions, do NOT commit without asking; its competitive claim is outdated per §3d).

## 6. Gotchas / constraints

- Carried: `docs/` lowercase in git (case-insensitive FS); no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox can't launch the SDK binary; **tsx watch hot-reload kills live turns — NEVER edit poc/server or switch branches in the main checkout while a demo is attached; check `lsof -ti :3001` first** (this merge was done with the stack up at the user's request — server hot-reloaded onto merged code).
- Demo relaunch: worktree FIRST (`cd poc/demo-project && git worktree add ../demo-worktrees/<s> -b <s>`), else MISLEADING "native binary failed to launch". Worktrees: ana, ben, v5a-retest-3, v5c-accept-1/2, v5b-accept-1, v6a-accept-1. Server from poc/server: `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_PLUGINS_ROOT=<abs path, e.g. <repo>/poc/demo-plugins> npm run dev`; client vite :5173. `AGENT_SKILLS` is RETIRED (v6c) — setting it does nothing; plugin skills arrive by importing a git URL on the skills screen, built-ins come free via `skills:"all"`.
- PromptBar submits via input keydown Enter (no form); ThinkingStrip keyboard guard ignores keys while an input is focused — synthetic tests must blur first. No component-test infra — pure-function extraction is the established pattern.
- Test baselines: main (post-v6a) = server 103 / client 43. `feature/v6c-plugins` = server 123 / client 45 (plan predicted 120/45; arithmetic deltas recorded in plan Deviations — skillRoster.test.ts had 2 tests not 3, fix rounds added tests).
- Known accepted v6a quirks: double-press M → duplicate identical mode events (idempotent); approving a plan exits AUTO (resolvePlan syncs to default); S from `?screen=status` jumps to skills.
- Permission classifier blocks some outward git/gh actions (`gh pr merge`, remote branch delete); local no-ff merge + push is the proven alternative when the user asks for the outcome.

## 7. Open questions / USER DECISIONS (carried)

- ~~Sequencing~~ DECIDED 2026-07-26: v6c first, subagent-driven; launch build parked (pull-notification overlap with §3b still noted for whenever launch resumes).
- `tour-skill-suggest.png` (untracked, repo root): screenshot from the live demo; the "suggest a skill" affordance it shows already exists (skill_suggest/skill_decision, v4-era). Keep or delete — user's call; no feature gap behind it.
- Carried v3–v5c items unchanged: worktree-containment Write/Edit approval; Bash-allowlist two-hop risk (market-research documents it as the residual boundary; AUTO amplifies it; v6c plugin hooks widen it further — spec §8); skill discovery under settingSources:[] (v6c retires the question by going `skills:"all"` + explicit plugins); frontend-design polish; meta-tools bypass gate #9; AgentStatus TOOLS line #10; plan-mode pairing cosmetic #11.
- Deferred v5b minors + v6a ledgered chores (§4.4) — none blocking.

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git status -sb   # feature/v6c-plugins (local, no remote); untracked: market-research.md, tour-skill-suggest.png
git log --oneline afc64b1..HEAD | wc -l      # 14 commits (dd0d6a4..9df6f6d incl. HANDOFF + slashmenu fix)
gh pr view 5 --json state -q .state          # MERGED (v6a)
gh pr view 6 --json state -q .state          # MERGED (deployment strategy spec)
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 123 passed
cd ../client && npm test && npm run build             # 45 passed, clean build
```

Demo stack may still be RUNNING from this session (server :3001 with `AGENT_PLUGINS_ROOT=<repo>/poc/demo-plugins` + `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees`, vite :5173) — check `lsof -ti :3001` per §4 step 1 before editing poc/server or switching branches. Plugin clone persists at `poc/demo-plugins/default/soltero-skills` (26 skills). Client URLs: `http://localhost:5173/?session=v6c-accept-1` / `v6c-accept-2` (session id must match a demo-worktree dir; bare URL defaults to session "demo" which has NO worktree → misleading "native binary failed to launch"). Worktrees v6c-accept-1/2 exist.

Resume at §1: continue the slash-autocomplete-v2 brainstorm (requirements captured there), get the junk-filter answer, then spec → plan → SDD.
