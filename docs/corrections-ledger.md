# Corrections Ledger

Compiled rules: deterministic enforcement artifacts derived from repeated corrections.
One entry per rule. Statuses: proposed | approved | installed | retired.

## CC-001 — plan-review verdicts must be severity-driven, not score-starved

- **Category:** skill-calibration
- **Trigger Origin:** 2026-07-29 — five plan-review council rounds on the §8.7 record plan all BLOCKED (83.4 / 84.3 / 80.0 / 84.1 / 86.0 vs the ≥95 gate) while finding severity decayed from real product gaps (rounds 1–2) to citation-notation and grep-format nitpicks; the final round BLOCKED at 86 with 27/27 findings minor, zero blocking, zero floor breaches — the exact failure mode this rule names. Owner overrode (directive given in advance) and flagged the skill for the end-of-month self-healing pass
- **Scope:** soltero-skills:plan-review (and its sibling prd-review, which shares the 6-dimension council + ≥95/≥80 gate design)
- **Constraint:** A BLOCKED verdict must be justified by at least one blocking-severity finding. A round whose surviving findings are all minor/mechanical must not BLOCK on the weighted score alone — either (a) the gate passes when no blocking findings survive and every dimension clears its ≥80 floor, or (b) skeptic deductions for minor-severity findings are bounded so confirmed-minor volume cannot hold a plan under 95 indefinitely. Round-over-round severity decay (blockings → notation nitpicks) should be surfaced to the owner as a convergence signal instead of another BLOCKED round.
- **Rationale:** The gate's arithmetic decouples verdict severity from finding severity: graders scored 85–92 across all dimensions in round 3, yet unlimited 2–10-point skeptic deductions per confirmed minor kept the overall below 95 in every round. Prose guidance to the council cannot fix this — the gate is deterministic script logic, so the fix must be too.
- **Added:** 2026-07-29
- **Traced-To:** Docs/mistakes-and-fixes.md entry 2026-07-29 (plan-review gate); docs/plan-reviews/2026-07-29-the-record-review.md (all round verdicts + finding lists); owner directive this session (F. Soltero, 2026-07-29)
- **Enforcement:** skill-patch — soltero-skills:plan-review `workflows/review.mjs` gate logic + SKILL.md gate wording, via the end-of-month skill-patcher/self-healing pass (soltero-skills repo; NOT a settings.json hook — nothing installs in this repo)
- **Status:** retired (fix shipped upstream in soltero-skills 0.19.1, 2026-07-30 — the gate is now `overall ≥85 AND every dimension ≥80 AND zero blocking violations`, verified against the 0.19.1 review.mjs source this session; applied per F. Soltero's directive "for the grader it should have a new gate for approval". First live run under the new gate: the §8.8 awareness plan's round 1 BLOCKED at 82.3 with 7 genuine blocking findings — the gate now agrees with finding severity, exactly the constraint this rule proposed.)
