# v5 design patch — 90s gamified terminal

Drop-in port of `Multiplayer AI Terminal.dc.html` into the real client
(`poc/client`). Same React 19 + Vite + plain-CSS idiom the repo already uses —
no new dependencies, no build changes.

## Copy map

| Patch file | Destination | Nature |
|---|---|---|
| `poc/client/index.html` | replace | adds the two Google Font links |
| `poc/client/src/terminal.css` | replace | full 90s theme. Keeps EVERY existing class name, so the old components still compile against it |
| `poc/client/src/components/Crt.tsx` | new | CRT shell (scanlines, vignette, roll, bezel) |
| `poc/client/src/components/Header.tsx` | replace | crumb bar + HUD strip + quest bar |
| `poc/client/src/components/PromptBar.tsx` | replace | restyle only, same props |
| `poc/client/src/components/Transcript.tsx` | replace | same logic, chunky permission card + watcher sprites |
| `poc/client/src/components/PartyPane.tsx` | replace | party roster, `you` card, other parties |
| `poc/client/src/components/ThinkingStrip.tsx` | replace | game roster + party-best line; dino engine untouched |
| `poc/client/src/components/Lobby.tsx` | replace | PLAYER SELECT (sprite tiles, colour chips, optional stats card) |
| `poc/client/src/components/AgentStatus.tsx` | new | **design-only**, mock props |
| `poc/client/src/components/SkillsPanel.tsx` | new | **design-only**, mock props |
| `poc/client/src/App.v5.tsx` | reference | shows the `<Crt>` wrap + `?screen=` routing; merge by hand into `App.tsx` |

Order that de-risks it: `index.html` + `terminal.css` first, run the demo, then
the components one at a time.

## What lands with zero server work

Everything visual: CRT shell, pixel chrome, sprite tiles, segmented bars,
chunky permission card, quest bar, party roster, arcade strip chrome, lobby.

## What needs wire work (all optional, all degrades gracefully)

Every new datum is an **optional prop that renders `—` when absent**, so the
patch compiles and runs against today's server.

1. `Header` `hud` — `turn`, `contextUsed/contextMax`, `toolsUsed`, `gated`,
   `partyXp`. Turn count and tool count are derivable client-side from the
   event log in `derive.ts` (count `turn_end`, count `tool_call`); context and
   XP need server events.
2. `ThinkingStrip` `partyBest` — the v5 party-wide high score. Needs a
   `game_score` event, and a decision on **per-session vs per-project** scope
   (HANDOFF §0.3). The strip already shows the local high score without it.
3. `ThinkingStrip` game roster — only `dino` has an engine (`game/dino.ts`).
   Snake / Breakout / Type Race render a "cartridge not inserted" lane until
   they get one. Same shape as `dino.ts`: `initialState / tick / renderLane`.
4. `AgentStatus` — HP is context remaining, MP is token budget. Needs usage
   numbers off the SDK result.
5. `SkillsPanel` — the v5 harness screen: spellbook, workflow run tree, slash
   palette, background tasks. Nothing behind it yet; the run tree maps 1:1 onto
   subagent `Task` calls if you emit a `subagent_*` event family.

## Open items this patch takes a position on

- **Party pane below 900px** (HANDOFF §7.4): still `display:none`, still your
  call. The CSS marks the spot — a `.party.summary` row of sprites is ~15 lines
  if you want the spec's summary+toggle.
- **7th sprite**: added `★` to `GLYPHS` in the design so a 7-person party has
  unique sprites. `identity.ts` is unchanged in this patch — add it there if you
  want it real.
- **The state tabs** in the mock (STREAMING / PERMISSION / HANDOFF / ARCADE
  STRIP) are mock-only scaffolding. They are not in this patch; real state comes
  from the event stream.

## Accessibility floor kept from v4

`--dim` stays at 5.72:1. Pixel-font labels are 8–11px caps and never carry
information that isn't repeated in the 13px monospace layer. `:focus-visible`
rings, `prefers-reduced-motion` (kills flicker, roll, sweep, bob, pulse) and the
structural — not opacity-only — encoding of ended sessions all survive.
