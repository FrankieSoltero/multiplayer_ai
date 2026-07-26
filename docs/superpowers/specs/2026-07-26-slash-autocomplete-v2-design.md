# Slash-Autocomplete v2 — Design

**Date:** 2026-07-26 · **Branch:** `feature/slash-autocomplete-v2` (off main post-v6c, PR #8)
**Status:** user-approved in brainstorm (visible-count, matching, keys, close-rule, junk filter, approach, branch all locked 2026-07-26)

## 1. Goal

Make the slashmenu usable against the post-v6c roster (~71 live entries, namespaced plugin
skills like `soltero-skills:agent-handoff`). Today it is prefix-match, click-only, unbounded
height: typing `/handoff` finds nothing, and `/` alone renders a wall. v2 adds keyboard-driven
selection over a 3-row scrollable window with substring matching, plus a minimal junk filter
for the dead entries the live SDK roster is known to contain (v6c plan §Deviations).

## 2. Requirements (locked)

- **3 rows visible** at a time; the rest reachable by scrolling (keyboard or mouse wheel).
- **Live narrowing** as the user types the name token.
- **Substring matching**, prefix matches ranked first.
- **↑/↓** move a highlight, wrapping at the ends; the 3-row window follows the highlight.
- **Enter or Tab** accept the highlighted entry → input becomes `/<name> ` (trailing space),
  menu closes, focus stays in the input; Enter again submits as today.
- **Esc** closes the menu without selecting; Enter then submits the raw text (escape hatch).
  Any subsequent change to the input re-triggers the menu.
- **Menu exists only on the name token** — regex stays `^\/(\S*)$`. First space closes it;
  backspacing past the space brings it back (same match logic re-triggers). `/` alone shows
  the full filtered list.
- **Minimal junk filter:** drop only entries whose description marks them as removed
  (description begins with `(removed`). Built-ins stay — the v6c `skills:"all"` reversal is
  deliberate. The SDK `SlashCommand` type has no skill-vs-command discriminator, so this is
  a knowingly narrow heuristic; anything broader was rejected as hand-maintained guesswork.
- Click-to-select keeps working; RUN/SUGGEST tag and description rendering unchanged.

## 3. Architecture — pure module + thin wiring (Approach A, approved)

No component-test infra exists; the repo's pattern is pure-function extraction
(`modes.ts`, `pluginLine.ts`, `skillSuite.ts`). Same here.

### 3a. `poc/client/src/slashMatch.ts` (new, pure)

- `matchSkills(token: string, skills: Skill[]): Skill[]` — case-insensitive substring match
  on `name`; stable sort: prefix matches first (original roster order within each group).
  Empty token returns the full list.
- `moveHighlight(current: number, delta: 1 | -1, length: number): number` — wrap-around
  step; returns 0 when `length` is 0.

### 3b. Junk filter at the derive layer

`derive.ts:74` (`s.skills = ev.skills ?? []`) becomes the single filter point:
`s.skills = (ev.skills ?? []).filter(notRemoved)` with `notRemoved` exported from
`slashMatch.ts` (`!description.trimStart().startsWith("(removed")`). One spot cleans every
consumer — SkillsPanel roster, AgentStatus roster count, PromptBar menu — and the wire
stays untouched (append-only events unchanged; filtering is client derivation, per the
standing architecture decision). Note: the SKILL SUITE path (`skillSuite.ts`) consumes the
raw per-session roster data directly (not the derived `DerivedState.skills`), so it applies
`notRemoved` itself in `suiteFromSessions`.

### 3c. `PromptBar.tsx` wiring

- New state: `highlightIndex` (number). One rule: reset to 0 whenever the match list
  changes (compare joined names). New state: `dismissed` (boolean) — set by Esc, cleared
  on any text change.
- `onKeyDown` gains: ArrowUp/ArrowDown (menu open → `moveHighlight`, `preventDefault` to
  stop caret jumps), Tab (menu open → accept, `preventDefault`), Enter (menu open → accept;
  else submit as today), Escape (menu open → set `dismissed`).
- Accepting = existing click behavior (`setText(`/${name} `)`, refocus) + close via the
  name-token regex no longer matching a bare token (text now has a trailing space).
- Menu renders when `matches.length > 0 && !dismissed`.

### 3d. ARIA (accessibility floor — standing decision)

Input: `role="combobox"`, `aria-expanded`, `aria-controls="slashmenu-list"`,
`aria-activedescendant` pointing at the highlighted option id. Menu: `role="listbox"`,
options `role="option"` + `aria-selected`, stable ids (`slashopt-<name>`).

### 3e. CSS (`terminal.css`, .slashmenu block ~:566)

- `max-height: calc 3 rows` + `overflow-y: auto` on `.slashmenu` (measure a row = padding
  `var(--sp-2)` ×2 + line-height; use a fixed px value with a comment tying it to 3 rows).
- `.slashmenu button.sel` — highlight style, same family as `:hover` but distinct/stronger
  (accent-tinted background + visible left indicator in the pixel idiom).
- Highlight follows keyboard via `scrollIntoView({ block: "nearest" })` on the selected
  button (effect in PromptBar keyed on `highlightIndex`).

## 4. Error handling / edge cases

- List changes for any reason (typing, roster arriving mid-typing via live `plugin_change`)
  → highlight resets to 0; list empties → menu unmounts, state irrelevant.
- Enter with menu open but zero matches → normal submit path (menu isn't rendered).
- Non-driver flow unchanged: accepting fills text; submit still routes to `onSuggestSkill`.

## 5. Testing

- `slashMatch.test.ts` (pure): substring hit incl. namespaced names (`handoff` →
  `soltero-skills:agent-handoff`), case-insensitivity, prefix-first ordering stability,
  empty-token = full list, `notRemoved` keeps normal entries / drops `(removed)…` ones,
  `moveHighlight` wrap both directions incl. length 1.
- `derive.test.ts`: roster event with a `(removed)` entry → filtered out of `skills`.
- No component tests (no infra — recorded pattern). Manual verify: demo stack per HANDOFF §6;
  type `/handoff`, arrows, Tab-accept, Esc+Enter raw submit, wheel-scroll the 3-row window.
- Baselines going in: server 123 / client 45 (client count will grow).

## 6. Out of scope (YAGNI)

Fuzzy/typo matching, description-text search, args placeholders/hints in the menu, hot
roster reordering by usage, any junk filtering beyond the `(removed` heuristic, server-side
roster changes.
