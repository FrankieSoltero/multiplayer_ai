# Awareness — Collisions (PRD §8.8 first half) Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd. The Task Dependency Table is the
> scheduling and review-depth contract. Spec of record:
> `docs/specs/2026-07-30-awareness-collisions-design.md` (its §8a rulings 1–8 and §2 banked
> decisions 1–7 are LOCKED) — where this plan is silent or wrong and the spec is explicit,
> the spec governs (standing ruling).

**Goal:** two sessions in one repo learn — humans on screen, agents in their prompt and at the
permission gate — that they have changed the same files, before merge time.

**Architecture:** each laptop computes a repo-relative `touched` set per session worktree
(git-derived, turn boundaries + pre-gate) and ships it as a new optional `SessionFacts` field;
a pure isomorphic `collisionsFrom()` in the server package intersects sets per repoKey group;
the hub pushes a compact `contested` down-frame to affected laptops; client surfaces ride the
existing 1s project push. Worktree provisioning becomes project-scoped first (kills debt §2.1).

**Tech stack / test runner:** TypeScript ESM, vitest. `cd poc/server && npx vitest run` ·
`cd poc/hub && npx vitest run` · `cd poc/client && npx vitest run`. Typecheck: server/hub
`npx tsc --noEmit`; client **`npx tsc -b`**. **No Verify in this plan depends on an npm
lifecycle hook firing:** `npx vitest run` does not run `pretest`, so every hub and client Verify
below builds `poc/server` with an EXPLICIT command of its own — **every hub task's Verify builds
`poc/server` BEFORE any hub command runs** (`cd poc/server && … && npm run build` → `cd ../hub &&
…`), and every client task's Verify opens with
`cd poc/client && npm --prefix ../server run build && …`.

## Global Constraints

- Rebuild `poc/server` (`npm --prefix poc/server run build`) after changing anything it
  exports — hub and client typecheck/bundle against its built `dist/`. **Every implementing
  task (all 18: 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b) builds:**
  each server task's Verify runs `npm run build` **as the last step of its BUILD chain, before any
  read-only check** (greps, `test -f`, `test -s`), and **no read-only check may run a suite, a
  `tsc`, or a build**; **each hub task's
  Verify builds `poc/server` BEFORE any hub command runs** (the build is the last step of the
  Verify's server leg, which precedes `cd ../hub`), and each client task's Verify begins with
  `npm --prefix ../server run build`. (The BUILD-chain wording is exact on purpose: Tasks 2a, 2b,
  3, 6a, 8a, 8p and 9a all continue past the build with read-only checks, so "ends in
  `npm run build`" was literally false for seven of the eighteen — cycle-2 round-3 fix.) There is
  no build carve-out and no task whose artifact is published by a later task's build. Since no two implementing tasks may be in flight together
  (all 18 are one exclusion group), no build is ever concurrent with a consumer's read.
- TDD is the implementer's standing discipline (soltero-skills:lean-tdd): every new test shown
  RED on pre-task code (revert-and-rerun). Never predict suite totals.
- Never `git add -A`; stage explicit paths; verify each commit with
  `git diff-tree --no-commit-id --name-only -r HEAD`. The tree may carry user WIP — never
  stage anything outside the task's file list. (`grep` is aliased to ugrep in the dev shell —
  verify snippets use `command grep` where plain grep semantics matter.)
- **Thesis constraint (spec §6, final bullet; thesis PRD §1.1):** what crosses sessions is
  "paths, session ids, and driver names — never transcript content." This plan additionally
  carries two fields, each justified: `lifecycle` because spec §4's `CollisionInput` includes
  it (closed sessions still collide, banked 6); participant names because spec §6a's digest
  line resolves the driver *from participants* (`session X (driven by Y) …`). No other field
  may join a collision surface.
- **Advisory only (spec §2.2):** no code path may block, queue, or lock a write because of a
  collision; tier (b) downgrades an AUTO approval to a HUMAN question, nothing more.
- Exact values used across tasks:
  - `TOUCH_CAP = 500`; truncation sentinel literal `"…"` (single U+2026 char);
    `PATH_WIRE_CAP = 512` (per-path wire cap, chars). **Canonical home:** ALL THREE constants are
    DECLARED in `poc/server/src/collisions.ts` (Task 5 — the isomorphic module) and re-exported
    unchanged from `poc/server/src/touched.ts` (Task 1), so the isomorphic module never imports
    the node-only one and no consumer sees two copies of a literal. The same
    single-source-of-truth rule therefore governs `PATH_WIRE_CAP` as governs `TOUCH_CAP`: Task 3's
    facts validator and Task 6a's frame validator both import it
    (`import { PATH_WIRE_CAP, TOUCH_CAP } from "./collisions.js"` in `relayProtocol.ts`) and
    neither may re-state `512` as a bare literal. (`relayProtocol.ts` cannot import it from
    `touched.ts` — that module is node-only; `collisions.ts` is the isomorphic home precisely so
    both sides can import it.) **Peer session ids inside `collisions[].sessionIds` are validated
    with the SAME bound as the frame's own top-level `sessionId`: the existing `SLUG` regex
    `/^[a-z0-9-]{1,40}$/` exported from `poc/server/src/project.ts:11`, applied through the same
    `str(id, SLUG)` helper `relayProtocol.ts:202`/`:208` already use** (cycle-2 round-3 fix: peer
    ids are session ids of the same universe as the top-level one, and Task 8b interpolates them
    into the human-read reason line, so bounding them merely as "strings ≤ 128 chars" bounded the
    same value class two ways in one frame; SLUG also makes the 512-char gate-reason cap
    unreachable by construction). No new regex, no new length literal. The only plan-authored
    inbound bound left on that field is the **≤ 100 ids per entry** count, which stays an inline
    literal in `relayProtocol.ts` beside the existing `MAX_REPOS = 100`. The gate-reason cap
    (512 chars, Task 8a) is likewise an inline literal — a SEPARATE bound from `PATH_WIRE_CAP`
    that merely shares its number.
  - **Inbound peer strings are UNTRUSTED text (cycle-2 round-3 fix).** Everything a `contested`
    frame carries is written by the hub and ends up (a) inside the agent's `<teammates>` prompt
    block (Task 7b) and (b) inside a gate reason a human reads (Task 8b). Validators therefore
    bound the CHARACTERS, not only the lengths: **every `paths[]` entry and every
    `collisions[].path` must contain no control characters and no newline** (reject the frame
    otherwise, on the existing malformed-frame path) — same rule on Task 3's `facts.touched`
    validator, since that field feeds the same surfaces. Peer ids are covered by `SLUG` above.
    Tasks 7b and 8b treat these strings as untrusted text: they interpolate them verbatim and
    never re-parse, re-split or execute them.
  - **producer-side per-path rule (plan-authored; spec §3.1/§3.3 set the wire cap but no
    producer rule — resolved here so the two do not contradict):** `touchedFiles` DROPS any
    path longer than `PATH_WIRE_CAP` (512 chars) before the cap/sentinel step. A single pathological
    path therefore costs that path, never the session's whole facts frame (Task 3's validator
    rejects the entire frame on one over-long path). Truncating instead was rejected: a
    truncated path is a *different* path and would false-collide. Owner may override.
    **State the real cost, not just the frame-size benefit:** a dropped path is a **silent
    exemption from banked decision 1** (spec §2.1, "two sessions … have both diverged from their
    shared base on the same path"). If two sessions BOTH diverge on a path longer than 512 chars,
    that collision is permanently invisible to `collisionsFrom` — no badge, no chip, no party
    row, no digest line, and no auto-approve withdrawal at the gate, ever, with nothing logged.
    This is not merely a wire-size protection; it narrows the spec's collision definition for a
    (rare) class of paths. The alternatives are raising `PATH_WIRE_CAP` or truncating, both
    rejected above. Recorded in the residuals register so the owner's override decision is made
    against this cost, not against the frame-size framing alone.
    **The exemption is no longer SILENT (cycle-2 round-3 fix — this closes the plan's own stated
    objection mechanically).** Task 1 emits ONE stderr line per `touchedFiles` call that dropped
    anything, exactly: ``process.stderr.write(`[touched] dropped ${n} path(s) over ${PATH_WIRE_CAP}
    chars in ${workdir}\n`)`` — a count and the worktree, never the path itself (a >512-char path
    in a log line is the same wire-size problem one layer down). Asserted verbatim by Task 1's
    over-long-path row. A dropped collision is still invisible to `collisionsFrom`, but it is now
    attributable from the laptop's own stderr rather than undetectable.
    **Escalation filed, execution NOT gated:** because this narrows LOCKED banked decision 1
    (spec §2.1) on the plan's own authority, it is filed for the owner as a **proposed spec §8a
    ruling 9 — "over-long paths: drop (current), truncate, or raise `PATH_WIRE_CAP`"** (see
    `## Final-pass notes`). The plan executes on the drop-and-log behavior meanwhile: it is the
    only option that never emits a rejectable frame and never invents a false path, so a later
    ruling either confirms it or changes two behavior rows (Task 1's over-long-path row and Task
    3's producer-never-emits-a-rejectable-path row) and one constant.
  - facts field `touched: string[] | null`.
  - down-frame (spec §8a ruling 6, amends §6a):
    `{ type: "contested", sessionId: string, paths: string[], collisions: { path: string; sessionIds: string[] }[] }`
    — `paths` bound identically to `facts.touched`: length ≤ `TOUCH_CAP + 1`, each ≤
    `PATH_WIRE_CAP` and free of control characters/newlines; `collisions` length ≤ `TOUCH_CAP + 1`
    (one entry per retained path, plus the sentinel slot `paths` may carry — see the invariant in
    Task 6a), each entry's `path` ≤ `PATH_WIRE_CAP` and likewise control-character-free, each
    `sessionIds` a NON-EMPTY array of strings **each matching `SLUG`**, **at most 100 ids per
    entry** — the count is the one plan-authored bound here, same posture and same number as
    `relayProtocol.ts`'s existing `MAX_REPOS = 100` inbound-array cap. These are
    the validator's bounds, and Task 6a's validator rows assert each one.
  - header badge label `⚠ CONTESTED ▸ ${n}`; session-list repo-group chip label
    `⚠ ${n} contested`. In BOTH literals `n` is a **count**, never a path list — for the badge,
    the distinct contested paths involving this session; for the chip, the distinct contested
    paths in that repo group. Session-row marker label: the exact literal **`contested`** — **no
    count and NO `⚠` glyph** (the row is one session; asserted verbatim by Task 9b's marker row).
    **Cycle-2 round-3 fix — the earlier `⚠ contested` reading is WITHDRAWN.** Spec §5 gives two
    different literals for the two session-list surfaces: the group chip carries the glyph
    (`⚠ N contested`) but the per-session marker does not ("per-session rows involved get a
    `contested` marker beside the state badge"). The plan had pinned `⚠ contested` and asserted it
    verbatim, which put this plan's standing rule ("where this plan is silent or wrong and the
    spec is explicit, the spec governs") in conflict with a task row — exactly the executor trap
    the plan named and withdrew for the §6a `paths` bound. The spec literal wins; no new
    plan-authored decision is created, so the register below stays complete.
  - gate reason line `contested with session ${otherSessionId}`.
  - calm CSS class literal `contested-calm` (chip, session-row marker, header badge). Its
    declaration, added by Task 9b to `poc/client/src/terminal.css`, uses the EXISTING non-amber
    awareness tokens and introduces no new custom property:
    `.contested-calm { color: var(--gold); border-color: var(--gold); background: var(--gold-wash); }`
    — `--gold` (`terminal.css:35`, commented "system / awareness / quest", 10.21:1 on `--bg`)
    and `--gold-wash` (`terminal.css:42`). The amber tokens at `terminal.css:37-39`
    (`--amber`, `--amber-mute`, `--amber-wash`) stay reserved for permission gates and are
    referenced nowhere in this rule.
  - worktree path `<repoRoot>/.mpai/worktrees/<projectId>/<slug>`; worktree branch
    `mpai/<projectId>/<slug>`; **internal WorkspaceManager map key literal `${projectId}/${slug}`**.
  - collisions module identity literal `COLLISIONS_MODULE_ID = "collisionsFrom/v1"` (exported
    from `collisions.ts`, and used at runtime in its input-guard message so minification
    cannot erase it — this is the client bundle-check anchor, Task 9a).
  - kill switch (spec §8a ruling 4): env `MPAI_CONTESTED_GATE`; the exact value `"0"` disables
    tier (b) entirely (auto-approve behaves exactly as today); any other value or unset = ON
    (banked decision 5, on by default). Tier (a) digest/UI surfaces are unaffected by it.
  - gate reason carrier (Task 8a; the client renders it in Task 8c): the `permission_request`
    EVENT's `reason?: string` (`poc/server/src/events.ts`) is the source of truth — it is what
    `poc/client/src/components/Transcript.tsx` renders from — and
    `PendingGate.reason: string | null` (`poc/server/src/pendingGate.ts`) is DERIVED from it by
    `pendingGateOf`. Cap: 512 chars, an inline literal, a separate bound from `PATH_WIRE_CAP`.
  - once-per-(file, session) bookkeeping: `ProjectSessionEntry.contestedAsked: Set<string>`
    (repo-relative paths).
  - per-session recompute inputs: `ProjectSessionEntry.workdir: string | undefined`,
    `ProjectSessionEntry.baseRef: string | null`.
- `poc/server/src/collisions.ts` must be **isomorphic pure ESM** — no `node:` imports, no
  filesystem/process access — the client imports it at RUNTIME (unlike `record`'s type-only
  imports). Task 9a's Verify includes a bundle check.
- **Done criteria (plan-level):** every per-task Verify passed; on the final tree all three
  suites + typechecks green; Task 11a's and Task 11b's walk records in the execution ledger with
  steps 4, 6, 7 (11a) and the solo leg 8d/8e/8f (11b) recorded **PASS**, and step 5 (agent tier
  (a), 11a) recorded either PASS or FAIL — a FAIL is admissible only with the verbatim
  `digestFor` dump for that turn in the ledger (the `[digest-dump]` stderr line produced under
  `MPAI_DIGEST_DUMP=1`, Task 7b) AND a follow-up filed in `docs/tech-debt.md`. A bare "recorded"
  is not done.
  - **Scope of step 5's admissible FAIL (resolves the step-5 / step-8e tension explicitly).**
    Step 5 has two halves: (i) the `[digest-dump]` line for that turn CONTAINS `notes.txt`, and
    (ii) the agent's ANSWER names the file. Only half (ii) — the LLM-dependent half — may be
    recorded FAIL-with-evidence. Half (i) is REQUIRED at step 5 exactly as it is at step 8e: a
    dump line that does not contain the file is a defect in this plan's own code, not model
    variance, and it fails the plan-level Done criteria at both steps. Step 8e asserts half (i)
    only, which is why it is listed "(Required PASS.)" with no FAIL allowance.
  - **The two abort states this plan creates, and how each is EXITED (neither is a "done"
    state).** (i) **Ports still occupied at 11b step 8a** (the absence gate fails): the plan is
    **BLOCKED, not done**. Ledger BLOCKED, identify the occupant with
    `lsof -ti :<port> | xargs ps -p -o command=`, have the OPERATOR free the port (never the
    executor — process hygiene is binding), then re-run the solo leg from step 8a. Before
    stopping, run step 9's cleanup (identity-check and kill any PID this walk recorded, then
    remove the PID files and capture logs) — see 11b step 8a. (ii) **The `[digest-dump]` line is
    absent at step 5 or step 8e**: that is a **Task 7b defect in this plan's own code**, not model
    variance, so it can NEVER be closed by a FAIL record (half (i) above is required at both
    steps). Fix Task 7b, rebuild, and re-run the affected step.

## Task Dependency Table

| Task | Files touched | Depends on | Conflicts with (no concurrency) | Risk tier |
|------|---------------|------------|---------------------------------|-----------|
| 5. collisionsFrom module | `poc/server/src/collisions.ts`, `poc/server/test/collisions.test.ts`, `poc/server/package.json` | — | 1, 2a, 2b, 3, 4, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | standard |
| 1. touchedFiles module | `poc/server/src/touched.ts`, `poc/server/test/touched.test.ts` | 5 | 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | standard |
| 2a. project-scoped worktrees (debt §2.1; spec §7, §8a.3) | `poc/server/src/workspace.ts`, `poc/server/src/server.ts` (provision call sites), `poc/server/test/workspace.test.ts` | — | 1, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | judgment |
| 2b. session `workdir`/`baseRef` binding | `poc/server/src/project.ts`, `poc/server/src/server.ts` (session-creation paths), `poc/server/test/project.test.ts` | 2a | 1, 2a, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | judgment |
| 3. facts field `touched` | `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`, `poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` | 5 | 1, 2a, 2b, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | standard |
| 4. laptop recompute triggers | `poc/server/src/server.ts`, `poc/server/src/agentDriver.ts` (the `recomputeTouched` hook member + its two decision-site calls, `:294`, `:531`), `poc/server/src/permissions.ts` (the decision-site call in `buildCanUseTool`'s write-tool path, `:141`), `poc/server/test/serverTouched.test.ts` | 1, 2a, 2b, 3 | 1, 2a, 2b, 3, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | judgment |
| 6a. `contested` frame type + validator (protocol) | `poc/server/src/relayProtocol.ts`, `poc/server/test/relayProtocol.test.ts` | 3, 5 | 1, 2a, 2b, 3, 4, 5, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | standard |
| 7a. laptop contested storage + local derivation | `poc/server/src/contested.ts` (new), `poc/server/src/server.ts` (frame handler), `poc/server/src/project.ts` (`contestedFrame`), `poc/server/test/serverContested.test.ts`, `poc/server/test/project.test.ts` | 4, 5, 6a | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | judgment |
| 6b. hub producer — push hook + change detection | `poc/hub/src/hub.ts`, `poc/hub/test/contested.test.ts`, `poc/hub/test/hubRestart.test.ts` | 6a | 1, 2a, 2b, 3, 4, 5, 6a, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | judgment |
| 7b. digest tier (a) lines | `poc/server/src/digest.ts`, `poc/server/src/server.ts` (`digestFor` call site + `MPAI_DIGEST_DUMP`), `poc/server/test/digest.test.ts`, `poc/server/test/serverDigestContested.test.ts` | 7a | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b | judgment |
| 8a. gate reason carrier | `poc/server/src/pendingGate.ts`, `poc/server/src/events.ts`, `poc/server/src/relayProtocol.ts`, `poc/server/test/pendingGate.test.ts`, `poc/server/test/relayProtocol.test.ts` | — | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8p, 8b, 8c, 9a, 9b, 10a, 10b | standard |
| 8p. `contestedWrite` pure predicate | `poc/server/src/permissions.ts`, `poc/server/test/permissions.test.ts` | 7a | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8b, 8c, 9a, 9b, 10a, 10b | standard |
| 8b. auto-approve withdrawal at the three decision sites | `poc/server/src/agentDriver.ts` (sites :294, :531), `poc/server/src/permissions.ts` (site :141), `poc/server/src/server.ts` (hook supply + `MPAI_CONTESTED_GATE`), `poc/server/src/project.ts` (`contestedAsked`), `poc/server/test/serverGateContested.test.ts` | 4, 7a, 8a, 8p | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8c, 9a, 9b, 10a, 10b | judgment |
| 8c. client: the gate names why | `poc/client/src/types.ts`, `poc/client/src/components/Transcript.tsx`, `poc/client/src/components/Transcript.test.tsx` | 8a, 8b | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | standard |
| 9a. collisionView adapter | `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts`, `poc/client/src/types.ts` | 3, 5 | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9b, 10a, 10b | standard |
| 9b. client: session-list surfaces | `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/components/SessionPicker.test.tsx`, `poc/client/src/terminal.css` | 9a | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 10a, 10b | standard |
| 10a. client: header badge + App wiring | `poc/client/src/components/Header.tsx`, `poc/client/src/App.tsx`, `poc/client/src/components/Header.test.tsx` | 5, 9a, 9b | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10b | standard |
| 10b. client: party-pane share rows | `poc/client/src/components/PartyPane.tsx`, `poc/client/src/components/PartyPane.test.tsx` | 9a | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a | standard |
| 11a. browser walk — hub-attached leg (steps 0–7) | ledger record; `docs/tech-debt.md` ONLY on a step-5 FAIL (no source files) | 4, 6b, 7b, 8b, 8c, 9b, 10a, 10b | — | standard |
| 11b. browser walk — solo parity leg (steps 8a–8f, shutdown 9) | ledger record (no source files, no docs writes) | 11a | — | standard |
| 12. docs sweep | `docs/PRD.md`, `docs/tech-debt.md` | 1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a, 7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b, 11a, 11b | — | mechanical |

**Table rows are listed in the serial execution order below, not in label order** (cycle-2
round-2 fix: an executor reading top-to-bottom now reads a runnable order). The LABELS are
unchanged — every cross-reference in this plan, in the spec's §8a rulings and in the three
earlier residual reports still resolves.

The table alone is the scheduling contract: a task may start when its Depends-on tasks are
complete AND no Conflicts-with task is in flight (implementation OR verification — a
whole-package-suite run, a whole-package `tsc --noEmit`, or an `npm run build` counts).
Conflicts are **total and symmetric**: the 18 implementing rows (1, 2a, 2b, 3, 4, 5, 6a, 6b, 7a,
7b, 8a, 8p, 8b, 8c, 9a, 9b, 10a, 10b) form ONE exclusion group, so each row's Conflicts cell
lists the other 17 — no exceptions, no dependency-ordered omissions. Re-verified mechanically
again after the cycle-2 round-2 edits (which split Task 6 into 6a/6b and added the client Task
8c, taking the group from 16 to 18): **the table was regenerated from a single serial-order list
and then re-checked by script — every implementing row has exactly 17 entries, every entry
appears on both rows (symmetry holds in both directions), no self-reference, no unknown label**;
11a, 11b and 12 are serialized by their Depends-on cells and carry no conflicts.
**Re-verified mechanically AGAIN after the cycle-2 round-3 edits, and the check is stated so it
can be repeated:** round 3 changed only ORDER and Depends-on cells (7a moved ahead of 6b; Task 4
gained `2a`; Task 10a gained `9b`) plus Task 4's Files cell (`agentDriver.ts`, `permissions.ts`) —
**no row was added or removed and no Conflicts cell changed**, because all 18 implementing rows
were already one total exclusion group, so any Files-cell widening inside the group is already
covered. Re-checked row by row after the edit: still 18 implementing rows, each Conflicts cell
still lists exactly the other 17, every pair still appears on both rows, no self-reference, no
unknown label. This plan
therefore permits NO concurrent writers at all, and 11a/11b/12 depend on the whole group, so
tasks execute serially. lean-sdd's pipelining still applies in its read-only
form — a reviewer that only reads the diff and the tree (no suite run, no `tsc`, no build) may
run concurrently with the next task's implementer; a reviewer that executes any verify command
may not.

**Serial execution order (verbatim).** The task NUMBERING is still not a topological order (Task
1 and Task 3 both depend on Task 5), but the TABLE above and the task SECTIONS below are now both
laid out in this order, so reading either top-to-bottom is safe. Execute in exactly this
sequence, which satisfies every Depends-on cell above:

`5 → 1 → 2a → 2b → 3 → 4 → 6a → 7a → 6b → 7b → 8a → 8p → 8b → 8c → 9a → 9b → 10a → 10b → 11a → 11b → 12`

(Numbers were deliberately NOT reassigned: every cross-reference in this plan, in the spec's
§8a rulings and in the three earlier residual reports cites the existing labels.)

**Why 7a now runs BEFORE 6b (cycle-2 round-3 fix — consumer before producer).** 7a's Depends-on
cell is `4, 5, 6a`, every one of which already precedes 6b, so this order satisfies every
Depends-on cell in the table unchanged. It removes a real intermediate-commit gap: with 6b first,
the commit that ships the hub PRODUCER would land while the only laptop-side HANDLER for the frame
(7a's `poc/server/src/server.ts` frame-handler branch) does not exist yet, so a laptop built at
that commit would receive a frame that VALIDATES into the down-frame union and then falls through
with no handler — a state the plan never described. (Task 6a's `old laptop / unknown down-frame`
compat row scopes itself to a DIFFERENT case: a laptop built before the frame TYPE existed, which
ignores it on the unknown-frame path.) With 7a first, no commit in this plan ever ships a
validated-but-unhandled `contested` frame: at 6a's commit nothing constructs one (6a's `no sender
yet` row), at 7a's commit the handler exists and still nothing sends, and 6b's commit is the first
that sends — into a laptop that already handles it. The re-ordering re-validated mechanically
against every Depends-on cell (see the matrix note above).

**Rationale (server/hub group).** Tasks 1, 2a, 2b, 3, 4, 5, 6a, 7a, 7b, 8a, 8p and 8b all write
`poc/server/src` and verify with a whole-package `tsc --noEmit` / whole suite / `npm run build`
over `poc/server`; Task 6b writes only `poc/hub`, but its Verify explicitly builds `poc/server`
before the hub suite runs, which is itself an in-flight conflict under this table's own rule.
Shared files sharpen it further (`server.ts`: 2a/2b/4/7a/7b/8b; `relayProtocol.ts`: 3/6a/8a;
`project.ts`: 2b/3/7a/8b; `pendingGate.ts` + `events.ts`: 8a; `permissions.ts`: **4**, 8p **and
8b** (4 adds the decision-site `recomputeTouched` call in `buildCanUseTool`'s write-tool path,
8p adds the pure predicate, 8b adds its first caller at `permissions.ts:141` — all three
serialised by this group, never concurrent); `agentDriver.ts`: **4 and 8b** (4 adds the
`recomputeTouched` hook member and its two decision-site calls; 8b adds the contested hooks and
the withdrawal at the same two sites — same serialisation);
`poc/server/dist/`: every task, since every task builds). Tasks 1, 5 and 7a create new source
files but still typecheck and build the whole package, so they carry the full group's conflicts
too — no "new-file-only means conflict-free" exemption survives in this plan.

**Rationale (client group).** 9a is a pure new module and is upstream of all three collision
client writers (9b, 10a, 10b all depend on 9a). 8c is the fourth client writer and is upstream of
none of them — it depends on 8a/8b (the server-side reason carrier and its first writer), not on
9a. 9b, 10a, 10b and 8c write client files and each runs the whole client suite. Under the
total-group rule above they all conflict with each other and with 9a as well, so the dependency
edges are belt-and-braces rather than the only guard.
`terminal.css` is written by 9b ONLY (it declares `contested-calm`); 10a merely applies the
class name, which is why 10a's Files cell no longer lists the stylesheet.
`poc/client/src/types.ts` is written by 9a (the `touched` mirror) **and** 8c (the `reason`
mirrors) — again serialised by the total group, never concurrent.

**Rationale (cross-group — client tasks are `poc/server/dist/` WRITERS, not readers).** Client
tasks write no server or hub *source* file, but **every client verify in this plan explicitly
builds `../server` first**: each of 8c, 9a, 9b, 10a and 10b opens with
`cd poc/client && npm --prefix ../server run build && …` — an issued command, not a
`pretest` hook (`npx vitest run` never fires npm lifecycle scripts, so the hook the earlier
revision leaned on would not have run). Task 9a additionally runs the client `npm run build`
(`tsc -b && vite build`) against that freshly built `dist/`. `poc/server/dist/` is exactly the
shared artifact the server/hub group's own `npm run build` steps write, and this table's own
conflict rule already counts "an `npm run build`" as an in-flight conflict. So 8c, 9a, 9b, 10a
and 10b are WRITERS of `poc/server/dist/` and carry the full server/hub group in their Conflicts
cells, symmetrically. There is no client/server parallelism in this plan, and no "re-run the
client verify once and call it a read-only race" allowance — a client verify that fails against
a half-written `dist/` is a scheduling violation to be fixed by serialising, not retried.

---

## Task 5: collisionsFrom — pure shared module *(spec §4)*

**Files:** create `poc/server/src/collisions.ts`; test `poc/server/test/collisions.test.ts`;
modify `poc/server/package.json` (add `"./collisions"` export, same shape as `"./record"`).

**Interfaces — produces (verbatim; isomorphic pure ESM per Global Constraints):**

```ts
// The ONLY import in this file, and it is type-only (see the isomorphism check in Verify):
import type { SessionFacts } from "./relayProtocol.js";

export const COLLISIONS_MODULE_ID = "collisionsFrom/v1";
// PLAN-AUTHORED — verification anchor, no spec requirement. Spec §4 fixes this module's surface
// as CollisionInput / Collision / collisionsFrom; this constant (and the TypeError input guard
// whose message carries it) exists ONLY as Task 9a's minification-stable bundle-check anchor.
// The owner may drop both and rely on Task 9a's node smoke check alone. Listed with the other
// plan-authored decisions in the residuals section.
// Canonical declaration site for ALL THREE constants (Global Constraints). They live HERE, in
// the isomorphic module, and touched.ts (Task 1) re-exports them — the reverse would drag a
// node-only module into the client bundle through Task 5's own `sentinel inert` rule, and
// relayProtocol.ts (Tasks 3 and 6a) could not import PATH_WIRE_CAP from a node-only module at all.
export const TOUCH_CAP = 500;
export const TOUCH_SENTINEL = "…";      // single U+2026 char
export const PATH_WIRE_CAP = 512;       // per-path wire cap, chars — producer drop threshold
                                        // (Task 1) AND validator bound (Tasks 3, 6)
export interface CollisionInput {
  sessionId: string;
  repoKey: string | null;
  lifecycle: SessionFacts["lifecycle"];   // carried per spec §4's CollisionInput (closed sessions collide, banked 6)
  touched: string[] | null;
}
export interface Collision { repoKey: string; path: string; sessionIds: string[] }
export function collisionsFrom(sessions: CollisionInput[]): Collision[];
// Input guard: a non-array argument throws
// `new TypeError(\`${COLLISIONS_MODULE_ID}: sessions must be an array\`)`.
// The literal is runtime-reachable ON PURPOSE — it is Task 9a's minification-stable
// bundle-check anchor.
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| basic collision | two sessions, same repoKey, overlapping path | one Collision, sessionIds both, ascending |
| single-session path (discriminating, spec §4 `sessionIds.length ≥ 2`) | one session touches `src/a.ts`; its peer in the SAME repoKey touches only `src/b.ts` | NO Collision emitted for either path, and across every case in this table every emitted Collision has `sessionIds.length ≥ 2` — an implementation that emitted single-sessionId Collisions must fail this row |
| three-way | three sessions share a path | one Collision with 3 sessionIds |
| grouping | same path, DIFFERENT repoKeys | no collision (fork bound, spec §2.7) |
| null repoKey | sessions with repoKey null | excluded entirely |
| null/empty touched | touched null or [] | contribute nothing, never collide |
| closed sessions count | one session lifecycle "closed" | still collides (spec §2.6) |
| sentinel inert | `"…"` in both sessions' touched | never a collision path |
| input guard | `collisionsFrom(null as never)` | throws TypeError whose message starts with `collisionsFrom/v1:` |
| determinism + purity | same input twice, any order | deep-equal output sorted (repoKey, path, sessionIds asc); inputs not mutated |

**Verify:** `cd poc/server && npx vitest run test/collisions.test.ts && npx tsc --noEmit` →
green. Isomorphism check — **transitive, not direct-only** (a direct `node:` grep would pass
while a relative import dragged a node-only module in behind it):

- `command grep -n "from \"node:" poc/server/src/collisions.ts` → empty, AND
- `command grep -nE "^\s*import " poc/server/src/collisions.ts` → exactly one hit, and it is
  `import type { SessionFacts } from "./relayProtocol.js";`. Every hit must begin `import type `
  — type-only imports are erased at build, so nothing this module names can reach the client
  bundle. A value import of ANY module, relative or not, fails this check.

This is also why `TOUCH_CAP` / `TOUCH_SENTINEL` / `PATH_WIRE_CAP` are declared in this file rather
than imported from `touched.ts` (Task 1 re-exports them instead).

Then **`npm run build && test -f dist/collisions.js`** (same build command, same position as
every other server task in this plan — there is no carve-out; the trailing `test -f` is the
command that asserts the artifact rather than eyeballing it): the chain exits 0 and
`poc/server/dist/collisions.js` exists, published by THIS task rather than by an unpinned
successor. Tasks 1, 3 and 9a all consume it and every one of
them is in this task's exclusion group, so the publish is never concurrent with a read.
**Commit:** `feat(server): collisionsFrom — pure per-repo intersection of touched sets`

---

## Task 1: touchedFiles — git-derived changed-path set *(spec §3.1)*

**Files:** create `poc/server/src/touched.ts`; test `poc/server/test/touched.test.ts`.

**Interfaces — produces (verbatim):**

```ts
// TOUCH_CAP / TOUCH_SENTINEL / PATH_WIRE_CAP are DECLARED in collisions.ts (Task 5 — the
// isomorphic module) and re-exported here unchanged, so the isomorphic module never imports this
// node-only one and no consumer sees two copies of a literal. `PATH_WIRE_CAP` lives there rather
// than here because relayProtocol.ts (Tasks 3 and 6a) must import it too and cannot import a
// node-only module. This is why Task 1 depends on Task 5 in the dependency table.
export { TOUCH_CAP, TOUCH_SENTINEL, PATH_WIRE_CAP } from "./collisions.js";

export function touchedFiles(workdir: string, baseRef: string): string[];
// Synchronous; shells out to git in `workdir` via execFileSync with `{ timeout: 5000 }` —
// EXACTLY 5000 ms per git invocation, because Task 4 puts this call on the permission-gate
// path and a hung git in a large repo must never stall gate handling.
// THROWS on git failure, INCLUDING a timeout — the caller (Task 4) owns
// keep-previous-value semantics.
```

**Blast radius of the synchronous call (state it accurately, POC posture).** `execFileSync`
blocks the whole node event loop, not just the calling gate. For up to 5000 ms per invocation
(turn-end or pre-gate recompute) EVERYTHING on that laptop process is frozen: every other
session's websocket traffic, the 1s throttled project push, the uplink heartbeat, and every
other pending permission gate. The 5000 ms figure is therefore a **whole-server** freeze bound,
not a per-gate one. Accepted at this posture because a laptop process serves one developer's
handful of sessions and a healthy `git status`/`git diff` on a working repo returns in tens of
milliseconds — the timeout is the pathological ceiling, not the expected cost. **Ruled accepted
(spec §8a.8): "a worst-case whole-daemon freeze of 5s at a turn boundary/gate is ACCEPTED …
revisit only on an observed freeze."** The 5000 ms value is therefore binding on this task; no
executor decision, no alternative to weigh. (Lowering the timeout or moving to async `execFile`
would re-sequence Task 4's gate path and is out of scope unless a freeze is actually observed.)

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| committed divergence | worktree with commits after branching from baseRef; base has advanced too | paths from `git diff --name-only $(git merge-base baseRef HEAD)..HEAD` — base-side-only changes NOT included |
| uncommitted work | modified + untracked files, nothing committed | their repo-relative paths included (`git status --porcelain` parsing; both staged and unstaged) |
| union + dedupe + sort | a path both committed and re-modified | appears once; output sorted ascending |
| rename | `git mv a.ts b.ts` committed (or staged) | BOTH `a.ts` and `b.ts` present |
| repo-relative | file in a subdirectory | path exactly as git emits (posix separators, no leading `./`, relative to repo root) |
| over-long path (producer rule) | a changed path longer than `PATH_WIRE_CAP` (512) chars | DROPPED before the cap/sentinel step; every returned path is ≤ `PATH_WIRE_CAP`, so this session's facts frame can never be rejected wholesale by Task 3's validator (paired with Task 3's "producer never emits a rejectable path" row). Not truncated — a truncated path is a different path and would false-collide. **AND the drop is LOGGED, exactly once per call that dropped anything**, on stderr, that line verbatim: ``process.stderr.write(`[touched] dropped ${n} path(s) over ${PATH_WIRE_CAP} chars in ${workdir}\n`)`` — asserted verbatim by `touched.test.ts` (prefix `[touched] dropped `, the count, and the workdir). Two dropped paths in one call → ONE line with `n = 2`, never two lines. The path itself is never logged (a >512-char path in a log line is the same size problem one layer down) |
| no drop, no log (discriminating) | a call in which every changed path is ≤ `PATH_WIRE_CAP` | NOTHING is written to stderr by `touchedFiles` — an implementation that logs unconditionally must fail this row |
| cap + sentinel | > TOUCH_CAP distinct paths (after the over-long drop) | first TOUCH_CAP after sort, then final element exactly `TOUCH_SENTINEL`; length = TOUCH_CAP + 1 |
| clean worktree | no divergence, nothing uncommitted | `[]` |
| git failure | `workdir` is not a git repo / git exits non-zero | throws (Error carries git's stderr) |
| git timeout | a git invocation exceeds the 5000 ms `execFileSync` timeout | throws, on the same path as any other git failure — Task 4 then keeps the previous `entry.touched` and the gate proceeds |

**Exact values:** `TOUCH_CAP = 500`; `TOUCH_SENTINEL = "…"` (U+2026); `PATH_WIRE_CAP = 512` — all
three DECLARED in `collisions.ts` (Task 5) and re-exported here, never re-declared; git timeout
`5000` ms.
Status parsing must handle the porcelain rename format (`R  old -> new`, both sides
contribute).
**Why the drop is logged (Global Constraints, cycle-2 round-3).** The drop narrows LOCKED banked
decision 1 for paths > 512 chars; the plan's own stated objection to it was that the exemption is
*silent*. The one-line-per-call stderr emit above removes that objection mechanically while the
proposed spec §8a ruling 9 (drop / truncate / raise the cap) is with the owner — see
`## Final-pass notes`. Execution is not gated on that ruling.

**Verify:** `cd poc/server && npx vitest run test/touched.test.ts && npx tsc --noEmit &&
npm run build && test -f dist/touched.js` → tests green (they build real temp git repos; no
mocking of git), typecheck clean, and the whole chain exits 0 — the trailing `test -f` is the
command that asserts the artifact, so artifact presence is never an eyeball step. This task
exports new symbols, so the build is mandatory under Global Constraints, not optional.
**Commit:** `feat(server): touchedFiles — repo-relative divergence set for a session worktree`

---

## Task 2a: project-scoped worktrees — debt §2.1 root fix *(spec §7, §8a.3)*

**Files:** modify `poc/server/src/workspace.ts`, `poc/server/src/server.ts` (provision call
sites ONLY — the session-creation binding is Task 2b); test
`poc/server/test/workspace.test.ts` (extend).

**Risk / rollback — READ BEFORE THE FIRST NEW-SCHEME PROVISION:**

- **Blast radius.** This changes where worktrees live and what branches they sit on. In-memory,
  a session already holding its worktree path keeps working for the life of the process. Across
  a **restart**, however, the `WorkspaceManager` map is rebuilt under the project-scoped key
  only, so a session provisioned under the flat `<repoRoot>/.mpai/worktrees/<slug>` scheme is
  **orphaned**: its directory and `mpai/<slug>` branch persist, unreferenced by any new-scheme
  key, and the disk they occupy is never reclaimed by this code. Nothing is deleted, but nothing
  cleans up either. This is broader than §7's prose ("old sessions keep working until closed"),
  and the governing authority is **spec §8a ruling 7**, which rules on exactly this case:
  "pre-branch flat-scheme sessions do NOT survive a daemon restart under project-scoped
  provisioning — their worktrees/branches sit unreferenced on disk. Accepted POC breakage; PR
  discloses; no legacy compat path." So: no legacy-key compat read is to be written, nothing is
  migrated, and **the PR text for this task MUST disclose the orphaning** — that disclosure is
  mandatory per the ruling, not conditional on any further decision.
- **Rollback.** `git revert` of this commit restores the flat scheme but does NOT remove
  anything the new scheme created.
  **Blast radius of the UNDO itself — read before running it, it is the destructive step here.**
  `mpai/<projectId>/<slug>` is the branch holding that session's committed work, so
  `git branch -D` **force-deletes unmerged session commits** and they are recoverable only from
  the reflog; `git worktree remove` correctly REFUSES on a dirty worktree — do **not** add
  `--force` without first inspecting what is dirty. Safe order, per provisioned pair:
  1. `git -C <repoRoot> log --oneline <baseRef>..mpai/<projectId>/<slug>` — paste the output into
     the execution ledger. This is the record of what the undo is about to destroy.
  2. `git -C <repoRoot> status --porcelain` inside the worktree, then
     `git worktree remove <repoRoot>/.mpai/worktrees/<projectId>/<slug>` (unforced; if it refuses,
     ledger why and stop — a dirty worktree is uncommitted human or agent work).
  3. `git -C <repoRoot> branch -d mpai/<projectId>/<slug>` (**lowercase**, merged-only). Escalate
     to `-D` ONLY after step 1's ledger output shows the branch is merged or was intentionally
     discarded.
- **Pre-step (do this first, paste into the ledger).** Record the baseline so the delta is
  recoverable: `git worktree list` and `git branch --list 'mpai/*'` output captured in the
  execution ledger BEFORE the first new-scheme provision runs.

**Interfaces — produces:** `WorkspaceManager.provision(projectId: string, slug: string,
baseRef: string)` (projectId is a new FIRST parameter). Internal map key literal
`${projectId}/${slug}`; path and branch as in Global Constraints.

**`projectId` validation — named, homed and placed (cycle-2 round-3 fix; "SLUG-validated like
slug at point of use" left three things to guess).** The regex is the EXISTING
`SLUG = /^[a-z0-9-]{1,40}$/` exported from `poc/server/src/project.ts:11` — no new regex, no new
bound. The check runs **inside `provision`, as its first statement**, not at the `server.ts` call
sites: `provision` is the function that turns the value into a filesystem path and a git branch
name, so the guard belongs where the path is built (one guard, all call sites covered, and it
cannot be forgotten by a future caller). On a non-SLUG `projectId` it **THROWS**
`new Error(\`invalid projectId: ${projectId}\`)` — it does not sanitise, does not fall back to a
default, and does not return a worktree; a caller with a bad projectId is a bug, and a
path-traversing projectId (`../`, absolute, `..`) is exactly what `SLUG` rejects. `slug` keeps
whatever validation it has today, unchanged. Asserted by the behavior row below.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| path scheme | provision("acme", "auth", base) | worktree at `<repoRoot>/.mpai/worktrees/acme/auth`, branch `mpai/acme/auth`, map key `acme/auth` |
| cross-project isolation | `provision("acme", "auth", base)` then `provision("beta", "auth", base)` | two DISTINCT worktrees, two branches, two map keys; neither reuses the other (the debt §2.1 failure, now discriminated) |
| same-project idempotence | `provision("acme", "auth", base)` twice | second call reuses the first worktree (existing idempotent-reuse semantics, keyed on `acme/auth`) |
| branch-taken check ordering | branch `mpai/acme/auth` exists but worktree dir is gone | existing branch-taken behavior preserved, evaluated against the project-scoped branch name |
| old flat scheme untouched | a legacy `<root>/.mpai/worktrees/<slug>` dir exists | never reused, never deleted, never migrated by any new-scheme call |
| call sites | every `provision(` caller in server.ts | passes the session's projectId; no caller left on the old signature (compiler-enforced) |
| non-SLUG projectId (discriminating) | `provision("../escape", "auth", base)` / `provision("Acme", …)` (uppercase) / `provision("", …)` / a 41-char projectId | THROWS `invalid projectId: …` as `provision`'s first statement — no directory is created, no branch is created, no map entry is written. An implementation that validates at the call sites instead of inside `provision` must fail this row (the test calls `provision` directly) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE
server suite green (live provisioning path), typecheck clean, build exits 0. Then the mechanical
scheme check — **deterministic, not an eyeball read** (two executors must not be able to disagree
on PASS):
`command grep -cE "path\.join\(this\.worktreesRoot,\s*slug\)" poc/server/src/workspace.ts` →
**prints exactly `0`** (no single-segment join survives). That count IS the pass/fail check.
`command grep -n "path.join(this.worktreesRoot" poc/server/src/workspace.ts` is kept as a
**reviewer note only** — its listing is read during review, it decides nothing.
**Commit:** `fix(server): project-scoped worktree provisioning — closes debt §2.1`

---

## Task 2b: bind `workdir` / `baseRef` to the session entry *(spec §3.1 + §3.2)*

**Files:** modify `poc/server/src/project.ts` (the two new `ProjectSessionEntry` fields),
`poc/server/src/server.ts` (session-creation paths only); test
`poc/server/test/project.test.ts` (extend — shared with Task 3 and Task 7a, both of which
conflict with this task, so the three never run concurrently).

**Depends on Task 2a** — the binding stores exactly the baseRef handed to 2a's new
`provision(projectId, slug, baseRef)` signature, so it cannot be written first.

**Traceability.** This task serves spec **§3.1** (`touchedFiles(workdir, baseRef)` needs a
per-session workdir and baseRef) and **§3.2** (freshness — the recompute at turn boundaries and
pre-gate must read those inputs from somewhere). No §8a ruling covers it: ruling 1 is the SCOPE
split (§8.8 collisions this branch, hub-side oversight separately) and is cited correctly by
Task 12 only. **The binding mechanism itself — two new `ProjectSessionEntry` fields rather than
re-deriving from the workspace manager — is plan-authored infrastructure**, listed with the
other plan-authored decisions in the residuals section; the owner may prefer a lookup.

**Interfaces — produces:**

```ts
// poc/server/src/project.ts — on ProjectSessionEntry
workdir: string | undefined;   // the session's worktree path, or undefined (no repo)
baseRef: string | null;        // EXACTLY the baseRef string passed to provision(...), else null
```

Both are bound at **every** session-creation path (`getOrCreateSession` and the `create_session`
handler, `poc/server/src/server.ts:404-463`). The binding **never re-derives the base itself and
never substitutes a default of its own**: it stores byte-for-byte whatever string the call site
handed `provision`. That stored value today may legitimately BE the literal `"main"` — the
existing `getOrCreateSession` call site passes `only.workspace.provision(sessionId,
only.defaultBranch ?? "main")` (`poc/server/src/server.ts:419`, three-arg after Task 2a) — and
that is correct, because it is what git was actually branched from. What is forbidden is the
binding site computing a base of its own.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| baseRef bound | session created with a repo + baseRef `origin/main` | `entry.baseRef === "origin/main"` (character-identical to the string handed to `provision`) and `entry.workdir` is the provisioned worktree path |
| no repo | session created without a repo | `entry.workdir === undefined`, `entry.baseRef === null` |
| every creation path (discriminating) | a session made via `getOrCreateSession` AND one made via the `create_session` handler | both entries carry the same bound pair; neither path leaves `workdir`/`baseRef` unset while a worktree exists |
| never re-derived (discriminating) | repo whose default branch is `main`, session provisioned from `origin/dev` | `entry.baseRef === "origin/dev"` — the binding site calls no `defaultBranch()` of its own and introduces no fallback literal; the fields are assigned ONLY from the arguments handed to `provision` |
| pass-through of a default chosen upstream | `getOrCreateSession` on a repo whose `defaultBranch` is null, so the call site itself passes `"main"` | `entry.baseRef === "main"` — accepted and correct: the binding stored the call site's string byte-for-byte, it did not invent one |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE
server suite green, typecheck clean, build exits 0. Then the **deterministic** negative check —
this one decides PASS/FAIL:
`command grep -nE "entry\.baseRef\s*=.*(defaultBranch\(|\"main\")" poc/server/src/server.ts` →
**prints nothing (exit status 1)**: no assignment to `entry.baseRef` introduces a `"main"` literal
or a `defaultBranch()` call of its own.
`command grep -n "baseRef" poc/server/src/server.ts` is a **reviewer instruction, not a check** —
read the hits and confirm each session-creation site assigns `entry.baseRef` from the same
expression it passed `provision(...)`. The real assertion is the discriminating behavior row above
(`entry.baseRef === "origin/dev"`), which fails on any re-derivation regardless of how it is
spelled.
**Commit:** `feat(server): bind workdir and baseRef to the session entry`

---

## Task 3: `touched` on SessionFacts *(spec §3.3)*

**Files:** modify `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`; tests
`poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` (extend both;
`project.test.ts` is shared with Tasks 2b and 7a, both of which conflict with this task).

**Depends on Task 5** — the validator's bounds are `TOUCH_CAP + 1` and `PATH_WIRE_CAP`, and both
constants have a single canonical home: `relayProtocol.ts` imports them with
`import { PATH_WIRE_CAP, TOUCH_CAP } from "./collisions.js"` (Task 5 declares them). Task 3 must
not re-declare either literal, which is why it cannot be scheduled before Task 5.

**Interfaces — produces (all three sites, character-exact):**

```ts
// poc/server/src/relayProtocol.ts — on SessionFacts, beside `repoKey`
touched: string[] | null;

// poc/server/src/project.ts — on ProjectSessionEntry (storage, default null)
touched: string[] | null;

// poc/server/src/project.ts — on ProjectMessage.sessions[]'s INLINE row type (project.ts:136-165)
// This row type enumerates its fields explicitly and does NOT inherit from SessionFacts, even
// though `projectSnapshot` (project.ts:194) builds each row by spreading `sessionFactsOf(...)`.
// Adding the field to SessionFacts alone leaves the snapshot row type without it and the
// client's own `ProjectSessionInfo` (Task 9a) with nothing to mirror.
touched: string[] | null;
```

`sessionFactsOf` copies `entry.touched` into facts. Validation in the facts validator:
absent/null accepted (→ null); else array of strings, each length ≤ `PATH_WIRE_CAP`, **each
containing no control characters and no newline** (Global Constraints' untrusted-peer-strings
rule — these strings reach the agent's `<teammates>` block via Task 7b and a human-read gate
reason via Task 8b, so the validator bounds the CHARACTERS as well as the length), array length
≤ `TOUCH_CAP + 1` (both length bounds imported from `./collisions.js`, never re-declared here);
anything else rejects the frame exactly like other malformed facts fields.

**Downgrade note (journal records outlive a revert; referenced by Task 6b).** Once `touched`
ships, hub journal rows carry it inside `facts_json`. If Tasks 3/6 are later reverted, those
rows still contain the field. Expected behavior of the field-unaware code: **ignored, not
rejected** — hydration reads `facts: JSON.parse(row.facts_json) as SessionFacts`
(`poc/hub/src/hubDb.ts:269`), an unchecked cast with no field allowlist and no validator on the
hydration path, so an unknown key rides through in memory and is re-serialized unchanged. The
guaranteeing code path is that cast; the row below verifies it. **No journal backup is
taken or needed at this posture:** the walk runs the hub on a disposable
`HUB_DB=$(mktemp -d)/hub.db` (Task 11a step 1), and no production journal exists yet.

**Exposure note (spec §8a ruling 5 — ACCEPTED, do not re-litigate).** This field widens what
project participants can see: `facts.touched` is a session's FULL changed-path list (up to
`TOUCH_CAP + 1` paths), and it rides the existing project push to **all members of that
project** on every laptop, and is journaled hub-side under the journal's existing retention
policy. That is deliberately broader than Task 6a/6b's down-frame, which minimizes to the
intersecting paths only. The spec accepts it as the same exposure class as the record's
`filesChanged`, to be swept together with v7b2 auth. The bound that DOES hold is project
membership — asserted by the discriminating row below.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| default | fresh session entry | facts.touched = null |
| carried | entry.touched = ["a.ts","b.ts"] | sessionFactsOf output has exactly that array (copied, not aliased — mutation of the returned facts never mutates the entry) |
| validation accepts | facts frame with touched: [] / ["a.ts"] / absent / null | accepted; absent normalizes to null |
| validation rejects | touched: "x" / [1] / [a `PATH_WIRE_CAP + 1` = 513-char string] / TOUCH_CAP+2 entries | frame rejected with the existing malformed-facts error path |
| validation rejects control characters (discriminating, untrusted peer strings) | `touched: ["src/a.ts\ninjected: line"]` / a path containing `\r` / a path containing ` ` or any other C0 control char | frame rejected on the same malformed-facts path — a length-only validator passes all of these and lets a hostile or compromised peer land newline-separated text inside the agent's `<teammates>` prompt block (Task 7b) and inside a human-read gate reason (Task 8b), so an implementation that checks only `length ≤ PATH_WIRE_CAP` must fail this row |
| snapshot row carries it (discriminating) | a session with `entry.touched = ["a.ts"]` rendered through `projectSnapshot` | the emitted `ProjectMessage.sessions[0].touched` deep-equals `["a.ts"]` and TYPECHECKS against the inline row type — a change that adds the field to `SessionFacts` only must fail this row |
| producer never emits a rejectable path (paired with Task 1) | facts built by `sessionFactsOf` from a `touchedFiles` result computed in a repo that contains a path longer than `PATH_WIRE_CAP` chars | the over-long path was already DROPPED producer-side (Task 1's over-long-path row), so the frame VALIDATES and the session's other paths survive — one pathological path never costs a session its whole facts frame |
| project bound (exposure, discriminating) | two projects on one server, each with sessions carrying touched | a project push to project A's members contains touched for A's sessions ONLY — no session of project B appears in it at all |
| protocol stability | RELAY_PROTOCOL_VERSION | UNCHANGED (additive optional field, spec §3.3); a v2 peer without the field still validates |

**Verify:** `cd poc/server && npx vitest run test/relayProtocol.test.ts test/project.test.ts &&
npx tsc --noEmit` → the targeted files green; then `npx vitest run` → WHOLE server suite green
(`relayProtocol.ts` and `project.ts` are the two most widely consumed modules in this plan —
`tsc` catches type breaks, not behavioral regressions in every other suite that consumes
`sessionFactsOf`); then `npm run build` → exits 0. Plus the read-only downgrade check (this task
writes no hub file): `command grep -n "JSON.parse(row.facts_json)" poc/hub/src/hubDb.ts` →
exactly 1 hit and it is an unchecked `as SessionFacts` cast with no field allowlist — the code
path that guarantees the "ignored, not rejected" claim above. If that ever stops being true,
the downgrade note must be rewritten before this task ships.
**Commit:** `feat(server): touched — repo-relative changed paths on session facts`

---

## Task 4: laptop recompute triggers *(spec §3.2)*

**Files:** modify `poc/server/src/server.ts` (the `recomputeTouched` function, the `turn_end` hook,
and the hook supply at the driver construction site `server.ts:445`),
`poc/server/src/agentDriver.ts` (the `recomputeTouched?: () => void` hook member + its two
decision-site calls at `:294` and `:531`), `poc/server/src/permissions.ts` (the decision-site call
in `buildCanUseTool`'s write-tool path, `:141`); test `poc/server/test/serverTouched.test.ts`
(new; real sessions over a real socket, real temp git worktrees via Task 2a's provisioning).

**Interfaces — consumes:** `touchedFiles`/`TOUCH_CAP` (Task 1), `entry.touched` (Task 3),
`entry.workdir` + `entry.baseRef` (Task 2b — the recompute call site reads baseRef from the
persisted field and nowhere else), project-scoped provisioning (Task 2a).

**Interfaces — produces (verbatim; this task now EXPORTS a trigger, it is not behavior-only any
more):**

```ts
// poc/server/src/server.ts — a module-local function, NOT exported from the package.
// It is the single recompute entry point; nothing else may call `touchedFiles` directly.
function recomputeTouched(project: Project, sessionId: string): void;
// Reads entry.workdir / entry.baseRef, calls touchedFiles, assigns entry.touched.
// Never throws: a git failure (including the 5000 ms timeout) KEEPS the previous
// entry.touched and logs once per session (behavior rows below).

// poc/server/src/agentDriver.ts — DriverHooks gains, beside `getOversight`:
  /** Recompute this session's touched set NOW, synchronously, before a write-tool
   *  permission decision is made (spec §3.2 pre-gate freshness, Task 4).
   *  Absent on drivers constructed without collision wiring — then no recompute runs
   *  and the decision sites judge the last turn-boundary set. */
  recomputeTouched?: () => void;
```

`server.ts` supplies it at the driver construction site `server.ts:445` as
`() => recomputeTouched(project, sessionId)` — the same closure-over-project shape Task 8b's four
contested hooks use, and the same shape the existing `getOversight?: () => string`
(`agentDriver.ts:78-80`, supplied at `server.ts:455`) already uses. `AgentDriver` takes it as a
constructor param in the same position-after-`getOversight` style and puts it into the hooks object
literal it hands `run(this.prompts, { … })` (`agentDriver.ts:289`), so site 3 reads
`hooks.recomputeTouched?.()` off the SAME object sites 1 and 2 read `this.recomputeTouched?.()`
from.

**The hook sites, pinned (an executor must not have to choose an insertion point).**

- **Turn boundary — unchanged, still on the per-session event subscriber** registered at session
  creation, `poc/server/src/server.ts:464-465`:

  ```ts
  session.subscribe((event) => {
    if (INTERESTING.has(event.type)) schedulePush(project);   // server.ts:465
    …
  });
  ```

  On `event.type === "turn_end"`, call `recomputeTouched(project, sessionId)` **before**
  `schedulePush(project)` is called, so the very push this event triggers already carries the
  fresh `entry.touched` (a recompute after the schedule would ship the previous turn's set).

- **Pre-gate — MOVED OFF the `permission_request` subscriber and ONTO the decision sites
  themselves (cycle-2 round-3 fix; this is the blocking D6 contradiction closed).** The earlier
  revision hung the pre-gate recompute on `event.type === "permission_request"` in the subscriber
  above and claimed that made "Task 8b judges fresh data" true. It does not, and the two tasks
  contradicted each other: **site 3 (`permissions.ts:141`, `buildCanUseTool`) runs BEFORE any
  `permission_request` event exists** — `buildCanUseTool` decides, and only if it declines to
  auto-allow does control reach `hooks.onPermissionRequest`, which is what appends the event. A
  subscriber-based recompute therefore could never have run before site 3's read, so site 3 would
  silently have judged the previous turn's set while the plan asserted freshness at all three
  sites. **One ordering, stated once, and every task now agrees on it: the recompute runs at the
  decision site, synchronously, immediately before the contested set is read.** The three call
  sites, pinned:

  | # | Decision site | Where the call goes | Guard |
  |---|---------------|---------------------|-------|
  | 1 | `poc/server/src/agentDriver.ts:294` — `onPermissionRequest`, before the `if (this.permissionMode === "auto")` branch | `this.recomputeTouched?.()` as the FIRST statement of `onPermissionRequest` | only when `FILE_WRITE_TOOLS.has(toolName)` — a Read/Grep/Bash gate must not shell out to git |
  | 2 | `poc/server/src/agentDriver.ts:531` — `setPermissionMode`, before `this.allowAllPending(userId)` | `this.recomputeTouched?.()` immediately before the `allowAllPending` call | only when at least one already-pending request's `toolName` is in `FILE_WRITE_TOOLS`; otherwise no call. One recompute for the whole batch, never one per pending request |
  | 3 | `poc/server/src/permissions.ts:141` — `buildCanUseTool`, the write-tool path | `hooks.recomputeTouched?.()` immediately BEFORE the `if (FILE_WRITE_TOOLS.has(toolName) && isContainedWrite(...))` early-allow | inside the same `FILE_WRITE_TOOLS` condition — evaluate `FILE_WRITE_TOOLS.has(toolName)` first, recompute, then run the containment test and the allow |

  All three calls are **synchronous** (`recomputeTouched` wraps the synchronous `touchedFiles`),
  so the set Task 8b reads one statement later is the set this call just wrote — no async race
  with the auto-allow, and no reliance on `Session.append`'s subscriber ordering. (This is the
  same blocking call Task 1's blast-radius note governs — the 5000 ms whole-process ceiling is
  accepted per spec §8a.8; moving the call from the subscriber to the decision site does not
  change how often it runs or how long it can block, only WHEN, and the new placement is strictly
  closer to the read.)
  **A driver with no `recomputeTouched` hook** (existing test fakes, older call sites) runs no
  pre-gate recompute and judges the last turn-boundary set — the `?.` is the guard, nothing
  throws, and Task 8b's "driver without collision wiring" row is the matching case.

**Risk / rollback (same form as Task 2a's and Task 6b's).**

- **`MPAI_CONTESTED_GATE=0` is NOT an escape hatch for this task.** That switch (Task 8b) disables
  tier (b) withdrawal ONLY. It does not stop the turn-boundary or pre-gate recompute, so it does
  not relieve the 5000 ms whole-process freeze this task puts on the gate path. Do not reach for
  it on an observed freeze.
- **Disable path on an observed freeze** (the condition spec §8a.8 names as the only reason to
  revisit): `git revert` this task's commit → `npm --prefix poc/server run build` → restart the
  laptop process. After the revert, sessions keep whatever `entry.touched` they last computed
  (nothing clears it) and tiers (a)/(b) then act on stale-or-empty local state — advisory
  surfaces degrade, nothing blocks.
  **Blast radius of the RESTART itself — read before running it (Task 2a models this form; the
  env/revert rollback paths in this plan did not until cycle-2 round-3).** Restarting a laptop
  process is not free and is not transparent to its users: **every in-flight agent turn on that
  process is interrupted**, **every unanswered `permission_request` is lost with the process** (the
  gate promise never resolves; the human sees a gate that stops existing), and **all in-memory
  per-session state is cleared** — `entry.touched`, `entry.contestedFrame` (Task 7a),
  `entry.contestedAsked` (Task 8b), so once-per-file promises reset and every previously-answered
  contested file can be asked about again. Worktrees and committed work on disk are untouched.
  **Therefore: drain or park live sessions first** — tell the drivers, let in-flight turns finish,
  answer or abandon pending gates deliberately — and only then restart. Never restart a laptop
  process out from under a running turn to apply a rollback.
- **The revert is independent of Tasks 1, 3 and 5**: this task exports nothing from the package —
  it adds a module-local `recomputeTouched` in `server.ts`, one optional `DriverHooks` member, and
  three guarded call sites. Reverting it leaves `touchedFiles`, the `touched` facts field and
  `collisionsFrom` in place and compiling. It is NOT independent of Task 8b in the other
  direction: 8b's decision sites keep working after this revert, they simply judge whatever
  `entry.touched` the last `turn_end` recompute wrote — reverting Task 4 turns pre-gate freshness
  off, it does not turn the gate off.
- If the owner wants a RUNTIME switch for the recompute itself (e.g. `MPAI_TOUCHED_RECOMPUTE=0`)
  rather than a revert, that is a separate owner call — this plan does not add one, because spec
  §8a.8 accepted the cost rather than gating it.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| turn boundary | a `turn_end` event is appended to a session with a workdir and a non-null baseRef | `touchedFiles(entry.workdir, entry.baseRef)` recomputed; `entry.touched` updated; the existing project push carries the new facts (rides `INTERESTING`) |
| baseRef source (discriminating) | session provisioned with baseRef `origin/dev` while the repo's default branch is `main` | the git invocation uses `origin/dev` — the persisted `entry.baseRef`, never `defaultBranch()`, never a literal `"main"` |
| null baseRef | `entry.baseRef === null` (session with no repo, or never provisioned) | touched stays null; NO git invocation, no error, no log spam |
| no workdir | `entry.workdir === undefined` | touched stays null; no git invocation |
| pre-gate, site 1 (discriminating) | driver in `permissionMode === "auto"`; an Edit arrives at `agentDriver.ts:294` | `recomputeTouched` ran BEFORE the auto branch is evaluated — assert ordering, not just occurrence: the git invocation is observed before the `permission_request` append. A recompute hung off the event subscriber must fail this row (it would run after the append, and after the auto branch already resolved) |
| pre-gate, site 2 | a write request is already pending; `setPermissionMode("auto")` is called | exactly ONE recompute runs before `allowAllPending` iterates, regardless of how many write requests are pending |
| pre-gate, site 3 (discriminating) | driver in `default` mode; an Edit inside the workdir reaches `permissions.ts:141` | `recomputeTouched` ran BEFORE the `isContainedWrite` early-allow is evaluated. **This is the site the previous revision could not have covered** — `buildCanUseTool` runs before any `permission_request` event exists, so an implementation that recomputes on the event must fail this row |
| pre-gate, non-write tools (discriminating) | a Read / Grep / Bash permission decision at any of the three sites | NO recompute, no git invocation — the `FILE_WRITE_TOOLS` guard at each site is what this row asserts |
| pre-gate, no hook supplied | a driver constructed without `recomputeTouched` | no recompute, no throw; the sites judge the last turn-boundary set |
| git failure | touchedFiles throws | previous `entry.touched` value KEPT (stale beats absent); logged once per session, not per event, with this EXACT line on stderr: ``process.stderr.write(`[touched] session=${sessionId} recompute failed: ${err.message}\n`)`` — asserted verbatim by `serverTouched.test.ts` (prefix `[touched] session=` plus the session id), and a second failure for the same session id emits NOTHING |
| git hangs (bounded stall) | git exceeds `touchedFiles`' 5000 ms timeout (Task 1) during a PRE-GATE recompute | treated exactly as a git failure: previous `entry.touched` KEPT, the gate PROCEEDS (never blocked, never delayed past the timeout), logged once per session. **Accepted blast radius, stated plainly (Task 1's "Blast radius of the synchronous call"):** `execFileSync` blocks the whole laptop process for that interval — every session's socket traffic, the 1s project push and every other pending gate are frozen, not just this gate. 5000 ms is the whole-process ceiling. **Ruled accepted (spec §8a.8); revisit only on an observed freeze** — not an executor decision |
| no recompute storms | non-write tools, non-boundary events | no git invocation (discriminate: a `tool_call` Read appends → no recompute) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE
server suite green (this task edits the live server AND `agentDriver.ts` / `permissions.ts`, whose
existing suites `test/agentDriver.test.ts` and `test/permissions.test.ts` guard today's gate
behavior — a recompute call inserted at the wrong place shows up there), typecheck clean, build
exits 0 (build last in the BUILD chain, Global Constraints). Then the three read-only
decision-site checks — each prints a number, each expectation is a number:
`command grep -c "recomputeTouched" poc/server/src/agentDriver.ts` → **≥ 3** (the hook member
declaration plus the calls at sites 1 and 2) and
`command grep -c "recomputeTouched" poc/server/src/permissions.ts` → **≥ 1** (site 3) and
`command grep -c "permission_request" poc/server/src/server.ts` → the pre-task baseline,
**unchanged by this task** (ledger the pre-task count before editing and compare) — the subscriber
gained no `permission_request` branch, because the pre-gate recompute no longer lives there.
**Commit:** `feat(server): recompute a session's touched set at turn boundaries and write gates`

---

## Task 6a: `contested` frame type + inbound validator *(spec §6a as amended by §8a ruling 6)*

Protocol-only task, split from the hub producer exactly as Task 8a was split from Task 8b: this
task adds the frame TYPE and its inbound validator and NOTHING sends one until Task 6b. It writes
no hub file and changes no hub behavior — which is why it is `standard` risk while 6b is
`judgment`.

**Files:** modify `poc/server/src/relayProtocol.ts` (down-frame union + validator); test
`poc/server/test/relayProtocol.test.ts` (extend — frame shape + validation).

**Interfaces — produces:** down-frame (exact, spec §8a ruling 6)

```ts
{ type: "contested",
  sessionId: string,                                        // SLUG-validated (see below)
  paths: string[],                                          // ≤ TOUCH_CAP + 1, each ≤ PATH_WIRE_CAP
  collisions: { path: string; sessionIds: string[] }[] }    // the colliding peers, so the
                                                            // laptop can NAME them (spec §6)
```

**Invariant between `paths` and `collisions` (cycle-2 round-3 fix — the earlier wording
contradicted Task 6b's own over-cap row).** `paths` is the distinct path set of `collisions`,
sorted ascending, **plus a trailing `TOUCH_SENTINEL` element when the set was truncated** (Task
6b's `over-cap` row appends the sentinel to `paths` while truncating `collisions` to the RETAINED
paths, so in the over-cap case `paths` is exactly one element longer than the distinct path set of
`collisions` and its last element is the sentinel). Stated as one rule so a validator or a test
written from the invariant does not reject a legitimate over-cap frame:

- not truncated → `paths` deep-equals the sorted distinct `collisions[].path` set;
- truncated → `paths` = that sorted set, then `TOUCH_SENTINEL` as the final element, and
  `collisions` carries no entry whose `path` is `TOUCH_SENTINEL`.

`sessionIds`
excludes nothing — the recipient's own id IS present, matching `collisionsFrom`'s output shape.

**`sessionId` bound (stated like every other field's, not left implicit) — and the SAME bound on
every PEER id.** The frame's top-level
`sessionId` is validated with the existing `SLUG` regex exported from `poc/server/src/project.ts:11`
(`/^[a-z0-9-]{1,40}$/`), via the same `str(f.sessionId, SLUG)` helper `relayProtocol.ts:202` and
`:208` already use for the `publish` and `facts` frames — no new regex, no new bound, and the
40-char length ceiling comes from `SLUG` itself. A non-string, non-SLUG or over-long `sessionId`
rejects the whole frame on the existing malformed-frame path (asserted by the validator row below).
**Every id in `collisions[].sessionIds` gets the identical `str(id, SLUG)` treatment
(cycle-2 round-3 fix; the earlier `≤ 128 chars` bound is WITHDRAWN).** Peer ids are session ids of
the same universe as the top-level one, so bounding them two different ways in one frame was an
internal contradiction; and Task 8b interpolates a peer id straight into the human-read reason
`contested with session ${otherSessionId}`, so a 128-char-arbitrary-string bound admitted
newlines and control characters into that line. With `SLUG`, the 512-char gate-reason cap (Task
8a) is unreachable by construction — `contested with session ` + at most 40 SLUG chars.

**Character bound on paths (untrusted peer strings, Global Constraints).** Every `paths[]` entry
and every `collisions[].path` must contain no control characters and no newline, in addition to
`≤ PATH_WIRE_CAP`. Same rule, same reason, as Task 3's facts validator: these strings land in the
agent's `<teammates>` prompt block (Task 7b) and on a permission card a human reads (Task 8c).

**Note (the `TOUCH_CAP + 1` bound IS the spec's bound — no divergence, nothing to reconcile).**
Spec §6a says the frame's paths are "capped at TOUCH_CAP". That phrase is the spec's own idiom
for a capped-plus-sentinel list, fixed by §3.1: "capped at `TOUCH_CAP = 500` (over-cap sets are
truncated after sort and flagged with a final literal entry `"…"`)" — and §3.3 renders that same
cap explicitly as "length ≤ TOUCH_CAP + 1". §6a uses the identical phrase for the identical
list, so `paths` ≤ `TOUCH_CAP + 1` (500 real paths + the sentinel slot) is the spec's bound read
consistently with §3.1/§3.3, not a plan-authored amendment. One validator shape therefore serves
both frames, and no additional ruling is required (§8a ruling 7 exists and is about a different
subject — old-scheme worktree orphaning). The earlier revision's "harmonization" caveat — and
its executor trap, where the standing "spec governs" rule pointed at a bound the plan's own
frames would violate — is **withdrawn**. (Reading recorded in the residuals section; if the
owner reads §6a as a flat 500 INCLUDING the sentinel, say so and this task drops to
`TOUCH_CAP − 1` paths + sentinel.)

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| validation accepts | a well-formed `contested` frame (SLUG `sessionId`, `paths: []`, `collisions: []`) and a populated one | accepted, parsed to the shape above, never partially applied |
| validation accepts a TRUNCATED frame (the invariant's carve-out, discriminating) | a frame whose `paths` is `[…N retained paths sorted…, TOUCH_SENTINEL]` and whose `collisions` has exactly those N retained paths and no sentinel entry — i.e. Task 6b's `over-cap` output | ACCEPTED. A validator or test written from "`paths` is exactly the distinct path set of `collisions`" would reject this legitimate frame; the invariant above carries the carve-out explicitly so it cannot |
| validation rejects — `sessionId` (discriminating) | inbound frame whose `sessionId` is `7` / `""` / `"Alpha"` (uppercase, non-SLUG) / a 41-char string | each rejected on the existing malformed-frame error path — the same `str(f.sessionId, SLUG)` treatment `relayProtocol.ts:202/208` already give `publish`/`facts` |
| validation rejects — `paths` | inbound `contested` frame with `paths: "x"` / a `PATH_WIRE_CAP + 1` = 513-char path / TOUCH_CAP+2 entries | frame rejected with the existing malformed-frame error path — never partially applied |
| validation rejects — `collisions` (explicit bounds) | inbound frame with `collisions: "x"` / TOUCH_CAP+2 collision entries / an entry missing `sessionIds` / `sessionIds: [1]` / `sessionIds: []` (empty) / 101 ids in one entry / an entry whose `path` is 513 chars | each rejected with the same malformed-frame error path. Bounds are the Global-Constraints ones: `collisions` length ≤ `TOUCH_CAP + 1`, `path` ≤ `PATH_WIRE_CAP` (imported, never re-stated as `512`), `sessionIds` non-empty, ≤ 100 ids per entry (the count is the one inline literal, beside the existing `MAX_REPOS = 100`, per Global Constraints) |
| validation rejects — peer ids bounded by `SLUG` (discriminating) | inbound frame with `collisions: [{ path: "a.ts", sessionIds: ["Alpha"] }]` (uppercase) / `["a 41-character-long-session-id-aaaaaaaaaa"]` / `[""]` / `["ok", "bad id with spaces"]` / `["ok\ninjected"]` | each rejected on the existing malformed-frame path via the SAME `str(id, SLUG)` helper the top-level `sessionId` uses. An implementation that bounds peer ids only by length (the withdrawn `≤ 128 chars` rule) passes every one of these and must fail this row — and would let a hostile hub put arbitrary text, newlines included, into Task 8b's `contested with session ${otherSessionId}` line |
| validation rejects control characters in paths (discriminating) | `paths: ["src/a.ts\ninjected: line"]` / a `collisions[].path` containing `\r` or a C0 control char | rejected on the same malformed-frame path — an implementation that checks only `length ≤ PATH_WIRE_CAP` must fail this row. Same rule and same reason as Task 3's facts-validator row: these strings reach the agent's prompt block and a human-read permission card |
| old laptop / unknown down-frame (compat) | a laptop built before this task receives a `type: "contested"` frame | the frame is IGNORED by the unknown-frame path; the uplink is NOT disconnected and no error surfaces. `RELAY_PROTOCOL_VERSION` stays **UNCHANGED** — a PLAN-AUTHORED reading (spec §3.3 grants the no-bump exemption to an additive optional FIELD; applying it to a whole new frame type is this plan's extension, registered with the other plan-authored decisions and justified by exactly this row's unknown-frame ignore path). Bumping the version instead would be an owner override |
| no sender yet (discriminating) | the whole server and hub suites on this commit | nothing anywhere CONSTRUCTS a `contested` frame — this task ships the type and validator only; Task 6b supplies the first sender. `command grep -rn "\"contested\"" poc/hub/src` → prints nothing |
| thesis bound | frame contents | ONLY sessionId, paths and colliding session ids — no transcript data, no prompts, no names |

**Verify:** `cd poc/server && npx vitest run test/relayProtocol.test.ts && npx tsc --noEmit` →
targeted file green, typecheck clean; then `npx vitest run` → **WHOLE server suite green**
(`relayProtocol.ts` is one of the two most widely consumed modules in this plan — `tsc` catches
type breaks, not behavioral regressions in every other suite that consumes the validator; this is
the same argument Task 3 and Task 8a make for the same file); then `npm run build` → exits 0.
Plus the no-sender check: `command grep -rn "\"contested\"" poc/hub/src` → prints nothing
(exit status 1) on this commit.
**Commit:** `feat(server): contested down-frame type and inbound validator`

---

## Task 7a: laptop contested storage + local derivation *(spec §6a)*

**Files:** create `poc/server/src/contested.ts` (the two accessors); modify
`poc/server/src/server.ts` (inbound `contested` frame handler only),
`poc/server/src/project.ts` (the `contestedFrame` field on `ProjectSessionEntry`); tests
`poc/server/test/serverContested.test.ts` (new), `poc/server/test/project.test.ts` (extend —
shared with Tasks 2b and 3, both of which conflict with this task).

**Interfaces — consumes:** the `contested` frame (Task 6a's type + validator; produced by Task 6b), `collisionsFrom` (Task 5), the
laptop's own project session map. Produces (exported for Task 7b and Task 8b — the two function
names are the contract, character-exact):

```ts
// poc/server/src/contested.ts — a LEAF module: it value-imports only `./collisions.js`
// and takes `Project` as a TYPE-ONLY import from `./project.js`. It must NOT be homed in
// server.ts: server.ts already imports digest.ts and permissions.ts, so an accessor living
// there would force those consumers into an import cycle back into the server module.
export function contestedFor(project: Project, sessionId: string): ReadonlySet<string>;
// UNION of (a) the last hub `contested` frame's paths for this session
// (entry.contestedFrame) and (b) local derivation: collisionsFrom over `project`'s sessions.
export function contestedSessionsFor(project: Project, sessionId: string, path: string): string[];
// The OTHER session ids colliding with `sessionId` on `path`, ascending, deduped
// across both sources; [] when the path is not contested.
```

**Import specifier for consumers (exact):** `import { contestedFor, contestedSessionsFor } from
"./contested.js";` — used by `server.ts`'s `digestFor` (Task 7b) and by `server.ts`'s gate path
(Task 8b). The `project` first parameter exists because these accessors have no ambient state:
the laptop's session map lives on `Project`, and passing it keeps the module pure and testable
in isolation (the same shape as the existing `digestFor(project, sessionId)` at
`poc/server/src/server.ts:510`).

Per-session storage — named and homed like every other per-session field in this plan
(`ProjectSessionEntry.contestedAsked`, `.workdir`, `.baseRef`):

```ts
// poc/server/src/project.ts — on ProjectSessionEntry
contestedFrame: { paths: string[]; collisions: { path: string; sessionIds: string[] }[] } | null;
// the last hub `contested` frame verbatim; null until one arrives
```

Local
derivation is computed on read from live session state — never persisted, so it cannot go
stale. `TOUCH_SENTINEL` is never a member of either accessor's output.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| frame stored | `contested` frame arrives for a session | stored verbatim; `contestedFor` reflects its paths; `contestedSessionsFor` returns its peer ids |
| frame clears | frame with `paths: [], collisions: []` | stored frame emptied; `contestedFor` loses the hub-sourced paths (locally-derived ones survive) |
| hub-only | hub frame names `src/a.ts` with peer `s9`; no local session shares anything | `contestedFor` = {`src/a.ts`}; `contestedSessionsFor(…, "src/a.ts")` = `["s9"]` |
| local-only (solo + same-machine) | two LOCAL sessions in one repoKey overlap on `src/b.ts`; NO hub frame ever arrives | `contestedFor` = {`src/b.ts`} computed via `collisionsFrom` over the laptop's own project sessions; `contestedSessionsFor` names the local peer session id |
| union | hub frame has `src/a.ts` (peer `s9`) and local derivation has `src/b.ts` (peer `s2`) | `contestedFor` = {`src/a.ts`,`src/b.ts`}; each path's peers come from its own source |
| union dedupe | the SAME path collides in both sources with an overlapping peer id | path appears once; `contestedSessionsFor` returns each peer id once, ascending |
| sentinel in hub frame (discriminating) | a stored `contested` frame whose `paths` ends in `TOUCH_SENTINEL` (Task 6b's `over-cap` row produces exactly this, and this task stores the frame verbatim) | `contestedFor` OMITS it — the sentinel is never a member of the returned set — and `contestedSessionsFor(…, TOUCH_SENTINEL)` returns `[]`. The filtering rule stated above is the ONLY thing keeping the sentinel out of a digest line (Task 7b) and out of a gate reason (Task 8b), so it is asserted here rather than left as prose; Task 5 carries the equivalent `sentinel inert` row on the derivation side |
| unknown session (accessor side) | `contestedFor(project, "nope")` | empty set; never throws |
| frame for unknown session (inbound side, discriminating) | a validated `contested` frame arrives whose `sessionId` is not in this laptop's project map — e.g. it raced a session removal, or names a session owned by another uplink | frame **DROPPED**: no `ProjectSessionEntry` is created, nothing is stored anywhere, no throw, no uplink disconnect, and at most one log line per session id — that line EXACTLY: ``process.stderr.write(`[contested] session=${sessionId} unknown session, frame dropped\n`)``, asserted verbatim, with a second frame for the same unknown id emitting NOTHING. A later `contested` frame for a session that DOES exist is still applied normally |
| thesis bound | accessor outputs | paths and session ids only — no prompts, no transcript, no file contents |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE
server suite green, typecheck clean, build exits 0.
**Commit:** `feat(server): laptop contested storage — hub frame ∪ local derivation`

---

## Task 6b: hub producer — push hook + change detection *(spec §6a as amended by §8a ruling 6)*

**Files:** modify `poc/hub/src/hub.ts`; tests `poc/hub/test/contested.test.ts` (new, on the
uplink harness), `poc/hub/test/hubRestart.test.ts` (extend — the §8.7 restart harness, spec §9
Testing).

**Depends on Task 6a** — the frame type and its bounds are 6a's; this task only produces frames
of that shape and may not restate a bound.

**Runs AFTER Task 7a in the serial order, deliberately (cycle-2 round-3).** 7a is the laptop-side
HANDLER for this frame; scheduling the producer first would have put one commit in the history at
which a `contested` frame validates into the down-frame union and then falls through with no
handler — a state the plan never described (Task 6a's `old laptop / unknown down-frame` compat row
covers a different case: a laptop built before the TYPE existed, which ignores the frame on the
unknown-frame path). With 7a first, **this commit is the first one in the plan that sends a
`contested` frame, and it sends into a laptop that already handles it.** 7a's Depends-on cell
(`4, 5, 6a`) is fully satisfied before this task either way, so the re-ordering costs nothing.

**Hub behavior — exact site and store.** The hook is `pushProject(projectId)` in
`poc/hub/src/hub.ts:142` (the function `schedulePush`, `hub.ts:167`, throttles at 1s
leading+trailing). At the END of each `pushProject` body, after the project snapshot is built:
compute `collisionsFrom` over the snapshot's sessions, then for every session in the snapshot
whose contested state CHANGED since the last frame sent to its owning uplink, send one frame
(empty `paths: []` **and** `collisions: []` when a session's last collision clears). Consumes
`collisionsFrom` (Task 5), `facts.touched` (Task 3, already stored/journaled by the hub for
free), and the frame type/validator (Task 6a).

**Routing — named exactly, like every other site in this plan (cycle-2 round-3 fix; "its owning
uplink" named no mechanism).** The owning uplink of a session is
`store.ownerOf(projectId, sessionId)` (the accessor used at `poc/hub/src/hub.ts:394`,
`:444`, `:579`, `:685`, `:782`), and the socket to write to is `uplinks.get(owner)` — the exact
pattern already at `poc/hub/src/hub.ts:444-445`:

```ts
const owner = store.ownerOf(projectId, sessionId);
const uplink = owner ? uplinks.get(owner) : undefined;
// no owner, or no live socket → skip this session entirely (the `offline uplink` row)
```

**Disconnect / re-registration hooks — both pinned.** The `lastContestedSent` purge rule below
hangs off exactly two existing sites, and the enumeration it uses is stated so an executor does
not invent one:

| Hook | Site (file:line, today) | What to do |
|------|-------------------------|------------|
| uplink DISCONNECT | the socket `close` handler, `poc/hub/src/hub.ts:410-418`, **beside `store.detach(uplinkId)` and before `schedulePush(projectId)`** | delete the `lastContestedSent` entry of every session this uplink owned |
| uplink RE-REGISTRATION | the hello/supersede path, `poc/hub/src/hub.ts:284-292`, immediately after `uplinks.set(frame.uplinkId, socket)` / `store.attach(...)` | same deletion, for the re-registering `frame.uplinkId` |

**Enumeration (exact):** iterate the project snapshot's sessions for that `projectId` and delete
each `lastContestedSent` key whose `store.ownerOf(projectId, sessionId)` equals the departing /
re-registering `uplinkId`. (At the disconnect site this must run **before** `store.detach(uplinkId)`
clears the ownership the enumeration depends on — stated because the order is load-bearing and
the `uplink reconnect / laptop restart` row below is what catches getting it wrong.)

Change detection is a new module-level store in `createHub`'s closure, declared beside
`const uplinks = new Map<string, WebSocket>()` (`poc/hub/src/hub.ts:131`) — exact shape:

```ts
// poc/hub/src/hub.ts — beside `uplinks`, keyed by sessionId
const lastContestedSent = new Map<
  string,                                                        // sessionId
  { paths: string[]; collisions: { path: string; sessionIds: string[] }[] }
>();
```

A session's entry is written immediately after its frame is handed to the socket, compared by
value (paths AND collisions) on the next push, and DELETED when the session leaves the project
snapshot. It is in-memory only — never journaled — which is exactly why the restart row below
tolerates one duplicate frame after a hub restart.

**Laptop restart / uplink reconnect (the symmetric case — an explicit rule, not a gap).** The
hub's change detection is per-session state the LAPTOP cannot see. When a laptop process restarts
or its uplink reconnects, the laptop loses `entry.contestedFrame` (Task 7a, in-memory) while the
hub still holds a matching `lastContestedSent` entry, so change detection would suppress the
resend and hub-sourced contested state would stay silently empty until the collision set happened
to change. **Rule: on uplink disconnect AND on uplink re-registration, the hub DELETES the
`lastContestedSent` entry of every session owned by that uplink**, so the next `pushProject`
re-sends that session's current frame unconditionally. One redundant frame after a reconnect is
acceptable (same posture as the hub-restart duplicate); a silently missing one is not. Asserted
by the reconnect row below.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| frame on collision | two uplinks' sessions in one repoKey publish overlapping touched | each owning uplink receives `contested` for ITS sessionId, `paths` listing the shared paths and `collisions` naming the peer session ids |
| change-only | same collision state across two pushes | no duplicate frame on the second push (state compared on paths AND collisions) |
| clear | one session's touched update removes the overlap | affected uplinks receive `paths: []`, `collisions: []` exactly once |
| over-cap | a session's contested path set exceeds TOUCH_CAP | truncated after sort to TOUCH_CAP entries plus a final `TOUCH_SENTINEL` element (length = TOUCH_CAP + 1, same semantics as Task 1/Task 3); `collisions` truncated to the retained paths |
| offline uplink | collision involves a session whose uplink is offline | no send, no error; frame delivered on next change after reconnect (no replay obligation — the next push recomputes) |
| uplink reconnect / laptop restart (discriminating) | an uplink with a contested session disconnects and re-registers; the collision set is UNCHANGED throughout | that session's `lastContestedSent` entry was deleted on disconnect/re-registration, so the first `pushProject` after re-registration RE-SENDS the identical frame — an implementation that only compares by value must fail this row (it would send nothing and leave the reconnected laptop with no hub-sourced contested state) |
| restart preserves touched | hub restarts and hydrates from the journal (extends `poc/hub/test/hubRestart.test.ts`) | each hydrated `SessionFacts.touched` deep-equals what was journaled before the restart; the first post-restart push recomputes collisions from it and emits frames matching pre-restart state (change-detection state MAY reset — one duplicate frame after restart is acceptable and documented) |
| thesis bound | frame contents | ONLY sessionId, paths and colliding session ids — no transcript data, no prompts, no names |

**Risk / rollback (no runtime switch — deliberate).** `MPAI_CONTESTED_GATE` (Task 8b) covers
tier (b) on the laptop ONLY. The hub's `collisionsFrom` computation and the `contested`
down-frame have **no runtime switch**: their disable path is a `git revert` of this task's
commit followed by a rebuild, a restart, and a laptop-side step. The full procedure, in order:

1. `git revert` this task's commit, then `npm --prefix poc/hub run build`, then restart the hub
   (the hub is a long-lived process; a revert does not take effect in a running one). If the hub
   is ever run as a shared/deployed process rather than the local :4000 walk process, this step
   is a redeploy rather than a restart. (Task 6a's commit may stay: an unused frame type and
   validator that nothing sends is inert. Revert it too only if the type itself is unwanted.)
2. **Laptop side (required — the revert alone does not restore prior behavior).** Every attached
   laptop keeps its last-received `entry.contestedFrame` (Task 7a, in-memory) and would go on
   withdrawing auto-approve on stale hub-sourced peers. **Relaunch every attached laptop with
   `MPAI_CONTESTED_GATE=0`.** There is no "or" here: a running node process's `process.env`
   cannot be changed from outside it, so setting the variable is a RELAUNCH, not a live flip
   (see Task 8b's kill-switch note, which states the same truth).
   **Blast radius of that relaunch — read before running it (cycle-2 round-3 fix; Task 2a models
   this form and the env/revert paths lacked it).** Relaunching a laptop process **interrupts every
   in-flight agent turn on it**, **loses every unanswered `permission_request` with the process**
   (the gate promise never resolves; the human's open permission card stops existing), and
   **clears all in-memory per-session state** — `entry.touched` (Task 4), `entry.contestedFrame`
   (Task 7a) and `entry.contestedAsked` (Task 8b), so once-per-file promises reset and files a
   human already answered for can be asked about again. Worktrees and committed work on disk are
   untouched. **Drain or park live sessions first** — tell the drivers, let in-flight turns finish,
   answer or abandon pending gates deliberately — then relaunch. This cost is per laptop and this
   step says "every attached laptop", so it is paid once per attached machine.
3. Tier (a) surfaces need no separate step: local derivation is computed on read, so hub-sourced
   contested state clears on the next laptop restart and locally-derived state remains correct
   throughout.

Reverting does NOT remove `touched` values already written to the hub journal — those rows keep
the field and are ignored by the field-unaware reader (Task 3's downgrade note).

**Verify (server build FIRST — the hub resolves `relayProtocol` through the package exports map
from `dist/`, so a hub suite run before the build would exercise the pre-task `dist/`):**
`cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE server suite green
(this task changes no server source, so the suite is a regression guard on the `dist/` the hub is
about to consume), typecheck clean, build exits 0. THEN
`cd ../hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green.
**Commit:** `feat(hub): contested down-frame — per-session collision signal to owning laptops`

---

## Task 7b: digest tier (a) — contested lines in `<teammates>` *(spec §6a)*

**Files:** modify `poc/server/src/digest.ts` (line building), `poc/server/src/server.ts` (the
`digestFor` call site at `poc/server/src/server.ts:510` — it is the only place with a `Project`
handle, plus the `MPAI_DIGEST_DUMP` emit below); tests `poc/server/test/digest.test.ts`
(extend), `poc/server/test/serverDigestContested.test.ts` (new — the wiring and the dump).

**Interfaces — consumes:** `contestedFor(project, sessionId)` / `contestedSessionsFor(project,
sessionId, path)` (Task 7a) via `import { contestedFor, contestedSessionsFor } from
"./contested.js"` **in `server.ts`, not in `digest.ts`** (digest.ts is imported BY project.ts;
importing back would cycle). Produces:

```ts
// poc/server/src/digest.ts
export interface TeammateSummary {           // gains ONE field
  contested: string[];                       // repo-relative paths this peer shares with the
                                             // reading session, ascending; [] when none
}
export function summarizeSession(
  id: string, events: LoggedEvent[], isDead: boolean,
  contested?: string[],                      // NEW optional 4th param, defaults to []
): TeammateSummary;
export function buildTeammateDigest(others: TeammateSummary[]): string;  // signature UNCHANGED
```

`buildTeammateDigest` owns the line form, the 5-path cap and the ` +N more` overflow (so the
whole format lives where Task 7b's tests are). `server.ts`'s `digestFor` supplies each peer's
`contested` array from the Task 7a accessors; the optional 4th parameter keeps `project.ts`'s
existing `summarizeSession` call sites compiling untouched.

**Insertion point inside `poc/server/src/digest.ts`, pinned (cycle-2 round-3 fix — pinned the way
Task 4 pins `server.ts:464-465` and Task 8c pins `Transcript.tsx:125`).** `buildTeammateDigest`
(`digest.ts:30`) opens `lines` with `"<teammates>"` (`digest.ts:32`) and then, per peer, pushes
the summary line `- session "${o.id}"${status}: …` (`digest.ts:35-37`) followed — only when
`o.recentToolCalls.length > 0` — by the indented `  recent activity: …` line
(`digest.ts:38-44`). The contested line is pushed **inside the same per-peer loop iteration, AFTER
both of those**, i.e. as the LAST line of that peer's block:

```ts
// digest.ts, inside the `for (const o of others)` loop, after the recent-activity push
if (o.contested.length > 0) {
  lines.push(`  ${contestedLineFor(o)}`);   // the spec §6a line form, indented like
}                                           // `recent activity:` — one line per peer
```

Not a separate trailing group after all peers, and not before the summary line: the digest reads
peer-by-peer today and the contested fact belongs to the peer whose block it sits in. A peer with
`contested: []` pushes nothing (the `no collisions` row below).

**`MPAI_DIGEST_DUMP` — the capture mechanism Task 11a step 5 and Task 11b step 8e depend on.** Today
`digestFor` is a non-exported local (`server.ts:510`) whose output is never logged, so "record
the `digestFor` output for that turn" named no mechanism that exists. This task adds one,
env-gated and off by default, in `server.ts` immediately before `digestFor` returns:

```ts
if (process.env.MPAI_DIGEST_DUMP === "1") {
  process.stderr.write(`[digest-dump] session=${sessionId} ${JSON.stringify(digest)}\n`);
}
```

Exact line: `[digest-dump] session=<sessionId> "<the whole digest, JSON-escaped on ONE line>"`.
Read it back with — from the repo root, with the laptop launched as
`MPAI_DIGEST_DUMP=1 node "$REPO_ROOT"/poc/server/bin/mpai.js … 2> "$LAPTOP_LOG"` (the
owner-only capture path ledgered at Task 11a step 0) —
`command grep -n "\[digest-dump\] session=beta" "$LAPTOP_LOG" | tail -1`, which
prints the line to paste verbatim into the ledger. Env var read per call, never cached; when
unset the emit is one comparison and no output, so default behavior is byte-identical to today.
It is a debug facility, not a product surface: it writes to the laptop's OWN stderr, crosses no
session boundary, and is listed with the plan-authored decisions in the residuals section.
**Handling of the capture file.** The dump line contains peer paths, session ids and driver names
(the same class of content as the walk ledger itself), so wherever that stderr is REDIRECTED to a
file — Task 11a step 1 and Task 11b step 8a send it to `$LAPTOP_LOG` / `$SOLO_LOG` inside an
owner-only `umask 077` `mktemp -d` directory, never a fixed world-readable `/tmp` path — the capture file
inherits the ledger's handling: it is read, its evidence line is pasted into the ledger, and the
whole capture directory is deleted at walk shutdown (`rm -rf "$LOGDIR"`, Task 11b step 9) — and
also on any 11a/11b abort, where that cleanup is unconditional. Never leave a walk log on a
shared machine.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| digest line | session s2 (driver name resolvable from participants) shares `src/a.ts` | a line of the form `session s2 (driven by <name>) has also changed: src/a.ts` (spec §6a literal) |
| per-peer grouping | one peer session shares three paths | ONE line for that peer listing all three joined with the exact separator `", "` (comma + single space — `first.join(", ")`, the same separator Task 10b uses), paths ascending |
| overflow cap | a peer shares 8 paths | first 5 paths joined with `", "`, then the exact suffix ` +3 more` |
| unnamed driver | peer session has no resolvable driver name | line degrades to `session s2 has also changed: …` — never prints `undefined` |
| local-derivation source | contested set comes only from local derivation (solo mode) | identical lines — the digest never distinguishes source |
| dump gate off (discriminating) | `MPAI_DIGEST_DUMP` unset, a turn that builds a digest | NOTHING is written to stderr by `digestFor` |
| dump gate on (`serverDigestContested.test.ts`) | `MPAI_DIGEST_DUMP=1`, a turn whose digest contains `notes.txt` | exactly one stderr line matching `[digest-dump] session=<id> ` whose JSON payload contains `notes.txt` |
| thesis bound | digest content | paths, session ids, driver names only — never another session's prompts/transcript |
| untrusted peer text (discriminating) | a contested path and a peer id that arrived over the wire | interpolated VERBATIM into the line and never re-parsed, re-split or executed. This is safe only because the validators bound the characters upstream — Task 6a and Task 3 reject control characters and newlines in paths and bound every peer id by `SLUG` — so no peer string can break out of its line into a forged `<teammates>` entry. The row asserts the pairing: a path containing `\n` never reaches this function, and this function adds no escaping of its own |
| no collisions | nothing contested | `<teammates>` block unchanged from today (no empty contested section) |

**Exact values / provenance:** the **5-path-per-line cap and the ` +N more` overflow are
plan-authored**, not spec text — spec §6a gives the line form and sets no digest-line cap. They
bound prompt growth under a near-`TOUCH_CAP` touched set. The two surfaces share the ` +N more`
**overflow phrasing and the `", "` separator, but NOT the count**: the digest shows up to 5
paths per peer and Task 10b's party row up to 3, because a prompt line can carry more without
costing anything a human reads, while the party row sits in a narrow fixed-width rail. Task 10b
records that this ` +N more` phrasing supersedes spec §5's `+${rest}` example.

**Verify:** `cd poc/server && npx vitest run test/digest.test.ts test/serverDigestContested.test.ts
&& npx tsc --noEmit` → targeted files green; then `npx vitest run` → WHOLE server suite green;
then `npm run build` → exits 0.
**Commit:** `feat(server): agents learn contested files — digest tier of awareness`

---

## Task 8a: gate reason carrier — wire + state *(spec §6b's "the gate's UI line names why", server half; the render is Task 8c)*

Pure carrier task: it adds the field and the wire slot, and NOTHING sets a non-null reason
until Task 8b, and nothing DRAWS one until Task 8c. Split out from the policy for the same reason Task 6a's down-frame protocol is its own
task — a protocol change lands under its own commit.

**Files:** modify `poc/server/src/events.ts` (the `permission_request` event gains the reason —
**this is the carrier the client actually reads**, see below), `poc/server/src/pendingGate.ts`
(the derived `reason` field), `poc/server/src/relayProtocol.ts` (the gate frame carries the reason
to the client); tests `poc/server/test/pendingGate.test.ts` (extend),
`poc/server/test/relayProtocol.test.ts` (extend).

**Which carrier the client reads — decided here, not left to the executor (closes the council's
D3 blocking question).** The client renders permission gates from the `permission_request` EVENT:
`poc/client/src/components/Transcript.tsx:125` (`case "permission_request"`) reads `ev.toolName`
and `ev.input` off the logged event and has no `pendingGate` in scope at all. So the reason rides
the **event** (`poc/server/src/events.ts:24`), and `pendingGateOf` (`pendingGate.ts`) derives
`PendingGate.reason` from that same event — ONE source, both surfaces, no second writer to keep in
sync. The alternative (`SessionFacts.pendingGate` only) was rejected because nothing renders it:
it would have shipped a reason the UI can never show, which is exactly the gap the council found.
Registered in the plan-authored decisions register; the owner may prefer the facts-only carrier,
at the cost of a new `Transcript` prop and an `App.tsx` edit.

**Interfaces — produces:**

```ts
// poc/server/src/events.ts — the `permission_request` variant (events.ts:24) gains:
| { type: "permission_request"; requestId: string; toolName: string; input: unknown;
    reason?: string }   // additive OPTIONAL field; absent = no reason (ordinary gate)

// poc/server/src/pendingGate.ts — PendingGate gains:
reason: string | null;   // e.g. `contested with session alpha`; null for ordinary gates
                         // `pendingGateOf` maps it: `reason: ev.reason ?? null`

// poc/server/src/relayProtocol.ts — the permission-gate down-frame gains:
reason?: string | null;  // additive OPTIONAL field; absent and null are the same thing
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| default null | any gate opened by today's code paths | `PendingGate.reason === null`; the emitted gate frame is byte-identical to today's apart from the optional field being absent/null; the appended `permission_request` event is byte-identical to today's (no `reason` key) |
| derived from the event (discriminating) | a log whose oldest undecided `permission_request` carries `reason: "contested with session alpha"` | `pendingGateOf(events).reason === "contested with session alpha"` — the value comes from the EVENT, so an implementation that adds `reason` to `PendingGate` without reading it off the event must fail this row |
| carried to the client | a gate whose `reason` is `contested with session alpha` | the gate frame carries that exact string, character-for-character, to the client, AND the `permission_request` event the client replays carries it too (Task 8c renders the event's copy) |
| validation accepts | inbound gate frame with `reason` absent / null / a string | accepted; absent normalizes to null |
| validation rejects | `reason: 7` / `reason: {}` / a string longer than 512 chars (the gate-reason cap — a SEPARATE bound from `PATH_WIRE_CAP`, deliberately the same number; it stays an inline literal in `pendingGate.ts`/`relayProtocol.ts` because no other task consumes it) | frame rejected with the existing malformed-frame error path — never partially applied |
| protocol stability | `RELAY_PROTOCOL_VERSION` | UNCHANGED (additive optional field, same posture as Task 3); a peer that ignores `reason` still validates and still renders the gate |
| no policy yet (discriminating) | the whole server suite on this commit | no gate anywhere sets a non-null reason — this task ships the carrier only; Task 8b supplies the first writer |

**Verify:** `cd poc/server && npx vitest run test/pendingGate.test.ts test/relayProtocol.test.ts
&& npx tsc --noEmit` → targeted files green; then `npx vitest run` → WHOLE server suite green;
then `npm run build` → exits 0 (build last in the BUILD chain, Global Constraints; the check below
is read-only). Plus the no-writer check — **count-anchored, so it decides PASS/FAIL rather than
being read** (cycle-2 round-3 fix: "→ no hit assigns a …" was a judgment read of grep output,
unlike every other check in this plan):
`command grep -c "reason:" poc/server/src/agentDriver.ts poc/server/src/server.ts` → **prints
exactly `poc/server/src/agentDriver.ts:1` and `poc/server/src/server.ts:1`** — the pre-task
baseline, verified against the tree at plan time (each file has exactly one existing `reason:`
line, neither of them a `permission_request` reason). This task adds no new one; Task 8b supplies
the first writer, and its commit is where those counts are expected to rise.
**Commit:** `feat(server): permission gates carry a reason line`

---

## Task 8p: `contestedWrite` — the pure predicate *(spec §6b, first half)*

Pure-predicate task, split from the policy exactly as Task 8a was split from it: this task adds
a decidable function and its table, and NOTHING calls it until Task 8b. It touches no gate path,
reads no env, and changes no control flow — which is why it is `standard` risk while 8b is
`judgment`.

**Files:** modify `poc/server/src/permissions.ts`; test `poc/server/test/permissions.test.ts`
(extend).

**Depends on Task 7a for TYPES ONLY** — the `contested: ReadonlySet<string>` parameter is
supplied by the caller; this task imports no accessor and never calls one.

**Interfaces — produces (verbatim; the name is the contract, character-exact):**

```ts
// poc/server/src/permissions.ts (pure — no I/O, no env, no gate state)
export function contestedWrite(
  toolName: string,
  input: unknown,
  workdir: string | undefined,          // widened deliberately — see the note below
  contested: ReadonlySet<string>,
): string | null;   // returns the repo-relative contested path, else null
```

(resolve `file_path ?? notebook_path` against workdir — the `isContainedWrite` pattern — then
relativize and membership-test.)

**`workdir` is `string | undefined`, not `string` (cycle-2 round-2 fix — the two sides used to
disagree).** Every caller's workdir comes from `ProjectSessionEntry.workdir: string | undefined`
(Task 2b: `undefined` when the session has no repo) or from `DriverHooks.workdir?: string`
(`poc/server/src/agentDriver.ts:74`), both already optional. Widening the parameter here — rather
than making Task 8b guard at each of its three call sites — keeps the guard in ONE place and makes
it test-asserted by the row below. Task 4 already carries the symmetric `no workdir` row for the
recompute path, so this is a copy of an existing decision, not a new one.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| write tool on a contested path | `toolName` Edit / Write / NotebookEdit, `input.file_path` (or `input.notebook_path`) resolving inside `workdir` to a member of `contested` | returns that repo-relative path, character-exact |
| write tool on an uncontested path | same shapes, path not in `contested` | `null` |
| non-write tools (discriminating) | Bash / Read / Grep / any other tool name, even with a `file_path` naming a contested path | `null` — the predicate never fires for a non-write tool |
| escapes the worktree | resolved path outside `workdir` (`../`, absolute elsewhere, symlink-style traversal string) | `null`; the existing `isContainedWrite` containment rule is reused unchanged and this predicate never widens what may be written |
| malformed input | `input` null / not an object / no path key / path not a string | `null`; never throws |
| no workdir (discriminating) | `workdir === undefined` (session with no repo), any tool, any `contested` set | `null`, never throws — the predicate cannot relativize without a worktree root, so it never fires; matches Task 4's symmetric `no workdir` row and Task 8b's `session with no workdir` row |
| empty contested set | `contested.size === 0` | `null` for every input |
| purity | any call | no env read, no filesystem access, no mutation of `input` or `contested` |

**Verify:** `cd poc/server && npx vitest run test/permissions.test.ts && npx tsc --noEmit` →
targeted file green; then `npx vitest run` → WHOLE server suite green; then `npm run build` →
exits 0. Plus the discriminating no-caller check:
`command grep -rn "contestedWrite" poc/server/src` → hits ONLY in `permissions.ts` on this
commit (Task 8b supplies the first caller).
**Commit:** `feat(server): contestedWrite — pure predicate for writes to contested paths`

---

## Task 8b: auto-approve withdrawal at the three decision sites *(spec §6b, §8a ruling 4)*

**Single purpose:** make **every** auto-approval of a write consult the contested check, and make
the resulting human question say why. The `MPAI_CONTESTED_GATE` kill switch ships in THIS commit
rather than a follow-up one for a single stated reason: **it must never exist in a state where
withdrawal is live and undisableable** — a commit that adds the withdrawal without its escape
hatch is a commit whose only rollback is a revert (spec §8a ruling 4 mandates the switch as part
of the behavior, not as a later convenience). The bookkeeping (`contestedAsked`) is likewise not
separable: without it the withdrawal would ask on every write instead of once per file, i.e. it
would not be the behavior spec §6b describes.

**Files:** modify `poc/server/src/agentDriver.ts` (decision sites `:294` and `:531`, plus the
`getContested` hook member and constructor param), `poc/server/src/permissions.ts` (decision site
`:141` inside `buildCanUseTool`), `poc/server/src/server.ts` (supply the hook at the driver
construction site `server.ts:445`, and the `MPAI_CONTESTED_GATE` read),
`poc/server/src/project.ts` (`contestedAsked`); test
`poc/server/test/serverGateContested.test.ts` (new).

**Interfaces — consumes:** `contestedWrite` (Task 8p — the predicate), `contestedFor(project,
sessionId)` and `contestedSessionsFor(project, sessionId, path)` (Task 7a — these exact names, via
`import { contestedFor, contestedSessionsFor } from "./contested.js"` **in `server.ts`**, which is
the only module with a `Project` handle), pre-gate recompute (Task 4), the
`permission_request` event's `reason` and `PendingGate.reason` (Task 8a — this task is the first
writer of that field).

### The three auto-approval decision sites (named, with the exact carrier)

An executor must not have to find these. There are exactly three places in the codebase that can
turn a write into an approval without asking a human, and **ALL THREE consult the contested check
in this task** — a fix at one of them is not this task done:

| # | Site (file:line, today) | What it does today | After this task | Which recompute has run at this point |
|---|-------------------------|--------------------|-----------------|----------------------------------------|
| 1 | `poc/server/src/agentDriver.ts:294` — `onPermissionRequest`, `if (this.permissionMode === "auto") { … }` | appends `permission_request` + an `auto: true` `permission_decision` and resolves `"allow"` immediately | if `contestedWrite(...)` returns a path AND that path is not already in `contestedAsked`, this branch is SKIPPED: the request falls through to the existing human-ask path, and the appended `permission_request` carries `reason` | **Task 4 site 1** — `this.recomputeTouched?.()` ran as the FIRST statement of `onPermissionRequest`, synchronously, before this branch is evaluated. The set read here is the set that call just wrote |
| 2 | `poc/server/src/agentDriver.ts:531` — `setPermissionMode`, `if (mode === "auto") this.allowAllPending(userId)` (helper at `:655`) | blanket-allows every already-pending request when the driver switches to AUTO | pending requests whose contested path is not yet in `contestedAsked` are LEFT PENDING (not resolved, not denied); every other pending request is allowed exactly as today | **Task 4 site 2** — one `this.recomputeTouched?.()` ran immediately before `allowAllPending` iterates (only when a pending request is a write tool). Every pending request in this batch is judged against that single fresh set, not against the set that was current when each was queued |
| 3 | `poc/server/src/permissions.ts:141` — `buildCanUseTool`, `if (FILE_WRITE_TOOLS.has(toolName) && isContainedWrite(hooks.workdir, input)) return { behavior: "allow" }` | auto-allows any contained write regardless of permission mode | the early `allow` is skipped when `contestedWrite(toolName, input, hooks.workdir, hooks.getContested?.() ?? new Set())` returns a path not in `contestedAsked`; control falls through to the existing `hooks.onPermissionRequest` await | **Task 4 site 3** — `hooks.recomputeTouched?.()` ran immediately before this `if`, inside the same `FILE_WRITE_TOOLS` guard. This site is the reason the pre-gate recompute had to move off the `permission_request` event subscriber: `buildCanUseTool` runs BEFORE any `permission_request` event exists, so a subscriber-based recompute could never have run before this read |

**One ordering, stated once, and this table is where it is checked per site (cycle-2 round-3 —
this closes the D6 blocking contradiction).** All three sites read `hooks.getContested?.()` /
`this.getContested?.()` one statement after Task 4's synchronous decision-site recompute wrote
`entry.touched`, so "Task 8b judges fresh data" is true at all three, by construction rather than
by an assumption about `Session.append`'s subscriber ordering. If a driver was constructed without
`recomputeTouched` (existing fakes, older call sites), no recompute runs and the site judges the
last turn-boundary set — the `driver without collision wiring` behavior row covers it, and nothing
throws.

**How the contested state reaches those sites (the carrier — plan-authored, modelled on existing
code).** `Project` is not in scope in `agentDriver.ts` or `permissions.ts`, so the state arrives as
a callback on `DriverHooks`, exactly the way team oversight already does
(`getOversight?: () => string`, `poc/server/src/agentDriver.ts:78-80`, supplied at
`poc/server/src/server.ts:455`):

```ts
// poc/server/src/agentDriver.ts — DriverHooks gains, beside `getOversight`:
  /** The reading session's currently-contested repo-relative paths (Task 7a).
   *  Absent on drivers constructed without collision wiring — treat as empty. */
  getContested?: () => ReadonlySet<string>;
  /** Paths this session has already asked a human about (Task 8b bookkeeping).
   *  Absent = empty; membership means "do not withdraw again". */
  contestedAsked?: () => ReadonlySet<string>;
  /** Peer session ids colliding on a path, for the reason line (Task 7a). */
  contestedSessions?: (path: string) => string[];
  /** Record that a human answered a contested gate for this path. */
  onContestedAnswered?: (path: string) => void;
```

`AgentDriver` takes them as constructor params in the same position-after-`getOversight` style and
puts them into the hooks object literal it hands `run(this.prompts, { … })`
(`agentDriver.ts:289`), so site 1 reads `this.getContested?.()` and site 3 reads
`hooks.getContested?.()` from the SAME object. `server.ts:445` supplies them from the project
map — `() => contestedFor(project, sessionId)`, `() => entry.contestedAsked`,
`(path) => contestedSessionsFor(project, sessionId, path)`,
`(path) => entry.contestedAsked.add(path)` — all four closures over data `server.ts` already holds
at that call site. **Reconciliation with Task 8p:** 8p's claim that it "touches no gate path" is
still true of 8p — it adds `contestedWrite` and nothing calls it. THIS task adds the first callers,
at the three sites above; the two tasks share `permissions.ts` and are serialised by the exclusion
group, never concurrent (see the server/hub rationale).

**Bookkeeping (once per file per session):** `ProjectSessionEntry.contestedAsked: Set<string>`
(repo-relative paths), in `poc/server/src/project.ts`. A path is added when a human answers a
contested gate for it (allow OR deny), via `onContestedAnswered`. It is **never** cleared while
the session lives — see the behavior rows.

**Kill switch (spec §8a ruling 4):** env `MPAI_CONTESTED_GATE`; the exact value `"0"` disables
this task's behavior entirely, at all three sites. Read once per gate decision, not cached at
boot — **and the reason is not "an operator can flip it without a restart", which is false**: a
running node process's `process.env` cannot be changed from outside it. The per-decision read
means the switch is honoured per-gate in tests and takes effect on the very first gate after a
relaunch; changing it on a LIVE laptop still requires relaunching that process with
`MPAI_CONTESTED_GATE=0` (Task 6b's rollback step 2 says the same).
**What that relaunch COSTS — stated here, before anyone reaches for the switch on a live machine
(cycle-2 round-3 fix; Task 2a models this form).** Relaunching the laptop process **interrupts
every in-flight agent turn on it**, **loses every unanswered `permission_request` with the
process** (including the very contested gate someone was trying to escape), and **clears all
in-memory per-session state** — `entry.touched` (Task 4), `entry.contestedFrame` (Task 7a) and
`entry.contestedAsked` (this task), so the once-per-(file, session) promise resets and files a
human already answered for become askable again. Worktrees and committed work on disk are
untouched. **Drain or park live sessions first** — tell the drivers, let in-flight turns finish,
answer or abandon pending gates deliberately — then relaunch. Note the asymmetry this creates: a
kill switch whose only live application path costs a restart is a deployment-time switch, not an
incident-time one; the incident-time behavior is "answer the gate once per file", which never
blocks a write. If a genuinely no-restart kill
switch is wanted, moving the flag to a dot-file read per gate decision is an owner call, not a
mechanical change. Tier (a) surfaces (Task 7b digest, client UI) are NOT gated by
it, and that absence is deliberate: tier (a) mutates no shared state and changes no control
flow — it adds bounded advisory text (≤ 5 paths + ` +N more` per peer, Task 7b) and read-only
DOM. Its disable path is therefore a `git revert` of the Task 7b / 8c / 9b / 10a / 10b commits,
which touch no shared state and need no runtime switch. Extending `MPAI_CONTESTED_GATE` to cover
the digest would be an owner call, not a mechanical addition. The switch also covers the accepted
degenerate case: a session whose `touched` approaches
`TOUCH_CAP = 500` makes nearly every write in a shared repo contested, so auto-approve is
effectively off repo-wide until the human answers once per file — that is the accepted worst
case, it still never blocks a write, and `MPAI_CONTESTED_GATE=0` is the escape hatch.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| site 1 — auto mode suppressed (discriminating) | driver in `permissionMode === "auto"`; an Edit to a contested path arrives at `agentDriver.ts:294` | NO `auto: true` `permission_decision` is appended and the promise does NOT resolve `"allow"`; a `permission_request` event is appended carrying `reason` and the driver waits for a human. An implementation that fixes only site 3 must fail this row (site 1 returns before `canUseTool` ever sees the call in auto mode) |
| site 2 — allow-all-pending suppressed (discriminating) | a contested write is already PENDING; the driver is then switched to AUTO (`setPermissionMode("auto")` → `allowAllPending`, `agentDriver.ts:531`) | that pending request is NOT resolved by `allowAllPending` — it stays pending until a human answers; any OTHER pending request in the same call is allowed exactly as today. An implementation that fixes only sites 1 and 3 must fail this row |
| site 3 — contained-write auto-allow suppressed (discriminating) | driver in `default` mode; an Edit to a contested path inside the workdir reaches `permissions.ts:141` | the early `return { behavior: "allow" }` is NOT taken; control falls through to `hooks.onPermissionRequest` and a human is asked. An implementation that fixes only sites 1 and 2 must fail this row (the contained-write allow fires regardless of permission mode) |
| all three consult the SAME set | the same contested path, exercised once per site | each site calls `contestedWrite` with `hooks.getContested?.()` — one source of truth; no site reimplements the membership test |
| withdrawal (hub mode) | AUTO-approvable write to a path contested via a hub `contested` frame | auto-approval suppressed; the gate asks a human; the `permission_request` event's `reason` and the derived `PendingGate.reason` are exactly `contested with session ${otherSessionId}` where otherSessionId = `contestedSessionsFor(...)[0]` (first colliding session by ascending id) |
| withdrawal (local derivation only, discriminating) | solo / same-machine: the path is contested ONLY by local derivation, no hub frame ever arrived | auto-approval still suppressed AND the reason names the actual local colliding session id — identical string form to hub mode |
| kill switch off | `MPAI_CONTESTED_GATE=0`, write to a contested path with auto-approve on | auto-approved exactly as today at ALL THREE sites; no gate, no reason, no `contestedAsked` entry (discriminating row) |
| kill switch default | env unset (or any value other than `"0"`) | withdrawal active (banked decision 5, on by default) |
| once per (file, session) | human answers (allow OR deny); the agent writes the same file again | path is in `contestedAsked`; normal auto-approve rules apply again for that file in that session, at all three sites |
| path leaves and returns | after the human answers, the path drops out of the contested set and later becomes contested again | still NOT re-asked — `contestedAsked` is not cleared on set changes; the promise is once per (file, session) for the session's lifetime |
| second write while gate pending | a second write to the SAME path arrives while the first gate is still unanswered in `pendingGate.ts` | it does not open a second contested gate and does not auto-approve on the strength of the unanswered first — it follows the existing pending-gate queuing behavior unchanged; `contestedAsked` gains the path only when a human actually answers |
| non-contested write | write to an uncontested path with auto-approve on | auto-approved exactly as today (discriminating row) |
| session with no workdir | a write gate on a session whose `entry.workdir` is `undefined` (no repo) | contested logic skipped entirely — `contestedWrite` returns `null` on an undefined workdir (Task 8p's `no workdir` row); auto-approve behaves exactly as today, no reason set, no `contestedAsked` entry |
| driver without collision wiring | a driver constructed with no `getContested` hook (existing test fakes, older call sites) | `hooks.getContested?.() ?? new Set()` — behaves exactly as today, never throws |
| non-write tools | Bash/Read/etc. on any path | never affected (end-to-end at the gate; the predicate-level row lives in Task 8p) |
| outside worktree | write whose resolved path escapes the workdir | existing isContainedWrite behavior unchanged; contested logic never widens what may be written |
| untrusted peer id in the reason line (discriminating) | the colliding peer id arrived over the wire in a hub `contested` frame | the reason is `contested with session ${otherSessionId}` with the id interpolated VERBATIM and never re-parsed or escaped by this task — safe because Task 6a validates every peer id with `str(id, SLUG)` (`/^[a-z0-9-]{1,40}$/`), so no newline, control character or 500-char string can reach this line. Two consequences asserted by this row: a non-SLUG peer id never gets here at all (the frame was rejected upstream), and the 512-char gate-reason cap (Task 8a) is unreachable by construction — `contested with session ` + ≤ 40 chars |
| advisory bound | any collision state | NOTHING is blocked — the only effect is auto → human, once |

**Verify:** `cd poc/server && npx vitest run test/serverGateContested.test.ts &&
npx tsc --noEmit` → the new file green; then `npx vitest run` → WHOLE server suite green
(this task edits `agentDriver.ts` and `permissions.ts`, whose existing suites
`test/agentDriver.test.ts` and `test/permissions.test.ts` guard today's auto-approve behavior);
then `npm run build` → exits 0. Plus the all-three-sites check:
`command grep -c "contestedWrite" poc/server/src/agentDriver.ts` → **≥ 2** (sites 1 and 2) and
`command grep -c "contestedWrite" poc/server/src/permissions.ts` → **≥ 2** (the export plus site
3's call) — a commit that wired only one file cannot pass both.
**Commit:** `feat(server): contested writes withdraw auto-approve at all three decision sites`

---

## Task 8c: client — the gate names why *(spec §6b, "The gate's UI line names why")*

The client half of spec §6b's UI clause. Task 8a carries the reason to the client and Task 8b is
its first writer; without this task the reason reaches the browser and is never drawn — the gap
the council's D3 blocking finding named.

**Files:** modify `poc/client/src/types.ts` (two mirrored optional fields — see below),
`poc/client/src/components/Transcript.tsx` (the `case "permission_request"` block at
`Transcript.tsx:125`); create `poc/client/src/components/Transcript.test.tsx` (**new** — no
Transcript test exists in the repo today; follow the `ProjectPicker.test.tsx` /
`RecordPanel.test.tsx` pattern).

**Depends on Tasks 8a and 8b** — 8a for the wire (the `permission_request` event's `reason` and
the `SessionFacts.pendingGate` mirror), 8b for the first non-null value.

**Interfaces — produces (verbatim):**

```ts
// poc/client/src/types.ts — on LoggedEvent (the flat event bag, types.ts:3), beside `auto?`:
  /** Why this permission gate was opened, e.g. `contested with session alpha`
   *  (spec §6b). Optional so an event from an older server still parses. */
  reason?: string | null;

// poc/client/src/types.ts — on ProjectSessionInfo's pendingGate mirror (types.ts:71):
  pendingGate?: { toolName: string; sinceTs: string; reason?: string | null } | null;
```

Both are added: the `LoggedEvent` field is the one **Transcript renders** (it renders from
`props.events`, not from facts — Task 8a's carrier note), and the `pendingGate` mirror keeps the
client's facts type in step with the server's `PendingGate` so a future facts-side surface has the
field to read. Neither is required, so `npx tsc -b` cannot fail on an older snapshot.

**Render (exact placement and text).** Inside `case "permission_request"` in
`poc/client/src/components/Transcript.tsx`, immediately AFTER the existing line

```tsx
<div className="perm-what">
  the agent wants to use <b>{ev.toolName}</b> — not on the auto-approve list
</div>
```

render, only when `ev.reason` is a non-empty string:

```tsx
{ev.reason ? <div className="perm-why">{ev.reason}</div> : null}
```

The reason string is produced server-side (Task 8b) and rendered VERBATIM — the client neither
composes nor reformats it, so the walk's literal `contested with session alpha` is the same string
end to end. No new stylesheet rule is required (`perm-why` may reuse the existing `.perm-what`
styling; adding a rule is allowed but `terminal.css` is Task 9b's file, so this task must not
touch it — if a rule is wanted, it is an owner call routed through 9b).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| reason rendered (discriminating) | a `permission_request` event with `reason: "contested with session alpha"` | the rendered output contains the literal `contested with session alpha` VERBATIM, in addition to (not instead of) the existing `the agent wants to use … — not on the auto-approve list` line — an implementation that replaces the existing line must fail this row |
| no reason | a `permission_request` event with `reason` absent (every gate opened by today's code paths) | NO extra node is rendered — not an empty one; the block is byte-identical to today |
| empty-string reason | `reason: ""` / `reason: null` | treated as absent — no node |
| decided gate keeps the reason | a `permission_request` with a reason that has since been decided | the reason line still renders beside the DECIDED outcome — the transcript is a log, not a live prompt |

**Verify:** `cd poc/client && npm --prefix ../server run build && npx tsc -b && npx vitest run
src/components/Transcript.test.tsx` → server build exits 0 (explicit — `npx vitest run` fires no
`pretest`), then the new file's cases green (each shown RED on pre-task code first, per the TDD
constraint); then `npx vitest run` → WHOLE client suite green. Plus
`command grep -c "ev.reason" poc/client/src/components/Transcript.tsx` → **≥ 1** (the render site
exists in the shipped component, not only in the test).
**Commit:** `feat(client): permission gates show why — the contested reason line`

---

## Task 9a: collisionView — client adapter over `collisionsFrom` *(spec §5)*

**Files:** create `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts`;
modify `poc/client/src/types.ts` (ONE added field — see below).

**The client's snapshot row is FLAT — this task's input type is that row, not a `facts` wrapper.**
`ProjectSessionInfo` (`poc/client/src/types.ts:61`) is the client's mirror of
`ProjectMessage.sessions[]`: `id`, `participants`, `driverName`, …, `repoKey?`, `lifecycle?` —
there is no `facts` member on it and nothing in the client builds one. This task therefore adds
the mirrored field and consumes the row type directly. The exact addition to
`poc/client/src/types.ts`, on `ProjectSessionInfo`, beside `lifecycle?`:

```ts
  /** Repo-relative paths this session has changed (spec §3.3). Optional so a
   *  snapshot from an older server still parses — same posture as `repoKey`. */
  touched?: string[] | null;
```

Server-side counterpart: Task 3 adds `touched: string[] | null` to `ProjectMessage.sessions[]`'s
inline row type, which is what this field mirrors.

**Interfaces — consumes.** Exact import lines in `poc/client/src/collisionView.ts` (the RUNTIME
import is the first non-type client import of the server package):

```ts
import { collisionsFrom, COLLISIONS_MODULE_ID } from "multiplayer-ai-server/collisions";
import type { Collision, CollisionInput } from "multiplayer-ai-server/collisions";
import type { ProjectSessionInfo } from "./types";
```

Produces (verbatim — 9b, 10a and 10b depend on these three signatures, character-exact):

```ts
export function projectCollisions(sessions: ProjectSessionInfo[]): Collision[];
// Maps each row to CollisionInput: sessionId ← row.id, repoKey ← row.repoKey ?? null,
// lifecycle ← row.lifecycle ?? "open", touched ← row.touched ?? null. Then delegates to
// collisionsFrom — no reimplementation of the intersection.
export function contestedCountFor(sessionId: string, collisions: Collision[]): number;
export function sharedWith(sessionId: string, otherSessionId: string, collisions: Collision[]): string[];
```

**Callers (so no client task has to invent its data source).** 9b passes its component-local
`sessions` state; 10b passes its existing `sessions` prop; 10a passes App's `projectSessions`.
All three are already `ProjectSessionInfo[]` — that is why this signature takes the row type
rather than an adapter shape nothing constructs.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| adapter | snapshot session rows (`ProjectSessionInfo[]`) | projectCollisions maps each row to CollisionInput by the mapping above and delegates to collisionsFrom (no reimplementation — asserted by deep-equal against direct collisionsFrom output) |
| mapping pinned (discriminating) | a row `{ id: "s1", repoKey: "r", lifecycle: "closed", touched: ["a.ts"] }` and a row `{ id: "s2", repoKey: "r", touched: ["a.ts"] }` with `lifecycle` and `touched` ABSENT on a third row `{ id: "s3", repoKey: "r" }` | the `CollisionInput[]` handed to `collisionsFrom` is exactly `[{sessionId:"s1",repoKey:"r",lifecycle:"closed",touched:["a.ts"]}, {sessionId:"s2",repoKey:"r",lifecycle:"open",touched:["a.ts"]}, {sessionId:"s3",repoKey:"r",lifecycle:"open",touched:null}]` — absent/undefined `touched` becomes `null` (never `[]`, never `undefined`), absent `repoKey` becomes `null`, absent `lifecycle` becomes `"open"` |
| missing field | a session row with no `touched` (older peer) | mapped to `touched: null`; contributes nothing; never throws |
| count | a session in 3 distinct collision paths | contestedCountFor = 3 (distinct paths involving that session) |
| shared | two sessions sharing 2 paths | sharedWith returns both, ascending; unrelated pair → `[]` |
| none | no collisions | `[]` from all three (discriminating row) |

**Verify:** `cd poc/client && npm --prefix ../server run build && npx tsc -b && npx vitest run
src/collisionView.test.ts` → the explicit server build exits 0 (this task imports
`multiplayer-ai-server/collisions` at RUNTIME, and `npx vitest run` fires no `pretest` hook, so
the build must be issued here), then green. Then the bundle check (minification-stable anchor —
esbuild mangles binding names but preserves string literals, so grepping for `collisionsFrom` as
an identifier is NOT valid). **Every command in this block runs from `poc/client`:**

`npm run build && command grep -c "collisionsFrom/v1" dist/assets/*.js` → `command grep -c`
prints one `file:count` line per matched file, so the expected result is **at least one line
whose count is ≥ 1** (equivalently, `command grep -l "collisionsFrom/v1" dist/assets/*.js`
prints at least one path) — proving Task 5's runtime-reachable module-id literal actually
bundled. **Verdict rule (no judgement call):** at least one non-zero count = **PASS** of the
bundle check. NO non-zero count = **FAIL of the bundle check, even if the node smoke check below
is green** — a green smoke check with an absent literal means the module resolves under node but
did not reach the browser bundle, which is precisely the failure this check exists to catch. On
that FAIL, do not proceed to 9b/10a/10b; fix the bundling first. (The smoke check is run in every
case, as a second, independent assertion — never as an escape hatch from this one.) It imports
through the **package specifier the real client code uses**, not a
relative file path, so it also proves Task 5's new `"./collisions"` entry in
`poc/server/package.json` resolves — the exports-map failure a `../server/dist/...` import would
silently pass. Run it from `poc/client`, the cwd this block established, where the
`file:../server` link resolves the specifier:

`node --input-type=module -e "import {collisionsFrom,COLLISIONS_MODULE_ID} from 'multiplayer-ai-server/collisions'; if(COLLISIONS_MODULE_ID!=='collisionsFrom/v1')process.exit(1); console.log(collisionsFrom([]))"`
→ prints `[]`, exit 0.
**Commit:** `feat(client): collisionView — client adapter over collisionsFrom`

---

## Task 9b: client session-list surfaces *(spec §5)*

**Files:** modify `poc/client/src/components/SessionPicker.tsx`,
`poc/client/src/terminal.css` (adds the `contested-calm` class — it does not exist today; the
amber gate tokens at `terminal.css:37-39` stay untouched); create
`poc/client/src/components/SessionPicker.test.tsx` (**new** — no SessionPicker test exists in
the repo today; this file holds the render tests for the rows below, against `collisionsFrom`
fixtures, spec §9 "UI: render tests …").

**Interfaces — consumes:** Task 9a's `projectCollisions` / `contestedCountFor` / `sharedWith`.

**Data path (no App edit — `App.tsx` is outside this task's file list and Global Constraints
forbid staging outside it).** `SessionPicker` already owns its session list in component-local
state (`poc/client/src/components/SessionPicker.tsx:33`,
`const [sessions, setSessions] = useState<ProjectSessionInfo[]>([])`) and its props are only
`{ projectId; userId; name }`. This task computes collisions IN THE COMPONENT from that local
state — `const collisions = useMemo(() => projectCollisions(sessions), [sessions]);` — and adds
NO new prop, so nothing in `App.tsx` needs to change and `npx tsc -b` cannot fail on an unpassed
required prop.

**Render placement, pinned (cycle-2 round-3 fix — the same precision Task 8c and Task 10a already
carry; `SessionPicker.tsx:33` named only the state hook, not where anything is drawn).** Two
insertion points in `poc/client/src/components/SessionPicker.tsx`, both inside the
`groups.map((group) => …)` block at `SessionPicker.tsx:231-268`:

- **repo-group chip** — the group head is the `showRepoHeads &&` block,
  `SessionPicker.tsx:233-244`, whose single rendered expression is
  `{labels.get(group.repoKey) ?? (group.repoKey || "unknown repo")}` (`:242`). The chip is
  appended INSIDE that same `<div className="line pix sm dim">`, after the label expression:

  ```tsx
  {labels.get(group.repoKey) ?? (group.repoKey || "unknown repo")}
  {groupContestedCount > 0 && (
    <span className="contested-calm">{`⚠ ${groupContestedCount} contested`}</span>
  )}
  ```

  Note it must render even when `showRepoHeads` is false only if the owner wants it there — it
  does NOT: the chip belongs to the group head, and a single-group view has no head today. That
  is existing behavior this task does not change.
- **session-row marker** — the state badge is the `<span className={\`spstate pix sm …\`}>` at
  `SessionPicker.tsx:250-252`, inside `<div className="spname">` (`:249`). The marker is a sibling
  rendered immediately AFTER that badge, still inside `.spname`:

  ```tsx
  {isContested && <span className="contested-calm">contested</span>}
  ```

  — beside the state badge, exactly as spec §5 words it, and after it so a CLOSED session reads
  `CLOSED` then `contested` (the `spec §2.6` case in the rows below).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| repo-group chip | a repo group with ≥1 collision | group head renders exactly `⚠ ${n} contested` where `n` = the distinct contested path COUNT for that repo group (a number, never a path list — e.g. `⚠ 2 contested`, never `⚠ src/a.ts,src/b.ts contested`); groups without collisions render exactly as today |
| session-row marker | a session appearing in any Collision | a marker beside the state badge (immediately after it, inside `.spname`) rendering the EXACT literal `contested` — **no count and NO `⚠` glyph**, matching spec §5's per-session marker literal verbatim (Global Constraints; the earlier `⚠ contested` reading is withdrawn — the glyph belongs to the group chip and the header badge, which spec §5 spells with it); CLOSED sessions show both markers (spec §2.6) |
| calm styling | the chip/marker | carries class `contested-calm` (assert the class name, not a color) AND the class is DECLARED in `terminal.css` as `.contested-calm { color: var(--gold); border-color: var(--gold); background: var(--gold-wash); }` — the existing awareness tokens at `terminal.css:35` and `:42`; no `--amber*` token appears in the rule |
| none | no collisions | zero new DOM (discriminating row) |

**Verify:** `cd poc/client && npm --prefix ../server run build && npx tsc -b && npx vitest run
src/components/SessionPicker.test.tsx` → server build exits 0 (explicit — no `pretest` hook
fires under `npx vitest run`), then the new file's cases green (each shown RED on pre-task code
first, per the TDD constraint); then `npx vitest run` → WHOLE client suite green. Plus the two CSS
checks, **both count-anchored, and the second's anchor proved by the first** (cycle-2 round-3 fix:
"the class is DEFINED (a rule body, not just a class reference)" was a judgment read of grep
output, and the `-A3` pipeline printed the PASS value `0` vacuously whenever its anchor failed to
match):

1. **Rule-body existence AND anchor precondition, in one command:**
   `command grep -c '^\.contested-calm[[:space:]]*{' poc/client/src/terminal.css` →
   **prints exactly `1`**. This proves a rule BODY exists (not a bare class reference) and pins
   the exact anchor check 2 depends on: the selector is written at column 0, unindented and
   uncompounded. **If this prints `0`, check 2 is void, not passed** — a selector written indented
   or compounded (`.chip.contested-calm {`) makes `^\.contested-calm` match nothing, so check 2's
   pipeline prints `0`, the PASS value, even if the rule uses `--amber`. Check 1 failing is
   therefore a FAIL of this Verify, not a licence to interpret check 2.
2. **No amber token in the rule body:**
   `command grep -A3 '^\.contested-calm' poc/client/src/terminal.css | command grep -c 'amber'` →
   **prints exactly `0`**. Valid only with check 1 green.

The rule is authored as ≤ 4 lines (selector + the three declarations in Global Constraints), so
`-A3` covers its whole body; a longer rule must widen the `-A` count to match.
Plus the marker-literal check (the glyph withdrawal above is a stated requirement of this diff, so
it carries an objective check like every other):
`command grep -c '⚠ contested' poc/client/src/components/SessionPicker.tsx` → **prints exactly
`0`** — the session-row marker is the bare literal `contested`; the only `⚠` in this file is the
group chip's `⚠ ${n} contested`.
**Commit:** `feat(client): contested chips on the session list`

---

## Task 10a: client header badge + App wiring *(spec §5)*

**Files:** modify `poc/client/src/components/Header.tsx`, `poc/client/src/App.tsx`; create
`poc/client/src/components/Header.test.tsx` (**new** — it does not exist in the repo today;
follow the `ProjectPicker.test.tsx` / `RecordPanel.test.tsx` pattern). Render tests over
`collisionsFrom` fixtures (spec §9). **No stylesheet edit:** `contested-calm` is declared by
Task 9b; this task only applies the class name.

**Depends on Task 9b — and the edge is now in the scheduling contract, not only in prose
(cycle-2 round-3 fix).** This task's badge carries `className="contested-calm"`, and that class is
DECLARED by Task 9b in `poc/client/src/terminal.css`. The plan said so in two places (this
paragraph and the client rationale), but "the table alone is the scheduling contract" — so an
executor scheduling from the table could have landed 10a's badge referencing an undeclared class.
The dependency table's Depends-on cell for 10a now reads `5, 9a, 9b`. The edge is ordering-only:
this task's tests assert the class NAME, never a computed style, so nothing here fails on a
missing rule — but a badge styled by nothing is not the calm surface spec §5 asks for, and
shipping it in that state for one commit is avoidable by ordering.

**Interfaces — consumes:** Task 9a's `projectCollisions` / `contestedCountFor`.

**Data path and the exact new prop.** `App.tsx` already holds `projectSessions`
(`ProjectSessionInfo[]`, the same array it passes to `PartyPane` at `poc/client/src/App.tsx:564`).
This task adds, in `App.tsx`,
`const collisions = useMemo(() => projectCollisions(projectSessions), [projectSessions]);` and
passes ONE new named prop to `Header`:

```tsx
// poc/client/src/components/Header.tsx
import type { Collision } from "multiplayer-ai-server/collisions";   // type-only — no runtime
                                                                     // import is added here
// … Header's props object gains, beside `pulls?: number`:
  /** Contested paths across the project, from Task 9a. Optional so a caller
   *  that has not computed them renders no badge rather than crashing. */
  contested?: Collision[];
```

`Header` renders the badge from `contestedCountFor(props.sessionId, props.contested ?? [])`. The
prop is OPTIONAL, so no other `Header` call site has to change. No other component receives a
`collisions` prop: 9b and 10b each compute their own (see their Data-path notes) and neither
touches `App.tsx`.

**Memoization is not BEHAVIORALLY test-asserted, but it is mechanically checked.** The `useMemo`
above exists so a git-scale array is not re-intersected on every render. The client has no
App-level test file (`poc/client/src/App.test.tsx` does not exist) and this task does not add
one — an App render harness is a larger piece of work than the wiring it would guard — so no test
observes the memo's EFFECT. Its PRESENCE is nevertheless a stated requirement of this task's diff,
and every stated requirement in this plan carries an objective check, so the Verify below greps
for the exact line. Every row in the behavior table below IS asserted by `Header.test.tsx`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| header badge | `contested` prop puts the current session in N > 0 contested paths | badge exactly `⚠ CONTESTED ▸ ${N}` beside the PULLS badge; class `contested-calm`, not the gate amber |
| badge hidden at 0 (discriminating) | current session has 0 contested paths | NO badge node rendered at all — not an empty one |
| prop absent | `Header` rendered with no `contested` prop at all (every pre-existing call site) | renders exactly as today — no badge node, no crash |

**Verify:** `cd poc/client && npm --prefix ../server run build && npx tsc -b && npx vitest run
src/components/Header.test.tsx` → server build exits 0 (explicit — `npx vitest run` fires no
`pretest`), then the new file's cases green (each shown RED on pre-task code first); then
`npx vitest run` → WHOLE client suite green. Plus the memo-presence check (the one stated
requirement of this diff with no behavioral test — see the note above), **whitespace-hardened so a
formatter cannot produce a spurious FAIL on a correct diff** (cycle-2 round-3 fix: the literal
string form failed on the perfectly correct
`useMemo(\n  () => projectCollisions(projectSessions),`):
`command grep -czE 'useMemo\([[:space:]]*\([[:space:]]*\)[[:space:]]*=>[[:space:]]*projectCollisions\(projectSessions\)' poc/client/src/App.tsx`
→ **prints exactly `1`**. (`-z` makes the file one record so the pattern matches across the line
break a formatter may insert; drop `-z` only if the memo is written on a single line, in which
case `command grep -cE 'useMemo\([[:space:]]*\([[:space:]]*\)[[:space:]]*=>[[:space:]]*projectCollisions\(projectSessions\)' poc/client/src/App.tsx`
→ exactly `1` is the equivalent check.)
**Commit:** `feat(client): contested badge in the session header`

---

## Task 10b: client party-pane share rows *(spec §5)*

**Files:** modify `poc/client/src/components/PartyPane.tsx`; create
`poc/client/src/components/PartyPane.test.tsx` (**new** — it does not exist in the repo today;
same pattern as above). Render tests over `collisionsFrom` fixtures (spec §9).

**Interfaces — consumes:** Task 9a's `projectCollisions` / `sharedWith`.

**Data path (no App edit, no new prop).** `PartyPane` already receives
`sessions: ProjectSessionInfo[]` (`poc/client/src/App.tsx:564` passes `sessions={projectSessions}`),
so this task computes collisions IN THE COMPONENT from that existing prop —
`const collisions = useMemo(() => projectCollisions(props.sessions), [props.sessions]);` — and
adds no prop and no `App.tsx` edit. (10a's `Header` prop is separate and does not reach here.)

**Render placement, pinned (cycle-2 round-3 fix — same precision as Task 8c's
`Transcript.tsx:125` block).** The OTHER PARTIES section head is at
`poc/client/src/components/PartyPane.tsx:59-60` (`<div className="party-title pix">` /
`<span>OTHER PARTIES</span>`); the rows it heads are the `others.map((s) => …)` block beginning at
`PartyPane.tsx:88`, each row an `<a className="member …">` (`:95-118`) containing
`<div className="member-head">` (`:100`) and `<div className="member-meta">` (`:113`). The shares
line is rendered as the LAST child of that `<a>`, after the existing `member-meta` div and before
the closing `</a>` (`:118`):

```tsx
{shared.length > 0 && (
  <div className="member-meta contested-calm">
    {`⚠ shares: ${shared.slice(0, 3).join(", ")}${shared.length > 3 ? ` +${shared.length - 3} more` : ""}`}
  </div>
)}
```

`shared` is `sharedWith(props.sessionId, s.id, collisions)` (Task 9a). It reuses the existing
`member-meta` class for layout and adds `contested-calm` for the calm token — no new stylesheet
rule, and `terminal.css` stays Task 9b's file (Global Constraints forbid staging outside this
task's file list).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| party row | an OTHER PARTIES row whose session shares paths with yours | one line `⚠ shares: ${first3.join(", ")}` — separator exactly `", "` (comma + single space), the same separator Task 7b's digest line uses — plus ` +${rest} more` when > 3 |
| no collision | no overlap with your session | rows and header exactly as today |

**Note (deliberate supersession):** spec §5's example prints bare `+2` (`⚠ shares: src/a.ts,
src/b.ts +2`). This plan uses ` +${rest} more` instead, so the party row and Task 7b's digest
overflow read identically. That is a plan-authored change to a spec *example*, not to a spec
rule; recorded here so a reviewer does not read it as drift. The path COUNT differs on purpose
(3 here, 5 in the digest) — see Task 7b's provenance note.

**Verify:** `cd poc/client && npm --prefix ../server run build && npx tsc -b && npx vitest run
src/components/PartyPane.test.tsx` → server build exits 0 (explicit), then the new file's cases
green (each shown RED on pre-task code first); then `npx vitest run` → WHOLE client suite green.
**Commit:** `feat(client): party-row shares — the peer-overlap awareness surface`

---

## Task 11a: browser walk — hub-attached leg, steps 0–7 *(verification only, no source changes;
spec §9 walk row — steps beyond it are house verification convention)*

**Files:** none in the normal case (deliverable = walk record in the execution ledger). The ONE
exception is step 5: a FAIL there requires a follow-up entry in `docs/tech-debt.md` — that is
the only file this task may write, and it is why the dependency table's Files cell reads
"ledger record; `docs/tech-debt.md` ONLY on a step-5 FAIL". Task 12 also edits that file and
depends on this task, so it must expect a step-5 entry to be present already.

**Split note (11a / 11b).** The walk is two tasks because it is two product modes with a full
process teardown between them: 11a is the hub-attached leg (steps 0–7), 11b is the solo parity
leg (steps 8a–8f) plus shutdown (step 9). 11b depends on 11a and inherits 11a's process/PID
hygiene rules verbatim; Task 12 depends on both. The step text and numbering are unchanged from
the single-task version, so every cross-reference elsewhere in this plan still resolves.

Each numbered step — including every lettered sub-step — is INDEPENDENTLY ledgered; a later
failure does not invalidate earlier recorded results.

**What this walk does and does NOT discriminate (read before recording a PASS).** Steps 1–7 run
alpha and beta on a SINGLE laptop attached to the hub. Task 7a defines the contested set as the
UNION of the hub frame and local derivation, so a PASS in steps 4/6/7 is satisfiable by local
derivation ALONE: these steps prove **"hub attached, derivation source not discriminated"**,
not "the hub down-frame works end to end". Task 6b's hub suite (`poc/hub/test/contested.test.ts`,
two uplinks in one repoKey) is the only end-to-end evidence for the down-frame, and it is where
a down-frame regression must be caught. Ledger steps 1–7 under that label verbatim.
*(Owner option, not required by this plan: launch a SECOND laptop — second clone, second port,
its own PID file — so steps 4/6/7 exercise a genuine cross-uplink frame. That upgrade would
make the hub-mode claim discriminating; it is out of scope here because it adds a second
user-machine port to the walk.)*

**Process hygiene (binding for every step):** launch each process in the background and record
its PID; stop ONLY by recorded PID. **Never `pkill -f node`, never `pkill` by process name, never
kill by port owner** — the user's own servers share this machine.

**PID-file hygiene (binding — a stale PID file is a loaded gun on a shared machine).** A fixed
path like `/tmp/mpai-walk-hub.pid` left behind by an aborted earlier walk can name a PID the OS
has since recycled onto someone else's process, so `kill $(cat …)` would signal a stranger.
Two rules, both mandatory:

1. **Write only after clearing.** Before every `echo $! > <pidfile>` in this walk, run
   `rm -f <pidfile>` on that exact path (steps 1 and 8a). Ledger the three paths in use:
   `/tmp/mpai-walk-hub.pid`, `/tmp/mpai-walk-laptop.pid`, `/tmp/mpai-walk-solo.pid`.

   **Capture LOGS are different: they are owner-only and unpredictable, never fixed `/tmp` paths.**
   The stderr captures hold peer paths, session ids and driver names (Task 7b's capture-file
   handling note), so a world-readable `/tmp/mpai-walk-laptop.log` on a shared machine leaks them.
   At step 0, before anything is launched, run once and ledger the two printed paths:
   `umask 077 && LOGDIR=$(mktemp -d) && LAPTOP_LOG="$LOGDIR/laptop.log" && SOLO_LOG="$LOGDIR/solo.log" && echo "$LAPTOP_LOG" && echo "$SOLO_LOG"`
   — the same posture `HUB_DB=$(mktemp -d)/hub.db` already uses. Every reference to
   `$LAPTOP_LOG` / `$SOLO_LOG` below means those ledgered paths. Step 9 removes the whole
   directory.

   **`$LOGDIR` is RE-READ from the ledger, never re-derived — and its deletion is checked
   non-vacuously (cycle-2 round-3 fix).** The plan already warned that `$LOGDIR` may not survive
   into the shell running step 8a/9, but the only assurance the logs were gone was
   `test ! -d "$LOGDIR"`, which **exits 0 vacuously when the variable is empty or unset** — and
   `rm -rf "$LOGDIR"` is likewise a no-op in that case, so an unset variable read as a clean
   sweep while the capture logs sat on disk. Two binding rules:

   - **Before any step that references `$LOGDIR`** (11a's abort cleanup, 11b step 8a's FAIL
     branch, 11b step 9), set it by **pasting the absolute path ledgered at 11a step 0** —
     `LOGDIR=<the ledgered absolute path>` — not by re-running `mktemp -d`, which would mint an
     empty new directory and "clean" that instead.
   - **The cleanup command is this exact chain, and an unset or missing `$LOGDIR` is a FAIL, not
     a pass:**
     `test -n "$LOGDIR" && test -d "$LOGDIR" && rm -rf "$LOGDIR" && test ! -d "$LOGDIR"` → exits 0.
     A non-zero exit means the logs may still be on disk: re-read the ledgered path and re-run.
     (If the directory is legitimately already gone — a second cleanup pass on the same walk —
     ledger that, with the path, rather than recording a vacuous pass.)
2. **Verify identity before every `kill`.** Run
   `ps -p $(cat <pidfile>) -o command=` and confirm the output contains the expected entrypoint
   — `poc/hub/dist/main.js` for the hub pidfile, `poc/server/bin/mpai.js` for the laptop and
   solo pidfiles. If it does not match (or `ps` prints nothing), **do not kill**: ledger the
   mismatch and `rm -f` the stale file. This check is binding at steps 8a and 9. A mismatch is
   NOT by itself permission to proceed into the solo leg — step 8a's absence gate below decides
   that, because the walk's own hub/laptop may still be alive under a PID the file no longer
   names, which would make steps 8d/8e/8f non-discriminating.

**Steps (verbatim):**

0. **Port pre-flight + repo-root capture (before anything is launched).** From the repo root run
   `REPO_ROOT=$(git rev-parse --show-toplevel)` and ledger the printed value (`echo $REPO_ROOT`)
   — every later `node …/poc/server/bin/mpai.js` invocation in this walk uses `$REPO_ROOT`, and
   step 1 AND step 8a each run from a `mktemp -d` scratch repo where a relative path would
   resolve to nothing. **The variable must be exported into (or re-captured in) whatever shell
   runs step 1 AND whatever shell runs step 8a** — both legs launch from a scratch directory, not
   from the plan's repo. Capture the two log paths here too (the `umask 077 && LOGDIR=…` line in
   the PID/log-hygiene rules above) and ledger them. Then run
   `lsof -ti :4000; lsof -ti :3002`. PASS = BOTH commands print nothing (both ports free). A
   non-empty result means the port belongs to someone else on this shared machine: pick another
   free port, ledger the substitution, and use it for the rest of the walk — **never kill the
   occupant** (the process-hygiene rule above is binding here). Port 3001 is out of scope and is
   never probed or touched. (Ledgered; not a plan-level Done-criteria step.)
1. Build all three packages, in this order (hub and client build against the server's `dist/`):
   `npm --prefix poc/server run build && npm --prefix poc/hub run build && npm --prefix poc/client run build`.
   Clear any stale PID files first: `rm -f /tmp/mpai-walk-hub.pid /tmp/mpai-walk-laptop.pid
   /tmp/mpai-walk-solo.pid`. Launch the hub, recording its PID:
   `HUB_DB=$(mktemp -d)/hub.db CLIENT_DIST=poc/client/dist PORT=4000 node poc/hub/dist/main.js &
   echo $! > /tmp/mpai-walk-hub.pid`. Launch ONE laptop **from a scratch git repo** — the same
   form step 8a uses, verbatim, so the two legs are not launched differently — **with the
   digest dump enabled and stderr captured** (steps 5 and 8e read that file), recording its
   PID, invoking the CLI by `$REPO_ROOT` path (a relative path resolves to nothing from the
   scratch repo, and a global binary must not be assumed):
   `SCRATCH=$(mktemp -d) && cd "$SCRATCH" && git init && git commit --allow-empty -m init && MPAI_DIGEST_DUMP=1 node "$REPO_ROOT"/poc/server/bin/mpai.js --hub ws://127.0.0.1:4000/uplink --port 3002 --no-open 2> "$LAPTOP_LOG" & echo $! > /tmp/mpai-walk-laptop.pid`
   (NOT port 3001 — may be user-occupied). **The `git commit --allow-empty -m init` is not
   optional and is not cosmetic (cycle-2 round-3 fix):** a bare `git init` leaves an UNBORN HEAD —
   no commit and no branch ref — so there is no ref for Task 2a's `provision(projectId, slug,
   baseRef)` to branch a worktree from and no `baseRef` for Task 2b to bind, and steps 2 and 3
   (`test -f "$SCRATCH"/.mpai/worktrees/<projectId>/alpha/notes.txt`, `git -C …/beta status`)
   would be asserting on worktrees that were never created. **Ledger the resulting branch name**
   (`git -C "$SCRATCH" branch --show-current` → typically `main` or `master` depending on this
   machine's `init.defaultBranch`) so the `baseRef` Task 2b binds is a real ref that can be checked
   against step 2's assertion. Ledger `$SCRATCH`: steps 2 and 3 assert on worktrees
   under it. *(If `mpai` is already on
   PATH via `npm --prefix poc/server link`, `mpai …` is equivalent; ledger which form was used.)*
   Ledger both PIDs. PASS = both PIDs recorded, the hub answering on :4000 and the laptop on
   :3002. (Ledgered; not a plan-level Done-criteria step.)
2. Browser: open `http://127.0.0.1:3002`, join the project, create session `alpha`, drive one
   turn that writes the file `notes.txt` (prompt: `create notes.txt with one line`) — the file
   name is load-bearing, steps 4/5/6 and 8d/8e/8f all assert on `notes.txt` literally — and wait
   for turn end. **Assert the worktree state with a command, not by eye** (ledger `<projectId>`
   as shown in the UI, and use the worktree path fixed in Global Constraints):
   `test -f "$SCRATCH"/.mpai/worktrees/<projectId>/alpha/notes.txt` → exit 0.
   PASS = the turn ends, that `test -f` exits 0, and alpha is
   listed in the session list. (Ledgered; not a plan-level Done-criteria step. It is a
   PRECONDITION of the required-PASS steps 4 and 6 — a silently-wrong worktree here would make
   both non-discriminating, which is why it is pinned mechanically.)
3. Create session `beta` in the SAME repo, drive a turn editing the SAME file with the exact
   prompt `add a second line to notes.txt`. Assert with a command:
   `git -C "$SCRATCH"/.mpai/worktrees/<projectId>/beta status --porcelain -- notes.txt` → prints
   a NON-EMPTY line (the file is modified in beta's worktree). PASS = the turn ends and that
   command's output is non-empty. (Ledgered; not a plan-level Done-criteria step; same
   precondition role as step 2.)
4. PASS = after beta's turn ends: header badge `⚠ CONTESTED ▸ 1` in beta's session view; the
   project screen's repo group head shows the chip `⚠ 1 contested`; alpha's OTHER PARTIES row
   (from beta's view) shows `⚠ shares: notes.txt`. (Required PASS for plan-level done.)
5. Agent tier (a): drive one more beta turn asking the agent `what files are contested right
   now?`. **Pin the input with a runnable command, not just prose:** the laptop was launched at
   step 1 with `MPAI_DIGEST_DUMP=1` and stderr captured (Task 7b's dump), so run
   `command grep -n "\[digest-dump\] session=beta" "$LAPTOP_LOG" | tail -1` and paste
   that single line into the ledger verbatim; confirm it contains `notes.txt`. (If the file has
   no such line, the dump did not fire — that is a step-5 FAIL, ledger it as one.)
   **Consequence:** PASS = the digest contains `notes.txt` AND the agent's answer names it.
   FAIL is admissible ONLY with (a) the verbatim `digestFor` dump pasted into the ledger and
   (b) a follow-up entry filed in `docs/tech-debt.md`; a bare "FAIL recorded" does not satisfy
   the plan-level Done criteria.
6. Agent tier (b): **turn auto-approve ON in beta first, and confirm it is on before driving the
   turn.** Spelled out rather than assumed: take the wheel in beta, then set the permission mode
   to AUTO from the session header's permission-mode control — the underlying protocol action is
   `set_permission_mode` with `mode: "auto"` (validated at `poc/server/src/server.ts:1237-1238`;
   only the current driver may send it). **Observable that it is on before proceeding:** the
   transcript shows a `permission_mode_change` entry naming `auto` and the header's mode
   indicator reads AUTO. Leave `MPAI_CONTESTED_GATE` unset (default ON). Then drive a turn
   with the exact prompt `append a second line to notes.txt` — PASS = the gate ASKS (it does not
   auto-approve, proving the withdrawal fired at a real auto-mode decision site) **AND the reason
   text `contested with session alpha` is VISIBLE IN THE BROWSER, rendered on the permission-check
   card beside the "the agent wants to use … — not on the auto-approve list" line (Task 8c),
   observed verbatim and pasted into the ledger** — a reason present only in the server's frame,
   with nothing drawn on screen, is a step-6 FAIL. Approve it; then drive one more turn
   with the exact prompt `append a third line to notes.txt`, which auto-approves (once-per-file
   proven live). (Required PASS.)
7. Close alpha; PASS = collision persists and alpha shows CLOSED + contested (spec §2.6).
   (Required PASS.)

**Verify (11a):** ledger contains steps 0–7 each independently recorded, with steps 4, 6 and 7
PASS, step 6's gate-reason text `contested with session alpha` pasted verbatim **and recorded as
observed IN THE BROWSER**, and step 5's
`[digest-dump]` line pasted verbatim (PASS, or FAIL under the Done-criteria allowance). On a
normal (non-aborted) run the hub
and laptop processes are LEFT RUNNING for Task 11b, which stops them at its step 8a; their PID
files stay in place. **If this task ABORTS before 11b can run — at any step, for any reason —
cleanup is not optional and not deferred to a task that will never start:** run step 9's cleanup
here (identity-check with `ps -p $(cat <pidfile>) -o command=`, `kill` only on a match, then
`rm -f /tmp/mpai-walk-hub.pid /tmp/mpai-walk-laptop.pid /tmp/mpai-walk-solo.pid` and the guarded
log-directory chain — `LOGDIR=<ledgered absolute path from step 0>` then
`test -n "$LOGDIR" && test -d "$LOGDIR" && rm -rf "$LOGDIR" && test ! -d "$LOGDIR"` → exit 0,
per the PID/log-hygiene rules; a bare `rm -rf "$LOGDIR"` on an unset variable is a silent no-op),
ledger that it ran with the path it ran on, and ledger the walk BLOCKED.
**Commit:** none.

---

## Task 11b: browser walk — solo parity leg, steps 8a–8f + shutdown *(verification only, no
source changes; spec §9 "solo-mode parity leg")*

**Files:** none. Unlike 11a there is no `docs/tech-debt.md` exception: step 8e is a required PASS
with no FAIL-with-evidence allowance (Done criteria), so this task writes nothing at all.

**Depends on Task 11a** — it inherits 11a's process-hygiene and PID-file-hygiene rules verbatim
(never `pkill`, identity-check before every `kill`, write a PID file only after `rm -f`), reads
`$REPO_ROOT` as captured in 11a step 0, and begins by stopping the processes 11a left running.
Each lettered sub-step is INDEPENDENTLY ledgered, exactly as in 11a.

**Steps (verbatim, numbering continued from 11a):**

8. **Solo parity leg — fresh everything** (the hub-mode repo already holds `alpha`/`beta`, so
   the solo leg uses a FRESH scratch repo and FRESH session names `gamma` / `delta`):
   - **8a.** Stop the hub by recorded PID only, **identity-checked first**:
     `ps -p $(cat /tmp/mpai-walk-hub.pid) -o command=` must contain `poc/hub/dist/main.js` →
     then `kill $(cat /tmp/mpai-walk-hub.pid)`. Stop the laptop the same way, its check
     requiring `poc/server/bin/mpai.js`. On a mismatch, do NOT kill: ledger it and `rm -f` the
     stale file — then the absence gate below decides whether the solo leg may run at all.
     **Absence gate (binding, run BEFORE launching solo — the solo leg's whole claim is "no hub
     running", so it must be checked independently of the PID files):** `lsof -ti :4000` prints
     NOTHING and `lsof -ti :3002` prints NOTHING (substitute the ports ledgered at 11a step 0 if
     they were substituted). If either prints anything, **record step 8a FAIL and STOP the solo
     leg** — do not kill the occupant, do not launch solo on top of it, and do not record
     8d/8e/8f at all: with a live hub or laptop still serving, those steps cannot discriminate
     local derivation from hub-sourced state.
     **On that FAIL branch, cleanup is UNCONDITIONAL and happens before stopping — the abort must
     not leave this walk's own artifacts behind:** run step 9's cleanup now — identity-check
     (`ps -p $(cat <pidfile>) -o command=`) and `kill` **only** PIDs this walk recorded and only on
     a match, then `rm -f /tmp/mpai-walk-hub.pid /tmp/mpai-walk-laptop.pid
     /tmp/mpai-walk-solo.pid` and the guarded log-directory chain — `LOGDIR=<the absolute path
     ledgered at 11a step 0, pasted, not re-derived>` then
     `test -n "$LOGDIR" && test -d "$LOGDIR" && rm -rf "$LOGDIR" && test ! -d "$LOGDIR"` → exit 0
     (the capture logs hold peer paths, session ids and driver names; an unset `$LOGDIR` makes a
     bare `rm -rf` a no-op and a bare `test ! -d` a vacuous pass — see the hygiene rules). **Then EXIT the abort state properly, because it is not a done state:**
     ledger the walk **BLOCKED**, identify the occupant with
     `lsof -ti :<port> | xargs ps -p -o command=`, and have the **OPERATOR** free the port (never
     the executor — the process-hygiene rule is binding); once free, re-run the solo leg from 8a.
     Only once both ports are empty:
     `rm -f /tmp/mpai-walk-solo.pid`, create a fresh scratch git repo **with an initial commit —
     same reason and same form as 11a step 1, a bare `git init` leaves an unborn HEAD with no ref
     to provision a worktree from** (cycle-2 round-3 fix):
     `SOLO_SCRATCH=$(mktemp -d) && cd "$SOLO_SCRATCH" && git init && git commit --allow-empty -m init`
     — ledger the resulting branch name (`git -C "$SOLO_SCRATCH" branch --show-current`) —
     and launch solo from it, same invocation form as 11a step 1 (dump enabled, stderr captured
     to a FRESH log — `$SOLO_LOG`, not `$LAPTOP_LOG` — so step 8e cannot read step 5's lines),
     using the `$REPO_ROOT` captured at
     11a step 0 — the scratch repo is not the plan's repo, so a relative path would resolve to
     nothing:
     `MPAI_DIGEST_DUMP=1 node "$REPO_ROOT"/poc/server/bin/mpai.js --port 3002 --no-open 2> "$SOLO_LOG" & echo $! > /tmp/mpai-walk-solo.pid`.
     Ledger `$SOLO_SCRATCH`: steps 8b and 8c assert on worktrees under it. PASS = both old PIDs
     gone (identity-checked before each kill), the absence gate empty on both ports, and the solo
     laptop — the newly recorded PID and no other process — serving on 3002.
   - **8b.** Open `http://127.0.0.1:3002`, join the project, create session `gamma`, drive one
     turn with the exact prompt `create notes.txt with one line` (byte-identical to 11a step 2).
     Assert with a command, as 11a step 2 does (ledger `<projectId>` as shown in the UI):
     `test -f "$SOLO_SCRATCH"/.mpai/worktrees/<projectId>/gamma/notes.txt` → exit 0.
     PASS = turn ends, that `test -f` exits 0, session listed. (Precondition of the required-PASS
     steps 8d/8f — pinned mechanically for the same reason 11a step 2 is.)
   - **8c.** Create session `delta` in the SAME fresh repo, drive a turn with the exact prompt
     `add a second line to notes.txt` (byte-identical to 11a step 3). Assert with a command:
     `git -C "$SOLO_SCRATCH"/.mpai/worktrees/<projectId>/delta status --porcelain -- notes.txt` →
     prints a NON-EMPTY line. PASS = turn ends and that output is non-empty.
   - **8d.** UI parity (solo repeat of step 4): PASS = badge `⚠ CONTESTED ▸ 1` in delta's view,
     repo-group chip `⚠ 1 contested`, gamma's OTHER PARTIES row shows `⚠ shares: notes.txt` — all from
     LOCAL derivation, with no hub running. (Required PASS.)
   - **8e.** Tier (a) parity (solo repeat of step 5), same runnable capture:
     `command grep -n "\[digest-dump\] session=delta" "$SOLO_LOG" | tail -1` → the
     line is pasted into the ledger verbatim and contains `notes.txt`. (Required PASS.)
   - **8f.** Tier (b) parity (solo repeat of step 6), same exact prompts and the same
     **auto-approve activation, spelled out identically**: take the wheel in delta, set the
     permission mode to AUTO from the session header's permission-mode control (protocol action
     `set_permission_mode` with `mode: "auto"`, validated at `poc/server/src/server.ts:1237-1238`,
     driver-only), and confirm it is on before driving — the transcript shows a
     `permission_mode_change` naming `auto` and the header's mode indicator reads AUTO;
     `MPAI_CONTESTED_GATE` stays unset. Then drive a turn with
     `append a second line to notes.txt` — PASS = the gate ASKS and the reason text
     `contested with session gamma` is VISIBLE IN THE BROWSER on the permission-check card
     (Task 8c), observed verbatim and pasted into the ledger, proving local derivation alone names
     the colliding session; approve it, then drive `append a third line to notes.txt`, which
     auto-approves. (Required PASS.)
9. Shutdown, identity-checked exactly as at 8a:
   `ps -p $(cat /tmp/mpai-walk-solo.pid) -o command=` must contain `poc/server/bin/mpai.js` →
   then `kill $(cat /tmp/mpai-walk-solo.pid)`; on a mismatch do not kill, ledger and `rm -f`.
   Then `rm -f /tmp/mpai-walk-hub.pid /tmp/mpai-walk-laptop.pid /tmp/mpai-walk-solo.pid` so the
   next walk cannot inherit these paths. **Then delete the capture logs, once their evidence
   lines are already pasted into the ledger (steps 5 and 8e).** Set `LOGDIR` by pasting the
   absolute path ledgered at 11a step 0 (never re-derive it with `mktemp -d`), then run the
   guarded chain:
   `test -n "$LOGDIR" && test -d "$LOGDIR" && rm -rf "$LOGDIR" && test ! -d "$LOGDIR"` → **exits
   0** (removes both `$LAPTOP_LOG` and `$SOLO_LOG` and the owner-only directory holding them). A
   non-zero exit means the logs may still be on disk — re-read the ledgered path and re-run; do
   not record the sweep. They hold peer paths,
   session ids and driver names on a machine this plan repeatedly calls shared
   (Task 7b's capture-file handling note), so leaving them behind is the same class of hazard as
   a stale PID file. Sweep = `lsof -ti :4000; lsof -ti :3002`
   both return EMPTY — meaningful only because step 0 established that both were empty to begin
   with (or ledgered the substituted ports, which are the ones swept here). Port 3001 is out of
   scope (may be user-occupied) and is never touched.

**Verify (11b):** ledger contains steps 8a–8f and 9 each independently recorded, with 8d, 8e and
8f PASS, step 8f's gate-reason text `contested with session gamma` pasted verbatim **and recorded
as observed IN THE BROWSER**, step 8e's
`[digest-dump]` line pasted verbatim, and step 9's sweep showing both ports empty, all three
PID files removed and `$LOGDIR` gone — the last one recorded as the **guarded** chain's exit 0,
`test -n "$LOGDIR" && test -d "$LOGDIR" && rm -rf "$LOGDIR" && test ! -d "$LOGDIR"`, run against
the absolute path re-read from 11a step 0's ledger entry (a bare `test ! -d "$LOGDIR"` exits 0
whenever the variable is empty, so on its own it is not evidence the logs were deleted; the
ledger records the path the chain ran on, not just the exit status). Together with 11a's record
this is the "both-mode" walk evidence the plan-level Done criteria require.
**Commit:** none.

---

## Task 12: docs sweep *(spec §8 non-goal 1; PRD §8.8)*

**Files:** modify `docs/PRD.md` (§8.8 Today), `docs/tech-debt.md` (§2.1).

**Pre-condition (Task 11a overlap).** If Task 11a's step 5 recorded a FAIL, a follow-up entry for
it is ALREADY in `docs/tech-debt.md` when this task starts — leave it in place, do not fold it
into §2.1, and do not treat it as an unexpected diff. It is a new OPEN entry, so it adds no
`RESOLVED` occurrence and the count expectation below (exactly **2**) is unaffected either way.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| PRD §8.8 Today | current text | rewritten: collisions shipped (touched facts, collisionsFrom, badge/chip/rows, agent digest + auto-approve withdrawal, on by default, advisory only), naming the `MPAI_CONTESTED_GATE=0` kill switch that restores today's auto-approve path; "oversight configured hub-side" EXPLICITLY still open (split ruling, spec §8a.1); fork bound restated |
| tech-debt §2.1 | current entry | marked RESOLVED (project-scoped provisioning, this branch) following the file's existing resolved-entry style (see §2.3's heading suffix); one sentence disclosing the unmigrated old flat worktree scheme |

**Verify** (each check discriminating — the file already contained one `RESOLVED` before this
task, so a bare presence grep proves nothing):

**Slice §8.8 FIRST, then grep the slice** — a whole-file presence grep for a common word
("advisory", "repoKey", "fork") passes on text that already exists elsewhere in `docs/PRD.md` and
so proves nothing about §8.8 having been edited. Run once:

```
awk '/^### 8\.8/,/^### 8\.9/' docs/PRD.md > /tmp/prd-8-8.txt
test -s /tmp/prd-8-8.txt          # the slice is non-empty, i.e. the section markers matched
```

then, against the SLICE (each prints a count; each expectation is a number, not a judgement):

- `command grep -c "oversight configured hub-side" /tmp/prd-8-8.txt` → **≥ 1** (split ruling,
  spec §8a.1, still open — stated inside §8.8).
- `command grep -c "MPAI_CONTESTED_GATE" /tmp/prd-8-8.txt` → **≥ 1** (kill switch disclosed).
- `command grep -c "advisory" /tmp/prd-8-8.txt` → **≥ 1** (advisory-only bound restated).
- `command grep -c "repoKey" /tmp/prd-8-8.txt` → **≥ 1** and
  `command grep -c "fork" /tmp/prd-8-8.txt` → **≥ 1** (the fork bound restated; both words, each
  with its own count — the previous `repoKey\|fork` alternation could pass on either alone).
- `rm -f /tmp/prd-8-8.txt` when done.
- `command grep -n "^### 2.1.*RESOLVED" docs/tech-debt.md` → exactly 1 hit, AND
  `command grep -c "RESOLVED" docs/tech-debt.md` → **2** (was 1 before this task).
- `git diff --stat docs/` touches only the two files.

**Commit:** `docs: PRD §8.8 Today (collisions shipped) + debt §2.1 resolved`

---

## Round-1 residuals

None. All 33 council violations from round 1 are closed in this revision (see
`.soltero/plan-fix-round1-report.md` for the per-violation mapping). Two items were closed by
owner ruling rather than mechanically, and are recorded here because they changed the spec of
record: the `contested` down-frame now carries `collisions` (spec §8a ruling 6) and tier (b)
gains the `MPAI_CONTESTED_GATE` kill switch (spec §8a ruling 4).

## Round-2 residuals

None. All 27 council violations from round 2 (2 blocking + 25 minor) are closed in this
revision (per-violation mapping: `.soltero/plan-fix-round2-report.md`). Three closures are
**plan-authored rulings the owner may override** rather than mechanical edits, and are flagged
here because a reviewer should see them as decisions, not drift:

1. **Over-long paths (D6/V23).** `touchedFiles` DROPS paths > 512 chars (Global Constraints +
   Task 1/Task 3 rows). Truncating or raising the wire cap were the alternatives; dropping is
   the only option that never emits a rejectable frame and never invents a false path.
   **Cost restated in full (cycle-2 round-2):** a dropped path is a silent exemption from banked
   decision 1 (spec §2.1) — if both sessions diverge on a > 512-char path, that collision never
   raises a badge, chip, party row, digest line or gate, and nothing is logged. Stated at the
   declaration site in Global Constraints so the override decision is made against the real cost.
2. **Frame-bound harmonization (D3/V9).** ~~Task 6 (now 6a) states the `paths` bound as a plan-authored
   harmonization…~~ **Superseded in round 3:** the caveat is withdrawn. Spec §3.1's "capped at
   `TOUCH_CAP`" already means "≤ TOUCH_CAP paths plus the sentinel slot" (§3.3 spells it as
   `≤ TOUCH_CAP + 1`), so §6a's identical phrase carries the identical bound. No additional
   ruling is needed and there is no plan/spec divergence to reconcile. (Spec §8a ruling 7 exists
   and rules on a different subject — old-scheme worktree orphaning.) See Task 6a's note.
3. **Walk discrimination (D6/V25).** Task 11a steps 1–7 are relabelled "hub attached, derivation
   source not discriminated" instead of adding a second laptop; Task 6b's hub suite carries the
   end-to-end down-frame evidence. Adding a second laptop remains an owner option.

## Round-3 residuals — RULED (spec §8a.7, §8a.8)

Both round-3 escalations are CLOSED by the spec of record. Nothing here gates execution: no task
withholds PR text, and Tasks 1, 2a and 4 are reviewed as settled. Kept only as a record of the
two rulings and where they bind.

1. **Old-scheme worktrees orphaned on restart — RULED by spec §8a.7:** "pre-branch flat-scheme
   sessions do NOT survive a daemon restart … Accepted POC breakage; PR discloses; no legacy
   compat path." Binds Task 2a: no legacy-key compat read, no migration, and the PR disclosure is
   mandatory.
2. **Synchronous `touchedFiles` freezes the whole laptop process — RULED by spec §8a.8:** "a
   worst-case whole-daemon freeze of 5s at a turn boundary/gate is ACCEPTED … revisit only on an
   observed freeze." Binds Tasks 1 and 4: the timeout stays exactly 5000 ms and the call stays
   synchronous.

## Cycle-2 round-2 residuals

**None.** All 24 council violations from cycle 2 round 2 (3 blocking + 21 minor) are closed in
this revision (per-violation mapping: `.soltero/plan-fix-c2r2-report.md`). No item was escalated:
nothing in this round turned out to be a product fork. Four closures are **plan-authored rulings
the owner may override** rather than purely mechanical edits, and are registered below with the
rest: the gate-reason CARRIER (D3 blocking), the `DriverHooks` carrier for contested state
(D4 blocking), the 512-char gate-reason cap, and the restated cost of the over-long-path drop.

The conflict matrix was **regenerated from a single serial-order list and re-verified
mechanically** after this round's two structural changes (Task 6 → 6a/6b; new client Task 8c):
18 implementing rows, each listing exactly the other 17, symmetric in both directions, no
self-reference, no unknown label — see the note under the Task Dependency Table.

### Plan-authored decisions (closed here; owner may override)

These are recorded, not escalated — each is a decision the plan makes explicitly so no reviewer
reads it as drift:

- **`COLLISIONS_MODULE_ID` (Task 5).** Not in spec §4's surface; exists only as Task 9a's
  minification-stable bundle anchor. Droppable in favour of the node smoke check alone.
- **`workdir`/`baseRef` as `ProjectSessionEntry` fields (Task 2b).** Spec §3.1/§3.2 require the
  inputs; storing them on the session entry rather than re-deriving is this plan's choice.
- **No protocol bump for the new `contested` frame type (Task 6a).** Spec §3.3 grants the
  no-bump exemption to an additive optional FIELD; applying it to a wholly new down-frame type is
  this plan's reading, justified by the unknown-frame ignore path (Task 6a's compat row: an old
  laptop ignores the frame and is not disconnected). If the owner wants `RELAY_PROTOCOL_VERSION`
  bumped for a new frame type, say so and Task 6a bumps it.
- **`MPAI_DIGEST_DUMP` (Task 7b).** An env-gated stderr dump added so Task 11a step 5 and Task 11b step 8e
  cite a runnable capture command instead of a mechanism that did not exist. Off by default;
  laptop-local; no cross-session exposure. The alternative the council offered — replacing the
  walk's ledger evidence with a server-suite assertion — was rejected because it would stop
  pinning the LIVE turn's digest, which is the whole point of step 5.
- **`collisions` inbound bounds (Task 6a).** `collisions` ≤ `TOUCH_CAP + 1`, `sessionIds`
  non-empty, **≤ 100 ids per entry** — spec fixes the shape, not the bounds; the number follows
  `relayProtocol.ts`'s existing `MAX_REPOS = 100` posture. **Narrowed in cycle-2 round-3:** the
  per-id `≤ 128 chars` bound is WITHDRAWN and replaced by the existing `SLUG` regex, so the only
  plan-authored bound left on this field is the ≤ 100 count. Peer ids are no longer a
  plan-authored bound at all — they reuse `poc/server/src/project.ts:11`.
- **§6a `paths` bound read as `TOUCH_CAP + 1` (Task 6a).** Consistent reading of §3.1/§3.3; if
  the owner reads §6a as a flat 500 including the sentinel, Task 6a drops to `TOUCH_CAP − 1`
  paths + sentinel and Task 3's facts bound is unaffected.
- **Client wiring shape (Tasks 9a / 9b / 10a / 10b).** `projectCollisions` takes the client's own
  snapshot row type `ProjectSessionInfo[]` (Task 9a adds the mirrored `touched?: string[] | null`
  field to `poc/client/src/types.ts`); 9b and 10b each compute collisions inside their component
  from data they already hold, and only 10a touches `App.tsx`, passing `Header` one new OPTIONAL
  `contested?: Collision[]` prop. The alternative — one App-level computation fanned out as
  required props to all three components — would put `App.tsx` in three tasks' file lists. The
  App-level `useMemo` is stated as a diff requirement; its EFFECT is deliberately not
  test-asserted (no App-level test file exists and this plan does not add one), but its PRESENCE
  is now checked mechanically by Task 10a's Verify (`command grep -c … → exactly 1`), so no stated
  requirement in this plan is left without an objective check. Task 8c is the fourth client
  writer; it depends on 8a/8b rather than 9a and computes no collisions.
- **Digest 5-path cap vs party-row 3-path cap (Tasks 7b / 10b).** Different counts on purpose,
  shared ` +N more` phrasing and `", "` separator; spec sets neither cap.
- **Gate-reason CARRIER: the `permission_request` EVENT, not facts alone (Tasks 8a / 8c).** The
  council's D3 blocking finding required an owner choice between the `permission_request` event
  (`poc/server/src/events.ts:24`) and `SessionFacts.pendingGate` (`relayProtocol.ts:33`). Decided
  here in favour of the EVENT, because `poc/client/src/components/Transcript.tsx:125` — the only
  place a gate is drawn — renders from `props.events` and has no `pendingGate` in scope, and
  because `pendingGateOf` already derives `PendingGate` from that same event, so one field feeds
  both surfaces with no second writer. The facts-side mirror is added too (client
  `ProjectSessionInfo.pendingGate.reason`) so the types do not drift, but nothing renders from it
  today. Owner alternative: facts-only, at the cost of a new `Transcript` prop and an `App.tsx`
  edit in Task 8c.
- **`DriverHooks` carrier for contested state (Task 8b).** `Project` is not in scope in
  `agentDriver.ts` or `permissions.ts`, so the three auto-approval decision sites reach the
  contested set through four optional `DriverHooks` callbacks (`getContested`, `contestedAsked`,
  `contestedSessions`, `onContestedAnswered`), supplied at `server.ts:445`. Modelled on the
  existing `getOversight?: () => string` hook (`agentDriver.ts:78-80`), not invented. Owner
  alternatives: pass a single pre-computed predicate result, or move the decision entirely into
  `server.ts` — both would change more call sites than this does.
- **512-char gate-reason cap (Task 8a).** A SEPARATE bound from `PATH_WIRE_CAP` that deliberately
  shares its number; it stays an inline literal in `pendingGate.ts`/`relayProtocol.ts` because no
  other task consumes it. Registered here because this register presents itself as the complete
  list of decisions the plan makes beyond the spec, and the cap was previously stated only in
  Task 8a's validator row.
- **Kill switch ships inside Task 8b, not as its own task (Task 8b).** The council offered a
  8b/8c split. Rejected for one stated reason, now in the task's own purpose paragraph: the
  withdrawal must never exist in a state where it is live and undisableable. (The label `8c` is
  used instead for the client render task.)
- **Over-long paths dropped producer-side; walk discrimination label** — carried forward from
  the round-2 residuals above, with the round-2 bullet now stating the banked-decision-1 cost in
  full.

### Plan-authored decisions ADDED in cycle-2 round-3 (this register stays complete)

- **`recomputeTouched` as a fifth `DriverHooks` callback (Task 4).** Spec §3.2 requires a pre-gate
  recompute but names no mechanism. `Project` is not in scope in `agentDriver.ts` or
  `permissions.ts`, so the trigger reaches the three decision sites as
  `recomputeTouched?: () => void`, supplied at `server.ts:445` — modelled on the existing
  `getOversight?: () => string` (`agentDriver.ts:78-80`) and identical in shape to Task 8b's four
  contested hooks. Owner alternatives: move the whole gate decision into `server.ts`, or accept
  turn-boundary-only freshness and delete the pre-gate requirement (that second one is a spec
  change, since §3.2 is an owner ruling).
- **Recompute at decision site 2 (`setPermissionMode` → `allowAllPending`) as well as sites 1 and
  3 (Task 4).** The council's prescription named two sites; the plan calls it at all three so the
  per-site statement in Task 8b's table ("the just-executed decision-site recompute") is uniformly
  true and no site silently judges a staler set than its neighbours. It is one extra recompute per
  AUTO switch that has write requests pending, never one per pending request. Owner may drop it
  and mark site 2 "judges the set current when the batch was queued".
- **The over-long-path drop is LOGGED (Task 1, Global Constraints).** One stderr line per call
  that dropped anything, carrying a COUNT and the workdir, never the path. Plan-authored: the spec
  has no producer-side drop rule at all, so it has no log rule either. This exists to make the
  banked-decision-1 exemption attributable while proposed §8a ruling 9 is with the owner.
- **`provision` THROWS on a non-SLUG `projectId`, validated inside the function (Task 2a).** The
  spec requires project scoping, not a validation posture. Throwing (rather than sanitising or
  falling back) and guarding inside `provision` (rather than at each `server.ts` call site) are
  this plan's choices; the regex itself is the existing `SLUG` at `poc/server/src/project.ts:11`,
  not a new bound.
- **Session-row marker literal aligned to the spec (Task 9b) — this is a WITHDRAWAL, not a new
  decision.** The plan previously pinned `⚠ contested`; spec §5's per-session marker literal is
  bare `contested`. The spec governs, the glyph is dropped, and no plan-authored decision is
  created — recorded here only so the change is visible to a reviewer who read the earlier
  revision.

## Cycle-2 round-3 residuals

**None.** All 24 council violations from cycle 2 round 3 (2 blocking + 22 minor) are closed in
this revision (per-violation mapping: `.soltero/plan-fix-final-report.md`). Both blocking
violations were one root cause — the pre-gate recompute was pinned to the `permission_request`
event subscriber while decision site 3 (`permissions.ts:141`) runs before any such event
exists — and are closed together by moving the recompute onto the decision sites (Task 4) and
stating, per site, which recompute has run at that point (Task 8b's site table). The turn-boundary
recompute is unchanged.

Two D3 minors (the over-long-path drop narrowing LOCKED banked decision 1) were graded
`owner-decision`. They are closed here on the most conservative reading available to a docs-only
pass — the behavior is unchanged (drop, never truncate, never raise the cap, so no frame becomes
rejectable and no false path is invented) and the plan's own stated objection, that the exemption
is *silent*, is removed mechanically by the new log line. The ruling itself is filed for the owner
as proposed spec §8a ruling 9; see `## Final-pass notes`. Execution is not gated on it.

The conflict matrix was **re-verified mechanically again** after this round's re-ordering
(7a ahead of 6b) and Depends-on/Files widenings: still 18 implementing rows, each listing exactly
the other 17, symmetric in both directions, no self-reference, no unknown label, and every
Depends-on cell satisfied by the serial order — see the note under the Task Dependency Table.

## Final-pass notes

This was the final revision pass; no further review round follows. Two notes for the controller
and the owner:

1. **Proposed spec §8a ruling 9 — over-long paths (FILED, NOT BLOCKING).** The producer-side rule
   "`touchedFiles` DROPS any path longer than `PATH_WIRE_CAP` (512 chars)" narrows LOCKED banked
   decision 1 (spec §2.1) for that class of paths: if two sessions both diverge on a >512-char
   path, the collision is invisible to `collisionsFrom` — no badge, chip, party row, digest line
   or gate. Every other spec-level conflict on this branch was escalated and ruled (§8a rulings
   4–8), so this one is put to the owner in the same form: **(a) rule the drop into the spec,
   formally narrowing banked decision 1 to paths ≤ `PATH_WIRE_CAP`; (b) raise `PATH_WIRE_CAP` in
   spec §3.3 so the class stays detectable; or (c) truncate instead** (rejected on the merits
   here — a truncated path is a different path and would false-collide). Worth stating in the
   escalation: spec §3.3's own "each ≤ 512 chars" validator bound already makes such a path
   untransportable, so the tension originates in the spec, not in this plan. **Meanwhile the plan
   executes on (a)'s behavior with the exemption LOGGED** (Task 1's new
   `[touched] dropped ${n} path(s) over ${PATH_WIRE_CAP} chars in ${workdir}` line), which is the
   most conservative reading: it changes no behavior a later ruling would have to undo, and it
   converts an undetectable exemption into an attributable one. If the owner picks (b), two
   behavior rows and one constant change (Task 1's over-long-path row, Task 3's
   producer-never-emits-a-rejectable-path row, `PATH_WIRE_CAP`); if the owner picks (a), nothing
   changes.
2. **One interpretation the controller should see.** The controller's pre-gate prescription named
   two recompute call sites (`buildCanUseTool`'s write-tool path, and the top of `agentDriver`'s
   auto-mode permission path) and separately required Task 8b's site table to state, per site,
   which recompute has run — "all three now: the just-executed decision-site recompute". Those two
   sentences are only simultaneously satisfiable if decision site 2
   (`setPermissionMode` → `allowAllPending`, `agentDriver.ts:531`) also gets a call, because a
   request queued earlier and released by a later AUTO switch would otherwise be judged against
   the set that was current when it was queued. **Resolved conservatively: Task 4 pins three call
   sites, not two**, with site 2's call made once per batch and only when a pending request is a
   write tool. This adds freshness, never removes it; if the owner prefers the literal two-site
   reading, delete Task 4's site-2 row and change Task 8b's site-2 cell to "judges the set current
   when the batch was queued". Registered above with the other plan-authored decisions.
