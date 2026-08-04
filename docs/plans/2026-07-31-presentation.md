# Presentation cycle (§8.5 + §8.9) — implementation plan

**Spec of record:** `docs/specs/2026-07-31-presentation-design.md` (APPROVED 2026-07-31; rulings
R1 pair, R2 same density, R3 agent-proposed surfacing approved with the spec, R4 smaller games +
adjustable split).
**Goal:** ship the two-theme presentation layer (Arcade base + Clean overrides, runtime-switch),
finish full-bleed, land the three §8.5 surfacing improvements and the PR-#32 styling/a11y
riders, and make the arcade strip smaller by default and user-resizable — 100% client-side.

**Architecture (3 sentences):** A `data-theme` attribute on the document root selects between
the untouched Arcade base stylesheet and an appended Clean override layer; a `useTheme` hook
owns persistence and drives the existing `Crt` `intensity` mechanism. Full-bleed completes by
retiring the `Cabinet` chrome so the glass is the page. All new §8.5/§8.9 surfaces (gate bar,
wheel-on-card, pull click-through, sub-session styling, resizable arcade strip) are presentation
over existing client state and messages — no protocol, server, or hub changes.

**Stack / suites:**
- client: `cd poc/client && npx tsc -b && npx vitest run` (baseline 430)
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (baseline 762 — must not change)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (baseline 352 — must not change)
- Never predict post-change totals; read them from runs.

**Plan done gate (objective):**
1. Tasks 1–15 landed; all three suite commands run fresh with exit 0, zero failures, tsc clean;
   server/hub counts exactly at baseline (no non-client file changed —
   `git diff --name-only main` shows only `poc/client/**` and `docs/**`); client count ≥ baseline.
2. **Live walk before the PR opens (spec §3's live-walk gate, explicit and complete):** run the
   built client against a real session (skill `run`) and walk, **screenshotting BOTH themes at
   each state** (spec: "both themes screenshotted on the session surface"). Every step has an
   OBJECTIVE pass condition — no walker judgment calls:
   (a) gate pending — after `[A]PPROVE` the gate card's `.perm-outcome` shows the decided
   state and the gate bar disappears (renders null); bar-body click scrolls
   `#perm-<requestId>` into view; `🛞 TAKE THE WHEEL` transfers the driver and the decide
   buttons appear on the card;
   (b) sub-session rail populated (the visual deliverable of Tasks 4–5) — the chips render in
   `.subsession-rail` with `.active`/`.gated`/`.done` accents applied; the rail scrolls
   horizontally without wrapping;
   (c) arcade strip open and closed — after a resize the `.lane` `<pre>` inline `fontSize` is
   `calc(var(--fs) * <scale>)` and `localStorage["mpai-arcade-size"]` holds that scale; after
   reload the same scale is restored;
   (d) full-bleed marquee-fold — in the browser console,
   `document.querySelector(".marquee, .cabinet, .crt-chrome-top, .lobby-foot") === null` on
   the session surface AND the `.term-header` breadcrumb is the sole identity line (Task 3's
   assertions re-run live; if Task 3's grep #5 RETAINED `.lobby-foot` for a non-App surface,
   drop it from this selector and name that surface in the walk record);
   (e) theme toggle — the toggle flips `document.documentElement.dataset.theme` between
   `arcade`/`clean`, `localStorage["mpai-theme"]` holds the value, and after reload
   `data-theme` equals the last-toggled value;
   (f) pull badge click-through — clicking `🔐 PULLS ▸ N` changes `window.location.search` to
   `session=<oldest sinceTs pull>&project=<projectId>`.
   Record pass/fail per step + the screenshot pairs in the ledger. Any failure blocks the PR.
   (Task 14's parity test runs in the no-DOM env and does NOT substitute for this visual
   check.)

## Global Constraints

1. **Arcade is the base, not a variant.** No existing rule in `terminal.css` is scoped under
   `[data-theme="arcade"]`; Arcade renders from today's rules untouched. Clean is one appended,
   fenced override section: `/* ===== CLEAN THEME (data-theme="clean") ===== */`.
2. **Absolute functional parity (PRD §5.2).** Every control, state, and affordance exists in
   both themes; a theme changes how something reads, never whether it is there. The one allowed
   behavioral difference is spec §2.2's opt-in rule: Clean does not AUTO-open the arcade
   strip's game lane while the agent is busy — Clean's busy state shows the thinking strip's
   status line without the game lane (manual open works identically in both).
3. **Same density (spec R2).** No geometry, spacing, grid, row-height, or font-size value
   changes between themes. Clean overrides decoration only: fonts, colors, shadows, animations,
   CRT effects, and letter-tracking (`--track-label` — a type-decoration knob, explicitly
   permitted so Task 6's `--track-label: 0` cannot collide with this constraint). (The arcade
   strip's resize (Task 13) is theme-independent and user-driven — not a density difference
   between themes.)
4. **AA floor with documented ratios.** Every Clean SOLID color token override carries an
   inline contrast-ratio comment in the same style as the base palette (`terminal.css:26-41`)
   and holds ≥ 4.5:1 for text tokens (≥ 3:1 for decorative rules, matching the base file's own
   annotations); alpha wash/mute tokens are exempt, as in the base palette (which annotates
   none of them). Verified MECHANICALLY with the verbatim command in Task 6's Verify, AND by
   the live-walk both-theme screenshot review (done gate step 2) — together the spec §5
   mitigation pair ("documented-ratio convention + review").
5. **Reduced motion is honored in both themes.** The existing blocks (`terminal.css:583-590`,
   `707-709`) remain the motion authority; Clean removes motion, never adds it.
6. **Preferences are client-local.** localStorage keys `mpai-theme` and `mpai-arcade-size`;
   never in the protocol, never synced. Absent/invalid values fall back silently to defaults
   (`"arcade"` / the default scale). **Both directions of storage access are guarded:** WRITE
   failures (private mode / quota — `setItem` throws) are caught, the preference still applies
   in-session; the initial READ is also try/catch-wrapped (`localStorage` access throws
   SecurityError in blocked-storage sandboxes/iframes) — a throwing read yields `null` and the
   silent default, never a crash. Two participants in one session may differ.
7. **Scoped diff:** no file outside `poc/client/` and `docs/` changes in any task. Game ENGINES
   (`poc/client/src/game/*.ts` pure engines) are untouched — footprint work is presentation
   scaling only. The user's WIP `poc/client/src/game/tetris.test.ts` is never staged.
8. **Rollback = revert the commit.** Every task except Task 3 is additive presentation;
   localStorage keys are optional reads, so reverts leave no bad state (stale keys are ignored
   by old code). **Task 3 is the one DELETION task** — it retires the `Cabinet` component, the
   `LEGEND` constant (App.tsx:39), and the chrome CSS rules (css:189-211) for all users with
   no flag; its blast radius is the cabinet chrome only, and its rollback is still a clean
   single-commit revert that restores the retired chrome verbatim. **Mid-chain rollback is
   ordered:** revert in REVERSE dependency order (newest dependent first), or revert the whole
   feature as one range — a lone mid-chain revert can leave later tasks' selectors/props
   dangling.
9. **Existing-behavior regression floor:** with `mpai-theme` absent and no resize stored, the
   app renders Arcade with today's behavior (modulo the deliberate changes: marquee fold,
   smaller default arcade lane, new gate bar/surfacing affordances, the newly-styled
   sub-session rail/chips (Task 4 — those classes render near-unstyled today), and the compact
   row's keyboard a11y attributes (Task 5)).
10. **Test-first (lean-tdd).** Each task's `T<n>-<row-name>` tests are written FIRST and
    watched fail before that row's implementation code; a test that passes on its first run is
    distrusted until proven able to fail.

## Task Dependency Table

| # | Task | Files touched | Depends on | Risk tier |
|---|------|--------------|------------|-----------|
| 1 | Theme hook (pure) | `poc/client/src/theme.ts` (new), `poc/client/src/theme.test.ts` (new) | — | standard |
| 2 | Theme wiring: header toggle + CRT coupling | `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx`, `poc/client/src/components/Header.tsx`, `poc/client/src/components/Header.test.tsx` | 1 | standard |
| 3 | Full-bleed: retire Cabinet, fold marquee/legend (atomic — see note) | `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx`, `poc/client/src/components/Crt.tsx`, `poc/client/src/terminal.css` | 2 | standard |
| 4 | PR-#32 rider: sub-session styling (CSS) | `poc/client/src/terminal.css` | 3 | standard |
| 5 | PR-#32 rider: compact-row keyboard a11y | `poc/client/src/components/Transcript.tsx`, `poc/client/src/components/Transcript.test.tsx` | 3 | standard |
| 6 | Clean skin CSS (token overrides, shadows, flourishes) | `poc/client/src/terminal.css` | 2, 4 | judgment |
| 7 | Games opt-in rule + Clean busy status line | `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx` | 3 | standard |
| 8 | §8.5: pinned gate bar component + placement | `poc/client/src/components/GateBar.tsx` (new), `poc/client/src/components/GateBar.test.tsx` (new), `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx`, `poc/client/src/terminal.css` | 6, 7 | judgment |
| 9 | §8.5: jump-to-card (card ids + scroll) | `poc/client/src/components/Transcript.tsx`, `poc/client/src/components/Transcript.test.tsx`, `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx` | 5, 8 | standard |
| 10 | §8.5: wheel-on-card | `poc/client/src/components/Transcript.tsx`, `poc/client/src/components/Transcript.test.tsx`, `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx` | 9 | standard |
| 11 | §8.5: pull click-through | `poc/client/src/components/Header.tsx`, `poc/client/src/components/Header.test.tsx`, `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx` | 10 | standard |
| 12 | Arcade footprint: smaller default scale | `poc/client/src/components/ThinkingStrip.tsx`, `poc/client/src/components/ThinkingStrip.test.tsx` (new) | — | standard |
| 13 | Arcade footprint: drag/keyboard resize control | `poc/client/src/components/ThinkingStrip.tsx`, `poc/client/src/components/ThinkingStrip.test.tsx`, `poc/client/src/terminal.css` | 8, 12 | standard |
| 14 | Cross-theme parity test | `poc/client/src/parity.test.tsx` (new) | 1–13 | standard |
| 15 | Docs: PRD §8.5 / §8.9 / §5.1 update | `docs/PRD.md` | 1–13 landed | mechanical |

**Serialization and concurrency:** 1→2→3 are serial (App.tsx). After 3, three file-disjoint
lanes open concurrently: **4** (terminal.css), **5** (Transcript.tsx — its compact row already
exists from PR #32; no edge to 4, they share no file), and **7** (App.tsx — the opt-in logic
is theme-VALUE-driven, testable without Task 6's skin, so no buildability edge to 6). 6 follows
4 (terminal.css chokepoint: writers 3→4→6→8→13). 8 waits on 6 (css) + 7 (App); 9→10→11 serial
on Transcript.tsx/App.tsx after 8. **12 is file-disjoint from everything except 13**
(ThinkingStrip only) and may run any time. 13 waits for 8 (last terminal.css writer) + 12, and
runs concurrently with 9–11 (disjoint files). 14 and 15 are disjoint from each other and run
concurrently after all of 1–13.

---

## Task 1 — Theme hook (pure)

**Spec:** §2.1. **Files:** create `poc/client/src/theme.ts`, `poc/client/src/theme.test.ts`.

**Interfaces — produces (exact):**
```ts
// theme.ts
export type Theme = "arcade" | "clean";
export const THEME_KEY = "mpai-theme";
export function readStoredTheme(raw: string | null): Theme;   // pure: "clean" -> "clean", anything else -> "arcade"
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void };
```
`useTheme` owns: initial read of `localStorage[THEME_KEY]` — the `getItem` call itself wrapped
in try/catch (throw → `null` → `readStoredTheme` default; constraint 6) — and, on every change,
sets `document.documentElement.dataset.theme = theme` and writes the key with the `setItem`
also wrapped in try/catch.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| default | no stored key | theme `"arcade"`, `data-theme="arcade"` on documentElement |
| invalid stored | `localStorage["mpai-theme"] = "neon"` | falls back to `"arcade"` silently |
| stored clean | key = `"clean"` | theme `"clean"`, attribute `"clean"` |
| setTheme | `setTheme("clean")` | state flips, attribute updates, key persisted |
| storage read throws | `localStorage.getItem` throws (blocked-storage sandbox) | no crash; theme `"arcade"` (default), attribute set — read guarded |
| storage write fails | `localStorage.setItem` throws (private mode / quota) | no crash; theme state AND `data-theme` attribute still update — preference degrades to in-session only |
| pure helper | `readStoredTheme(null / "clean" / "ARCADE" / "")` | `"arcade"` / `"clean"` / `"arcade"` / `"arcade"` |

**Exact values:** key `mpai-theme`; values `"arcade"`/`"clean"`; attribute `data-theme` on
`document.documentElement`.

**Verify:** client suite command; exits 0, tsc clean. Test titles `T1-<row-name>`, all in
`theme.test.ts` (hook rows via the hooks-shim pattern of
`poc/client/src/components/Transcript.test.tsx` — its `renderTree` helper; storage-throw rows
stub `localStorage` accessors to throw).
**Commit:** `feat(client): theme hook — mpai-theme persistence, data-theme writer, guarded storage`

---

## Task 2 — Theme wiring: header toggle + CRT coupling

**Spec:** §2.1. **Files:** modify `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx`,
`poc/client/src/components/Header.tsx`, `poc/client/src/components/Header.test.tsx`.

**Why atomic (toggle + CRT coupling in one commit):** spec §2.1 couples CRT intensity to the
theme value — the toggle's observable effect INCLUDES the CRT swap. A commit shipping the
toggle without the coupling renders a broken intermediate state (CRT effects fully on in
Clean); a commit shipping the coupling without the toggle has no way to reach Clean at all.
Both rows are the single "theme value reaches the app" wiring and share the same
App.test.tsx fixtures. Two source files + their two test files.

**Interfaces — consumes:** Task 1's `useTheme`. **Produces:** Header gains props
`theme: Theme` and `onThemeToggle: () => void`.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| toggle | click the header THEME button | theme flips via `setTheme`, attribute updates, key persisted (Task 1's hook does the work) |
| button label | theme arcade / clean | header button (class `planmode`) reads exactly `THEME ▸ ARCADE` / `THEME ▸ CLEAN`; present in BOTH themes |
| CRT coupling | theme clean / arcade | App renders `<Crt intensity="off">` / `<Crt intensity="full">` (App.tsx:172-174 mount) |
| button placement | header render | THEME button renders in the `.term-header` control run beside ARCADE (Header.tsx:112-123 area) |

**Exact values:** button labels above.

**Verify:** client suite; exits 0, tsc clean. Test titles `T2-<row-name>` in `App.test.tsx` /
`Header.test.tsx` (hooks-shim pattern of `poc/client/src/components/Transcript.test.tsx`'s
`renderTree` helper).
**Commit:** `feat(client): theme wiring — header toggle and CRT intensity coupling`

---

## Task 3 — Full-bleed: retire Cabinet, fold marquee/legend

**Spec:** §2.3 (PRD §5.1 remainder). **Files:** modify `poc/client/src/App.tsx`,
`poc/client/src/App.test.tsx`, `poc/client/src/components/Crt.tsx`,
`poc/client/src/terminal.css`.

**Why atomic (council round-2 ruling, justify arm):** the marquee and legend exist ONLY as
`Cabinet`'s own chrome (`Crt.tsx:39-66` renders both inside the component); retiring `Cabinet`
without folding them is not a buildable intermediate state — it would require constructing
throwaway standalone chrome for one commit. One component deletion, one commit.

**Why no feature flag (affirmative decision, not an omission):** the deletion is spec-mandated
(§2.3 closes PRD §5.1's remainder), client-side, and single-commit-revertible; the pre-PR
live-walk gate (done gate step 2(d), which blocks the PR on the objective marquee-fold check)
IS the pre-merge staging that a flag would otherwise provide.

**Interfaces — consumes:** Task 2's App mount shape (`<Crt intensity={...}>`).
**Interfaces — produces:** App renders `<Crt>` as the page root (no `Cabinet`); `Crt.tsx` no
longer exports `Cabinet`.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| glass is the page | App render | no `.cabinet`, `.crt-chrome-top`, `.marquee`, or legend `.lobby-foot` chrome wrapper in the App tree; `<Crt>` wraps `screenBody()` directly |
| no duplicate identity | header | the `.term-header` breadcrumb (already leading `multiplayer_ai`, Header.tsx:63-66) is the sole identity line; the marquee sub-tagline is dropped, not relocated |
| props.right (spec §2.3) | `Cabinet`'s `right?: ReactNode` prop | NO live use — grep-confirmed at plan time: the sole mount (App.tsx:172) passes only `legend`. Nothing relocates to the header; the prop dies with the component. Report re-confirms via grep #1 below |
| legend dropped | App | the `LEGEND` constant (App.tsx:39) and its render path are deleted |
| dead chrome removed | terminal.css | `.crt-chrome-top`/`.marquee`/`.marquee-title`/`.marquee-sub` rules (css:200-211) deleted; `.cabinet`/`.cabinet-inner` (189-199) deleted if unused after the change; `.lobby-foot` RETAINED if any other surface still uses it (grep #5; state which in the report) |
| CRT fx intact | Arcade render | `.crt-scan/.crt-vig/.crt-tint/.crt-roll/.crt-bezel` layers unchanged (Crt.tsx:30-34) |
| regression | main session surface | Header, HUD, row, ThinkingStrip, PromptBar all render exactly as before inside the glass |

**Exact values:** none new.

**Verify:** client suite; exits 0, tsc clean. Dead-chrome deletion is grep-verified with
expected results stated in the report:
1. `command grep -rn "Cabinet" poc/client/src` → **no hits** (or the report names each
   survivor and why it lives).
2. `command grep -n "crt-chrome-top\|marquee\|cabinet" poc/client/src/terminal.css` → **no
   hits**.
3. `command grep -rn "crt-chrome-top\|marquee" poc/client/src --include="*.tsx"` → **no hits**.
4. `command grep -n "LEGEND" poc/client/src/App.tsx` → **no hits**.
5. `command grep -rn "lobby-foot" poc/client/src` → decides the retention row: hits outside the
   deleted App path ⇒ rule retained + hits named in the report; zero hits ⇒ rule deleted too.
Test titles `T3-<row-name>`.
**Commit:** `feat(client): full-bleed — glass is the page, marquee and legend folded`

---

## Task 4 — PR-#32 rider: sub-session styling (CSS)

**Spec:** §2.5. **Files:** modify `poc/client/src/terminal.css` ONLY. **Deterministic file
set:** the rail's inline styles (PR #32 as-shipped:
`poc/client/src/components/SubSessionRail.tsx:25` `overflowX: "auto", whiteSpace: "nowrap"`,
already pinned by `SubSessionRail.test.tsx:175-183`) STAY untouched — the new
`.subsession-rail` rule adds only decoration the inline styles don't set. No migration; no
`.tsx` file is in this task's diff. (The 4→5 serial dependency holds regardless — 5 depends
on 4 in the table either way.)

**Why one task:** lamp extraction plus the six-class rule set are one cohesive styling unit —
a single surface (the sub-session transcript area), a single stylesheet section, no behavior.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| lamp standalone | css | `.lamp` extracted to a standalone rule (from `.subagent .lamp`, css:646-651); the old scoped rule remains until the legacy `.subagent` block is retired (NOT this task) |
| six classes styled | css | rules exist for `.subagent-row`, `.subsession-rail`, `.subsession-chip` (+ `.active` accent-marked, `.gated` amber-marked, `.done` dimmed), `.subsession-header`, `.perm-sub`, `.badge` — existing vocabulary (tokens, 2px frames, `.pix` labels); no new colors outside the token set |
| rail overflow | 12 chips | horizontal scroll still via the rail's inline styles (untouched — behavior identical: no wrap, scrollable) |

**Exact values:** class names above, verbatim (they are already in the markup).

**Verify:** client suite; exits 0, tsc clean (regression only — this task adds no behavior).
CSS rows are grep-asserted, not unit-tested (the repo has no DOM/layout env); expected results
stated in the report:
1. `command grep -n "^\.lamp\b\|^\.lamp " poc/client/src/terminal.css` → exactly **1**
   standalone `.lamp` rule (the scoped `.subagent .lamp` at css:646-651 still present,
   matched separately by `command grep -n "\.subagent \.lamp" …` → **1 hit**).
2. For EACH of `subagent-row`, `subsession-rail`, `subsession-chip`, `subsession-header`,
   `perm-sub`: `command grep -c "<name>" poc/client/src/terminal.css` → **≥ 1**; plus
   `command grep -cn "^\.badge\b\|^\.badge " …` → **≥ 1**.
3. Chip states: `command grep -n "subsession-chip.active\|subsession-chip.gated\|subsession-chip.done" poc/client/src/terminal.css` → **3 distinct rules**.
4. Token-only colors: `command grep -n "#[0-9a-fA-F]" <the added hunks via git diff terminal.css>` → **no hits** (all color via `var(--…)`).
5. No-wrap/scroll intact where it lives (the untouched inline styles):
   `command grep -n "nowrap" poc/client/src/components/SubSessionRail.tsx` → **≥ 1 hit** (at
   :25 today), and `command grep -n "overflowX" poc/client/src/components/SubSessionRail.tsx`
   → **≥ 1 hit**; plus `git diff --name-only <commit>` →
   **`poc/client/src/terminal.css` only**.
**Commit:** `feat(client): sub-session surface styled — lamp standalone, rail and chips`

---

## Task 5 — PR-#32 rider: compact-row keyboard a11y

**Spec:** §2.5. **Files:** modify `poc/client/src/components/Transcript.tsx`,
`poc/client/src/components/Transcript.test.tsx`.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| row keyboard access | compact row (Transcript.tsx:334-345) | gains `role="button"`, `tabIndex={0}`; Enter and Space invoke the same open handler as click |
| row semantics regression | MAIN compact row | text pieces and click behavior from PR #32 unchanged (`⚒ SUB-QUEST`, label, status, `N rows`, `open ▸`) |

**Exact values:** `role="button"`, `tabIndex={0}`; keys `Enter` and ` ` (Space).

**Verify:** client suite; exits 0, tsc clean. Test titles `T5-<row-name>` in
`Transcript.test.tsx` (its existing `renderTree` hooks-shim helper).
**Commit:** `feat(client): compact sub-session row keyboard a11y`

---

## Task 6 — Clean skin CSS (token overrides, shadows, flourishes)

**Spec:** §2.2, plus ruling R5 for the four derived alphas (mixed provenance disclosed — the
spec enumerates the solids; R5, logged in the review file's cycle-2 rulings, extends the set
to their rgba() derivations). **Files:** modify `poc/client/src/terminal.css` ONLY (pure
styling; the behavioral opt-in gate is Task 7).

**Why atomic (tokens + shadows + flourishes in one commit):** all three rows are edits to the
SAME fenced section (constraint 1 — one appended unit), so splitting yields zero concurrency
(same-file serial writers) while shipping partial-theme intermediate states — a Clean with
re-pointed colors but arcade offset-shadows and a sweeping wheelbanner is not a coherent theme
any commit should render. One fence, one commit.

**Closed override set (no "at minimum"):** the tokens named in the token-overrides row below
are the COMPLETE set — no token outside it is overridden, and no geometry/spacing token is
ever overridden (constraint 3). Spec §2.2 enumerates the re-pointed solids (`--accent`,
`--gold`, `--amber`, `--green`, `--red`, plus `--frame`); the four derived alphas ride along
by ruling R5 (review file, cycle-2 rulings): in the base palette they are literal `rgba()`
derivations of their solids (`--amber-mute`/`--amber-wash` of `--amber`, css:38-39;
`--gold-wash` of `--gold`, css:42; `--green-wash` of `--green`, css:43) — re-pointing a solid
without its derived alphas would render the OLD hue washing behind the NEW hue. Decorative-
only, AA-comment-exempt (constraint 4).

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| fenced section | terminal.css | one appended section opening exactly `/* ===== CLEAN THEME (data-theme="clean") ===== */`; no Clean rule outside it; no existing rule modified (constraint 1) |
| token overrides | `:root[data-theme="clean"]` | EXACTLY this set (closed — see note above): `--pf: var(--fm)`, `--track-label: 0`, `--chunk: none`, `--chunk-sm: none`; re-pointed solids per spec §2.2: `--frame`, `--accent`, `--gold`, `--amber`, `--green`, `--red` — each with an inline documented contrast ratio (constraint 4); their derived alphas per ruling R5: `--amber-mute`, `--amber-wash`, `--gold-wash`, `--green-wash` (AA-exempt). `--bg`/`--panel`/`--input`/`--fg`/`--dim` retained; nothing else overridden |
| hardcoded shadow sites | Clean | `[data-theme="clean"]` overrides set the two literal offset shadows to `none`: `.btn:active` (css:124) and `.perm:has(.perm-actions)` (css:357) |
| stilled flourishes | Clean | `.wheelbanner` renders static (its `sweepbg` animation off via `animation: none`); `.crt-fx` already hidden via Task 2's `intensity="off"` coupling — no duplicate CSS needed |
| arcade regression | theme arcade | zero visual/behavioral change from this task (no base rule touched) |

**Exact values:** the fence comment string above; `--pf: var(--fm)`; `--chunk: none`;
`--chunk-sm: none`; `--track-label: 0`. The six solid hex values are **(proposed — confirm)**
by design: implementer-proposed under constraint 4, confirmed by the two-part gate — the
mechanical AA computation below AND the live-walk both-theme screenshot review (done gate
step 2), the spec §5 mitigation pair. No other value in this task is open.

**Verify:** client suite; exits 0, tsc clean (regression only). All rows grep- and
computation-asserted, results in the report. **`<fenced section>` below is the concrete
extraction** `sed -n '/===== CLEAN THEME/,$p' poc/client/src/terminal.css` (the fence is the
last section of the file by constraint 1 — everything from the fence line down):
1. Fence exists once: `command grep -c "===== CLEAN THEME" poc/client/src/terminal.css` →
   exactly **1**.
2. Containment: every hit of `command grep -n 'data-theme="clean"' poc/client/src/terminal.css`
   is at or below the fence's line number (no Clean rule above the fence).
3. Each required override present inside the fence: for EACH token in the token-overrides row
   (`--pf`, `--track-label`, `--chunk`, `--chunk-sm`, `--frame`, `--accent`, `--gold`,
   `--amber`, `--amber-mute`, `--amber-wash`, `--gold-wash`, `--green-wash`, `--green`,
   `--red`): `command grep -n "<token>:" <fenced section>` → **≥ 1 hit**; exact-value tokens
   match verbatim (`--pf: var(--fm)` etc.).
4. AA comments present: every SOLID color token override line also matches `/\*.*:1` (the
   inline ratio comment) — `command grep -n "^\s*--\(frame\|accent\|gold\|amber\|green\|red\):" <fence> | command grep -v ":1"` → **no hits**.
5. Shadow sites: `command grep -n "btn:active\|perm:has" <fenced section>` → **2 hits**, each
   rule containing `box-shadow: none` (`command grep -c "box-shadow: none" <fenced section>` →
   **≥ 2**).
6. Stilled wheelbanner: `command grep -n "wheelbanner" <fenced section>` → **≥ 1 hit**, the
   rule containing `animation: none`.
7. **Mechanical AA check (verbatim command, explicit pass condition):** run, with every
   overridden solid hex value as arguments:
   ```
   node -e 'const L=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4);return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]};const r=(a,b)=>{const[x,y]=[L(a),L(b)].sort((p,q)=>q-p);return((x+0.05)/(y+0.05)).toFixed(2)};for(const t of process.argv.slice(1))console.log(t, r(t, "#0b0d10"))' "#<hex1>" "#<hex2>" …
   ```
   Paste command + output into the task report. PASS = ≥ **4.5:1** for text tokens
   (`--accent`, `--gold`, `--amber`, `--green`, `--red`), ≥ **3:1** for decorative (`--frame`,
   matching the base file's annotation style); alpha wash/mute tokens exempt, as in the base
   palette (which annotates none of them). Each inline comment must state the computed ratio
   (2 dp).
**Commit:** `feat(client): clean theme — fenced token override layer`

---

## Task 7 — Games opt-in rule + Clean busy status line

**Spec:** §2.2 ("Clean's busy state shows the thinking strip's status line without the game
lane", spec:94-95). **Files:** modify `poc/client/src/App.tsx`, `poc/client/src/App.test.tsx`.

**Interfaces — consumes:** Task 2's `theme` in App. (No dependency on Task 6: the opt-in logic
is theme-VALUE-driven and its tests run in the no-DOM env — the Clean skin's presence is
irrelevant to buildability; the combined live look is checked at the done-gate walk.)

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| games opt-in | Clean, agent becomes busy | the game LANE does not auto-open (App's busy auto-open path gated `theme === "arcade"`); the ARCADE header button and idle hotkey `A` still open it, and once open it behaves identically |
| busy status line | Clean, agent busy | the thinking strip's STATUS LINE still renders (spec §2.2 verbatim: status line without the game lane) — the busy-thinking affordance exists in both themes |
| arcade unchanged | Arcade, agent busy | auto-open exactly as today |
| decidability | Clean, pending gate | gate cards, wheel controls, and all buttons remain present and functional (parity — constraint 2) |

**Exact values:** gate condition `theme === "arcade"` on the auto-open path only; ESC/G/SPACE
behavior unchanged when open (spec:95).

**Verify:** client suite; exits 0, tsc clean. Test titles `T7-<row-name>` in `App.test.tsx`
(hooks-shim pattern of `poc/client/src/components/Transcript.test.tsx`'s `renderTree` helper),
covering all four rows — including `T7-busy-status-line` asserting the status line renders in
Clean-busy with the lane closed.
**Commit:** `feat(client): clean games opt-in — busy keeps status line, lane opens manually`

---

## Task 8 — §8.5: pinned gate bar component + placement

**Spec:** §2.4 (proposal 1 of 3, approved with the spec). **Files:** create
`poc/client/src/components/GateBar.tsx`, `poc/client/src/components/GateBar.test.tsx`; modify
`poc/client/src/App.tsx`, `poc/client/src/App.test.tsx`, `poc/client/src/terminal.css`.

**Interfaces — produces (exact):**
```ts
// GateBar.tsx
export interface GateBarProps {
  // Derived in App from derived.events: the NEWEST `permission_request` event whose
  // requestId is not in derived.permissionDecisions (exact rule already used by the
  // a/d hotkeys — App.tsx:264, Transcript.tsx:61-77). subLabel joins on the gate
  // event's parentToolUseId via the EXISTING pattern (Transcript.tsx:56 and :154):
  //   new Map(deriveSubSessions(events).map(s => [s.key, s.label]))
  //     .get(gateEvent.parentToolUseId)   // undefined -> no subLabel
  gate: { requestId: string; toolName: string; subLabel?: string } | null;
  isDriver: boolean;        // derived.driverId === userId (App.tsx:274)
  driverName?: string;      // derived.participants.get(derived.driverId)?.name  (derive.ts:5-7)
  driverGlyph?: string;     // derived.participants.get(derived.driverId)?.glyph (same source)
  onDecide: (requestId: string, decision: "allow" | "deny") => void;  // sendPermission (App.tsx:455)
  onTakeWheel: () => void;
  onJump: (requestId: string) => void;   // scroll target lands in Task 9
}
export function GateBar(props: GateBarProps): JSX.Element | null;   // null when gate is null
```
GateBar styling — exact token mapping (the existing permission-gate vocabulary, css:34-43):
`.gatebar` frame `--amber` (2px, the gate color), background `--amber-wash`, text `--fg`,
tool name `--amber`, sub-label `--dim` with the `⚒` prefix (matching `.perm-sub`); non-driver
variant frame `--amber-mute`; buttons reuse the existing classes verbatim (`btn green` /
`btn red` / `btn gold`) with no new rules. `.gatebar` rules are appended to `terminal.css`
OUTSIDE the Clean fence — it is a base-theme surface, present in both themes; no color
outside the token set.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| hidden | `gate: null` | GateBar renders null; layout untouched (regression floor for sessions without gates) |
| driver bar | undecided gate, isDriver | element class `gatebar`; text contains `🔐 <toolName>` and, when `subLabel` present, `⚒ <subLabel>`; `[A]PPROVE` (`btn green`) and `[D]ENY` (`btn red`) invoke `onDecide(requestId, "allow"/"deny")` |
| non-driver bar | undecided gate, not driver | text `🔐 waiting on <glyph> <name>`; button `🛞 TAKE THE WHEEL` invokes `onTakeWheel()`; no decide buttons |
| jump wiring | click the bar body (not its buttons) | `onJump(requestId)` fires (App's scroll handler is Task 9; this task wires the callback) |
| newest-first | two undecided gates | the bar shows the NEWEST undecided gate (same target rule as the existing a/d hotkeys, App.tsx:264 / Transcript.tsx:61-77) |
| placement | App default session surface | bar renders directly above PromptBar, only on the default transcript surface (not workflows/skills/oversight/invite), in BOTH themes |
| hotkeys regression | driver, a/d pressed | existing hotkey path unchanged; bar buttons and hotkeys hit the same decision callback (`sendPermission`, App.tsx:455) |

**Exact values:** class `gatebar`; button texts `[A]PPROVE`, `[D]ENY`, `🛞 TAKE THE WHEEL`;
bar text pieces as in the rows above.

**Verify:** client suite; exits 0, tsc clean. Test titles `T8-<row-name>` — GateBar-local rows
in `GateBar.test.tsx`, placement/derivation rows in `App.test.tsx` (hooks-shim pattern of
`poc/client/src/components/Transcript.test.tsx`'s `renderTree` helper).
**Commit:** `feat(client): §8.5 pinned gate bar above the prompt`

---

## Task 9 — §8.5: jump-to-card

**Spec:** §2.4 (proposal 1, the jump affordance). **Files:** modify
`poc/client/src/components/Transcript.tsx`, `poc/client/src/components/Transcript.test.tsx`,
`poc/client/src/App.tsx`, `poc/client/src/App.test.tsx`.

**Interfaces — produces:** each gate card's root element in Transcript gains
`id={"perm-" + requestId}`; App's `onJump` handler scrolls the matching element into view.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| card id | any gate card render | root element carries `id="perm-<requestId>"` |
| jump | GateBar `onJump(requestId)` fires | App's handler scrolls the matching `#perm-<requestId>` card into view (`scrollIntoView`) |
| no target | `onJump` with a requestId whose card is not mounted | no-op, no crash |

**Exact values:** card id prefix `perm-`.

**Verify:** client suite; exits 0, tsc clean. Test titles `T9-<row-name>` — card-id rows in
`Transcript.test.tsx` (its `renderTree` helper), jump-handler rows in `App.test.tsx`.
**Assertion mechanism for the DOM-only row (no-DOM env):** `T9-jump` stubs
`document.getElementById` to return an object carrying a `scrollIntoView` spy and asserts the
handler calls it for id `perm-<requestId>`; `T9-no-target` stubs it to return `null` and
asserts no throw.
**Commit:** `feat(client): §8.5 jump-to-card — gate bar click scrolls to the gate`

---

## Task 10 — §8.5: wheel-on-card

**Spec:** §2.4 (proposal 2 of 3). **Files:** modify `poc/client/src/components/Transcript.tsx`,
`poc/client/src/components/Transcript.test.tsx`, `poc/client/src/App.tsx`,
`poc/client/src/App.test.tsx`.

**Interfaces — produces (exact):** Transcript gains optional prop `onTakeWheel?: () => void`;
App passes the same take-wheel handler already wired to GateBar (Task 8).

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| wheel-on-card | non-driver, undecided gate card | `.perm-outcome` area gains a `🛞 TAKE THE WHEEL` button (`btn gold`) invoking Transcript's `onTakeWheel`; card does NOT auto-decide after transfer — driver decides on the card as normal |
| wheel-on-card absent | decided gate, or already driver | no such button (driver sees the existing `[A]/[D]` actions) |
| prop absent | `onTakeWheel` not passed | no button rendered; existing card behavior byte-identical (optional-prop regression floor) |

**Exact values:** button text `🛞 TAKE THE WHEEL` (`btn gold`), identical to Task 8's bar
button.

**Verify:** client suite; exits 0, tsc clean. Test titles `T10-<row-name>` in
`Transcript.test.tsx` (existing `renderTree` hooks-shim helper) and `App.test.tsx` for the
handler-sharing row.
**Commit:** `feat(client): §8.5 wheel-on-card for non-driver gates`

---

## Task 11 — §8.5: pull click-through

**Spec:** §2.4 (proposal 3 of 3). **Files:** modify `poc/client/src/components/Header.tsx`,
`poc/client/src/components/Header.test.tsx`, `poc/client/src/App.tsx`,
`poc/client/src/App.test.tsx`.

**Interfaces — produces (exact):** Header's pulls badge gains `onPullsClick?: () => void`.
**Data source, exact:** App's existing `pulls: Pull[]` memo (App.tsx:226, computed by
`pullsFrom` — `poc/client/src/pulls.ts:49`; `Pull = { sessionId, toolName, sinceTs, driverName }`).
**Oldest-waiting** = the pull with the MINIMUM `sinceTs` (ISO timestamp) in that array.
**Navigation call, all three arguments pinned** (`sessionUrlFrom(search, sessionId, projectId)`
— `poc/client/src/pickerUrl.ts:28`, projectId is a REQUIRED third argument):
```ts
window.location.search = sessionUrlFrom(window.location.search, oldest.sessionId, projectId);
```
where `projectId` is the Session component's own prop (App.tsx:191) — CORRECT by construction,
not a guess: `pulls` derives from `projectSessions`, the socket's project-scoped session list
for exactly that `projectId` (`useSessionSocket({ projectId, … })`, App.tsx:193/:195), so
every pull's target session is in the CURRENT project. Same call shape as the existing
`SessionPicker.tsx:535` site. No new URL construction.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| pulls click-through | header badge, pulls > 0 | the `🔐 PULLS ▸ N` badge is a real `<button>` (keyboard-operable) invoking `onPullsClick`; App navigates to the oldest-waiting pull's session (min `sinceTs`) via the existing `?session=` switch (`sessionUrlFrom`) |
| empty at click | handler invoked while `pulls` is empty (count dropped between render and click) | no-op — no navigation, no crash (`sessionUrlFrom` never called without a target) |
| pulls regression | pulls = 0 | no badge, exactly as today (Header.tsx:162-166) |
| prop absent | `onPullsClick` not passed | badge renders as today, non-interactive (optional-prop regression floor) |

**Exact values:** badge text `🔐 PULLS ▸ N` unchanged; ordering key `sinceTs` (minimum wins).

**Verify:** client suite; exits 0, tsc clean. Test titles `T11-<row-name>` — badge rows in
`Header.test.tsx`, navigation + empty-set rows in `App.test.tsx` (hooks-shim pattern of
`poc/client/src/components/Transcript.test.tsx`'s `renderTree` helper).
**Assertion mechanism for the navigation row (no-DOM env):** `T11-navigation` asserts the
handler computes `sessionUrlFrom(search, <min-sinceTs pull>.sessionId, projectId)` — via a
module spy on `sessionUrlFrom` or by asserting the produced query string contains
`session=<oldest>&project=<projectId>`; `T11-empty` asserts `sessionUrlFrom` is NOT called
when `pulls` is empty.
**Commit:** `feat(client): §8.5 pull badge click-through to oldest waiting session`

---

## Task 12 — Arcade footprint: smaller default scale

**Spec:** §2.6 (R4). **Files:** modify `poc/client/src/components/ThinkingStrip.tsx`; create
`poc/client/src/components/ThinkingStrip.test.tsx`.

**Interfaces — produces (exact):**
```ts
// ThinkingStrip.tsx additions
export const ARCADE_SIZE_KEY = "mpai-arcade-size";
export const ARCADE_SCALE = { min: 0.5, max: 1.0, default: 0.65, step: 0.05 } as const;
export function readStoredScale(raw: string | null): number;  // pure: parse float, clamp to [min,max]; NaN/absent -> default
```
The initial `localStorage.getItem(ARCADE_SIZE_KEY)` call is try/catch-wrapped (throw → `null`
→ `readStoredScale` default; constraint 6).

**Why the default changes for everyone with no flag (affirmative decision):** the smaller
default is spec-mandated (R4: "smaller games"), client-side, immediately user-adjustable back
to 1.0 via Task 13's resize control (whose stored value then persists), and clean-revert
reversible — a flag would duplicate what `mpai-arcade-size` already provides.

**Lane font-size base (pinned — council round-1 ruling 2):** the `.lane` rule
(`terminal.css:446-450`) sets NO font-size today; the effective base is the mono base token
`--fs` = **13px** (`terminal.css:48`). The scaled lane font-size is set as an inline style on
the `.lane` `<pre>`: `fontSize: calc(var(--fs) * <scale>)` — at the default 0.65 that computes
to **8.45px**; at scale 1.0 it equals today's 13px exactly.

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| smaller default | no stored key | game lane renders at scale 0.65: inline `fontSize` exactly `calc(var(--fs) * 0.65)` on the `.lane` `<pre>`; engines untouched (constraint 7) |
| stored scale | key = "0.8" | lane at 0.8 (`calc(var(--fs) * 0.8)`) |
| invalid stored | key = "abc" / "" / "9" | default 0.65 / default / clamped 1.0 |
| storage read throws | `localStorage.getItem` throws (blocked-storage sandbox) | no crash; scale = default 0.65 — read guarded |
| theme independence | arcade + clean themes | identical scale and stored value in both |

**Exact values:** key `mpai-arcade-size`; clamp/default values in `ARCADE_SCALE`; lane base
`--fs` 13px; inline style `calc(var(--fs) * <scale>)`.

**Verify:** client suite; exits 0, tsc clean. Test titles `T12-<row-name>` in
`ThinkingStrip.test.tsx` (pure helper + storage-throw rows directly; render rows via the
hooks-shim pattern of `poc/client/src/components/Transcript.test.tsx`'s `renderTree` helper).
**Commit:** `feat(client): arcade lane smaller by default — 0.65 of --fs, stored scale honored`

---

## Task 13 — Arcade footprint: drag/keyboard resize control

**Spec:** §2.6 (R4, user-adjustable). **Files:** modify
`poc/client/src/components/ThinkingStrip.tsx`, `poc/client/src/components/ThinkingStrip.test.tsx`,
`poc/client/src/terminal.css`.

**Interfaces — consumes:** Task 12's `ARCADE_SCALE`, `ARCADE_SIZE_KEY`, stored-scale state.

**Drag mapping (pinned — council round-2 ruling):** vertical axis only. On `pointerdown` the
handle captures `anchorScale` (current scale) and `anchorY` (`event.clientY`). On each
`pointermove`: `scale = clamp(anchorScale + (anchorY − clientY) / 400, 0.5, 1.0)` — dragging UP
grows the strip (matches ArrowUp); with the /400 divisor, **200px of travel spans the full
0.5-wide clamp range** (a deliberately gentle feel). The stored key is
written once per gesture, on `pointerup` (keyboard steps persist per keypress, as before).

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| drag handle | strip open | a handle element (class `arcade-resize`) on the strip's top edge: `role="separator"`, `aria-orientation="horizontal"`, `tabIndex={0}`; pointer drag adjusts scale per the pinned mapping above |
| keyboard resize | handle focused, ArrowUp/ArrowDown | scale steps by 0.05 (up = bigger strip), clamped to [0.5, 1.0]; each change persisted to `mpai-arcade-size` |
| persistence | after any adjustment | key holds the numeric string; re-mount restores it |
| storage write fails | `localStorage.setItem` throws (private mode / quota) | no crash; resize still applies in-session (state updates), persistence silently skipped — write wrapped in try/catch (constraint 6) |
| live-run integrity | game running during resize | run state, tick, and keyboard capture unaffected (capture handoff App.tsx:289/295/644 untouched); ESC/G/SPACE unchanged |
| theme independence | arcade + clean themes | identical resize behavior and stored value in both |

**Exact values:** class `arcade-resize`; ARIA attributes above; step 0.05; drag mapping
constants: divisor **400px**, anchor at pointerdown, vertical axis, up = bigger.

**Verify:** client suite; exits 0, tsc clean. Test titles `T13-<row-name>` in
`ThinkingStrip.test.tsx` (hooks-shim pattern of
`poc/client/src/components/Transcript.test.tsx`'s `renderTree` helper), including:
- `T13-drag-mapping`: simulated pointerdown/move deltas assert the exact
  `anchorScale + (anchorY − clientY)/400` arithmetic and clamping.
- `T13-live-run`: mount with a running-game fixture, drive a resize (Arrow + simulated drag),
  assert the game/run state object is UNCHANGED (same reference / tick counter advances) and
  the ESC/G/SPACE handler props are still wired.
Plus the live-run row's untouched-capture check, mechanical: `git diff --name-only <commit>` →
exactly `poc/client/src/components/ThinkingStrip.tsx`,
`poc/client/src/components/ThinkingStrip.test.tsx`, `poc/client/src/terminal.css` — App.tsx
(the :289/:295/:644 capture handoff) untouched by construction.
**Commit:** `feat(client): arcade strip drag and keyboard resize — pinned 400px/0.5 mapping`

---

## Task 14 — Cross-theme parity test

**Spec:** §3 (parity check). **Files:** create `poc/client/src/parity.test.tsx`.

**This is NOT the banned trailing write-the-tests task (rubric D2, addressed directly):** the
banned pattern is deferring the tests for earlier tasks' behavior to the end. Here every task
1–13 writes and watches-fail its OWN tests first (constraint 10) — nothing about Tasks 1–13 is
tested later than its implementation. Task 14 introduces a NEW, emergent invariant —
cross-theme control-set equality — that is not any single task's behavior and becomes
definable only once the final control set exists (gate bar, wheel-on-card, resize handle land
in Tasks 8–13). Per-surface incremental parity assertions would be rewritten at every task and
prove strictly less than the whole-surface equality check (council round-1 ruling 1, justify
arm; reaffirmed cycle 2 against the rubric line itself).

**Behavior table:**

| case | input/state | expected |
|---|---|---|
| control-set parity | session surface fixture (pending gate + 2 sub-sessions + arcade open), rendered under `theme="arcade"` and `theme="clean"` | the extracted sets of interactive affordances (button/labeled-control text + handler presence, via the hooks-shim tree walk — `poc/client/src/components/Transcript.test.tsx`'s `renderTree` helper pattern) are IDENTICAL across themes |
| opt-in exception | busy fixture | the ONE permitted divergence: arcade auto-opens the game LANE, clean does not (asserted explicitly as the only difference) — AND the thinking strip's STATUS LINE is asserted present in BOTH themes' busy state (spec §2.2; Task 7's row) |
| picker parity | project screen fixture | same control-set equality on a second representative surface |

**Verify:** client suite; exits 0, tsc clean. Test titles `T14-<row-name>`.
**Commit:** `test(client): cross-theme control-set parity`

---

## Task 15 — Docs: PRD §8.5 / §8.9 / §5.1 update

**Spec:** spec §0–§2 rulings. **Files:** modify `docs/PRD.md`.

**Behavior table:**

| case | expected |
|---|---|
| §5.1 *Today* | stale 1296px-pin paragraph corrected: full-bleed shipped (no pin since before this cycle; marquee/legend folded this cycle) |
| §8.9 *Today* | rewritten: two themes shipped (Arcade default, Clean override layer, `data-theme` + `mpai-theme` runtime switch), full-bleed done, arcade strip resizable (`mpai-arcade-size`), games opt-in in Clean |
| §8.9 *Open* | density question REMOVED as open; replaced with the ruling: same density, quieter skin (spec R2, 2026-07-31) |
| §8.5 *Today*/*Final* | updated: gate bar, wheel-on-card, pull click-through shipped; section's "surfacing" remainder closed, citing `docs/specs/2026-07-31-presentation-design.md` |
| §5.2 alignment | the "standard type, calmer density" line aligned to ruling R2 (same density, quieter skin) — the content is already decided by R2; this only propagates the ruling to the one section still contradicting it |
| no other sections | diff touches only the §5.1, §5.2, §8.5, §8.9 blocks |

**Verify (content checks, expected results stated):**
1. `command grep -n "same density" docs/PRD.md` → hits in §8.9.
2. `command grep -n "2026-07-31-presentation-design" docs/PRD.md` → hits in §8.5.
3. `command grep -n "mpai-theme\|mpai-arcade-size" docs/PRD.md` → hits in §8.9's rewritten
   *Today* (both keys present).
4. `command grep -n "1296" docs/PRD.md` → **no hits** (the stale pin text is REMOVED, not
   qualified).
5. `command grep -n "calmer density" docs/PRD.md` → **no hits** (§5.2's line now reads per
   R2: same density, quieter skin).
6. `git diff docs/PRD.md` hunks fall only in the four named blocks; `git diff --name-only`
   for the commit lists `docs/PRD.md` only. No suite impact.
**Commit:** `docs(prd): presentation cycle shipped — §5.1/§8.5/§8.9, density fork closed`
