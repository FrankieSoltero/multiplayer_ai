# Plan review — §8.8 hub-side oversight

**Plan:** `docs/plans/2026-08-04-hub-oversight.md` · **Spec:** `docs/specs/2026-08-04-hub-oversight-design.md`
**Council:** soltero-skills:plan-review bundled workflow, run `wf_c429ede8-5cf`, 2026-08-04, round 1, councilComplete: true.

## ✅ PASS — 86.8 (gate: ≥85 overall, every dimension ≥80, zero blocking)

| Dimension | Weight | Score | Blocking |
|---|---|---|---|
| D1 Decomposition & ordering | 15 | 83 | 0 |
| D2 Verifiability | 20 | 88 | 0 |
| D3 Spec fidelity & traceability | 20 | 88 | 0 |
| D4 Concreteness | 15 | 87 | 0 |
| D5 Risk & reversibility | 15 | 86 | 0 |
| D6 Consistency & completeness | 15 | 88 | 0 |

All violations minor; zero blocking; no floor breaches; no skeptic-confirmed misses.

## Post-PASS mechanical fixes — APPLIED to the plan (house precedent, no re-review)

1. **D1:** Task 2 split → 2a (HubDb v4, standard) + 2b (wiring/toggle/emit, judgment);
   Task 1's three-seam grouping rationale stated explicitly.
2. **D2:** Task 5 verify is now an exact grep command with expected outcome; Task 3 verify
   anchored to counts; Task 4's "PULL hidden or disabled" disjunction resolved (below).
3. **D3:** `overseer.activity` → `overseer.notify` reconciled (code-verified: `notify` is the
   real method; SPEC corrected, plan already right). `hubEnv.ts pattern` phrasing superseded
   with a logged rationale in Task 2b's Exact values (presence-only check needs no validation
   machinery). PULL invention dropped (below).
4. **D4:** `App.tsx:641` → `App.tsx:520` (grep-verified); `OversightPanel.tsx`/`.test.tsx`
   pinned without hedges.
5. **D5:** Task 2a gained the additive-only migration risk note + rollback posture, and a
   v3-fixture migration behavior row.
6. **D6:** summarize-failure behavior row added (no row, no frame, prior state retained);
   the summary↔text↔latest.text field mapping stated once in Task 2b.

## Owner-decision item — resolved by the spec of record (logged, not silently decided)

D2 flagged "PULL hidden or disabled — pick one." Spec §5 explicitly lists PULL among the
UNCHANGED client items, and D3 independently flagged the plan's clause as invented behavior.
Resolution: **the clause is dropped — PULL stays untouched** (with oversight unavailable it
injects nothing, which is already truthful). This follows the standing rule that the approved
spec governs over plan embellishment; it is a rendering detail, not a product fork, so it was
resolved and logged rather than escalated.
