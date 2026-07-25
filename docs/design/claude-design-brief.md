# Claude Design Brief — "Terminal, but multiplayer" (v4)

*Prepared: 2026-07-24 · For: external "Claude Design" agent · Status: ready to act on*

This document is self-contained. You should not need to open the repository to produce
screens from it — everything you need (product context, current UI, approved direction,
component list, motion, constraints, and explicit asks) is written out below.

---

## 1. Product one-pager

**What it is:** Multiplayer AI is a developer tool where a team shares one live coding-agent
session per project, the way people already share a terminal over screen-share — except the
terminal itself is multiplayer-native instead of screen-shared.

**Core mechanics:**

- **Shared live agent sessions per project.** Everyone on the project can join the same
  session and watch the agent's work — prompts, tool calls, tool output, errors — appear in
  real time, exactly as it happens, not as a replay or a summary.
- **One driver at a time, take-the-wheel handoff.** Only one person "drives" (can prompt the
  agent) at any moment. Anyone else in the session can take the wheel from the current
  driver at will — control passes instantly, visibly, to whoever takes it. There is no
  request/grant negotiation; taking the wheel is a single action.
- **Agent-side awareness.** The agent narrates itself: it self-declares its current intent
  (a short "what I'm doing right now" line) as it works, and separately, each project's
  sidebar shows a live digest of what every other session on the project is doing — a
  teammate glance-view without needing to join their session.
- **Multiplayer approval gate.** When the agent wants to run a privileged/dangerous tool call
  (e.g. a shell command), it doesn't just ask the driver — it surfaces the request to
  everyone in the session, and **any** driver-eligible participant can approve or deny it, not
  only whoever happens to be driving. This makes tool-safety a team decision, not a solo one.
- **Per-session agent/model choice.** Each session picks which Claude model runs it
  (e.g. Opus, Sonnet, Haiku), and the current driver can switch models between turns as needs
  change (cheaper/faster for grunt work, stronger for hard problems).

**Audience:** Development teams — engineers pairing or mobbing on a shared codebase who want
the speed of an autonomous coding agent without losing the safety and visibility of having a
human in the loop, and without one person being a silent bottleneck.

**Competitive frame:** Tools like Amp's "Multiplayer" and Warp's "Remote Control" already let
a team watch or hand off control of one agent session. What none of them combine is all four
pieces at once: a genuinely shared live session, frictionless take-the-wheel handoff, agent
self-narrated awareness plus a cross-session teammate digest, and a tool-approval gate that
any teammate — not just the active driver — can act on. That combination is the product's
differentiation.

---

## 2. Current UI state

Today's proof-of-concept client is a plain, generic dark web app — it works, but it does not
yet look or feel like the product's real identity (see Section 3 for where it's headed). As
it stands today:

- A single centered column, **max-width 860px**, full viewport height, dark background
  (`#0f1115`) with light-gray text, in a normal proportional system UI font (not monospace).
- A plain `<h1>` header showing "Multiplayer AI — session `<id>` · project `<id>`" with a
  connected/disconnected status dot on the right.
- A row of **pill-shaped teammate avatar chips** below the header (rounded-999px background
  chips, one per participant), with a green-tinted chip for whoever is currently driving and
  a 🛞 suffix on their name.
- The main transcript area is a **bordered rounded box** containing chat-style messages:
  - User prompts render as **right-aligned dark-blue chat bubbles** (rounded corners,
    max-width 80%), like a messaging app.
  - Agent text renders as **left-aligned dark bubbles**, full width.
  - Tool calls/results render as small dim monospace lines with a gear (⚙) or arrow (↳)
    prefix.
  - System lines (control changes, intent updates, permission decisions) render as small
    centered gold/amber text.
  - **Permission requests render as a purple-bordered card** (`msg permission` — background
    `#2a2337`, border `#6d5aa8`) containing a title line, a monospace code box showing the
    command, and green **Approve** / red **Deny** buttons (or a "waiting for the driver"
    line for non-drivers, or an approved/denied outcome line once decided).
- To the right of the transcript, a **teammates sidebar** (~240px, bordered rounded box)
  lists the project's other sessions as clickable cards, each showing the session id, its
  declared intent (or "no declared intent yet"), and a meta line of participants / driver /
  last-activity time.
- At the bottom, a footer with either a plain rounded **text input + blue "Send" button**
  (if you're driving) or a full-width green **"Take the wheel 🛞" button** (if you're not).

**Screenshots** (repo root, referenced for visual grounding — describe/redesign from these,
you don't need the live app):

- `step1-autoapprove.png` — driver's view mid-session: header, driving teammate chip, gold
  intent line, chat-bubble transcript (tool calls/results inline as dim monospace lines), and
  the driving-only prompt input at the bottom.
- `step2-card.png` — the purple permission-request card in its "awaiting decision" state,
  showing the tool name, a monospace command preview box, and the green Approve / red Deny
  buttons, mid-transcript among chat bubbles.
- `step3-denied.png` — a second participant's view after a permission request was denied: the
  purple card now shows a collapsed "denied" outcome line, followed by system lines
  ("took the wheel", "denied a tool request") and the agent's own bubble reply adapting to
  the denial.
- `step4-sidebar.png` — a non-driving participant's near-empty transcript (just a "took the
  wheel" system line) next to the teammates sidebar showing one other live session card with
  its intent, participants, and driver.

---

## 3. Approved aesthetic direction (restate — do not deviate)

This section is a verbatim-faithful restatement of the design decisions that have already
been approved for this product. Treat it as fixed ground truth, not a suggestion.

### 3.1 Visual foundation

- **Type:** one monospace stack everywhere — `ui-monospace, "SF Mono", "JetBrains Mono",
  Menlo, monospace`. No proportional type anywhere in the interface. No chat bubbles, no
  rounded message cards, no border-radius message styling of any kind. This is a hard
  reversal of the current UI's chat-bubble look described in Section 2.
- **Color:** a near-black terminal background with light-gray foreground text. A small,
  deliberately limited semantic palette layered on top:
  - dim gray → tool calls and tool results
  - gold → system/awareness lines
  - red → errors
  - warning-amber → permission blocks
  - Additionally, each user gets a per-user **identity color**, derived deterministically
    from their `userId` (i.e., the same user always renders in the same color across
    sessions and reloads). Identity color is used for their name, an avatar glyph, and their
    entry in the party pane (Section 4).
- **Glyph vocabulary** (matches the visual language of Claude Code's own terminal shell —
  keep these exact glyphs, do not substitute other icons):
  - `⏺` — tool call
  - `⎿` — tool result
  - `>` — user prompt
  - `✦` — intent / objective
  - `🛞` — driver (whoever currently has control)
  - `🔐` — permission (privileged tool-call gate)
  - Frames and dividers are drawn using **box-drawing characters**: `╭ ─ ╮ │ ╰ ╯ ├ ┬ ┴`.

### 3.2 Shell & layout

- The whole app is **one full-viewport terminal window** — it should read as a terminal
  application, not a web page with a chrome-browser feel. A single header rule across the
  top shows: `project · session · agent: opus 4.8 ▾ · connection state`.
- Below the header, a **tmux-style two-pane split**: the transcript pane (flexible width,
  takes remaining space) on the left, and a **PARTY pane** (~280px fixed width) on the
  right. See Section 4 for PARTY pane contents. Under roughly **900px viewport width**, the
  party pane collapses into a single status-line summary (e.g. "ben +1 watching") with a
  toggle to expand it back.
- At the bottom: a **boxed prompt input** drawn with box-drawing characters (`╭─╮` style
  border), spanning the full pane width. Directly beneath it, a **status line** showing
  driving state, an `esc to interrupt` hint, and a watcher-count summary.
- Overall max width is **~1280px**, centered, at full viewport height — this is a deliberate
  increase from the current UI's 860px, because the party pane needs permanent screen real
  estate (awareness is a first-class, always-visible part of the product, not a drawer you
  open).

---

## 4. Component inventory to design

Design each of the following as a distinct, fully specified component. Where noted, the
event → rendering mapping is fixed (copied verbatim from the approved spec) — do not change
what information each line shows, only its visual treatment.

1. **Header rule** — single line: `project · session · agent: opus 4.8 ▾ · connection state`.
   The `agent: … ▾` segment is a dropdown trigger (see "Agent picker" below).

2. **Transcript event lines.** The transcript is a chronological log; each entry corresponds
   to one event type from the underlying event log (the full event/message list is in
   Section 6). Rendering per event type:

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

3. **Permission block** — the bordered amber `🔐` block described above, in both of its
   states: open (awaiting decision, showing the command and either action buttons for a
   driver or a waiting line for others) and collapsed (after a decision, a single outcome
   line). This is the highest-stakes UI element in the product — see the explicit ask on
   visual weight in Section 7.

4. **Thinking strip + dino lane** — appears at the bottom of the transcript while the agent's
   turn is active (from the moment a prompt is sent until the turn ends). Content: a line
   reading `✦ <model> is thinking… (12s) · score 0042`, above an ASCII dino-runner lane, the
   whole thing framed between dashed rules. This is a small, playable, per-viewer local
   mini-game (every viewer — driver and watchers alike — can play it independently; jumps
   are never broadcast to other viewers). `space` makes the dino jump, but only when the
   prompt input isn't focused (typing in the prompt exits/pauses the game). The high score
   persists locally (browser storage) per viewer. The whole strip fades out when the turn
   ends. Whether this is built with DOM/CSS or `<canvas>` is an implementation decision, not
   a design one — design the visual/animation target either way.

5. **PARTY pane** — the right-hand ~280px pane, replacing today's plain teammate-card
   sidebar. Header: `PARTY · <project name>`. One entry per session in the project,
   showing: an avatar glyph rendered in that session's identity color, the session name,
   its list of participants, a `🛞` marker on whichever participant is currently driving that
   session, that session's currently-declared intent shown as a "quest line", and a
   last-activity timestamp. Ended sessions render visually dimmed/muted. Clicking an entry
   jumps the viewer into that session (this behavior already exists today and should be
   preserved, just re-skinned).

6. **Lobby screen** — a new pre-join surface shown before a user enters a session. Contains:
   a name input (pre-filled from the user's previously stored identity, if any), an avatar
   glyph + color picker chosen from a small fixed set of options, a live view of who is
   already present in the party/project, and an `[ enter session ]` action. Once set,
   identity (name + glyph + color) persists across the browser session the same way it does
   today. A `?name=` URL parameter should be able to skip the lobby entirely (used for
   scripted demos) — design should not assume the lobby is always shown.

7. **Agent picker** — opened via the `agent: opus 4.8 ▾` control in the header. Only the
   session's **current driver** can open it. Offers a small fixed set of Claude models
   (opus / sonnet / haiku). Selecting one switches the session's model, but the switch only
   takes effect **between turns** — it must never interrupt or apply mid-turn. Consider how
   the picker communicates "you can't change this right now, a turn is in progress" to a
   driver who tries mid-turn, and how it communicates "only the driver can do this" to a
   non-driver who tries.

8. **Prompt bar + status line** — the boxed `╭─╮` prompt input at the bottom of the
   transcript pane, plus the status line directly beneath it (driving state / `esc to
   interrupt` hint / watcher-count summary), as described in Section 3.2.

---

## 5. Motion

Motion in this product is intentionally minimal — almost everything is static, terminal-style
text. Only two things animate:

1. **Take-the-wheel sweep** — when control changes hands (`control_change` event), a
   **one-beat** full-width dashed-rule sweep animation plays, accompanying the
   `🛞 ben took the wheel` line, before it settles into a normal static system line in the
   scrollback. This is the single moment of visual flourish the product allows itself.
2. **Thinking-strip fade-out** — when an agent turn ends, the thinking strip + dino lane
   (Component 4 above) fades out and is removed.

Nothing else in the interface should animate. No hover micro-interactions beyond ordinary,
subtle state changes (e.g. a button darkening slightly on hover is fine; anything that reads
as "motion design" is not).

---

## 6. Hard constraints

- **Must render the full existing event vocabulary.** The transcript is driven by an
  append-only log of typed events. The event types your design must account for (including
  ones not yet listed in Section 4's table, which are upcoming but already committed) are:

  - `user_message` — a prompt a user sent
  - `agent_text_delta` — a chunk of the agent's text response
  - `tool_call` — the agent invoking a tool, with a tool name and input
  - `tool_result` — the output of a tool call
  - `control_change` — driver changed
  - `presence_join` — a user joined the session (optionally may carry an avatar glyph and
    identity color, for lobby-selected identity to be visible to teammates)
  - `presence_leave` — a user left the session
  - `agent_error` — an error from the agent
  - `intent_update` — the agent (or a user) updated the declared current intent
  - `permission_request` — the agent is requesting approval to run a privileged tool call
  - `permission_decision` — someone approved or denied a pending permission request
  - `turn_end` *(upcoming)* — marks the end of an agent turn; this is what should trigger the
    thinking-strip fade-out in Component 4, and gives the app an explicit turn boundary it
    doesn't cleanly have today
  - `model_change` *(upcoming)* — the session's chosen agent model changed (rendered as a
    system line, e.g. `✦ agent switched to sonnet`), driven by the Agent picker (Component 7)

  Design every event type a visible, on-brand terminal-line treatment — don't leave any of
  them unstyled or defaulting to "generic text."

- **This is a web app** (React + CSS), not a native terminal emulator — it must be
  implementable with ordinary web technologies. Don't design anything that requires a real
  PTY, native window chrome, or OS-level terminal integration.
- **Keyboard-first.** Every core action (sending a prompt, approving/denying a permission
  request via `a`/`d`, interrupting via `esc`, taking the wheel) should have a clear
  keyboard path, not just a mouse-click affordance.
- **Dark-only.** No light theme. Don't design a light-mode variant.
- **No external fonts or CDNs required.** The monospace stack must resolve from
  system-installed fonts (`ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`) —
  don't design around a webfont that has to be fetched from a font CDN.
- **Desktop-first,** with the one specific responsive behavior already noted in Section 3.2:
  the PARTY pane collapses to a status-line summary under ~900px viewport width. Beyond that
  one breakpoint, do not design a full mobile/responsive system — this is explicitly out of
  scope (see also Section 8 non-goals below).
- **Existing behavior must not silently change.** In particular, permission/approval logic
  (who can approve, what "any driver-eligible participant" means) is a separate, already-
  ratified product decision — your job is to give it the right visual weight and treatment,
  not to redesign the underlying rule.
- **Out of scope for this pass (non-goals):** auto-reconnect UX, a mobile layout, a light
  theme, sound, broadcasting the mini-game's state to other viewers, and support for non-
  Claude agents. Don't spend design effort on these.

---

## 7. What to design (explicit asks)

Please produce concrete, specific answers to each of the following — not just a general
mood/direction, but exact values a frontend engineer could implement directly:

1. **Spacing and type scale.** Exact pixel or rem values for the monospace type scale (body
   text, header rule, system lines, code/tool lines, timestamps) and the spacing rhythm
   (padding within the transcript pane, gaps between transcript lines, gutters around the
   two-pane split, padding inside the boxed prompt input and permission block).

2. **Final palette values.** Concrete hex/HSL values for: the near-black background, the
   light-gray foreground, dim gray (tool calls/results), gold (system/awareness), red
   (errors), warning-amber (permission blocks), and the identity-color set (the small palette
   of distinct colors assigned deterministically per user, plus the hashing/assignment rule
   if you have an opinion on it). Also specify border/rule colors for the box-drawing frames
   and pane divider.

3. **Dino sprite treatment** — decide and specify whether the thinking-strip mini-game
   (Component 4) renders as true ASCII/text-character art or as small pixel-art sprites
   rendered in DOM/CSS, and show what the running/jumping states and the obstacle(s) look
   like either way.

4. **Permission-block visual weight.** This is the product's highest-stakes moment (a
   privileged tool call awaiting human approval) — specify exactly how much visual emphasis
   it gets relative to ordinary transcript lines (border weight, background contrast, icon
   size, whether it should draw the eye immediately even in a fast-scrolling transcript) for
   both its open (awaiting decision) and collapsed (decided) states.

5. **Party-entry layout.** The exact layout of one entry in the PARTY pane (Component 5) —
   how avatar glyph, session name, participant list, driver marker, intent quest-line, and
   last-activity timestamp are arranged and sized within the ~280px pane width, for both
   active and ended-session states.

6. **Lobby composition.** A full layout for the lobby screen (Component 6) — arrangement of
   name input, glyph/color picker, live party preview, and the enter-session action.

7. **Empty and edge states**, specified explicitly:
   - No party members yet (a brand-new/empty project) — what the PARTY pane shows.
   - Agent dead/crashed mid-turn — how this differs from an ordinary `agent_error` line.
   - Disconnected (WebSocket dropped) — how the header connection indicator and the rest of
     the UI communicate this, including whether/how input is disabled while disconnected.
