# Awareness — Collisions (PRD §8.8 first half) Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd. The Task Dependency Table is the
> scheduling and review-depth contract. Spec of record:
> `docs/specs/2026-07-30-awareness-collisions-design.md` (its §8a rulings 1–6 and §2 banked
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
`cd poc/hub && npx vitest run` (pretest builds server) · `cd poc/client && npx vitest run`
(pretest builds server). Typecheck: server/hub `npx tsc --noEmit`; client **`npx tsc -b`**.

## Global Constraints

- Rebuild `poc/server` (`npm --prefix poc/server run build`) after changing anything it
  exports — hub and client typecheck/bundle against its built `dist/`. **Carve-out:** Task 5
  deliberately does NOT build (see its Verify and the Conflicts rationale below); whichever
  task runs next publishes `dist/collisions.js` as part of its own `npm run build` — every
  server/hub task after 5 builds, and so does every client task (its `pretest` builds
  `../server`). Since no two of those tasks may be in flight together (all of 1–10 are one
  exclusion group), the publish is never concurrent with a consumer's read.
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
  - `TOUCH_CAP = 500`; truncation sentinel literal `"…"` (single U+2026 char); per-path wire
    cap 512 chars. **Canonical home:** both constants are DECLARED in
    `poc/server/src/collisions.ts` (Task 5 — the isomorphic module) and re-exported unchanged
    from `poc/server/src/touched.ts` (Task 1), so the isomorphic module never imports the
    node-only one and no consumer sees two copies of the literal.
  - **producer-side per-path rule (plan-authored; spec §3.1/§3.3 set the wire cap but no
    producer rule — resolved here so the two do not contradict):** `touchedFiles` DROPS any
    path longer than the 512-char wire cap before the cap/sentinel step. A single pathological
    path therefore costs that path, never the session's whole facts frame (Task 3's validator
    rejects the entire frame on one over-long path). Truncating instead was rejected: a
    truncated path is a *different* path and would false-collide. Owner may override.
  - facts field `touched: string[] | null`.
  - down-frame (spec §8a ruling 6, amends §6a):
    `{ type: "contested", sessionId: string, paths: string[], collisions: { path: string; sessionIds: string[] }[] }`
    — `paths` bound identically to `facts.touched`: length ≤ `TOUCH_CAP + 1`, each ≤ 512 chars.
  - header badge label `⚠ CONTESTED ▸ ${n}`; session-list repo-group chip label
    `⚠ ${n} contested`. In BOTH literals `n` is a **count**, never a path list — for the badge,
    the distinct contested paths involving this session; for the chip, the distinct contested
    paths in that repo group.
  - gate reason line `contested with session ${otherSessionId}`.
  - calm CSS class literal `contested-calm` (chip, session-row marker, header badge — amber
    tokens at `poc/client/src/terminal.css:37-39` stay reserved for gates).
  - worktree path `<repoRoot>/.mpai/worktrees/<projectId>/<slug>`; worktree branch
    `mpai/<projectId>/<slug>`; **internal WorkspaceManager map key literal `${projectId}/${slug}`**.
  - collisions module identity literal `COLLISIONS_MODULE_ID = "collisionsFrom/v1"` (exported
    from `collisions.ts`, and used at runtime in its input-guard message so minification
    cannot erase it — this is the client bundle-check anchor, Task 9a).
  - kill switch (spec §8a ruling 4): env `MPAI_CONTESTED_GATE`; the exact value `"0"` disables
    tier (b) entirely (auto-approve behaves exactly as today); any other value or unset = ON
    (banked decision 5, on by default). Tier (a) digest/UI surfaces are unaffected by it.
  - gate reason carrier: `PendingGate.reason: string | null` (`poc/server/src/pendingGate.ts`).
  - once-per-(file, session) bookkeeping: `ProjectSessionEntry.contestedAsked: Set<string>`
    (repo-relative paths).
  - per-session recompute inputs: `ProjectSessionEntry.workdir: string | undefined`,
    `ProjectSessionEntry.baseRef: string | null`.
- `poc/server/src/collisions.ts` must be **isomorphic pure ESM** — no `node:` imports, no
  filesystem/process access — the client imports it at RUNTIME (unlike `record`'s type-only
  imports). Task 9a's Verify includes a bundle check.
- **Done criteria (plan-level):** every per-task Verify passed; on the final tree all three
  suites + typechecks green; Task 11's walk record in the execution ledger with steps 4, 6, 7
  and the solo leg 8d/8e/8f recorded **PASS**, and step 5 (agent tier (a)) recorded either
  PASS or FAIL — a FAIL is admissible only with the verbatim `digestFor` dump for that turn in
  the ledger AND a follow-up filed in `docs/tech-debt.md`. A bare "recorded" is not done.

## Task Dependency Table

| Task | Files touched | Depends on | Conflicts with (no concurrency) | Risk tier |
|------|---------------|------------|---------------------------------|-----------|
| 1. touchedFiles module | `poc/server/src/touched.ts`, `poc/server/test/touched.test.ts` | 5 | 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10 | standard |
| 2a. project-scoped worktrees (§2.1) | `poc/server/src/workspace.ts`, `poc/server/src/server.ts` (provision call sites), `poc/server/test/workspace.test.ts` | — | 1, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10 | judgment |
| 2b. session `workdir`/`baseRef` binding | `poc/server/src/project.ts`, `poc/server/src/server.ts` (session-creation paths), `poc/server/test/project.test.ts` | 2a | 1, 2a, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10 | judgment |
| 3. facts field `touched` | `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`, `poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` | — | 1, 2a, 2b, 4, 5, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10 | standard |
| 4. laptop recompute triggers | `poc/server/src/server.ts`, `poc/server/test/serverTouched.test.ts` | 1, 2b, 3 | 1, 2a, 2b, 3, 5, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10 | judgment |
| 5. collisionsFrom module | `poc/server/src/collisions.ts`, `poc/server/test/collisions.test.ts`, `poc/server/package.json` | — | 1, 2a, 2b, 3, 4, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10 | standard |
| 6. hub contested down-frame | `poc/hub/src/hub.ts`, `poc/server/src/relayProtocol.ts`, `poc/hub/test/contested.test.ts`, `poc/hub/test/hubRestart.test.ts`, `poc/server/test/relayProtocol.test.ts` | 3, 5 | 1, 2a, 2b, 3, 4, 5, 7a, 7b, 8a, 8b, 9a, 9b, 10 | judgment |
| 7a. laptop contested storage + local derivation | `poc/server/src/server.ts`, `poc/server/src/project.ts` (`contestedFrame`), `poc/server/test/serverContested.test.ts`, `poc/server/test/project.test.ts` | 4, 5, 6 | 1, 2a, 2b, 3, 4, 5, 6, 7b, 8a, 8b, 9a, 9b, 10 | judgment |
| 7b. digest tier (a) lines | `poc/server/src/digest.ts`, `poc/server/test/digest.test.ts` | 7a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 8a, 8b, 9a, 9b, 10 | standard |
| 8a. gate reason carrier | `poc/server/src/pendingGate.ts`, `poc/server/src/relayProtocol.ts`, `poc/server/test/pendingGate.test.ts`, `poc/server/test/relayProtocol.test.ts` | — | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8b, 9a, 9b, 10 | standard |
| 8b. auto-approve withdrawal | `poc/server/src/permissions.ts`, `poc/server/src/server.ts`, `poc/server/src/project.ts`, `poc/server/test/permissions.test.ts`, `poc/server/test/serverGateContested.test.ts` | 4, 7a, 8a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 9a, 9b, 10 | judgment |
| 9a. collisionView adapter | `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts` | 3, 5 | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8b | standard |
| 9b. client: session-list surfaces | `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/components/SessionPicker.test.tsx`, `poc/client/src/terminal.css` | 9a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 10 | standard |
| 10. client: badge + party rows | `poc/client/src/components/Header.tsx`, `poc/client/src/components/PartyPane.tsx`, `poc/client/src/App.tsx`, `poc/client/src/terminal.css`, `poc/client/src/components/Header.test.tsx`, `poc/client/src/components/PartyPane.test.tsx` | 5, 9a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9b | standard |
| 11. two-session browser walk | ledger record; `docs/tech-debt.md` ONLY on a step-5 FAIL (no source files) | 4, 6, 7b, 8b, 9b, 10 | — | standard |
| 12. docs sweep | `docs/PRD.md`, `docs/tech-debt.md` | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10, 11 | — | mechanical |

The table alone is the scheduling contract: a task may start when its Depends-on tasks are
complete AND no Conflicts-with task is in flight (implementation OR verification — a
whole-package-suite run, a whole-package `tsc --noEmit`, or an `npm run build` counts).
Conflicts are symmetric, listed on BOTH rows — re-verified after every edit to this table (last
verified for this revision: all 14 implementing rows, every Conflicts entry present on both
rows, no self-references, no unknown labels; 11 and 12 are serialized by their Depends-on cells
and carry no conflicts). With the client group now inside the server/hub mutual-exclusion set
(cross-group rationale below), this plan permits NO concurrent
writers at all: rows 1–10 are a single exclusion group and 11/12 depend on all of it, so tasks
execute serially. lean-sdd's pipelining still applies in its read-only form — a reviewer that
only reads the diff and the tree (no suite run, no `tsc`, no build) may run concurrently with
the next task's implementer; a reviewer that executes any verify command may not.

**Rationale (server/hub group).** Tasks 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a and 8b are one
mutually-exclusive group. Every one of them writes `poc/server/src` and verifies with a
whole-package `tsc --noEmit` / whole suite / `npm run build` over `poc/server` — including
Task 6, whose hub suite pretest builds `poc/server`. Shared files sharpen it further
(`server.ts`: 2a/2b/4/7a/8b; `relayProtocol.ts`: 3/6/8a; `project.ts`: 2b/3/7a/8b;
`pendingGate.ts`: 8a; `poc/server/dist/`: everything that builds). Tasks 1 and 5 create only
new source files but still typecheck the whole package, so they carry the full group's
conflicts too — no "new-file-only means conflict-free" exemption survives in this plan.

**Rationale (client group).** 9a is a pure new module and is upstream of BOTH client writers
(9b depends 9a; 10 depends 9a), so it can never run concurrently with them. 9b and 10 both
write client component files and both run the whole client suite, and they overlap on
`terminal.css` (9b adds `contested-calm`, 10 consumes it), so they conflict with each other.

**Rationale (cross-group — client tasks are `poc/server/dist/` WRITERS, not readers).** Client
tasks write no server or hub *source* file, but every client verify in this plan BUILDS the
server package: `poc/client/package.json` declares `"pretest": "npm --prefix ../server run
build"`, and Task 9a's verify additionally runs the client `npm run build` (`tsc -b && vite
build`) against that freshly built `dist/`. `poc/server/dist/` is exactly the shared artifact
the server/hub group's own `npm run build` steps write, and this table's own conflict rule
already counts "an `npm run build`" as an in-flight conflict. So 9a, 9b and 10 are WRITERS of
`poc/server/dist/`: each of them carries the full server/hub group (1, 2a, 2b, 3, 4, 5, 6, 7a,
7b, 8a, 8b) in its Conflicts cell, and 9a, 9b, 10 appear symmetrically on every server/hub row.
There is no client/server parallelism in this plan, and no "re-run the client verify once and
call it a read-only race" allowance — a client verify that fails against a half-written
`dist/` is a scheduling violation to be fixed by serialising, not retried.

---

## Task 1: touchedFiles — git-derived changed-path set *(spec §3.1)*

**Files:** create `poc/server/src/touched.ts`; test `poc/server/test/touched.test.ts`.

**Interfaces — produces (verbatim):**

```ts
// TOUCH_CAP / TOUCH_SENTINEL are DECLARED in collisions.ts (Task 5 — the isomorphic module)
// and re-exported here unchanged, so the isomorphic module never imports this node-only one.
// This is why Task 1 depends on Task 5 in the dependency table.
export { TOUCH_CAP, TOUCH_SENTINEL } from "./collisions.js";

export const PATH_WIRE_CAP = 512;   // producer-side drop threshold (Global Constraints)
export function touchedFiles(workdir: string, baseRef: string): string[];
// Synchronous; shells out to git in `workdir` via execFileSync with `{ timeout: 5000 }` —
// EXACTLY 5000 ms per git invocation, because Task 4 puts this call on the permission-gate
// path and a hung git in a large repo must never stall gate handling.
// THROWS on git failure, INCLUDING a timeout — the caller (Task 4) owns
// keep-previous-value semantics.
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| committed divergence | worktree with commits after branching from baseRef; base has advanced too | paths from `git diff --name-only $(git merge-base baseRef HEAD)..HEAD` — base-side-only changes NOT included |
| uncommitted work | modified + untracked files, nothing committed | their repo-relative paths included (`git status --porcelain` parsing; both staged and unstaged) |
| union + dedupe + sort | a path both committed and re-modified | appears once; output sorted ascending |
| rename | `git mv a.ts b.ts` committed (or staged) | BOTH `a.ts` and `b.ts` present |
| repo-relative | file in a subdirectory | path exactly as git emits (posix separators, no leading `./`, relative to repo root) |
| over-long path (producer rule) | a changed path longer than `PATH_WIRE_CAP` (512) chars | DROPPED before the cap/sentinel step; every returned path is ≤ 512 chars, so this session's facts frame can never be rejected wholesale by Task 3's validator (paired with Task 3's "producer never emits a rejectable path" row). Not truncated — a truncated path is a different path and would false-collide |
| cap + sentinel | > TOUCH_CAP distinct paths (after the over-long drop) | first TOUCH_CAP after sort, then final element exactly `TOUCH_SENTINEL`; length = TOUCH_CAP + 1 |
| clean worktree | no divergence, nothing uncommitted | `[]` |
| git failure | `workdir` is not a git repo / git exits non-zero | throws (Error carries git's stderr) |
| git timeout | a git invocation exceeds the 5000 ms `execFileSync` timeout | throws, on the same path as any other git failure — Task 4 then keeps the previous `entry.touched` and the gate proceeds |

**Exact values:** `TOUCH_CAP = 500`; `TOUCH_SENTINEL = "…"` (U+2026) — both DECLARED in
`collisions.ts` (Task 5) and re-exported here; `PATH_WIRE_CAP = 512`; git timeout `5000` ms.
Status parsing must handle the porcelain rename format (`R  old -> new`, both sides
contribute).

**Verify:** `cd poc/server && npx vitest run test/touched.test.ts && npx tsc --noEmit` → green
(tests build real temp git repos; no mocking of git).
**Commit:** `feat(server): touchedFiles — repo-relative divergence set for a session worktree`

---

## Task 2a: project-scoped worktrees — debt §2.1 root fix *(spec §7, §8a.3)*

**Files:** modify `poc/server/src/workspace.ts`, `poc/server/src/server.ts` (provision call
sites ONLY — the session-creation binding is Task 2b); test
`poc/server/test/workspace.test.ts` (extend).

**Risk / rollback — READ BEFORE THE FIRST NEW-SCHEME PROVISION:**

- **Blast radius.** This changes where worktrees live and what branches they sit on. Sessions
  currently running on the flat `<repoRoot>/.mpai/worktrees/<slug>` scheme are **orphaned on
  restart**: their directory and `mpai/<slug>` branch persist, unreferenced by any new-scheme
  key, and the disk they occupy is never reclaimed by this code. Nothing is deleted, but
  nothing cleans up either — a POC-posture accepted cost (spec §7), disclosed in the PR.
- **Rollback.** `git revert` of this commit restores the flat scheme but does NOT remove
  anything the new scheme created. The manual undo, per provisioned pair, is:
  `git worktree remove <repoRoot>/.mpai/worktrees/<projectId>/<slug>` then
  `git branch -D mpai/<projectId>/<slug>`.
- **Pre-step (do this first, paste into the ledger).** Record the baseline so the delta is
  recoverable: `git worktree list` and `git branch --list 'mpai/*'` output captured in the
  execution ledger BEFORE the first new-scheme provision runs.

**Interfaces — produces:** `WorkspaceManager.provision(projectId: string, slug: string,
baseRef: string)` (projectId is a new FIRST parameter; SLUG-validated like slug at point of
use). Internal map key literal `${projectId}/${slug}`; path and branch as in Global Constraints.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| path scheme | provision("acme", "auth", base) | worktree at `<repoRoot>/.mpai/worktrees/acme/auth`, branch `mpai/acme/auth`, map key `acme/auth` |
| cross-project isolation | provision("acme", "auth") then provision("beta", "auth") | two DISTINCT worktrees, two branches, two map keys; neither reuses the other (the debt §2.1 failure, now discriminated) |
| same-project idempotence | provision("acme", "auth") twice | second call reuses the first worktree (existing idempotent-reuse semantics, keyed on `acme/auth`) |
| branch-taken check ordering | branch `mpai/acme/auth` exists but worktree dir is gone | existing branch-taken behavior preserved, evaluated against the project-scoped branch name |
| old flat scheme untouched | a legacy `<root>/.mpai/worktrees/<slug>` dir exists | never reused, never deleted, never migrated by any new-scheme call |
| call sites | every `provision(` caller in server.ts | passes the session's projectId; no caller left on the old signature (compiler-enforced) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green
(live provisioning path). Then the mechanical scheme check:
`command grep -n "path.join(this.worktreesRoot" poc/server/src/workspace.ts` → every hit
includes a projectId argument (no single-segment `path.join(this.worktreesRoot, slug)` remains).
**Commit:** `fix(server): project-scoped worktree provisioning — closes debt §2.1`

---

## Task 2b: bind `workdir` / `baseRef` to the session entry *(spec §8a ruling 1)*

**Files:** modify `poc/server/src/project.ts` (the two new `ProjectSessionEntry` fields),
`poc/server/src/server.ts` (session-creation paths only); test
`poc/server/test/project.test.ts` (extend — shared with Task 3 and Task 7a, both of which
conflict with this task, so the three never run concurrently).

**Depends on Task 2a** — the binding stores exactly the baseRef handed to 2a's new
`provision(projectId, slug, baseRef)` signature, so it cannot be written first.

**Interfaces — produces** (spec §8a ruling 1, closing Task 4's input gap):

```ts
// poc/server/src/project.ts — on ProjectSessionEntry
workdir: string | undefined;   // the session's worktree path, or undefined (no repo)
baseRef: string | null;        // EXACTLY the baseRef string passed to provision(...), else null
```

Both are bound at **every** session-creation path (`getOrCreateSession` and the `create_session`
handler, `poc/server/src/server.ts:404-463`) — never re-derived, never defaulted to `"main"`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| baseRef bound | session created with a repo + baseRef `origin/main` | `entry.baseRef === "origin/main"` (character-identical to the string handed to `provision`) and `entry.workdir` is the provisioned worktree path |
| no repo | session created without a repo | `entry.workdir === undefined`, `entry.baseRef === null` |
| every creation path (discriminating) | a session made via `getOrCreateSession` AND one made via the `create_session` handler | both entries carry the same bound pair; neither path leaves `workdir`/`baseRef` unset while a worktree exists |
| never re-derived | repo whose default branch is `main`, session provisioned from `origin/dev` | `entry.baseRef === "origin/dev"` — no call to `defaultBranch()`, no `"main"` literal on the binding path (compile-time: the fields are assigned only from the provision arguments) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green;
`npm run build`. Mechanical check: `command grep -n "baseRef" poc/server/src/server.ts` → every
session-creation hit assigns from the provision argument, none from a literal `"main"`.
**Commit:** `feat(server): bind workdir and baseRef to the session entry`

---

## Task 3: `touched` on SessionFacts *(spec §3.3)*

**Files:** modify `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`; tests
`poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` (extend both;
`project.test.ts` is shared with Tasks 2b and 7a, both of which conflict with this task).

**Interfaces — produces:** `SessionFacts.touched: string[] | null` (relayProtocol.ts, beside
`repoKey`); `ProjectSessionEntry.touched: string[] | null` storage field (project.ts, default
null) + `sessionFactsOf` copies it into facts. Validation in the facts validator: absent/null
accepted (→ null); else array of strings, each length ≤ 512, array length ≤ TOUCH_CAP + 1;
anything else rejects the frame exactly like other malformed facts fields.

**Exposure note (spec §8a ruling 5 — ACCEPTED, do not re-litigate).** This field widens what
project participants can see: `facts.touched` is a session's FULL changed-path list (up to
`TOUCH_CAP + 1` paths), and it rides the existing project push to **all members of that
project** on every laptop, and is journaled hub-side under the journal's existing retention
policy. That is deliberately broader than Task 6's down-frame, which minimizes to the
intersecting paths only. The spec accepts it as the same exposure class as the record's
`filesChanged`, to be swept together with v7b2 auth. The bound that DOES hold is project
membership — asserted by the discriminating row below.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| default | fresh session entry | facts.touched = null |
| carried | entry.touched = ["a.ts","b.ts"] | sessionFactsOf output has exactly that array (copied, not aliased — mutation of the returned facts never mutates the entry) |
| validation accepts | facts frame with touched: [] / ["a.ts"] / absent / null | accepted; absent normalizes to null |
| validation rejects | touched: "x" / [1] / [513-char string] / TOUCH_CAP+2 entries | frame rejected with the existing malformed-facts error path |
| producer never emits a rejectable path (paired with Task 1) | facts built by `sessionFactsOf` from a `touchedFiles` result computed in a repo that contains a path longer than 512 chars | the over-long path was already DROPPED producer-side (Task 1's over-long-path row), so the frame VALIDATES and the session's other paths survive — one pathological path never costs a session its whole facts frame |
| project bound (exposure, discriminating) | two projects on one server, each with sessions carrying touched | a project push to project A's members contains touched for A's sessions ONLY — no session of project B appears in it at all |
| protocol stability | RELAY_PROTOCOL_VERSION | UNCHANGED (additive optional field, spec §3.3); a v2 peer without the field still validates |

**Verify:** `cd poc/server && npx vitest run test/relayProtocol.test.ts test/project.test.ts
&& npx tsc --noEmit` → green; `npm run build`.
**Commit:** `feat(server): touched — repo-relative changed paths on session facts`

---

## Task 4: laptop recompute triggers *(spec §3.2)*

**Files:** modify `poc/server/src/server.ts`; test `poc/server/test/serverTouched.test.ts`
(new; real sessions over a real socket, real temp git worktrees via Task 2a's provisioning).

**Interfaces — consumes:** `touchedFiles`/`TOUCH_CAP` (Task 1), `entry.touched` (Task 3),
`entry.workdir` + `entry.baseRef` (Task 2b — the recompute call site reads baseRef from the
persisted field and nowhere else), project-scoped provisioning (Task 2a). Produces: no new
exports — behavior only.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| turn boundary | a `turn_end` event is appended to a session with a workdir and a non-null baseRef | `touchedFiles(entry.workdir, entry.baseRef)` recomputed; `entry.touched` updated; the existing project push carries the new facts (rides `INTERESTING`) |
| baseRef source (discriminating) | session provisioned with baseRef `origin/dev` while the repo's default branch is `main` | the git invocation uses `origin/dev` — the persisted `entry.baseRef`, never `defaultBranch()`, never a literal `"main"` |
| null baseRef | `entry.baseRef === null` (session with no repo, or never provisioned) | touched stays null; NO git invocation, no error, no log spam |
| no workdir | `entry.workdir === undefined` | touched stays null; no git invocation |
| pre-gate | a `permission_request` for a write tool (Edit/Write/NotebookEdit) arrives | recompute BEFORE the gate is offered/answered, so Task 8b judges fresh data |
| git failure | touchedFiles throws | previous `entry.touched` value KEPT (stale beats absent); logged once per session, not per event |
| git hangs (bounded gate latency) | git exceeds `touchedFiles`' 5000 ms timeout (Task 1) during a PRE-GATE recompute | treated exactly as a git failure: previous `entry.touched` KEPT, the gate PROCEEDS (never blocked, never delayed past the timeout), logged once per session — a hung git in a large repo cannot stall gate handling |
| no recompute storms | non-write tools, non-boundary events | no git invocation (discriminate: a `tool_call` Read appends → no recompute) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green
(edits the live server); `npm run build`.
**Commit:** `feat(server): recompute a session's touched set at turn boundaries and write gates`

---

## Task 5: collisionsFrom — pure shared module *(spec §4)*

**Files:** create `poc/server/src/collisions.ts`; test `poc/server/test/collisions.test.ts`;
modify `poc/server/package.json` (add `"./collisions"` export, same shape as `"./record"`).

**Interfaces — produces (verbatim; isomorphic pure ESM per Global Constraints):**

```ts
export const COLLISIONS_MODULE_ID = "collisionsFrom/v1";
// Canonical declaration site for both constants (Global Constraints). They live HERE, in the
// isomorphic module, and touched.ts (Task 1) re-exports them — the reverse would drag a
// node-only module into the client bundle through Task 5's own `sentinel inert` rule.
export const TOUCH_CAP = 500;
export const TOUCH_SENTINEL = "…";      // single U+2026 char
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
- `command grep -nE "^\s*import " poc/server/src/collisions.ts` → every hit (if any) begins
  `import type ` — type-only imports are erased at build, so nothing this module names can
  reach the client bundle. A value import of ANY module, relative or not, fails this check.

This is also why `TOUCH_CAP`/`TOUCH_SENTINEL` are declared in this file rather than imported
from `touched.ts` (Task 1 re-exports them instead).
**No `npm run build` in this task** — building writes the shared `poc/server/dist/`; whichever
task runs next publishes `dist/collisions.js` with its own build (Global Constraints carve-out).
This task still typechecks the whole package, which is why its Conflicts cell lists every other
server/hub task AND every client task (client verifies build `../server` via `pretest` — see
the cross-group rationale).
**Commit:** `feat(server): collisionsFrom — pure per-repo intersection of touched sets`

---

## Task 6: hub `contested` down-frame *(spec §6a as amended by §8a ruling 6)*

**Files:** modify `poc/hub/src/hub.ts`, `poc/server/src/relayProtocol.ts` (down-frame union +
validator); tests `poc/hub/test/contested.test.ts` (new, on the uplink harness),
`poc/hub/test/hubRestart.test.ts` (extend — the §8.7 restart harness, spec §9 Testing),
`poc/server/test/relayProtocol.test.ts` (extend — frame shape + validation).

**Interfaces — produces:** down-frame (exact, spec §8a ruling 6)

```ts
{ type: "contested",
  sessionId: string,
  paths: string[],                                        // ≤ TOUCH_CAP + 1, each ≤ 512 chars
  collisions: { path: string; sessionIds: string[] }[] }  // the colliding peers, so the
                                                          // laptop can NAME them (spec §6)
```

`paths` is exactly the distinct path set of `collisions`, sorted ascending; `sessionIds`
excludes nothing — the recipient's own id IS present, matching `collisionsFrom`'s output shape.
**Note (deliberate harmonization, not a spec change).** Spec §6a's prose says the frame's paths
are "capped at TOUCH_CAP", and §8a ruling 6 amends the frame's SHAPE only. This plan bounds
`paths` **identically to `facts.touched`** — length ≤ `TOUCH_CAP + 1` (the +1 slot holds
`TOUCH_SENTINEL`), each path ≤ 512 chars — so one validator shape serves both frames. That is a
plan-authored harmonization to the bound spec §3.3 already pins for `touched`, recorded here
(same treatment as Task 10's supersession note) so a reviewer does not read it as drift. It
does not retire spec text: if the owner prefers, it can be banked as ruling 7 amending §6a. The
spec remains the record; where it is explicit and this plan is wrong, the spec governs.

Hub behavior: on each throttled project push, compute `collisionsFrom` over the project
snapshot's sessions; for every session whose contested state CHANGED since last sent to its
owning uplink, send one frame (empty `paths: []` **and** `collisions: []` when a session's last
collision clears). Consumes `collisionsFrom` (Task 5), facts.touched (Task 3, already
stored/journaled by the hub for free).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| frame on collision | two uplinks' sessions in one repoKey publish overlapping touched | each owning uplink receives `contested` for ITS sessionId, `paths` listing the shared paths and `collisions` naming the peer session ids |
| change-only | same collision state across two pushes | no duplicate frame on the second push (state compared on paths AND collisions) |
| clear | one session's touched update removes the overlap | affected uplinks receive `paths: []`, `collisions: []` exactly once |
| over-cap | a session's contested path set exceeds TOUCH_CAP | truncated after sort to TOUCH_CAP entries plus a final `TOUCH_SENTINEL` element (length = TOUCH_CAP + 1, same semantics as Task 1/Task 3); `collisions` truncated to the retained paths |
| validation rejects (relayProtocol) | inbound `contested` frame with `paths: "x"` / a 513-char path / TOUCH_CAP+2 entries / a `collisions` entry missing `sessionIds` / `sessionIds: [1]` | frame rejected with the existing malformed-frame error path — never partially applied |
| offline uplink | collision involves a session whose uplink is offline | no send, no error; frame delivered on next change after reconnect (no replay obligation — the next push recomputes) |
| restart preserves touched | hub restarts and hydrates from the journal (extends `poc/hub/test/hubRestart.test.ts`) | each hydrated `SessionFacts.touched` deep-equals what was journaled before the restart; the first post-restart push recomputes collisions from it and emits frames matching pre-restart state (change-detection state MAY reset — one duplicate frame after restart is acceptable and documented) |
| old laptop / unknown down-frame (compat) | a laptop built before this task receives a `type: "contested"` frame | the frame is IGNORED by the unknown-frame path; the uplink is NOT disconnected and no error surfaces. `RELAY_PROTOCOL_VERSION` stays **UNCHANGED** (additive frame type — same posture as Task 3's additive optional field). Bumping the version instead would be an owner decision, not this task's |
| thesis bound | frame contents | ONLY sessionId, paths and colliding session ids — no transcript data, no prompts, no names |

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green;
server-side: `cd poc/server && npx vitest run test/relayProtocol.test.ts` → green, then
`npm run build`.
**Commit:** `feat(hub): contested down-frame — per-session collision signal to owning laptops`

---

## Task 7a: laptop contested storage + local derivation *(spec §6a)*

**Files:** modify `poc/server/src/server.ts` (frame handler + local derivation),
`poc/server/src/project.ts` (the `contestedFrame` field on `ProjectSessionEntry`); tests
`poc/server/test/serverContested.test.ts` (new), `poc/server/test/project.test.ts` (extend —
shared with Tasks 2b and 3, both of which conflict with this task).

**Interfaces — consumes:** the `contested` frame (Task 6), `collisionsFrom` (Task 5), the
laptop's own project session map. Produces (server-internal, exported for Task 7b and Task 8b —
these two names are the contract, character-exact):

```ts
export function contestedFor(sessionId: string): ReadonlySet<string>;
// UNION of (a) the last hub `contested` frame's paths for this session and
// (b) local derivation: collisionsFrom over this laptop's own project sessions.
export function contestedSessionsFor(sessionId: string, path: string): string[];
// The OTHER session ids colliding with `sessionId` on `path`, ascending, deduped
// across both sources; [] when the path is not contested.
```

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
| unknown session | `contestedFor("nope")` | empty set; never throws |
| thesis bound | accessor outputs | paths and session ids only — no prompts, no transcript, no file contents |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green;
`npm run build`.
**Commit:** `feat(server): laptop contested storage — hub frame ∪ local derivation`

---

## Task 7b: digest tier (a) — contested lines in `<teammates>` *(spec §6a)*

**Files:** modify `poc/server/src/digest.ts`; test `poc/server/test/digest.test.ts` (extend).

**Interfaces — consumes:** `contestedFor` / `contestedSessionsFor` (Task 7a). Produces:
`digestFor`'s `<teammates>` block gains contested lines. No new exports.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| digest line | session s2 (driver name resolvable from participants) shares `src/a.ts` | a line of the form `session s2 (driven by <name>) has also changed: src/a.ts` (spec §6a literal) |
| per-peer grouping | one peer session shares three paths | ONE line for that peer listing all three, comma-separated, paths ascending |
| overflow cap | a peer shares 8 paths | first 5 paths, then ` +3 more` |
| unnamed driver | peer session has no resolvable driver name | line degrades to `session s2 has also changed: …` — never prints `undefined` |
| local-derivation source | contested set comes only from local derivation (solo mode) | identical lines — the digest never distinguishes source |
| thesis bound | digest content | paths, session ids, driver names only — never another session's prompts/transcript |
| no collisions | nothing contested | `<teammates>` block unchanged from today (no empty contested section) |

**Exact values / provenance:** the **5-path-per-line cap and the ` +N more` overflow are
plan-authored**, not spec text — spec §6a gives the line form and sets no digest-line cap. They
are deliberate: they bound prompt growth under a near-`TOUCH_CAP` touched set and they match
Task 10's party-row overflow so the two surfaces read alike. The corresponding note in Task 10
records that this ` +N more` phrasing supersedes spec §5's `+${rest}` example.

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green;
`npm run build`.
**Commit:** `feat(server): agents learn contested files — digest tier of awareness`

---

## Task 8a: gate reason carrier — wire + state *(spec §6b's "the gate's UI line names why")*

Pure carrier task: it adds the field and the wire slot, and NOTHING sets a non-null reason
until Task 8b. Split out from the policy for the same reason Task 6's down-frame is its own
task — a protocol change lands under its own commit.

**Files:** modify `poc/server/src/pendingGate.ts` (the `reason` field),
`poc/server/src/relayProtocol.ts` (the gate frame carries the reason to the client); tests
`poc/server/test/pendingGate.test.ts` (extend), `poc/server/test/relayProtocol.test.ts` (extend).

**Interfaces — produces:**

```ts
// poc/server/src/pendingGate.ts — PendingGate gains:
reason: string | null;   // e.g. `contested with session alpha`; null for ordinary gates

// poc/server/src/relayProtocol.ts — the permission-gate down-frame gains:
reason?: string | null;  // additive OPTIONAL field; absent and null are the same thing
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| default null | any gate opened by today's code paths | `PendingGate.reason === null`; the emitted gate frame is byte-identical to today's apart from the optional field being absent/null |
| carried to the client | a gate whose `reason` is `contested with session alpha` | the gate frame carries that exact string, character-for-character, to the client |
| validation accepts | inbound gate frame with `reason` absent / null / a string | accepted; absent normalizes to null |
| validation rejects | `reason: 7` / `reason: {}` / a string longer than 512 chars | frame rejected with the existing malformed-frame error path — never partially applied |
| protocol stability | `RELAY_PROTOCOL_VERSION` | UNCHANGED (additive optional field, same posture as Task 3); a peer that ignores `reason` still validates and still renders the gate |
| no policy yet (discriminating) | the whole server suite on this commit | no gate anywhere sets a non-null reason — this task ships the carrier only; Task 8b supplies the first writer |

**Verify:** `cd poc/server && npx vitest run test/pendingGate.test.ts test/relayProtocol.test.ts
&& npx tsc --noEmit` → green; then `npx vitest run` → WHOLE server suite green; `npm run build`.
**Commit:** `feat(server): permission gates carry a reason line`

---

## Task 8b: auto-approve withdrawal — tier (b) *(spec §6b, §8a ruling 4)*

**Files:** modify `poc/server/src/permissions.ts`, `poc/server/src/server.ts`,
`poc/server/src/project.ts` (`contestedAsked`); tests
`poc/server/test/permissions.test.ts` (extend), `poc/server/test/serverGateContested.test.ts` (new).

**Interfaces — consumes:** `contestedFor(sessionId)` and `contestedSessionsFor(sessionId, path)`
(Task 7a — these exact names), pre-gate recompute (Task 4), `PendingGate.reason` and its gate
frame (Task 8a — this task is the first writer of that field). Produces:

```ts
// poc/server/src/permissions.ts (pure)
export function contestedWrite(
  toolName: string,
  input: unknown,
  workdir: string,
  contested: ReadonlySet<string>,
): string | null;   // returns the repo-relative contested path, else null
```

(resolve `file_path ?? notebook_path` against workdir — the `isContainedWrite` pattern — then
relativize and membership-test.)

**Bookkeeping (once per file per session):** `ProjectSessionEntry.contestedAsked: Set<string>`
(repo-relative paths), in `poc/server/src/project.ts`. A path is added when a human answers a
contested gate for it (allow OR deny). It is **never** cleared while the session lives — see
the behavior rows.

**Kill switch (spec §8a ruling 4):** env `MPAI_CONTESTED_GATE`; the exact value `"0"` disables
this task's behavior entirely. Read once per gate decision (not cached at boot) so an operator
can flip it without a restart. Tier (a) surfaces (Task 7b digest, client UI) are NOT gated by
it, and that absence is deliberate: tier (a) mutates no shared state and changes no control
flow — it adds bounded advisory text (≤ 5 paths + ` +N more` per peer, Task 7b) and read-only
DOM. Its disable path is therefore a `git revert` of the Task 7b / 9b / 10 commits, which touch
no shared state and need no runtime switch. Extending `MPAI_CONTESTED_GATE` to cover the digest
would be an owner call, not a mechanical addition. The switch also covers the accepted degenerate case: a session whose `touched` approaches
`TOUCH_CAP = 500` makes nearly every write in a shared repo contested, so auto-approve is
effectively off repo-wide until the human answers once per file — that is the accepted worst
case, it still never blocks a write, and `MPAI_CONTESTED_GATE=0` is the escape hatch.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| withdrawal (hub mode) | AUTO-approvable write to a path contested via a hub `contested` frame | auto-approval suppressed; the gate asks a human; `PendingGate.reason` is exactly `contested with session ${otherSessionId}` where otherSessionId = `contestedSessionsFor(...)[0]` (first colliding session by ascending id) |
| withdrawal (local derivation only, discriminating) | solo / same-machine: the path is contested ONLY by local derivation, no hub frame ever arrived | auto-approval still suppressed AND the reason names the actual local colliding session id — identical string form to hub mode |
| kill switch off | `MPAI_CONTESTED_GATE=0`, write to a contested path with auto-approve on | auto-approved exactly as today; no gate, no reason, no `contestedAsked` entry (discriminating row) |
| kill switch default | env unset (or any value other than `"0"`) | withdrawal active (banked decision 5, on by default) |
| once per (file, session) | human answers (allow OR deny); the agent writes the same file again | path is in `contestedAsked`; normal auto-approve rules apply again for that file in that session |
| path leaves and returns | after the human answers, the path drops out of the contested set and later becomes contested again | still NOT re-asked — `contestedAsked` is not cleared on set changes; the promise is once per (file, session) for the session's lifetime |
| second write while gate pending | a second write to the SAME path arrives while the first gate is still unanswered in `pendingGate.ts` | it does not open a second contested gate and does not auto-approve on the strength of the unanswered first — it follows the existing pending-gate queuing behavior unchanged; `contestedAsked` gains the path only when a human actually answers |
| non-contested write | write to an uncontested path with auto-approve on | auto-approved exactly as today (discriminating row) |
| non-write tools | Bash/Read/etc. on any path | never affected |
| outside worktree | write whose resolved path escapes the workdir | existing isContainedWrite behavior unchanged; contested logic never widens what may be written |
| advisory bound | any collision state | NOTHING is blocked — the only effect is auto → human, once |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green;
`npm run build`.
**Commit:** `feat(server): contested writes withdraw auto-approve — asked once per file per session`

---

## Task 9a: collisionView — client adapter over `collisionsFrom` *(spec §5)*

**Files:** create `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts`.

**Interfaces — consumes (RUNTIME import — first non-type client import of the server pkg):**
`collisionsFrom`, `COLLISIONS_MODULE_ID`, `Collision`, `CollisionInput` from
`multiplayer-ai-server/collisions`. Produces (verbatim — 9b and Task 10 depend on these):

```ts
export function projectCollisions(sessions: { sessionId: string; facts: SessionFacts }[]): Collision[];
export function contestedCountFor(sessionId: string, collisions: Collision[]): number;
export function sharedWith(sessionId: string, otherSessionId: string, collisions: Collision[]): string[];
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| adapter | snapshot session rows | projectCollisions maps facts → CollisionInput and delegates to collisionsFrom (no reimplementation — asserted by deep-equal against direct collisionsFrom output) |
| missing field | a session row whose facts lack `touched` (older peer) | mapped to `touched: null`; contributes nothing; never throws |
| count | a session in 3 distinct collision paths | contestedCountFor = 3 (distinct paths involving that session) |
| shared | two sessions sharing 2 paths | sharedWith returns both, ascending; unrelated pair → `[]` |
| none | no collisions | `[]` from all three (discriminating row) |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run src/collisionView.test.ts` → green.
Then the bundle check (minification-stable anchor — esbuild mangles binding names but preserves
string literals, so grepping for `collisionsFrom` as an identifier is NOT valid). **Every
command in this block runs from `poc/client`:**

`npm run build && command grep -c "collisionsFrom/v1" dist/assets/*.js` → `command grep -c`
prints one `file:count` line per matched file, so the expected result is **at least one line
whose count is ≥ 1** (equivalently, `command grep -l "collisionsFrom/v1" dist/assets/*.js`
prints at least one path) — proving Task 5's runtime-reachable module-id literal actually
bundled. If NO line has a non-zero count, fall back to the equivalent smoke check before
concluding a bundling failure — note the specifier is relative to `poc/client`, the cwd this
block established:

`node --input-type=module -e "import {collisionsFrom,COLLISIONS_MODULE_ID} from '../server/dist/collisions.js'; if(COLLISIONS_MODULE_ID!=='collisionsFrom/v1')process.exit(1); console.log(collisionsFrom([]))"`
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

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| repo-group chip | a repo group with ≥1 collision | group head renders exactly `⚠ ${n} contested` where `n` = the distinct contested path COUNT for that repo group (a number, never a path list — e.g. `⚠ 2 contested`, never `⚠ src/a.ts,src/b.ts contested`); groups without collisions render exactly as today |
| session-row marker | a session appearing in any Collision | a `contested` marker beside the state badge; CLOSED sessions show both (spec §2.6) |
| calm styling | the chip/marker | carries class `contested-calm` (assert the class name, not a color); the class exists in `terminal.css` and no amber token is referenced |
| none | no collisions | zero new DOM (discriminating row) |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run src/components/SessionPicker.test.tsx`
→ the new file's cases green (each shown RED on pre-task code first, per the TDD constraint);
then `npx vitest run` → WHOLE client suite green. Plus
`command grep -n "contested-calm" poc/client/src/terminal.css` → the class is defined, not just
referenced.
**Commit:** `feat(client): contested chips on the session list`

---

## Task 10: client badge + party rows *(spec §5)*

**Files:** modify `poc/client/src/components/Header.tsx`, `poc/client/src/components/PartyPane.tsx`,
`poc/client/src/App.tsx`, `poc/client/src/terminal.css` (badge use of `contested-calm`); create
`poc/client/src/components/Header.test.tsx` (**new** — owns the header-badge row and the
App.tsx `useMemo` wiring row) and `poc/client/src/components/PartyPane.test.tsx` (**new** —
neither file exists in the repo today; follow the `ProjectPicker.test.tsx` /
`RecordPanel.test.tsx` pattern). Both are render tests over `collisionsFrom` fixtures (spec §9).

**Interfaces — consumes:** Task 9a's `projectCollisions`/`contestedCountFor`/`sharedWith`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| header badge (`Header.test.tsx`) | current session has N > 0 contested paths | badge exactly `⚠ CONTESTED ▸ ${N}` beside the PULLS badge; class `contested-calm`, not the gate amber |
| badge hidden at 0 (`Header.test.tsx`, discriminating) | current session has 0 contested paths | NO badge node rendered at all — not an empty one |
| party row (`PartyPane.test.tsx`) | an OTHER PARTIES row whose session shares paths with yours | one line `⚠ shares: ${first3.join(", ")}` + ` +${rest} more` when > 3 |
| no collision (`PartyPane.test.tsx`) | no overlap with your session | rows and header exactly as today |
| wiring (`Header.test.tsx`, via the App-level render) | App.tsx | collisions computed once per project push (useMemo over project sessions), passed down as props — assert the memo is not recomputed when unrelated props change; no per-render recompute of git-scale arrays |

**Note (deliberate supersession):** spec §5's example prints bare `+2` (`⚠ shares: src/a.ts,
src/b.ts +2`). This plan uses ` +${rest} more` instead, so the party row and Task 7b's digest
overflow read identically. That is a plan-authored change to a spec *example*, not to a spec
rule; recorded here so a reviewer does not read it as drift.

**Verify:** `cd poc/client && npx tsc -b && npx vitest run src/components/Header.test.tsx
src/components/PartyPane.test.tsx` → both new files' cases green (each shown RED on pre-task
code first); then `npx vitest run` → WHOLE client suite green.
**Commit:** `feat(client): contested badge and party-row shares — the awareness surfaces`

---

## Task 11: two-session browser walk *(verification only, no source changes; spec §9 walk row —
steps beyond it are house verification convention)*

**Files:** none in the normal case (deliverable = walk record in the execution ledger). The ONE
exception is step 5: a FAIL there requires a follow-up entry in `docs/tech-debt.md` — that is
the only file this task may write, and it is why the dependency table's Files cell reads
"ledger record; `docs/tech-debt.md` ONLY on a step-5 FAIL". Task 12 also edits that file and
depends on this task, so it must expect a step-5 entry to be present already.

Each numbered step — including every lettered sub-step — is INDEPENDENTLY ledgered; a later
failure does not invalidate earlier recorded results.

**What this walk does and does NOT discriminate (read before recording a PASS).** Steps 1–7 run
alpha and beta on a SINGLE laptop attached to the hub. Task 7a defines the contested set as the
UNION of the hub frame and local derivation, so a PASS in steps 4/6/7 is satisfiable by local
derivation ALONE: these steps prove **"hub attached, derivation source not discriminated"**,
not "the hub down-frame works end to end". Task 6's hub suite (`poc/hub/test/contested.test.ts`,
two uplinks in one repoKey) is the only end-to-end evidence for the down-frame, and it is where
a down-frame regression must be caught. Ledger steps 1–7 under that label verbatim.
*(Owner option, not required by this plan: launch a SECOND laptop — second clone, second port,
its own PID file — so steps 4/6/7 exercise a genuine cross-uplink frame. That upgrade would
make the hub-mode claim discriminating; it is out of scope here because it adds a second
user-machine port to the walk.)*

**Process hygiene (binding for every step):** launch each process in the background and record
its PID; stop ONLY by recorded PID. **Never `pkill -f node`, never `pkill` by process name, never
kill by port owner** — the user's own servers share this machine.

**Steps (verbatim):**

0. **Port pre-flight (before anything is launched).** From the repo root run
   `lsof -ti :4000; lsof -ti :3002`. PASS = BOTH commands print nothing (both ports free). A
   non-empty result means the port belongs to someone else on this shared machine: pick another
   free port, ledger the substitution, and use it for the rest of the walk — **never kill the
   occupant** (the process-hygiene rule above is binding here). Port 3001 is out of scope and is
   never probed or touched. (Ledgered; not a plan-level Done-criteria step.)
1. Build all three packages, in this order (hub and client build against the server's `dist/`):
   `npm --prefix poc/server run build && npm --prefix poc/hub run build && npm --prefix poc/client run build`.
   Launch the hub, recording its PID:
   `HUB_DB=$(mktemp -d)/hub.db CLIENT_DIST=poc/client/dist PORT=4000 node poc/hub/dist/main.js &
   echo $! > /tmp/mpai-walk-hub.pid`. Launch ONE laptop from a scratch git repo, recording its
   PID — invoke the CLI by path, do NOT assume a global binary is installed:
   `node poc/server/bin/mpai.js --hub ws://127.0.0.1:4000/uplink --port 3002 --no-open & echo $! >
   /tmp/mpai-walk-laptop.pid` (NOT port 3001 — may be user-occupied). *(If `mpai` is already on
   PATH via `npm --prefix poc/server link`, `mpai …` is equivalent; ledger which form was used.)*
   Ledger both PIDs. PASS = both PIDs recorded, the hub answering on :4000 and the laptop on
   :3002. (Ledgered; not a plan-level Done-criteria step.)
2. Browser: open `http://127.0.0.1:3002`, join the project, create session `alpha`, drive one
   turn that writes the file `notes.txt` (prompt: `create notes.txt with one line`) — the file
   name is load-bearing, steps 4/5/6 and 8d/8e/8f all assert on `notes.txt` literally — and wait
   for turn end. PASS = the turn ends, `notes.txt` is present in alpha's worktree, and alpha is
   listed in the session list. (Ledgered; not a plan-level Done-criteria step.)
3. Create session `beta` in the SAME repo, drive a turn editing the SAME file (`notes.txt`).
   PASS = the turn ends and `notes.txt` is modified in beta's worktree. (Ledgered; not a
   plan-level Done-criteria step.)
4. PASS = after beta's turn ends: header badge `⚠ CONTESTED ▸ 1` in beta's session view; the
   project screen's repo group head shows the chip `⚠ 1 contested`; alpha's OTHER PARTIES row
   (from beta's view) shows `⚠ shares: notes.txt`. (Required PASS for plan-level done.)
5. Agent tier (a): drive one more beta turn asking the agent `what files are contested right
   now?`. **Pin the input, not just the prose:** record in the ledger the `digestFor` output for
   that turn (server log / test hook dump) and confirm it contains `notes.txt`.
   **Consequence:** PASS = the digest contains `notes.txt` AND the agent's answer names it.
   FAIL is admissible ONLY with (a) the verbatim `digestFor` dump pasted into the ledger and
   (b) a follow-up entry filed in `docs/tech-debt.md`; a bare "FAIL recorded" does not satisfy
   the plan-level Done criteria.
6. Agent tier (b): with auto-approve on in beta (and `MPAI_CONTESTED_GATE` unset), ask the agent
   to edit notes.txt again — PASS = the gate ASKS with reason text `contested with session
   alpha` observed verbatim; approve it; a subsequent edit auto-approves (once-per-file proven
   live). (Required PASS.)
7. Close alpha; PASS = collision persists and alpha shows CLOSED + contested (spec §2.6).
   (Required PASS.)
8. **Solo parity leg — fresh everything** (the hub-mode repo already holds `alpha`/`beta`, so
   the solo leg uses a FRESH scratch repo and FRESH session names `gamma` / `delta`):
   - **8a.** Stop the hub by recorded PID only: `kill $(cat /tmp/mpai-walk-hub.pid)`; stop the
     laptop the same way. Create a fresh scratch git repo (`mktemp -d` + `git init`) and launch
     solo from it, same invocation form as step 1:
     `node <repoRoot>/poc/server/bin/mpai.js --port 3002 --no-open & echo $! >
     /tmp/mpai-walk-solo.pid`. PASS = both old PIDs gone, solo laptop serving on 3002, no hub
     process running.
   - **8b.** Open `http://127.0.0.1:3002`, join the project, create session `gamma`, drive one
     turn that writes `notes.txt`. PASS = turn ends, session listed.
   - **8c.** Create session `delta` in the SAME fresh repo, drive a turn editing `notes.txt`.
     PASS = turn ends.
   - **8d.** UI parity (solo repeat of step 4): PASS = badge `⚠ CONTESTED ▸ 1` in delta's view,
     repo-group chip `⚠ 1 contested`, gamma's OTHER PARTIES row shows `⚠ shares: notes.txt` — all from
     LOCAL derivation, with no hub running. (Required PASS.)
   - **8e.** Tier (a) parity (solo repeat of step 5): the `digestFor` dump for a delta turn
     contains `notes.txt`. (Required PASS.)
   - **8f.** Tier (b) parity (solo repeat of step 6): PASS = the gate ASKS with reason text
     `contested with session gamma` observed verbatim — proving local derivation alone names
     the colliding session. (Required PASS.)
9. Shutdown: `kill $(cat /tmp/mpai-walk-solo.pid)`; sweep = `lsof -ti :4000; lsof -ti :3002`
   both return EMPTY — meaningful only because step 0 established that both were empty to begin
   with (or ledgered the substituted ports, which are the ones swept here). Port 3001 is out of
   scope (may be user-occupied) and is never touched.

**Verify:** ledger contains both-mode records incl. the gate-reason text observed verbatim
(steps 6 and 8f) and the step-5/8e `digestFor` evidence.
**Commit:** none.

---

## Task 12: docs sweep *(spec §8 non-goal 1; PRD §8.8)*

**Files:** modify `docs/PRD.md` (§8.8 Today), `docs/tech-debt.md` (§2.1).

**Pre-condition (Task 11 overlap).** If Task 11's step 5 recorded a FAIL, a follow-up entry for
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

- `command grep -n "oversight configured hub-side" docs/PRD.md` → ≥ 1 hit, and the hit is
  inside §8.8 (confirm by line number against `command grep -n "^### 8.8" docs/PRD.md`).
- `command grep -n "MPAI_CONTESTED_GATE" docs/PRD.md` → ≥ 1 hit (kill switch disclosed).
- `command grep -n "advisory" docs/PRD.md` → ≥ 1 hit in §8.8 (advisory-only bound restated).
- `command grep -n "repoKey\|fork" docs/PRD.md` → the fork bound restated in §8.8.
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
2. **Frame-bound harmonization (D3/V9).** Task 6 states the `paths` bound as a plan-authored
   harmonization to spec §3.3 rather than "retiring" spec §6a's phrasing; the owner may instead
   bank it as ruling 7 amending §6a.
3. **Walk discrimination (D6/V25).** Task 11 steps 1–7 are relabelled "hub attached, derivation
   source not discriminated" instead of adding a second laptop; Task 6's hub suite carries the
   end-to-end down-frame evidence. Adding a second laptop remains an owner option.
