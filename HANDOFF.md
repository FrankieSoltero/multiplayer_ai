# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (night): **v6a BUILT — PR #5 OPEN; demo stack RUNNING on the v6a branch; user checked out v6a live and liked it.** Full brainstorm→spec→plan→SDD cycle ran this session; v6b decisions banked (§3b); `market-research.md` absorbed. NEW: user asked how to implement ACTUAL plugins & skills — candidate next cycle, see §3c. Demo state: server :3001 + vite :5173 running FROM THE FEATURE-BRANCH working tree (do NOT git checkout or edit poc/ in the main checkout while it's up — hot-reload kills live turns); worktree `v6a-accept-1` created; user demoed live in session `v5b-accept-1` as "the-goat" (wheel handoffs, skill suggest, teammates digest all verified live).*

## 0. WHERE WE ARE — v6a on a branch, PR #5 open

- Branch `feature/v6a-modes-skills` (8 code commits + docs), pushed; **PR #5** → main: https://github.com/FrankieSoltero/multiplayer_ai/pull/5
- Final whole-branch review verdict: **ready to merge**, zero Critical/Important. Suites on branch head: server **103/103** (tsc clean), client **43/43** + clean build.
- main still holds only spec+plan docs commits (3fb2b4c spec, aff6560 plan, plus this HANDOFF).

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**CURRENT TASK:** v6a awaits the user's PR review/merge (same no-ff style as PRs #2–#4). After merge: v6b cycle — brainstorm is ALREADY DONE at the decision level (§3b banked answers); next session starts at spec-writing for v6b, not from scratch.

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP. Don't pair AskUserQuestion with long content in the same turn. SDD per superpowers skills (worked well again for v6a — 1 fix round total across 7 tasks).

## 2. What v6a shipped (on the branch)

- **Three-state permission mode DEFAULT → AUTO → PLAN.** `set_permission_mode` accepts `auto`; driver-only, allowed mid-turn (rescues gate-stuck turns). AUTO enforced at the RELAY: `AgentDriver.permissionMode` field; incoming gates auto-answered with `permission_decision { userId: session.driverId ?? "system", auto: true }` appended AFTER the request (wire honesty); entering auto sweeps pending gates once (attributed to mode-setter); leaving restores gating; plan requests NEVER auto-approved; SDK mode only ever set to plan/default (auto→SDK "default"); dead guard retained.
- **Client:** `modes.ts` (`nextMode`, MODE_ORDER, pure+tested); Header MODE control (▢ DEFAULT / ⚡ AUTO amber / ◉ PLAN) replacing the PLAN toggle (`permissionMode/canCycleMode/onCycleMode` props); `M` hotkey; transcript `⚡ auto-approved · AUTO set by <name>` + generalized mode-change line; `.planmode.auto.on` amber CSS (static only).
- **Skills discoverability:** `screen` is React state seeded by `?screen=` (deep links live); header SKILLS button; `S` toggles, `Esc` returns, BACK button in SkillsPanel; `A`/`M` hotkeys scoped to main screen; `?screen=status` stays URL-only.

## 3. Decisions + why (do not re-litigate)

- All v1–v5c decisions stand.
- v6a (user-approved in brainstorm): Shift+Tab REJECTED (browser reverse-focus-traversal; accessibility floor) → `M` hotkey chosen by user over Ctrl+.; auto = relay-enforced full gate auto-approval (not SDK acceptEdits — restart-bound + invisible bypass = dishonest wire); driver-only anytime incl. mid-turn; amber styling + wire-visible driver-attributed decisions are LOAD-BEARING mitigations (spec §7 names AUTO's tension with the approval-handoff headline primitive + trust-boundary widening).
- Recorded deviations (plan §Deviations): "leaving auto restores gating" test is two-prompt (original was non-deterministic); ⚡ AUTO marker shows driver NAME not glyph (consistent with transcript convention; spec drift accepted at final review).

## 3b. v6b BANKED DECISIONS (user answered these 2026-07-25 — start the spec from here)

- **Interrupt rail first, fleet cards second** (per market-research.md principle 2: build the interrupt system, not the stream). Screen leads with pulls — pending 🔐 gates across the server + file-collision alerts, one-click jump-in (loop: notice → drop in → act); per-project status cards (sessions, driver, busy/idle, last prompt, current tool) underneath. Team scope = everyone on this server (no auth/org model). NEVER name it "team hub".
- **Collision signal must generate PULLS, not just prompts.** `<teammates>` digest (server `digest.ts`: intent + last-5 tool-call file targets, injected per prompt) ALREADY EXISTS — the v6b delta is server-side file-overlap detection surfaced as human-facing interrupts in both sessions + fleet screen; agent-side is a small tiered add (detailed overlap warning appended to digest on collision). User chose "agents too, tiered" — mostly already built.
- **Presence, co-op framed:** focus-based, session-level ("which of your sessions is hot"), PARTY visual language — never person-level monitoring (surveillance objection; gamification is load-bearing).
- **Multi-session same-user:** same machinery as teammates + presence; user picked "shared identity presence" option.
- **Coordination = awareness + advisory overlap warnings** on top of worktree isolation. NOT locks, NOT task boards.
- **TUI client** = carried future direction ("shell program like Claude Code") — keep the wire protocol client-agnostic from now on.
- **Language:** "awareness" not "shared context"; "take the wheel"/"driver" everywhere.

## 3c. PLUGINS & SKILLS — new candidate cycle (user asked 2026-07-25, not yet brainstormed)

User: "how can we go about implementing actual plugins and skills?" Sketch given (user hasn't picked a layer yet — brainstorm properly next session):

- **Today's reality:** skills are real (SDK `skills:` option loads from worktree `.claude/skills/`, roster on wire, suggest/gate flow, SkillsPanel union) but allowlisted by the ops-level `AGENT_SKILLS` env var — a listing filter, not a sandbox; auto-discovery under `settingSources: []` never verified (carried §7 item).
- **Layer 1 (smallest, recommended start):** real per-project skill discovery — server scans the project repo's `.claude/skills/*/SKILL.md`, builds roster dynamically per session, drop the env var. Retires the §7 verification gap.
- **Layer 2:** plugins = MCP servers + skills + UI affordances via a per-project manifest (e.g. `.claude/plugins.json`); precedent in code: the `awareness` in-process MCP server in `agentDriver.ts` (`createSdkMcpServer`). Install/enable driver-gated.
- **Layer 3:** distribution/marketplace + trust — skills are a prompt-injection surface; interacts with the Bash-allowlist containment residual (market-research known risk). Needs a real trust story.
- Open sequencing question: does this jump ahead of the v6b fleet/interrupt cycle (§3b)? It's smaller and unblocks richer demos — user to decide.

## 4. Ordered next steps (fresh session)

1. Verify state per §8. NOTE: the main checkout may still be on `feature/v6a-modes-skills` serving the live demo — check `lsof -ti :3001` BEFORE any checkout/edit under the repo; kill the stack first if the user is done with it (the tsx supervisor respawns children — kill the `npm run dev`/`tsx watch` parents, not just the node child).
2. If PR #5 unmerged: ask the user to review/merge (or merge locally on request — gh pr merge may be permission-blocked; local `git merge --no-ff` + push worked before).
2b. Ask which cycle is next: plugins/skills (§3c, user's latest interest) or v6b interrupt rail (§3b). Brainstorm BEFORE building either.
3. Post-merge tidy (optional): delete remote branch; post-merge chores ledgered by final review (poll-based waits in server.test.ts; thread `PermissionMode` type through derive/Header; hotkey-guard helper to DRY App.tsx ×3) — none blocking.
4. v6b cycle: write spec from §3b (brainstorm-level decisions are done; spec §8 of v6a design doc has the same list) → plan → SDD.

## 5. Files with line refs (branch feature/v6a-modes-skills @ 7d8d9d0)

- Server: `events.ts:24-35` (auto?: true, mode "auto"); `agentDriver.ts` — permissionMode field ~:180, auto fast-path in onPermissionRequest hook ~:214, `allowAllPending` sweep (mirrors denyAllPending delete-first), `setPermissionMode` ~:406 (dead guard first line, no mid-turn guard, sdkMode mapping), resolvePlan syncs relay mode; `server.ts:331` handler (mode format checked BEFORE driver guard).
- Client: `modes.ts`; `derive.ts:15,88` (auto in decisions map, conditional spread — non-auto stays `{decision,userId}` exactly); `App.tsx` — screen state seeded from URL ~:30, A/M/S-Esc hotkey effects ~:126-175 (A/M gated on `props.screen === null`); `Header.tsx` MODE + SKILLS buttons; `Transcript.tsx:139-150,241-251`; `terminal.css:243-245`; `SkillsPanel.tsx` onBack.
- Docs: spec `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md`; plan (+Deviations) `docs/superpowers/plans/2026-07-25-v6a-modes-skills.md`; positioning `market-research.md` (repo root, UNTRACKED — user's file, read it before product decisions; do not commit without asking).

## 6. Gotchas / constraints

- All carried gotchas stand: `docs/` lowercase in git; no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox can't launch SDK binary; **tsx watch hot-reload kills live turns — NEVER edit poc/server while a demo is attached; check `lsof -ti :3001` first** (stack was killed this session with user approval; vite may still be up — HMR-safe).
- Demo relaunch: worktree FIRST (`cd poc/demo-project && git worktree add ../demo-worktrees/<s> -b <s>`); server from poc/server: `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`; client vite :5173. Existing worktrees: ana, ben, v5a-retest-3, v5c-accept-1/2, v5b-accept-1.
- Test baselines: **branch** server 103, client 43 (main still 94/39 until PR #5 merges).
- Known accepted quirks (final review, no action): double-press M before echo → duplicate identical mode events (idempotent); approving a plan exits AUTO (resolvePlan syncs to default — mention in demo if relevant); S from `?screen=status` jumps to skills.
- Permission classifier may block gh pr merge / remote branch delete in auto mode.

## 7. Open questions / USER DECISIONS (carried)

- PR #5: merge timing/style is the user's call.
- Carried v3–v5c items unchanged (worktree-containment approvals; Bash-allowlist two-hop risk — NOTE market-research.md documents it as the residual boundary, and AUTO mode amplifies it (spec §7); skill discovery under settingSources:[]; frontend-design polish; meta-tools bypass gate #9; AgentStatus TOOLS line #10; plan-mode pairing cosmetic #11 — v6a auto deliberately sidesteps it at the relay).
- v6b scope split (one cycle or interrupt-rail-first then presence)? — decide at spec time.

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git status -sb
gh pr view 5 --json state -q .state          # OPEN until user merges
git checkout feature/v6a-modes-skills
cd poc/server && npx tsc --noEmit && npx vitest run   # 103 passed
cd ../client && npm test && npm run build             # 43 passed, clean build
git checkout main
```

Resume at §4.
