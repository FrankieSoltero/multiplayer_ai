# `frontend-design` skill pass — notes and comparison

*Date: 2026-07-24 · Branch: `feature/project-hub` · Task 11 of the v4 terminal-multiplayer plan*

This is the skill **test** the spec asked for (spec §Purpose, deliverable 3): run a real
`frontend-design` skill pass over the built v4 UI, and compare what the skill produces against
the two hand-written baselines —
`docs/superpowers/specs/2026-07-24-product-design-terminal-multiplayer.md` (the approved spec)
and `docs/design/claude-design-brief.md` (the hand-written brief). The comparison is the
deliverable; the CSS refinements are the evidence that the comparison was run for real.

**Skill identity.** The spec and the task brief both name the skill
`soltero-skills:frontend-design`. **No such skill is installed.** The skill that exists on this
machine is `frontend-design:frontend-design`, from the `claude-plugins-official` marketplace
(`~/.claude/plugins/cache/claude-plugins-official/frontend-design/`). That is the one invoked
here. It is a single `SKILL.md` with no bundled reference files, scripts, or templates — the
whole skill is ~1,400 words of prose guidance. Worth correcting the spec's name reference.

**What the UI was assessed against.** The client dev server only (`poc/client && npm run dev`);
the agent server's native binary cannot start in this sandbox. To assess the transcript at real
density rather than as an empty shell, a representative event set (user messages, tool call,
tool result, superseded + current objective, take-the-wheel line, an open permission block, a
decided permission block, an agent error, a three-entry party pane, the thinking strip, the
prompt bar) was injected into the live DOM so the real `terminal.css` styled real markup.
Before/after screenshots at 1440×900 are in `.playwright-mcp/` (`session-before.png`,
`session-after2.png`, `lobby-before.png`, `lobby-after.png`).

---

## (a) What the skill prescribed

Faithful summaries of the skill's actual guidance, in its own order. Quoted fragments are
verbatim from `SKILL.md`.

1. **Framing.** Work as "the design lead at a small studio known for giving every client a
   visual identity that could not be mistaken for anyone else's." The client "has already
   rejected proposals that felt templated." Make "deliberate, opinionated choices about
   palette, typography, and layout that are specific to this brief, and take one real aesthetic
   risk you can justify."

2. **Ground it in the subject.** If the brief doesn't pin down the subject, pin it yourself —
   name the subject, its audience, and "the page's single job." "The subject's own world, its
   materials, instruments, artifacts, and vernacular, is where distinctive choices come from."

3. **The hero is a thesis.** Open with "the most characteristic thing in the subject's world."
   Explicitly names "a big number with a small label, supporting stats, and a gradient accent"
   as "the template answer."

4. **Typography carries the personality of the page.** Pair display and body faces
   deliberately, "not the same families you would reach for on any other project," and set "a
   clear type scale with intentional weights, widths, and spacing." The type treatment should
   be "a memorable part of the design, not a neutral delivery vehicle."

5. **Structure is information.** Numbering, eyebrows, dividers and labels "should encode
   something true about the content, not decorate it." Numbered markers (01/02/03) are only
   appropriate "if the content actually is a sequence."

6. **Leverage motion deliberately.** "An orchestrated moment usually lands harder than
   scattered effects." But also: "sometimes less is more, and extra animation contributes to
   the feeling that the design is AI-generated."

7. **Match complexity to the vision.** "Maximalist directions need elaborate execution; minimal
   directions need precision in spacing, type, and detail. Elegance is executing the chosen
   vision well."

8. **Copy is design material.** Name things by what people control, not how the system is
   built. Active voice; a control says exactly what happens ("Save changes," not "Submit"); an
   action keeps the same name through the whole flow. Errors "don't apologize, and they are
   never vague about what happened." An empty screen "is an invitation to act."

9. **Process: brainstorm → explore → plan → critique → build → critique again.** Two passes.
   First produce a compact token system — **Color** (4–6 named hex values), **Type** (faces for
   2+ roles), **Layout** (prose + ASCII wireframes), **Signature** (the one element the page is
   remembered by). Then review that plan against the brief *before* building: "if any part of
   it reads like the generic default you would produce for any similar page … revise that part,
   say what you changed and why."

10. **The AI-default calibration list.** The skill names three looks that AI design currently
    clusters around: (1) warm cream `#F4F1EA` + high-contrast serif + terracotta accent; (2)
    **"a near-black background with a single bright acid-green or vermilion accent"**; (3) "a
    broadsheet-style layout with hairline rules, **zero border-radius**, and dense
    newspaper-like columns." Critically, it then says: **"Where the brief pins down a visual
    direction, follow it exactly — the brief's own words always win, including when it asks for
    one of these looks."**

11. **Restraint and self-critique.** "Spend your boldness in one place." Let the signature be
    the one memorable thing and keep everything around it quiet. "Build to a quality floor
    without announcing it: **responsive down to mobile, visible keyboard focus, reduced motion
    respected**." Critique as you build, taking screenshots. Chanel's rule: "before leaving the
    house, take a look in the mirror and remove one accessory."

---

## (b) Where the skill agreed and disagreed with the spec + brief

### Agreed — and sharpened

| Skill guidance | Spec / brief position | Outcome |
|---|---|---|
| "Minimal directions need precision in spacing, type, and detail" | Brief §7.1 asks for exact px values for the type scale and spacing rhythm | **Agreement, and the skill is the more demanding of the two.** The brief asked for exact values; the built CSS had *arbitrary* exact values (font sizes 13/12/11px, paddings 3/4/6/8/10/12/14/20/24px, gaps 2/4/6/8/10/14px). The skill's "precision" test is what exposed that as raggedness rather than a system. |
| "Spend your boldness in one place"; one signature element, everything else quiet | Brief §7.4 asks explicitly how much visual weight the permission block gets, and calls it "the product's highest-stakes UI element" | **Strong agreement, independently reached.** The skill's signature-element framing lands on exactly the element the brief already flagged. The built UI under-delivered on it: the amber block was one hairline border away from an ordinary line. |
| "Extra animation contributes to the feeling that the design is AI-generated"; remove one accessory | Brief §5: **only two** things animate — the take-the-wheel sweep and the thinking-strip fade | **Agreement, and it caught a violation.** The shipped CSS had a third animation: `.pulse` running `1.2s infinite` on the thinking strip's `✦`. Both baselines and the skill independently say cut it. |
| "Structure is information … encode something true about the content" | Brief §5 party pane: "Ended sessions render visually dimmed/muted" | **Agreement with a correction.** `opacity: 0.5` encodes "ended" *only* as transparency, and pushed already-dim meta text far below any legible contrast. Encoding it structurally (dashed frame) says the same thing without destroying legibility. |
| Quality floor: "visible keyboard focus" | Brief §6: "**Keyboard-first.** Every core action … should have a clear keyboard path" | **The skill closed a gap the brief left open.** The brief mandated keyboard-first *behaviour* and the components deliver it (`a`/`d`, `space`, Enter) — but neither the spec nor the brief ever said what focus should *look like*, and the CSS had no `:focus-visible` rule at all, while `.promptbar input` explicitly sets `outline: none`. This is the single clearest case of the skill catching something the hand-written brief could not. |
| Quality floor: "reduced motion respected" | Not mentioned in the spec or the brief anywhere | **Pure skill contribution.** No `prefers-reduced-motion` handling existed. |

### Disagreed, or applied with friction

1. **"Typography carries the personality … pair the display and body faces deliberately."**
   This is the skill's single largest point and it is **inapplicable here**. Spec §1 and brief
   §3.1 mandate *one* monospace stack everywhere, from system fonts, with no webfonts (brief
   §6). There is no display face to pair, no width axis to exploit, and effectively one weight.
   The skill has no branch for "typography is a fixed constraint," so roughly a fifth of its
   guidance produced nothing usable. **Resolution: brief wins**, per the skill's own "the
   brief's own words always win" rule.

2. **"The hero is a thesis. Open with the most characteristic thing …"** The skill is written
   for a *page* — a hero, a scroll, sections, a page-load sequence. This is a full-viewport
   application shell with no hero, no scroll narrative, and no marketing surface. The
   *concept* transferred (identify the most characteristic thing and lead with it → the
   transcript and the permission gate), but the prescription did not.

3. **The AI-default calibration list is a direct hit on this product's approved direction.**
   The skill names "a near-black background with a single bright … vermilion accent" as default
   cluster (2), and "zero border-radius" with "hairline rules" as part of cluster (3). The v4
   UI is near-black (`#0b0d10`) with a vermilion/terracotta accent (`#d97757` — Claude's own),
   hairline rules, and — after this pass — zero border-radius. Read naively, the skill says
   this design is templated. But the skill's own escape clause resolves it: the direction is
   pinned by the brief and by an explicit product goal ("essentially match the same shell as
   Claude Code"), so **the brief wins and the look stays.** This is worth recording plainly:
   a *faithful homage to a specific known tool* and *an AI default* can be visually
   indistinguishable, and only the brief can tell them apart. The skill handles this correctly
   but only in one sentence, and an agent skimming it could easily "fix" the design away from
   the product's actual identity.

4. **"Responsive down to mobile."** Directly contradicted. Spec §8 and brief §6 both make
   mobile an explicit non-goal; the only responsive behaviour in scope is the party pane
   collapsing under 900px. **Brief wins; not adopted.**

5. **"Take one real aesthetic risk you can justify."** In tension with the task's own
   constraint (CSS-only refinements, no structural or component changes) and with a
   already-ratified direction. The risk taken was the largest one available inside those
   bounds — collapsing the type scale (see below) — but the skill plainly expects more latitude
   than a refinement pass has.

6. **The skill's copy guidance found nothing.** Its writing section is strong and specific
   (active voice, one name per action through the whole flow, errors that don't apologise,
   empty states as invitations). Checked against the shipped strings — `[ enter session ]`,
   `🛞 take the wheel`, `you're driving — prompt the agent…`, `⏳ driver deciding…`,
   `no quest declared`, `no sessions yet`, `space to jump · click the prompt to type instead` —
   the copy already satisfies all of it. Verbs are active, controls name their outcome,
   nothing apologises. **Agreement by way of nothing to fix**, which is itself a result: the
   hand-written brief's vernacular work had already covered this ground.

---

## (c) Recommendations adopted

All changes are CSS-only, in `poc/client/src/terminal.css`. No component, markup, or behaviour
was touched.

### The subject-grounded thesis, and the risk

The skill's most useful single instruction was **"the subject's own world, its materials,
instruments, artifacts, and vernacular, is where distinctive choices come from."** Applied
literally: a terminal's material is **the character cell**. Everything else follows from that,
and it is a sharper design rule than "use a modular scale," because it is derived from this
subject and not transferable to any other page.

**The risk taken (skill: "take one real aesthetic risk you can justify"): collapse the type
scale to a single size.** A real terminal has exactly one cell size; hierarchy there is carried
by colour and position, never by point size. So the three-size scale (13/12/11px) was cut to
one content size (13px) with a single tracked micro-label step (11.5px, `0.14em`, used only for
`PARTY ·`, `JOIN SESSION`, and `OBJECTIVE:`). The status line, party quest/meta, permission
outcome and thinking hint all moved *up* to 13px and are now distinguished purely by `--dim`.
This is a genuine risk — it makes secondary chrome heavier than a conventional web hierarchy
would — and it is justified twice over: it is what the subject actually does, and it removed
every instance of 11px text sitting at 4.12:1 contrast.

### Adopted changes

1. **Cell-derived tokens.** `--fs: 13px`, `--fs-label: 11.5px`, `--line: 20px` (an *integer*
   line box — the previous `line-height: 1.5` on 13px produced a fractional 19.5px), and a 4px
   spacing grid (`--sp-1: 4px` … `--sp-6: 24px`). Every padding, margin and gap in the file now
   resolves to a token. The off-grid values (3px, 6px, 10px, 14px, 20px) are gone.

2. **True scrollback rhythm.** `.line + .line { margin-top: 0 }` — consecutive transcript lines
   now sit on adjacent cells with no leading, as a terminal does. The 2px inter-line gap was a
   web-app instinct. Turn separation is restored where it means something:
   `.line + .line:has(> .who)` gives one cell of air above each user prompt, so each turn reads
   as a paragraph. (Degrades to zero-gap on engines without `:has()`.)

3. **Flattened the surface — "remove one accessory."** `--panel` was `#101318`, *lighter* than
   `--bg`, which made every region read as a raised card. Panels now share the background and
   the 1px rules do all the separating. A new `--input: #14171d` is spent only on the two
   surfaces that are genuinely interactive or quoted — the prompt input, and the permission
   block's command line.

4. **Removed all `border-radius`.** 6px/4px/3px radii on the frames were the loudest remaining
   "this is a web page" tell, and directly contradicted brief §3.1's "no border-radius … of any
   kind" and its box-drawing-character frame language. (Noted above: zero-radius is also part
   of an AI-default cluster the skill warns about — the brief pins it, so the brief wins.)

5. **The permission block promoted to the signature element,** with everything around it
   deliberately quieter (skill: "spend your boldness in one place"). It now carries an amber
   wash, a 4px left rail, and a full cell of margin above and below.
   **Two weights, not one:** `.perm:has(.perm-actions)` — true exactly when this viewer is the
   driver and the request is still open — gets the full treatment; a decided block, or one this
   viewer can only watch, keeps an amber frame at `--amber-mute` and recedes. This directly
   answers brief §7.4 ("should it draw the eye immediately even in a fast-scrolling
   transcript"): yes, but only while it is actionable. Approve/deny buttons also grew to a
   real target size and gained hover fills.

6. **Contrast floor met.** `--dim` was `#6b7482` = **4.12:1** on `--bg` — below WCAG AA — and it
   carried the smallest text in the app (party meta, status line, thinking hint, tool output).
   Raised to `#828c9b` = **5.72:1**. `--frame` lifted `#333b49` → `#3d4655` (1.73 → 2.04:1) so
   the dashed rules read as rules. Every other palette entry was measured and already clears
   AA: fg 14.37, gold 10.21, amber 8.91, green 8.95, accent 6.23, red 5.85; all six identity
   colours 6.09–11.26. Ratios are recorded inline in the token block.

7. **`:focus-visible` ring**, global, 2px `--accent` with 2px offset. The brief demanded
   keyboard-first behaviour but never specified what focus looks like, and there was no focus
   styling anywhere.

8. **`@media (prefers-reduced-motion: reduce)`** disables the wheel sweep, the strip-in and the
   fade-out transition.

9. **Cut the infinite `.pulse` animation** on the thinking strip's `✦`. It was a third
   animation in a design that allows exactly two (brief §5), and the running dino lane plus the
   ticking elapsed counter already carry liveness. The class is kept as an inert hook so
   `ThinkingStrip.tsx` needs no change.

10. **Ended party entries encoded structurally** — `opacity: 0.5` → `0.75` plus a dashed frame,
    so "ended" is carried by a structural signal rather than by fading text past legibility
    (skill: "structure is information").

11. **Gutters unified to 12px** across header, objective, transcript, party pane, prompt box and
    status line, so text in every region shares one left column — which is what makes a
    multi-pane terminal read as one grid rather than several boxes.

### Rejected

| Recommendation | Why rejected |
|---|---|
| Pair a distinctive display face with a body face | Spec §1 / brief §3.1 mandate one monospace stack; brief §6 forbids webfonts. Non-negotiable. |
| "Responsive down to mobile" | Explicit non-goal (spec §8, brief §6). The 900px party-pane collapse is the only responsive behaviour in scope, and it already exists. |
| Move off the near-black + vermilion palette (skill's AI-default cluster 2) | The palette is the product's identity — a deliberate Claude Code homage, ratified in the spec's decision table. The skill's own "the brief's own words always win" clause covers this. |
| Lead with a hero / page-load sequence / scroll-triggered reveals | No hero surface exists; brief §5 caps total animation at two moments. |
| Rewrite interface copy | Checked line by line against the skill's writing rules; the existing strings already comply. |

### Recorded as future work (needs a component change — out of scope here)

1. **`.perm.decided` class.** The permission block has three states — *open and actionable by
   you*, *open but you're only watching*, *decided* — and only two are distinguishable in CSS,
   because the pending-watcher state and the decided state both render a `.perm-outcome` div.
   `Transcript.tsx` should emit `.perm.decided` (and ideally `.perm.pending`) so the collapsed
   state can properly recede. Brief §7.4 asks for both states to be specified; only the
   actionable/non-actionable split is achievable CSS-only.

2. **Lobby label column.** `name ›` / `glyph ›` / `color ›` don't align, because the label text
   in `Lobby.tsx` is a bare text node inside a flex row — an anonymous flex item, which CSS
   cannot target or size. Column alignment is the essence of a terminal UI, so this is a real
   defect. Fix: wrap the labels in `<span class="lobby-label">` and set a fixed `ch` width.

3. **Turn grouping in the transcript.** Turn separation is currently approximated by
   `:has(> .who)` (space before each user prompt). A real `turn_end`-driven wrapper element
   would let agent turns, tool blocks and system lines each get correct grouping instead of
   inferring it from line classes.

4. **Party-pane collapse under 900px.** The CSS still just does `display: none`. Spec §2 and
   brief §3.2 both call for collapsing to a status-line summary ("ben +1 watching") *with a
   toggle*. Hiding it is not collapsing it. This predates this pass, but the skill's
   "empty and failure states are moments for direction" framing is what surfaced it.

---

## (d) Verdict: is the skill useful alongside a hand-written brief?

**Yes, but not for the reason it advertises, and not as a replacement for the brief.**

The skill sells itself as a source of *aesthetic direction* — palette, type pairing, a signature
look, an identity "that could not be mistaken for anyone else's." On this project that
half of it was almost entirely inert, and by its own rules it had to be: the direction was
already pinned, monospace-only, dark-only, webfont-free, and a deliberate homage to a specific
existing tool. Roughly half the skill's word count is about display/body type pairing and hero
composition, neither of which exists here. Worse, its own calibration list flags this product's
ratified palette and zero-radius frames as AI-default clusters; only one sentence
("the brief's own words always win") stops an agent from confidently redesigning the product's
identity away. On a project with a strong brief, that sentence is doing more work than the
other 1,300 words, and it is easy to skim past.

What the skill *did* deliver, and what a hand-written brief structurally cannot, is a **process
and a floor**. Three things came out of it that neither the spec nor the brief produced:
(1) `prefers-reduced-motion`, which appears nowhere in either baseline; (2) visible keyboard
focus — the brief mandated keyboard-first behaviour but never said what focus looks like, and
the CSS had no focus styling at all while explicitly stripping the UA default; and (3) the
"minimal directions need precision" test, which is what turned "the brief gave exact values" into
"the exact values don't form a system," and produced the cell-derived token set. A brief written
before implementation specifies *what to build*; it cannot audit *what was actually built*. The
skill's "critique, build, critique again" loop is what caught the third animation that violated
the brief's own §5, the sub-AA `--dim`, and — in the second critique pass — a regression the
first pass introduced (uppercasing the party title also case-folded the project identifier).

Its most valuable single line for this project was the least design-specific one: *"the subject's
own world, its materials, instruments, artifacts, and vernacular, is where distinctive choices
come from."* That is what produced the cell as the unit of measure, integer line boxes,
zero-leading scrollback, the flat surface, and one type size — a coherent system derived from
the subject rather than imported from a design-system template. The brief asked for exact
numbers and got them; the skill asked *where the numbers should come from*, which is the better
question and the one that made the numbers cohere.

**Practical conclusion: keep both, in this order.** Hand-written brief first — it carries the
product truth, the event vocabulary, the ratified decisions, and the non-goals, none of which
the skill can know or infer. Then run the skill as a **post-build critique and quality-floor
pass**, with the brief explicitly loaded as the authority, because on its own the skill will
mistake a faithful homage for a template. Used that way it earned its place here: eleven
adopted CSS changes, two accessibility defects fixed, one brief violation caught, and four
genuine defects written down as scoped future work. Used the other way round — skill first, as
a source of direction — it would have argued this product out of its own identity.

---

## Verification

- `npm run build` (in `poc/client`) — clean, `tsc -b && vite build` both pass.
- `npx vitest run` — **11/11 passing**, 3 files. (There is no repo-root `package.json`; the
  suite lives in `poc/client`.)
- Visual spot-check at 1440×900 against a full injected event set, plus the lobby surface:
  `.playwright-mcp/session-before.png` → `session-after2.png`, `lobby-before.png` →
  `lobby-after.png`.
- Contrast ratios computed with the WCAG 2.x relative-luminance formula against `--bg`
  (`#0b0d10`); the resulting values are recorded as comments in the `:root` token block.
