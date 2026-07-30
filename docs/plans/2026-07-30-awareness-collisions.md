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
  deliberately does NOT build (see its Verify and the Conflicts rationale below); the first
  downstream consumer to run (Task 6, Task 7a, or Task 9a) performs the build that publishes
  `dist/collisions.js`.
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
    cap 512 chars.
  - facts field `touched: string[] | null`.
  - down-frame (spec §8a ruling 6, amends §6a):
    `{ type: "contested", sessionId: string, paths: string[], collisions: { path: string; sessionIds: string[] }[] }`
    — `paths` bound identically to `facts.touched`: length ≤ `TOUCH_CAP + 1`, each ≤ 512 chars.
  - header badge label `⚠ CONTESTED ▸ ${n}`; gate reason line `contested with session ${otherSessionId}`.
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
| 1. touchedFiles module | `poc/server/src/touched.ts`, `poc/server/test/touched.test.ts` | — | 2, 3, 4, 5, 6, 7a, 7b, 8 | standard |
| 2. project-scoped worktrees (§2.1) | `poc/server/src/workspace.ts`, `poc/server/src/server.ts`, `poc/server/src/project.ts`, `poc/server/test/workspace.test.ts`, `poc/server/test/project.test.ts` | — | 1, 3, 4, 5, 6, 7a, 7b, 8 | judgment |
| 3. facts field `touched` | `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`, `poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` | — | 1, 2, 4, 5, 6, 7a, 7b, 8 | standard |
| 4. laptop recompute triggers | `poc/server/src/server.ts`, `poc/server/test/serverTouched.test.ts` | 1, 2, 3 | 1, 2, 3, 5, 6, 7a, 7b, 8 | judgment |
| 5. collisionsFrom module | `poc/server/src/collisions.ts`, `poc/server/test/collisions.test.ts`, `poc/server/package.json` | — | 1, 2, 3, 4, 6, 7a, 7b, 8 | standard |
| 6. hub contested down-frame | `poc/hub/src/hub.ts`, `poc/server/src/relayProtocol.ts`, `poc/hub/test/contested.test.ts`, `poc/hub/test/hubRestart.test.ts`, `poc/server/test/relayProtocol.test.ts` | 3, 5 | 1, 2, 3, 4, 5, 7a, 7b, 8 | judgment |
| 7a. laptop contested storage + local derivation | `poc/server/src/server.ts`, `poc/server/test/serverContested.test.ts` | 4, 5, 6 | 1, 2, 3, 4, 5, 6, 7b, 8 | judgment |
| 7b. digest tier (a) lines | `poc/server/src/digest.ts`, `poc/server/test/digest.test.ts` | 7a | 1, 2, 3, 4, 5, 6, 7a, 8 | standard |
| 8. auto-approve withdrawal | `poc/server/src/permissions.ts`, `poc/server/src/server.ts`, `poc/server/src/pendingGate.ts`, `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`, `poc/server/test/permissions.test.ts`, `poc/server/test/serverGateContested.test.ts` | 4, 7a | 1, 2, 3, 4, 5, 6, 7a, 7b | judgment |
| 9a. collisionView adapter | `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts` | 3, 5 | — | standard |
| 9b. client: session-list surfaces | `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/terminal.css` | 9a | 10 | standard |
| 10. client: badge + party rows | `poc/client/src/components/Header.tsx`, `poc/client/src/components/PartyPane.tsx`, `poc/client/src/App.tsx`, `poc/client/src/terminal.css`, `poc/client/src/components/PartyPane.test.tsx` | 5, 9a | 9b | standard |
| 11. two-session browser walk | (no source files — execution-ledger record only) | 4, 6, 7b, 8, 9b, 10 | — | standard |
| 12. docs sweep | `docs/PRD.md`, `docs/tech-debt.md` | 1–11 | — | mechanical |

The table alone is the scheduling contract: a task may start when its Depends-on tasks are
complete AND no Conflicts-with task is in flight (implementation OR verification — a
whole-package-suite run, a whole-package `tsc --noEmit`, or an `npm run build` counts).
Conflicts are symmetric, listed on BOTH rows — verified by inspection after every edit to this
table.

**Rationale (server/hub group).** Tasks 1–8 are one mutually-exclusive group. Every one of them
either writes `poc/server/src` (1, 2, 3, 4, 5, 6, 7a, 7b, 8), or verifies with a whole-package
`tsc --noEmit` / whole suite / `npm run build` over `poc/server` — including Task 6, whose hub
suite pretest builds `poc/server`. Shared files sharpen it further (`server.ts`: 2/4/7a/8;
`relayProtocol.ts`: 3/6/8; `project.ts`: 2/3/8; `poc/server/dist/`: everything that builds).
Tasks 1 and 5 create only new files but still typecheck the whole package, so they carry the
full group's conflicts too — no "new-file-only means conflict-free" exemption survives in this
plan.

**Rationale (client group).** 9a is a pure new module and is upstream of BOTH client writers
(9b depends 9a; 10 depends 9a), so it can never run concurrently with them — its Conflicts
cell is legitimately empty. 9b and 10 both write client component files and both run the whole
client suite, and they overlap on `terminal.css` (9b adds `contested-calm`, 10 consumes it), so
they conflict with each other. Client work writes no server/hub file, so it carries no
server-group conflicts. It does READ `poc/server/dist/` (typecheck + bundle): if a client
verify fails with a missing or half-written server export while a server task's `npm run build`
is in flight, re-run the client verify once after that build completes before recording it as a
real failure — a read-only dependency, not a scheduling conflict.

---

## Task 1: touchedFiles — git-derived changed-path set *(spec §3.1)*

**Files:** create `poc/server/src/touched.ts`; test `poc/server/test/touched.test.ts`.

**Interfaces — produces (verbatim):**

```ts
export const TOUCH_CAP = 500;
export const TOUCH_SENTINEL = "…";
export function touchedFiles(workdir: string, baseRef: string): string[];
// Synchronous; shells out to git in `workdir`. THROWS on git failure —
// the caller (Task 4) owns keep-previous-value semantics.
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| committed divergence | worktree with commits after branching from baseRef; base has advanced too | paths from `git diff --name-only $(git merge-base baseRef HEAD)..HEAD` — base-side-only changes NOT included |
| uncommitted work | modified + untracked files, nothing committed | their repo-relative paths included (`git status --porcelain` parsing; both staged and unstaged) |
| union + dedupe + sort | a path both committed and re-modified | appears once; output sorted ascending |
| rename | `git mv a.ts b.ts` committed (or staged) | BOTH `a.ts` and `b.ts` present |
| repo-relative | file in a subdirectory | path exactly as git emits (posix separators, no leading `./`, relative to repo root) |
| cap + sentinel | > TOUCH_CAP distinct paths | first TOUCH_CAP after sort, then final element exactly `TOUCH_SENTINEL`; length = TOUCH_CAP + 1 |
| clean worktree | no divergence, nothing uncommitted | `[]` |
| git failure | `workdir` is not a git repo / git exits non-zero | throws (Error carries git's stderr) |

**Exact values:** `TOUCH_CAP = 500`; `TOUCH_SENTINEL = "…"` (U+2026); status parsing must
handle the porcelain rename format (`R  old -> new`, both sides contribute).

**Verify:** `cd poc/server && npx vitest run test/touched.test.ts && npx tsc --noEmit` → green
(tests build real temp git repos; no mocking of git).
**Commit:** `feat(server): touchedFiles — repo-relative divergence set for a session worktree`

---

## Task 2: project-scoped worktrees — debt §2.1 root fix *(spec §7, §8a.3)*

**Files:** modify `poc/server/src/workspace.ts`, `poc/server/src/server.ts` (provision call
sites + session-creation binding), `poc/server/src/project.ts` (per-session `workdir` /
`baseRef` fields); tests `poc/server/test/workspace.test.ts`, `poc/server/test/project.test.ts`
(extend both — `project.test.ts` is shared with Task 3, which conflicts with this task, so the
two never run concurrently).

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
Also (spec §8a ruling 1, closing Task 4's input gap):

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
| path scheme | provision("acme", "auth", base) | worktree at `<repoRoot>/.mpai/worktrees/acme/auth`, branch `mpai/acme/auth`, map key `acme/auth` |
| cross-project isolation | provision("acme", "auth") then provision("beta", "auth") | two DISTINCT worktrees, two branches, two map keys; neither reuses the other (the debt §2.1 failure, now discriminated) |
| same-project idempotence | provision("acme", "auth") twice | second call reuses the first worktree (existing idempotent-reuse semantics, keyed on `acme/auth`) |
| branch-taken check ordering | branch `mpai/acme/auth` exists but worktree dir is gone | existing branch-taken behavior preserved, evaluated against the project-scoped branch name |
| old flat scheme untouched | a legacy `<root>/.mpai/worktrees/<slug>` dir exists | never reused, never deleted, never migrated by any new-scheme call |
| call sites | every `provision(` caller in server.ts | passes the session's projectId; no caller left on the old signature (compiler-enforced) |
| baseRef bound | session created with a repo + baseRef `origin/main` | `entry.baseRef === "origin/main"` (character-identical to the string handed to provision) and `entry.workdir` is the provisioned worktree path |
| no repo | session created without a repo | `entry.workdir === undefined`, `entry.baseRef === null` |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green
(live provisioning path). Then the mechanical scheme check:
`command grep -n "path.join(this.worktreesRoot" poc/server/src/workspace.ts` → every hit
includes a projectId argument (no single-segment `path.join(this.worktreesRoot, slug)` remains).
**Commit:** `fix(server): project-scoped worktree provisioning — closes debt §2.1`

---

## Task 3: `touched` on SessionFacts *(spec §3.3)*

**Files:** modify `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`; tests
`poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` (extend both;
`project.test.ts` is shared with Task 2, which conflicts with this task).

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
| project bound (exposure, discriminating) | two projects on one server, each with sessions carrying touched | a project push to project A's members contains touched for A's sessions ONLY — no session of project B appears in it at all |
| protocol stability | RELAY_PROTOCOL_VERSION | UNCHANGED (additive optional field, spec §3.3); a v2 peer without the field still validates |

**Verify:** `cd poc/server && npx vitest run test/relayProtocol.test.ts test/project.test.ts
&& npx tsc --noEmit` → green; `npm run build`.
**Commit:** `feat(server): touched — repo-relative changed paths on session facts`

---

## Task 4: laptop recompute triggers *(spec §3.2)*

**Files:** modify `poc/server/src/server.ts`; test `poc/server/test/serverTouched.test.ts`
(new; real sessions over a real socket, real temp git worktrees via Task 2's provisioning).

**Interfaces — consumes:** `touchedFiles`/`TOUCH_CAP` (Task 1), `entry.touched` (Task 3),
`entry.workdir` + `entry.baseRef` (Task 2 — the recompute call site reads baseRef from the
persisted field and nowhere else), project-scoped provisioning (Task 2). Produces: no new
exports — behavior only.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| turn boundary | a `turn_end` event is appended to a session with a workdir and a non-null baseRef | `touchedFiles(entry.workdir, entry.baseRef)` recomputed; `entry.touched` updated; the existing project push carries the new facts (rides `INTERESTING`) |
| baseRef source (discriminating) | session provisioned with baseRef `origin/dev` while the repo's default branch is `main` | the git invocation uses `origin/dev` — the persisted `entry.baseRef`, never `defaultBranch()`, never a literal `"main"` |
| null baseRef | `entry.baseRef === null` (session with no repo, or never provisioned) | touched stays null; NO git invocation, no error, no log spam |
| no workdir | `entry.workdir === undefined` | touched stays null; no git invocation |
| pre-gate | a `permission_request` for a write tool (Edit/Write/NotebookEdit) arrives | recompute BEFORE the gate is offered/answered, so Task 8 judges fresh data |
| git failure | touchedFiles throws | previous `entry.touched` value KEPT (stale beats absent); logged once per session, not per event |
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
| three-way | three sessions share a path | one Collision with 3 sessionIds |
| grouping | same path, DIFFERENT repoKeys | no collision (fork bound, spec §2.7) |
| null repoKey | sessions with repoKey null | excluded entirely |
| null/empty touched | touched null or [] | contribute nothing, never collide |
| closed sessions count | one session lifecycle "closed" | still collides (spec §2.6) |
| sentinel inert | `"…"` in both sessions' touched | never a collision path |
| input guard | `collisionsFrom(null as never)` | throws TypeError whose message starts with `collisionsFrom/v1:` |
| determinism + purity | same input twice, any order | deep-equal output sorted (repoKey, path, sessionIds asc); inputs not mutated |

**Verify:** `cd poc/server && npx vitest run test/collisions.test.ts && npx tsc --noEmit` →
green; `command grep -n "from \"node:" poc/server/src/collisions.ts` → empty (isomorphic).
**No `npm run build` in this task** — building writes the shared `poc/server/dist/` that other
in-flight tasks consume; the first downstream consumer (Task 6, 7a, or 9a) builds instead
(Global Constraints carve-out). This task still typechecks the whole package, which is why its
Conflicts cell lists every other server/hub task.
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
Bounds are **identical to `facts.touched`** (length ≤ `TOUCH_CAP + 1`, each path ≤ 512) so one
validator shape serves both; the earlier "≤ TOUCH_CAP" phrasing is retired.

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
| thesis bound | frame contents | ONLY sessionId, paths and colliding session ids — no transcript data, no prompts, no names |

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green;
server-side: `cd poc/server && npx vitest run test/relayProtocol.test.ts` → green, then
`npm run build`.
**Commit:** `feat(hub): contested down-frame — per-session collision signal to owning laptops`

---

## Task 7a: laptop contested storage + local derivation *(spec §6a)*

**Files:** modify `poc/server/src/server.ts` (frame handler + storage + local derivation);
test `poc/server/test/serverContested.test.ts` (new).

**Interfaces — consumes:** the `contested` frame (Task 6), `collisionsFrom` (Task 5), the
laptop's own project session map. Produces (server-internal, exported for Task 7b and Task 8 —
these two names are the contract, character-exact):

```ts
export function contestedFor(sessionId: string): ReadonlySet<string>;
// UNION of (a) the last hub `contested` frame's paths for this session and
// (b) local derivation: collisionsFrom over this laptop's own project sessions.
export function contestedSessionsFor(sessionId: string, path: string): string[];
// The OTHER session ids colliding with `sessionId` on `path`, ascending, deduped
// across both sources; [] when the path is not contested.
```

Per-session storage: `contestedFrame: { paths: string[]; collisions: { path: string;
sessionIds: string[] }[] } | null` (the last frame verbatim, null until one arrives). Local
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

## Task 8: auto-approve withdrawal — tier (b) *(spec §6b, §8a ruling 4)*

**Files:** modify `poc/server/src/permissions.ts`, `poc/server/src/server.ts`,
`poc/server/src/pendingGate.ts` (reason field), `poc/server/src/relayProtocol.ts` (the gate
frame carries the reason to the client), `poc/server/src/project.ts` (`contestedAsked`); tests
`poc/server/test/permissions.test.ts` (extend), `poc/server/test/serverGateContested.test.ts` (new).

**Interfaces — consumes:** `contestedFor(sessionId)` and `contestedSessionsFor(sessionId, path)`
(Task 7a — these exact names), pre-gate recompute (Task 4). Produces:

```ts
// poc/server/src/permissions.ts (pure)
export function contestedWrite(
  toolName: string,
  input: unknown,
  workdir: string,
  contested: ReadonlySet<string>,
): string | null;   // returns the repo-relative contested path, else null

// poc/server/src/pendingGate.ts — PendingGate gains:
reason: string | null;   // e.g. `contested with session alpha`; null for ordinary gates
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
it. The switch also covers the accepted degenerate case: a session whose `touched` approaches
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
string literals, so grepping for `collisionsFrom` as an identifier is NOT valid):
`npm run build && command grep -c "collisionsFrom/v1" dist/assets/*.js` → ≥ 1, proving Task 5's
runtime-reachable module-id literal actually bundled. If that returns 0, fall back to the
equivalent smoke check before concluding a bundling failure:
`node --input-type=module -e "import {collisionsFrom,COLLISIONS_MODULE_ID} from './poc/server/dist/collisions.js'; if(COLLISIONS_MODULE_ID!=='collisionsFrom/v1')process.exit(1); console.log(collisionsFrom([]))"`
→ prints `[]`, exit 0.
**Commit:** `feat(client): collisionView — client adapter over collisionsFrom`

---

## Task 9b: client session-list surfaces *(spec §5)*

**Files:** modify `poc/client/src/components/SessionPicker.tsx`,
`poc/client/src/terminal.css` (adds the `contested-calm` class — it does not exist today; the
amber gate tokens at `terminal.css:37-39` stay untouched).

**Interfaces — consumes:** Task 9a's `projectCollisions` / `contestedCountFor` / `sharedWith`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| repo-group chip | a repo group with ≥1 collision | group head renders `⚠ ${paths} contested` (distinct path count); groups without collisions render exactly as today |
| session-row marker | a session appearing in any Collision | a `contested` marker beside the state badge; CLOSED sessions show both (spec §2.6) |
| calm styling | the chip/marker | carries class `contested-calm` (assert the class name, not a color); the class exists in `terminal.css` and no amber token is referenced |
| none | no collisions | zero new DOM (discriminating row) |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run` → WHOLE client suite green;
`command grep -n "contested-calm" poc/client/src/terminal.css` → the class is defined, not just
referenced.
**Commit:** `feat(client): contested chips on the session list`

---

## Task 10: client badge + party rows *(spec §5)*

**Files:** modify `poc/client/src/components/Header.tsx`, `poc/client/src/components/PartyPane.tsx`,
`poc/client/src/App.tsx`, `poc/client/src/terminal.css` (badge use of `contested-calm`); test
`poc/client/src/components/PartyPane.test.tsx` (new or extend existing pattern).

**Interfaces — consumes:** Task 9a's `projectCollisions`/`contestedCountFor`/`sharedWith`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| header badge | current session has N > 0 contested paths | badge exactly `⚠ CONTESTED ▸ ${N}` beside the PULLS badge; hidden at 0; class `contested-calm`, not the gate amber |
| party row | an OTHER PARTIES row whose session shares paths with yours | one line `⚠ shares: ${first3.join(", ")}` + ` +${rest} more` when > 3 |
| no collision | no overlap with your session | rows and header exactly as today |
| wiring | App.tsx | collisions computed once per project push (useMemo over project sessions), passed down as props — no per-render recompute of git-scale arrays |

**Note (deliberate supersession):** spec §5's example prints bare `+2` (`⚠ shares: src/a.ts,
src/b.ts +2`). This plan uses ` +${rest} more` instead, so the party row and Task 7b's digest
overflow read identically. That is a plan-authored change to a spec *example*, not to a spec
rule; recorded here so a reviewer does not read it as drift.

**Verify:** `cd poc/client && npx tsc -b && npx vitest run` → WHOLE client suite green.
**Commit:** `feat(client): contested badge and party-row shares — the awareness surfaces`

---

## Task 11: two-session browser walk *(verification only, no source changes; spec §9 walk row —
steps beyond it are house verification convention)*

**Files:** none (deliverable = walk record in the execution ledger). Each numbered step —
including every lettered sub-step — is INDEPENDENTLY ledgered; a later failure does not
invalidate earlier recorded results.

**Process hygiene (binding for every step):** launch each process in the background and record
its PID; stop ONLY by recorded PID. **Never `pkill -f node`, never `pkill` by process name, never
kill by port owner** — the user's own servers share this machine.

**Steps (verbatim):**

1. Build all three packages. Launch the hub, recording its PID:
   `HUB_DB=$(mktemp -d)/hub.db CLIENT_DIST=poc/client/dist PORT=4000 node poc/hub/dist/main.js &
   echo $! > /tmp/mpai-walk-hub.pid`. Launch ONE laptop from a scratch git repo, recording its
   PID: `mpai --hub ws://127.0.0.1:4000/uplink --port 3002 --no-open & echo $! >
   /tmp/mpai-walk-laptop.pid` (NOT port 3001 — may be user-occupied). Ledger both PIDs.
2. Browser: join project, create session `alpha`, drive one turn that writes a file (e.g.
   `create notes.txt with one line`), wait for turn end.
3. Create session `beta` in the SAME repo, drive a turn editing the SAME file.
4. PASS = after beta's turn ends: header badge `⚠ CONTESTED ▸ 1` in beta's session view; the
   project screen's repo group shows the chip; alpha's OTHER PARTIES row (from beta's view)
   shows `⚠ shares: notes.txt`. (Required PASS for plan-level done.)
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
     solo from it: `mpai --port 3002 --no-open & echo $! > /tmp/mpai-walk-solo.pid`. PASS =
     both old PIDs gone, solo laptop serving on 3002, no hub process running.
   - **8b.** Join the project, create session `gamma`, drive one turn that writes `notes.txt`.
     PASS = turn ends, session listed.
   - **8c.** Create session `delta` in the SAME fresh repo, drive a turn editing `notes.txt`.
     PASS = turn ends.
   - **8d.** UI parity (solo repeat of step 4): PASS = badge `⚠ CONTESTED ▸ 1` in delta's view,
     repo-group chip present, gamma's OTHER PARTIES row shows `⚠ shares: notes.txt` — all from
     LOCAL derivation, with no hub running. (Required PASS.)
   - **8e.** Tier (a) parity (solo repeat of step 5): the `digestFor` dump for a delta turn
     contains `notes.txt`. (Required PASS.)
   - **8f.** Tier (b) parity (solo repeat of step 6): PASS = the gate ASKS with reason text
     `contested with session gamma` observed verbatim — proving local derivation alone names
     the colliding session. (Required PASS.)
9. Shutdown: `kill $(cat /tmp/mpai-walk-solo.pid)`; sweep = `lsof -ti :4000 -ti :3002` returns
   EMPTY. Port 3001 is out of scope (may be user-occupied) and is never touched.

**Verify:** ledger contains both-mode records incl. the gate-reason text observed verbatim
(steps 6 and 8f) and the step-5/8e `digestFor` evidence.
**Commit:** none.

---

## Task 12: docs sweep *(spec §8 non-goal 1; PRD §8.8)*

**Files:** modify `docs/PRD.md` (§8.8 Today), `docs/tech-debt.md` (§2.1).

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
