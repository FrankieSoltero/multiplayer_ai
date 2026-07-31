# Plan Review — Identity & Access (Branch A, PRD §8.1)

**Plan:** `docs/plans/2026-07-31-identity-and-access.md`
**Spec:** `docs/specs/2026-07-31-identity-and-operating-design.md` (APPROVED)
**Council:** soltero-skills:plan-review 0.19.1 bundled workflow, round 1, 2026-07-31
(6 graders + anti-inflation skeptics; run `wf_84f3f515-903`, 10 agents)

## ✅ PASS — 86.1 / 100

Gate: overall ≥85 ✓ (86.1) · every dimension ≥80 ✓ (min 82) · blocking violations = 0 ✓

| Dimension | Weight | Grader | Skeptic misses | Final |
|-----------|--------|--------|----------------|-------|
| D1 Task decomposition & ordering | 15 | 88 | 0 | 88 |
| D2 Verifiability | 20 | 91 | 6 | 82 |
| D3 Spec fidelity & traceability | 20 | 88 | 0 | 88 |
| D4 Concreteness | 15 | 94 | 8 | 82 |
| D5 Risk & reversibility | 15 | 88 | 0 | 88 |
| D6 Consistency & completeness | 15 | 89 | 0 | 89 |

## Council highlights

- **D1:** security-correct sequencing confirmed — identity stamped before membership
  gates; device store → pairing → bearer enforcement; no deploy-before-auth inversion.
- **D3:** every Branch A requirement (A1–A6) and all three §6 stale-citation actions
  map to concrete tasks; Branch B and the §8.2 invite flow correctly excluded.
- **D5:** fail-closed uplinks, roster redaction, hashed single-use tokens, 0600 file
  modes, DoS bounds and live revocation all present; the additive one-transaction
  migration was the only gap (no backup/rollback note).
- **D2/D4 skeptics** trimmed inflated grades for soft "→ green" verify observables and
  guessed test-file names (e.g. a non-existent "hub uplink tests" suite).

## Violations (all MINOR — none blocking) and disposition

All mechanical fixes recommended by the council were applied to the plan
**after** the PASS verdict (the verdict derives from the reviewed revision;
these edits implement the council's own recommended fixes verbatim, no scope
change):

1. **D1:** Task 11 split — entrance/join-affordance (Task 11) vs pairing-approval UI
   (new Task 12); docs sweep renumbered to Task 13. Task 10 now notes its runtime-only
   dependency on Task 8.
2. **D2:** every Verify line now names its expected new cases and requires the suite
   count strictly above the prior task's (exact totals read from runs, never
   predicted — house rule). Plan-level done criterion added to the header.
3. **D3:** spec IDs added to every task header; Task 5 now states why the standalone
   `server.ts` parity change and `isMember` field ride along (one browser bundle,
   no client parsing fork).
4. **D4:** all test references now name real files (`routing.test.ts`,
   `httpSurface.test.ts`, `hubDb.test.ts`, `relayIntegration.test.ts`,
   `relay.test.ts`, `server.test.ts`, `cli.test.ts`, the two client `*.test.tsx`),
   verified against the tree.
5. **D5:** Task 6 gained the pre-migration `<dbPath>.v1.bak` backup step and the
   rollback path (restore `.bak`; old code against v2 refuses at boot by design).
6. **D6:** Architecture citation reconciled to `server.ts:1045-1058`.

## Owner questions

None. (The council labeled some D2 count-binding fixes "owner-decision"; they were
resolved by the standing "never predict suite totals" rule — counts are bounded
relative to baselines and named cases must appear in run output.)

## Handoff

PASS recorded → execute with soltero-skills:lean-sdd on a fresh branch off `main`.
