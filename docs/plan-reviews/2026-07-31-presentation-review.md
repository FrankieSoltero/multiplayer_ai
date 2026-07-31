# Plan review — Presentation cycle (§8.5 + §8.9)

**Plan:** `docs/plans/2026-07-31-presentation.md`
**Spec:** `docs/specs/2026-07-31-presentation-design.md`
**Council:** soltero-skills:plan-review bundled workflow (6 graders, skeptics on ≥90,
deterministic gate).

---

## Round 1 — 2026-07-31

### ⛔ BLOCKED — do not execute (round 1)

Overall **84.2** (< 85 threshold) AND **D2 Verifiability 79 < 80 floor**. Zero
blocking-severity violations; all findings minor. **Council caveat, disclosed:** one council
agent died on a StructuredOutput retry cap (`councilComplete: false` in the gate record); the
verdict is BLOCKED regardless (threshold + floor both breached by completed dimensions), and
round 2 re-convenes the full council fresh.

| Dimension | Weight | Final |
|---|---|---|
| D1 Decomposition & ordering | 15 | 86 |
| D2 Verifiability | 20 | **79** |
| D3 Spec fidelity & traceability | 20 | 87 |
| D4 Concreteness | 15 | 82 |
| D5 Risk & reversibility | 15 | 88* |
| D6 Consistency & completeness | 15 | 88* |
| **Overall** | | **84.2 — BLOCKED** |

\* D5/D6 final attribution approximate in this record — the workflow's composed table was
partially truncated in transcript; per-agent scores recovered from the journal
(`wf_739a7244-4e8/journal.jsonl`). Round 2's table supersedes this one.

### Findings → fix list (applied post-round-1 by the controller, mechanical)

- **D2 (the floor breach, 4 mechanical + 1 owner-decision):** (1) AA-ratio verification must
  name a mechanical check + pass condition (WCAG relative-luminance computation, ≥4.5:1 text /
  ≥3:1 decorative) instead of "the review checks the ratios". (2) Task 2 dead-chrome deletion
  gets explicit greps with expected no-hit results. (3) Task 3 CSS-only rows get concrete
  grep assertions. (4) Task 4 "review-checked against the fenced section" replaced with greps
  for the fence string and each required token override + AA comment presence.
- **D1 (2):** split Task 5 into three single-purpose tasks (gate bar / wheel-on-card / pull
  click-through) and split Task 3 into styling vs a11y — independent revertibility.
- **D3 (2):** Task 2 gains a row covering spec §2.3's `props.right` relocation (or a
  grep-confirmed "no live use" note); the spec's live-walk-before-PR lands as an explicit
  done-gate step.
- **D4 (4):** enumerate the wash tokens in the Clean override list; cite the hooks-shim test
  helper by path everywhere "house pattern" is referenced; cite `sessionUrlFrom`
  (`poc/client/src/pickerUrl.ts`) for the pulls navigation; pin the lane font-size base
  exactly (see rulings below).
- **D5 (1):** rollback note qualified — mid-chain reverts happen in reverse dependency order
  or as a range revert of the feature.
- **D6 (1):** localStorage WRITE failure path (private mode / quota) — setItem wrapped so a
  throwing store degrades to in-session state; behavior rows added to Tasks 1 and 6.

### Owner-decision items — controller rulings (plan-structure, not product; logged per house precedent)

1. **D2: trailing parity test (Task 7).** RESOLVED via the justify arm: the parity invariant
  quantifies over the FINAL control set — its assertions reference surfaces (gate bar, resize
  handle) that only exist after Tasks 5–6, so per-surface incremental assertions would be
  rewritten every task and prove less. The plan gains an explicit justification note; Task 7
  stays.
2. **D4: undefined lane font-size "base".** RESOLVED by pinning: base = `--fs` (13px, the mono
  base token, terminal.css:48); lane font-size = `calc` of `--fs` × scale, stated as an exact
  value in Task 6.

Fixer note: fixes to be applied by the controller as mechanical plan edits; the verdict above
is unchanged by the fixer. Round 2 re-convenes the full council on the edited plan.

**Fix-list APPLIED 2026-07-31 (controller, mechanical):** all D2/D3/D4/D5/D6 items plus both
splits — Task 3 → styling (new T3) + a11y (new T4); Task 5 → gate bar (T6) + wheel-on-card
(T7) + pull click-through (T8) — plan renumbered to 11 tasks, dependency table updated
(6→7→8 serial on App.tsx; 9 concurrent with 7–8; 10‖11 trailing). Ruling 1 landed as Task 10's
justification note; ruling 2 pinned the lane base to `--fs` 13px with exact calc values in
Task 9. Live-walk done-gate added as Plan done gate step 2.

---

## Round 2 — 2026-07-31 (on the round-1-fixed, 11-task plan)

### ⛔ BLOCKED — do not execute (round 2)

Overall **82.2** (< 85) AND two floor breaches: **D2 Verifiability 79**, **D4 Concreteness
78**. **3 blocking violations.** Council COMPLETE this round (16 agents, 0 dead — round 1's
caveat does not recur). Run `wf_300ccc6f-4da`. Score moved DOWN from round 1 (84.2 → 82.2):
grader raw scores were high (88–94) but skeptics confirmed 2–4 misses per dimension, pulling
finals down.

| Dimension | Weight | Grader | Skeptic misses | Final |
|---|---|---|---|---|
| D1 Decomposition & ordering | 15 | 91 | 4 | 82 |
| D2 Verifiability | 20 | 91 | 4 | **79** |
| D3 Spec fidelity & traceability | 20 | 88 | 0 | 88 |
| D4 Concreteness | 15 | 92 | 3 | **78** |
| D5 Risk & reversibility | 15 | 94 | 2 | 80 |
| D6 Consistency & completeness | 15 | 90 | 2 | 85 |
| **Overall** | | | | **82.2 — BLOCKED** |

### Blocking violations (3)

1. **D2 (mechanical):** Task 9's `live-run integrity` row had no stated command/check.
2. **D4 (owner-decision → controller ruling 3 below):** the pointer-drag distance-to-scale
   mapping was entirely unpinned (no axis, anchor, or sensitivity).
3. **D5 (mechanical):** initial `localStorage` READS were unguarded — `getItem`/property
   access throws in blocked-storage environments and would crash mount; only writes were
   wrapped.

### Findings → fix list (round 2)

- **D1 (6, all "task bundles unrelated changes"):** split Task 5 (Clean CSS ∥ games opt-in) —
  mechanical; split Task 9 (default scale ∥ resize control) — mechanical; Task 1 (hook ∥
  wiring), Task 6 (GateBar ∥ jump-to-card), Task 2 (Cabinet ∥ marquee/legend) — owner-decision,
  ruled below.
- **D2 (5 + the blocking):** greps for Task 5's shadow/wheelbanner rows; explicit test-first
  statement (repo practices lean-tdd but plan never said so); Task 3 rail no-wrap/overflow
  grep; Task 11 PRD content greps (keys present, `1296` gone); Task 9 live-run check
  (blocking).
- **D3 (1):** spec §2.2's "Clean busy shows the thinking strip's status line without the game
  lane" was reduced to "does not auto-open" — transcribe the row; reconcile the parity test's
  only-divergence assertion.
- **D4 (4 + the blocking):** name the pulls state field + ordering key exactly; name the
  App sources for `gate`/`driverName`/`driverGlyph`; provide the AA node one-liner verbatim;
  pin the drag mapping (blocking).
- **D5 (2 + the blocking):** guard localStorage READS in both Task 1 and Task 9 with rows +
  tests (blocking); extend constraint 6 to both directions.
- **D6 (4):** Clean-busy status-line row (same as D3); Task 8 empty-pulls-at-click no-op row;
  constraint 9's "modulo" list gains the Task 3/4 rider changes; done-gate live walk restores
  spec §3's sub-session-rail-populated state and both-themes-screenshots-per-state.

### Owner-decision items — controller rulings (plan-structure, not product; logged per house precedent)

3. **D4 blocking: drag mapping.** RESOLVED by pinning (implementation exactness, not a product
   fork): vertical axis; anchor = scale + clientY captured at pointerdown;
   `scale = clamp(anchorScale + (anchorY − clientY)/400, 0.5, 1.0)`; up = bigger (matches
   ArrowUp); 400px spans the full range; persist once per gesture on pointerup.
4. **D1: Task 1 split.** RESOLVED via split: pure hook (theme.ts + test) vs wiring (Header
   toggle + CRT coupling). Cheap, independent revertibility, no downside.
5. **D1: Task 6 split.** RESOLVED via split: GateBar component + placement vs jump-to-card
   (card ids + scroll handler) — two independently testable behaviors.
6. **D1: Task 2 split.** RESOLVED via the justify arm: the marquee and legend exist ONLY as
   `Cabinet`'s own chrome (Crt.tsx:39-66 renders both inside the component); retiring Cabinet
   without folding them is not a buildable intermediate state. Justification note added to the
   task; it stays atomic.

**Fix-list APPLIED 2026-07-31 (controller, mechanical):** all items above; plan renumbered to
**15 tasks** (1 hook, 2 wiring, 3 full-bleed, 4 styling, 5 a11y, 6 Clean CSS, 7 opt-in+status
line, 8 gate bar, 9 jump, 10 wheel-on-card, 11 pulls, 12 default scale, 13 resize, 14 parity,
15 docs). New concurrency: 5‖6 after 4; 12 fully independent; 13 ‖ 9–11. Constraint 10
(test-first) added; done gate step 2 now carries the spec-complete walk (both themes
screenshotted per state, sub-session rail populated). Round 3 re-convenes the full council on
the edited plan (final round — still BLOCKED ⇒ back to plan authoring).

---

## Round 3 — 2026-07-31 (on the 15-task plan; FINAL round of cycle 1)

### ⛔ BLOCKED — do not execute (round 3)

Overall **85.2** (≥ 85 ✓), **zero floor breaches** ✓, but **1 blocking violation** ⇒ BLOCKED
by the gate. Council complete (14 agents, 0 dead). Run `wf_e84e5b87-484`.

| Dimension | Weight | Grader | Skeptic misses | Final |
|---|---|---|---|---|
| D1 Decomposition & ordering | 15 | 91 | 2 | 82 |
| D2 Verifiability | 20 | 92 | 2 | 86 |
| D3 Spec fidelity & traceability | 20 | 95 | 2 | 87 |
| D4 Concreteness | 15 | 92 | 2 | 80 |
| D5 Risk & reversibility | 15 | 88 | 0 | 88 |
| D6 Consistency & completeness | 15 | 87 | 0 | 87 |
| **Overall** | | | | **85.2 — BLOCKED (1 blocking violation)** |

### The blocking violation (D4, owner-decision)

Task 11 claimed "navigation via `sessionUrlFrom`, no new URL construction" while citing a data
source (`Pull`, pulls.ts:49) that carries no `projectId` — but `sessionUrlFrom`'s real
signature is `(search, sessionId, projectId)` with a REQUIRED third argument
(pickerUrl.ts:28). The executor could not satisfy the task from the cited sources.

### Cycle-1 close-out (max 3 rounds reached) → plan returned to authoring

Per the plan-review rules, three rounds exhausted ⇒ the plan went **back to plan authoring**
(lean-plans re-entry, controller as author). All round-3 findings were addressed there:

- **Blocking (D4):** RESOLVED with verified facts, not a guess (ruling 7): `pulls` derives
  from `projectSessions`, the socket's PROJECT-SCOPED list (`useSessionSocket({ projectId })`,
  App.tsx:193/:195), so every pull targets the CURRENT project by construction; the third
  argument is the Session component's own `projectId` prop (App.tsx:191), same call shape as
  the existing SessionPicker.tsx:535 site. Full three-argument call pinned verbatim in Task
  11. (The council's cross-project mis-routing concern cannot arise from this data source.)
- **D1:** Task 4's file set made deterministic (terminal.css ONLY; the rail inline styles stay
  at SubSessionRail.tsx:25, already pinned by SubSessionRail.test.tsx:175-183 — the plan's
  earlier "Transcript.tsx" attribution was corrected to the real file) + cohesion note; Task 2
  and Task 6 gained explicit Why-atomic justifications (ruling 8: toggle without CRT coupling
  is a broken intermediate state; ruling 9: one fence = one commit, splits give zero
  concurrency and incoherent partial themes).
- **D2:** T9-jump/T9-no-target and T11-navigation/T11-empty assertion mechanisms named
  (getElementById stub + scrollIntoView spy; sessionUrlFrom spy / query-string assert);
  done-gate walk step (d) made objective (querySelector null-check replaces "verified
  visually"); Task 14's justification restated against the rubric line itself — it is not
  deferred test-writing (constraint 10 covers Tasks 1–13); it tests a new emergent invariant.
- **D3:** wash tokens restructured (ruling R5): required overrides now EXACTLY the spec §2.2
  enumeration; the four derived alphas (`--amber-mute`, `--amber-wash`, `--gold-wash`,
  `--green-wash`) ride along as rgba() derivations of their re-pointed solids (css:38-39,
  42-43) — decorative-only, AA-exempt; spec §5's "review" arm restored (mechanical AA check
  AND the live-walk both-theme screenshot review — the "not by editorial review" exclusion
  removed).
- **D4:** "at minimum" replaced by a CLOSED override set; Task 8's subLabel join pinned to the
  literal existing expression (Transcript.tsx:56/:154, keyed on `parentToolUseId`).
- **D5:** constraint 8 carves out Task 3 as the one deletion task with its blast radius named.
- **D6:** constraint 4 scoped to SOLID tokens (alpha exemption stated); constraint 3's allowed
  decoration list gains letter-tracking (`--track-label`).

**Cycle 2 round 1 re-convenes the full council fresh on the re-authored plan** (recorded by
the workflow as round 4 — the script's round counter is continuous; cycle bookkeeping lives in
this file).

---

## Cycle 2, Round 1 — 2026-07-31 (workflow round 4, on the re-authored 15-task plan)

### ✅ PASS — cleared for execution

Overall **85.3** (≥ 85 ✓), **zero floor breaches** ✓, **zero blocking violations** ✓. Council
complete (18 agents, 0 dead). Run `wf_5fddf9a5-402`.

| Dimension | Weight | Grader | Skeptic misses | Final |
|---|---|---|---|---|
| D1 Decomposition & ordering | 15 | 93 | 1 | 87 |
| D2 Verifiability | 20 | 92 | 3 | 84 |
| D3 Spec fidelity & traceability | 20 | 95 | 2 | 86 |
| D4 Concreteness | 15 | 94 | 3 | 83 |
| D5 Risk & reversibility | 15 | 91 | 1 | 87 |
| D6 Consistency & completeness | 15 | 90 | 2 | 85 |
| **Overall** | | | | **85.3 — PASS** |

### Post-PASS mechanical fixes (applied by the controller, house precedent — no re-review)

- **D6 (best catch of the round):** the drag-mapping gloss contradicted its own formula —
  with divisor 400, **200px** (not 400px) spans the 0.5-wide clamp range. Gloss corrected;
  divisor and T13-drag-mapping test unchanged.
- **D1:** artificial 4→5 edge dropped (file-disjoint; 5 now depends on 3) and 7's edge on 6
  dropped (opt-in logic is theme-value-driven; tests run in the no-DOM env) — 8 now depends
  on 6+7 explicitly to keep the terminal.css chokepoint chain (3→4→6→8→13) intact. After
  Task 3, lanes 4/5/7 run concurrently.
- **D2:** all six live-walk steps now carry objective pass conditions (dataset.theme values,
  localStorage keys, querySelector null-checks, location.search end-state) — no walker
  judgment calls; `.lobby-foot` added to the step-(d) selector with the grep-#5 retention
  caveat.
- **D3:** Task 15 also aligns PRD §5.2's "standard type, calmer density" line (PRD:208) to
  R2, with a grep check; Task 6's Spec header discloses the mixed §2.2 + R5 provenance
  (chosen over amending the user-approved spec).
- **D4:** `<fenced section>` resolved to the concrete
  `sed -n '/===== CLEAN THEME/,$p' poc/client/src/terminal.css`; the six Clean hex values
  tagged with the literal "(proposed — confirm)" convention, confirmed by the AA+live-walk
  two-part gate; GateBar's exact token mapping enumerated (amber gate vocabulary, existing
  btn classes verbatim).
- **D5:** affirmative no-flag justifications added to Task 3 (the live-walk gate is the
  pre-merge staging) and Task 12 (spec-mandated, user-adjustable via Task 13, clean revert).

**Handoff:** execution via soltero-skills:lean-sdd on branch `feature/presentation` off main
(`20c40fd`); first docs commit = spec + plan + this review + HANDOFF edit (standing
convention). Recorded score of record: **85.3 PASS**.
