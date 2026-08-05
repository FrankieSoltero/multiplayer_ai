# multiplayer_ai — Product Requirements

*The product's final state. Every spec in `docs/superpowers/specs/` hangs off this document.*

**Written 2026-07-28.** Supersedes the `v7a → v7b1 → v7b2 → v7b3 → v7c → v7d → v7e` chain as the
plan of record. That chain is not deleted — its specs remain the authority on *shipped* code — but
"what do we build next" is now answered by picking a section from §8, not by incrementing a letter.

> **Reading the code references.** Every line ref in this document — including those to `poc/hub/`,
> `poc/server/src/relay.ts` and `mpai`'s `--hub` flag — is against **`main`**. The hub landed there
> when `feature/v7b1-hub-relay-spine` (PR #20) merged; no separate branch is needed to read them.

---

## 1. What this is

A **team hub for agent-assisted engineering**. Engineers attach their laptops to one shared hub,
open the repos they're working in, and run agents there. Everyone can see what everyone else is
doing, drop into anyone's session, and take control of a live agent run mid-task.

### 1.1 The thesis

Most "multiplayer AI" products merge everyone's context into one shared pool. This one does the
opposite: **sessions stay isolated, and only enough signal is shared for people and agents to avoid
colliding.** The unit of sharing is *awareness* — who is doing what, right now — not *artifact*.
Pooled-context products get noisier as the team grows; this one shouldn't.

Carried unchanged from `market-research.md`. Any feature that would make one agent read another's
transcript is off-thesis.

### 1.2 The primitive worth defending

**Transfer of control over a live agent run, between people.**

One person is driving. Another watches the same stream and takes the wheel mid-task. Everything
else in this document is either supporting infrastructure for that or packaging around it.

The strongest concrete instance is **approval handoff**: a teammate drops in solely to resolve a
pending `🔐` permission request and leaves. High-frequency, unambiguously valuable, needs no
explanation in a demo. It is the headline use case, not a footnote.

### 1.3 The target experience, in the user's words

> "I could go to a coworker and say I want to do in-depth work on our clients. They start `mpai`,
> we invite each other, open all of their client repos, and work in unison on everything — and come
> out knowing what they both did in depth without getting any information lost."

Three requirements are load-bearing in that sentence and are treated as requirements throughout:
**many repos at once**, **work in unison** (see and steer each other), and **a complete record
afterwards**.

---

## 2. Scope

**This PRD describes a hub a team runs for themselves.** Identity is GitHub. Hosting is the team's
own problem. There is no billing, no organizations, no multi-tenancy, no cross-hub directory.

**Commercial concerns are deliberately out of scope**, by explicit decision (D1). Hosted hubs,
seats, billing and onboarding-for-strangers are not requirements of this document and no design
here should be justified by them. The one carried-forward exception is that seats stay *countable*
where it costs nothing to keep them so — that keeps per-seat pricing a later pricing decision
rather than a later architecture change.

**Security hardening and deployment are the last section (§8.10), by explicit decision.** They are
a gate on ever exposing a hub beyond a trusted network — not a gate on the product being finished.

---

## 3. The object model

Four objects. Each has exactly one job.

### Hub

**The entrance.** One per team, self-hosted, one URL. Hubs are separate from each other: a hub is a
boundary, not a directory of other hubs.

Owns: **identity** (who you are), the **project directory** (what exists, who's in it), and the
**relayed copy** of everything happening inside it.

Runs no agent. Holds no API key. Clones no repo.

You land on the hub and you are always either choosing a project or inside one.

### Project

**A named container inside a hub: repos + people + sessions + a record.** You join one or create
one. It spans repos by design and spans machines by consequence.

A project is the unit you **invite someone into**, the unit a **summary is scoped to**, and the
only object other than a session with a lifecycle (create → active → closed → archived).

A project is a *bounded piece of work* — "acme-migration", "friday-bugbash" — not a permanent
property of the company. Boundedness is what makes a record of it meaningful.

### Session

**One agent working in one repo, in its own git worktree.** Participants, one driver at a time, a
transcript, a permission gate. A session belongs to exactly one project and one repo.

This is the part that already works and is not being redesigned.

### Machine

**Someone's laptop running `mpai --hub <url>`, headless.** It contributes repos and runs agents.
One machine serves many repos and many projects at once.

### Containment

```
hub → project → session → sub-session
                   ↑
              (one repo, on one machine)
```

**A repo is attached to a project by a machine, not owned by one.** Two people can attach the same
repo from their own clones; each gets their own worktrees, and each appears as their own session.

### Sub-sessions

A session can spawn sub-agent sessions. **A sub-session is a view, not a peer** — you swap between
main and a sub-agent the way Claude Code does. Three consequences:

- Sub-sessions **never appear at project level**. The project list stays readable no matter how
  many spawn.
- A sub-session's permission gate **surfaces on the parent**. Spawning five sub-agents is only a
  win if it doesn't produce five things to babysit.
- **Take-the-wheel operates on the parent.** You inherit its sub-agents with it, because the wheel
  is control of a machine's agent, not of a stream.

### Terminology

| Word | Means | Note |
|---|---|---|
| **Hub** | the entrance, one per team | |
| **Project** | named container of repos + people + sessions | today's `projectId`, given an identity |
| **Session** | one agent, one repo, one worktree | unchanged |
| **Sub-session** | a spawned sub-agent inside a session | a view within its parent |
| **Machine** | a laptop running `mpai --hub` | today's "uplink", widened |
| **Participant** | a person in a session | |
| ~~Party~~ | — | **retired.** It currently means a session's participants (`PartyPane`, "OTHER PARTIES") and is a fourth word for what hub/project/session already name. |

---

## 4. Topology — what runs where

| | Owns | Runs |
|---|---|---|
| **Machine** (`mpai --hub`) | the repos, the worktrees, the event log, driver state, the permission promise | **the agent** |
| **Hub** | identity, the project directory, membership, the relayed event copy, the web client | **nothing** |

The agent runs where the repo is: the engineer's laptop, on that engineer's own API key. The hub
coordinates; it does not execute. Laptops dial **outbound** to the hub, so no inbound ports are
needed on anyone's machine.

**The hub is the only human surface.** `mpai --hub <url>` is headless: it prints its status and
sits there. No local web server, no browser, no `localhost` URL. You never point a browser at a
machine.

**Plain `mpai` with no hub keeps the local UI as solo mode.** This is also the honest answer to
"what if the hub is down": you can still work alone, you just aren't on the team.

Exactly one surface is live at a time. That is the entire fix for *"a very confusing UI to tell the
user where they are."*

---

## 5. Surfaces

One surface — the hub — and four screens in a straight line.

**Entrance.** Sign in. See the projects you're in. Join one, or create one.

**Project.** The repos attached to it and who attached them. Every session across every repo, each
labelled with its repo, its machine and its participants. Who is where. Invite. Create a session,
choosing which of your attached repos it cuts a worktree from.

**Session.** The agent: transcript, todos, skills, workflows, the permission gate, the wheel, the
arcade.

**Sub-session.** Swapped into from within its parent session, and swapped back out of.

### 5.1 The layout requirement

**The terminal UI occupies the full page.** Shipped: the glass is the page. The fixed-width,
centred-column `.cabinet-inner` pin this section used to describe was already gone before the
presentation cycle started; what the cycle closed out was the marquee and legend, which used to
stack outside the glass in a `Cabinet` wrapper. `Cabinet` is retired — `App`'s root renders `<Crt>`
directly around the routed screen (`App.tsx:184`), with the `.term-header` breadcrumb as the sole
identity line (`App.tsx:180-184`) — rather than a marquee band above and a legend row below. The
bezel, scanlines, vignette and roll survive in `.crt`/`.crt-bezel`/`.crt-roll`
(`terminal.css:193-221`): the arcade identity was never what was being removed; the letterboxing
was.

**This is a requirement, not a cosmetic.** At that old pinned width the project screen had room for
only one column, which is *why* today's session picker is a flat list. Full-bleed is what makes
"repos down one side, sessions in the middle, who's where on the right" possible at all. The screen
designs in §8 depend on it.

### 5.2 Two presentations

The product ships **two themes over one interface**:

- **Arcade** — the 90s gamified terminal: CRT glass, scanlines, bezel, pixel-face chrome, chunky
  frames with hard offset shadows, the marquee. The product's identity.
- **Clean** — corporate-friendly. No CRT, no scanlines, no pixel type, no cabinet. Quieter frames,
  standard type, same density as Arcade — a quieter skin, not a tighter layout (ruling R2, spec
  §0, 2026-07-31). The version you screen-share in a client meeting.

**Functional parity is absolute.** Every control, every state, every affordance exists in both.
A theme may change how something *reads*; it may never change *whether it is there*. No feature is
arcade-only and none is clean-only.

**This is one component tree with two themes, not two UIs**, and it is feasible because the styling
already enforces the rule that makes it possible: `terminal.css:11-16` requires the pixel face to
be **chrome only** and to "never carry information that isn't also in the mono layer." The arcade
layer is therefore decorative over a complete information layer, by design. Clean strips the
decoration and loses nothing. Anything that violates that rule is a bug in Arcade, not a gap in
Clean.

**What makes it cheap:** the palette is fully tokenized in `:root` (`terminal.css:18-45`), and
`Crt.tsx`'s `intensity` knob already has an `"off"` mode that strips the overlays and curvature
(`Crt.tsx:20`). **What is not yet themeable and is the actual work:** shape and density — the 2px
chunky frames, `--chunk`'s hard offset shadows, segmented bars, the cabinet and marquee chrome —
live in component classes rather than behind tokens.

**Rules that hold in both:**

- **The contrast floor is the same.** Today's palette documents its ratios inline and clears AA
  throughout (`terminal.css:29-42`). Clean holds that floor. A quieter theme is the easiest place
  to quietly drop it.
- **Reduced motion is honoured in both** (`terminal.css:573`). Clean has less to suppress; the
  handling does not change.
- **Theme is a per-user preference**, persisted and switchable at runtime — not a build flag and
  not a hub-wide setting. Two people in the same session can be in different themes.
- **Arcade is the default.** It is the product's identity, and Clean is one control away. Reversible
  if it turns out people meet the product in front of their team before they meet it alone.

**The games exist in both**, because they are functionality (§8.9) and parity is absolute. In Clean
they are opt-in and never take over the screen.

**Explicitly not in scope: a light mode.** Both themes are dark. Light doubles a matrix that is
already two-wide, and nothing in the target experience asks for it. Recorded as a later option, not
a gap.

---

## 6. Decisions

Every decision made in the session that produced this document, with its reasoning. These are
settled; re-open them deliberately or not at all.

**D1 — Scope is a team running its own hub.** No billing, orgs or tenancy. *Why:* the product's
unproven part is the multiplayer primitive, not the commerce around it. Commercial architecture
built before the primitive is validated is architecture built on a guess.

**D2 — The hub is the only human surface; `mpai --hub` is headless.** *Why:* two live surfaces
rendering the same client — one of which can only ever show one machine — is what produced the
"where am I" confusion. This is the only option where that question has a single answer. It also
finishes a decision the code half-made: `cli.ts:153` already suppresses the browser open under
`--hub`. **Cost, accepted:** with `--hub`, a hub outage stops work entirely. Mitigated by solo mode
(D3), revisitable later by serving the client locally against both connections.

**D3 — Plain `mpai` keeps the local UI as solo mode.** *Why:* it costs nothing (the client is one
build), and it is the honest fallback for a hub outage.

**D4 — One `mpai` daemon per machine; repos are attached from the hub UI.** *Why:* "open all of
their client repos" is something you do *in the product*, next to the person you invited — not by
opening a fourth terminal tab. **Consequence:** the uplink becomes *a machine*, not *a machine
bound to one repo in one project* (`hubStore.ts:23-28`). `WorkspaceManager`, the worktree layout,
`repoKey` and every "the repo" assumption in `server.ts` become "which repo." Recorded now
specifically so machine identity is not built one-repo-shaped and then rebuilt.

**D5 — The hub contains projects; the hub is not itself the project.** *Why:* "in-depth work on our
clients" is a bounded piece of work with a start, an end and a named set of participants. Without
that boundary the session list is an undifferentiated stream of everything the team has ever done —
a flat list, just longer. A record needs edges. **Cheap because** `projectId` is already the hub's
top-level key (`hubStore.ts:41`); this gives an existing key an identity rather than adding a layer.

**D6 — "Project", not "party".** *Why:* it matches the existing wire vocabulary (`projectId`,
`watch_project`, `ProjectMessage`) so the rename is near-free, and "party" then retires cleanly
instead of becoming a fourth noun.

**D7 — A repo is attached to a project by a machine, not owned by one.** *Why:* two engineers
working the same client repo is the central scenario, and each needs their own clone and worktrees.

**D8 — A sub-session is a view within its parent, not a peer in the project.** *Why:* it matches
Claude Code's swap model, which is what was asked for, and it keeps the project list readable as
sub-agents multiply.

**D9 — The goal for the agent surface is Claude Code parity, plus the games.** *Why:* it is a
concrete, checkable target instead of an open-ended one. **Cheap because** `mpai` already drives the
agent through the Claude Agent SDK (`agentDriver.ts`'s `runAgentQuery` → `query()`) — subagents,
skills, MCP, hooks and permission gating are SDK-level capabilities already available. Parity is
overwhelmingly a job of **surfacing capabilities in the UI**, not of building an agent.

**D10 — The terminal UI is full-bleed.** See §5.1.

**D13 — Two themes over one interface: Arcade and Clean, with absolute functional parity.** *Why:*
the 90s gamified look is the product's identity and should not be diluted, but it is not what you
want on screen in a client meeting — and forcing that choice on the whole team would make one of
those two situations permanently awkward. **Feasible because** the styling already forbids the
arcade layer from carrying unique information (`terminal.css:11-16`), so Clean strips decoration
rather than removing capability. Per-user, runtime-switchable, Arcade default. See §5.2.

**D11 — The project is the unit of record.** *Why:* the requirement is "come out knowing what you
both did without losing anything," and a record needs the edges a project provides.

**D12 — Security hardening and deployment are the last section.** *Why:* they gate exposing a hub
beyond a trusted network, not the product being finished. **This is a real gate:** the hub already
enforces a pre-authentication payload limit and its identity/membership plane is now enforced
(§8.1, `docs/tech-debt.md` §1.1, resolved), but TLS, rate limiting and retention/backup are still
open (§8.10), so it must not be put on the public internet before §8.10 is done.

---

## 7. Rejected options

Recorded so they are argued with rather than rediscovered.

**Forking VS Code (Code-OSS) as the UI.** Considered, dropped. *Why:* (1) A fork is a desktop app
on the laptop, which is the surface D2 just removed — it silently reverses D2, or else requires
serving the editor from the hub with all file I/O crossing the relay, a substantial new subsystem.
(2) Code-OSS is MIT and genuinely forkable, but forks carry a permanent upstream-rebase tax and
cannot use Microsoft's official extension marketplace (forks use Open VSX; several first-party
extensions are proprietary and unavailable). (3) Focus: the thing nobody else ships is cross-person
control transfer of a live agent run, and a fork spends most of its effort on parts everyone
already has. **If revisited**, the cheaper rungs are embedding Monaco (VS Code's editor as an npm
package — real diffs and editing, no fork) or shipping a VS Code *extension* so teammates keep
their existing editor and get the multiplayer surface as a panel.

**`mpai` as a full daily-driver harness replacing Claude Code.** Raised, retracted. The goal is the
shared aspect; D9 keeps parity as the target for the agent surface without making "replace your
harness" the product's bar.

**The hub as the primary surface with the local UI as a secondary view of it.** Rejected as D2 —
this is the shipped v7b1 configuration and is what confused the demo.

**The hub as the only container (no projects).** Rejected as D5.

**Forcing multiple repos under one project id to make a demo look complete.** Rejected on principle
and recorded in memory: a demo must show the gap, not hide it.

---

## 8. Sections

Each section is a noun someone can own. Each becomes its own brainstorm → spec → plan when picked
up. **Listing order is not build order** — ordering is a separate decision, made per section, so
nothing becomes "next" by accident.

Each entry states what it is, what exists today, and what final state requires.

### 8.1 Identity & access

*What:* who you are on a hub, and what you may see.

*Today:* **shipped, on this branch.** GitHub OAuth with an allowlist, server-verified `userId`,
invites, a sign-out control — all built and merged — and now reused at the hub, not just the
standalone server: the hub mounts the same `auth.ts` (`multiplayer-ai-server/auth`'s `authRoutes`/
`requireAuth`, imported at `hub.ts:5`), reads the session cookie once at the browser upgrade, and
stamps the verified GitHub login as `userId`/`name` at both `identify` (`hub.ts:804-805`) and
`join` (`hub.ts:918-919`) — the browser's claim is discarded outright, not merely truncated.
Machines authenticate separately, with something better than "knows the URL": a laptop pairs via
a short-TTL (`pairing.ts`'s `PAIRING_CODE_TTL_MS` = 10 min), unambiguous-alphabet code approved by
an allowlisted browser, minting an opaque bearer stored only as its SHA-256 digest
(`pairing.ts`'s `hashToken`) in HubDb's schema-v2 `devices` table (`hubDb.ts:16`, `:24-27`), bound
to the machine's persisted `machineId` — a bearer minted for one machine cannot authenticate
`hello` for another (`hub.ts:563-564`) — and refused or revoked with WebSocket close code 4401
(`hub.ts:29`, `:521-525`, `:205`). Project membership is now the enforced access unit:
`join`, `create_session`, `attach_repo`/`detach_repo`, `set_project_lifecycle`,
`watch_project`/`peek` and `get_record` all gate on `store.isMember` (`hub.ts:933`, `:995`,
`:1069`, `:867`, `:1099`, `:1135`), and the project-push fan-out re-checks membership at send
time, so a departed member's pushes stop without an explicit unsubscribe (`hub.ts:233`). Only the
project LIST stays hub-wide, as the join affordance — each entry is redacted per requester
(`memberCount`/`isMember`, `members: []` for a non-member) rather than gated outright
(`hub.ts:388-403`, `:822`).

*Final state:* reached. The one narrowing is closed: invites are now project-scoped, hub-held
and durable (branch `feature/project-invites`) — the hub mints, lists, revokes, peeks and redeems
invites for a project from a schema-v3 `invites` table, redemption happens at `join_project`, and
the standalone server answers the same five messages for solo mode. The identity and membership
planes themselves are both enforced end to end, not merely designed.

### 8.2 Projects

*What:* the container — create, name, invite, join, leave, close, archive.

*Today:* **shipped (PR #22, lifecycle controls on `feature/project-lifecycle`).** Projects are
first-class on the hub: display name, member list, lifecycle (open/closed/archived at the store
level), `create_project`/`list_projects`/`join_project`/`leave_project` over the browser
protocol, and the entrance screen listing projects with member counts. The standalone server
answers the same entrance messages so solo mode lands on a one-item entrance. The PR-#22 gap is
closed: `set_project_lifecycle` now has a client surface — close/reopen/archive/un-archive
controls on the project screen (member-only, arm-and-confirm on the destructive two) and a SHOW
ARCHIVED toggle on the entrance, so archived state is reachable and reversible; the standalone
server answers the same message with the same refusal strings.

*Final state:* reached. The invite flow is scoped to projects (`feature/project-invites`), and
the close/archive client controls are shipped (`feature/project-lifecycle`). §8.2 is complete.

### 8.3 Machines & repos

*What:* one daemon per machine, many repos, attached from the hub.

*Today:* shipped and merged (PR #23, spec
`docs/superpowers/specs/2026-07-28-machines-repos-design.md`). A machine is a durable
identity: `~/.mpai/machine.json` (`MPAI_HOME` override) persists `{ machineId, name }` across
restarts, and `mpai`'s `--machine-name`/`--root` flags give a one-launch display name and an
allowlisted repo-candidate scan (`machineIdentity.ts`, `machineRepos.ts`). One daemon now offers a
**set** of repos — `server.ts`'s single `repo` field is retired in favor of `repos: Map<string,
RepoEntry>` — attached at launch (the cwd repo) or later, from the hub UI's MACHINES panel
(`MachinesPanel.tsx`: ATTACH/DETACH per repo, candidate-only, blocker-refused while sessions are
open; this attach/detach state lives in memory only and does not survive a daemon restart, debt
§2.7). The relay protocol bumped to v2 (`RELAY_PROTOCOL_VERSION = 2`, no v1 shim): the hello and
a new `repos` up-frame carry the machine's name and its full `RepoDecl[]` list, capped at 100 and
deep-validated element-by-element (`relayProtocol.ts`'s `repoList()`). `create_session` takes an
optional `machineId` to target one of several machines offering the same repo; the create form
lists real `(repo, machine)` pairs with per-repo base-ref prefill from `origin/HEAD` (D8/D9).
Session ids stay project-unique — no machine-scoped keys — so the collision this section used to
describe was really debt §2.3's restart case (a laptop reappearing under a fresh id looked like a
second machine fighting over the same session name); with a stable `machineId`, restarting a
laptop now silently **reclaims** its own sessions instead of colliding with them (debt §2.3,
dissolved; named tests there). Repo and machine labels render everywhere a UUID or raw key used
to (walk finding W4, dissolved; `SessionPicker.tsx:213,228-229`), never rendered before this
branch.

*Final state:* D4 — reached, with one deliberate refinement recorded in the spec (D4 there): names
stop colliding via a stable machine identity plus create-time dedupe (`freeSessionName`), not via
machine-scoped session ids — a smaller change with the same user-facing result. `mpai --hub <url>`
runs once per machine; repos are attached and detached from the hub UI, exactly as this line
originally asked.

*Open:* multi-project machines (one daemon = one hub = one project per launch stands, unchanged
— spec §10 non-goal); the candidate list is fixed for a daemon's lifetime, so a freshly cloned
repo needs a restart to appear (spec §4, §12.5).

### 8.4 Sessions & sub-sessions

*What:* the unit of agent work, and spawning sub-agents within it.

*Today:* sessions are complete and work well. Creating a session from the hub now works — the
projects work (PR #22, merged) routes `create_session` and narrowcasts the reply back, closing the
break that sent people back to a `localhost` tab. Machines & repos (§8.3, merged as PR #23)
extended the routing rather than replacing it: `create_session` now
carries an optional `machineId`, so a repo offered by several online machines is routed to the
one named instead of a coin-toss first-match, with three distinct refusals (machine unknown,
offline, or not offering that repo) (`hub.ts:549-613`). Sub-sessions now exist as **swappable
views, not a peer object** — spawning stays agent-initiated (the driver's Task/Agent tool call
opens one; there is no UI spawn control) and every sub-session is a filtered projection over the
parent's single append-only event log, never a log of its own. The server attributes each
`permission_request`/`permission_decision` and task start with an optional `parentToolUseId`
naming the spawning sub-session (`agentDriver.ts:265-434`, `events.ts:16-32`); a gate the driver
can't attribute still renders exactly as before, since attribution is display metadata, never
load-bearing for the decision. The client derives sub-session summaries from that same flat log
(`deriveSubSessions`, `derive.ts:152-218`) and swaps the transcript area between `MAIN` and a
per-sub-session projection (`Transcript.tsx`). A compact rail under the stats bar
(`SubSessionRail.tsx`, wired in `App.tsx:570`) lists one chip per sub-session — glyph `⚒`, label,
running/done state, and a pending-gate badge — and carries the existing driver-only STOP control
for a sub-session mapped to a stoppable task. Gates stay parent-scoped regardless of active view:
they render in the gate surface prefixed `⚒ <label>` when attributed, and are decided on the
parent session's driver exactly like a main-agent gate — there is no separate approval path per
sub-session. View state is client-local (not synced, not persisted); refresh lands on `MAIN`.

*Final state:* shipped at the code level — spawn sub-sessions and swap between them (D8), per
the design of record `docs/specs/2026-07-31-sub-sessions-design.md`.

*Ruling (spec R1, 2026-07-31):* the former "Open" question here — does a sub-session get its own
worktree, or share its parent's — is CLOSED: **shared parent worktree.** A sub-session runs in its
parent session's worktree, on the parent's branch; no per-sub-session worktrees, no merge-back
machinery, no branch naming. This matches Claude Code's model and the SDK default. Accepted bound:
parallel sub-agents can write the same tree — work is typically partitioned by prompt, and
everything lands on the session's one branch.

### 8.5 Control transfer & approvals

*What:* the primitive (§1.2).

*Today:* **built, and proven end to end across the relay** — joining another machine's session and
taking the wheel, including answering a permission gate that then executed on the other machine.
Pull notifications for unanswered gates are built and verified in a browser. Surfacing shipped this
cycle: a pinned gate bar above the prompt (`GateBar.tsx`) that jumps to the full gate card on click
and needs no scroll to reach the pending decision; wheel-on-card, so a non-driver can take the wheel
directly from an undecided permission gate in the transcript (`Transcript.tsx`); and pull
click-through, jumping from the header pull badge / per-session pull rows to the oldest-waiting
pull's session (`App.tsx`). All three ship identically in both themes, per §5.2's parity rule.

*Final state:* **the surfacing work this section called out is done.** See
`docs/specs/2026-07-31-presentation-design.md` for the design this cycle shipped against. Nothing
else in §8.5 is currently open.

### 8.6 The agent surface

*What:* Claude Code parity, in the UI (D9).

*Today:* transcript, todos, skills, workflows, oversight, prompt bar, permission gates, agent
status, thinking strip, slash autocomplete, model picker — and, after cycle 1 ("the wire",
`feature/agent-surface`, plan `docs/plans/2026-08-01-agent-surface.md`): the agent's own state is
visible and controllable. `turn_end` carries the usage/cost payload the HUD was designed for
(`total_cost_usd`, `usage`, `modelUsage`, durations — CONTEXT, elapsed, and a tokens-based PARTY
XP are wired, not placeholders); a driver-only ■ STOP interrupts the turn mid-run
(`Query.interrupt()`), with the interrupted outcome distinguishable from success in the log, not
just the UI; error turns carry their subtype and reason (`error_max_turns`,
`error_max_budget_usd`, …); rate limits, api retries, compaction, and refusal-fallbacks surface
as transcript/status signals instead of silence; subagent progress summaries are on
(`agentProgressSummaries`); and the skill roster hot-refreshes on `commands_changed`/plugin
changes. The `?screen=status` design screen was retired in the same cycle — its bars had no
honest feed and its tool grid was static; the HUD shows the real numbers now.

*Final state:* the gap inventory the PRD called for is done
(`docs/specs/2026-08-01-agent-surface-gap-inventory.md`) and cycle 1 ships the wire. Local
models ride the same surface (`feature/local-models`): the model registry is the single source
(`poc/server/src/models.ts`), operators add entries via `MPAI_EXTRA_MODELS`, and a LiteLLM proxy
routes the Anthropic API by model id (`claude-*` pass-through, local ids to Ollama) so a session
can pick a local model from the same picker with gates and record intact
(`deploy/local-models.md`). Cycle 2 (`feature/permission-rules`, plan
`docs/plans/2026-08-03-permission-rules.md`) ships permission **always-allow**: a driver answers
a gate with ALWAYS (gate card + `l` hotkey, offered only when the SDK suggested a rule) and the
SDK's suggested rule comes back as `updatedPermissions` with destination **forced to `session`**
— a driver's click never writes settings files, the rule dies with the session, and the
`permission_decision` event records rule + decider. Gates also render the SDK's own
title/description/decisionReason/matchedAskRule instead of only the reconstructed tool line.
What remains is phased and recorded in tech-debt §2.9: the six SDK modes mapping, token-level
streaming, rewind/checkpoints, SDK hooks, effort controls, background-tasks UI.

### 8.7 The record

*What:* D11 — come out knowing what everyone did, losing nothing.

*Today:* **built.** The hub's store is durable SQLite (`better-sqlite3`, WAL mode) behind
`HUB_DB` — default `~/.mpai/hub.db`, honoring the same `MPAI_HOME`-overridable dotdir §8.3 uses
for machine identity (spec §8a.2) — with a single-writer PID lockfile beside the DB that silently
reclaims a stale (dead/unparsable-PID) lock at boot (spec §8a.5); the one accepted false-alive
edge (a reused PID fooling the liveness check, or the resulting dual failure where boot is
refused though nobody actually holds the DB) recovers by deleting `<dbPath>.lock`. A hub restart
now replays from disk instead of starting empty, and a turn-boundary record — derived, not
written at close — is surfaced through `get_record` on both the hub and the standalone server
(`multiplayer-ai-server/record`) and rendered by the project screen's RECORD panel. Any write
failure is **fail-stop**: the hub process exits rather than run with memory ahead of disk, a
deliberate whole-hub outage (spec §3.6). Operator recovery order (spec §8a ruling 7): **back up
the `hub.db`/`hub.db-wal`/`hub.db-shm` trio FIRST** — it is the product's sole record and moving
`hub.db` alone strands committed WAL data — then free disk space, move the trio together, or run
degraded with `HUB_DB=:memory:`; a corrupt DB has no recovery before §8.10 ships backups, so the
record to that point is lost absent copies kept by the operator; schema bumps follow the same
backup-before-upgrade convention. Separately, `better-sqlite3` is a **native** dependency of
`poc/hub` — a failed native build breaks hub boot even when `HUB_DB` itself is fine, recovered
with `npm rebuild better-sqlite3`. What remains open, unchanged: **any graceful-shutdown signal
for a closed lid is still missing** (spec §6 non-goal 3) — a laptop vanishing and a laptop
cleanly restarting still look identical to the hub. Retention/compaction/backup for the
now-unbounded events table is deliberately deferred to §8.10 (debt §2.8).

*Final state:* durable hub-side storage; a record built **continuously at turn boundaries**, not
written at close; a project-scoped summary of what happened, who drove what, what changed, what was
approved and by whom. Survives a hub restart and a laptop vanishing mid-work. **Both properties are
product requirements of the record, not infrastructure to be deferred indefinitely.**

### 8.8 Awareness

*What:* the shared signal that keeps people and agents from colliding — the thesis in §1.1.

*Today:* presence, the roster, pull notifications, an oversight summarizer, and cross-session
collision awareness: git-derived `touched` facts recomputed at turn boundaries (`turn_end`, now in
`INTERESTING`) and at all three auto-approve decision sites, grouped by project `repoKey` through
the pure `collisionsFrom` (shared server/client) into a hub-computed `contested` down-frame naming
the colliding peers. Surfaces as a `⚠ CONTESTED ▸ N` header badge, per-session contested markers,
and `⚠ shares:` party rows (calm gold, never amber); agents get a tier (a) digest line plus a tier
(b) auto-approve withdrawal with gate reason `contested with session X`, asked once per (file,
session). On by default, advisory only — never blocks a write — and disabled wholesale with
`MPAI_CONTESTED_GATE=0`, which restores today's auto-approve path unchanged. Fork grouping remains
out of scope (known bound below).

Hub-side oversight now ships (`docs/specs/2026-08-04-hub-oversight-design.md`, split from the
collision work by the awareness spec's scope ruling, §8a.1): the hub runs its own `Overseer`
(imported, not reimplemented) over `OversightSessionDigest`s built from session logs across every
attached machine, so a project spanning laptops gets one team-wide summary instead of each
laptop's siloed view. Capability is host-configured — a hub can summarize iff its own process
carries `ANTHROPIC_API_KEY` (validated for presence at boot, no live probe); without one,
`set_oversight enabled:true` is refused with the exact string `oversight is unavailable on this
hub — no ANTHROPIC_API_KEY configured`, and every snapshot carries truthful
`oversight.available: false` (the solo server always reports `available: true`, since its SDK
creds are the laptop's own). `set_oversight` is hub-answered and member-gated with the lifecycle
convention — the same byte-identical refusal `join this project before changing it`, already
covered by the client's `not_a_member` normalization. HubDb schema v4 adds `project_oversight`
(enabled + summary + seq), written through before the snapshot push — durable-before-visible,
matching invites — so a hub restart keeps both posture and the latest summary, with `seq`
continuing from the stored value so clients never see it move backwards. Agent parity reaches the
laptops via a new `oversight_update` down-frame pushed to owning uplinks on refresh and toggle
(reconnect re-emits, so a laptop restart self-heals); the laptop's `team_update` tool text and the
one-shot `pendingOversight` prompt injection both read the hub-pushed state on a hub-attached
project, falling back to the local overseer only when running solo. The client's OVERSIGHT screen
renders unavailability truthfully — a disabled toggle with the reason line — instead of a dead
switch; `pull_oversight`/PULL and everything else is unchanged.

*Final state:* file-collision detection across sessions grouped by repo — meaningful only once a
project holds more than one repo, which is why it waited — and hub-side oversight, configured per
project and persisted across restarts. Both reached.

*Known bound, accepted:* forks do not group. Two engineers on forks of one repo produce different
keys and will not be grouped, though they will conflict upstream.

### 8.9 Presentation & the arcade

*What:* the two themes (§5.2), the full-bleed layout (§5.1), and the games.

*Today:* **shipped.** Full-bleed is done (§5.1). Two themes ship over one component tree: `Arcade`
(default) and `Clean`, switchable per user at runtime via a `data-theme="arcade" | "clean"` attribute
on `document.documentElement`, backed by a `useTheme()` hook that reads/writes localStorage
`mpai-theme` (`theme.ts`) — absent or invalid falls back to Arcade. Clean is a decoration-only
override layer fenced in `terminal.css` (`[data-theme="clean"]` rules), not a second layout: same
density as Arcade, per ruling R2 (spec §0, 2026-07-31) — a quieter skin, not a tighter one. The games
are built and client-side, and now have a smaller default footprint: the arcade lane renders at
`0.65` of `--fs` by default and is user-resizable (drag handle or arrow keys) between `0.5` and
`1.0`, persisted per user to localStorage `mpai-arcade-size` (`ThinkingStrip.tsx`) — the same
client-local preference pattern as `mpai-theme`. In Clean, games are opt-in: while an agent is busy
the thinking-strip status line renders without the game lane until the user opens it manually; a
manual open renders identically in both themes — the one sanctioned behavioral difference between
the themes, since parity governs everything else.

*Final state:* full-bleed, and Arcade / Clean switchable per user at runtime with absolute
functional parity. Both hold the AA contrast floor and honour reduced motion.

### 8.10 Operating a hub

*What:* running a hub for real — deployment, TLS, payload limits, rate limiting, retention,
audit, host settings.

*Today:* shipped at the code level; nothing has run on a real box yet. `hubConfigFrom`
(`hubEnv.ts`) validates every operating var at boot — `HUB_ORIGIN`, `HUB_RETENTION_DAYS`,
`HUB_BACKUP_DIR`/`_INTERVAL_MS`/`_KEEP`, `HUB_MIN_FREE_BYTES`, `HUB_TRUST_PROXY` — and refuses to
boot on a malformed value with a named error; `HOST` is fail-closed, refusing to boot a
non-loopback bind that has no auth configured rather than exposing an anonymous hub. Retention is
opt-in: unset keeps every event forever (a deliberate stance, not a gap), and when set, boot-time
pruning runs open/migrate → backup → prune → load, with `nextEventId` seeded from the max *stored*
id so a prune never disturbs sequence continuity and `sessions` rows are never pruned. Hot backups
(`VACUUM INTO`) run at boot before any prune and on an interval thereafter, keep the newest N, are
never fatal, and write 0700 dirs / 0600 files. A disk-headroom preflight refuses to boot below
`HUB_MIN_FREE_BYTES`, and a runtime gate refuses publishes while headroom is low (logged once,
recovering via reconnect) — replacing the old disk-full crash-loop with a loud refusal. Connections
are capped at 512 sockets, upgrades and `/auth`/`/pair` are rate-limited per IP (30/min, 429 on the
HTTP paths), a 200-msg/10s flood closes browser sockets (uplinks exempt), and a 4 MB
`bufferedAmount` triggers a backpressure close. The WebSocket upgrade checks `Origin` against
`HUB_ORIGIN` and closes 1008 on a mismatch, admitting header-less clients unchanged. `deploy/hub/`
carries a Caddyfile, systemd unit, `env.example`, and a RUNBOOK — present but explicitly
**UNVERIFIED**: written for this section, never exercised against a real box because none exists
to test on. D12's exposure gate is satisfied at the code level; real-box verification is the one
item this section leaves open. **That verification now has a runbook** —
`deploy/multi-machine-test.md` (this cycle) stages the user's 1-hub/3-machine acceptance test as
the vehicle: its §8.10 checklist items (TLS via Caddyfile, the systemd unit, backups present,
retention behavior) are marked "this run verifies," executed at the user's 3-computer test.

*Final state:* a hub that can be exposed to a network beyond a trusted one. **This section is the
gate on that exposure** (D12) and on nothing else.

---

## 9. Where the code actually is

Stated plainly so this document is not mistaken for a description of what exists.

**Built and working:** sessions, worktrees, the agent driver, transcript, todos, skills, workflows,
the arcade, the permission gate, driver handoff and take-the-wheel, GitHub OAuth with an allowlist,
invites, pull notifications, oversight summarization, repo identity, session lifecycle, `/exit` and
leave, the relay uplink, the hub's WebSocket surface, and `mpai --hub`. Control transfer across the
relay is proven end to end on two machines.

**Structurally already right for this PRD:** the hub stores `projectId → sessionId → session` with
a per-session `repoKey` and `uplinkId` (`hubStore.ts:41`, `:13-21`) and returns `repo: null`
because "a hub spans repos" (`:219-223`). **Many repos in one project already store and fan out
correctly.** The gap is surface and workflow, not the data model.

**The concrete gaps between here and §3–§5:**

1. A project has no name, members or lifecycle — it is a hidden URL parameter.
2. ~~`repoKey` and machine are stored but never rendered, so a multi-repo list reads as flat and
   unlabelled.~~ **Resolved** (§8.3, branch `feature/machines-repos`): every repo key and machine
   id renders as a human label everywhere the project screen shows one (walk finding W4,
   `docs/tech-debt.md` §2.3's closing note).
3. Sessions cannot be created from the hub.
4. ~~Session names collide across machines within a project.~~ **Narrower than stated, and the
   live case is resolved**: session ids stay project-unique by design (spec D4) rather than
   scoped by machine, so a genuine same-name collision between two *different* machines is still
   refused, correctly. What this line actually described in practice was debt §2.3's restart
   case — a laptop reappearing under a fresh id looked exactly like that collision — which is
   dissolved (§8.3).
5. ~~An uplink is one machine bound to one repo; D4 needs it to be one machine.~~ **Resolved**
   (D4, §8.3): a machine now offers a set of repos, attached and detached from the hub UI.
6. ~~The hub trusts the browser's identity claim.~~ **Resolved** (§8.1, this branch): the hub
   verifies GitHub identity itself (`auth.ts` reused at the hub) and stamps the verified login at
   `identify`/`join`, discarding the browser's claim; machines authenticate with pairing-derived,
   hash-stored, revocable bearers bound to `machineId` (`hubDb.ts`'s schema-v2 `devices` table),
   and participation is membership-gated throughout (`hub.ts`'s `isMember` checks).
7. The hub's log does not survive a restart.
8. Sub-sessions do not exist as a product concept.
9. ~~The UI is a fixed-width centred column.~~ **Resolved** (§5.1, `feature/presentation`): the
   pin was already gone before this cycle, and the marquee/legend that used to stack outside the
   glass are folded away with `Cabinet` retired.
10. There is one theme. Shape and density are not behind tokens, so Clean cannot be expressed
    without extracting them.

**Open branch:** `feature/v7b1-hub-relay-spine`, PR #20, unmerged. It is code-complete and reviewed;
its relay and hub socket surface are the transport this PRD builds on.

---

## 10. Open questions

Unresolved and deliberately not invented here.

1. **Sub-session worktrees** — own worktree or share the parent's (§8.4).
2. ~~**Repo attachment UX** — how a headless machine offers a path picker to a browser it does not
   serve, without becoming an arbitrary-path read primitive (§8.3).~~ **Resolved by refusing to
   build one** (machines-repos spec D3): a machine offers a fixed, launch-time-scanned candidate
   list (`--root`/`machine.json` roots), never an arbitrary path.
3. **Section ordering** — which of §8's sections is picked up first. Not decided by writing this
   document.
4. **Three v7b1 residuals**, carried: ~~the laptop's uplink fails silently, so a wrong hub URL is
   indistinguishable from a working one~~ — **resolved** (spec F1/F2, `cli.ts`/`relay.ts`): a
   bare `--hub` origin is normalized to append `/uplink`, and the CLI's "attached" line now
   prints only after the relay's `onAttached` fires on a real `welcome` (never at launch), with
   a loud once-per-process `onNoWelcome` warning if a socket opens but no `welcome` arrives
   within 5s (commit `3609c16`). ~~and a relay join emits no success signal~~ — **resolved**
   (spec F3, `hub.ts`/`server.ts`/`useSessionSocket.ts`): the hub and the solo server each send
   an explicit `{ type: "joined", sessionId, projectId }` message to the joining channel before
   replay, surfaced in the client Header as `● JOINED` (commits `228c432`, `384d924`). Both were
   previously out of scope for machines & repos (spec §12.3 names the first explicitly as
   inherited, not fixed) — resolved instead this cycle (`docs/specs/2026-08-05-prd-finishing-design.md`).
   The third — `uplinkId` minted per launch, so sessions did not survive a
   laptop restart — **is resolved**: it was directly in D4's path and did resolve with it
   (`docs/tech-debt.md` §2.3). The trap this item used to record — `repoKey` is not a usable
   machine identity, since with an `origin` present it is byte-identical across every clone by
   design — is now moot as a *machine*-identity risk: machine identity is `machineId`, persisted
   independently of `repoKey`, which keeps its original, unrelated job of grouping teammates on
   the same repo (spec §3.3, D7).
5. **Terminology migration** — retiring "party" touches client components and CSS class names; when
   to absorb that churn is a scheduling question.
