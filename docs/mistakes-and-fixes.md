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

## 2026-07-27 — A subagent edited the shared root .gitignore because `git check-ignore` reported no match for a directory that did not exist yet

- **Symptom:** Task 5 of the A1a plan asked only to VERIFY that `poc/server/dist/` was already ignored. `git check-ignore -v poc/server/dist` printed nothing, so the implementer concluded the root's bare `dist/` pattern "doesn't match nested paths" and added a redundant `**/dist/` line to the shared root `.gitignore` — a file the brief had explicitly placed off-limits, with an instruction to stop and report instead
- **Root cause:** A gitignore pattern with a trailing slash is directory-only, so git cannot match it against a path it cannot stat. The check was run BEFORE `npm run build`, when `poc/server/dist` did not exist. A bare `dist/` does match nested directories perfectly well once they exist — verified twice, in a scratch repo, by both the controller and the reviewer
- **Fix:** Reverted the `.gitignore` to byte-identical original, re-ran `git check-ignore -v poc/server/dist` AFTER building, and confirmed it matches on the pre-existing `.gitignore:2:dist/` (commit 59c86a8)
- **Lesson:** Order matters for `git check-ignore` — build first, then check, or a directory-only pattern reports a false negative. More generally: when a plan says "verify, and stop and report if it fails," a failing verification is data, not a bug to route around. The implementer's own diagnosis was never tested before it was acted on, and it was wrong. Plan steps that gate on a command should say what a negative result MEANS, not just what to run
- **Regression test:** (none — process lesson; the plan step now reads "confirm the build output is already ignored" and names the expected `.gitignore:2:dist/` output)

## 2026-07-27 — The A1a plan and spec both shipped a tsconfig.build.json that cannot produce a runnable build

- **Symptom:** The plan (Task 5 Step 1) and spec (§3.5) both described `tsconfig.build.json` as `noEmit:false` + `outDir` + `include` only. Building with exactly that fails under TypeScript 7.0.2 with TS5011, and when forced past it emits to `dist/src/main.js` instead of `dist/main.js` — which would have broken both `node dist/main.js` and the systemd unit's `ExecStart`
- **Root cause:** The config was authored from the shape of the existing `tsconfig.json` rather than by running `tsc -p` once. `rootDir` is inferred from the common source directory only in some configurations; with this project's layout it must be explicit
- **Fix:** The implementer added `rootDir: "src"` unprompted and justified it; the final review independently reproduced the failure both ways. Both the plan and the spec were corrected so anyone re-deriving the config gets the working version (commit b928d6f)
- **Lesson:** A plan that hands an agent a literal config file to transcribe is only as good as one execution of that file. Build-tool config in a plan should be run once before the plan is written, not reasoned about — the failure mode is silent (a build that "succeeds" into the wrong path) and lands far downstream, in a deploy artifact nobody has executed yet
- **Regression test:** Task 5's verification step runs `node dist/main.js` and asserts the fail-fast message, which only passes if the emit path is correct

## 2026-07-27 — `npx tsc --noEmit` passed on the client while `npm run build` failed with TS2304, so a green type-check was not a green build

- **Symptom:** After adding a `signedInAs` prop, `cd poc/client && npx tsc --noEmit && npx vitest run` reported clean tsc and 147 passing tests, but `npm run build` immediately after failed with two `TS2304: Cannot find name 'auth'` errors in `App.tsx`.
- **Root cause:** The bare `npx tsc --noEmit` invocation and the `build` script do not resolve the same tsconfig, so `--noEmit` was not type-checking `App.tsx` the way the build does. The code genuinely was wrong — `<Header>` is rendered inside `SessionView`, a *different component* from the one holding the `auth` state — but the check most likely to be run first said nothing about it.
- **Fix:** Threaded the login down explicitly as a `signedInAs: string | null` prop on `SessionView` rather than reaching for the in-scope `userId`, which with auth off is the anonymous per-tab UUID and must never be offered as something to sign out of.
- **Lesson:** On the client, `tsc --noEmit` is **not** a substitute for `npm run build` — treat the build as the authoritative type gate and always run it before claiming green. A component boundary is also easy to miss when a file holds several components: check which one actually encloses your JSX before assuming a variable is in scope.
- **Regression test:** None possible at the type level; the guard is procedural — the verification command list in HANDOFF §8 already ends the client line with `&& npm run build`, and that ordering is the point.
