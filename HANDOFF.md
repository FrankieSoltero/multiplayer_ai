# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-25 (night): v5a MERGED (PR #2 → main `1591089`). v5c restyle cycle: spec APPROVED + plan COMMITTED on `feature/v5c-restyle` (HEAD `752e274`). User chose SUBAGENT-DRIVEN execution. Stopped at the ~45% context hook BEFORE dispatching Task 1 — fresh session starts execution.*

## 0. WHERE WE ARE — v5c ready to execute, zero tasks dispatched

- v5a is done and merged (PR #2). All v5a history lives in git; don't revisit.
- v5c brainstorm → spec → plan cycle COMPLETE this session:
  - Spec (user-approved, incl. "skill suite" naming): `docs/superpowers/specs/2026-07-25-v5c-restyle-design.md` (commit `d7e437e`)
  - Plan (12 tasks, full merged code inline): `docs/superpowers/plans/2026-07-25-v5c-restyle.md` (commit `752e274`)
- **Execution choice made by user: Subagent-Driven** → fresh session invokes `superpowers:subagent-driven-development` on the plan, starting at Task 1. NO tasks dispatched yet; no SDD ledger exists yet.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration. v1–v5a merged to main. v5b (game roster + party high score) still unstarted, after v5c.

**CURRENT TASK:** execute `docs/superpowers/plans/2026-07-25-v5c-restyle.md` via superpowers:subagent-driven-development (one subagent per task, per-task review, ledger in `.superpowers/sdd/2026-07-25-v5c-restyle/progress.md` — create on first task, same pattern as v5a).

**PROCESS NOTE (standing):** context-watch hook at ~40% = HARD STOP (refresh this file, tell user to /clear, end turn).

## 2. What v5c is (one paragraph)

Port the user's 90s-terminal design patch (vendored by plan Task 1 to `docs/design/90s-terminal-patch/`; source zip at repo root `Multiplayer AI 90s Terminal UI.zip`) onto the v5a client with zero functional regressions, plus ONE feature: the party-wide skill suite (`?screen=skills` union of all sessions' rosters), fed by adding `skills` to `projectSnapshot`. HUD shows only client-derivable numbers (TURN/TOOLS/gated); CONTEXT & PARTY XP render `—`. The patch predates v5a, so it's a port, not a file replace — plan Tasks 2–9 carry the full merged component code inline; do NOT copy REF components except where a task says "verbatim" (Crt, ThinkingStrip, Lobby, index.html).

## 3. Decisions + why (do not re-litigate)

- All v1–v5a decisions stand (append-only wire + client derivation; server = relay + gate).
- v5c decisions (each user-approved during brainstorm, 2026-07-25):
  - PR #2 merged FIRST; v5c branches off main — clean history over stacked PRs.
  - HUD = derivable-only (zero server risk); usage/XP events explicitly out of scope (v5b+).
  - Skill suite = union of party sessions' rosters (real data), NOT per-user declared packs — users don't report installed skills in this architecture; per-user inventories deferred (spec §8).
  - "Skill suite" naming (user-requested rename from "spellbook") — spec + UI label `SKILL SUITE`.
  - Approach A: incremental in-place port (css-first w/ TEMP compat section, components one at a time) — patch README's own de-risk order; no parallel-UI flag, no big-bang.
  - `?screen=skills|status` render inside the joined session (one socket path); AgentStatus is dash-honest design-only; SkillsPanel background-tasks section dropped (YAGNI).
  - Small calls: party pane + todo panel get <900px summary strips (closes carried v4 item 4); ★ 7th sprite (glyph hash shift accepted); suggest-chip preview 120→300 (closes item 10); no fake affordances (dropped PRESS W, fake XP bar, "no overlap", [R]/[X] brackets).

## 4. Ordered next steps (fresh session)

1. `git checkout feature/v5c-restyle` (verify HEAD `752e274`).
2. Invoke `superpowers:subagent-driven-development` with plan `docs/superpowers/plans/2026-07-25-v5c-restyle.md`; create `.superpowers/sdd/2026-07-25-v5c-restyle/progress.md` ledger; dispatch Task 1 (vendor patch) → Task 12 in order, per-task review, gates every task.
3. Task 12 ends with live Playwright acceptance (10-point checklist in the plan) + HANDOFF refresh + screenshot commit-or-drop user decision.
4. After clean final review: finishing-a-development-branch (v5a precedent: push + PR).
5. Then: v5b cycle when user wants it; carried user decisions in §7.

## 5. Files with line refs (v5c HEAD 752e274)

- Plan: `docs/superpowers/plans/2026-07-25-v5c-restyle.md` — Global Constraints block near top (gates, TEMP-rule discipline, live-demo gotchas); Tasks 1–12 with full code inline. Spec: `docs/superpowers/specs/2026-07-25-v5c-restyle-design.md:1-146`.
- Client (current, pre-port): `poc/client/src/App.tsx:117-162` (SessionView JSX the tasks edit); `components/Transcript.tsx:39-176` (renderEvent switch being restyled); `components/PromptBar.tsx:13-35` (slash/submit logic to preserve); `terminal.css:1-302` (replaced wholesale in Task 2); `identity.ts:1` (GLYPHS — Task 7 adds ★); `derive.ts:103-111` (TranscriptGroup, kind: "subagent"), `derive.ts:4-8` (Participant).
- Server (Task 10 only): `poc/server/src/project.ts:31-60` (ProjectMessage + projectSnapshot); `poc/server/test/project.test.ts:12-16` (addSession helper to extend).
- Patch source: zip at repo root; plan Task 1 vendors it to `docs/design/90s-terminal-patch/` (13 files; README.md = copy map + wiring notes).

## 6. Gotchas / constraints

- All v3–v5a gotchas stand: worktree containment; `Docs/`==`docs/`; no client auto-reconnect; `.superpowers/` git-excluded; subagent sandbox CANNOT launch the SDK binary (controller runs the stack); tsx watch hot-reload kills live turns (never edit poc/server mid-demo).
- **Fresh demo sessions need a worktree FIRST**: `cd poc/demo-project && git worktree add ../demo-worktrees/<session> -b <session>` — else SDK spawn fails with a MISLEADING "native binary failed to launch" banner. Stale stack from a dead session: kill by port, restart unsandboxed. Stack: server :3001 `AGENT_WORKDIR_ROOT=<repo>/poc/demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev` (from poc/server); vite :5173 (from poc/client). Existing worktrees: ana, ben, v5a-retest-3.
- Test counts move during v5c: server 89→90 (Task 10), client 18→21 (Task 11). Baselines in plan Global Constraints.
- TEMP css rules (Task 2) each name their deleting task — implementers must not delete early or leave them; Task 12 greps for stragglers.
- SkillsPanel/AgentStatus in the vendored REF are MOCKS — Task 11 builds real versions from code in the plan; don't copy the mocks.
- Live SDK facts (documented, not bugs): Skill tool "Unknown skill" under settingSources:[] (agent self-recovers); meta-tools (ToolSearch/TaskCreate/TaskUpdate/Agent) bypass canUseTool; a/d keys ignored while an input is focused. Speculative (unproven): task-id drift if SDK task numbering is session-global across subagents.
- Scratchpad extraction of the zip from the previous session is GONE (session-scoped) — the plan re-extracts from the repo-root zip in Task 1; after Task 1 use the vendored copy.

## 7. Open questions / USER DECISIONS (batched)

Carried v3: (1) worktree-containment Write/Edit approval; (2) Bash-allowlist two-hop residual risk; (3) skill discovery under settingSources:[] broken — accept self-recovery or investigate SDK.
Carried v4/v5a: (5) stale skill name in v4 spec text; (6) 4 polish items in frontend-design-skill-notes; (8) v5a deferred minors (DEFER list in git history of this file @ bf889d4); (9) meta-tools bypassing the gate — accept or raise upstream.
v5c items resolved by the spec: item 4 (party pane <900px → summary strips), item 10 (chip preview → 300).
New: (11) v5c acceptance screenshots — commit or drop (ask at Task 12). (12) `Multiplayer AI 90s Terminal UI.zip` at repo root — delete after Task 1 vendors it, or keep? (ask at merge).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git checkout feature/v5c-restyle
git log --oneline | head -3   # 752e274 docs(v5c): implementation plan …, d7e437e docs: v5c spec …, 1591089 merge PR #2
cd poc/server && npx tsc --noEmit && npx vitest run   # clean, 89 passed (pre-Task-10 baseline)
cd ../client && npm test && npm run build             # 18 passed, clean build (pre-Task-11 baseline)
```

Resume at §4 step 2: invoke superpowers:subagent-driven-development on the plan, Task 1 first. The brainstorm/spec/plan cycle is DONE — do not re-open design questions; the plan contains all code.
