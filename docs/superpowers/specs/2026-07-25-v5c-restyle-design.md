# v5c — 90s gamified terminal restyle (user-approved design)

*Approved 2026-07-25. Branch: `feature/v5c-restyle` off main at `1591089` (post-PR #2).*

## 1. Goal & scope

Port the user-supplied design patch (`Multiplayer AI 90s Terminal UI.zip`, repo
root — extract to a scratch dir; the `repo-patch/` inside is the source) onto
the v5a client. The patch was authored against the **v4** client, so this is a
port, not a file replace: every patch component adopts the current component's
logic and moves its markup to the patch's classes.

**Zero functional regressions.** Every v5a behavior works identically under the
new skin: slash autocomplete (passenger=suggest, driver=auto-run), suggest →
decide flow, plan gate (approve / request revision, mode switchback), todo
mirror, subagent groups (collapse/expand), a/d shortcuts, take-wheel,
permission cards, model switch, lobby, dino game.

**One feature beyond restyle:** the party-wide skill suite (§5) — SkillsPanel
lists the union of all party sessions' skill rosters, fed by a small additive
change to the project-sessions feed. No other server changes.

**HUD data policy (user-decided):** only client-derivable numbers are live —
TURN (count `turn_end` + 1), TOOLS USED (count `tool_call`), gated (count
`permission_request`). CONTEXT and PARTY XP render the patch's `—`
placeholder; usage/XP wire events are explicitly out of scope (v5b or later).

## 2. Shell & CSS

- `index.html`: add the patch's two Google Font links (pixel + mono).
- `terminal.css`: the patch's theme (562 lines, keeps every v4 class name)
  **merged with restyled versions of the 15 v5a class blocks it predates**
  (`todopanel`, `subagent`, `skillcard`, `slashmenu`, `planmode`/`plan-body`).
  Same class names, 90s treatment — components keep compiling throughout the
  port.
- Whole app wraps in `<Cabinet><Crt>` (marquee + legend; scanlines, vignette,
  tint, roll, bezel). `Crt` keeps its `off | subtle | full` intensity knob,
  default `full`. `prefers-reduced-motion` kills flicker/roll/sweep/bob/pulse
  (as the patch already does).
- v4 accessibility floor kept: `--dim` ≥ 5.72:1; pixel-font labels are 8–11px
  caps and never sole carriers of information (always repeated in the 13px
  mono layer); `:focus-visible` rings; ended sessions encoded structurally,
  not opacity-only.

## 3. Component ports

Order follows the patch README's de-risking sequence: `index.html` +
`terminal.css` first (old components still compile), run the demo, then
components one at a time. For each, start from the CURRENT component and move
its markup to the patch classes.

- **Header**: patch crumb bar + HUD strip + quest bar; plus the v5a plan-mode
  toggle restyled as a pixel HUD button (`▢ PLAN` off / `◉ PLAN` lit in the
  plan accent). `hud` prop fed from App (derivable counts only). Quest-step
  segments render only when a `questStep` prop exists (none today — leave the
  prop optional as in the patch).
- **Transcript** (the big one): patch idiom — chunky permission card with
  WAITING-seconds timer, watcher sprites, wheel banner, quest lines — merged
  with v5a's grouped rendering (`deriveTranscriptGroups` untouched). New 90s
  treatments for the v5a surfaces, same data and handlers:
  - **Subagent groups** → inset "co-op window" panels: pixel label
    `⚒ SUB-QUEST: <description>`, blinking status lamp while running / solid
    when done, row count; collapse/expand behavior unchanged.
  - **Skill cards** → gold-framed `⚡ SPELL CAST: <name>` cards, args in the
    mono layer. (Output continues to fall through as a generic dim row — the
    ratified v5a deviation stands.)
  - **Suggest chips** → pixel-bordered chips; driver sees `[R]UN` /
    `[X] DISMISS` buttons (real buttons, not letter-only affordances). Args
    preview widened 120 → 300 chars to match the permission card's budget
    (closes HANDOFF §7 item 10 toward approve-what-you-see).
  - **PlanCard** → permission-card frame in the plan accent:
    `📜 PLAN PROPOSED`, markdown body, `[A]PPROVE` / `REQUEST REVISION`
    buttons, decided/read-only states as today.
- **PromptBar**: patch restyle + v5a slash autocomplete; slashmenu becomes a
  pixel-border popup (roster names + dimmed descriptions), passenger variant
  labeled `SUGGEST`. Existing keyboard behavior unchanged.
- **TodoPanel**: patch panel idiom — `QUEST LOG` pixel header, `☐ ◐ ☒`
  glyphs kept.
- **PartyPane**: patch port (party roster, `you` card, other parties).
- **ThinkingStrip**: patch port — arcade strip chrome; dino lane playable
  (engine untouched), other lanes render `CARTRIDGE NOT INSERTED`; party-best
  line renders `—` (no `game_score` event yet — v5b).
- **Lobby**: patch port — PLAYER SELECT sprite tiles, colour chips, optional
  stats card.
- **App.tsx**: merged by hand per the patch's `App.v5.tsx` reference —
  Cabinet/Crt wrap, `?screen=` routing, HUD derivation — keeping ALL v5a
  wiring (planMode/onTogglePlan/onSuggestSkill/onDecideSkill/onDecidePlan,
  TodoPanel mount).

## 4. `?screen=` design screens

- Routes `?screen=skills` and `?screen=status` render inside the Cabinet/Crt
  shell, reachable in the live demo without nav that implies more than they
  deliver; the marquee legend labels design-only content.
- **AgentStatus** (`?screen=status`): ports as design-only — HP/MP bars render
  `—`/empty until a usage event exists.
- **SkillsPanel** (`?screen=skills`): real data where it exists —
  - Skill suite = party-wide skill union (§5), dedup by skill name, each entry
    showing which session(s)/driver(s) bring it.
  - Slash palette = this session's roster (same data as the prompt-bar menu).
  - Run tree = this session's real subagent groups from
    `deriveTranscriptGroups`.
  - The patch's background-tasks section is DROPPED (no data behind it —
    YAGNI).

## 5. Wire change (the only server work)

`projectSnapshot` (`poc/server/src/project.ts`) adds `skills: SkillInfo[]` to
each per-session summary, sourced from the `ProjectSessionEntry.skills` the
server already holds. Client `ProjectSessionInfo` gains the matching field.
Additive field on the live `project` summary message — no logged-event
change, replay untouched, older clients unaffected. The skill-suite union/dedup
is a pure client helper over `projectSessions`.

## 6. Small decisions (user-approved)

- **Party pane <900px**: replace `display:none` with the patch's marked
  `.party summary` spot — a summary row of sprite glyphs with a toggle
  (~15 lines CSS + a small render branch). Closes the carried v4 open item.
  TodoPanel gets the same summary treatment for consistency.
- **7th sprite**: add `★` to `GLYPHS` in `identity.ts`.
- **CRT default**: `full`; `subtle`/`off` remain available as the `Crt`
  intensity prop (screen-recording knob), not user-facing UI.

## 7. Testing & acceptance

- Existing suites stay green at every step (server 89 + additions, client 18;
  derive tests are style-agnostic).
- New tests: `projectSnapshot` includes per-session `skills`; skill-suite
  union/dedup helper (pure function, client test).
- Final live Playwright acceptance, one pass through every restyled surface:
  lobby → session → permission card (a/d + buttons + watcher sprites) →
  suggest chip → plan cycle → subagent group → todo panel + <900px summary →
  `?screen=skills` with two sessions contributing different rosters →
  `?screen=status` → CRT knob + reduced-motion. Screenshots taken;
  commit-or-drop is the user's call at the end.
- Live-demo gotcha carried from v5a: fresh demo sessions need a git worktree
  first (`git worktree add ../demo-worktrees/<session> -b <session>` from
  `poc/demo-project`); tsx watch hot-reload kills live SDK turns.

## 8. Out of scope

- Context/usage wire events, party XP, `game_score` / party-best, additional
  game engines (Snake/Breakout/Type Race), per-user skill inventories
  ("users declare/upload their own skill packs" — revisit after v5b), state
  tabs from the mock (mock-only scaffolding), background-tasks panel.
