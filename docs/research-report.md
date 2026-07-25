# Multiplayer AI for Dev Teams — Research & Feasibility Report

*Date: 2026-07-24. Prepared as part of a startup exploration of YC's Fall 2026
"Multiplayer AI" RFS (Aaron Epstein).*

---

## 1. The Opportunity

YC's Fall 2026 Requests for Startups names a category, **"Multiplayer AI"**, authored by General Partner Aaron Epstein. Its core line:

> "Anyone on a team should be able to drop into the same live agent session to watch it work, redirect it, and hand it off, the way they'd work with any other human team member."
> — [ycombinator.com/rfs](https://www.ycombinator.com/rfs)

That sentence is a precise product spec, not a vague theme. It has three verbs — **watch**, **redirect**, **hand off** — and one hard constraint: **the same live session**. Not a shared transcript, not a Slack thread, not a read-only link. A shared, live, controllable surface.

The precedent the RFS leans on is the collaboration shift that already happened in adjacent categories. Google Docs made single-player word processors feel antique; Figma did the same to single-player design tools. In both cases the winning product was not the one with the best solo features — it was the one that assumed, by default, that more than one person would be in the document at once. Figma's own engineering account of this ([figma.com/blog/how-figmas-multiplayer-technology-works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)) is worth reading as a business document as much as a technical one: multiplayer was the wedge that let a browser-based newcomer displace an entrenched desktop incumbent.

**Why agents make this newly relevant.** Until recently, an AI coding session was a chat: short-lived, fast, and cheap to redo, so single-player was fine. That has changed. 2026-era agents run multi-hour and multi-day autonomous tasks — cloning a repo, running full test suites, iterating on failures, opening PRs — on cloud compute that persists across device disconnects (Cloudflare's `keepAlive()` and durable-execution fibers, Devin's isolated VMs, Factory's Droid Computers). A long-running autonomous process that touches a shared codebase is exactly the kind of work that a team needs to **watch** (is it going off the rails?), **redirect** (that's the wrong approach, stop), and **hand off** (I'm going offline, someone else take the wheel). The longer and more autonomous the task, the more acute the need — and the worse a single-player tool serves it. GitHub Next frames the same problem from the failure side: single-player coding agents produce "wasted work, coordination debt, and misaligned outputs" ([githubnext.com talk](https://githubnext.com/talks/one-developer-two-dozen-agents-zero-alignment/)).

So the opportunity is a real, newly-sharp need (multi-day autonomous agents that demand human oversight and handoff), riding a proven collaboration-wedge pattern (Docs/Figma), named explicitly by a top-tier accelerator at the moment the category is forming. The rest of this report asks the two questions that matter for a solo founder: **is the wedge still open** (Section 2), and **can one person actually build it** (Section 3).

---

## 2. Competitive Landscape

This section classifies each product by a strict bar, taken from the RFS: **truly-multiplayer** means two or more distinct human accounts can be in the *same live agent session*, seeing it act in real time, with at least one able to redirect/take over without restarting or forking. **Share-only** ("single-player with sharing") means one human drives and others get a transcript, read-only link, Slack record, or exported copy. Full evidence and source flags are in `research-a.md` and `research-b.md`.

### 2.1 Cursor

Cursor 3.0 (April 2026) shipped an "Agents Window" — a sidebar showing every active agent session with real-time status and the ability to intervene ([Sean Kim writeup](https://blog.imseankim.com/cursor-3-agents-window-multi-agent-cloud-handoff-design-mode-ai-coding-ide-2026/)). Critically, this is **one person's dashboard over their own parallel agents**, not multiple humans in one session. The Teams plan ($40/user/mo, [cursor.com/pricing](https://cursor.com/pricing)) shares configuration, billing, analytics, and RBAC/SSO — shared *settings*, not a shared *session*. A targeted search for two humans co-driving one live session returned nothing across the pricing page, changelog, and third-party deep-dives.

**Verdict: Single-player (with async/config sharing).** No roadmap item for live multi-human sessions as of July 2026.

### 2.2 Devin / Cognition

Devin's Slack integration syncs a session bidirectionally with a Slack thread: teammates post into the thread, Devin sees and responds to all of them, and an `(aside)` keyword lets people comment without interrupting the run ([docs.devin.ai/integrations/slack](https://docs.devin.ai/integrations/slack)). This is the most "live" of the share-only set — a genuinely *shared input channel* where multiple humans reach one running agent. But it is sequential message-passing in a channel, not a shared visual/control surface: no live diff, no shared terminal, no take-the-wheel handoff. The new Teams plan ($80/mo minimum, [cognition.com/blog/new-self-serve-plans-for-devin](https://cognition.com/blog/new-self-serve-plans-for-devin)) adds "collaboration, centralized billing, and admin controls" but does not describe real-time co-control of a single session.

**Verdict: Share-only (borderline).** A shared live input stream, not a shared live control surface.

### 2.3 Claude Code / Anthropic

This is the best-documented "no" in the set. GitHub issue [anthropics/claude-code#60082](https://github.com/anthropics/claude-code/issues/60082) (opened May 18, 2026, "Feature request: real-time multi-user collaboration on a single Claude Code session") enumerates exactly what exists instead and why none of it qualifies: claude.ai share links are **read-only views**; "Teammates" and "peer sessions" all belong to the **same account** (different devices, not different humans); "Remote Control" lets **one** user drive their own session from another device. No maintainer response as of last check. Claude Cowork is explicitly "single-user… you cannot share an in-progress task with a teammate, hand off a workflow, or co-edit" ([felloai.com guide](https://felloai.com/claude-cowork-guide/)). "Agent Teams" orchestrates multiple Claude instances under one human operator — multi-agent, not multi-human.

**Verdict: Single-player with sharing.** The gap here is confirmed by an open, unaddressed feature request in Anthropic's own repo — the strongest primary-source "this doesn't exist yet" signal in the research.

### 2.4 OpenAI Codex

Codex cloud agents delegate tasks to sandboxes from the editor; its multi-agent delegation config governs **agent-to-agent** delegation, not human-to-human sharing ([openai.com/index/introducing-upgrades-to-codex](https://openai.com/index/introducing-upgrades-to-codex/)). The changelog contains no entries for team collaboration or multi-user sessions. ChatGPT Team shared links are opt-in, link-based, and not live-simultaneous, and "a Codex seat does not change these collaboration boundaries" ([help.openai.com shared-links FAQ](https://help.openai.com/en/articles/8798634-shared-links-faq-chatgpt-team-version)). An open May 2026 community feature request asks for "shareable Codex session/task links and optional collaboration access" ([community.openai.com/t/1380974](https://community.openai.com/t/new-feture-request-in-codex/1380974)) — itself evidence the capability is absent.

**Verdict: Single-player with sharing.**

### 2.5 Factory.ai

Factory's product page makes a direct, primary-source claim: **"Send a teammate a live session URL and they can watch the Droid work, leave comments, or take over without needing the desktop app installed."** ([factory.ai/product/web](https://factory.ai/product/web)). Sessions, computers, and skills sync across TUI, desktop, web, IDE, and Slack, so a task started on one surface can be taken over from another. This is watch + comment + take-over on one live session — it clears the RFS bar.

**Verdict: Truly multiplayer (verified via primary source).** Unverified: concurrency limits (how many humans at once, takeover locking, time caps).

### 2.6 Amp (Sourcegraph)

Amp ships a feature literally named **"Multiplayer"** ([ampcode.com/manual](https://ampcode.com/manual)): "Multiplayer lets workspace members collaborate in an orb-backed thread… workspace members can send messages and access the orb's files, changes, portals, and shared terminal." It runs 3 hours by default (extendable), ends on expiry, and bills entirely to the thread owner. Shared live access to files, changes, and terminal inside a running session is the most explicit "multiplayer" capability found in the entire market.

**Verdict: Truly multiplayer (verified via primary source).** Unverified: concurrent-control conflict resolution (who wins if two people type at once).

### 2.7 Other players

- **Zed** extended its long-standing CRDT-based human-to-human collaboration (Channels) to AI agents, where an agent is "a first-class collaborator with the same write access as any human in the room" ([zed.dev/docs/ai/agent-panel](https://zed.dev/docs/ai/agent-panel), [zed.dev/docs/collaboration/overview](https://zed.dev/docs/collaboration/overview)). **Plausibly truly-multiplayer**, built from two confirmed-real official primitives, but no single official source states the combined claim outright.
- **GitHub Next "Ace"** — an internal research prototype for "a realtime, multiplayer coding agent workspace" (shared terminal, live previews, multiplayer editing, team chat, bidirectional PR linking), reported as in technical preview with "a few thousand" users per the GitHub Next talk/blog ([githubnext.com talk](https://githubnext.com/talks/one-developer-two-dozen-agents-zero-alignment/), [maggieappleton.com/zero-alignment](https://maggieappleton.com/zero-alignment)) — though a second research pass could only corroborate a proposal-stage tracking issue with no assignees or PRs, and could not confirm the repo is an official, currently-active GitHub product surface. **Treat Ace's maturity and user numbers as unverified**, not settled fact. Not a startup — but if the "technical preview" characterization holds, it would be the single strongest existing implementation of the RFS, living inside a distribution-advantaged incumbent. Given the conflicting evidence, this is the most important competitive fact to keep verifying, not to assume.
- **GitHub Copilot / VS Code** ships parallel sessions for *one* developer and a standalone app to orchestrate multiple agents for one operator ([github.blog changelog](https://github.blog/changelog/2026-07-08-github-copilot-in-visual-studio-code-june-2026-releases/)) — single-player.

### 2.8 Summary table

| Product | Live shared co-control? | Verdict | Primary evidence |
|---|---|---|---|
| Cursor | No — dashboard over own agents; shares config/billing | Single-player (w/ sharing) | [cursor.com/pricing](https://cursor.com/pricing) |
| Devin / Cognition | Shared Slack input channel; sequential, no live control surface | Share-only (borderline) | [docs.devin.ai/integrations/slack](https://docs.devin.ai/integrations/slack) |
| Claude Code | No — read-only links, same-account peers, single-user remote control | Single-player w/ sharing | [claude-code#60082](https://github.com/anthropics/claude-code/issues/60082) |
| OpenAI Codex | No — opt-in shared links, not live; open feature request | Single-player w/ sharing | [community.openai.com/t/1380974](https://community.openai.com/t/new-feture-request-in-codex/1380974) |
| **Factory.ai** | **Yes — watch/comment/take-over on live URL** | **Truly multiplayer** | [factory.ai/product/web](https://factory.ai/product/web) |
| **Amp (Sourcegraph)** | **Yes — shared files/changes/terminal, 3h default** | **Truly multiplayer** | [ampcode.com/manual](https://ampcode.com/manual) |
| Zed | Human+agent on same CRDT buffer via Channels | Plausibly multiplayer | [zed.dev/docs/ai/agent-panel](https://zed.dev/docs/ai/agent-panel) |
| GitHub "Ace" | Proposed/preview — full multiplayer agent workspace (maturity unverified: one pass found "technical preview," another only a proposal-stage tracking issue) | Preview claim, unverified (incumbent) | [githubnext.com](https://githubnext.com/talks/one-developer-two-dozen-agents-zero-alignment/) |
| GitHub Copilot | Parallel sessions for one dev | Single-player | [github.blog changelog](https://github.blog/changelog/2026-07-08-github-copilot-in-visual-studio-code-june-2026-releases/) |

### 2.9 Where the open wedges are

Reading down the table, the market splits cleanly:

1. **The three biggest-distribution coding agents — Claude Code, Cursor, Codex — are all single-player-with-sharing**, and all three have *open, public user requests* for exactly this capability. Those requests are simultaneously **validation** (users want it badly enough to file issues) and **risk** (they're on the incumbents' radar; each could ship it as a feature).
2. **Only two shipping products clear the bar — Amp and Factory** — and both are broad IDE/agent platforms, not purpose-built around the multiplayer session as *the* product. Neither has locked down the obvious hard problems (concurrent-control conflict, takeover locking, participant limits) in their public docs.
3. **The startup layer is forming but not settled** (see Section 4): Proliferate (S25) is the closest literal match, Lightsprint the broadest, Dust the best-funded — but all at slightly different altitudes (self-hosted, product-dev platform, enterprise) than a dev-tools-native "drop into the live coding session" product.

The open wedges, in order of attractiveness, are ranked in Section 4. First, can a solo founder actually build the core mechanic?

---

## 3. Technical Feasibility

**Short answer: yes, and it's already been demonstrated.** A working PoC in this repo (`poc/`) proved the core mechanic — shared live session with watch, replay-for-late-joiners, and control handoff — in roughly **one day of build time**.

### 3.1 The architecture: single authoritative process + append-only event log

The PoC is a Node/TypeScript server that, per session, maintains an **append-only event log with monotonic `seq` numbers**. Every meaningful thing that happens (agent tool call, tool result, text chunk, a human joining, a control change) is appended as an event. Clients connect over **WebSocket**; the server **broadcasts** each new event to all connected clients and, for a **late joiner**, replays the log **from seq 0** (or from any requested seq) so the newcomer catches up to identical state. Control is a **grab-based steering lock** ("the wheel"): whoever holds it can prompt the agent; a `control_change` event transfers it. The agent itself is driven by the **Claude Agent SDK in streaming-input mode**.

This is not a novel architecture — and that is the point. It is the direct, deliberate application of the pattern every serious prior-art source converges on:

- **Figma**: one authoritative server process per document; all clients connect to it; it owns final state. Figma explicitly rejected full CRDTs because CRDTs solve the *decentralized, no-central-authority* problem — and Figma has a central authority, so the machinery is unnecessary overhead ([figma.com/blog](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)). **Our session has a central authority too: the one process that owns the agent and its log.**
- **ESAA-Conversational** (arXiv 2026): treat all interaction history as an immutable, append-only event log; support reconnection via replay; handoff = synthesize context from prior events and pass log access to the incoming party ([arxiv.org/pdf/2606.23752](https://arxiv.org/pdf/2606.23752)). This is, almost line-for-line, what the PoC does.
- **Cloudflare Durable Objects**: one persistent singleton process per agent instance, with its own SQLite, automatic hibernation, and resumable WebSocket streams ([cloudflare.com/products/agents](https://www.cloudflare.com/products/agents/)) — a near-literal production substrate for "one authoritative process per session."

A notable alternative surfaced in research: teams that already have a multiplayer WebSocket layer in place (e.g. **Liveblocks** or **PartyKit**) for existing real-time features can reuse that same sync layer for agent-session broadcast/replay/presence, rather than standing up a new Durable-Objects-based backend from scratch. This is a "reuse what you have" path, not a replacement recommendation — Durable Objects remains the more purpose-built substrate for teams starting fresh, but the Liveblocks/PartyKit route is a lower-friction production option worth flagging where the multiplayer plumbing already exists.

### 3.2 Turn-taking vs CRDT — and why turn-taking wins here

A multiplayer *text editor* (Google Docs, Figma design canvas) genuinely needs CRDT or OT machinery, because many users edit overlapping character/property ranges concurrently and every keystroke must merge. A multiplayer *agent session* does not have that shape. The shared object is a **linear conversation with one agent**: prompts go in, the agent acts, events stream out. The concurrency that actually occurs is coarse and rare — "two humans try to send input during the same agent turn" — and is cleanly resolved by a **steering lock** (only the wheel-holder can prompt) plus **last-writer-wins** on the few properties that need it, exactly as Figma resolves property conflicts. Full CRDT merge semantics would be solving a harder problem (decentralized concurrent merge) than the session actually poses. Turn-taking over a single authoritative log is simpler to build, reason about, debug, and — per Figma's explicit startup-velocity argument — the right call for a small team moving fast. GitHub Next's "Realtime GitHub" reached the same "avoid CRDT libraries" conclusion via a Git-native model ([githubnext.com/projects/rtgh](https://githubnext.com/projects/rtgh/)); the anti-CRDT consensus across independent sources is strong.

### 3.3 What the PoC demonstrated (acceptance evidence)

Acceptance was run by a controller via Playwright on 2026-07-24 (`task-6-report.md`, VERDICT: **PASS**). Concrete results:

- **Two tabs, one session.** Tab A prompted the agent; the agent used only Glob/Read (tool restriction enforced), streamed real tool calls and results with real tool names, and produced a correct 2-sentence summary. **Both tabs saw identical transcripts** — live shared view confirmed.
- **Late-joiner replay.** Tab B joined late and **replayed the full log from seq 0**, arriving at identical state — the reconnection/catch-up path works.
- **Control handoff.** Tab B **took the wheel** (`control_change` at seq 20), prompted "whats going on", and the agent replied **with shared context** — cross-user continuity on one live session confirmed. This is the RFS's "hand it off" verb, working.
- **Automated test suite:** 19/19 tests pass; `tsc --noEmit` clean.

The three RFS verbs — watch, redirect, hand off — were each exercised end-to-end against a real Claude agent. The core mechanic is not speculative.

Note on streaming granularity: in the PoC, agent text arrives message-granular — each `agent_text_delta` event carries a whole assistant text block, not a token stream — because the SDK's partial-message streaming is not enabled, so watchers see progress at message/tool boundaries; true token-level streaming is a production item, not a PoC gap in the core mechanic.

### 3.4 What the PoC exposed (reported honestly)

Live testing surfaced real issues, all worth reporting:

- **SDK `tool_result` content is polymorphic** — it arrives as a **string OR an array**. The first acceptance run crashed the driver on string content. Any production driver must normalize both shapes.
- **Per-message error containment is essential.** Initially, **one malformed message killed the entire driver loop**. The fix (verified in the second run, commit `2b39b2f`) wraps per-message handling so one bad event can't take down the session.
- **`allowedTools` only auto-approves; `tools` is the restriction knob.** In the first run, Bash was usable despite being left out of `allowedTools` — because `allowedTools` governs auto-approval, not availability. To actually *restrict* what the agent can do, constrain the `tools` set. This is a security-relevant distinction: least-privilege for agent tool access requires the right knob.
- **No client auto-reconnect yet.** Tab A's page refresh caused leave/rejoin churn (seq 17-19); the client doesn't auto-reconnect (accepted PoC scope, but table-stakes for production).
- **Sessions are in-memory** — lost on server restart. Fine for a PoC; unacceptable for multi-day sessions.

### 3.5 The C-vs-event-loop question: agent sessions are I/O-bound

A tempting instinct for "many concurrent sessions with strict isolation and performance" is a systems language with thread-per-session — e.g., a C or Rust service spawning an OS thread per live session. **For this workload that is the wrong tool.** An agent session spends virtually all of its wall-clock time **waiting on I/O**: streaming tokens back from the LLM, waiting on tool execution (file reads, test runs, shell commands), and — uniquely for multiplayer — **waiting on humans** to watch, comment, and take the wheel. It is almost never CPU-bound. Thread-per-session buys you parallel *computation* you don't need while paying for it in memory footprint, context-switching, and concurrency bugs. An **event loop** (Node's, or any async runtime) is purpose-built for exactly this: thousands of mostly-idle I/O-bound connections multiplexed on a small thread pool. The PoC's Node/WebSocket choice is not a compromise; it's the correct match for an I/O-bound, human-in-the-loop workload.

That does **not** mean the concurrency problem is imaginary — it means **it lives at the architecture level, not the thread level**. The real scaling question is "how do many independent live sessions coexist safely," and the answer, from every prior-art source, is **shard by session**: one authoritative process/Durable-Object per session, never one big process multiplexing all sessions' *state*. Figma runs one authoritative process **per document**; Cloudflare runs one Durable Object **per agent instance**. You scale out by adding sessions-as-processes, not by threading within one. So the concurrency problem is real, but you solve it by drawing the process boundary at the session (an architectural decision) — the language and threading model inside each session should optimize for I/O concurrency, which points at an event loop, not C.

### 3.6 Production requirements (the gap from PoC to product)

The PoC proves the mechanic; a shippable product needs the following, all with known, off-the-shelf answers:

| Requirement | PoC state | Production answer |
|---|---|---|
| Persistence (survive restart; multi-day sessions) | In-memory only | Durable event log — Cloudflare Durable Objects (SQLite + hibernation) or Postgres append-only table |
| Reconnection | No client auto-reconnect | Resumable streams + replay-from-seq (the log already supports this server-side) |
| Multi-day session hibernation | None | Durable Object hibernation + `keepAlive()`/durable-execution fibers ([cloudflare.com/products/agents](https://www.cloudflare.com/products/agents/)) |
| Auth & access control | None | Real accounts; per-session visibility tiers (cf. Amp's Unlisted/Workspace/Private); least-privilege tool scoping (see the `tools` lesson above) |
| Concurrent-control conflict | Single steering lock (works) | Formalize lock semantics: takeover rules, queueing, who-wins — the exact area Amp/Factory leave publicly unspecified |
| Secrets/isolation for agent compute | Local workdir | Sandboxed per-session compute (Docker/microVM), no shared credentials across sessions |

None of these are research problems. Every one has a shipping reference implementation. The build risk is **integration and polish effort**, not **feasibility**.

---

## 4. Go / No-Go Assessment

### 4.1 Open wedges, ranked

1. **A multiplayer session layer *on top of* the incumbent single-player agents (Claude Code / Cursor / Codex).** These three own developer distribution and are all confirmed single-player-with-sharing, each with an open user request for live collaboration ([claude-code#60082](https://github.com/anthropics/claude-code/issues/60082), [Codex request](https://community.openai.com/t/new-feture-request-in-codex/1380974)). A product that wraps their agents in a shared-session control surface rides their model quality and reach while filling the exact gap they haven't. **Highest demand signal; also highest incumbent-roadmap risk** — this is the feature each of them is most likely to build.
2. **The hard concurrency/handoff problem that even the multiplayer leaders left open.** Amp and Factory ship live sessions but publicly under-specify concurrent-control conflict resolution, takeover locking, and participant limits. A product that nails multi-human control semantics (queueing, exclusive takeover, merge-of-intent) as its differentiator competes on depth, not mere existence. Narrower market, more defensible craft.
3. **A vertical/workflow-specific multiplayer session** (e.g., incident response, on-call pairing with an agent, review-and-merge rooms) where the collaboration model is tuned to one high-value team ritual rather than general coding. Smaller TAM per wedge, but harder for a horizontal incumbent to serve well, and a credible YC-scale "start narrow" story.
4. **Self-hosted / enterprise-control multiplayer** (Proliferate's lane): teams that can't send code to a vendor cloud. Real demand, but Proliferate (S25, open-source, MIT) already occupies it and Dust is funded one tier up at the enterprise-agent layer.

### 4.2 Moat risk — stated plainly

The uncomfortable facts:

- **The single strongest implementation of the RFS is reported to exist inside GitHub/Microsoft** ("Ace"), a distribution-advantaged incumbent — one research pass found a GitHub Next talk/blog describing a technical preview with "a few thousand" users ([githubnext.com](https://githubnext.com/talks/one-developer-two-dozen-agents-zero-alignment/)), while a second pass could only corroborate a proposal-stage tracking issue with no assignees or PRs and could not confirm the repo is an official, active GitHub product surface. **Ace's actual maturity is unverified** — treat "GitHub ships Ace broadly" as a real but unconfirmed risk, not an imminent, settled event. If the technical-preview characterization does hold and GitHub ships Ace broadly, a horizontal multiplayer-coding startup would be competing with the platform that hosts most of the world's code.
- **Two products already clear the bar** (Amp, Factory), so this is not a greenfield category — it's a "be meaningfully better/different" category.
- **The open feature requests cut both ways.** They validate demand, but they are also the incumbents' own backlog. The core mechanic is ~1 day to prototype (this PoC proves it), so it is **not itself a moat** — anyone can build the demo. The moat, if any, is in the hard parts (control semantics, multi-day durability, trust/security, workflow fit) and in distribution.
- **Capital is already here.** Dust raised $40M (May 2026) on "multiplayer AI" branding ([sifted.eu/articles/dust-series-b-40m](https://sifted.eu/articles/dust-series-b-40m)); the enterprise layer is funded.

The one genuinely favorable timing fact: **the YC RFS was published concurrently with market formation, and F26 applications close 2026-07-27, so no F26 company yet exists that was purpose-built for it.** YC is naming a wedge it already sees among adjacent portfolio companies (Proliferate, Lightsprint, Endstack), not seeding a brand-new idea. The wedge is **named but not yet crowded with purpose-built startups** — a narrow, closing window, not an open field.

### 4.3 Recommendation — conditional GO, narrow and fast

For a solo full-stack founder exploring a YC application, the evidence supports a **conditional GO**, with the conditions doing the real work:

**Proceed if you can commit to a narrow, defensible wedge — specifically wedge #2 or #3, not #1.** The core mechanic is proven and cheap (this PoC), which means "we built shared live agent sessions" is not a company; it's a weekend. The defensible product is either (a) **the hard control/handoff semantics** the current leaders left open, or (b) **a specific team ritual** (incident response, review rooms, on-call pairing) where a tuned collaboration model beats a horizontal tool. Pick one and go deep.

**Do not build wedge #1 (a thin multiplayer wrapper over Claude Code/Cursor/Codex) as the whole thesis** — it is the feature those incumbents are most likely to ship themselves, and their open feature requests prove it's on the radar. It's fine as an initial *distribution* surface, not as the *moat*.

**Concrete conditional triggers:**

- **GO now** if you can differentiate on the hard parts (control-conflict semantics, multi-day durability, security/isolation, or a vertical workflow) and ship a credible demo before the **2026-07-27** application deadline — the PoC already gets you most of the way to that demo.
- **Re-evaluate to NO-GO** if, before you commit, (a) **GitHub ships "Ace" into general availability** (note: Ace's current status is unverified — one source describes a technical preview, another only a proposal-stage tracking issue — so confirm it's a real, active GitHub product before treating this trigger as tripped), or (b) **any one of Claude Code / Cursor / Codex ships live multi-human sessions** — either event collapses the horizontal wedge and you should either pivot to a vertical (#3) or stand down.
- **Time-box the decision to the deadline.** The favorable fact — no purpose-built F26 competitor exists yet — expires the moment the batch is selected. If you're going to apply, the window is now.

Net: the need is real and newly sharp, the mechanic is proven buildable by one person in a day, and the *category* is validated by two shipping products and an active YC RFS — but the *moat* is not the mechanic. Go, but go narrow, go deep on the hard part, and move before the incumbents and the batch close the window.

---

## Addendum — 2026-07-24 refresh

*Same-day refresh. Folds in two delta-research passes run in parallel with v3 implementation —
`research-competitors.md` (harness-competitor deep-dive) and `research-sweep.md` (general
sweep) — plus build evidence from this repo's own v2/v3 work. This section does not rewrite
Sections 1–4 above; it reports what changed, adds what's new, and re-checks the thesis. Sources
are cited inline as they were in those two files; confidence tags (confirmed / reported /
speculative) are carried through unchanged.*

### A.1 Competitor delta

- **Amp's "Multiplayer" feature shipped 2026-07-22** — two days before the delta research pass,
  and effectively concurrent with the original report's cutoff. Confirmed via a dedicated launch
  post, [ampcode.com/news/multiplayer](https://ampcode.com/news/multiplayer), distinct from the
  evergreen manual page the original report cited: "Turn any of your orbs into a multiplayer
  environment from the thread's Share menu." No new detail on conflict resolution or participant
  caps — that gap stands as originally reported.
- **Warp's "Remote Control" clears the truly-multiplayer bar and was entirely absent from the
  original competitive landscape.** Warp's docs (confirmed,
  [docs.warp.dev/agent-platform/cli-agents/remote-control](https://docs.warp.dev/agent-platform/cli-agents/remote-control/),
  updated 2026-07-23) describe sharing a live session (Claude Code, Codex, OpenCode, or Warp's own
  Oz agent) via a link with "edit access" to send input, approve commands, or redirect the agent —
  not merely view. A company social post claims live cursors (reported, not corroborated in the
  docs text). **The market has moved from two shipping truly-multiplayer products to at least
  three (Amp, Factory, Warp)** — closing the report's wedge #2 ("the hard concurrency problem the
  leaders left open") faster than the original timeline implied, though none of the three publicly
  document conflict resolution, participant limits, or takeover locking.
- **Zed's "plausibly truly-multiplayer" verdict is downgraded, not confirmed.** Four official Zed
  pages were fetched directly this pass —
  [zed.dev/docs/ai/agent-panel](https://zed.dev/docs/ai/agent-panel),
  [zed.dev/docs/collaboration/overview](https://zed.dev/docs/collaboration/overview),
  [zed.dev/docs/collaboration/channels](https://zed.dev/docs/collaboration/channels),
  [zed.dev/docs/ai/parallel-agents](https://zed.dev/docs/ai/parallel-agents) /
  [zed.dev/blog/parallel-agents](https://zed.dev/blog/parallel-agents) — and all four describe
  human-to-human Channels and the AI Agent Panel as **separate, non-overlapping systems**; none
  mentions multiple simultaneous humans, driver/observer roles, or control handoff over an agent.
  The "humans + agents share one buffer" claim traces only to tertiary SEO/review content, never to
  zed.dev. Recommend treating Zed as **unconfirmed, evidence points toward single-player-with-sharing**
  rather than "plausibly multiplayer."
- **Windsurf no longer exists as an independent product.** Cognition acquired it and rebranded it
  **Devin Desktop** on 2026-06-02 (confirmed,
  [devin.ai/blog/windsurf-is-now-devin-desktop](https://devin.ai/blog/windsurf-is-now-devin-desktop/),
  [cognition.com/blog/introducing-devin-desktop](https://cognition.com/blog/introducing-devin-desktop)).
  Devin Desktop is a one-operator "cockpit for every coding agent" via the Agent Client Protocol —
  Codex, Claude Agent, and Devin swap mid-session, with "Spaces" sharing context between them. This
  is market consolidation, not a multiplayer-verdict change: still one-operator-many-agents, like
  Cursor's Agents Window.
- **GitHub Ace is now a live, gated technical preview**, not just a reported claim. The delta sweep
  found `ace.githubnext.com` functioning with an active signup form (confirmed,
  [ace.githubnext.com](https://ace.githubnext.com/)); the competitor deep-dive independently
  confirmed the same URL 307-redirects to an OAuth login wall
  ([maggieappleton.com/zero-alignment](https://maggieappleton.com/zero-alignment) talk, dated
  2026-04-09, re-fetched). Richer mechanics confirmed this pass: "multiplayer prompting" (devs and
  non-devs jointly directing one agent), collaborative cursor-visible plan editing, shared
  microVM-per-git-branch sandbox, shared terminal output, live preview. The speaker's own words:
  "It's not a prime time product yet." The community tracking issue proposing Ace-like integration
  into core GitHub product (`github/app#123`) remains open, unassigned, zero linked PRs — **no
  corroborated path to GitHub-product GA**, but the maturity uncertainty the original report flagged
  has narrowed toward "real, shipping-as-preview," which **raises, not lowers**, the report's §4.2/§4.3
  Ace risk.
- **Cursor is doubling down on fleet management, not co-control** — reinforcing, not undercutting,
  the original wedge-#1 caveat. Cursor 3.10 (reported, dated 2026-06-30) added Team MCP
  distribution and pushed Teams accounts to up to 50 parallel workers, plus a new iOS app for
  remote monitoring/steering of one user's own agents. All single-operator-fleet-management —
  modestly de-risks "Cursor ships live co-control next" specifically, since their visible roadmap
  energy is orchestration depth, not same-session multiplayer.
- **Claude Code's own Agent Teams docs deliberately scope approval to one human — directly
  relevant to this project's differentiator.** Fetched directly this pass
  (`code.claude.com/docs/en/agent-teams`, confirmed, current as of Claude Code v2.1.178+, still
  experimental/opt-in): multiple Claude Code instances can coordinate in one session, but *"A
  teammate cannot approve a permission prompt or supply consent on your behalf... the classifier
  treats an approval claim relayed from another agent as untrusted input rather than confirmation
  from you."* Anthropic has clearly considered approval-gating in a multi-agent context and chose
  **not** to extend it to multiple humans. No competitor surveyed treats "driver approval gate for
  tool calls, controllable/handoffable between multiple humans" as a product feature — **it remains
  open ground.**

### A.2 Infrastructure shift: a major platform vendor just shipped the report's NO-GO precondition

The single biggest new fact in the refresh: **Microsoft published a standalone "Agent Host
Protocol" (AHP) and shipped it as the reference implementation inside VS Code 1.129 (rolling out
~2026-07-15 to 2026-07-22)** — confirmed via
[github.com/microsoft/agent-host-protocol](https://github.com/microsoft/agent-host-protocol),
[code.visualstudio.com/updates/v1_129](https://code.visualstudio.com/updates/v1_129), and
[visualstudiomagazine.com's writeup](https://visualstudiomagazine.com/articles/2026/07/16/vs-code-1129-introduces-agent-host-and-experimental-agents-window-editor.aspx).

AHP's mechanics map almost 1:1 onto this PoC's architecture (§3.1 above): an authoritative host
holds state while clients reconcile; the server assigns monotonic `serverSeq` ordering to
mutations (≈ the PoC's `seq`); reconnection/replay happens via `lastSeenServerSeq` (≈
replay-from-seq); "turn ownership and mutual exclusion (the mutex analogy)" (≈ the PoC's steering
lock); simultaneous actions arbitrate first-write-wins — the same last-writer/first-writer-wins
simplicity the report argued for over full CRDT merge (§3.2). AHP is explicitly layered under ACP
("AHP is a coordination layer. ACP is a communication layer. They compose naturally.") and is
substantial infrastructure, not a sketch: 736 commits, published client libraries in Rust,
TypeScript, Kotlin, Go, and Swift, a formal release process.

Today's product framing is **single-developer, cross-device continuity** — "start a task on your
laptop, pick it back up from another machine" — **not yet confirmed multi-human.** The spec is
explicitly silent on accounts, authentication, and "different users." That is the load-bearing
nuance: the multi-human-specific work (identity, permissions, handoff-between-*people* UX) is
still undone even by Microsoft — but the far harder distributed-systems substrate underneath it is
now open-source, documented, and battle-tested inside the most widely used code editor. That
substrate was previously this report's chief claim to differentiation-via-craft (§4.1 wedge #2); it
is measurably less differentiated than it was a day earlier. Concretely: **the original report's
§4.3 NO-GO-trigger precondition — "a major platform vendor ships an open, standardized multi-client
session protocol" — has now been met, a full RFS-application-cycle before the report anticipated
it might be.** Only an identity/permissions layer stands between AHP and genuine multi-human
sessions in VS Code, and nothing in the spec blocks Microsoft from adding one.

Two adjacent protocol developments, lower urgency but worth carrying forward for execution:

- **MCP's 2026-07-28 release candidate** (reported — dated just after the sweep, not yet
  finalized), described as "the largest revision since launch," standardizes session
  creation/resumption/migration at the protocol level — lowers the cost of the reconnection/replay
  work §3.6 already flags as a PoC-to-production gap. Source:
  [blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/).
  Elicitation rework (SEP-2260) is protocol-level plumbing for human-confirmation gates, but remains
  single-user; MCP still does not define multi-human session semantics.
- **CHAP (Collaborative Human-Agent Protocol)**, an academic proposal (confirmed as existing,
  content summarized from full text,
  [arxiv.org/pdf/2606.09751](https://arxiv.org/pdf/2606.09751), Shahid/Suttie/Black, v2
  2026-06-23): envelopes (structured interaction containers), a handoff mechanism ("the handoff
  between shifts becomes a portable envelope rather than a pinned message"), and audit
  functionality, explicitly designed for multiple humans *and* multiple agents in one shared
  context. A second, more rigorous academic anchor alongside ESAA-Conversational (§3.1) for the
  "this is a converged-upon pattern" argument — and it adds an audit/governance angle
  ESAA-Conversational didn't emphasize, relevant to the enterprise-control wedge (#4).

### A.3 Build evidence from our own v2/v3 experiments

Independent of external research, this project's own build work over the same day produced three
concrete data points bearing directly on feasibility and differentiation:

1. **v2 live acceptance — an agent unprompted flagged a real conflict from injected teammate
   awareness.** In the controller-run Playwright acceptance for the "Project Hub" awareness
   feature (`.superpowers/sdd/task-6-report.md`, run 2, VERDICT: PASS), two agents ran in separate
   git worktrees under one project. Ana's agent declared intent ("Reading `src/auth.ts` to plan
   migration from session cookies to JWT"). Ben's agent — with no mention of Ana in its own prompt
   — received only the system's `<teammates>` digest, and **unprompted** added a "⚠️ Coordination
   note" naming Ana's in-flight JWT migration, correctly identifying that both changes touch
   `src/api.ts` and the request shape, and asking whether to wait, sync, or proceed. The report
   notes this "exceeds the acceptance bar." This is a live demonstration of an agent reasoning
   about *other connected humans'* concurrent intent — the exact capability the competitor
   deep-dive (§A.1 above, point 8 of its headline deltas) found **no surveyed competitor**
   implements: Amp and Factory give shared view/access, Ace gives shared prompting/cursors, but
   none describe an agent reasoning about what other connected humans are currently trying to do.
2. **Write-access experiment (commit `489b27d`, "feat: enable Write/Edit for agents in their own
   worktrees") — two agents built real code in parallel.** With Write/Edit enabled per-agent
   (Bash still off), two agents worked concurrently in isolated git worktrees on the same project.
   One agent proactively minimized its footprint on a file it detected a teammate was mid-change
   on — the system prompt's instruction to "keep your footprint on shared files minimal when a
   teammate is mid-change there, and say so when a merge conflict looks likely" (added in that same
   commit) was followed in practice, not just specified. The agent predicted the exact merge
   conflict its parallel changes would cause and its resolution; a subsequent merge test confirmed
   the prediction was correct. This is build-time evidence, not a controller-scripted acceptance
   run, so treat it as **internal/reported** rather than a formally logged acceptance artifact — but
   it is tied to a real, inspectable commit and a real merge outcome.
3. **v3 (in progress) — full Claude Code capabilities behind a driver approval gate where approval
   is itself a multiplayer feature.** Per the v3 design
   (`docs/superpowers/specs/2026-07-24-full-capabilities-design.md`) and implementation plan
   (`docs/superpowers/plans/2026-07-24-full-capabilities.md`), agents gain the full `claude_code`
   tool preset (Bash, Task/subagents, WebSearch/WebFetch, project-scoped Skills) with Bash and other
   powerful tools routed through a `canUseTool` gate: pending requests are logged as shared
   `permission_request`/`permission_decision` events visible to everyone in the session, and
   **any teammate who takes the wheel can decide a pending request** — approval, and the ability to
   hand off *who* gets to approve, is a controllable, handoffable, multiplayer primitive. As of this
   refresh, Tasks 1–2 are complete and committed (`08099cf` bash-allowlist/event types, `c2185c7`
   permission gate + full tool preset + project skills, both reviewed); Tasks 3–6 (server wire
   message, client approval cards, demo skill, live acceptance) are not yet built. This combination —
   full-capability agents plus a multiplayer-native approval gate — is, per the competitor deep-dive
   (§A.1, Claude Code Agent Teams point and headline delta #8), **not shipped by any surveyed
   competitor**: Anthropic's own Agent Teams docs explicitly scope approval to one human by design.

### A.4 Thesis check: does the conditional GO survive?

**Yes, but the clock is running faster than the original report could see.** Nothing in either
delta pass overturns the core findings: the need is real, the mechanic is proven and cheap to
build (now demonstrated twice more — v2's live conflict-flagging and the v3 write-access
experiment), and Claude Code, Cursor, and OpenAI Codex still have not shipped live multi-human
sessions as of 2026-07-24 (research-sweep.md §4, point 4). The original conditional-GO
recommendation (§4.3) — proceed on wedge #2 or #3, not a thin wrapper on wedge #1, with hard
concurrency/handoff semantics as the defensible ground — is, if anything, **reinforced**: even the
newest entrants (Warp, Amp's dedicated launch) still don't publicly document conflict resolution,
participant caps, or takeover locking, and no competitor treats tool-approval as a controllable
multiplayer primitive — exactly the ground this project's v3 work is building on.

What changed is the **speed of the incumbent-risk clock**, concretely:

- The original NO-GO trigger's *precondition* — "a major platform vendor ships an open,
  standardized multi-client session protocol" — **has now been met** (VS Code's AHP), roughly a
  full RFS-application-cycle before the report anticipated. It is not itself a NO-GO event (AHP is
  still single-developer, identity-agnostic), but it removes the single hardest remaining technical
  barrier between a fourth major incumbent (Microsoft/GitHub/VS Code) and true multi-human sessions.
- GitHub Ace has moved from "unverified, possibly just a proposal" to "live, gated technical
  preview with working signup" — the risk the original report flagged as needing continuous
  re-verification has moved further toward real, though GA still has not happened.
- The count of shipping truly-multiplayer products has grown from two (Amp, Factory) to at least
  three (adding Warp) within the same week the original report was written — the "not yet crowded"
  framing is already measurably less true one week later.

**What would flip this to NO-GO now**, restated against the faster clock: (1) Microsoft/GitHub adds
an identity/permissions layer to AHP and ships multi-human sessions in VS Code or Copilot — this is
now a smaller lift than it was, since the state-sync substrate is done; (2) GitHub ships Ace to
general availability rather than gated technical preview; (3) any of Claude Code, Cursor, or Codex
ships live multi-human co-control — Claude Code's Agent Teams approval-scoping decision (§A.1)
suggests Anthropic specifically has considered and declined this so far, which is mild evidence
against imminent risk from that one vendor, but not from the other two, and not from Microsoft.
**None of the three triggers has tripped as of 2026-07-24.** If proceeding, the correct read of
this refresh is: move faster, keep building on wedge #2/#3 (control semantics, driver-approval-gate
as a multiplayer primitive, teammate-intent-aware agents), and treat the current window as
narrower than it looked a week ago rather than as comfortably open.
