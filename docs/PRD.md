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

**The terminal UI occupies the full page.** Today the whole app is pinned to a 1296px centred
column (`terminal.css:196`, `.cabinet-inner { width: 1296px }`) inside 22px of cabinet padding
(`:193`), with the marquee band above (`:200`) and the legend row below (`Crt.tsx:54-60`) each
taking a slice of the height. On a wide display that is a small letterboxed screen in a large empty
room.

Final state: the glass is the page. The marquee and legend fold **into** the CRT as chrome rather
than stacking outside it. The bezel, scanlines, vignette and roll survive — the arcade identity is
not what's being removed; the letterboxing is.

**This is a requirement, not a cosmetic.** At 1296px the project screen has room for one column,
which is *why* today's session picker is a flat list. Full-bleed is what makes "repos down one
side, sessions in the middle, who's where on the right" possible at all. The screen designs in §8
depend on it.

### 5.2 Two presentations

The product ships **two themes over one interface**:

- **Arcade** — the 90s gamified terminal: CRT glass, scanlines, bezel, pixel-face chrome, chunky
  frames with hard offset shadows, the marquee. The product's identity.
- **Clean** — corporate-friendly. No CRT, no scanlines, no pixel type, no cabinet. Quieter frames,
  standard type, calmer density. The version you screen-share in a client meeting.

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
beyond a trusted network, not the product being finished. **This is a real gate:** the hub has no
pre-authentication payload limit (`docs/tech-debt.md` §1.1), so it must not be put on the public
internet before §8.10 is done.

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

*Today:* GitHub OAuth with an allowlist, server-verified `userId`, invites, a sign-out control —
all built and merged, all against the standalone server. The hub currently takes the browser's word
for identity, which is why it must not be exposed.

*Final state:* the hub verifies identity itself; a machine trusts the hub's stamp rather than the
browser's claim (today `hub.ts` simply truncates whatever the browser sent — at `identify`
(`:670-671`) and again at `join` (`:766-767`)). Project membership is the access unit. Machines
authenticate to the hub with something better than "knows the URL."

### 8.2 Projects

*What:* the container — create, name, invite, join, leave, close, archive.

*Today:* **shipped (PR #22).** Projects are first-class on the hub: display name, member list,
lifecycle (open/closed/archived at the store level), `create_project`/`list_projects`/
`join_project`/`leave_project` over the browser protocol, and the entrance screen listing
projects with member counts. The standalone server answers the same entrance messages so solo
mode lands on a one-item entrance. Known plan gap, disclosed in PR #22: `close_project`/
`archive_project` exist and are tested hub-side but have **no client surface** yet, so archived
state is unreachable from the UI.

*Final state:* the invite flow scoped to projects (invites today predate projects), and the
close/archive client controls. Everything else here is done.

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
offline, or not offering that repo) (`hub.ts:549-613`). Sub-sessions do not exist as a product
concept.

*Final state:* spawn sub-sessions and swap between them (D8).

*Open:* does a sub-session get its own worktree (isolated and mergeable) or share its parent's
(fast, but two agents writing one tree)?

### 8.5 Control transfer & approvals

*What:* the primitive (§1.2).

*Today:* **built, and proven end to end across the relay** — joining another machine's session and
taking the wheel, including answering a permission gate that then executed on the other machine.
Pull notifications for unanswered gates are built and verified in a browser.

*Final state:* mostly a matter of surfacing it well — this section is closer to done than any
other, and its remaining work is presentation, not mechanism.

### 8.6 The agent surface

*What:* Claude Code parity, in the UI (D9).

*Today:* transcript, todos, skills, workflows, oversight, prompt bar, permission gates, agent
status, thinking strip, slash autocomplete, model picker.

*Final state:* needs a **gap inventory against Claude Code** as its first task — this section
cannot be scoped from memory. The likely shape is surfacing SDK capabilities that already exist
behind the driver rather than building new agent machinery.

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
out of scope (known bound below); oversight configured hub-side is still open — split ruling, spec
§8a.1, tracked on its own branch.

*Final state:* file-collision detection across sessions grouped by repo — meaningful only once a
project holds more than one repo, which is why it waited. Oversight configured hub-side.

*Known bound, accepted:* forks do not group. Two engineers on forks of one repo produce different
keys and will not be grouped, though they will conflict upstream.

### 8.9 Presentation & the arcade

*What:* the two themes (§5.2), the full-bleed layout (§5.1), and the games.

*Today:* one theme — the 90s gamified terminal — pinned to a 1296px centred column. The games are
built and client-side; since the client is served by the hub, they come along for free under D2.
`Crt.tsx`'s `intensity` knob is a partial theming precedent; shape and density are not yet behind
tokens.

*Final state:* full-bleed, and Arcade / Clean switchable per user at runtime with absolute
functional parity. Both hold the AA contrast floor and honour reduced motion.

*Open:* whether Clean warrants its own information density (more rows visible, tighter panels) or
only a quieter skin at the same density. Density changes are where parity is most likely to break
by accident.

### 8.10 Operating a hub

*What:* running a hub for real — deployment, TLS, payload limits, rate limiting, retention,
audit, host settings.

*Today:* deployment wiring exists in-repo; nothing is deployed. The hub already enforces a
pre-authentication payload limit, and the standalone server now matches it (`docs/tech-debt.md`
§1.1, resolved) — TLS, rate limiting, retention/backup and host settings are what remain open.

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
6. The hub trusts the browser's identity claim.
7. The hub's log does not survive a restart.
8. Sub-sessions do not exist as a product concept.
9. The UI is a 1296px centred column.
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
4. **Three v7b1 residuals**, carried: the laptop's uplink fails silently, so a wrong hub URL is
   indistinguishable from a working one; and a relay join emits no success signal. Both remain
   unanswered and out of scope for machines & repos (spec §12.3 names the first explicitly as
   inherited, not fixed). The third — `uplinkId` minted per launch, so sessions did not survive a
   laptop restart — **is resolved**: it was directly in D4's path and did resolve with it
   (`docs/tech-debt.md` §2.3). The trap this item used to record — `repoKey` is not a usable
   machine identity, since with an `origin` present it is byte-identical across every clone by
   design — is now moot as a *machine*-identity risk: machine identity is `machineId`, persisted
   independently of `repoKey`, which keeps its original, unrelated job of grouping teammates on
   the same repo (spec §3.3, D7).
5. **Terminology migration** — retiring "party" touches client components and CSS class names; when
   to absorb that churn is a scheduling question.
