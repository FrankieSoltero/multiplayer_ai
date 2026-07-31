# Plan Review — Operating a Hub (Branch B, PRD §8.10)

**Plan:** `docs/plans/2026-07-31-operating-a-hub.md`
**Spec:** `docs/specs/2026-07-31-identity-and-operating-design.md` §3 (APPROVED)
**Council:** soltero-skills:plan-review 0.19.1 bundled workflow, round 1, 2026-07-31
(run `wf_a96ef7a3-141`, 8 agents)

## ✅ PASS — 85.9 / 100

Gate: overall ≥85 ✓ (85.9) · every dimension ≥80 ✓ (min 82) · blocking violations = 0 ✓

| Dimension | Weight | Grader | Skeptic misses | Final |
|-----------|--------|--------|----------------|-------|
| D1 Task decomposition & ordering | 15 | 87 | 0 | 87 |
| D2 Verifiability | 20 | 87 | 0 | 87 |
| D3 Spec fidelity & traceability | 20 | 89 | 0 | 89 |
| D4 Concreteness | 15 | 93 | 4 | 82 |
| D5 Risk & reversibility | 15 | 87 | 0 | 87 |
| D6 Consistency & completeness | 15 | 82 | 0 | 82 |

## Council highlights

- All six Branch-B spec items (B1–B6) map to citing tasks; the HOST fail-closed
  exposure gate is correctly ordered first; the id-continuity trap (publish-after-
  prune PK collision) traces cleanly to B1.
- **The one substantive catch (D5+D6, converging):** the plan's boot order ran the
  retention prune BEFORE the backup while its own Global Constraint promised
  destructive paths are preceded by their backup. Fixed post-PASS: canonical boot
  order is now open/migrate → backup → prune → load, stated once in the header and
  referenced by Tasks 3 and 4; retention without backups configured is documented
  as the operator's explicit double opt-in to unrecoverable deletion.

## Violations (all MINOR — none blocking) and disposition

All mechanical fixes applied post-PASS (implementing the council's own
recommendations; verdict derives from the reviewed revision):

1. **D1:** `main.ts` added to Tasks 4–7's file lists (each wires its own config
   field; same serial chain, no new contention); Task 8's dependency cell now
   states the RUNBOOK is written from the plan's contracts (design-known);
   Task 3's `journal_size_limit` bundling justified in place.
2. **D2:** verbose-reporter requirement pinned (`--reporter=verbose` — the default
   reporter doesn't print passing test names); Task 9's Verify gained content
   greps; the "every suite strictly above baseline" claim corrected (only the hub
   suite grows — no Branch B task touches server/client).
3. **D3:** Task 9 header cites its requirements.
4. **D4 (skeptic-trimmed):** Caddy hostname is an explicit placeholder token;
   systemd hardening directives and `User=mpai` enumerated; TokenBucket eviction
   pinned as inline-in-`take()`; boot-line formats pinned for origin /
   minFreeBytes / trustProxy; tech-debt target resolved to §2.8 (the §1.x
   placeholder dropped).
5. **D5/D6:** boot-order fix above; boot-log lines reconciled (Task 1's config
   announce + Task 3's prune result both print).

## Owner questions

One, non-blocking, flagged in the plan's Global Constraints as explicit
out-of-scope: **`staticFiles.ts` security headers** (spec §1 names the gap;
§3 assigns it to no B-item). Plan keeps headers Caddyfile-only this branch;
the owner may pull it in as a ride-along.

## Handoff

PASS recorded. Execution waits for PR #29 (Branch A) to merge — Branch B's code
builds on Branch A's `hubEnv.ts`/`HubOptions`; on merge, branch off `main` and
execute with soltero-skills:lean-sdd.
