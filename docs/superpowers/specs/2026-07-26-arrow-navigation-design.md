# Arrow Navigation — Design

*Status: approved 2026-07-26. Branch `feature/arrow-nav`, based on `feature/arcade-tetris-doodle` (stack tip).*

## 1. Problem

Every interactive control in the terminal is reachable only by mouse or by Tab. The shell is styled as a keyboard-first TUI and has single-letter hotkeys for the five screens (S/W/O/I/A/M), but there is no way to move around the interface itself with the arrow keys the way a terminal UI implies.

Goal: make the whole terminal navigable with the arrow keys, without breaking the three things that already own arrows.

## 2. What already owns the arrow keys

Any design has to survive all three. They were verified in the code, not assumed.

1. **The arcade engines.** `snake.ts` (arrows + WASD), `tetris.ts` and `doodle.ts` (arrows) consume arrows for gameplay. The host already publishes a `capturing` flag while a run is live (`ThinkingStrip.tsx:94-99` → `App.tsx` `arcadeCapturing`), which is the existing mechanism for muting global keys.
2. **The slash-command menu.** `PromptBar.tsx:62-63` binds ↑/↓ to `moveHighlight` while the menu is open. The menu only opens when the input starts with `/`, so the input is non-empty whenever it is open.
3. **The prompt input's text caret.** ←/→ move the caret whenever the input has text. This is the one that would be most annoying to break.

Plus one standing constraint: **Shift+Tab must never be captured** (v6a accessibility ruling, `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md:12`). This design binds neither Tab nor Shift+Tab.

## 3. Decisions and rationale (for review)

**3.1 Activation: an empty prompt means NAV; typing always wins.** Arrows drive the focus ring whenever the prompt is empty, and are the text caret the moment it has content. Chosen over an explicit Esc-toggled mode and over a Ctrl+arrow chord.

*Why:* arrows do nothing in an empty text input, so claiming them is free — there is no behavior to take away. It needs no new key, so `Esc` keeps its existing three meanings (close screen, close arcade, dismiss slash menu) unchanged rather than gaining a fourth with a precedence order. And it makes the promise easy to state: **if you are typing, arrows are the caret; if you are not, they move you around.** The Ctrl+arrow option was rejected as a two-hand chord nobody would use.

*Accepted cost:* pressing ↑ in an empty prompt moves focus out of the input rather than recalling the last prompt. If prompt history is wanted later it will need a different key or a rule that ↑ recalls history first and only navigates once history is exhausted. Noted in §7.

**3.2 Real DOM focus, not a JavaScript selection index.** Navigation calls `element.focus()` and lets the browser do the rest.

*Why:* Tab and Shift+Tab keep working with no special handling; `Enter` and `Space` activate a focused `<button>` natively, so no key binding is needed to "activate"; screen readers announce the focused control correctly; and the existing focus ring at `terminal.css:81` (`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` — commented "keyboard-first shell, so focus is always visible") applies with **no new CSS**. A parallel JS selection index would have had to reimplement all four and would have drifted from the real focus.

**3.3 Rows are derived from geometry, not from markup.** Items are grouped into visual rows by comparing their bounding boxes at keypress time.

*Why:* this was originally scoped as `data-nav-group` attributes on containers. Deriving rows from `getBoundingClientRect` instead means **no markup changes anywhere**, it is correct by construction for the header that now wraps onto two rows (see §6), and it cannot fall out of sync with the layout the way hand-maintained attributes do. Same behavior, less to maintain.

**3.4 Every natively focusable element participates by default.** The item set is `button`, `select`, `input`, `a[href]`, and anything with a non-negative `tabindex`, minus a `data-nav-skip` opt-out, minus anything with a zero-size box.

*Why:* it makes "the whole terminal" literally true on day one — all five screens (SKILLS, WORKFLOWS, OVERSIGHT, INVITE, ARCADE), the header, the party pane, the session list, the transcript's permission buttons and the prompt are covered without touching a single component. Any screen added later is covered for free. An allowlist would have required editing thirteen components and would silently miss the fourteenth.

**3.5 Horizontal wraps, vertical clamps.** ←/→ wrap around within a row; ↑/↓ stop at the top and bottom rows.

*Why:* wrapping within a row matches `moveHighlight` in the existing slash menu, so the two behave alike. Vertical wrapping from the prompt back up to the header is disorienting in a tall layout, so ↑/↓ clamp instead.

## 4. Behavior

| Key | Effect |
|---|---|
| `←` / `→` | previous / next focusable in the same visual row, wrapping |
| `↑` / `↓` | nearest focusable in the row above / below, matched by horizontal centre; clamps at the ends |
| `Enter` / `Space` | activates the focused control — native browser behavior, not bound by this feature |
| `Tab` / `Shift+Tab` | unchanged |

Rows are computed by vertical overlap: two items share a row when their vertical spans overlap by more than half the shorter item's height. That puts the header's two wrapped lines in separate rows, and puts the transcript and the party pane — which sit side by side — in the same row, so ←/→ crosses between them naturally.

When nothing relevant is focused, the first arrow press focuses the first item in document order.

## 5. Guards — when arrows are NOT ours

Checked in this order on every keydown. Any match returns immediately and lets the key through untouched.

1. `metaKey`, `ctrlKey` or `altKey` held → let the browser and OS have it.
2. The key is not one of the four arrows → ignore.
3. **A live arcade run has the keyboard** (`arcadeCapturing`) → the game owns arrows. Passed into the hook as its `enabled` flag, so the listener is not even attached during a run.
4. Focus is in a `TEXTAREA` or `SELECT` → native arrow behavior wins. This deliberately leaves the AGENT model `<select>` behaving normally.
5. Focus is in an `INPUT` **whose value is non-empty** → the text caret wins. This is what makes typing always win, and it also covers the slash menu, which can only be open when the input begins with `/`.

## 6. Relationship to the header clipping fix

The commit immediately before this one fixed `.term-header`, which was a `nowrap` flex row with `overflow: hidden`: because `white-space: nowrap` stops the buttons shrinking below their labels, the row ran past the frame and the tail was silently clipped — INVITE and ONLINE entirely, OVERSIGHT nearly so. It now wraps onto two lines.

That matters here for two reasons. Clipped controls were **unreachable**, so a focus ring over them would have focused invisible elements. And because rows are derived from geometry (§3.3), the now-wrapped header is treated as two rows automatically, with no attribute to update.

## 7. Out of scope for v1

- Prompt history on ↑ (see §3.1 — it needs its own decision about precedence).
- Type-to-focus, i.e. pressing a printable key while a control is focused jumping back to the prompt. Rejected for v1 because the single-letter screen hotkeys (S/W/O/I/A/M/G) would collide with it.
- Any change to the letter hotkeys, `Esc`, `Tab`, or `Shift+Tab`.
- Scrolling the transcript with arrows (transcript lines are not focusable; only its permission buttons are).
- A visible "NAV mode" indicator — there is no mode to indicate.

## 8. Testing

The geometry and index arithmetic is extracted into pure functions and unit tested, matching the house pattern (there is no component-test infrastructure; `poc/client/src/game/*.test.ts`, `slashMatch.test.ts` and `oversightView.test.ts` all follow it):

- `rows()` — groups rects into visual rows; overlapping items share a row, stacked items do not; a wrapped header yields two rows; side-by-side panes yield one.
- `moveH()` — steps within a row and wraps at both ends.
- `moveV()` — moves to the adjacent row, picks the nearest item by horizontal centre, and clamps at the top and bottom.
- `isTypingTarget()` — the §5 guard: true for a non-empty input, a textarea and a select; false for an empty input and for a button.

The hook itself is a thin DOM binding over these and is verified by driving the real UI, which is also required because `ThinkingStrip` and the header have no component tests.
