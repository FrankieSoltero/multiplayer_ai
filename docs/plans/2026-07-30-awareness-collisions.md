# Awareness — Collisions (PRD §8.8 first half) Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd. The Task Dependency Table is the
> scheduling and review-depth contract. Spec of record:
> `docs/specs/2026-07-30-awareness-collisions-design.md` (its §8a rulings 1–3 and §2 banked
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
  exports — hub and client typecheck/bundle against its built `dist/`.
- TDD is the implementer's standing discipline (soltero-skills:lean-tdd): every new test shown
  RED on pre-task code (revert-and-rerun). Never predict suite totals.
- Never `git add -A`; stage explicit paths; verify each commit with
  `git diff-tree --no-commit-id --name-only -r HEAD`. The tree may carry user WIP — never
  stage anything outside the task's file list. (`grep` is aliased to ugrep in the dev shell —
  verify snippets use `command grep` where plain grep semantics matter.)
- **Thesis constraint (spec §1):** collision surfaces carry ONLY paths, session ids, lifecycle
  and driver/participant names — never transcript content.
- **Advisory only (spec §2.2):** no code path may block, queue, or lock a write because of a
  collision; tier (b) downgrades an AUTO approval to a HUMAN question, nothing more.
- Exact values used across tasks: `TOUCH_CAP = 500`; truncation sentinel literal `"…"` (single
  U+2026 char); per-path wire cap 512 chars; facts field `touched: string[] | null`;
  down-frame `{ type: "contested", sessionId: string, paths: string[] }`; header badge label
  `⚠ CONTESTED ▸ ${n}`; gate reason line `contested with session ${otherSessionId}`; worktree
  path `<repoRoot>/.mpai/worktrees/<projectId>/<slug>`; worktree branch
  `mpai/<projectId>/<slug>`.
- `poc/server/src/collisions.ts` must be **isomorphic pure ESM** — no `node:` imports, no
  filesystem/process access — the client imports it at RUNTIME (unlike `record`'s type-only
  imports). Task 9's Verify includes a bundle check.
- **Done criteria (plan-level):** every per-task Verify passed; on the final tree all three
  suites + typechecks green; Task 11's two-session walk record (both modes) in the execution
  ledger.

## Task Dependency Table

| Task | Files touched | Depends on | Conflicts with (no concurrency) | Risk tier |
|------|---------------|------------|---------------------------------|-----------|
| 1. touchedFiles module | `poc/server/src/touched.ts`, `poc/server/test/touched.test.ts` | — | 2, 3, 4 | standard |
| 2. project-scoped worktrees (§2.1) | `poc/server/src/workspace.ts`, `poc/server/src/server.ts`, `poc/server/test/workspace.test.ts` | — | 1, 3, 4, 7, 8 | judgment |
| 3. facts field `touched` | `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`, `poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` | — | 1, 2, 4, 6, 7, 8 | standard |
| 4. laptop recompute triggers | `poc/server/src/server.ts`, `poc/server/test/serverTouched.test.ts` | 1, 2, 3 | 1, 2, 3, 7, 8 | judgment |
| 5. collisionsFrom module | `poc/server/src/collisions.ts`, `poc/server/test/collisions.test.ts`, `poc/server/package.json` | — | — | standard |
| 6. hub contested down-frame | `poc/hub/src/hub.ts`, `poc/server/src/relayProtocol.ts`, `poc/hub/test/contested.test.ts`, `poc/server/test/relayProtocol.test.ts` | 3, 5 | 3, 7, 8 | judgment |
| 7. laptop contested storage + digest | `poc/server/src/server.ts`, `poc/server/src/digest.ts`, `poc/server/test/digest.test.ts`, `poc/server/test/serverContested.test.ts` | 4, 5, 6 | 2, 3, 4, 6, 8 | standard |
| 8. auto-approve withdrawal | `poc/server/src/permissions.ts`, `poc/server/src/server.ts`, `poc/server/test/permissions.test.ts`, `poc/server/test/serverGateContested.test.ts` | 4, 7 | 2, 3, 4, 6, 7 | judgment |
| 9. client: session-list surfaces | `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts`, `poc/client/src/components/SessionPicker.tsx` | 5 | 10 | standard |
| 10. client: badge + party rows | `poc/client/src/components/Header.tsx`, `poc/client/src/components/PartyPane.tsx`, `poc/client/src/App.tsx`, `poc/client/src/components/PartyPane.test.tsx` | 5, 9 | 9 | standard |
| 11. two-session browser walk | (no source files — execution-ledger record only) | 4, 6, 8, 10 | — | standard |
| 12. docs sweep | `docs/PRD.md`, `docs/tech-debt.md` | 1–11 | — | mechanical |

The table alone is the scheduling contract: a task may start when its Depends-on tasks are
complete AND no Conflicts-with task is in flight (implementation OR verification — a
whole-package-suite run counts). Conflicts are symmetric, listed on BOTH rows. Sources: shared
files (`server.ts`: 2/4/7/8; `relayProtocol.ts`: 3/6; SessionPicker: 9 vs 10's App wiring) and
whole-package-suite Verifies (tasks 2, 4, 6, 7, 8 run whole suites while other same-package
writers would be in flight; hub suite pretest builds poc/server — no hub full-suite verify
while a poc/server writer is in flight). Tasks 1, 5 are new-file-only but 1's verify typechecks
the whole server package (conflicts with in-flight server writers); 5 is dependency-free and
conflict-free (scoped verify). Client tasks 9/10 are disjoint from all server/hub work.

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
sites only); test `poc/server/test/workspace.test.ts` (extend).

**Interfaces — produces:** `WorkspaceManager.provision(projectId: string, slug: string,
baseRef: string)` (projectId is a new FIRST parameter; SLUG-validated like slug at point of
use). Internal key, path, and branch all gain the project dimension.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| path scheme | provision("acme", "auth", base) | worktree at `<repoRoot>/.mpai/worktrees/acme/auth`, branch `mpai/acme/auth` |
| cross-project isolation | provision("acme", "auth") then provision("beta", "auth") | two DISTINCT worktrees, two branches; neither reuses the other (the debt §2.1 failure, now discriminated) |
| same-project idempotence | provision("acme", "auth") twice | second call reuses the first worktree (existing idempotent-reuse semantics, now project-scoped) |
| branch-taken check ordering | branch `mpai/acme/auth` exists but worktree dir is gone | existing branch-taken behavior preserved, evaluated against the project-scoped branch name |
| old flat scheme untouched | a legacy `<root>/.mpai/worktrees/<slug>` dir exists | never reused, never deleted, never migrated by any new-scheme call |
| call sites | every `provision(` caller in server.ts | passes the session's projectId; no caller left on the old signature (compiler-enforced) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green
(live provisioning path). Then: `command grep -rn "worktrees" poc/server/src | command grep -v
"worktrees/<" ` shows no remaining single-segment path construction.
**Commit:** `fix(server): project-scoped worktree provisioning — closes debt §2.1`

---

## Task 3: `touched` on SessionFacts *(spec §3.3)*

**Files:** modify `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`; tests
`poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` (extend both).

**Interfaces — produces:** `SessionFacts.touched: string[] | null` (relayProtocol.ts, beside
`repoKey`); `ProjectSessionEntry.touched: string[] | null` storage field (project.ts, default
null) + `sessionFactsOf` copies it into facts. Validation in the facts validator: absent/null
accepted (→ null); else array of strings, each length ≤ 512, array length ≤ TOUCH_CAP + 1;
anything else rejects the frame exactly like other malformed facts fields.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| default | fresh session entry | facts.touched = null |
| carried | entry.touched = ["a.ts","b.ts"] | sessionFactsOf output has exactly that array (copied, not aliased — mutation of the returned facts never mutates the entry) |
| validation accepts | facts frame with touched: [] / ["a.ts"] / absent / null | accepted; absent normalizes to null |
| validation rejects | touched: "x" / [1] / [513-char string] / TOUCH_CAP+2 entries | frame rejected with the existing malformed-facts error path |
| protocol stability | RELAY_PROTOCOL_VERSION | UNCHANGED (additive optional field, spec §3.3); a v2 peer without the field still validates |

**Verify:** `cd poc/server && npx vitest run test/relayProtocol.test.ts test/project.test.ts
&& npx tsc --noEmit` → green; `npm run build`.
**Commit:** `feat(server): touched — repo-relative changed paths on session facts`

---

## Task 4: laptop recompute triggers *(spec §3.2)*

**Files:** modify `poc/server/src/server.ts`; test `poc/server/test/serverTouched.test.ts`
(new; real sessions over a real socket, real temp git worktrees via Task 2's provisioning).

**Interfaces — consumes:** `touchedFiles`/`TOUCH_CAP` (Task 1), `entry.touched` (Task 3),
project-scoped provisioning (Task 2). Produces: no new exports — behavior only.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| turn boundary | a `turn_end` event is appended to a session with a workdir | `touchedFiles(workdir, baseRef)` recomputed; `entry.touched` updated; the existing project push carries the new facts (rides `INTERESTING`) |
| pre-gate | a `permission_request` for a write tool (Edit/Write/NotebookEdit) arrives | recompute BEFORE the gate is offered/answered, so Task 8 judges fresh data |
| no workdir | session without a repo/worktree | touched stays null; no git invocation |
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
export interface CollisionInput {
  sessionId: string;
  repoKey: string | null;
  lifecycle: SessionFacts["lifecycle"];
  touched: string[] | null;
}
export interface Collision { repoKey: string; path: string; sessionIds: string[] }
export function collisionsFrom(sessions: CollisionInput[]): Collision[];
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
| determinism + purity | same input twice, any order | deep-equal output sorted (repoKey, path, sessionIds asc); inputs not mutated |

**Verify:** `cd poc/server && npx vitest run test/collisions.test.ts && npx tsc --noEmit` →
green; `npm run build` (dist gains collisions.js/.d.ts); `command grep -n "from \"node:"
poc/server/src/collisions.ts` → empty (isomorphic).
**Commit:** `feat(server): collisionsFrom — pure per-repo intersection of touched sets`

---

## Task 6: hub `contested` down-frame *(spec §6a)*

**Files:** modify `poc/hub/src/hub.ts`, `poc/server/src/relayProtocol.ts` (down-frame union +
validator); tests `poc/hub/test/contested.test.ts` (new, on the uplink harness),
`poc/server/test/relayProtocol.test.ts` (extend — frame shape).

**Interfaces — produces:** down-frame `{ type: "contested", sessionId: string, paths:
string[] }` (paths ≤ TOUCH_CAP, each ≤ 512 — same bounds as facts.touched). Hub behavior: on
each throttled project push, compute `collisionsFrom` over the project snapshot's sessions; for
every session whose contested-path set CHANGED since last sent to its owning uplink, send one
frame (empty `paths: []` when a session's last collision clears). Consumes `collisionsFrom`
(Task 5), facts.touched (Task 3, already stored/journaled by the hub for free).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| frame on collision | two uplinks' sessions in one repoKey publish overlapping touched | each owning uplink receives `contested` for ITS sessionId listing the shared paths |
| change-only | same collision state across two pushes | no duplicate frame on the second push |
| clear | one session's touched update removes the overlap | affected uplinks receive `paths: []` exactly once |
| offline uplink | collision involves a session whose uplink is offline | no send, no error; frame delivered on next change after reconnect (no replay obligation — the next push recomputes) |
| restart | hub restarts (journal hydration) | collision state recomputed from hydrated facts on the next push; no frames lost that matter (change-detection state MAY reset — a duplicate frame after restart is acceptable and documented) |
| thesis bound | frame contents | ONLY sessionId + paths — no transcript data, no prompts |

**Verify:** `cd poc/hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green;
server-side: `cd poc/server && npx vitest run test/relayProtocol.test.ts` → green, then
`npm run build`.
**Commit:** `feat(hub): contested down-frame — per-session collision signal to owning laptops`

---

## Task 7: laptop contested storage + digest tier (a) *(spec §6a)*

**Files:** modify `poc/server/src/server.ts` (frame handler + storage), `poc/server/src/digest.ts`;
tests `poc/server/test/digest.test.ts` (extend), `poc/server/test/serverContested.test.ts` (new).

**Interfaces — consumes:** the `contested` frame (Task 6), `collisionsFrom` (Task 5).
Produces: `digestFor`'s `<teammates>` block gains contested lines; per-session stored
`contestedPaths: string[]` (server-internal).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| frame stored | `contested` frame arrives for a session | stored; `paths: []` clears it |
| local derivation (solo + same-machine) | two LOCAL sessions overlap | contested lines present with NO hub frame — computed via `collisionsFrom` over the laptop's own project sessions |
| union | both hub frame and local derivation have paths | digest shows the union, deduped |
| digest line | session s2 (driver name resolvable from participants) shares `src/a.ts` | a line of the form `session s2 (driven by <name>) has also changed: src/a.ts` — paths capped at 5 per line with ` +N more` overflow |
| thesis bound | digest content | paths, session ids, names only — never another session's prompts/transcript |
| no collisions | nothing contested | `<teammates>` block unchanged from today (no empty contested section) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green;
`npm run build`.
**Commit:** `feat(server): agents learn contested files — digest tier of awareness`

---

## Task 8: auto-approve withdrawal — tier (b) *(spec §6b)*

**Files:** modify `poc/server/src/permissions.ts`, `poc/server/src/server.ts`; tests
`poc/server/test/permissions.test.ts` (extend), `poc/server/test/serverGateContested.test.ts` (new).

**Interfaces — consumes:** per-session contested set (Task 7), pre-gate recompute (Task 4).
Produces: pure helper in permissions.ts (verbatim):

```ts
export function contestedWrite(
  toolName: string,
  input: unknown,
  workdir: string,
  contested: ReadonlySet<string>,
): string | null;   // returns the repo-relative contested path, else null
```

(resolve `file_path ?? notebook_path` against workdir — the `isContainedWrite` pattern — then
relativize and membership-test.)

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| withdrawal | AUTO-approvable write to a contested path | auto-approval suppressed; the gate asks a human; the gate carries reason `contested with session ${otherSessionId}` (first colliding session by ascending id) |
| once per (file, session) | human answers (allow OR deny); the agent writes the same file again | normal auto-approve rules apply again for that file in that session |
| non-contested write | write to an uncontested path with auto-approve on | auto-approved exactly as today (discriminating row) |
| non-write tools | Bash/Read/etc. on any path | never affected |
| outside worktree | write whose resolved path escapes the workdir | existing isContainedWrite behavior unchanged; contested logic never widens what may be written |
| advisory bound | any collision state | NOTHING is blocked — the only effect is auto → human, once |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit` → WHOLE server suite green;
`npm run build`.
**Commit:** `feat(server): contested writes withdraw auto-approve — asked once per file per session`

---

## Task 9: client session-list surfaces *(spec §5)*

**Files:** create `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts`;
modify `poc/client/src/components/SessionPicker.tsx`.

**Interfaces — consumes (RUNTIME import — first non-type client import of the server pkg):**
`collisionsFrom`, `Collision`, `CollisionInput` from `multiplayer-ai-server/collisions`.
Produces (verbatim — Task 10 depends on these):

```ts
export function projectCollisions(sessions: { sessionId: string; facts: SessionFacts }[]): Collision[];
export function contestedCountFor(sessionId: string, collisions: Collision[]): number;
export function sharedWith(sessionId: string, otherSessionId: string, collisions: Collision[]): string[];
```

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| adapter | snapshot session rows | projectCollisions maps facts → CollisionInput and delegates to collisionsFrom (no reimplementation — asserted by deep-equal against direct collisionsFrom output) |
| repo-group chip | a repo group with ≥1 collision | group head renders `⚠ ${paths} contested` (distinct path count); groups without collisions render exactly as today |
| session-row marker | a session appearing in any Collision | a `contested` marker beside the state badge; CLOSED sessions show both (spec §2.6) |
| calm styling | the chip/marker | uses a non-amber dim/calm class (amber literals reserved for gates — assert the class name, not a color) |
| none | no collisions | zero new DOM (discriminating row) |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run` → WHOLE client suite green; `npm
run build` succeeds AND `command grep -c "collisionsFrom" dist/assets/*.js` ≥ 1 (the runtime
import actually bundles).
**Commit:** `feat(client): contested chips on the session list`

---

## Task 10: client badge + party rows *(spec §5)*

**Files:** modify `poc/client/src/components/Header.tsx`, `poc/client/src/components/PartyPane.tsx`,
`poc/client/src/App.tsx`; test `poc/client/src/components/PartyPane.test.tsx` (new or extend
existing pattern).

**Interfaces — consumes:** Task 9's `projectCollisions`/`contestedCountFor`/`sharedWith`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| header badge | current session has N > 0 contested paths | badge exactly `⚠ CONTESTED ▸ ${N}` beside the PULLS badge; hidden at 0; calm class, not the gate amber |
| party row | an OTHER PARTIES row whose session shares paths with yours | one line `⚠ shares: ${first3.join(", ")}` + ` +${rest} more` when > 3 |
| no collision | no overlap with your session | rows and header exactly as today |
| wiring | App.tsx | collisions computed once per project push (useMemo over project sessions), passed down as props — no per-render recompute of git-scale arrays |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run` → WHOLE client suite green.
**Commit:** `feat(client): contested badge and party-row shares — the awareness surfaces`

---

## Task 11: two-session browser walk *(verification only, no source changes; spec §9 walk row —
steps beyond it are house verification convention)*

**Files:** none (deliverable = walk record in the execution ledger). Each numbered step is
INDEPENDENTLY ledgered; a later failure does not invalidate earlier recorded results.

**Steps (verbatim):**
1. Build all three packages; launch hub (`HUB_DB=$(mktemp -d)/hub.db CLIENT_DIST=poc/client/dist
   PORT=4000 node poc/hub/dist/main.js`); launch ONE laptop (`mpai --hub
   ws://127.0.0.1:4000/uplink --port 3002 --no-open`) from a scratch git repo (NOT port 3001 —
   may be user-occupied).
2. Browser: join project, create session `alpha`, drive one turn that writes a file (e.g.
   `create notes.txt with one line`), wait for turn end.
3. Create session `beta` in the SAME repo, drive a turn editing the SAME file.
4. PASS = after beta's turn ends: header badge `⚠ CONTESTED ▸ 1` in beta's session view; the
   project screen's repo group shows the chip; alpha's OTHER PARTIES row (from beta's view)
   shows `⚠ shares: notes.txt`.
5. Agent tier (a): drive one more beta turn asking the agent `what files are contested right
   now?` — its answer names notes.txt (digest visible to the agent). PASS/FAIL recorded.
6. Agent tier (b): with auto-approve on in beta, ask the agent to edit notes.txt again — PASS =
   the gate ASKS with reason text `contested with session alpha`; approve it; a subsequent edit
   auto-approves (once-per-file proven live).
7. Close alpha; PASS = collision persists and alpha shows CLOSED + contested (spec §2.6).
8. Solo parity: stop hub processes; `mpai --port 3002 --no-open`; repeat steps 2–4 solo (local
   derivation, no hub frames). 9. Shutdown; port sweep clean (3001 excepted if user-occupied).

**Verify:** ledger contains both-mode records incl. the gate-reason text observed verbatim.
**Commit:** none.

---

## Task 12: docs sweep *(spec §8 non-goal 1; PRD §8.8)*

**Files:** modify `docs/PRD.md` (§8.8 Today), `docs/tech-debt.md` (§2.1).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| PRD §8.8 Today | current text | rewritten: collisions shipped (touched facts, collisionsFrom, badge/chip/rows, agent digest + auto-approve withdrawal, on by default, advisory only); "oversight configured hub-side" EXPLICITLY still open (split ruling, spec §8a.1); fork bound restated |
| tech-debt §2.1 | current entry | marked RESOLVED (project-scoped provisioning, this branch) following the file's existing resolved-entry style (see §2.3's); one sentence disclosing the unmigrated old flat worktree scheme |

**Verify:** `command grep -n "CONTESTED\|collisionsFrom\|touched" docs/PRD.md` hits the new
§8.8 text; `command grep -n "RESOLVED" docs/tech-debt.md` includes §2.1;
`git diff --stat docs/` touches only the two files.
**Commit:** `docs: PRD §8.8 Today (collisions shipped) + debt §2.1 resolved`
