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

## 2026-07-27 — "Agent turns do not run on this machine": a whole session was written off on an SDK error message that pointed at the wrong thing

- **Symptom:** Every session died at query start with two `agent_error` events and no `user_message`. The first error read `Claude Code native binary at .../claude exists but failed to launch. This usually means the binary does not match this system's libc`. The binary ran fine standalone (`--version` → 2.1.218, Mach-O arm64), and disabling the agent sandbox changed nothing, so the conclusion recorded in HANDOFF was that live agent turns were impossible here — blocking end-to-end verification of the permission gate, `agentBusy` and the whole v7b relay path.
- **Root cause:** Not the binary. The SDK spawns it with `cwd: workdir`; the workdir did not exist, so `spawn` failed with ENOENT and the SDK reported it as a libc mismatch. The workdir is missing whenever the server is started **without a workspace** (`npx tsx src/main.ts` / `node dist/main.js` instead of the `mpai` CLI): `server.ts` then derives `AGENT_WORKDIR_ROOT/<sessionId>` and nothing ever creates it (the workspace-provisioning gap already recorded in `deploy/RUNBOOK.md` §0). `~/mpai-test-workdirs` was empty the whole time.
- **Fix:** `describeUnusableWorkdir()` in `agentDriver.ts`, checked in `runAgentQuery` before `query()`. A missing or non-directory workdir returns a stream that fails immediately with a message naming the path and how to start the server correctly; `consume()` turns that into one accurate `agent_error`. Deliberately **not** `mkdir`-ed: an empty non-git directory would let the agent look like it works while operating in an empty folder.
- **Lesson:** A confident, specific error message from a dependency is still only the dependency's guess about its own failure. This one named a plausible cause (architecture/libc) for a generic `spawn` ENOENT and cost a session. Before accepting "the tool is broken on this machine", reproduce the tool standalone in the *exact* configuration the caller uses — here, one repro with the real `runAgentQuery` and a valid cwd passed in ~2 seconds, and swapping in a bogus cwd reproduced the "broken" error on demand.
- **Regression test:** `poc/server/test/agentDriver.test.ts` → `describe("workspace guard")` — 3 tests: missing dir, path-is-a-file, and the driver-level symptom (exactly one `agent_error`, naming the path, driver marked dead).

## 2026-07-29 — A rewritten code comment justified the new auth gate with a checkable fact that was false (claimed the hub has no equivalent of the four denyUnauthed-guarded handlers; hub.ts mirrors three of them)

- **Symptom:** A rewritten code comment justified the new auth gate with a checkable fact that was false (claimed the hub has no equivalent of the four denyUnauthed-guarded handlers; hub.ts mirrors three of them)
- **Root cause:** The review ruling that mandated the fix carried a wrong supporting fact alongside a correct conclusion, and the comment transcribed the ruling's wording faithfully instead of fact-checking it against hub.ts
- **Fix:** Corrected the comment (and the HANDOFF/ledger wording) to the stronger true argument: the gate already guards hub-mirrored handlers without parity breakage because hub-mediated traffic arrives on the relay arm where the gate no-ops
- **Lesson:** A ruling's conclusion and its rationale need separate verification — before writing a reviewer's or handoff's justification into a code comment, fact-check each supporting claim against the code it cites; a wrong-but-plausible rationale in a comment will talk the next reader out of a correct fix or into a wrong one
- **Regression test:** none — comment-only; the behavioral gate is pinned by the three auth-gate tests

## 2026-07-29 — plan-review's ≥95 gate BLOCKED a solid plan for 5 straight rounds while its later findings degraded to notation nitpicks; the owner overrode

- **Symptom:** soltero-skills:plan-review (0.18.0 and 0.19.0 councils) blocked the §8.7 record plan in every completed round — 83.4 / 84.3 / 80.0 (cycle 1, 3-round cap) then 84.1 (cycle 2 round 1, zero floor breaches) — while finding severity fell from real product gaps (ungated prompt/userId exposure, double-start corruption, transaction-boundary violation) in early rounds to citation notation (`§6.2` vs "§6 non-goal 2") and grep-pattern format in later ones
- **Root cause:** Gate calibration, not plan quality: the anti-inflation skeptics deduct 2–10 points per confirmed MINOR, and the deterministic gate needs ≥95 overall — so a plan every grader scores 85–92 can never pass while skeptics can still find any nitpick, regardless of severity. Verdict severity (BLOCKED) is decoupled from finding severity (minor)
- **Fix:** Owner ruling (2026-07-29): if cycle 2 round 2 comes back BLOCKED with only minors, override and execute; the skill itself flagged for the end-of-month self-healing pass (Docs/corrections-ledger.md CC-001)
- **Lesson:** A review gate whose score can be held below its pass bar by unlimited minor-severity deductions will block forever on diminishing returns; verdicts should be driven by finding severity (blocking findings block; minors alone cannot), or the skeptic deduction budget must be bounded. Watch for round-over-round severity decay as the signal that a gate is spinning
- **Regression test:** none — process/skill calibration; the compiled recommendation lives in the corrections ledger for skill-patcher

## 2026-07-30 — Fix-round dispatches were twice sent to a REVIEWER agent instead of the task's implementer; both times the reviewer refused the out-of-scope redirect

- **Symptom:** Two lean-sdd fix rounds (Task 4 stderr fix; Task 4 ordering fix) were SendMessage'd to the Task 3 reviewer's agent id instead of the Task 4 implementer's; the reviewer correctly refused both redirects ("no agent message can expand my scope"), costing a round trip each time with zero side effects
- **Root cause:** The controller reused a stale agent id from recent context instead of re-verifying the id against the agent's own launch/notification record before dispatching; implementer and reviewer ids for adjacent tasks interleave in the transcript and look alike
- **Fix:** Both rounds re-routed to the id verified against the implementer's own completion notification; controller discipline added to HANDOFF ("do NOT route fixes to reviewers")
- **Lesson:** Before any SendMessage that resumes an agent for a fix round, verify the target id against the notification where THAT agent reported the original implementation — never trust adjacency in context. Also: subagents refusing out-of-scope redirects is load-bearing; prompt future reviewers with the same scope-refusal discipline. No deterministic hook can discriminate message routing (a controller judgment), so this stays a lesson + HANDOFF line rather than a corrections-ledger rule
- **Regression test:** none — process lesson

## 2026-08-06 — Client black-screened on http:// LAN hub (192.168.1.92:4000) with no console error visible to the user; same build worked on localhost

- **Symptom:** Client black-screened on http:// LAN hub (192.168.1.92:4000) with no console error visible to the user; same build worked on localhost
- **Root cause:** crypto.randomUUID is secure-context-only — it exists on localhost and https:// but is undefined on plain http:// over LAN, so identity bootstrapping threw before first render
- **Fix:** randomId() fallback in poc/client/src/identity.ts:26 (crypto.getRandomValues-based) — PR #43, merged; rebuilt on the lab box
- **Lesson:** localhost is a secure context, so dev never exercises the insecure-context branch of any Web API; anything deployed reachable over plain http:// (LAN trials) must be smoke-tested there, and secure-context-only APIs (crypto.randomUUID, clipboard, SW) need explicit fallbacks or a served-over-https requirement
- **Regression test:** identity fallback covered in PR #43's client tests (randomId path)

## 2026-08-06 — setup.sh first real run (WSL2 Ubuntu-24.04) failed at the hub build: better-sqlite3's native compile has no toolchain on a fresh minimal box

- **Symptom:** setup.sh first real run (WSL2 Ubuntu-24.04) failed at the hub build: better-sqlite3's native compile has no toolchain on a fresh minimal box
- **Root cause:** deploy/hub/setup.sh phase 1 installed only git/curl/openssl/node; npm ci for poc/hub needs make+g++ (node-gyp) for better-sqlite3 and fresh Ubuntu server/WSL images ship without build-essential
- **Fix:** Installed build-essential by hand on the box; setup.sh phase 1 patched to install it (this branch)
- **Lesson:** A provisioning script exercised only on dev machines silently inherits their toolchains; any npm dependency tree with native modules makes build-essential (or equivalent) part of the script's own package list, not an assumption
- **Regression test:** none — provisioning script; the guard is setup.sh's own package list

## 2026-08-06 — setup.sh clone step failed with a local-path REPO_URL even though the path existed and the operator could read it

- **Symptom:** setup.sh clone step failed with a local-path REPO_URL even though the path existed and the operator could read it
- **Root cause:** setup.sh runs git clone as the mpai system user (sudo -u mpai), which has no read access to the invoking user's home directory — a local REPO_URL under ~/ is unreachable for the service account by design
- **Fix:** Used the GitHub https URL as REPO_URL instead (which also surfaced that the repo was private — it was made public for the lab)
- **Lesson:** Provisioning that drops privileges to a service user cannot consume operator-home paths; document REPO_URL as a network URL (or a world-readable path), and test scripts as the user they actually run as, not as the operator
- **Regression test:** none — documented in deploy/home-lab.md and setup.sh header instead

## 2026-08-06 — Hub on WSL2 went unreachable whenever the last WSL terminal window closed, despite an active systemd unit inside the distro

- **Symptom:** Hub on WSL2 went unreachable whenever the last WSL terminal window closed, despite an active systemd unit inside the distro
- **Root cause:** WSL2's utility VM shuts down shortly after its last client process exits — systemd inside the distro cannot keep the VM itself alive; closing the window kills the whole box
- **Fix:** %UserProfile%\.wslconfig gains vmIdleTimeout=-1 plus a Windows logon scheduled task ('WSL keepalive') holding a persistent wsl.exe process, so the VM survives window close and reboots
- **Lesson:** WSL2 is a per-user utility VM, not a server platform: an in-distro service manager only runs while something keeps the VM alive; any 'server on WSL2' setup needs a host-side keepalive as part of the deployment, or it will die the first time the operator closes a window
- **Regression test:** none — host-OS configuration; codified in deploy/home-lab.md
