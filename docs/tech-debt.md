# Tech debt log

Known debt, deliberately deferred. Opened 2026-07-27 (bg session #11) when the decision was
made to build v7 first and run a security + optimization scrub afterwards.

**How to use this.** One entry per item: what it is, evidence (file:line), why it was deferred,
and what "fixed" looks like. Add to it when you defer something rather than leaving the
knowledge in a session that will be cleared. Remove entries when they are fixed, in the same
commit as the fix.

**Scrub gate — read this before deploying.** The security items below were deferred *relative
to building v7*, not relative to exposing it. §1.1 is a pre-authentication denial of service
and v7's entire purpose is to put a hub on the public internet. **The security section must be
cleared before the hub is publicly reachable**, which is a gate on A1b/deployment, not on v7
being written.

---

## 1. Security — deferred 2026-07-27, must clear before public exposure

### 1.1 No `maxPayload` on the WebSocket server — pre-auth DoS

`poc/server/src/server.ts:269` — `new WebSocketServer({ server: httpServer })` with no
`maxPayload`, so the `ws` default of **100 MB** applies. The upgrade completes *before* any
join or auth gate, so an unauthenticated peer that can reach the port can push a 100 MB frame
into `JSON.parse` (`server.ts:301`), amplifying into a much larger object graph. Repeatable.

**Fixed looks like:** an explicit `maxPayload` around 1 MB (`MAX_PROMPT_LENGTH` is 4000, so
this is generous), applied on browser-facing *and* uplink-facing sockets, enforced before
authentication. Test: oversized frame is rejected without allocating.

**v7b1 note — the two halves now diverge.** `poc/hub/src/hub.ts:135` *does* set
`maxPayload: MAX_FRAME_BYTES` (1 MB) on both hub planes; `server.ts` still does not. So the
same >1 MB paste into the prompt box is accepted by a standalone laptop and answered with a
1009 close by the hub. The hub's cap is correct and stays. What makes it user-visible is §4's
missing client reconnect: a 1009 leaves the tab on a dead socket until a manual reload.
Fixing `server.ts` here removes the divergence; fixing the client reconnect removes the sting.

### 1.2 Invite token travels in query parameters and persists in the address bar

`poc/client/src/components/InviteSignIn.tsx:29` passes `location.pathname + location.search` —
containing `&invite=<192-bit bearer token>` — into `loginUrl()`
(`poc/client/src/authState.ts:30-32`), producing `/auth/login?next=<...&invite=token>`. There
is **no `history.replaceState` anywhere in the client**, so the token stays in the address bar
permanently. (Carried from HANDOFF §6b.)

Today's blast radius is limited to browser history and screen shares: `deploy/Caddyfile` sets
`Referrer-Policy: no-referrer` and enables no access log. That mitigation is one `log` directive
away from evaporating, which is why this is structural rather than cosmetic.

**Fixed looks like:** strip `invite` from `next` before building the login URL, and
`history.replaceState` the token out of the URL after redemption. Recorded as a rule in the v7
spec §10.1 so the hub does not extend the pattern.

### 1.3 `userId` is type-checked but never bounded or charset-validated

`poc/server/src/server.ts:330-336` checks `typeof msg.userId === "string"` and nothing more,
while `sessionId` and `projectId` both go through `SLUG.test`. With auth **on**, `:353-357`
overwrites it with the verified GitHub login, so it is inert. With auth **off** it flows
unbounded into the event log, project snapshots, `arcadeRecords`' identity map, and
`<teammates>` digests.

**Fixed looks like:** length cap plus charset validation applied regardless of auth mode.
Sweep the same pass for `stop_task`'s uncapped `taskId` and the uncapped summary/tool-target
text flowing into prompts and snapshots.

### 1.4 No `Origin` check on the WebSocket upgrade

Carried from HANDOFF §7e, triaged "can ship" during A2a. Cross-site WebSocket hijacking is
blocked today by `SameSite=Lax` alone. Once the cookie confers identity across a whole team on
an internet-facing hub, an explicit origin check stops being defence in depth and becomes a
control. Recorded in v7 spec §10.6.

### 1.5 No rate limiting anywhere

Acceptable for a localhost POC, not for a public hub. Affects `/auth/*`, the WebSocket upgrade,
and — once v7 lands — device-pairing code submission, which is brute-forceable by construction
(v7 spec §10.5).

### 1.5b `HubStore.uplinks` grows without bound — and the frame validation under it is shallow — LARGELY DISSOLVED (PRD §8.3, 2026-07-29)

Two v7b2 inputs that until now lived only in the v7b1 plan's Deviations (§D.9 and §B.3). They
are recorded here because this is the file a v7b2 planner opens.

**Unbounded `uplinks` — dissolved for the case that was actually happening; open for the
adversarial one.** `poc/hub/src/hubStore.ts` — `attach()` inserts a permanent `Uplink` per
distinct `uplinkId` and `detach()` only flips `online = false`; nothing ever deletes, unchanged
code. What changed is what feeds it: the debt as written described "a connect/`hello`/disconnect
loop with fresh ids" as the leak — and per §2.3 below, that loop was not a hypothetical, it was
**every laptop restart**, because `uplinkId` was minted fresh (`randomUUID()`) each launch. With
the machine identity work (spec `docs/superpowers/specs/2026-07-28-machines-repos-design.md`
§3), `uplinkId` is now the persisted `machineId`, so `attach()`'s `uplinks.set(uplinkId, ...)`
**overwrites the same entry** on every reconnect of a real machine instead of adding a new one —
proven by `poc/hub/test/hubStore.test.ts:156` ("lets a machine that restarted under its
persisted machineId reclaim its own sessions (debt §2.3)") and, across the wire, by
`poc/hub/test/relayIntegration.test.ts:865` ("reclaims its own sessions across a relay restart,
with no ownership collision"). **What remains open:** the uplink plane is still fully
unauthenticated — nothing here stops an adversarial peer from sending a fresh `hello` with a new
random `uplinkId` on every connect, which would still grow the map exactly as originally
described. That is unchanged and is exactly what the exposure gate (§8.10/D12 of the PRD) is
for — this entry is dissolved for every legitimate deployment's actual failure mode, not for an
unauthenticated adversary, which was never in scope for this branch.

**Shallow frame validation (v7b1 ruling B.3, a named input for v7b2's validation task — do not
lose it) — one deep example now exists; the original shallow spots are untouched.**
`poc/server/src/relayProtocol.ts`'s `isFacts` still checks `Array.isArray(f.events)` /
`participants` / `skills` and casts, and `pendingGate` is still only checked `object | null` with
no deeper shape check — **not touched by this branch**, and the standing warning still holds:
**anyone touching `hubStore`: do not assume a fully shaped `PendingGate`.** What this branch adds
is `repoList()` (`relayProtocol.ts:135-152`), the shared validator for `hello`'s and the `repos`
frame's `RepoDecl[]`: it checks every element's `key`/`label`/`attached`/`defaultBranch` bounds
and **rejects the whole list on any single malformed entry**, never silently drops one. It is the
first deep, bounded, whole-reject validator in this file — a template for eventually closing
`isFacts`'s remaining shallow spots, not a claim that they are closed. `repoKey`,
`identity.userId` and `identity.name` remain length-bounded but not charset-checked, as before.
One element-level hole — an out-of-range `seq` that froze a session's history permanently — was
closed by the v7b1 whole-branch review; the rest of `isFacts` stands exactly as written.

### 1.6 UNEXAMINED: the plugin clone path

`poc/server/src/pluginStore.ts:154` and `:173` `JSON.parse` metadata from a cloned third-party
repository. This is untrusted input by definition, and the plugin system is the one place the
product deliberately executes other people's content. **This was not audited** in the
2026-07-27 pass — flagged here so the gap is not mistaken for coverage. Related: the
Bash-allowlist two-hop risk that plugin hooks widen (v6c spec §8).

---

## 2. Correctness

### 2.1 Worktrees are not project-scoped — two projects can silently share one working copy

`poc/server/src/server.ts:511` — `provision(slug, baseRef)` keys on the session slug alone:
directory `worktreesRoot/<slug>`, branch `mpai/<slug>`, no `projectId` anywhere.
`project.sessions.has(slug)` guards *within* a project but nothing guards across them, and
`provision`'s idempotent-reuse check (`poc/server/src/workspace.ts:35`) runs **before** the
branch-taken check. So a session named `auth` in project B silently adopts project A's existing
worktree and branch: two agents, two sessions, one working copy, no warning.

Found 2026-07-27 while designing v7. **Blocks v7e** (collision detection), which must dedupe by
resolved workdir and treat a shared working copy as "same copy" rather than collision —
otherwise every file either session touches reads as contested.

### 2.2 Production sessions have no workspace provisioning

HANDOFF §0, unchanged. `poc/server/src/main.ts` never passes a `workspace` to `startServer`, so
`server.ts:174-175` derives a workdir that **nothing ever creates**; and with
`AGENT_WORKDIR_ROOT` unset, `poc/server/src/agentDriver.ts:133` falls back to `process.cwd()` —
under the systemd unit, the running deployment's own source tree. Deliberately not patched with
a bare `mkdir`: failing loudly beats an agent silently working in an empty directory.

Blocks A1b. Dissolved for the hub (which provisions nothing) but still live for standalone
`mpai`.

### 2.3 A hub-attached laptop cannot reclaim its own sessions after a restart — RESOLVED (PRD §8.3, 2026-07-29)

**Was:** `poc/server/src/cli.ts` passed no `uplinkId`, so `poc/server/src/server.ts`'s relay
construction minted a fresh `randomUUID()` on **every** launch. The hub keys session ownership on
`uplinkId` (`poc/hub/src/hubStore.ts` — `HubSession.uplinkId`, `ownerOf`, and `snapshot`'s
`presence` lookup), so after `mpai --hub` was restarted, every session the previous run owned
stayed bound to the now-`online:false` uplink and read `offline` forever with no machine able to
adopt it, and a same-machine restart was indistinguishable from the two-laptop collision that
`setFacts`'s `already owned by another machine` refusal was written for. Observed live during
v7b1 Task 8's two-process walk (2026-07-28). **Consequence at the time:** Task 6's entire resume
machinery (`hubStore.resumeOffsets`) was dead code in every real deployment, and the plan's
central promise — sessions survive on the hub when a laptop goes away — was false after any
laptop restart.

**What closed it — the grain decision this entry left open.** This entry itself had already
identified that no new protocol was needed, only a stable-and-per-machine uplink id (the "grain"
question). `docs/superpowers/specs/2026-07-28-machines-repos-design.md` §3 answered it: a new
`poc/server/src/machineIdentity.ts` mints and persists `{ machineId, name }` in
`$MPAI_HOME/machine.json` (default `~/.mpai`) on first run, refusing launch on a corrupt file
rather than silently regenerating (which would orphan the very sessions this fix is for).
`cli.ts:246-250` passes that persisted `identity.machineId` as both `machine.machineId` and
`hub.uplinkId`, replacing the per-process mint (commit `64c27cf`). `hubStore.setFacts`'s existing
same-`uplinkId` takeover rule and `hub.ts`'s same-id supersede logic needed **no change** — they
simply start working the moment the id is stable, exactly as this entry predicted.

**Named tests:**
- `poc/hub/test/hubStore.test.ts:156` — `"lets a machine that restarted under its persisted
  machineId reclaim its own sessions (debt §2.3)"` — unit-level: `detach()` then re-`attach()`
  under the same id, and a `setFacts` call afterward for the same session (with a new `runId`)
  returns `{ ok: true }` rather than the ownership refusal, with the reconnected repo list
  visible on the machine record.
- `poc/hub/test/relayIntegration.test.ts:865` — `"reclaims its own sessions across a relay
  restart, with no ownership collision"`, in the `"machines and repos, across the wire"` block
  (commit `695bafa`) — a real `Relay` stopped and restarted with the same `uplinkId` against a
  real `startHub`, asserting no `already owned by another machine` line is logged at all and the
  reclaimed session carries the post-restart facts.
- Live walk (spec §11 / this plan's Task 13): `.superpowers/sdd/2026-07-29-machines-repos/task-walk-brief.md`
  kills and relaunches a daemon under the same `MPAI_HOME` and reads the hub's own log for the
  absence of the refusal line — the one check no unit test can stand in for, since it is the
  live reconnect timing this entry's "no protocol needed" claim depended on.

**What remains, honestly.** Spec §3.2's "runId trap" can now actually be exercised — a laptop
that restarts re-adopts its sessions instead of never returning, so a second run genuinely gets
appended — but no test drives that specific trap end-to-end yet, only the reclaim scenarios
above. A closed laptop lid still fires no graceful shutdown (PRD §8.7), so an abrupt kill and a
clean restart are not distinguished by anything; harmless here because reconnect works either
way, but worth knowing before this dissolution is cited to close anything about shutdown
ordering. Neither blocks this section.

**Walk finding W4 — resolved alongside this.** `.superpowers/sdd/2026-07-28-projects/progress.md:588`
recorded, from the prior (projects-branch) live walk: *"machine labels in session rows are raw
per-launch uplink UUIDs (debt §2.3's grain)"* — a direct symptom of the identity problem above: no
stable id meant no stable name to show, so the client fell back to printing the raw id. Dissolved
by the same machine-identity work plus `poc/client/src/components/SessionPicker.tsx` (commit
`8665591`, `feat(client): repo labels and machine names replace raw keys (W4)`): the repo group
head (`SessionPicker.tsx:213`) and the session-row `spwho` line (`:228-229`) now look every
`repoKey`/`machineId` up in `labels`/`machineNames` maps built off the live `machines` list
(`:118-119`, via `repoLabels`/`poc/client/src/repoChoices.ts`) before falling back to the raw id
— which also closes the sibling gap the same walk observed one line above it ("two repo groups
headed by repo key," i.e. raw keys, not just machine UUIDs), per the machines-repos spec §8's
broader "names everywhere UUIDs render" framing. **No client component-test infrastructure
exists** (§3 below), so this is asserted by live walk only, not a unit test — see the walk
brief's visual-confirmation step.

### 2.4 The hub refuses a `join` to an offline session, so its stored history is unreachable

`poc/hub/src/hub.ts`'s browser `join` handler answers
`no machine is running session "<id>" right now` and returns **before** the replay from
`store.eventsFor`. The hub holds the whole transcript (that is the stated payoff of keeping
sessions after `detach`), but no browser can read it once the owning laptop is offline: the
picker row renders `OFFLINE`, JOIN still navigates, and the session view opens empty with
`PARTY · 0`. Observed live during Task 8's walk (item 6). The fix is to replay and snapshot
first and only refuse the *drive/approve* paths, which `tunnel()` already does on its own.

### 2.5 The invite flow is dead through the hub — needs design, not a patch

`peek_invite` is sent by `poc/client/src/components/InviteLanding.tsx:24` and
`InviteSignIn.tsx:17`. The hub's `HUB_HANDLED` set (`poc/hub/src/hub.ts:18`) covers only
`watch_project` and `peek`, so `peek_invite` falls through to `tunnel()` and — on a socket that
has not joined a session, which is every invite landing by definition — is answered
`"join a session first"`. The landing page renders `INVITE UNAVAILABLE`. **Every invite link is
broken against a hub.** Found by the v7b1 whole-branch review; not a regression, the flow was
never wired.

**Why it is not a two-line fix.** The hub cannot *answer* it: invites live on the laptop, in
`poc/server/src/invites.ts`, keyed by a token the laptop minted. It cannot *route* it either:
the token encodes a project and session that only the laptop can decode, so the hub has nothing
to select an uplink by — and it has no identity plane of its own until v7b2.

**Fixed looks like** one of: (a) a hub-side invite store, which means the hub mints and
redeems, which means it needs v7b2's identity first; (b) an unauthenticated
`peek_invite`-by-broadcast to every uplink in every project, first non-error wins — cheap, but
it hands an unauthenticated caller a probe across every laptop, so it needs the §10 floor too;
or (c) putting the projectId in the invite URL so the hub can pick the project, then
broadcasting only within it. All three are v7b2-or-later. Sits next to the `create_session`
bound in the v7b1 plan's "Known bounds" list.

### 2.6 Deployed no-workspace mode shows a misleading "no machine" refusal (was: quietly disabled)

Ruled 2026-07-28 (user, session #18, "option 1"): **ship as-is, disclose in the projects PR,
design later.** Introduced as a side effect of the solo-mode "1+" fix (`9749d53`): the deployed,
no-workspace server (`poc/server/src/main.ts` passes no `workspace`, see §2.2) now emits a real
`ProjectSummary` whose `machines` list is empty, so `canAct`
(`poc/client/src/projectAccess.ts:15`) returns `"no-machine"` where the client previously ended
up with `null`. The project screen then hides NEW SESSION, relabels every JOIN to WATCH, and
`refusalText` (`projectAccess.ts:24`) advises *"run `mpai --hub <url> --project <id>`"* — a dead
end on a deployment that has no hub either. Net change: disabled-button → misleading refusal.

**Why deferred:** `deploy/RUNBOOK.md` has never been executed, so no live deployment shows this;
and the honest fix is a design call (what *should* a session-incapable deployment say?), not a
patch. **TRAP for whoever picks this up:** having the server report a machine with
`repoKey: ""` makes it worse — `chosenRepo` becomes `""` and CREATE re-enables onto a server
that cannot provision (recorded in the projects ledger, Fix wave 1, I3).

**Cite refreshed 2026-07-29 (branch `feature/machines-repos` whole-branch review) — the
paragraph above is now stale, not current behavior.** `chosenRepo` no longer exists:
`SessionPicker.tsx`'s repo selection is `chosen` (`chooseRepo(choices, picked)`, `:113`), built
off `repoChoices(machines)` — a list of real `(machine, repo)` pairs — rather than a bare
`repoKey` string a machine could report as `""`. And the mechanism the TRAP warned about has
flipped direction: `canCreate` (`:128`) requires `chosen !== null`, so a machine reporting zero
usable repos now means `choices` is empty, `chosen` is `null`, and CREATE stays **disabled** —
not re-enabled onto a server that cannot provision. The question this section asks — what a
session-incapable deployment should say — is still open; only the old TRAP's code shape is gone.

**Fixed looks like:** a deliberate "this deployment can't host sessions" state with truthful
copy (and no hub advice when there is no hub), or restoring the quiet disabled state — chosen by
spec, with a component-level test once §3's infrastructure exists.

### 2.7 Attach/detach state is in-memory only — a daemon restart silently reverts every attached repo to candidate

`poc/server/src/server.ts:677-742` (the `attach_repo`/`detach_repo` handler) mutates the
in-process `repos` Map — flips `attached`, sets/clears `workspace` and `defaultBranch` — and
writes nothing to disk. Attach a candidate repo from the MACHINES panel, then restart the daemon
for any reason (crash, deploy, `mpai` relaunched by hand), and that repo is back to an unattached
candidate exactly as the launch-time scan (`machineRepos.ts`) found it, with no record anywhere
that anyone ever attached it. **User-visible composite behavior:** a repo a teammate attached
yesterday can silently vanish from the create form's repo picker today — no error, no log line,
nothing distinguishing "never attached" from "attached, then reverted by a restart nobody
connected to this." Found during the 2026-07-29 whole-branch review of `feature/machines-repos`;
not a regression against prior behavior — attach/detach are new this branch (Task 6, spec §6) and
were never durable.

**Why deferred:** no spec section asks for durability
(`docs/superpowers/specs/2026-07-28-machines-repos-design.md` §5–§6 describe the wire protocol
and the in-memory repo set; surviving a restart is out of scope as written), and today an `mpai`
restart is still a manual, operator-driven event rather than the kind of always-on daemon a
silent revert would ambush someone on.

**Fixed looks like:** persist the attached set (or just its delta from the launch-time scan)
alongside `machine.json` in `$MPAI_HOME`, restored when `startServer` builds its repo map — before
the scan's candidates are merged in — so a scanned candidate matching a persisted-attached key
starts attached instead of starting as a candidate the operator has to re-attach by hand. Needs a
design call on ordering (persisted state vs. a candidate the scan no longer finds, or a candidate
whose root moved) before it is a patch rather than a decision.

---

## 3. Test coverage gaps

- **No component/hook test infrastructure.** Named here because two A2a Criticals and two
  invite Criticals were client-side and none of them can have a regression test today. Most
  acute: reverting the single line `userId={selfId}` in `App.tsx` reintroduces the
  "permission gate unanswerable" Critical with all client tests green (HANDOFF §4g).
- **`ThinkingStrip.tsx` is entirely untested** — roster, swap, keyboard, capture flag, RAF,
  localStorage. Caused the swap crash in `docs/mistakes-and-fixes.md:9-14`.
- **Live-behaviour drift is the recurring failure class**, not a coverage percentage. Three
  incidents so far: the `skills:"all"` reversal, `canUseTool` shadowing, and the
  `<label>`/`<select>` focus trap. v7's equivalents are named as required verification in the
  v7 spec §5.

---

## 4. Deferred minors — pointers, not duplicates

These are recorded in detail in `HANDOFF.md` and are not copied here, so there is one source of
truth per item:

- Invite system deferred minors and stated non-claims — HANDOFF §6b.
- Oversight deferred minors — HANDOFF §7 (final-review triage list).
- Workflows deferred minors — HANDOFF §7.
- Session-launcher deferred minors — HANDOFF §7.
- Arrow-navigation deferred items — HANDOFF §7.
- Carried v3–v6c items (worktree-containment approvals, Bash-allowlist two-hop risk,
  frontend-design polish, meta-tools bypass) — HANDOFF §7 tail.
- **v7 scrub candidates: `poc/server/src/auth.ts` and `poc/server/src/staticFiles.ts` go dead
  for hub-attached `mpai` once v7b2 lands.** The hub serves the client and (from v7b2) owns
  sign-in, so a laptop launched with `--hub` needs neither. Both stay live for standalone
  `mpai`, so this is a scrub-pass question ("is standalone still a supported mode?"), not a
  deletion — noted per the v7b1 plan's closing checklist.
- **The client never reconnects its session WebSocket** (`poc/client/src/useSessionSocket.ts` —
  `ws.onclose = () => setConnected(false)`, no retry). Pre-existing and equally true standalone,
  but the hub makes it load-bearing: a hub restart strands every browser on a dead socket showing
  a stale roster and live-looking APPROVE buttons that silently do nothing (the click logs
  `WebSocket is already in CLOSING or CLOSED state`). Only a manual reload recovers. Observed
  during v7b1 Task 8's walk, item 4.

---

## 5. Optimization — noted, none urgent

- `arcadeRecords` (`poc/server/src/project.ts:52-82`) walks **every event in every session** on
  each throttled project push. Fine for an in-memory POC; the upgrade path is an incremental
  best-map. Becomes relevant when the hub aggregates many teams.
- `useArrowNav` recomputes every element rect on each keypress (~30 elements, sub-millisecond,
  but O(n) per press).
- Project snapshots are recomputed wholesale on every push rather than diffed. Under v7 the hub
  fans these out to every browser, so a diff or a per-session dirty flag is worth revisiting
  then — not before.
