# Plan Review — Awareness Collisions (docs/plans/2026-07-30-awareness-collisions.md)

## Round 1 — **BLOCKED** (overall 82.3; D6 breached the ≥80 floor at 78; 7 blocking violations)

Run `wf_e21ca304-363`, 2026-07-30, on the **0.19.0** council (old ≥95 gate — superseded
mid-cycle, see below). D1 83 · D2 84 · D3 82 · D4 84 · D5 82 · D6 78. 33 violations: 7
blocking, 26 minor; 4 owner-decision items.

**Gate change (CC-001 closed):** soltero-skills 0.19.1 shipped the severity-driven gate —
`overall ≥85 AND every dimension ≥80 AND zero blocking violations` — replacing the ≥95
score-starved gate. Verified in the 0.19.1 `review.mjs` source; applied from round 2 onward per
the owner's directive. Round 1's verdict stands under BOTH gates (real blockings + a floor
breach), which is itself evidence the new gate tracks severity correctly.
`docs/corrections-ledger.md` CC-001 → retired.

**Owner rulings from round 1's owner questions (spec §8a rulings 4–6):**
4. `MPAI_CONTESTED_GATE=0` kill switch for tier (b); default ON.
5. `facts.touched` broadcast exposure ACCEPTED (record-filesChanged exposure class; journal
   retention; sweep with v7b2 auth).
6. Down-frame amended to carry `collisions: { path, sessionIds }[]` so hub-mode gate reasons
   and digest lines name the colliding session.
Mechanical resolution of the fourth owner item: `ProjectSessionEntry.baseRef`/`workdir`
persisted at session creation; null baseRef → touched stays null.

**Blocking findings (all mechanical after the rulings):** Task 5's conflicts row contradicted
its whole-package verify (×2); Task 7's contested-set accessor unnamed for Task 8 + solo
discriminating row missing; baseRef source unpinned; Task 2 had no risk/rollback block;
hub-mode colliding-session identity absent from the wire (×2, resolved by ruling 6).

All 33 findings dispatched to a fix pass; revision + round 2 on the 0.19.1 council follow.
