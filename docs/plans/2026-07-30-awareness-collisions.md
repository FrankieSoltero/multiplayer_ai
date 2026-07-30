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
  task (1–10b) builds:** each server task's Verify ends in `npm run build`, **each hub task's
  Verify builds `poc/server` BEFORE any hub command runs** (the build is the last step of the
  Verify's server leg, which precedes `cd ../hub`), and each client task's Verify begins with
  `npm --prefix ../server run build`. There is no build carve-out and no task whose artifact is
  published by a later task's build. Since no two implementing tasks may be in flight together
  (1–10b are one exclusion group), no build is ever concurrent with a consumer's read.
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
    facts validator and Task 6's frame validator both import it
    (`import { PATH_WIRE_CAP, TOUCH_CAP } from "./collisions.js"` in `relayProtocol.ts`) and
    neither may re-state `512` as a bare literal. (`relayProtocol.ts` cannot import it from
    `touched.ts` — that module is node-only; `collisions.ts` is the isomorphic home precisely so
    both sides can import it.) The `sessionIds` bounds in Task 6's frame validator (each id ≤ 128
    chars, ≤ 100 ids per entry) are plan-authored inbound-array bounds with no cross-task
    consumer, so they stay inline literals in `relayProtocol.ts` beside the existing
    `MAX_REPOS = 100`.
  - **producer-side per-path rule (plan-authored; spec §3.1/§3.3 set the wire cap but no
    producer rule — resolved here so the two do not contradict):** `touchedFiles` DROPS any
    path longer than `PATH_WIRE_CAP` (512 chars) before the cap/sentinel step. A single pathological
    path therefore costs that path, never the session's whole facts frame (Task 3's validator
    rejects the entire frame on one over-long path). Truncating instead was rejected: a
    truncated path is a *different* path and would false-collide. Owner may override.
  - facts field `touched: string[] | null`.
  - down-frame (spec §8a ruling 6, amends §6a):
    `{ type: "contested", sessionId: string, paths: string[], collisions: { path: string; sessionIds: string[] }[] }`
    — `paths` bound identically to `facts.touched`: length ≤ `TOUCH_CAP + 1`, each ≤
    `PATH_WIRE_CAP`; `collisions` length ≤ `TOUCH_CAP + 1` (one entry per retained path, so it can
    never exceed `paths`), each entry's `path` ≤ `PATH_WIRE_CAP`, each `sessionIds` a NON-EMPTY array of strings,
    each ≤ 128 chars, **at most 100 ids per entry** — plan-authored bound, same posture and
    same number as `relayProtocol.ts`'s existing `MAX_REPOS = 100` inbound-array cap. These are
    the validator's bounds, and Task 6's validator rows assert each one.
  - header badge label `⚠ CONTESTED ▸ ${n}`; session-list repo-group chip label
    `⚠ ${n} contested`. In BOTH literals `n` is a **count**, never a path list — for the badge,
    the distinct contested paths involving this session; for the chip, the distinct contested
    paths in that repo group. Session-row marker label: the exact literal **`⚠ contested`** (no
    count — the row is one session; asserted verbatim by Task 9b's marker row).
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
  - gate reason carrier: `PendingGate.reason: string | null` (`poc/server/src/pendingGate.ts`).
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

## Task Dependency Table

| Task | Files touched | Depends on | Conflicts with (no concurrency) | Risk tier |
|------|---------------|------------|---------------------------------|-----------|
| 1. touchedFiles module | `poc/server/src/touched.ts`, `poc/server/test/touched.test.ts` | 5 | 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | standard |
| 2a. project-scoped worktrees (§2.1) | `poc/server/src/workspace.ts`, `poc/server/src/server.ts` (provision call sites), `poc/server/test/workspace.test.ts` | — | 1, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | judgment |
| 2b. session `workdir`/`baseRef` binding | `poc/server/src/project.ts`, `poc/server/src/server.ts` (session-creation paths), `poc/server/test/project.test.ts` | 2a | 1, 2a, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | judgment |
| 3. facts field `touched` | `poc/server/src/relayProtocol.ts`, `poc/server/src/project.ts`, `poc/server/test/relayProtocol.test.ts`, `poc/server/test/project.test.ts` | 5 | 1, 2a, 2b, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | standard |
| 4. laptop recompute triggers | `poc/server/src/server.ts`, `poc/server/test/serverTouched.test.ts` | 1, 2b, 3 | 1, 2a, 2b, 3, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | judgment |
| 5. collisionsFrom module | `poc/server/src/collisions.ts`, `poc/server/test/collisions.test.ts`, `poc/server/package.json` | — | 1, 2a, 2b, 3, 4, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | standard |
| 6. hub contested down-frame | `poc/hub/src/hub.ts`, `poc/server/src/relayProtocol.ts`, `poc/hub/test/contested.test.ts`, `poc/hub/test/hubRestart.test.ts`, `poc/server/test/relayProtocol.test.ts` | 3, 5 | 1, 2a, 2b, 3, 4, 5, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | judgment |
| 7a. laptop contested storage + local derivation | `poc/server/src/contested.ts` (new), `poc/server/src/server.ts` (frame handler), `poc/server/src/project.ts` (`contestedFrame`), `poc/server/test/serverContested.test.ts`, `poc/server/test/project.test.ts` | 4, 5, 6 | 1, 2a, 2b, 3, 4, 5, 6, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b | judgment |
| 7b. digest tier (a) lines | `poc/server/src/digest.ts`, `poc/server/src/server.ts` (`digestFor` call site + `MPAI_DIGEST_DUMP`), `poc/server/test/digest.test.ts`, `poc/server/test/serverDigestContested.test.ts` | 7a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 8a, 8p, 8b, 9a, 9b, 10a, 10b | judgment |
| 8a. gate reason carrier | `poc/server/src/pendingGate.ts`, `poc/server/src/relayProtocol.ts`, `poc/server/test/pendingGate.test.ts`, `poc/server/test/relayProtocol.test.ts` | — | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8p, 8b, 9a, 9b, 10a, 10b | standard |
| 8p. `contestedWrite` pure predicate | `poc/server/src/permissions.ts`, `poc/server/test/permissions.test.ts` | 7a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9a, 9b, 10a, 10b | standard |
| 8b. auto-approve withdrawal (wiring + bookkeeping + kill switch) | `poc/server/src/server.ts`, `poc/server/src/project.ts` (`contestedAsked`), `poc/server/test/serverGateContested.test.ts` | 4, 7a, 8a, 8p | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 9a, 9b, 10a, 10b | judgment |
| 9a. collisionView adapter | `poc/client/src/collisionView.ts`, `poc/client/src/collisionView.test.ts`, `poc/client/src/types.ts` | 3, 5 | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9b, 10a, 10b | standard |
| 9b. client: session-list surfaces | `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/components/SessionPicker.test.tsx`, `poc/client/src/terminal.css` | 9a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 10a, 10b | standard |
| 10a. client: header badge + App wiring | `poc/client/src/components/Header.tsx`, `poc/client/src/App.tsx`, `poc/client/src/components/Header.test.tsx` | 5, 9a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10b | standard |
| 10b. client: party-pane share rows | `poc/client/src/components/PartyPane.tsx`, `poc/client/src/components/PartyPane.test.tsx` | 9a | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a | standard |
| 11a. browser walk — hub-attached leg (steps 0–7) | ledger record; `docs/tech-debt.md` ONLY on a step-5 FAIL (no source files) | 4, 6, 7b, 8b, 9b, 10a, 10b | — | standard |
| 11b. browser walk — solo parity leg (steps 8a–8f, shutdown 9) | ledger record (no source files, no docs writes) | 11a | — | standard |
| 12. docs sweep | `docs/PRD.md`, `docs/tech-debt.md` | 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p, 8b, 9a, 9b, 10a, 10b, 11a, 11b | — | mechanical |

The table alone is the scheduling contract: a task may start when its Depends-on tasks are
complete AND no Conflicts-with task is in flight (implementation OR verification — a
whole-package-suite run, a whole-package `tsc --noEmit`, or an `npm run build` counts).
Conflicts are **total and symmetric**: the 16 implementing rows (1, 2a, 2b, 3, 4, 5, 6, 7a, 7b,
8a, 8p, 8b, 9a, 9b, 10a, 10b) form ONE exclusion group, so each row's Conflicts cell lists the
other 15 — no exceptions, no dependency-ordered omissions. Re-verified mechanically again after
the cycle-2 edits (which added `poc/client/src/types.ts` to 9a and split Task 11 into 11a/11b —
neither changes the implementing group): every row has exactly 15 entries, every entry appears on
both rows, no
self-reference, no unknown label; 11a, 11b and 12 are serialized by their Depends-on cells and
carry no conflicts. This plan therefore permits NO concurrent writers at all, and 11a/11b/12
depend on the whole group, so tasks execute serially. lean-sdd's pipelining still applies in its read-only
form — a reviewer that only reads the diff and the tree (no suite run, no `tsc`, no build) may
run concurrently with the next task's implementer; a reviewer that executes any verify command
may not.

**Serial execution order (verbatim — the task NUMBERING is not a topological order; do not
execute top-to-bottom).** Task 1 and Task 3 both depend on Task 5, so document order starts with
an unrunnable task. Execute in exactly this sequence, which satisfies every Depends-on cell
above:

`5 → 1 → 2a → 2b → 3 → 4 → 6 → 7a → 7b → 8a → 8p → 8b → 9a → 9b → 10a → 10b → 11a → 11b → 12`

(Numbers were deliberately NOT reassigned: every cross-reference in this plan, in the spec's
§8a rulings and in the two earlier residual reports cites the existing labels.)

**Rationale (server/hub group).** Tasks 1, 2a, 2b, 3, 4, 5, 6, 7a, 7b, 8a, 8p and 8b all write
`poc/server/src` and verify with a whole-package `tsc --noEmit` / whole suite / `npm run build`
over `poc/server` — including Task 6, whose Verify explicitly builds `poc/server` before the hub
suite runs. Shared files sharpen it further (`server.ts`: 2a/2b/4/7a/7b/8b; `relayProtocol.ts`:
3/6/8a; `project.ts`: 2b/3/7a/8b; `pendingGate.ts`: 8a; `permissions.ts`: 8p;
`poc/server/dist/`: every task, since every task builds). Tasks 1, 5 and 7a create new source
files but still typecheck and build the whole package, so they carry the full group's conflicts
too — no "new-file-only means conflict-free" exemption survives in this plan.

**Rationale (client group).** 9a is a pure new module and is upstream of all three client
writers (9b, 10a, 10b all depend on 9a). 9b, 10a and 10b write client component files and each
runs the whole client suite. Under the total-group rule above they all conflict with each other
and with 9a as well, so the dependency edges are belt-and-braces rather than the only guard.
`terminal.css` is written by 9b ONLY (it declares `contested-calm`); 10a merely applies the
class name, which is why 10a's Files cell no longer lists the stylesheet.

**Rationale (cross-group — client tasks are `poc/server/dist/` WRITERS, not readers).** Client
tasks write no server or hub *source* file, but **every client verify in this plan explicitly
builds `../server` first**: each of 9a, 9b, 10a and 10b opens with
`cd poc/client && npm --prefix ../server run build && …` — an issued command, not a
`pretest` hook (`npx vitest run` never fires npm lifecycle scripts, so the hook the earlier
revision leaned on would not have run). Task 9a additionally runs the client `npm run build`
(`tsc -b && vite build`) against that freshly built `dist/`. `poc/server/dist/` is exactly the
shared artifact the server/hub group's own `npm run build` steps write, and this table's own
conflict rule already counts "an `npm run build`" as an in-flight conflict. So 9a, 9b, 10a and
10b are WRITERS of `poc/server/dist/` and carry the full server/hub group in their Conflicts
cells, symmetrically. There is no client/server parallelism in this plan, and no "re-run the
client verify once and call it a read-only race" allowance — a client verify that fails against
a half-written `dist/` is a scheduling violation to be fixed by serialising, not retried.

---

## Task 1: touchedFiles — git-derived changed-path set *(spec §3.1)*

**Files:** create `poc/server/src/touched.ts`; test `poc/server/test/touched.test.ts`.

**Interfaces — produces (verbatim):**

```ts
// TOUCH_CAP / TOUCH_SENTINEL / PATH_WIRE_CAP are DECLARED in collisions.ts (Task 5 — the
// isomorphic module) and re-exported here unchanged, so the isomorphic module never imports this
// node-only one and no consumer sees two copies of a literal. `PATH_WIRE_CAP` lives there rather
// than here because relayProtocol.ts (Tasks 3 and 6) must import it too and cannot import a
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
| over-long path (producer rule) | a changed path longer than `PATH_WIRE_CAP` (512) chars | DROPPED before the cap/sentinel step; every returned path is ≤ `PATH_WIRE_CAP`, so this session's facts frame can never be rejected wholesale by Task 3's validator (paired with Task 3's "producer never emits a rejectable path" row). Not truncated — a truncated path is a different path and would false-collide |
| cap + sentinel | > TOUCH_CAP distinct paths (after the over-long drop) | first TOUCH_CAP after sort, then final element exactly `TOUCH_SENTINEL`; length = TOUCH_CAP + 1 |
| clean worktree | no divergence, nothing uncommitted | `[]` |
| git failure | `workdir` is not a git repo / git exits non-zero | throws (Error carries git's stderr) |
| git timeout | a git invocation exceeds the 5000 ms `execFileSync` timeout | throws, on the same path as any other git failure — Task 4 then keeps the previous `entry.touched` and the gate proceeds |

**Exact values:** `TOUCH_CAP = 500`; `TOUCH_SENTINEL = "…"` (U+2026); `PATH_WIRE_CAP = 512` — all
three DECLARED in `collisions.ts` (Task 5) and re-exported here, never re-declared; git timeout
`5000` ms.
Status parsing must handle the porcelain rename format (`R  old -> new`, both sides
contribute).

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
| cross-project isolation | `provision("acme", "auth", base)` then `provision("beta", "auth", base)` | two DISTINCT worktrees, two branches, two map keys; neither reuses the other (the debt §2.1 failure, now discriminated) |
| same-project idempotence | `provision("acme", "auth", base)` twice | second call reuses the first worktree (existing idempotent-reuse semantics, keyed on `acme/auth`) |
| branch-taken check ordering | branch `mpai/acme/auth` exists but worktree dir is gone | existing branch-taken behavior preserved, evaluated against the project-scoped branch name |
| old flat scheme untouched | a legacy `<root>/.mpai/worktrees/<slug>` dir exists | never reused, never deleted, never migrated by any new-scheme call |
| call sites | every `provision(` caller in server.ts | passes the session's projectId; no caller left on the old signature (compiler-enforced) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE
server suite green (live provisioning path), typecheck clean, build exits 0. Then the mechanical
scheme check: `command grep -n "path.join(this.worktreesRoot" poc/server/src/workspace.ts` →
every hit includes a projectId argument (no single-segment
`path.join(this.worktreesRoot, slug)` remains).
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
server suite green, typecheck clean, build exits 0. Mechanical check:
`command grep -n "baseRef" poc/server/src/server.ts` → every session-creation hit assigns
`entry.baseRef` from the same expression passed to `provision(...)` on that path; no assignment
to `entry.baseRef` introduces a `"main"` literal or a `defaultBranch()` call that the
`provision` argument does not already contain.
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
absent/null accepted (→ null); else array of strings, each length ≤ `PATH_WIRE_CAP`, array length
≤ `TOUCH_CAP + 1` (both imported from `./collisions.js`, never re-declared here); anything else
rejects the frame exactly like other malformed facts fields.

**Downgrade note (journal records outlive a revert; referenced by Task 6).** Once `touched`
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
| validation rejects | touched: "x" / [1] / [a `PATH_WIRE_CAP + 1` = 513-char string] / TOUCH_CAP+2 entries | frame rejected with the existing malformed-facts error path |
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
| git failure | touchedFiles throws | previous `entry.touched` value KEPT (stale beats absent); logged once per session, not per event, with this EXACT line on stderr: ``process.stderr.write(`[touched] session=${sessionId} recompute failed: ${err.message}\n`)`` — asserted verbatim by `serverTouched.test.ts` (prefix `[touched] session=` plus the session id), and a second failure for the same session id emits NOTHING |
| git hangs (bounded stall) | git exceeds `touchedFiles`' 5000 ms timeout (Task 1) during a PRE-GATE recompute | treated exactly as a git failure: previous `entry.touched` KEPT, the gate PROCEEDS (never blocked, never delayed past the timeout), logged once per session. **Accepted blast radius, stated plainly (Task 1's "Blast radius of the synchronous call"):** `execFileSync` blocks the whole laptop process for that interval — every session's socket traffic, the 1s project push and every other pending gate are frozen, not just this gate. 5000 ms is the whole-process ceiling. **Ruled accepted (spec §8a.8); revisit only on an observed freeze** — not an executor decision |
| no recompute storms | non-write tools, non-boundary events | no git invocation (discriminate: a `tool_call` Read appends → no recompute) |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE
server suite green (edits the live server), typecheck clean, build exits 0.
**Commit:** `feat(server): recompute a session's touched set at turn boundaries and write gates`

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
// relayProtocol.ts (Tasks 3 and 6) could not import PATH_WIRE_CAP from a node-only module at all.
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

## Task 6: hub `contested` down-frame *(spec §6a as amended by §8a ruling 6)*

**Files:** modify `poc/hub/src/hub.ts`, `poc/server/src/relayProtocol.ts` (down-frame union +
validator); tests `poc/hub/test/contested.test.ts` (new, on the uplink harness),
`poc/hub/test/hubRestart.test.ts` (extend — the §8.7 restart harness, spec §9 Testing),
`poc/server/test/relayProtocol.test.ts` (extend — frame shape + validation).

**Interfaces — produces:** down-frame (exact, spec §8a ruling 6)

```ts
{ type: "contested",
  sessionId: string,
  paths: string[],                                        // ≤ TOUCH_CAP + 1, each ≤ PATH_WIRE_CAP
  collisions: { path: string; sessionIds: string[] }[] }  // the colliding peers, so the
                                                          // laptop can NAME them (spec §6)
```

`paths` is exactly the distinct path set of `collisions`, sorted ascending; `sessionIds`
excludes nothing — the recipient's own id IS present, matching `collisionsFrom`'s output shape.
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

**Hub behavior — exact site and store.** The hook is `pushProject(projectId)` in
`poc/hub/src/hub.ts:142` (the function `schedulePush`, `hub.ts:167`, throttles at 1s
leading+trailing). At the END of each `pushProject` body, after the project snapshot is built:
compute `collisionsFrom` over the snapshot's sessions, then for every session in the snapshot
whose contested state CHANGED since the last frame sent to its owning uplink, send one frame
(empty `paths: []` **and** `collisions: []` when a session's last collision clears). Consumes
`collisionsFrom` (Task 5), `facts.touched` (Task 3, already stored/journaled by the hub for
free).

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
| validation rejects — `paths` (relayProtocol) | inbound `contested` frame with `paths: "x"` / a `PATH_WIRE_CAP + 1` = 513-char path / TOUCH_CAP+2 entries | frame rejected with the existing malformed-frame error path — never partially applied |
| validation rejects — `collisions` (relayProtocol, explicit bounds) | inbound frame with `collisions: "x"` / TOUCH_CAP+2 collision entries / an entry missing `sessionIds` / `sessionIds: [1]` / `sessionIds: []` (empty) / a `sessionIds` string > 128 chars / 101 ids in one entry / an entry whose `path` is 513 chars | each rejected with the same malformed-frame error path. Bounds are the Global-Constraints ones: `collisions` length ≤ `TOUCH_CAP + 1`, `path` ≤ `PATH_WIRE_CAP` (imported, never re-stated as `512`), `sessionIds` non-empty, each id a string ≤ 128 chars, ≤ 100 ids per entry (these two are inline literals beside the existing `MAX_REPOS = 100`, per Global Constraints) |
| offline uplink | collision involves a session whose uplink is offline | no send, no error; frame delivered on next change after reconnect (no replay obligation — the next push recomputes) |
| uplink reconnect / laptop restart (discriminating) | an uplink with a contested session disconnects and re-registers; the collision set is UNCHANGED throughout | that session's `lastContestedSent` entry was deleted on disconnect/re-registration, so the first `pushProject` after re-registration RE-SENDS the identical frame — an implementation that only compares by value must fail this row (it would send nothing and leave the reconnected laptop with no hub-sourced contested state) |
| restart preserves touched | hub restarts and hydrates from the journal (extends `poc/hub/test/hubRestart.test.ts`) | each hydrated `SessionFacts.touched` deep-equals what was journaled before the restart; the first post-restart push recomputes collisions from it and emits frames matching pre-restart state (change-detection state MAY reset — one duplicate frame after restart is acceptable and documented) |
| old laptop / unknown down-frame (compat) | a laptop built before this task receives a `type: "contested"` frame | the frame is IGNORED by the unknown-frame path; the uplink is NOT disconnected and no error surfaces. `RELAY_PROTOCOL_VERSION` stays **UNCHANGED** — a PLAN-AUTHORED reading (spec §3.3 grants the no-bump exemption to an additive optional FIELD; applying it to a whole new frame type is this plan's extension, registered with the other plan-authored decisions and justified by exactly this row's unknown-frame ignore path). Bumping the version instead would be an owner override |
| thesis bound | frame contents | ONLY sessionId, paths and colliding session ids — no transcript data, no prompts, no names |

**Risk / rollback (no runtime switch — deliberate).** `MPAI_CONTESTED_GATE` (Task 8b) covers
tier (b) on the laptop ONLY. The hub's `collisionsFrom` computation and the `contested`
down-frame have **no runtime switch**: their disable path is a `git revert` of this task's
commit followed by a rebuild, a restart, and a laptop-side step. The full procedure, in order:

1. `git revert` this task's commit, then `npm --prefix poc/hub run build`, then restart the hub
   (the hub is a long-lived process; a revert does not take effect in a running one). If the hub
   is ever run as a shared/deployed process rather than the local :4000 walk process, this step
   is a redeploy rather than a restart.
2. **Laptop side (required — the revert alone does not restore prior behavior).** Every attached
   laptop keeps its last-received `entry.contestedFrame` (Task 7a, in-memory) and would go on
   withdrawing auto-approve on stale hub-sourced peers. Set `MPAI_CONTESTED_GATE=0` on every
   attached laptop — or restart the laptop process — so tier (b) stops acting on the last
   received frame.
3. Tier (a) surfaces need no separate step: local derivation is computed on read, so hub-sourced
   contested state clears on the next laptop restart and locally-derived state remains correct
   throughout.

Reverting does NOT remove `touched` values already written to the hub journal — those rows keep
the field and are ignored by the field-unaware reader (Task 3's downgrade note).

**Verify (server build FIRST — the hub resolves `relayProtocol` through the package exports map
from `dist/`, so a hub suite run before the build would exercise the pre-task `dist/`):**
`cd poc/server && npx vitest run test/relayProtocol.test.ts && npx tsc --noEmit && npm run build`
→ targeted server tests green, typecheck clean, build exits 0. THEN
`cd ../hub && npx vitest run && npx tsc --noEmit` → WHOLE hub suite green.
**Commit:** `feat(hub): contested down-frame — per-session collision signal to owning laptops`

---

## Task 7a: laptop contested storage + local derivation *(spec §6a)*

**Files:** create `poc/server/src/contested.ts` (the two accessors); modify
`poc/server/src/server.ts` (inbound `contested` frame handler only),
`poc/server/src/project.ts` (the `contestedFrame` field on `ProjectSessionEntry`); tests
`poc/server/test/serverContested.test.ts` (new), `poc/server/test/project.test.ts` (extend —
shared with Tasks 2b and 3, both of which conflict with this task).

**Interfaces — consumes:** the `contested` frame (Task 6), `collisionsFrom` (Task 5), the
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
| unknown session (accessor side) | `contestedFor(project, "nope")` | empty set; never throws |
| frame for unknown session (inbound side, discriminating) | a validated `contested` frame arrives whose `sessionId` is not in this laptop's project map — e.g. it raced a session removal, or names a session owned by another uplink | frame **DROPPED**: no `ProjectSessionEntry` is created, nothing is stored anywhere, no throw, no uplink disconnect, and at most one log line per session id — that line EXACTLY: ``process.stderr.write(`[contested] session=${sessionId} unknown session, frame dropped\n`)``, asserted verbatim, with a second frame for the same unknown id emitting NOTHING. A later `contested` frame for a session that DOES exist is still applied normally |
| thesis bound | accessor outputs | paths and session ids only — no prompts, no transcript, no file contents |

**Verify:** `cd poc/server && npx vitest run && npx tsc --noEmit && npm run build` → WHOLE
server suite green, typecheck clean, build exits 0.
**Commit:** `feat(server): laptop contested storage — hub frame ∪ local derivation`

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
`MPAI_DIGEST_DUMP=1 node poc/server/bin/mpai.js … 2> /tmp/mpai-walk-laptop.log` —
`command grep -n "\[digest-dump\] session=beta" /tmp/mpai-walk-laptop.log | tail -1`, which
prints the line to paste verbatim into the ledger. Env var read per call, never cached; when
unset the emit is one comparison and no output, so default behavior is byte-identical to today.
It is a debug facility, not a product surface: it writes to the laptop's OWN stderr, crosses no
session boundary, and is listed with the plan-authored decisions in the residuals section.
**Handling of the capture file.** The dump line contains peer paths, session ids and driver names
(the same class of content as the walk ledger itself), so wherever that stderr is REDIRECTED to a
file — Task 11a step 1 and Task 11b step 8a send it to `/tmp/mpai-walk-*.log` — the capture file
inherits the ledger's handling: it is read, its evidence line is pasted into the ledger, and the
file is deleted at walk shutdown (Task 11b step 9). Never leave a walk log on a shared machine.

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
| validation rejects | `reason: 7` / `reason: {}` / a string longer than 512 chars (the gate-reason cap — a SEPARATE bound from `PATH_WIRE_CAP`, deliberately the same number; it stays an inline literal in `pendingGate.ts`/`relayProtocol.ts` because no other task consumes it) | frame rejected with the existing malformed-frame error path — never partially applied |
| protocol stability | `RELAY_PROTOCOL_VERSION` | UNCHANGED (additive optional field, same posture as Task 3); a peer that ignores `reason` still validates and still renders the gate |
| no policy yet (discriminating) | the whole server suite on this commit | no gate anywhere sets a non-null reason — this task ships the carrier only; Task 8b supplies the first writer |

**Verify:** `cd poc/server && npx vitest run test/pendingGate.test.ts test/relayProtocol.test.ts
&& npx tsc --noEmit` → targeted files green; then `npx vitest run` → WHOLE server suite green;
then `npm run build` → exits 0.
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
  workdir: string,
  contested: ReadonlySet<string>,
): string | null;   // returns the repo-relative contested path, else null
```

(resolve `file_path ?? notebook_path` against workdir — the `isContainedWrite` pattern — then
relativize and membership-test.)

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| write tool on a contested path | `toolName` Edit / Write / NotebookEdit, `input.file_path` (or `input.notebook_path`) resolving inside `workdir` to a member of `contested` | returns that repo-relative path, character-exact |
| write tool on an uncontested path | same shapes, path not in `contested` | `null` |
| non-write tools (discriminating) | Bash / Read / Grep / any other tool name, even with a `file_path` naming a contested path | `null` — the predicate never fires for a non-write tool |
| escapes the worktree | resolved path outside `workdir` (`../`, absolute elsewhere, symlink-style traversal string) | `null`; the existing `isContainedWrite` containment rule is reused unchanged and this predicate never widens what may be written |
| malformed input | `input` null / not an object / no path key / path not a string | `null`; never throws |
| empty contested set | `contested.size === 0` | `null` for every input |
| purity | any call | no env read, no filesystem access, no mutation of `input` or `contested` |

**Verify:** `cd poc/server && npx vitest run test/permissions.test.ts && npx tsc --noEmit` →
targeted file green; then `npx vitest run` → WHOLE server suite green; then `npm run build` →
exits 0. Plus the discriminating no-caller check:
`command grep -rn "contestedWrite" poc/server/src` → hits ONLY in `permissions.ts` on this
commit (Task 8b supplies the first caller).
**Commit:** `feat(server): contestedWrite — pure predicate for writes to contested paths`

---

## Task 8b: auto-approve withdrawal — tier (b) wiring *(spec §6b, §8a ruling 4)*

**Files:** modify `poc/server/src/server.ts` (gate path wiring + the `MPAI_CONTESTED_GATE`
read), `poc/server/src/project.ts` (`contestedAsked`); test
`poc/server/test/serverGateContested.test.ts` (new).

**Interfaces — consumes:** `contestedWrite` (Task 8p — the predicate, called from the gate
path), `contestedFor(project, sessionId)` and `contestedSessionsFor(project, sessionId, path)`
(Task 7a — these exact names, via `import { contestedFor, contestedSessionsFor } from
"./contested.js"`), pre-gate recompute (Task 4), `PendingGate.reason` and its gate frame
(Task 8a — this task is the first writer of that field). Produces no new exports: the gate path
calls `contestedWrite(toolName, input, entry.workdir, contestedFor(project, sessionId))` and,
on a non-null result, suppresses the auto-approval and sets the reason.

**Bookkeeping (once per file per session):** `ProjectSessionEntry.contestedAsked: Set<string>`
(repo-relative paths), in `poc/server/src/project.ts`. A path is added when a human answers a
contested gate for it (allow OR deny). It is **never** cleared while the session lives — see
the behavior rows.

**Kill switch (spec §8a ruling 4):** env `MPAI_CONTESTED_GATE`; the exact value `"0"` disables
this task's behavior entirely. Read once per gate decision (not cached at boot) so an operator
can flip it without a restart. Tier (a) surfaces (Task 7b digest, client UI) are NOT gated by
it, and that absence is deliberate: tier (a) mutates no shared state and changes no control
flow — it adds bounded advisory text (≤ 5 paths + ` +N more` per peer, Task 7b) and read-only
DOM. Its disable path is therefore a `git revert` of the Task 7b / 9b / 10a / 10b commits, which touch
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
| non-write tools | Bash/Read/etc. on any path | never affected (end-to-end at the gate; the predicate-level row lives in Task 8p) |
| outside worktree | write whose resolved path escapes the workdir | existing isContainedWrite behavior unchanged; contested logic never widens what may be written |
| advisory bound | any collision state | NOTHING is blocked — the only effect is auto → human, once |

**Verify:** `cd poc/server && npx vitest run test/serverGateContested.test.ts &&
npx tsc --noEmit` → the new file green; then `npx vitest run` → WHOLE server suite green; then
`npm run build` → exits 0.
**Commit:** `feat(server): contested writes withdraw auto-approve — asked once per file per session`

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

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| repo-group chip | a repo group with ≥1 collision | group head renders exactly `⚠ ${n} contested` where `n` = the distinct contested path COUNT for that repo group (a number, never a path list — e.g. `⚠ 2 contested`, never `⚠ src/a.ts,src/b.ts contested`); groups without collisions render exactly as today |
| session-row marker | a session appearing in any Collision | a marker beside the state badge rendering the EXACT literal `⚠ contested` (no count — the row is one session; Global Constraints); CLOSED sessions show both markers (spec §2.6) |
| calm styling | the chip/marker | carries class `contested-calm` (assert the class name, not a color) AND the class is DECLARED in `terminal.css` as `.contested-calm { color: var(--gold); border-color: var(--gold); background: var(--gold-wash); }` — the existing awareness tokens at `terminal.css:35` and `:42`; no `--amber*` token appears in the rule |
| none | no collisions | zero new DOM (discriminating row) |

**Verify:** `cd poc/client && npm --prefix ../server run build && npx tsc -b && npx vitest run
src/components/SessionPicker.test.tsx` → server build exits 0 (explicit — no `pretest` hook
fires under `npx vitest run`), then the new file's cases green (each shown RED on pre-task code
first, per the TDD constraint); then `npx vitest run` → WHOLE client suite green. Plus
`command grep -n "contested-calm" poc/client/src/terminal.css` → the class is DEFINED (a rule
body, not just a class reference), and — anchored to the RULE BODY, not to a single line, because
a one-line pipeline passes vacuously the moment the rule is formatted across several lines —
`command grep -A3 '^\.contested-calm' poc/client/src/terminal.css | command grep -c 'amber'` →
prints exactly `0` (the rule's declaration line plus its next 3 lines contain no amber token).
The rule is authored as ≤ 4 lines (selector + the three declarations in Global Constraints), so
`-A3` covers its whole body; a longer rule must widen the `-A` count to match.
**Commit:** `feat(client): contested chips on the session list`

---

## Task 10a: client header badge + App wiring *(spec §5)*

**Files:** modify `poc/client/src/components/Header.tsx`, `poc/client/src/App.tsx`; create
`poc/client/src/components/Header.test.tsx` (**new** — it does not exist in the repo today;
follow the `ProjectPicker.test.tsx` / `RecordPanel.test.tsx` pattern). Render tests over
`collisionsFrom` fixtures (spec §9). **No stylesheet edit:** `contested-calm` is declared by
Task 9b; this task only applies the class name.

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

**Memoization is deliberately NOT test-asserted.** The `useMemo` above exists so a git-scale
array is not re-intersected on every render, but the client has no App-level test file
(`poc/client/src/App.test.tsx` does not exist) and this task does not add one — an App render
harness is a larger piece of work than the wiring it would guard. So the memo is stated as a
requirement of the diff and verified by review of that diff, and this task's Verify makes no
claim about it. Every row in the table below IS asserted by `Header.test.tsx`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| header badge | `contested` prop puts the current session in N > 0 contested paths | badge exactly `⚠ CONTESTED ▸ ${N}` beside the PULLS badge; class `contested-calm`, not the gate amber |
| badge hidden at 0 (discriminating) | current session has 0 contested paths | NO badge node rendered at all — not an empty one |
| prop absent | `Header` rendered with no `contested` prop at all (every pre-existing call site) | renders exactly as today — no badge node, no crash |

**Verify:** `cd poc/client && npm --prefix ../server run build && npx tsc -b && npx vitest run
src/components/Header.test.tsx` → server build exits 0 (explicit — `npx vitest run` fires no
`pretest`), then the new file's cases green (each shown RED on pre-task code first); then
`npx vitest run` → WHOLE client suite green.
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

**PID-file hygiene (binding — a stale PID file is a loaded gun on a shared machine).** A fixed
path like `/tmp/mpai-walk-hub.pid` left behind by an aborted earlier walk can name a PID the OS
has since recycled onto someone else's process, so `kill $(cat …)` would signal a stranger.
Two rules, both mandatory:

1. **Write only after clearing.** Before every `echo $! > <pidfile>` in this walk, run
   `rm -f <pidfile>` on that exact path (steps 1 and 8a). Ledger the three paths in use:
   `/tmp/mpai-walk-hub.pid`, `/tmp/mpai-walk-laptop.pid`, `/tmp/mpai-walk-solo.pid`.
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
   step 8a runs from a `mktemp -d` scratch repo where a relative path would resolve to nothing.
   The variable must be exported into (or re-captured in) whatever shell runs step 8a. Then run
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
   echo $! > /tmp/mpai-walk-hub.pid`. Launch ONE laptop from a scratch git repo **with the
   digest dump enabled and stderr captured** (steps 5 and 8e read that file), recording its
   PID — invoke the CLI by path, do NOT assume a global binary is installed:
   `MPAI_DIGEST_DUMP=1 node poc/server/bin/mpai.js --hub ws://127.0.0.1:4000/uplink --port 3002
   --no-open 2> /tmp/mpai-walk-laptop.log & echo $! >
   /tmp/mpai-walk-laptop.pid` (NOT port 3001 — may be user-occupied). *(If `mpai` is already on
   PATH via `npm --prefix poc/server link`, `mpai …` is equivalent; ledger which form was used.)*
   Ledger both PIDs. PASS = both PIDs recorded, the hub answering on :4000 and the laptop on
   :3002. (Ledgered; not a plan-level Done-criteria step.)
2. Browser: open `http://127.0.0.1:3002`, join the project, create session `alpha`, drive one
   turn that writes the file `notes.txt` (prompt: `create notes.txt with one line`) — the file
   name is load-bearing, steps 4/5/6 and 8d/8e/8f all assert on `notes.txt` literally — and wait
   for turn end. PASS = the turn ends, `notes.txt` is present in alpha's worktree, and alpha is
   listed in the session list. (Ledgered; not a plan-level Done-criteria step.)
3. Create session `beta` in the SAME repo, drive a turn editing the SAME file with the exact
   prompt `add a second line to notes.txt`. PASS = the turn ends and `notes.txt` is modified in
   beta's worktree. (Ledgered; not a plan-level Done-criteria step.)
4. PASS = after beta's turn ends: header badge `⚠ CONTESTED ▸ 1` in beta's session view; the
   project screen's repo group head shows the chip `⚠ 1 contested`; alpha's OTHER PARTIES row
   (from beta's view) shows `⚠ shares: notes.txt`. (Required PASS for plan-level done.)
5. Agent tier (a): drive one more beta turn asking the agent `what files are contested right
   now?`. **Pin the input with a runnable command, not just prose:** the laptop was launched at
   step 1 with `MPAI_DIGEST_DUMP=1` and stderr captured (Task 7b's dump), so run
   `command grep -n "\[digest-dump\] session=beta" /tmp/mpai-walk-laptop.log | tail -1` and paste
   that single line into the ledger verbatim; confirm it contains `notes.txt`. (If the file has
   no such line, the dump did not fire — that is a step-5 FAIL, ledger it as one.)
   **Consequence:** PASS = the digest contains `notes.txt` AND the agent's answer names it.
   FAIL is admissible ONLY with (a) the verbatim `digestFor` dump pasted into the ledger and
   (b) a follow-up entry filed in `docs/tech-debt.md`; a bare "FAIL recorded" does not satisfy
   the plan-level Done criteria.
6. Agent tier (b): with auto-approve on in beta (and `MPAI_CONTESTED_GATE` unset), drive a turn
   with the exact prompt `append a second line to notes.txt` — PASS = the gate ASKS with reason
   text `contested with session alpha` observed verbatim; approve it; then drive one more turn
   with the exact prompt `append a third line to notes.txt`, which auto-approves (once-per-file
   proven live). (Required PASS.)
7. Close alpha; PASS = collision persists and alpha shows CLOSED + contested (spec §2.6).
   (Required PASS.)

**Verify (11a):** ledger contains steps 0–7 each independently recorded, with steps 4, 6 and 7
PASS, step 6's gate-reason text `contested with session alpha` pasted verbatim, and step 5's
`[digest-dump]` line pasted verbatim (PASS, or FAIL under the Done-criteria allowance). The hub
and laptop processes are LEFT RUNNING for Task 11b, which stops them at its step 8a; their PID
files stay in place.
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
     local derivation from hub-sourced state. Only once both ports are empty:
     `rm -f /tmp/mpai-walk-solo.pid`, create a fresh scratch git repo (`mktemp -d` + `git init`)
     and launch solo from it, same invocation form as 11a step 1 (dump enabled, stderr captured
     to a FRESH log so step 8e cannot read step 5's lines), using the `$REPO_ROOT` captured at
     11a step 0 — the scratch repo is not the plan's repo, so a relative path would resolve to
     nothing:
     `MPAI_DIGEST_DUMP=1 node "$REPO_ROOT"/poc/server/bin/mpai.js --port 3002 --no-open
     2> /tmp/mpai-walk-solo.log & echo $! > /tmp/mpai-walk-solo.pid`. PASS = both old PIDs gone
     (identity-checked before each kill), the absence gate empty on both ports, and the solo
     laptop — the newly recorded PID and no other process — serving on 3002.
   - **8b.** Open `http://127.0.0.1:3002`, join the project, create session `gamma`, drive one
     turn with the exact prompt `create notes.txt with one line` (byte-identical to 11a step 2).
     PASS = turn ends, `notes.txt` present in gamma's worktree, session listed.
   - **8c.** Create session `delta` in the SAME fresh repo, drive a turn with the exact prompt
     `add a second line to notes.txt` (byte-identical to 11a step 3). PASS = turn ends.
   - **8d.** UI parity (solo repeat of step 4): PASS = badge `⚠ CONTESTED ▸ 1` in delta's view,
     repo-group chip `⚠ 1 contested`, gamma's OTHER PARTIES row shows `⚠ shares: notes.txt` — all from
     LOCAL derivation, with no hub running. (Required PASS.)
   - **8e.** Tier (a) parity (solo repeat of step 5), same runnable capture:
     `command grep -n "\[digest-dump\] session=delta" /tmp/mpai-walk-solo.log | tail -1` → the
     line is pasted into the ledger verbatim and contains `notes.txt`. (Required PASS.)
   - **8f.** Tier (b) parity (solo repeat of step 6), same exact prompts: drive a turn with
     `append a second line to notes.txt` — PASS = the gate ASKS with reason text
     `contested with session gamma` observed verbatim, proving local derivation alone names the
     colliding session; approve it, then drive `append a third line to notes.txt`, which
     auto-approves. (Required PASS.)
9. Shutdown, identity-checked exactly as at 8a:
   `ps -p $(cat /tmp/mpai-walk-solo.pid) -o command=` must contain `poc/server/bin/mpai.js` →
   then `kill $(cat /tmp/mpai-walk-solo.pid)`; on a mismatch do not kill, ledger and `rm -f`.
   Then `rm -f /tmp/mpai-walk-hub.pid /tmp/mpai-walk-laptop.pid /tmp/mpai-walk-solo.pid` so the
   next walk cannot inherit these paths. **Then delete the capture logs, once their evidence
   lines are already pasted into the ledger (steps 5 and 8e):**
   `rm -f /tmp/mpai-walk-laptop.log /tmp/mpai-walk-solo.log`. They hold peer paths, session ids
   and driver names at fixed, predictable paths on a machine this plan repeatedly calls shared
   (Task 7b's capture-file handling note), so leaving them behind is the same class of hazard as
   a stale PID file. Sweep = `lsof -ti :4000; lsof -ti :3002`
   both return EMPTY — meaningful only because step 0 established that both were empty to begin
   with (or ledgered the substituted ports, which are the ones swept here). Port 3001 is out of
   scope (may be user-occupied) and is never touched.

**Verify (11b):** ledger contains steps 8a–8f and 9 each independently recorded, with 8d, 8e and
8f PASS, step 8f's gate-reason text `contested with session gamma` pasted verbatim, step 8e's
`[digest-dump]` line pasted verbatim, and step 9's sweep showing both ports empty and all three
PID files plus both capture logs removed. Together with 11a's record this is the "both-mode"
walk evidence the plan-level Done criteria require.
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
2. **Frame-bound harmonization (D3/V9).** ~~Task 6 states the `paths` bound as a plan-authored
   harmonization…~~ **Superseded in round 3:** the caveat is withdrawn. Spec §3.1's "capped at
   `TOUCH_CAP`" already means "≤ TOUCH_CAP paths plus the sentinel slot" (§3.3 spells it as
   `≤ TOUCH_CAP + 1`), so §6a's identical phrase carries the identical bound. No additional
   ruling is needed and there is no plan/spec divergence to reconcile. (Spec §8a ruling 7 exists
   and rules on a different subject — old-scheme worktree orphaning.) See Task 6's note.
3. **Walk discrimination (D6/V25).** Task 11a steps 1–7 are relabelled "hub attached, derivation
   source not discriminated" instead of adding a second laptop; Task 6's hub suite carries the
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

### Plan-authored decisions (closed here; owner may override)

These are recorded, not escalated — each is a decision the plan makes explicitly so no reviewer
reads it as drift:

- **`COLLISIONS_MODULE_ID` (Task 5).** Not in spec §4's surface; exists only as Task 9a's
  minification-stable bundle anchor. Droppable in favour of the node smoke check alone.
- **`workdir`/`baseRef` as `ProjectSessionEntry` fields (Task 2b).** Spec §3.1/§3.2 require the
  inputs; storing them on the session entry rather than re-deriving is this plan's choice.
- **No protocol bump for the new `contested` frame type (Task 6).** Spec §3.3 grants the
  no-bump exemption to an additive optional FIELD; applying it to a wholly new down-frame type is
  this plan's reading, justified by the unknown-frame ignore path (Task 6's compat row: an old
  laptop ignores the frame and is not disconnected). If the owner wants `RELAY_PROTOCOL_VERSION`
  bumped for a new frame type, say so and Task 6 bumps it.
- **`MPAI_DIGEST_DUMP` (Task 7b).** An env-gated stderr dump added so Task 11a step 5 and Task 11b step 8e
  cite a runnable capture command instead of a mechanism that did not exist. Off by default;
  laptop-local; no cross-session exposure. The alternative the council offered — replacing the
  walk's ledger evidence with a server-suite assertion — was rejected because it would stop
  pinning the LIVE turn's digest, which is the whole point of step 5.
- **`collisions` inbound bounds (Task 6).** `collisions` ≤ `TOUCH_CAP + 1`, `sessionIds`
  non-empty, ids ≤ 128 chars, ≤ 100 ids per entry — spec fixes the shape, not the bounds; the
  numbers follow `relayProtocol.ts`'s existing `MAX_REPOS = 100` posture.
- **§6a `paths` bound read as `TOUCH_CAP + 1` (Task 6).** Consistent reading of §3.1/§3.3; if
  the owner reads §6a as a flat 500 including the sentinel, Task 6 drops to `TOUCH_CAP − 1`
  paths + sentinel and Task 3's facts bound is unaffected.
- **Client wiring shape (Tasks 9a / 9b / 10a / 10b).** `projectCollisions` takes the client's own
  snapshot row type `ProjectSessionInfo[]` (Task 9a adds the mirrored `touched?: string[] | null`
  field to `poc/client/src/types.ts`); 9b and 10b each compute collisions inside their component
  from data they already hold, and only 10a touches `App.tsx`, passing `Header` one new OPTIONAL
  `contested?: Collision[]` prop. The alternative — one App-level computation fanned out as
  required props to all three components — would put `App.tsx` in three tasks' file lists. The
  App-level `useMemo` is stated as a diff requirement and deliberately NOT test-asserted (no
  App-level test file exists and this plan does not add one).
- **Digest 5-path cap vs party-row 3-path cap (Tasks 7b / 10b).** Different counts on purpose,
  shared ` +N more` phrasing and `", "` separator; spec sets neither cap.
- **Over-long paths dropped producer-side; walk discrimination label** — carried forward from
  the round-2 residuals above, unchanged.
