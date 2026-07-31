# Plan review — Sub-sessions (PRD §8.4)

**Plan:** `docs/plans/2026-07-31-sub-sessions.md`
**Spec:** `docs/specs/2026-07-31-sub-sessions-design.md`
**Council:** soltero-skills:plan-review bundled workflow (6 graders, skeptics on ≥90, deterministic gate).

---

## Round 1 — 2026-07-31

### ⛔ BLOCKED — do not execute (round 1)

Overall **85.2** (threshold 85 ✓) but **D4 Concreteness 78 < 80 floor**. Zero blocking-severity
violations; all 19 findings minor/mechanical, no owner questions.

| Dimension | Weight | Grader | Skeptic misses | Final |
|---|---|---|---|---|
| D1 Decomposition & ordering | 15 | 87 | 0 | 87 |
| D2 Verifiability | 20 | 91 | 4 | 84 |
| D3 Spec fidelity & traceability | 20 | 87 | 0 | 87 |
| D4 Concreteness | 15 | 92 | 3 | **78** |
| D5 Risk & reversibility | 15 | 87 | 0 | 87 |
| D6 Consistency & completeness | 15 | 88 | 0 | 88 |
| **Overall** | | | | **85.2 — BLOCKED (floor)** |

### Findings (all minor, all mechanical) → fixes applied post-round-1

- **D1** (2): Task 1 bundles gate-attribution + task-join → justified as atomic (same three
  files + same test files; splitting only serializes). Task 4 bundling STOP with rail →
  deliberate-cohesion note added.
- **D2** (5): per-task Verify lines gained concrete observables ("vitest exits 0, 0 failures")
  plus a behavior-table coverage check; Task 4's procedure-less manual note dropped in favor of
  the automated row; plan-level done gate added.
- **D3** (3): spec citations added to every task header; §2.1's task-join enrichment
  (status/summary) now surfaced as a Task 4 view-header behavior row; §2.5's no-cap/horizontal
  scroll default added as a Task 4 row.
- **D4** (5, the floor breach): approximate anchors (":824 area", ":895 region") replaced with
  structural/symbol anchors; the fictional "stats bar" mount landmark replaced with the real
  anchor (`App.tsx` `<div className="row">` container, immediately before `<Transcript>`);
  label resolution for Transcript pinned exactly (`deriveSubSessions(events)` indexed by key);
  the task-join scope row rewritten in wire subtypes (`progress`/`updated`/`done`).
- **D5** (3): rollback note added (revert-commit; optional non-load-bearing fields, no
  migration); Task 4's inert-for-existing-sessions no-flag justification made explicit;
  deploy-ordering note added (server-first and client-first both safe).
- **D6** (1): behavior row added — a gate is *decidable* (not just rendered) from inside a
  sub-session view.

Fixer note: fixes were applied by the controller as mechanical plan edits; the verdict above is
unchanged by the fixer. Round 2 re-convenes the full council on the edited plan.

## Round 2 — 2026-07-31

### ⛔ BLOCKED — do not execute (round 2)

Overall **85.0** (threshold met), no floor breaches — but **1 blocking violation** (D6).

| Dimension | Weight | Grader | Skeptic misses | Final |
|---|---|---|---|---|
| D1 Decomposition & ordering | 15 | 92 | 1 | 83 |
| D2 Verifiability | 20 | 88 | 0 | 88 |
| D3 Spec fidelity & traceability | 20 | 87 | 0 | 87 |
| D4 Concreteness | 15 | 91 | 4 | 82 |
| D5 Risk & reversibility | 15 | 92 | 1 | 88 |
| D6 Consistency & completeness | 15 | 92 | 2 | 80 |
| **Overall** | | | | **85.0 — BLOCKED (blocking violation)** |

**The blocking violation (D6):** spec §3 mandates an interleaved-concurrent-sub-agents
attribution test; Task 1's behavior table had no such row, and Task 1's own coverage-check
Verify gate made the omission self-enforcing (no row ⇒ no test, guaranteed). **Fix applied:**
"interleaved concurrency" row added to Task 1 (two active parents, out-of-order deletes, no
cross-attribution).

**Minor fixes also applied:** Goal reworded to "two optional wire fields"; SdkMessage
declaration site, `pendingPermissions` post-change shape, `permissions.ts:337` driver-ask line,
and `subagentType` join path pinned; stale-map-entry blast-radius note (unique tool_use ids ⇒
no misattribution); constraint 9 grounded (loose client type by construction + Task 2's
old-event fixture named as the cross-version proof); types.ts note de-whiplashed; Task 3
cohesion rationale added; Task 4 gained the enrichment cohesion sentence, `tokens` in the
enrichment row, the pinned view-header markup/insertion (`subsession-header`), a
project-level-untouched row + scoped-diff check, and `App.test.tsx` (new) added to Files and
the dependency table; Task 5 Verify expanded to concrete checks for all four rows. Two D1
"owner-decision" split-vs-justify items were resolved via the justify arm (plan-structure
choice, not a product call): Task 3 and Task 4 cohesion rationales above.

Fixer note: fixes applied by the controller; verdict unchanged by the fixer. Round 3 is a fresh
full-council run.

## Round 3 — 2026-07-31

### ✅ PASS — 85.7 (threshold 85 ✓, all floors ≥80 ✓, zero blocking violations ✓)

| Dimension | Weight | Grader | Skeptic misses | Final |
|---|---|---|---|---|
| D1 Decomposition & ordering | 15 | 91 | 2 | 82 |
| D2 Verifiability | 20 | 91 | 1 | 83 |
| D3 Spec fidelity & traceability | 20 | 91 | 1 | 86 |
| D4 Concreteness | 15 | 94 | 2 | 88 |
| D5 Risk & reversibility | 15 | 93 | 1 | 88 |
| D6 Consistency & completeness | 15 | 94 | 1 | 88 |
| **Overall** | | | | **85.7 — PASS** |

**Residual minors (19, none blocking).** The D1 "split task 1/3/4" owner-decision items are
DECLINED with the in-plan cohesion rationales standing (house call: bundles are related and
justified; splitting serializes writers on shared files). **Post-PASS mechanical fixes to
apply before execution** (house precedent — they do not reopen the verdict):

1. TDD line per task: "write each behavior-table row as a failing test first" (D2).
2. Row-to-test naming convention (`it('T1-<row-name>')`-style) replacing the informal
   cross-check in Tasks 1–4 (D2).
3. Task 1: reconcile "two wire fields" wording with spec §2.2's "one wire change"; add a hub
   round-trip row for `task_event` started with `toolUseId`; map each behavior row to its
   specific test file; add `resolvePermission`/`handleTaskMessage` line anchors (D3/D4).
4. Task 4: name enrichment as intrinsic to the header it creates; pin
   `derived.tasks.get(key).status/.summary/.tokens` keys; cite `deriveTranscriptGroups`
   (derive.ts:172) for done-detection (D1/D4).
5. Constraint 5/Task 2 note: sub-session projection exposes nothing not already in the shared
   session log (D5). Task 3 note: `⚒ SUB-QUEST` is the deliberate fixed marker (D6).
6. Task 2 note: a nested sub-agent's events carry the OUTER parent key — they render flat
   inside the parent's view per spec §4 out-of-scope (D6).
7. D5 owner-decision on `subCallParents` prune/cap: declined — plan already documents
   bounded-per-driver-lifetime growth and impossibility of misattribution (unique ids).
