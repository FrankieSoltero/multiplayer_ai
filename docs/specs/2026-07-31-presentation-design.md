# Presentation cycle — §8.5 surfacing + §8.9 themes & full-bleed (design)

**Status:** APPROVED (user, 2026-07-31). **Sections:** PRD §8.5 (control-transfer
surfacing) + §8.9 (presentation & the arcade), governed by PRD §5.1 (layout) and §5.2 (two
presentations). **Branch:** one branch, `feature/presentation` — all work is client-side and
inter-dependent (the Clean skin styles the same classes the §8.5/PR-#32 riders touch); splitting
would serialize writers on `terminal.css`.

## 0. Rulings (user, 2026-07-31)

- **R1 — section pick:** §8.5 + §8.9 as one presentation cycle.
- **R2 — Clean density:** SAME density as Arcade — a quieter skin, not a tighter layout. (PRD
  §8.9's open question closed. Consequence: no geometry/density tokenization is needed this
  cycle; Clean is decoration-layer overrides only. Density remains revisitable later as its own
  decision.)
- **R3 — §8.5 surfacing:** agent-proposed (this spec §2.4), user approves via this design.
- **R4 — games footprint (user, 2026-07-31):** the games must take up less space by default,
  and the split between the terminal (transcript) area and the arcade strip must be
  user-adjustable at runtime. Design in §2.7.

Pre-decided by PRD §5.2 (not re-opened): theme is a per-user, runtime-switchable, persisted
preference; Arcade is default; absolute functional parity; both themes dark, no light mode; AA
contrast floor and reduced-motion honored in both; games exist in both, opt-in in Clean.

## 1. Context (verified 2026-07-31, main @ 20c40fd)

- `terminal.css` (810 lines): palette/type/space/CRT fully tokenized in `:root` (18-65) with
  inline AA ratios; shape is NOT tokenized — 2px frames are literals (`.panel`:101, `.btn`:118),
  `--chunk`/`--chunk-sm` shadows ARE vars (:27-28, used at 105/120/514/601/661); `.seg` geometry
  hardcoded (160-177). **No theme mechanism exists** — no `data-theme`, no `.clean`, no body
  class.
- **Full-bleed is partly done already** — PRD §5.1's "Today" (1296px `.cabinet-inner` pin) is
  STALE: `.cabinet-inner` is `width:100%` (:195-199), `.crt` already drops side borders/radius
  for full-bleed (:213-229). What remains: marquee + legend still stack OUTSIDE the glass —
  `Cabinet` (Crt.tsx:39-66) renders `.crt-chrome-top`/`.marquee` above (44-52) and the legend
  `.lobby-foot` below (56-62); App mounts `<Cabinet legend={LEGEND}><Crt>` (App.tsx:172-174)
  with stale legend strings (App.tsx:39).
- `Crt` has the theming precedent: `intensity: "off" | "subtle" | "full"` flips `--crt-op`,
  `--crt-flick`, `--crt-curve` (Crt.tsx:17-23); `off` also hides `.crt-fx` (css :247-248).
- Preference persistence precedent: localStorage `mpai-pull-after-ms` (pulls.ts:12,
  App.tsx:212/245-249) and `mpai-<game>-high` (ThinkingStrip.tsx:9). No settings UI exists.
- §8.5 surfaces today: TAKE THE WHEEL button + driving/watching statusline (PromptBar.tsx:128-136),
  `.wheelbanner` on `control_change` (Transcript.tsx:121-131), `.perm` gate cards with driver
  `[A]/[D]` actions or non-driver "⏳ driver deciding…" (Transcript.tsx:146-207), a/d hotkeys
  (Transcript.tsx:61-77), "🔐 N gates pending" statusline (PromptBar.tsx:143-144), header
  "🔐 PULLS ▸ N" badge (Header.tsx:162-166) + per-session pull rows (PartyPane.tsx:135-146).
  Pulls are in-app only (no Web Notifications API anywhere).
- PR #32 riders: `.subagent-row`, `.subsession-rail`, `.subsession-chip`, `.subsession-header`,
  `.perm-sub`, `.badge` have ZERO css rules; `.lamp` exists only scoped under the old
  `.subagent` block (css 634-652), so the new markup renders near-unstyled. Compact row is a
  bare `<div onClick>` (Transcript.tsx:334-345) — keyboard-inaccessible.

## 2. Design

### 2.1 Theme mechanism (§8.9)

- **Hook:** `data-theme="arcade" | "clean"` on `document.documentElement`. Arcade renders with
  today's rules untouched (no `[data-theme="arcade"]` selectors needed — arcade IS the base).
  Clean is an override layer: `:root[data-theme="clean"] { …token overrides… }` plus a small
  set of `[data-theme="clean"] .<class>` rules, appended to `terminal.css` as a clearly-fenced
  section.
- **State:** a `useTheme()` hook in App — reads localStorage **`mpai-theme`** (absent/invalid ⇒
  `arcade`), sets the attribute, exposes `(theme, setTheme)`. Per-user, client-local, never in
  the protocol (two participants in one session can differ — PRD §5.2).
- **Switch:** a `THEME ▸ ARCADE|CLEAN` toggle button in the Header, `planmode`-button style,
  placed beside ARCADE (Header.tsx:112-123 area). Present and functional in both themes
  (parity). No keyboard hotkey (header buttons have none today).
- **CRT coupling:** App passes `intensity={theme === "clean" ? "off" : "full"}` to `<Crt>`
  (App.tsx:173) — Clean gets no scanlines/vignette/flicker/curvature via the existing
  mechanism; the `.crt-fx` layers stay mounted-but-hidden exactly as `off` already behaves.

### 2.2 The Clean skin (§8.9)

Decoration-only overrides (R2: geometry, spacing, densities, and layout untouched):

- **Type:** `--pf` (pixel face) overridden to the mono stack — pixel type disappears wholesale;
  since `terminal.css`'s own rule makes `--pf` chrome-only ("never carries information that
  isn't also in the mono layer", :11-16), nothing is lost. `--track-label` loosened to 0.
- **Shape quieting via existing vars:** `--chunk: none`, `--chunk-sm: none` (kills hard offset
  shadows everywhere they're consumed). Frames stay 2px (literal, unchanged — same density) but
  `--frame` recolors to a quieter value; `.btn:active`'s literal `1px 1px 0` (css:124) and
  `.perm:has(.perm-actions)`'s `5px 5px 0` (css:357) get `[data-theme="clean"]` overrides to
  `none` — the two hardcoded shadow sites the var sweep can't reach.
- **Palette:** same dark family, muted — `--bg`/`--panel`/`--input` kept, `--accent`, `--gold`,
  `--amber`, `--green`, `--red` re-pointed at desaturated equivalents chosen to hold the AA
  floor, with the same inline documented-ratio convention the base palette uses (css:26-41).
  Semantic meanings (gold=contested-calm, amber=pending, etc.) unchanged.
- **Chrome:** marquee/cabinet chrome and animated flourishes suppressed in Clean — the
  `sweepbg` wheelbanner marquee animation (css:331-341) renders as a static banner; `.pix`
  labels render in mono. Reduced-motion blocks (css:583-590, 707-709) remain the motion
  authority for both themes.
- **Games in Clean (PRD §5.2):** functionality parity, opt-in presentation — the ARCADE button
  and hotkey still open ThinkingStrip, but Clean does NOT auto-mount the arcade while the agent
  is busy (App's `busy` auto-open path becomes arcade-theme-only); Clean's busy state shows the
  thinking strip's status line without the game lane. ESC/G/SPACE behavior unchanged when open.

### 2.3 Full-bleed completion (§5.1 remainder)

The glass becomes the page; marquee and legend fold INTO the CRT as chrome:

- `Cabinet` is retired from the mount path: App renders `<Crt>` directly full-page
  (App.tsx:172-174). The marquee's identity line collapses into the existing `.term-header`
  breadcrumb (which already leads with `multiplayer_ai`, Header.tsx:63-66) — no duplicate
  full-width band. `props.right` content (if any live use) relocates into the header.
- The legend row is retired; its two strings (App.tsx:39) are stale design-era notes, dropped
  outright (not relocated).
- `Cabinet` itself and `.crt-chrome-top`/`.marquee*`/`.lobby-foot` rules stay in the codebase
  only if some other surface still uses them; if nothing does after the App change, component
  and rules are deleted (dead code).
- PRD §5.1's stale "Today" paragraph (1296px pin) is corrected in this cycle's PRD task.

### 2.4 §8.5 surfacing (R3 — proposed here, approved with this design)

Three concrete improvements, no new mechanism, protocol untouched:

1. **Pinned pending gate.** Today an undecided gate can scroll out of view; the only persistent
   signals are a statusline count and a HUD number. New: when ≥1 undecided `permission_request`
   exists, a slim **gate bar** renders directly above the PromptBar (both themes): `🔐 <tool> —
   <sub-session ⚒ label if attributed> · [A]PPROVE [D]ENY` for the driver (same handlers/
   hotkeys as the card), or `🔐 waiting on <driver glyph+name> · 🛞 TAKE THE WHEEL` for
   non-drivers. Newest-undecided-first (matching the existing a/d hotkey target,
   Transcript.tsx:61-77). Clicking the bar scrolls the transcript to the gate card.
2. **Take-the-wheel-to-decide on the card.** The non-driver gate card's `.perm-outcome`
   ("⏳ driver deciding…", Transcript.tsx:190-206 area) gains a `🛞 TAKE THE WHEEL` button —
   the §8.5 primitive (join → take wheel → answer the gate) becomes one click from the place
   you're looking instead of a trip to the PromptBar. Sends the existing `take_wheel`; the user
   still decides on the card once driver (no auto-decide).
3. **Pull badge click-through.** The header `🔐 PULLS ▸ N` badge (Header.tsx:162-166) becomes a
   button: clicking navigates to the oldest-waiting pulling session (same `?session=` switch
   the session picker uses). Today the badge is inert and the user must find the party row.

### 2.5 PR #32 riders (styling + a11y)

- `.lamp` promoted to a standalone rule (extracted from `.subagent .lamp`, css:646-651; old
  scoped rule kept as-is for the legacy block until it's removed).
- The six unstyled classes get Arcade rules in the existing vocabulary — `.subagent-row` (panel
  row, lamp, pointer affordance), `.subsession-rail` (slim chip strip under the header),
  `.subsession-chip` (+`active`/`gated`/`done` states: accent border / amber `!` badge / dimmed),
  `.subsession-header` (one-line bar, `■ STOP` right-aligned), `.perm-sub` (dim ⚒ prefix),
  `.badge` — and inherit Clean automatically via the token overrides.
- a11y: the compact row (Transcript.tsx:334-345) gets `role="button"`, `tabIndex={0}`, and
  Enter/Space key handling; chips are already real `<button>`s.

### 2.6 Games footprint & the adjustable split (R4)

- **Smaller by default.** The arcade strip's game lane (`ThinkingStrip.tsx`, the ASCII
  `<pre class="lane">`) currently renders at the mono base size; its footprint shrinks by
  rendering the lane at a reduced font-size (ASCII art scales cleanly with font-size; the
  game ENGINES are pure and untouched — presentation-layer scaling only). The new default
  visibly favors the transcript.
- **User-adjustable split.** A horizontal **drag handle** on the arcade strip's top edge lets
  each user set how much vertical space the strip takes vs the transcript area. Dragging
  adjusts the lane scale between a min (status-line-plus-thumbnail) and max (today's size)
  clamp. Keyboard accessible: the handle is focusable and arrow-up/down adjusts in steps
  (a11y peer of the drag).
- **Persisted per-user:** localStorage **`mpai-arcade-size`** (same client-local preference
  pattern as `mpai-theme` / `mpai-pull-after-ms`); absent/invalid ⇒ the new smaller default.
  Applies in both themes identically (parity); Clean's opt-in rule (§2.2) is unchanged — this
  governs the strip's size whenever it IS open, in either theme.
- **Scope bound:** this cycle the adjustable split applies to the arcade strip only — the one
  surface that competes with the terminal for space. Other dividers (e.g. party-pane width)
  are explicitly out of scope; the resize affordance is built so it could be reused, but no
  other surface adopts it now.
- **Interaction integrity:** resizing never changes game logic, tick rate, or keyboard
  capture; a live run keeps playing while resized. ESC/G/SPACE and the capture handoff
  (App.tsx:289/295/644) are untouched.

### 2.7 What does NOT change

Hub and server: nothing (this cycle is 100% client). Protocol: nothing. The wheel/gate/pull
mechanisms: nothing — §8.5 work is presentation over existing messages. Density, spacing, layout
grid: nothing (R2). Light mode: explicitly out (PRD §5.2).

## 3. Verification bar

- Every task test-covered per house TDD; theme tests assert `data-theme` scoping, localStorage
  round-trip (absent/invalid ⇒ arcade), and CRT intensity coupling. Resize tests assert the
  clamp bounds, the `mpai-arcade-size` round-trip (absent/invalid ⇒ smaller default), keyboard
  step-adjustment on the handle, and that game state/capture survive a resize.
- **Parity check is mechanical where possible:** a test walks the rendered tree in both themes
  for representative screens and asserts identical control/affordance sets (buttons, inputs,
  handlers) — themes may differ only in class/style presentation. (The repo's no-DOM test env
  applies; the existing hooks-shim render pattern is the vehicle.)
- New Clean palette values ship with documented contrast ratios inline (house convention), each
  ≥ AA against its use.
- Live walk before PR: both themes screenshotted on the session surface (gate pending, sub-
  session rail populated, arcade open/closed) + full-bleed marquee-fold verified visually.

## 4. Open questions

None blocking. (R1–R3 decided; PRD §5.2 pre-decides the rest. The gate-bar and
wheel-on-card proposals in §2.4 are this spec's two genuinely new UI elements — approving this
design approves them.)

## 5. Risks

- **Parity drift** is the named risk of any second theme; mitigated by the mechanical parity
  test (§3) and by Clean being overrides-only (no forked components).
- **Palette re-derivation** risks silently dropping AA; mitigated by the documented-ratio
  convention + review.
- The marquee fold changes the first thing every user sees; it's a one-commit revert if it
  reads wrong (all presentation, no data).
