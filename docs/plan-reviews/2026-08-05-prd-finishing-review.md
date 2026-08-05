# Plan review — PRD finishing cycle

**Plan:** `docs/plans/2026-08-05-prd-finishing.md` · **Spec:** `docs/specs/2026-08-05-prd-finishing-design.md`
**Council:** plan-review workflow run `wf_66293e8c-934`, 2026-08-05, round 1, councilComplete: true.

## ✅ PASS — 87.2 (≥85 overall, all dimensions ≥80, zero blocking)

D1 87 · D2 86 · D3 88 · D4 88 · D5 87 · D6 87. All violations minor.

## Post-PASS mechanical fixes — APPLIED

D1 grouping justifications (T1 single-writer cli.ts; T3 cycle-wrap unit) · D2 T2 verify
phrasing, enumerated T3 tick-list, plan-level done criterion (constraint 8) · D3 §8.5
citation, re-arm behavior row, query-preservation annotated as implementation detail ·
D4 exact test-file paths pinned · D5 data-exposure constraint 7 + runbook teardown/
failure-recovery requirements.

## Owner-decision items — resolved by code fact / spec scope (logged)

1. Malformed `--hub`: the EXISTING CLI validation (`--hub requires a ws:// or wss:// url`)
   runs before normalization — behavior row added pinning that order. Code fact, not a new
   decision.
2. Refused-join signaling: out of scope per spec F3 (the SUCCESS signal); refusals keep
   today's error surface. Noted in the Task 2 behavior table.
