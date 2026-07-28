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

### 2.3 A hub-attached laptop cannot reclaim its own sessions after a restart

`poc/server/src/cli.ts` passes no `uplinkId`, so `poc/server/src/server.ts`'s relay construction
mints a fresh `randomUUID()` on **every** launch. The hub keys session ownership on `uplinkId`
(`poc/hub/src/hubStore.ts` — `HubSession.uplinkId`, `ownerOf`, and `snapshot`'s
`presence` lookup), so after `mpai --hub` is restarted:

- every session the previous run owned stays bound to the now-`online:false` uplink and reads
  `offline` forever, with no machine able to adopt it; and
- if the restarted laptop re-creates a session with the same id, `setFacts` returns
  `session "<id>" ... is already owned by another machine` and `hub.ts`'s `facts` handler closes
  the uplink with 1008 — a same-machine restart is indistinguishable from the two-laptop
  collision that error was written for.

Observed live during v7b1 Task 8's two-process walk (2026-07-28); the hub logged the refusal
once per project push and the laptop reconnected into it each time.

**Consequence, stated plainly because it is the part that matters.** Task 6's entire resume
machinery is dead code in every real deployment: `hubStore.resumeOffsets`
(`poc/hub/src/hubStore.ts:79-88`) skips any session whose `uplinkId` differs, and the `have` map
it feeds (`poc/hub/src/hub.ts:181`) exists *solely* to serve a laptop returning under the same id
— which no laptop ever does. And the plan's central promise, that sessions survive on the hub
when a laptop goes away, **is false after any laptop restart**: they survive as unreachable
`offline` rows that no machine can adopt.

**No new protocol is needed — the takeover rule already ships.** `hubStore.setFacts`
(`hubStore.ts:100`) refuses ownership only when `existing.uplinkId !== uplinkId`, so a
reconnecting *same* identity silently re-owns its sessions; `hub.ts:227-230` already handles a
same-`uplinkId` socket superseding a stale one. Everything downstream of a stable id works today.

**What is actually open is narrow: the grain.** An uplink identity must be stable across restarts
*and* distinct per machine. `WorkspaceManager.repoKey()` (`poc/server/src/workspace.ts:79-86`)
supplies the stable-per-repo half and is already in hand at `poc/server/src/server.ts:1006` as
`repo?.key` — but note it is **deliberately shared across machines** when the repo has an
`origin` (that is its entire purpose, grouping teammates by repo, spec §3.3), so it cannot be the
uplink id on its own. The machine-scoping ingredient already exists beside it: `localRepoKey`'s
`hostname` + hashed `repoRoot` (`poc/server/src/repoKey.ts`). So the decision is "is one uplink
per repo-per-machine the right grain, and what should a *second* `mpai` on the same repo do —
refuse, or share?", plus close to a one-line default at `server.ts:1007`. A grain decision, not a
protocol project.

Also the reason spec §3.2's "runId trap" could not be exercised at all: the laptop never
re-adopts the session, so a second run is never appended.

### 2.4 The hub refuses a `join` to an offline session, so its stored history is unreachable

`poc/hub/src/hub.ts`'s browser `join` handler answers
`no machine is running session "<id>" right now` and returns **before** the replay from
`store.eventsFor`. The hub holds the whole transcript (that is the stated payoff of keeping
sessions after `detach`), but no browser can read it once the owning laptop is offline: the
picker row renders `OFFLINE`, JOIN still navigates, and the session view opens empty with
`PARTY · 0`. Observed live during Task 8's walk (item 6). The fix is to replay and snapshot
first and only refuse the *drive/approve* paths, which `tunnel()` already does on its own.

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
