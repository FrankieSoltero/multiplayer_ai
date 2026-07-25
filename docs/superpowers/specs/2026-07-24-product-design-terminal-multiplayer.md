# Product Design Spec — "Terminal, but multiplayer" (v4)

*Date: 2026-07-24 · Branch: `feature/project-hub` · Status: user-approved design, pre-plan*

## Purpose

Reshape the PoC client from a plain dark web app into the product's real identity: a
**faithful Claude-Code-terminal shell** with **game-feel flourishes** layered on top, plus
user-selectable agent/model per session. This spec is the source of truth for three
deliverables:

1. This design spec (committed).
2. A self-contained design brief for the external "Claude Design" agent at
   `docs/design/claude-design-brief.md`.
3. A real `soltero-skills:frontend-design` skill pass on this UI, compared against the
   brief-driven approach — keep the better, or merge.

## Decisions (user-ratified, do not re-litigate)

| Fork | Decision | Why |
|------|----------|-----|
| Shell fidelity | **Faithful terminal** — transcript IS a terminal session, no bubbles/cards | Strongest identity; flourishes pop against austerity; matches "essentially match the same shell as claude code" |
| Mini-game placement | **Inline spinner strip** — the game IS the thinking indicator, per-viewer local | Zero modal chrome; always discoverable; fits the shell |
| Agent choice | **Per-session, driver picks** (Claude family), switchable between turns | Fits one-agent-per-session architecture; smallest wire change |
| Game motifs | **All four**: party sidebar, quest-log intents, take-the-wheel flourish, lobby | User selected all |
| Layout | **Two-pane terminal** (tmux-style split), max-width lifted to ~1280px | Awareness is the product — always visible; reads as terminal, not web app |

## 1. Visual foundation

- **Type:** one monospace stack everywhere — `ui-monospace, "SF Mono", "JetBrains Mono",
  Menlo, monospace`. No proportional type. No chat bubbles, no rounded cards, no
  border-radius message styling.
- **Color:** near-black terminal background, light-gray foreground. Semantic palette
  (small): dim gray = tool calls/results; gold = system/awareness lines; red = errors;
  warning-amber = permission blocks. Per-user **identity color** derived
  deterministically from `userId`, used for names, avatar glyphs, party entries.
- **Glyphs (CC vocabulary):** `⏺` tool call · `⎿` result · `>` user prompt · `✦`
  intent/objective · `🛞` driver · `🔐` permission. Frames drawn with box-drawing
  characters (`╭─╮│╰╯├┬┴`).

## 2. Shell & layout

- The app is **one full-viewport terminal window**: header rule showing
  `project · session · agent: opus 4.8 ▾ · connection state`.
- Below it, a **tmux-style two-pane split**: transcript (flex) + PARTY pane (~280px).
  Under ~900px viewport width the party pane collapses to a status-line summary
  ("ben +1 watching") with a toggle.
- Bottom: boxed `╭─╮` prompt input spanning full width; beneath it a **status line**
  (driving state, `esc to interrupt`, watcher summary).
- Max width **~1280px** centered (up from 860px), full viewport height.

## 3. Transcript rendering (event → terminal line)

| Event | Rendering |
|-------|-----------|
| `user_message` | `> ana: run the tests` — name in identity color |
| `agent_text_delta` | plain paragraphs; `⏺` prefix on the turn's first block |
| `tool_call` | `⏺ Bash(npx vitest run)` — dim |
| `tool_result` | `  ⎿ output` — dim, truncated at 300 chars (as today) |
| `agent_error` | red `⚠` line |
| `control_change` | **flourish**: full-width dashed-rule sweep + `🛞 ben took the wheel`, one-beat animation, settles into a normal system line |
| `intent_update` | quest-log: current objective pinned under header as `✦ OBJECTIVE: …`; transcript shows the new one and strikes through the previous |
| `permission_request` | bordered **amber `🔐` block**; command as code line; driver sees `[approve] [deny]` bracket-buttons + `a`/`d` keyboard shortcuts; non-drivers see `⏳ driver deciding…` |
| `permission_decision` | the block collapses to `✅ approved by ben` / `⛔ denied by ben` line |

## 4. Thinking strip + mini-game

- **Trigger:** agent turn active (prompt sent → turn end). Renders at transcript bottom
  where CC's spinner would sit.
- **Content:** `✦ <model> is thinking… (12s) · score 0042` above an ASCII dino-runner
  lane between dashed rules.
- **Rules:** playable by every viewer (driver and watchers), **local only** — jumps are
  not broadcast. `space` jumps only when the prompt input is not focused; typing in the
  prompt exits the game. High score persists in `localStorage`. Strip fades out at turn
  end. DOM/CSS vs `<canvas>` is an implementation-plan decision.

## 5. Party pane

Replaces today's teammate cards. `PARTY · <project>` header; one entry per project
session: avatar glyph in identity color, session name, participants, `🛞` on the driver,
the session's declared intent as its quest line, last-activity time; ended sessions
dimmed. Click to jump to that session (existing behavior preserved).

## 6. Lobby (new surface)

Pre-join screen before entering a session: name input (pre-filled from stored identity),
avatar glyph + color picker from a small set, live view of who's already in the party,
`[ enter session ]`. Identity (name + glyph + color) persists in `sessionStorage` as
today. A `?name=` URL override skips the lobby for scripted demos.

## 7. Agent choice (the one backend change)

- Header shows `agent: opus 4.8 ▾`; **only the current driver** can open the picker
  (opus / sonnet / haiku). Switches apply **between turns**, never mid-turn.
- Wire: new `set_model` client→server message; new `model_change` event in the session
  log (`✦ agent switched to sonnet`) so the switch is multiplayer-visible.
- `poc/server/src/agentDriver.ts` reads the session's chosen model instead of the
  hardcoded `claude-opus-4-8` (systemPrompt/model).

## 8. Non-goals

Auto-reconnect · mobile · light theme · sound · broadcast game state · non-Claude
agents. (These are explicitly out of scope for v4.)

## Constraints carried from v1–v3

- Wire/event model is fixed: the client renders the `events.ts` union
  (`permission_request`/`permission_decision` included); design must not require server
  log-format changes beyond `set_model`/`model_change`, a `turn_end` event (§4's
  "prompt sent → turn end" trigger requires a turn boundary the log doesn't have
  today), optional `glyph`/`color` on join/`presence_join` (§6 lobby identity must be
  visible to teammates), and a read-only pre-join `peek` snapshot (§6's live party
  preview). All are append-only additions; existing events are unchanged.
- v3 ratification items (HANDOFF §7) are a separate open thread; design must not
  silently change permission/allowlist behavior.
- `Docs/` == `docs/` on this filesystem — lowercase `docs/` always.

## Next step

Invoke `superpowers:writing-plans` for the implementation plan, which also sequences
deliverables (b) the Claude Design brief and (c) the frontend-design skill pass relative
to implementation.

## Documented deviations (post-build)

- The status line does not show "esc to interrupt" — no interrupt exists on the wire.
- The lobby party preview is a point-in-time peek snapshot, not a live view.
- `⏺` prefixes every agent text block (plan-mandated), not only the turn's first.
