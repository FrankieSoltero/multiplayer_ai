# Mistakes and Fixes

Running log of non-obvious problems hit in this project and how they were fixed.

| Date | Problem | Fix |
|---|---|---|
| 2026-07-24 | Live SDK tool_result content can be a string; driver's whole-loop try/catch made one bad message kill the session; allowedTools doesn't restrict the tool set | string\|array content handling, per-message error containment, explicit tool restriction |

## 2026-07-26 — Switching arcade roster dino->snake crashed renderGrid (TypeError reading s.food) in live acceptance; unit tests and build were green

- **Symptom:** Switching arcade roster dino->snake crashed renderGrid (TypeError reading s.food) in live acceptance; unit tests and build were green
- **Root cause:** Generic host reset game state in a [mounted, game] effect, but React renders BEFORE effects run, so the new engine rendered the old game's state shape; fix round 1 (setters during render) still crashed because the CURRENT render invocation continues to the JSX with the stale state
- **Fix:** React's adjust-state-during-render pattern completed with a local value: compute runState = engine.init(seed()) in the render pass that detects the game switch, setState(runState), and render score/over/render/hint from runState, not state (commits 94f45cf + b93aac3)
- **Lesson:** When an engine/state pair must switch together, effects are too late and render-phase setters are only half the fix — the current pass still executes, so every render-path consumer must read a local freshly-derived value. Also: pure-function tests and clean builds cannot catch cross-module state-shape mismatches behind any-casts; drive the real UI once before calling a host component done
- **Regression test:** Component test (if infra ever added): mount host, click SNAKE while dino state is live, assert no throw and 5 rendered rows

## 2026-07-26 — PARTY BEST tie-breaking silently depended on Map insertion order across sessions, contradicting the code's own 'ties keep the earlier holder' comment

- **Symptom:** PARTY BEST tie-breaking silently depended on Map insertion order across sessions, contradicting the code's own 'ties keep the earlier holder' comment
- **Root cause:** Aggregation iterated project.sessions.values() and compared scores only, never using the events' ts timestamps
- **Fix:** Track winning ts in the best map; replace on score > cur.score || (score === cur.score && ts < cur.ts); cross-session tie test with vi.setSystemTime (commit 0af2d90)
- **Lesson:** When aggregating across append-only logs, session/collection iteration order is not chronology — order by the events' own timestamps, and write the test so it fails under iteration-order luck
- **Regression test:** (none yet)

## 2026-07-26 — Untracked user files (market-research.md, tour-skill-suggest.png, poc/demo-plugins/ incl. a gitlink) silently vanished from git status — a fix-wave subagent had committed them into e73cf66 via a broad git add

- **Symptom:** Untracked user files (market-research.md, tour-skill-suggest.png, poc/demo-plugins/ incl. a gitlink) silently vanished from git status — a fix-wave subagent had committed them into e73cf66 via a broad git add
- **Root cause:** The fix-wave dispatch prompt named the files to change but not the exact 'git add <paths>' command; the subagent (haiku) staged everything. Task briefs that spelled out explicit add paths never had this problem
- **Fix:** git reset --soft to the pre-fix commit, git restore --staged the user files, recommitted only intended paths (branch was local-only so rewrite was safe); verified with git diff-tree and covering tests (44 passing)
- **Lesson:** Every subagent dispatch that ends in a commit must include the literal 'git add <explicit paths>' command — repos with untracked user files at the root make 'git add .' a data-leak into history. Also: after any subagent commit, check 'git status --short' still shows the expected untracked files before moving on
- **Regression test:** controller check after each subagent commit: git diff-tree --name-status on the new commit, diff against the dispatch's intended file list
