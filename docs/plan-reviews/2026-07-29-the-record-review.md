# Plan Review — The Record (docs/plans/2026-07-29-the-record.md)

## Round 1 — **BLOCKED — do not execute** (overall 83.4 / gate ≥95; D1 breached the ≥80 floor)

Council: 6 graders + 3 skeptics + 3 re-grades (soltero-skills:plan-review workflow,
run `wf_657308de-15d`, 2026-07-29).

| Dimension | Weight | Grader | Skeptic misses | Final |
|---|---|---|---|---|
| D1 Task decomposition & ordering | 15 | 90 | 2 | **78** ← floor breach |
| D2 Verifiability | 20 | 83 | 0 | 83 |
| D3 Spec fidelity & traceability | 20 | 85 | 0 | 85 |
| D4 Concreteness | 15 | 92 | 3 | 83 |
| D5 Risk & reversibility | 15 | 88 | 0 | 88 |
| D6 Consistency & completeness | 15 | 92 | 2 | 83 |
| **Overall (weighted)** | | | | **83.4 — BLOCKED** |

## Blocking findings

1. **(D1, owner decision)** Task 5 ships hub-side `get_record` with no identity requirement
   ("same access as watch_project"), while Task 6's standalone arm refuses via `denyUnauthed()`.
   The record aggregates prompts, changed-file paths, and the approval trail with userIds —
   strictly more than a snapshot. Council requires either a gate in/before the exposing task, or
   an explicit owner sign-off recorded in the plan. → **Owner question below.**
2. **(D4)** The restart "kill the hub" test never names the kill mechanism (graceful `close()` vs
   hard kill proves different durability). → fixed: in-process crash equivalent named (second
   `HubDb` handle opened on the same file WITHOUT closing the first).
3. **(D6)** Spec §3.6's runtime fail-stop ("no catch-and-carry-on") had no hub-level behavior
   row or test. → fixed: `fatal` seam + fail-stop behavior rows added.

## Mechanical fixes applied (round 1 → revision)

- Split Task 2 into persister seam / hydration; split Task 4 into helper extraction / wiring /
  restart+fail-stop integration (plan is now 11 tasks; dependency table rebuilt, file-overlap
  caveat gone).
- Verify lines widened: hub get_record task reruns routing+hubStore tests + tsc; standalone task
  reruns the whole server suite; docs task got objective checks; plan-level Done criteria added.
- Task 7 (panel) got an explicit browser walk (hub AND solo) + contrast check in Verify, and the
  spec-mandated toggle render test named.
- Per-task spec citations added; `HubDb` rename from spec's `SqlitePersister` declared deliberate.
- Startup log line pinned verbatim; recordView/RecordPanel contracts spelled with explicit
  delegation markers.
- `.gitignore` gains `.mpai-hub/` (the DB holds prompts/userIds/paths) with a `git status
  --porcelain` check; operator recovery path for a refused boot documented.
- Global parity constraint reworded to what the tasks implement (validation/error-string/reply
  parity; auth gating per each server's existing discipline).
- HubDb behavior table gains the spec §3.6 "unopenable" row (dbPath is a directory → throw).

## Owner question (blocks round 2)

**Hub-side access model for `get_record`?** (a) no gate — parity with the hub's existing
watch_project/list_projects (v7b1 hub has auth OFF entirely; join/watch already expose the same
data; sign-off recorded, v7b2 auth sweep must include get_record), (b) require `identify` first
(self-asserted in v7b1 — symbolic, matches create_project's shape), (c) require identify +
project membership.

**Owner answered (2026-07-29): option (b) — hub `get_record` requires `identify`** (membership
not required). Written into Task 8's access-gate rows and the Global Constraints parity note.

## Round 2 — **BLOCKED — do not execute** (overall 84.3; D5 breached the ≥80 floor)

Run `wf_510cb190-c3a`. D1 86 · D2 88 · D3 88 · D4 82 (skeptic −10) · **D5 75** (skeptic −15) ·
D6 84.

**Blocking:** browser-walk commands unnamed (D4×2, fixed — verbatim commands + contrast
procedure now in Task 11); runtime-write-failure blast radius/recovery undocumented (D5, fixed —
Task 6 blast-radius row + Task 12 PRD text); dependency table contradicted Task 7's conditional
hub.ts write (D6, fixed — Task 6 owns the fatal wiring, Task 7 is a pure test task). **Two owner
questions** (D5): DB default-path policy and double-start corruption.

**Owner answered (2026-07-29):** default path = **`~/.mpai/hub.db`** honoring `MPAI_HOME` (the
§8.3 dotdir precedent; kills the cwd-dependence and the gitignore reliance), and **single-writer
PID lockfile** beside the DB (double-start refused naming the running PID; stale locks
reclaimed; `skipLock` seam for the crash test). Both written into the spec (§8a rulings) and the
plan (Tasks 4, 6, 7).

**Other round-2 fixes applied:** Task 10 split (view-model vs panel+walk; plan is now 12 tasks);
Task 6 gained `hubBoot.test.ts` + `hubDbPath`/`storeLogLine` tested contracts; harness helpers
enumerated by name; `MachineInfo` import source pinned (`poc/client/src/types.ts`); TurnApproval
requestId drop disclosed; spec §4.3/§3.1 amended so spec and plan agree; at-rest posture recorded
(0700 dotdir, unencrypted, no retention until §8.10); WAL-complete recovery wording (move the
`hub.db`/`-wal`/`-shm` trio together).

## Round 3 — **BLOCKED — do not execute** (overall 80.0; D1 78, D3 78, D5 78 breach the floor)

Run `wf_5fe050bf-455` (final round of this cycle — 3-round cap reached; per the skill the plan
returns to lean-plans for revision, then a FRESH review cycle).

Grader scores were 90–92 across all six dimensions; skeptics confirmed 2–3 missed minors on
D1/D2/D3/D4/D5/D6, dropping finals to 78–84. What blocks:

**Blocking findings:** (1) Task 11 depends on Task 6's HUB_DB/dist deliverables but the table
omits the edge — a parallelizing executor could schedule the walk before the wiring exists;
(2) Task 11's fetch/refresh/error behavior rows have no named test file; (3) spec §7 says the
hydration-equivalence test uses *arbitrary* realistic sequences — the plan pinned one fixed
sequence (needs a property test or an owner ruling); (4) spec §3.3's "one transaction per frame"
is violated by the implicit-creation publish path (`sessionSaved` + `eventsAppended` as two
transactions) — needs a combined single-transaction persist path; (5) the lockfile's silent
stale-reclaim policy needs an owner decision (a fooled liveness check = two writers).

**Owner questions carried to the next cycle:** (a) ratify TurnApproval's `requestId` drop as
spec §8a ruling #4, or add the field; (b) lockfile reclaim policy — silent stale-reclaim with
documented blast radius vs refuse-and-require-manual-removal.

**Remaining minors (all mechanical):** split Task 6 (helpers vs plumbing) and Task 11 (panel vs
walk); walk steps for styling-consistency and decorative-layer checks; exact fatal-default test
recipe (vi.spyOn process.exit); solo-walk observable content; diff-scoped tech-debt check;
corrupt-DB unrecoverability + backup-before-upgrade sentences; skipLock comment wording; test
files listed in the dependency table.

Note: rounds 1–3 ran on soltero-skills 0.18.0's council (no per-agent model pins → all graders
inherited the session model, Fable 5). 0.19.0, installed mid-cycle, pins graders/re-grades to
opus and skeptics to sonnet; the next cycle uses it.

**Owner answered (2026-07-29):** proceed with fix + fresh cycle; `requestId` drop RATIFIED
(spec §8a ruling 4); lockfile stale-reclaim = SILENT with documented blast radius (spec §8a
ruling 5). All round-3 findings applied as a lean-plans revision: plan is now 14 tasks (Task 6
boot-config helpers split out; Task 13 browser walk split out with verbatim steps and the
missing dependency on the wiring task), single-transaction implicit-session persist
(`eventsAppended(..., newSession?)`), hydration equivalence upgraded to a seeded property test
(≥25 random sequences), `RecordPanel.test.tsx` named with per-row tests, `defaultFatal` exported
with an exact spy recipe, corrupt-DB/backup-before-upgrade/backup-first recovery documented,
diff-scoped tech-debt verify.

# Cycle 2 (plan revision of 2026-07-29, soltero-skills 0.19.0 council)

## Cycle 2, Round 1 — **BLOCKED — do not execute** (overall 84.1; NO floor breaches — first round with every dimension ≥80)

Run `wf_cf9c3a9d-0f3` (0.19.0 council: opus graders/re-grades, sonnet skeptics; full findings
in `/private/tmp/claude-501/-Users-franciscosoltero-Desktop-Code-multiplayer-ai/4026c7bb-3d54-433a-9b0e-ced8f4edb2fd/tasks/wo262xt6i.output` while this machine keeps it).

D1 86 · D2 84 · D3 80 · D4 87 · D5 87 · D6 82. 28 violations: 26 minor/mechanical, 2 blocking
(one D3, one D6 — full text in the output file above), plus 2 owner questions:

1. **SqlitePersister vs HubDb rename** — the plan's "spec governs" header conflicts with the
   deliberate rename note; council wants the SPEC amended (rename recorded as a §8a ruling) or
   the class named `SqlitePersister`.
2. **Backup posture as plan-authored policy** — Task 7's operator-recovery ordering and the
   backup-before-upgrade convention exceed spec §3.6/§8a; council wants them ratified as a §8a
   ruling or moved out of the plan.

Representative mechanical fixes queued for the next revision: widen Tasks 2/3/9 verifies to the
whole hub suite; conflicts column (or dep edge 7→9) in the table so prose isn't the only
scheduler input; split Task 7 (wiring vs fail-stop) or record the fusion as deliberate; Task 13
sub-deliverables independently ledgered; mechanical no-logic-edited check on Task 5's
extraction; pass/fail criterion for the styling-consistency walk step; named assertion for Task
12's "rendering" row.

**Owner answered (2026-07-29, session #22):** `HubDb` rename RATIFIED (spec §8a ruling 6);
backup posture (backup-first recovery ordering, backup-before-upgrade convention, at-rest
posture) RATIFIED (spec §8a ruling 7); and the auto-decision rollup exclusion — flagged in the
minors with an "or get a ruling" option — RATIFIED too (spec §8a ruling 8) rather than left as
`(proposed — confirm)`.

**All 26 mechanical fixes + 2 blocking fixes applied** to the plan: Conflicts-with column added
to the dependency table (table alone now schedules; whole-package-suite verifies encoded);
Tasks 2/3/9 verifies widened to the whole hub suite; Task 7 fusion recorded as deliberate;
Task 13 steps independently ledgered, step-4 pass/fail criterion, citations split
(§5/§4.3/house convention); `captureHydration` helper named and shared (Task 3 → Task 4
round-trip restated); driver rows aligned to spec §4.1's "opening"/"at that point" wording with
a discriminating in-turn control_change row; lock/schema error-string templates; mulberry32 /
seed 1337 pinned; better-sqlite3 native blast radius + rebuild verify + npm-install first step
+ package-lock staged; skipLock test-only made checkable (row + grep); get_record exposure
delta recorded; rollupLines/sessionBlocks signatures and rendered-line templates pinned;
RecordPanel props final; Task 12 rendering row named assertion; Task 14 citations fixed to
"§6 non-goals 2–3" and the tech-debt grep matched to the file's real `### N.M` format.

→ cycle 2 round 2 convened on the revised plan.
