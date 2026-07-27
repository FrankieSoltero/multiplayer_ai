# v7a + v7b — Hub architecture (design)

*Brainstormed and user-approved 2026-07-27 (bg session #11). Supersedes the v6b
collision-detection framing, which was shelved mid-brainstorm once it became clear it was
designed against a topology the product is replacing.*

## 1. What this builds

A **hub**: one shared team surface that engineers across **many repos** join, with each
person's agent running on their **own laptop, in their own repo, on their own key**.

Today a server is bound to exactly one git repo, fixed at launch from `mpai`'s working
directory (`cli.ts:102-120`, `server.ts:82`). Every session on that server is a worktree of
that one repo. Five engineers across four repos means **four separate servers, four URLs,
and zero cross-visibility** — they cannot see each other's parties, cannot receive each
other's pulls, and share no oversight. `?project=` groups sessions *within* one repo's
server; it cannot span repos.

v7 splits two roles that are currently fused in a single process:

| | Owns | Runs |
|---|---|---|
| **Local `mpai`** | the repo, the worktrees, the event log, driver state, the permission promise | the agent |
| **Hub** | identity, the team roster, membership, the relayed event copy, the web client | nothing |

The hub **runs no agent, holds no API key** (one scoped exception in §3.7), and **clones no
repo**.

### 1.1 What this supersedes

- **v6b (file-collision detection)** is re-designated **v7e** and deferred. It cannot be
  built meaningfully before the hub exists: until a hub holds two repos, "which sessions
  share a repo" is always "all of them." Its banked decisions (HANDOFF §3b) survive intact.
- **HANDOFF §3e's per-user API key analysis (§7b)** is **dissolved, not solved**. Agents run
  on their owners' machines, so each engineer already pays with their own key. The
  prompt-cache-invalidation cost model that drove the deferral no longer applies.
- **HANDOFF §0's workspace-provisioning blocker** is dissolved *for the hub*, which never
  provisions a worktree. It remains a live bug for standalone `mpai` and for A1b.
- **Reading B's agent sandboxing and multi-tenancy** largely dissolve: no two people's
  agents share a machine.
- **A1b deployment** shrinks dramatically in scope. Only the hub needs a box, TLS and a
  domain — and the hub is a router plus a database, not an agent host.

### 1.2 The v7a / v7b split

One spec, two plans. They are specified together because repo identity only earns its keep
once a hub holds several repos, but they ship in order:

- **v7a — repo identity and lifecycle.** `repoKey.ts`, the repo key threaded onto sessions,
  and the three lifecycle facts of §3.4 replacing `ended`. Ships against **today's standalone
  server**, where the repo key is trivially constant and `presence` is always online. Small,
  independently verifiable, and it lets the client learn the new shape before any relay exists.
- **v7b — hub and relay.** Everything else: the hub package, `relay.ts`, device pairing, the
  trust inversion of §3.5, host settings, and pointing the client at the hub.

## 2. Decisions (user-approved 2026-07-27)

1. **Client-side execution.** The agent runs where the repo is: the engineer's laptop. The
   hub coordinates; it does not execute. Chosen over a server-side model where the hub holds
   clones of every repo. Rationale: it matches "essentially like it was run locally," and it
   *removes* four banked blockers rather than solving them (§1.1).
2. **The machine that runs the agent decides whether the agent may act.** `canUseTool`
   resolves on the laptop, always. A hub able to resolve it remotely would be a hub able to
   make your agent run Bash on your machine.
3. **The hub relays the existing protocol verbatim.** `prompt`, `permission`, `take_wheel`
   and the rest travel unchanged. The local server gains a **second transport**, not a new
   language. `Session`, `AgentDriver`, `permissions.ts` and the event vocabulary are untouched.
4. **`mpai` keeps working standalone.** With no hub configured it behaves exactly as today.
   The hub is strictly additive — see §6.
5. **Repo identity = normalized `origin` remote URL** (§3.3). Computed laptop-side, requires
   no configuration, and matches across machines and protocols.
6. **Three orthogonal lifecycle facts, each with exactly one owner** (§3.4), replacing
   today's single conflated `ended`.
7. **Host is a hub-scoped role; driver stays session-scoped.** They are orthogonal, and the
   same human routinely holds both (§3.6).
8. **The host can never drive or approve in a session they have not joined.** Stated as a
   non-capability, not left implied (§3.6).
9. **Approval authority comes from presence, not from role.** Any participant may take the
   wheel and decide; this is unchanged from today and is the product's wedge.
10. **Oversight is host-configurable: bring your own key, or a paid tier where we supply
    one** (§3.7).
11. **v7b keeps the hub's event log in memory**, like today's server. Durability across hub
    restarts is v7c.

## 3. Architecture

### 3.1 Topology and ownership

Each laptop opens **one outbound** WebSocket to the hub and keeps it alive. Browsers connect
**only** to the hub. No inbound ports on anyone's machine — no NAT traversal, no firewall
rules, no dynamic-IP or CGNAT problem, which were the reasons HANDOFF §3e rejected
self-hosting on a home machine.

The laptop remains the authority for its own sessions: it holds the event log, the driver
state, and the pending `canUseTool` promise.

### 3.2 The relay protocol — two planes

Commands and events have opposite shapes and must not share a mechanism.

**Command plane — addressed, tunnelled.** A browser's `prompt` or `permission` must reach one
specific laptop. The hub wraps it:

```
{ type: "tunnel", channelId, payload }   // payload = the untouched original message
```

The laptop unwraps and feeds `payload` to the same handler that serves a direct WebSocket
today, then replies on the same `channelId`. The hub is a router here and nothing more.

**Publish plane — broadcast, fanned out by the hub.** Session events travel the other way and
are **not** tunnelled per browser: a session with six watchers would otherwise push six copies
up a laptop's uplink. The laptop publishes its stream **once**; the hub persists and fans out.
The laptop never learns how many browsers are attached, so watchers joining and leaving cost
it nothing.

This lands on existing code with almost no friction: `session.subscribe(fn)` (`session.ts:34`)
already provides the per-event hook used at `server.ts:390-394` to feed joined sockets. The
relay is **one more subscriber that forwards upward**.

**Snapshot assembly moves to the hub.** Only the hub sees every laptop, so it composes the
team view. Laptops publish per-session *facts* — intent, participants, driver, `pendingGate`,
`ended`, repo key. `summarizeSession` (`digest.ts:10`) and `pendingGateOf`
(`pendingGate.ts:17`) stay laptop-side as fact producers; `projectSnapshot` (`project.ts:106`)
becomes hub-side assembly.

**Reconnect is nearly free**, and this is a direct payoff of the append-only design. The
laptop reconnects, the hub reports "I have through seq 214 for session `auth`," and the laptop
replays from 215. No diffing, no reconciliation.

**The `runId` trap — designed out, not discovered later.** The event log lives in memory
(`session.ts:5`), so a laptop restart resets `seq` to 0, which would silently overwrite real
history in the hub's store. Therefore: **the laptop mints a `runId` each time it starts a
session process, and events are keyed `(runId, seq)`.** The hub stores them in arrival order
under its own monotonic id. This also gives v7d its natural seam — a session resumed from a
handoff is simply a **new run of the same session**, which is precisely what it is.

### 3.3 Repo identity

Computed laptop-side at provision from `git remote get-url origin`, then normalized:

```
git@github.com:acme/api.git      ─┐
https://github.com/acme/api       ─┼──→   github.com/acme/api
https://github.com/acme/api.git   ─┘
```

Strip scheme, strip credentials, strip `.git`, lowercase the host, drop trailing slashes.
Two engineers who cloned the same repo produce the same key with zero configuration.

**No remote → never match.** A repo without `origin` gets a deliberately machine-local key
(`local:<host>:<hash of absolute path>`) so it can never falsely group with anyone else's.
Silence beats a wrong match.

Repo identity is a property of the **session**, not the machine: one laptop may run `mpai` in
several repos, producing several uplinks.

**Repo key does not replace `?project=` — they answer different questions and both stay.**
A project is a *social* grouping chosen by humans ("the auth work"); a repo key is a *physical*
fact about which working copies can conflict. On the hub, projects group what people see
together, and repo keys group what can collide. The two are independent: one project may span
several repos, and one repo may appear in several projects. Only v7e reads the repo key.

### 3.4 Session lifecycle

Today `ended` conflates three genuinely different situations, which is why "Ana's laptop is
asleep" and "Ana's agent crashed" currently render identically.

| Fact | Values | Owner | Means |
|---|---|---|---|
| `presence` | online / offline | **Hub** — it sees the uplink | Is the laptop reachable |
| `lifecycle` | open / closed | **Hub** — explicit action | Has someone deliberately ended this |
| `ended` | true / false | **Laptop** — it runs the process | Is the agent process dead |

The UI composes its label from these three; the wire never guesses.

**Closing a session:**
- **Any participant** may close a session they are in, attributed on the wire — session scope,
  consistent with the standing no-owner-role precedent and with `task_stop` / `oversight_pull`,
  which attribute rather than restrict.
- **The host** may close any session on the hub — surface scope, and part of why the role
  exists.

### 3.5 Auth and trust

**Browsers → hub.** A2a's OAuth moves to the hub essentially intact — `auth.ts` (cookie
sign/verify, allowlist, the four `/auth/*` routes) is transport-agnostic. The allowlist becomes
host-owned settings rather than the `GITHUB_ALLOWLIST` env var.

**Laptops → hub — device pairing.** `mpai` is not a browser and has no cookie round trip. Run
`mpai --hub https://team.example.com`; it prints a short code; you approve it in an
already-signed-in browser tab; the hub issues a long-lived uplink token bound to your GitHub
identity. No secret is ever pasted into a terminal, and every uplink is provably owned by a
known human.

**The trust direction inverts — this is the part to get right.** Today the local server
verifies identity itself: `server.ts:353-357` overwrites both `msg.userId` and `msg.name` with
the cookie-verified login, which is what closed A2a whole-branch Critical 1. In the hub model
remote participants authenticate to the **hub**, so the hub does that stamping and the laptop
trusts it. The rules:

1. The hub stamps every tunnelled command with the verified identity of the browser that sent
   it. A browser cannot claim to be someone else.
2. A laptop may publish only for sessions it owns; the hub checks the uplink. A laptop cannot
   forge another laptop's session events.
3. The laptop trusts hub-stamped identity on inbound commands and **nothing else**. Its own
   gate logic, path-containment checks (`permissions.ts:82`) and driver rules stay local and
   unchanged.

### 3.6 The host role

**Host is an attribute of a person on the hub, not a mode.** The host joins sessions, takes the
wheel and is attributed by name exactly like anyone else. Hosting the hub does **not** mean the
hub runs the host's agent — the host runs `mpai` on their own laptop like everyone else.

**Host owns** (most of these already exist as env vars, so this is a move, not an invention):
the sign-in allowlist, `REQUIRE_INVITE`, whether members may add plugins, retention period,
whether AUTO mode is permitted, and the oversight configuration of §3.7.

**Host explicitly cannot** drive or approve in a session they have not joined. This is a stated
non-capability. A decision attributed to someone who was not present is exactly what the product
exists to eliminate; a host bypass would recreate the credential-confusion villain in the
project's own positioning (HANDOFF §3e).

**Ownership is transferable.** Designed in from the start — a hub must not die because its host
leaves the company.

**Seats are countable from day one**, whether or not they are charged for. Per-host pricing has
one weakness: a fifty-person org has a single payer, so revenue stops tracking delivered value.
Making seats countable now keeps per-seat a *pricing* change later rather than an architecture
change.

### 3.7 Oversight — the one scoped key exception

`overseer.ts` summarizes **across** sessions, so it belongs on the hub — but it makes a model
call, and §1 says the hub holds no key. Resolution: **the host configures it**, choosing either
to supply their own key or to take a paid tier where we supply one.

This is a **scoped exception, not a reversal of §3e**. The hub holds at most one key, placed
there deliberately by the host, used only for summarization with `tools: []` and `maxTurns: 1`
(`overseer.ts:159-165`) — it never executes a tool. The blast radius is far smaller than the
rejected "N users' keys on an assume-breach box."

**Business precondition, not a code blocker:** if we supply the key we are reselling inference.
That is a different question from HANDOFF §3f's ruling (which concerned products offering
claude.ai *login*), and it needs a read of Anthropic's commercial terms — the same document
captured 2026-07-25 and never re-verified.

## 4. What moves, what stays, what is new

**Moves to the hub:** `auth.ts` (near-intact), `staticFiles.ts`, `invites.ts` (invites govern
who joins the surface), `projectSnapshot` from `project.ts` (becomes assembly).

**Stays on the laptop, unchanged:** `session.ts`, `agentDriver.ts`, `permissions.ts`,
`digest.ts`, `pendingGate.ts`, `workspace.ts`, `events.ts`, `pluginStore.ts` (plugins are local
files the agent loads), and every `server.ts` message handler.

**New:** `relay.ts` on the laptop (outbound socket, tunnel framing, event forwarding,
resume-from-seq); `repoKey.ts` (pure normalization); the hub package (router, fan-out, snapshot
assembly, membership, host settings).

**Client:** small. It already speaks this protocol. Point `SERVER_URL` at the hub, render the
new presence/lifecycle states, add a host settings screen.

## 5. Testing

House pattern throughout — extract pure, inject the boundary:

- `repoKey.ts` — pure, table-driven over the URL forms in §3.3 plus the no-remote case.
- Tunnel framing — pure wrap/unwrap, no sockets required.
- Hub routing and snapshot assembly — pure functions over declared session facts.
- The uplink — inject the socket, same pattern as `auth.ts`'s injected `exchangeCode` and
  `config.ts:12`'s injected fs probe.
- `(runId, seq)` keying — a restart-mid-session test asserting the hub's stored history is not
  overwritten.

**What tests structurally cannot catch, named up front rather than discovered at the end.**
This project has been burned three times by live-behaviour drift (`skills:"all"` reversal,
`canUseTool` shadowing, the `<label>`/`<select>` focus trap). The v7 equivalents are:

1. **Reconnect mid-gate** — a laptop's uplink drops while a permission request is pending.
2. **Laptop sleeping mid-turn** — the agent dies mid-stream; watchers must see honest state.
3. **Hub restart with laptops attached** — every uplink must re-establish and resume.

These require a real two-machine walk and are **required verification**, not optional polish.

## 6. Migration and staging

The hub is **purely additive**, which is what de-risks this:

1. `mpai` with no `--hub` behaves exactly as today.
2. `server.ts`'s handlers do not change, so **all 305 server tests keep passing untouched**.
3. The hub is a separate package with its own suite.

There is no big-bang cutover and no broken intermediate state. The demo path that every prior
piece of work depends on keeps working throughout.

## 7. Out of scope

- **v7c — persistence.** SQLite on the hub; durable across hub restarts. v7b's hub keeps its
  log in memory, which already delivers the win: sessions survive a laptop disconnecting, and a
  team shares one surface across repos.
- **v7d — handoff continuity.** Generate a handoff **continuously** (debounced, at turn
  boundaries) rather than only at close, because sleeping lids, crashes and dead wifi fire no
  graceful-close trigger. Replay it into a fresh agent on resume. Chosen over persisting agent
  memory because prose is portable across machines *and* across model providers, which
  conversation state is not (HANDOFF §3f) — and it is human-readable, which is on-thesis. The
  `(runId, seq)` keying of §3.2 is its seam.
- **v7e — collision detection** (formerly v6b), grouped by repo key.
- **Oversight running on the hub** beyond the configuration decision in §3.7.
- Fork-aware repo grouping (§8).

## 8. Known bounds and honest disclosures

- **The hub sees everything relayed through it** — transcripts, tool calls, file paths,
  prompts. Inherent to being the shared surface, not an oversight. Teams who cannot accept it
  self-host the hub, which is cheap precisely because it runs no agents.
- **Forks do not group.** Two engineers on forks of one repo produce different keys and will
  not be grouped, though they will conflict upstream. Keying on upstream would fix it, at real
  complexity, for a case common in OSS and rare inside a team. Accepted.
- **An offline laptop cannot be driven or approved.** Its agent is not running either, so
  nothing is lost but the illusion of availability — which today's always-on box provides.
- **Approvals gain roughly 100ms** (browser → hub → laptop). Irrelevant for a human clicking a
  button.
- **Sessions closing:** with v7b's in-memory hub log, a hub restart still loses history. That
  is v7c's job and should not be presented to users as durable before then.

## 9. Bug found while designing this — recorded, not fixed here

**Worktrees are not project-scoped, so two projects can silently share one working copy.**
`provision(slug, baseRef)` (`server.ts:511`) keys on the session slug alone — directory
`worktreesRoot/<slug>`, branch `mpai/<slug>`, with no `projectId` anywhere.
`project.sessions.has(slug)` guards *within* a project but nothing guards across them, and
`provision`'s idempotent-reuse check (`workspace.ts:35`) runs **before** the branch-taken check.
So a session named `auth` in project B silently adopts project A's existing worktree and
branch: two agents, two sessions, one working copy, no warning.

Out of scope for v7a/v7b. It matters to **v7e**, which must dedupe by resolved workdir and treat
a shared working copy as "same copy," not as collision — otherwise every file either session
touches reads as contested.

## 10. Open questions

- **Session close semantics on reconnect.** If a host closes a session while its laptop is
  offline, what does the laptop do when it returns — accept the close, or resurrect? Proposed:
  accept, and surface it to the returning user.
- **Uplink token revocation.** Device pairing issues long-lived tokens; the host needs a way to
  revoke a lost laptop. Shape is straightforward, but it is unspecified here.
- **Multiple `mpai` instances for one repo on one machine.** Permitted by the design; whether
  the UI should discourage it is undecided.
