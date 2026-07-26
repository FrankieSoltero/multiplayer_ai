# Slash-Autocomplete v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keyboard-driven slash autocomplete — 3-row scrollable menu, substring matching (prefix-first), ↑/↓ + Enter/Tab/Esc, and a minimal `(removed` junk filter on the derived roster.

**Architecture:** One new pure module `poc/client/src/slashMatch.ts` (matching, ranking, junk filter, highlight stepping — all unit-tested), consumed by `derive.ts` (filter at the single roster fold point) and `PromptBar.tsx` (thin keyboard/ARIA wiring). CSS-only window sizing. No wire/protocol/server changes.

**Tech Stack:** React 18 + TypeScript, Vitest, plain CSS (`terminal.css`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-slash-autocomplete-v2-design.md`. Deviations get recorded in this plan's Deviations section at the end.
- Branch: `feature/slash-autocomplete-v2` (already created, off main post-PR-#8). Never merge without the user.
- **DO NOT touch `poc/server/` or switch branches** — a demo stack may be running (`lsof -ti :3001`); tsx watch hot-reload kills live turns. Editing `poc/client/` only triggers vite HMR, which is safe.
- Client-only change. The wire stays append-only and untouched; filtering is client derivation (standing architecture decision).
- No component-test infra exists and none is added — pure-function extraction is the repo's testing pattern.
- Client baseline going in: **45 tests passing**, `npm run build` clean. All commands run from `poc/client/`.
- Accessibility floor: the menu ships with combobox/listbox ARIA (Task 3), not as a follow-up.

---

### Task 1: `slashMatch.ts` — pure matching/ranking/filter/highlight module

**Files:**
- Create: `poc/client/src/slashMatch.ts`
- Test: `poc/client/src/slashMatch.test.ts`

**Interfaces:**
- Consumes: nothing (pure, zero imports).
- Produces (Tasks 2 and 3 rely on these exact names/signatures):
  - `export interface Skill { name: string; description: string }`
  - `export function matchSkills(token: string, skills: Skill[]): Skill[]`
  - `export function moveHighlight(current: number, delta: 1 | -1, length: number): number`
  - `export function notRemoved(s: Skill): boolean`

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/slashMatch.test.ts` (style matches `modes.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { matchSkills, moveHighlight, notRemoved } from "./slashMatch";

const sk = (name: string, description = "") => ({ name, description });

describe("matchSkills", () => {
  const roster = [
    sk("review", "review a PR"),
    sk("code-review:code-review", "plugin review"),
    sk("soltero-skills:agent-handoff", "resume packet"),
    sk("init", "init CLAUDE.md"),
  ];

  it("substring-matches namespaced names — /handoff finds the soltero skill", () => {
    expect(matchSkills("handoff", roster)).toEqual([sk("soltero-skills:agent-handoff", "resume packet")]);
  });

  it("is case-insensitive both ways", () => {
    expect(matchSkills("HANDoff", roster)).toHaveLength(1);
    expect(matchSkills("agent", [sk("Soltero:AGENT-x")])).toHaveLength(1);
  });

  it("ranks prefix matches before substring matches, keeping roster order within each group", () => {
    expect(matchSkills("review", roster).map((s) => s.name)).toEqual([
      "review",              // prefix
      "code-review:code-review", // substring, original order preserved
    ]);
  });

  it("returns the full list for an empty token", () => {
    expect(matchSkills("", roster)).toEqual(roster);
  });

  it("returns [] when nothing matches", () => {
    expect(matchSkills("zzz", roster)).toEqual([]);
  });
});

describe("moveHighlight", () => {
  it("steps down and wraps past the end", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
  });

  it("steps up and wraps past the start", () => {
    expect(moveHighlight(1, -1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });

  it("returns 0 for empty and single-item lists", () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
    expect(moveHighlight(0, -1, 0)).toBe(0);
    expect(moveHighlight(0, 1, 1)).toBe(0);
  });
});

describe("notRemoved", () => {
  it("keeps normal entries, including empty descriptions", () => {
    expect(notRemoved(sk("review", "review a PR"))).toBe(true);
    expect(notRemoved(sk("bare"))).toBe(true);
  });

  it("drops entries whose description marks them removed, even with leading whitespace", () => {
    expect(notRemoved(sk("agents", "(removed)…"))).toBe(false);
    expect(notRemoved(sk("agents", "  (removed in v2)"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/client && npx vitest run src/slashMatch.test.ts`
Expected: FAIL — cannot resolve `./slashMatch`.

- [ ] **Step 3: Write minimal implementation**

Create `poc/client/src/slashMatch.ts`:

```ts
// Pure helpers for the prompt bar's slash autocomplete (spec:
// docs/superpowers/specs/2026-07-26-slash-autocomplete-v2-design.md).

export interface Skill {
  name: string;
  description: string;
}

/** Case-insensitive substring match on the name; prefix matches rank first,
 *  original roster order preserved within each group. Empty token = full list. */
export function matchSkills(token: string, skills: Skill[]): Skill[] {
  const t = token.toLowerCase();
  if (!t) return skills.slice();
  const prefix: Skill[] = [];
  const rest: Skill[] = [];
  for (const s of skills) {
    const n = s.name.toLowerCase();
    if (n.startsWith(t)) prefix.push(s);
    else if (n.includes(t)) rest.push(s);
  }
  return [...prefix, ...rest];
}

/** Wrap-around highlight step; 0 when the list is empty. */
export function moveHighlight(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

/** Minimal junk filter: the live SDK roster is known to contain dead entries
 *  whose description starts with "(removed" (v6c plan §Deviations). The SDK's
 *  SlashCommand type has no skill-vs-command discriminator, so this stays a
 *  deliberately narrow heuristic. */
export function notRemoved(s: Skill): boolean {
  return !s.description.trimStart().startsWith("(removed");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd poc/client && npx vitest run src/slashMatch.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/slashMatch.ts poc/client/src/slashMatch.test.ts
git commit -m "feat(client): slashMatch — substring matching, highlight stepping, junk filter"
```

---

### Task 2: junk-filter the roster at the derive layer

**Files:**
- Modify: `poc/client/src/derive.ts:73-75` (the `skill_roster` case)
- Test: `poc/client/src/derive.test.ts` (add one `it` to the existing `"harness state"` describe, near line 96)

**Interfaces:**
- Consumes: `notRemoved` from Task 1 (`import { notRemoved } from "./slashMatch"`).
- Produces: `DerivedState.skills` is now always junk-filtered — every consumer (SkillsPanel roster, AgentStatus roster count, PromptBar menu) sees the clean list. No signature changes.

- [ ] **Step 1: Write the failing test**

In `poc/client/src/derive.test.ts`, inside the existing `describe("harness state", ...)` block, add (uses the file's existing `ev` helper):

```ts
  it("filters (removed) junk entries out of the skill roster", () => {
    const s = deriveState([
      ev({ type: "skill_roster", skills: [
        { name: "review", description: "review a PR" },
        { name: "agents", description: "(removed)…" },
      ] }, 0),
    ]);
    expect(s.skills).toEqual([{ name: "review", description: "review a PR" }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/client && npx vitest run src/derive.test.ts`
Expected: FAIL — the new test receives both entries.

- [ ] **Step 3: Write minimal implementation**

In `poc/client/src/derive.ts`: add to the imports at the top

```ts
import { notRemoved } from "./slashMatch";
```

and change the `skill_roster` case (line 73-75) from

```ts
      case "skill_roster":
        s.skills = ev.skills ?? [];
        break;
```

to

```ts
      case "skill_roster":
        s.skills = (ev.skills ?? []).filter(notRemoved);
        break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd poc/client && npx vitest run src/derive.test.ts`
Expected: PASS — all derive tests, including the new one.

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/derive.ts poc/client/src/derive.test.ts
git commit -m "feat(client): filter (removed) junk entries at the roster derive point"
```

---

### Task 3: PromptBar keyboard wiring + 3-row scrollable menu + ARIA

**Files:**
- Modify: `poc/client/src/components/PromptBar.tsx` (whole component — current file is 86 lines)
- Modify: `poc/client/src/terminal.css:566-578` (the `.slashmenu` block)

**Interfaces:**
- Consumes: `matchSkills`, `moveHighlight` from Task 1 (`import { matchSkills, moveHighlight } from "../slashMatch"` — note the `../`, PromptBar lives in `components/`).
- Produces: no new exports; `PromptBar` props are UNCHANGED (callers in `App.tsx` untouched).

No unit test — component behavior with no component-test infra (recorded pattern; the logic under the keys is Task 1's tested module). Verification = `tsc` via build + the manual demo checklist in Task 4.

- [ ] **Step 1: Rewrite `PromptBar.tsx`**

Replace the component body with the following. Everything outside the input/menu (take-the-wheel button, statusline, submit routing) is byte-identical to today; the diff is state, keydown, and the menu markup.

```tsx
import { useEffect, useRef, useState } from "react";
import { matchSkills, moveHighlight } from "../slashMatch";

export function PromptBar(props: {
  isDriver: boolean; agentBusy: boolean; watcherNames: string[];
  skills: { name: string; description: string }[];
  gatesPending: number;
  onPrompt: (text: string) => void; onTakeWheel: () => void;
  onSuggestSkill: (skill: string, args: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false); // Esc closes until the text changes
  const listRef = useRef<HTMLDivElement | null>(null);

  const slash = text.match(/^\/(\S*)$/); // "/par" while still typing the name
  const matches = slash ? matchSkills(slash[1], props.skills) : [];
  const menuOpen = matches.length > 0 && !dismissed;

  // one rule: any change to the match list resets the highlight to the top
  const matchKey = matches.map((m) => m.name).join("\n");
  useEffect(() => { setHighlight(0); }, [matchKey]);

  // the 3-row window follows the keyboard highlight
  useEffect(() => {
    listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [highlight, matchKey]);

  const accept = (name: string) => {
    setText(`/${name} `); // trailing space ends the name token → menu closes itself
    setHint(null);
    props.inputRef.current?.focus();
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    const cmd = t.match(/^\/(\S+)\s*(.*)$/);
    if (cmd) {
      props.onSuggestSkill(cmd[1], cmd[2]);
      setText("");
      setHint(null);
      return;
    }
    if (!props.isDriver) {
      setHint("watching — suggest a skill with /name, or take the wheel to prompt");
      return;
    }
    props.onPrompt(t);
    setText("");
    setHint(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (menuOpen) {
      // clamp: the reset-to-0 effect runs post-render, so guard a stale index
      const sel = matches[Math.min(highlight, matches.length - 1)];
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => moveHighlight(h, 1, matches.length)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => moveHighlight(h, -1, matches.length)); return; }
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); accept(sel.name); return; } // Shift+Tab stays reverse focus traversal (accessibility floor, v6a ruling)
      if (e.key === "Enter") { accept(sel.name); return; }
      if (e.key === "Escape") { setDismissed(true); return; }
    }
    if (e.key === "Enter") submit();
  };

  const selName = matches[Math.min(highlight, matches.length - 1)]?.name;

  return (
    <div className="promptbar">
      <div className="inputbox">
        <span className="caret">▸</span>
        <input
          ref={props.inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setHint(null); setDismissed(false); }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls="slashmenu-list"
          aria-autocomplete="list"
          aria-activedescendant={menuOpen && selName ? `slashopt-${selName}` : undefined}
          placeholder={
            props.isDriver
              ? "you're driving — prompt the agent, or /skill…"
              : "watching — suggest a skill with /name args…"
          }
          maxLength={4000}
        />
        <span className="keys">⏎ send</span>
        {menuOpen && (
          <div className="slashmenu" id="slashmenu-list" role="listbox" ref={listRef}>
            {matches.map((s, i) => (
              <button
                key={s.name}
                id={`slashopt-${s.name}`}
                role="option"
                aria-selected={i === highlight}
                className={i === highlight ? "sel" : undefined}
                onClick={() => accept(s.name)}
              >
                <span className="tag">{props.isDriver ? "RUN" : "SUGGEST"}</span>
                <b>/{s.name}</b>{s.description && <span className="dim"> — {s.description}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {!props.isDriver && (
        <button className="btn gold dashed wide" onClick={props.onTakeWheel}>
          🛞 TAKE THE WHEEL
        </button>
      )}
      <div className="statusline">
        <span className={props.isDriver ? "driving" : ""}>
          {props.isDriver ? "🛞 you are driving" : "watching"}
        </span>
        {props.agentBusy && <span>✦ agent working…</span>}
        {hint && <span className="red">{hint}</span>}
        {props.watcherNames.length > 0 && (
          <span>{props.watcherNames.join(", ")} watching</span>
        )}
        {props.gatesPending > 0 && (
          <span className="gate">🔐 {props.gatesPending} gate{props.gatesPending > 1 ? "s" : ""} pending</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS — 3-row window + highlight style**

In `poc/client/src/terminal.css`, extend the `.slashmenu` block (currently :566-578). Add to the `.slashmenu` rule:

```css
  max-height: 108px; /* 3 rows: 20px --line + 8px --sp-2 padding ×2 each */
  overflow-y: auto;
```

and add after the `:hover` rule:

```css
.slashmenu button.sel {
  background: rgba(217, 119, 87, 0.22);
  box-shadow: inset 3px 0 0 var(--accent);
}
```

- [ ] **Step 3: Verify types and build**

Run: `cd poc/client && npm run build`
Expected: clean (tsc + vite). Also run `npm test` — expected: all pass (no count change from this task).

- [ ] **Step 4: Commit**

```bash
git add poc/client/src/components/PromptBar.tsx poc/client/src/terminal.css
git commit -m "feat(client): keyboard-driven slash autocomplete — 3-row window, arrows, Enter/Tab/Esc, ARIA combobox"
```

---

### Task 4: final verification sweep

**Files:** none created; read-only against the spec + full runs.

- [ ] **Step 1: Full client suite + build**

Run: `cd poc/client && npm test && npm run build`
Expected: **56 tests passing** (45 baseline + 10 slashMatch + 1 derive), build clean. If the count differs, find out why and record the arithmetic in Deviations.

- [ ] **Step 2: Spec re-read**

Re-read `docs/superpowers/specs/2026-07-26-slash-autocomplete-v2-design.md` §2-§4 against `git diff main --stat` and the shipped code. Every locked requirement (3 rows, substring+prefix-first, ↑/↓ wrap, Enter/Tab accept, Esc dismiss + re-trigger on change, close-at-space/reopen-on-backspace, junk filter at derive, ARIA, click preserved, RUN/SUGGEST unchanged) maps to code or gets a recorded deviation below.

- [ ] **Step 3: Commit any fixes and stop**

Stop for the user's manual demo checkpoint (checklist: type `/handoff` → soltero skill appears; ↑/↓ wraps and window scrolls; Tab fills `/name ` and second Enter submits; Esc then Enter submits raw; wheel-scroll works; SkillsPanel no longer shows `(removed)` rows). Demo stack env per HANDOFF §6. Do not merge; PR on user go.

---

## Deviations (recorded during execution)

- **Task 3 (PromptBar):** The plan's reference component code carried a clamp inconsistency — the JSX map compared `i === highlight` (raw) while the keydown handler and `aria-activedescendant` used a `Math.min`-clamped index, producing a one-frame ARIA/visual mismatch when the match list narrows (the `setHighlight(0)` reset is a `useEffect`, not guaranteed to flush before paint). Caught by the task review; fixed in `ec75ee2` by computing `effectiveHighlight = Math.min(highlight, matches.length - 1)` once and using it in all three places.
