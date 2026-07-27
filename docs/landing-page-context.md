# Landing Page Context — Multiplayer AI

*Written 2026-07-27. Source of truth for anyone (human or agent) building the marketing
landing page. This is a **context brief**, not a spec and not copy-ready text — it gives
you the product truth, the positioning rules, the real screenshots, and the visual system
so the page can be written and designed without re-reading the repo.*

**Upstream sources, in priority order.** Where this doc and these disagree, these win:

| Source | What it settles |
|---|---|
| `market-research.md` | Positioning, competitive frame, **language discipline**, known risks |
| `docs/superpowers/specs/2026-07-25-deployment-strategy-design.md` §1–§3 | Launch narrative, the staked message, the waitlist/signup gate |
| `docs/design/claude-design-brief.md` | Product one-pager, component vocabulary, aesthetic ground truth |
| `poc/client/src/terminal.css` | The literal design tokens (palette, type, spacing) |
| `HANDOFF.md` | What is actually built and merged *right now* |

---

## 1. What the product is

**Multiplayer AI** is a developer tool where a team shares live coding-agent sessions.
Each engineer drives their own agent in their own git worktree, but anyone on the project
can drop into anyone else's live session — watch the stream as it happens, take control,
and **resolve the agent's pending permission request under their own verified identity**.

The unit of sharing is **awareness** (who is doing what, right now), not **artifact**
(one shared buffer or transcript). Sessions stay isolated; only a minimal digest crosses
between them. That is an architectural choice, and it is the pitch — pooled-context
products get noisier as the team grows; this one shouldn't.

### The one primitive worth building a page around

> **Your agent hits a permission gate and you're at lunch. A teammate drops in, approves
> it under their own name, and leaves. The agent never stopped.**

That is the staked message from the deployment strategy spec. Everything on the landing
page — hero, video, screenshots, feature list — should ladder back to it. It is
high-frequency, unambiguously valuable, and needs no explanation once seen.

**Category term to lead with: "approval handoff."** See §3 for why.

---

## 2. Who the page is talking to

Development teams of roughly **3–8 engineers** who already run autonomous coding agents
(Claude Code, Cursor, Copilot agents, Amp, Warp) and have hit the two problems that come
with them:

1. **The solo bottleneck.** One person's agent is blocked on a permission gate, or headed
   the wrong way, and only that person can do anything about it.
2. **Invisible collisions.** Two agents in two worktrees are about to touch the same
   files, and nobody finds out until the merge.

Secondary audiences the page should not be *designed* for but should not alienate:
eng leads evaluating agent tooling for a team, and the YC/HN crowd who will read the
architecture notes and the honest-limitations section as a credibility signal.

**Sophistication assumption:** high. This audience knows what a worktree, a permission
prompt, and an event log are. Do not over-explain. Do not use stock "AI transformation"
imagery. Terminal literacy is the shared language and the aesthetic leans into it.

---

## 3. Language discipline — the rules

These are ratified positioning decisions, not style preferences. Breaking them collapses
the product into a crowded category.

### Say

| Term | Why |
|---|---|
| **approval handoff** | The category-defining term for public copy. Nobody else claims it. |
| **awareness** | The whole thesis. Sessions stay isolated; awareness is what crosses. |
| **driver** / **take the wheel** | Consistent metaphor across UI, docs and code — keep as in-product flavor. |
| **party** | The co-op social framing (see §7 on why this is load-bearing). |
| **under their own name** / **verified identity** | The differentiator vs. the credential-confusion failure mode. |

### Avoid

| Term | Why |
|---|---|
| **"shared team hub"**, **"multiplayer AI workspace"** | Describes the surface, hides the primitive, lands in the crowded Superconductor/Dust category. |
| **"shared context"** | Off-thesis. The product deliberately does *not* pool context. Say *awareness*. |
| **"take the wheel"** *as the headline claim* | Superconductor uses it verbatim on their homepage. Keep the mechanic prominent; do not stake the headline on the phrase. |
| **"watch your agents live"** as a lead | Commoditized — Copilot cloud sessions are shared-by-default; Warp, Factory, Amp and Omnigent all show the run. |
| Framing **spectating** as the core loop | Nobody ambiently watches a teammate's session; that behavior decays to zero in a week. The core loop is **notice → drop in → act**. |

### The contrast to draw (carefully)

The villain of the story is **credential confusion**: on some competing products a
teammate who steers your agent acts under *your* credentials. Users complain about this
publicly. Our line:

> *Every decision on the wire carries the name of the human who made it.*

GitHub OAuth (shipped — see §5) makes this demonstrably true rather than self-asserted.
Draw the contrast on the mechanism, **without naming competitors combatively.**

---

## 4. Competitive frame (as of July 2026)

Useful for a comparison section, or just for knowing what claims are actually
differentiated. Condensed from `market-research.md` plus the July 25 research refresh.

- **Live shared viewing of agent runs is table stakes.** Do not claim it as a feature.
- **Coarse cross-person control is shipping.** Factory markets "take over" verbatim;
  Warp grants edit access to viewers; Cursor lets teammates steer another user's cloud
  agent.
- **Nobody ships identity-clean, per-action approval handoff** — dropping into someone
  else's live session, under your own identity, solely to resolve a pending tool-permission
  gate, then leaving. **This is the unclaimed ground.**

| Product | Overlaps us on | Does *not* do |
|---|---|---|
| Superconductor | Closest positioning; "multiplayer workspace for your team and coding agents" | Live cross-person control transfer — sessions are shared as retrievable artifacts, not streams you join and steer |
| Zed | Parallel agents on multiplayer infra; follow mode | Follow mode is editor-scoped, not agent-session-scoped |
| GitHub Copilot agent sessions | Live session log, mid-run steering | Single-player — you steer *your own* agent |
| Cursor | Teammates can steer another user's cloud agent | Runs under the *creator's* credentials |
| Replit / Claude Tag / Dust et al. | Multiplayer chat, shared workspaces | Chat-level or async, not agent-run-level |

**Be honest in the page's own architecture notes:** the primitive is a feature, not a moat.
Defensibility comes from the whole shape — isolation-plus-awareness plus the co-op social
model — not from the handoff alone. Disclosing this reads as maturity to the HN audience.

---

## 5. Feature inventory — what is actually built

Everything below is **merged to `main` and verified** unless flagged. Baselines at time of
writing: 305 server tests, 160 client tests, clean typecheck and build.

**Do not put anything on the page that isn't in this table.** If the page needs a feature
that's only designed, label it as roadmap explicitly.

### The core loop

| Feature | What it does | Page-worthy? |
|---|---|---|
| **Shared live agent sessions** | Everyone on a project joins the same stream — prompts, tool calls, tool output, errors — in real time, not a replay. Event-sourced, so late joiners replay the full log. | Supporting (table stakes) |
| **One driver, take-the-wheel handoff** | Only one person prompts the agent at a time. Anyone can take the wheel instantly — no request/grant negotiation. The turn keeps streaming; nothing restarts. | **Hero** |
| **Multiplayer approval gate** | Privileged tool calls (`Bash`, subagents, web tools) pause and surface a `🔐` block to the whole session. Any driver-eligible participant can approve or deny — with `a`/`d` keyboard shortcuts. Decisions are attributed on the wire. | **Hero** |
| **Pull notifications** | A gate in another session left unanswered past *your* threshold lights that session's row amber and shows `🔐 PULLS ▸ N` in the header. Off by default; per-recipient delay (OFF / 30s / 1m / 2m / 5m). This is the "notice" half of notice → drop in → act. | **Hero** |
| **Verified identity (GitHub OAuth)** | Sign in with GitHub; an allowlist of usernames is the entire access-control system. The wire `userId` *is* the GitHub login, so approvals, take-the-wheel and arcade records all carry verified identity. | **Hero** (this is what makes the identity claim true) |

### Awareness

| Feature | What it does |
|---|---|
| **Agent-declared intent** | The agent narrates itself via a `set_intent` tool — a one-line "what I'm doing right now" that renders as a pinned `✦ QUEST` objective and a struck-through history in the quest log. |
| **`<teammates>` digest** | Each agent receives a *digest* (never another session's transcript) of what sibling sessions are doing, so it shapes its own plan around in-flight work without being told. |
| **PARTY pane** | Always-visible right pane: every session in the project, its participants, who's driving, its current quest line, last activity. Click to jump in. |
| **Oversight agent** | Opt-in, server-side, one per project. Reads structured digests only (never transcript prose) and maintains a short prose summary of what the whole team is doing. A driver can explicitly **pull** it into their own agent's context — attributed on the wire. Off by default. |

### Agent harness

| Feature | What it does |
|---|---|
| **Full Claude Code tool set** | Bash, subagents, web tools, task tools, project skills — governed by the approval gate. |
| **Per-session model choice** | Driver picks opus / sonnet / haiku from the header; switches apply between turns and log a visible `model_change`. |
| **Permission modes** | Driver cycles DEFAULT → AUTO → PLAN (`M`). AUTO is relay-enforced server-side so every gate still hits the wire — no silent bypass, honest transcript. |
| **Plan gate** | Plans surface as a driver-gated card: approve, or request revision. |
| **Skills + slash commands** | `/`-menu over the live roster (~71 entries) with substring matching and keyboard selection. Passenger suggests, driver runs. |
| **Plugin import** | Anyone in the project registers a plugin by **https git URL**; the server shallow-clones it, validates it's a real plugin, and every new session in the project gets its skills. Project-scoped, attributed on the wire. |
| **Skills & Workflows screens** | `SKILL SUITE` = union of every party session's roster, tagged by session. `WORKFLOWS` = live tree of subagents/background tasks with per-task tokens, tool uses, elapsed, last tool, and a driver-gated **STOP**. Header shows `WORKFLOWS ▸ N` while tasks run. |

### Session management

| Feature | What it does |
|---|---|
| **`mpai` CLI** | One command in any git repo starts the whole stack on one port (server serves the built client). |
| **Auto-provisioned worktrees** | Every session's agent gets its own git worktree off the launched repo — the containment model, not an option. |
| **In-app session creation** | Name + base branch, from the browser. No terminal required. |
| **Invite system** | Mint a link that is *just a token* — no project or session id in the URL, so it can't be edited to point elsewhere. The recipient sees **"ANA INVITED YOU"**, the room, an expiry countdown and seats left, before committing. Seats, TTL and revoke are all live. Off by default (`REQUIRE_INVITE=1`). |

### The co-op layer (do not cut this — see §7)

| Feature | What it does |
|---|---|
| **Lobby / SELECT YOUR PLAYER** | Pick name, sprite glyph and identity color before entering. `?name=` skips it. |
| **Arcade** | Four real playable engines — DINO RUN · SNAKE · TETRIS · DOODLE JUMP — rendered as pure text in the thinking strip while the agent works, or anytime via `A`. Party-wide high scores per game, project-scoped, on the append-only wire. |
| **HUD** | TURN / CONTEXT / TOOLS USED / PARTY XP tiles. **Note:** only client-derivable numbers are live (turn count, tool count, gated count). CONTEXT and PARTY XP render `—`. Don't screenshot a HUD in a way that implies those are real. |
| **Keyboard-first everything** | Single-letter screen hotkeys (S/W/O/I/A/M), `a`/`d` on gates, `esc` to interrupt, full arrow-key navigation of the whole shell when the prompt is empty. |

### Not built — roadmap only

Label clearly if mentioned at all:

- **v6b file-collision detection** — surfacing "two agents are about to touch the same
  files" as a human-facing interrupt. Decisions banked, **no spec yet.** This is the
  highest-leverage open gap in the product.
- **Bring-your-own API key per session** (A2b) — designed, blocked on a spike.
- **Persistence, reconnect, multi-tenancy, OS-level sandboxing, audit, rate limiting** —
  the "Reading B" roadmap. All explicitly out of scope today.
- **Deployment** — see §10. **The product is not yet running on a public box.**

---

## 6. Screenshot inventory

All paths are repo-relative. **Read the caveat in §6.3 before shipping any of these.**

### 6.1 The strong ones — `docs/acceptance/v5c/`

Captured 2026-07-25 against the v5c restyle. These are the current visual identity.

| File | What's actually in it | Use for |
|---|---|---|
| `v5c-accept-3-permission.png` | **The money shot.** Amber `🔐 PERMISSION CHECK · WAITING` block mid-transcript: "the agent wants to use **Bash** — not on the auto-approve list", the command `touch hello.txt` in a code box, `[A]PPROVE` (green) / `[D]ENY` (red) bracket-buttons. Party pane shows `ana 🛞 DRIVING · you` and `ben · watching`. Status line reads `🔐 1 gate pending`. Thinking strip below with DINO RUN lane and `HAIKU 4.5 IS THINKING… 19S`. | **Hero image.** The whole pitch in one frame — but see the arcade-roster trap in §6.3; the cartridge bar in this frame is out of date. |
| `v5c-accept-2-shell.png` | The take-the-wheel flourish: dashed-rule sweep + `!! ANA HAS TAKEN THE WHEEL !!` and the subtitle *"the turn keeps streaming — nothing restarts"*. | Handoff / "nothing restarts" section |
| `v5c-accept-8-questlog.png` | Full shell, widest view. Header (`multiplayer_ai › demo › session v5c-accept-1 · AGENT haiku 4.5 · PLAN · ONLINE`), HUD tiles, pinned `✦ QUEST` line, dense transcript of task tools, PARTY pane with two members, QUEST LOG pane with completed/struck items. | Product overview / "what it looks like" |
| `v5c-accept-1-lobby.png` | `SELECT YOUR PLAYER` — name field, 7 sprite glyphs, 6 identity colors, `▸ PRESS START`, and an "ALREADY IN THE PROJECT" panel. | Co-op framing / identity section |
| `v5c-accept-9-skills.png` | `SKILLS & WORKFLOWS` screen: SKILL SUITE list, a skill's detail with which sessions carry it, SUB-QUESTS panel, and the COMMAND PALETTE showing `/auth-migration-guide` with `passenger / suggests · driver / runs`. | Skills / harness section |
| `v5c-accept-6-plancard.png` | Driver-gated plan card: the agent's scope summary (lines added, files modified, breaking changes) with green `APPROVE` / red `REQUEST REVISION` buttons, gold left-rail. Header shows `PLAN` mode lit. | Plan gate — genuinely good frame |
| `v5c-accept-4-slashmenu.png` | The `/` command menu open over the roster. | Skills / keyboard-first |
| `v5c-accept-5-spellcast.png` | Skill invocation rendering in the transcript. | Skills |
| `v5c-accept-7-narrow.png` | Sub-900px layout. **Has visible layout overlap** — the status line and a collapsed permission block render on top of the transcript's bottom edge. | **Internal only.** Do not ship; it shows a rendering bug. |
| `v5c-accept-10-status.png` | The `?screen=status` design-only palette/glyph reference sheet. | **Internal only.** Not a product screen — never present it as one. |

### 6.2 Other images in the repo

- `tour-skill-suggest.png` (repo root, 2026-07-25) — skill suggest flow. Usable.
- `v4-*.png` (repo root) — the **v4** shell, lobby, party/wheel, permission card and
  thinking game. **Superseded by v5c.** Do not mix with v5c shots; the two skins look
  different and mixing them reads as an inconsistent product.
- `step1-*` … `step4-*.png` (repo root) — the original **v1/v3 plain dark web app** with
  chat bubbles. **Do not use.** This is the look the product deliberately abandoned.
- `.playwright-mcp/*.png` — before/after pairs from a design pass. Internal.

### 6.3 The honest caveat — read this

**The v5c screenshots predate roughly a third of the shipped product.** Captured
2026-07-25; merged since then: the invite system, the oversight agent, the Workflows
screen, Tetris + Doodle Jump, arrow navigation, **GitHub OAuth / sign-in**, and **pull
notifications**.

Consequences for the page:

- There is **no screenshot of a signed-in, identity-verified session** — and identity is a
  headline claim. The party roster in every existing shot shows lobby-chosen names
  (`ana`, `ben`), not GitHub logins.
- There is **no screenshot of a pull notification** (`🔐 PULLS ▸ N` in the header, amber
  OTHER PARTIES row) — the feature that makes the hero moment self-explanatory.
- There is **no screenshot of the invite landing screen** (`ANA INVITED YOU`), which is the
  best-looking social artifact in the product.
- The Workflows screen is unshot.
- **A concrete trap: every existing screenshot shows the wrong arcade roster.** The
  cartridge bar reads `DINO RUN · SNAKE · BREAKOUT · TYPE RACE`, and
  `v5c-accept-7-narrow.png` even shows *"cartridge not inserted — snake has no engine yet"*.
  Since then Type Race was replaced by **Tetris**, the empty Breakout slot was filled with
  **Doodle Jump**, and Snake shipped. Shipping any of these frames advertises an empty slot
  and a game that no longer exists.

**Recommendation: capture a fresh screenshot set before building the page.** The five
frames actually worth capturing:

1. A gate pending in a session with **GitHub-verified names** in the party roster.
2. The **pull notification** state — header badge + amber row in another session.
3. A `permission_decision` collapsed to `✅ approved by <githublogin>` — the identity claim,
   visible.
4. The **invite landing screen** with expiry countdown and seats left.
5. The **Workflows** screen with live subagent rows.

Until those exist, `v5c-accept-3-permission.png` carries the hero and the identity claim
is text-only. That's a real gap between what the page will assert and what it can show.

### 6.4 The asset the page actually needs most

Per the launch strategy, the centerpiece is a **60–90 second video**, not a static image:
one take, real product, no narration-over-slides. Ana's agent hits a `🔐` gate → Ana's away
→ Ben gets the pull, drops in, takes the wheel, approves *under his own name and glyph* →
hands back → the agent never stopped, and the wire shows who approved.

**The landing page should be built around a video slot in the hero.** Design it so the page
still works with a looping GIF/screenshot fallback if the video isn't ready.

---

## 7. Visual direction

The landing page should look like it was made by the same people who made the product.
The product's identity is strong and specific — **a 90s arcade-cabinet terminal** — and the
launch strategy explicitly calls that aesthetic *a distribution asset*: instantly
recognizable in a feed of identical dark-mode terminal demos. Lean in hard.

### 7.1 Real design tokens

Lifted verbatim from `poc/client/src/terminal.css`. Use these exact values so the page and
the screenshots sit in the same world.

```css
/* surface */
--bg:     #0b0d10;   /* app background */
--panel:  #0f1216;   /* panels lift one step off bg */
--input:  #14171d;
--frame:  #3d4655;   /* decorative rule — deliberately quiet */
--room:   #07080a;   /* the "room around the cabinet" (body bg) */

/* text */
--fg:     #d8dee6;   /* 14.37:1 */
--dim:    #828c9b;   /*  5.72:1 */

/* semantic — all clear AA on --bg */
--gold:   #d9b86b;   /* system / awareness / quest */
--red:    #e0685f;   /* errors */
--amber:  #e0a458;   /* PERMISSION GATE — the product's signature color */
--green:  #7fbf7f;   /* affirmative / driving */
--accent: #d97757;   /* "you can act here" ONLY */
```

Two washes worth reusing: `--amber-wash: rgba(224,164,88,0.07)` and
`--gold-wash: rgba(217,184,107,0.08)`.

**Shadows are solid rectangles, never blurred:** `--chunk: 4px 4px 0 #0b0d10`. Panels get
chunky 2px frames with a hard offset shadow — NES boxes, not Material cards. No blur
anywhere on the page either.

### 7.2 Type — the split is a rule, not a preference

- **Pixel face** — `"Press Start 2P", "Silkscreen", monospace` — **chrome only.** Labels,
  headings, scores, tab names. 8–11px, caps, tracked (`letter-spacing: 0.06em`). *Never
  carries information that isn't also in the mono layer.*
- **Mono** — `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` —
  **every piece of real content.** 13px / 20px line height.
- **No proportional type anywhere.** This is the single strongest identity decision.

*Implementation note:* the app loads these from Google Fonts
(`poc/client/index.html:9-12`). A landing page can do the same, but self-host if the page
has a performance budget — `Press Start 2P` is tiny and `JetBrains Mono` can be subset.

### 7.3 Spacing and shape

4px grid: `4 / 8 / 12 / 16 / 24`. Box-drawing characters for frames and dividers
(`╭ ─ ╮ │ ╰ ╯ ├ ┬ ┴`). Dashed rules as section separators — the product uses them
constantly and they photograph well.

### 7.4 Glyph vocabulary

These are the product's iconography. **Use them instead of generic icons.** Consistency
here is most of what makes the page feel authentic.

| Glyph | Means |
|---|---|
| `⏺` | tool call |
| `⎿` | tool result |
| `>` / `▸` | user prompt |
| `✦` | intent / objective / quest |
| `🛞` | driver — whoever currently has control |
| `🔐` | permission gate |
| `■ ▲ ● ✦ ◆ ♠ ★` | player sprites (identity glyphs from the lobby) |

### 7.5 Motion

The product allows itself **exactly two** animations: the take-the-wheel dashed-rule sweep,
and the thinking-strip fade-out. A landing page can be a little more generous, but the
restraint is part of the brand. CRT scanline/flicker is an established product texture
(`Crt.tsx`) and is fair game for the hero. **Anything that reads as "motion design" is
off-brand.**

### 7.6 Dark only

No light theme, in the product or on the page. Don't build one.

### 7.7 Why the game layer is not decoration

The obvious objection to ambient visibility is **surveillance**: *"my lead can watch my
agent."* The PARTY roster, sprites, identity colors and quest lines are what make
visibility read as **co-op rather than monitoring**. That framing is the answer to the
product's biggest adoption risk.

**Do not let a designer sand this off in the name of looking "enterprise."** The arcade
games themselves are genuinely disposable; the social framing is load-bearing. If the page
has room for exactly one "fun" element, make it the party/identity layer, not a game.

---

## 8. Suggested page structure

A recommendation, not a mandate. Each section lists what it must *prove*.

1. **Hero.** The moment, stated as the message in §1. Video (or
   `v5c-accept-3-permission.png` as fallback). One-line subhead naming the category:
   *approval handoff for AI coding agents.* Primary CTA → waitlist.
   *Proves: there is a specific, recognizable problem and this solves it.*

2. **The moment, unpacked — 3 beats.** notice → drop in → act. Three frames:
   pull notification lights up → you join and take the wheel → `✅ approved by <you>`,
   agent never stopped. *Proves: the loop is short and real.*
   ⚠️ Needs the fresh screenshots from §6.3.

3. **Why this isn't "watch your agents."** The contrast: everyone shows you the run;
   nobody lets a *different person* resolve a pending action *as themselves*. Mechanism,
   not marketing. *Proves: differentiation.*

4. **Awareness, not shared context.** Sessions are isolated worktrees; agents get a
   digest, never each other's transcripts. Show the PARTY pane and a `✦ QUEST` line.
   *Proves: the architecture is a deliberate position, not a limitation.*

5. **The harness is real.** Full Claude Code tool set, permission modes, plan gate, skills
   + plugin import, workflows/subagent tree, per-session model choice, `mpai` CLI.
   Screenshot: `v5c-accept-9-skills.png` or `v5c-accept-8-questlog.png`.
   *Proves: this is a working tool, not a demo of one idea.*

6. **Identity and access.** Sign in with GitHub. Allowlist. Invite links that are just
   tokens. *Every decision on the wire carries the name of the human who made it.*
   *Proves: the identity claim, which is the thing competitors get wrong.*

7. **Honest limitations.** Short, direct, linked to the research. Trusted-team security
   model; the Bash-allowlist two-hop escape; no OS-level sandboxing yet; no persistence or
   reconnect. **This section is an asset, not a liability** — the launch plan puts the
   known-risks section into the Show HN post verbatim because disclosed limitations read
   as maturity. *Proves: these people are trustworthy.*

8. **Waitlist.** See §9.

9. **Footer.** Repo link, research report, the specs. The spec → plan → TDD artifacts are
   credibility ammo for the technical reader.

---

## 9. The waitlist

### What it's actually for

Per the launch strategy, the signup is **gated and low-throughput by design**: it feeds
**hosted 30-minute sessions** where the founder drives, same setup as the friends beta.
Bookings are capped at what one person can host. Scarcity is acceptable — this is not a
self-serve product yet.

**Design the form to serve that**, not a generic "get notified" flow.

### Fields

The strategy spec names three. Keep it to these:

- **Email** (required)
- **Team size**
- **Current agent tooling** — free text or a short multi-select (Claude Code / Cursor /
  Copilot / Amp / Warp / other). This is genuinely useful qualification data *and* competitive
  intel.

Everything else is friction. Do not ask for a company name or a job title.

### Two paths after submit

This is the part a generic waitlist gets wrong. There are **two** outcomes:

1. **Bookers** → a calendar link for a hosted 30-min session. This is the real conversion.
2. **Non-bookers** → the video plus **local-run instructions (BYO Anthropic key)**. The
   repo is public; someone can run `mpai` in their own repo today. Don't dead-end them on
   a "we'll be in touch."

The confirmation state should offer both, in that order.

### Copy direction

Honest about stage. The product is a working PoC that is **not yet deployed publicly**
(§10) — a waitlist that implies a live hosted service would be a lie the first booked user
discovers. Something in the spirit of:

> *We're running hosted sessions with small teams, a few at a time. Or skip the line —
> clone the repo, bring your own key, and run it yourself.*

### Technical constraints

- Waitlist storage is **not built.** There is no database in this project and no email
  infrastructure. Options, cheapest first: a form service (Tally / Formspark / Buttondown),
  a serverless function writing to a hosted sheet or KV, or a small endpoint on the same
  Node server once it's deployed. **This is an unresolved decision — see §11.**
- If the page collects email addresses, the standard privacy floor applies: state what the
  data is used for, don't collect what you won't use, use TLS, and don't log the addresses
  anywhere they'll leak.
- **Do not put the waitlist behind the GitHub OAuth allowlist.** The allowlist is the
  product's access control; the waitlist is how people ask to be added to it.

---

## 10. Honesty constraints — do not overclaim

The page must not assert any of the following, because none are true today:

| Don't say | Reality |
|---|---|
| "Sign up and start using it" | Not deployed. No public URL. The A1b deployment work is the last item on the roadmap and is blocked on hardware and one known code fix. |
| "Secure multi-tenant" / "enterprise ready" | The security model **explicitly assumes a trusted team.** There is no OS-level sandboxing, no multi-tenancy, no audit log, no rate limiting. |
| "Sandboxed agents" | Agents run in git worktrees, which is containment, not a sandbox. There is a documented two-hop escape: an allowlisted command (`npm test`, `npx tsc`, read-only `git`) can be steered by a config file the agent authored in its own worktree. Documented openly in `market-research.md`. |
| "Never loses your session" | State is **in memory.** No persistence across restarts, no reconnect UX. |
| "Works on mobile" | Desktop-first with one breakpoint (PARTY pane collapses under ~900px). A full mobile layout is an explicit non-goal *for the app*. The **landing page itself should of course be fully responsive** — just don't screenshot the app on a phone. |
| "Any AI agent" / "any model" | Claude family only, via the Claude Agent SDK. Per-session choice is opus / sonnet / haiku. |
| Live metrics in the HUD | CONTEXT and PARTY XP render `—`. Only turn count, tool count and gated count are real. |

**The rule:** if a claim isn't backed by a row in §5, it doesn't go on the page.

---

## 11. Open questions for the human

Answer these before or during the build; none of them block starting.

1. **Product name.** The repo is `multiplayer_ai` and the UI wordmark is `MULTIPLAYER_AI`.
   Is that the launch name? It's descriptive and it matches YC's RFS language verbatim,
   which cuts both ways — instantly legible, but also the category name rather than a brand.
2. **Domain.** Not yet chosen (the deployment spec says "one domain," unspecified).
3. **Waitlist backend.** §9 — form service vs. serverless vs. the Node server. Cheapest
   real answer is a form service; the page can ship before deployment that way.
4. **Where does the page live?** Static site separate from `poc/`, or served by the same
   Node server? Separate is safer — the page shouldn't depend on the app being up.
5. **Is the video being made?** §6.4 — the page's shape depends on whether the hero has a
   video slot or a static image.
6. **Fresh screenshots** — §6.3. Worth ~30 minutes with the stack running and two browser
   profiles, and it materially upgrades the page.
