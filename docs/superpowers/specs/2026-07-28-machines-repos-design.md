# Machines & repos (design)

*PRD §8.3. Brainstormed and approved section-by-section in session #19 (2026-07-28); the
six pre-locked rulings are in `.superpowers/sdd/2026-07-28-machines-repos/brainstorm-state.md`.
This spec is the document of record for the section — where the eventual plan's code
disagrees with it, this spec governs.*

## 1. What this builds

A **machine** becomes a first-class, durable thing: a daemon with a persisted identity that
survives restarts, a human name, and a **set** of repos it offers — instead of today's
per-process UUID welded to exactly one repo. Repos can be attached and detached from the hub
UI, chosen from a daemon-enumerated candidate list. Sessions bind to a repo at creation and
say so.

### 1.1 The user-facing result

- The entrance and project screens show **machine names** (e.g. `franks-mbp`), never UUIDs.
- One `mpai` daemon can serve several repos into a project. The create-session form's repo
  select lists real `(repo, machine)` choices with human labels.
- A MACHINES panel on the project screen shows each machine, its attached repos (DETACH),
  and its remaining candidates (ATTACH).
- Restarting a laptop no longer orphans its sessions: the daemon comes back as the *same
  machine* and silently reclaims them (dissolves debt §2.3, most of §1.5b, walk finding W4).

## 2. Decisions

All user-approved; do not re-litigate.

| # | Decision | Why |
|---|---|---|
| D1 | Full §8.3 scope in ONE spec: identity grain + multi-repo daemon + hub-UI attach/detach + path-picker resolution + session scoping. | The pieces constrain each other; splitting them re-opens each seam twice. |
| D2 | Machine = daemon instance with persisted id in `~/.mpai/machine.json` `{ machineId, name }`; name defaults to hostname; `MPAI_HOME` env override; `--machine-name` flag for a one-launch display-name override. | Stable identity is what makes restart-reclaim, honest labels, and detach semantics possible. The env override keeps two daemons on one laptop possible — the dev walk depends on it. |
| D3 | Repo attach = pick from a **daemon-enumerated candidate list** (allowlisted roots via repeatable `--root` flag or `roots` in machine.json; flag wins). No typed paths, no browsing. | Resolves open question "path picker for a headless machine" by refusing to build one: the daemon advertises a fixed list, so the browser can never turn attach into an arbitrary-path read primitive. |
| D4 | Session ids stay **project-unique**; URLs unchanged; create-time dedupe (`freeSessionName`) handles name collisions; stable machineId makes restart-reclaim ride hubStore's existing same-uplinkId ownership rule. | No machine-scoped session keys — smallest change that keeps every existing URL and ownership check working. |
| D5 | Detach is **refused** while the repo has open-lifecycle sessions, with an error listing the blockers by name. No drain state, no force-kill. | Honest and simple; a drain state is machinery this section doesn't need. |
| D6 | Approach A: evolve the uplink protocol in place. `RELAY_PROTOCOL_VERSION` 1→2; one uplink per machine; repos as a set on the hello. No v1 compatibility shim. | Hub and laptop live in one repo and upgrade in lockstep; a mismatch rejected loudly at hello beats a half-understood uplink misbehaving later (`relayProtocol.ts:9-11`'s standing policy). |
| D7 | The create form's `baseRef` field **stays** exactly as shipped. | It is a pass-through string with no enumeration cost anywhere, and removing it breaks stacked/hotfix/PR-review workflows to save one ignorable field. |
| D8 | Default base ref for **attached** repos comes from `origin/HEAD`; only origin-less repos fall back to the current checkout. The cwd-launch repo keeps today's current-checkout default. | `defaultBranch()` returns whatever branch the main checkout is *sitting on* (`workspace.ts:68-74`). Right for the repo you launched from; a stale-branch trap for an allowlist repo nobody has positioned in months. |
| D9 | `RepoDecl` carries `defaultBranch: string \| null` (null for unattached candidates). | The base-ref prefill is null in hub mode today; this makes D8 visible in the form, per selected repo. |
| D10 | The snapshot's single `repo` field is **retired** (the hub already sends `repo: null`, `hubStore.ts:354-357`; standalone stops sending it). Client consumers of `RepoInfo` migrate to the machines list. | One snapshot shape for both servers; the machines list now carries everything the single field did. |

**Explicit non-goal (user-approved):** one daemon = one hub = one project per launch, exactly
as today. Multi-project machines are a future axis, not this spec.

## 3. Machine identity

A new module `poc/server/src/machineIdentity.ts` owns the identity file.

- **Location:** `$MPAI_HOME/machine.json`, `MPAI_HOME` defaulting to `~/.mpai`.
- **Shape:** `{ machineId: string, name: string }`, optionally `roots: string[]` (D3).
- **First run:** mint `randomUUID()`, name = `os.hostname()`, write atomically (temp file +
  rename) so a crashed first run can't half-write identity.
- **Every later run:** read the same id back. A corrupt or unreadable file **refuses launch**
  with a message naming the file — never silent regeneration, which would mint a new identity
  and orphan every session the hub attributes to the old one.
- **Wiring:** `cli.ts` loads the identity and passes `uplinkId: machineId` and `name` into
  `startServer`'s hub options, replacing the per-process mint at `server.ts:1105` (the
  `?? randomUUID()` fallback stays for direct-API test construction only).
- **Standalone:** the fake "machineId = repoKey" (`project.ts:200,254`) is replaced by the
  real persisted machineId, so solo shows the true machine name too.

## 4. The repo candidate list

- Allowlisted roots: repeatable `--root <path>` flag; `roots` in machine.json is the
  persistent form; the flag wins when both are present.
- **Scan, at launch:** each root contributes the root itself if it is a git repo, otherwise
  its immediate children containing `.git`. Depth 1, no recursion — bounded and predictable.
- The candidate list is **fixed for the daemon's lifetime**; a freshly cloned repo needs a
  daemon restart to appear. (Rescan-on-demand is future work if this hurts.)
- A plain `mpai` launch auto-attaches the cwd repo exactly as today; it enters the repo map
  pre-attached with the current-checkout default branch (D8's cwd carve-out).
- A `--root` that doesn't exist or isn't a directory refuses launch. A root with zero git
  repos is legal. Two candidate paths resolving to the same repoKey (two clones of one
  origin): first wins, the duplicate is skipped with a launch-log warning naming both paths.
- Repo **label** = the repo directory's basename.

## 5. Protocol v2

### 5.1 RepoDecl

```ts
interface RepoDecl {
  key: string;             // repoKeyFor() output, ≤200 chars (today's bound)
  label: string;           // human name (basename), ≤100 chars
  attached: boolean;       // serving sessions vs. merely available to attach
  defaultBranch: string | null;  // D8 value for attached repos; null for candidates; ≤100 chars
}
```

The repos list is capped at **100 entries**, enforced twice and never silently: `parseUpFrame`
rejects a hello or `repos` frame with more (boundary rule, D6), and a launch whose scan yields
more than 100 candidates **refuses to start**, naming the offending root — a truncated list
would misrepresent the machine, and an allowlist that big is a config error.

### 5.2 Hello v2 and the `repos` frame

`RELAY_PROTOCOL_VERSION = 2`; mismatches keep being rejected at the frame boundary, no shim
(D6). Today's hello `{ t, v, uplinkId, projectId, repoKey }` (`relayProtocol.ts:41`) becomes:

```ts
{ t: "hello", v: 2, uplinkId: string /* = machineId */, name: string /* ≤40, identity parity */,
  projectId: string, repos: RepoDecl[] }
```

One new up-frame:

```ts
{ t: "repos", repos: RepoDecl[] }
```

sent whenever the daemon's set changes (after an attach/detach lands). It is always the
**full authoritative list, replacing** the hub's record — never a diff. That neutralizes the
scout's re-attach trap: the hub's record is only ever overwritten wholesale from the
machine's own list; there is no single-key rewrite path.

`SessionFacts.repoKey` (`relayProtocol.ts:35`) is unchanged on the wire — constant per
uplink today, it becomes genuinely meaningful per session.

### 5.3 Attach/detach are client messages, not relay frames

`attach_repo { machineId, repoKey }` and `detach_repo { machineId, repoKey }` ride as
ordinary client messages: browser → hub, hub routes to the target machine through the
**existing** tunnel + `pendingReplyFrom` reply-grant machinery (exactly like routed
`create_session`, hub.ts:520-559), daemon answers via the existing `reply` frame, then emits
the `repos` up-frame. One routing mechanism; identity stamping and refusal text for free.
The known one-in-flight-per-channel reply bound applies to them as it does to
`create_session` (§9).

`create_session` gains an **optional `machineId`**: when present the hub routes to that
machine and verifies it offers the repo; when absent it falls back to today's
first-online-match (§7).

## 6. The server-side repo set

The single `repo` const (`server.ts:147-155`) becomes `repos: Map<string, RepoEntry>` keyed
by repoKey:

```ts
interface RepoEntry {
  key: string; label: string; root: string;
  attached: boolean;
  workspace: WorkspaceManager | null;   // constructed at attach time only
  defaultBranch: string | null;          // computed at attach time (D8)
}
```

- Candidates enter with `attached: false`, no workspace. Attach constructs
  `WorkspaceManager(root, root/.mpai/worktrees)` and computes the D8 default branch.
  (Worktrees stay per-repo under each repo's own root — debt §2.1 is adjacent but
  unaffected.)
- The cwd-launch repo enters pre-attached; a plain `mpai` launch behaves byte-for-byte as
  today.

**Sessions bind to a repo at create.** `ProjectSessionEntry` gains `repoKey`, set at
creation. `create_session` (`server.ts:707-712`) stops discarding `msg.repoKey` (scout
blocker d): present → resolve through the map, refusing unknown or unattached keys; absent →
the single attached repo, or refuse with "specify a repo" when several are attached. The
deep-link-join provisioning path (`server.ts:259-263`) uses the entry's bound repo when the
session exists; a never-created session falls back to the lone attached repo or refuses when
ambiguous.

**Zero attached repos** must behave exactly like today's `repo === null`: `create_session`
refuses ("server not launched in a repo", `server.ts:707`) and deep-link join falls through to
the `AGENT_WORKDIR_ROOT` path (`server.ts:265-268`). That branch is the deployed no-workspace
mode the user ruled to ship as-is (I3, debt §2.6) — this spec must not regress it.

**New handlers** `attach_repo` / `detach_repo`, with `create_project`'s exact gate posture:
`denyUnauthed()` on the direct arm, no-op on the relay arm where the hub has already stamped
identity (the C1 rationale, `server.ts:439-450`). Semantics in §9. Both ack, push the
full-list `repos` frame to the relay, and push affected project snapshots. Because the
handlers live on the laptop, **solo mode gets attach/detach for free** on the direct arm.

**Fan-out to the remaining single-`repo` sites:** facts (`server.ts:221`) carry the
session's own `repoKey`; snapshot/summary/peek (`:202, :484, :630`) carry the machines list
instead of the retired single `repo` field (D10); the Relay constructor (`:1104`) takes the
machine name plus the RepoDecl list instead of one `repoKey` string, and gains a way to send
the `repos` frame on change.

## 7. Hub store

- `Uplink` (`hubStore.ts:23-28`) → `{ uplinkId /* machineId */, projectId, name,
  repos: RepoDecl[], online }`; the scalar `repoKey` is gone. `attach()` takes `name` and
  the hello's repo list; a new `setRepos(uplinkId, repos)` applies the `repos` frame.
  Both are wholesale replacement (§5.2).
- `MachineInfo` — declared three times (`hubStore.ts:46-50`, `project.ts:156-170`, client
  `types.ts:87`) — becomes `{ machineId, name, repos: RepoDecl[], online }` in all three.
  The scalar is **dropped, not kept alongside**; client consumers migrate (§8).
- `publish()`'s synthesized facts for a not-yet-declared session (`hubStore.ts:273`) use
  `repoKey: null` (the type already allows it): the hub honestly doesn't know the repo until
  the facts frame says so, and that overwrites moments later.
- **Restart-reclaim needs no store change**: `setFacts`' same-uplinkId ownership check
  (`hubStore.ts:232`) and hub.ts's same-id supersede rules (`hub.ts:296-306`) start working
  the moment the id is stable. A named test pins this (§11).
- **Routing:** first-online-match by scalar (`hub.ts:535-537`) becomes "first online machine
  whose repo list contains that key, attached". With an explicit `machineId` the hub routes
  to that machine after verifying it offers the repo, refusing otherwise (§9). The
  create-flow ownership pre-check (`owner !== target.machineId`) is unchanged.
- Sessions on a detached repo need no handling: sessions outlive machines by design
  (`hubStore.ts:179-181`), keep their own `repoKey`, and detach is refused while any are
  open — only ended sessions can be labeled with a repo their machine no longer offers,
  which is accurate history.

## 8. Client UI

- **Repo select** (`SessionPicker.tsx:207-211`): one option per **(machine, attached
  repo)** pair, labeled `"<repo label> — <machine name>"`; selection state is the
  `{ machineId, repoKey }` pair `create_session` sends. Default choice: explicit selection,
  else the first attached repo of the first online machine (standalone no longer needs the
  `repo?.key` special case — solo reports a real machine with a real list).
- **Base-ref prefill** (`:99`): from the selected repo's `RepoDecl.defaultBranch` (D9),
  re-prefilling when the selection changes. Empty still means "laptop applies its default"
  server-side (`server.ts:708-711`).
- **Names everywhere UUIDs render** (walk finding W4): session rows (`:175`) show
  `repo label · machine name`; group heads (`:161`) show labels via a key→label map built
  off the machines list, falling back to the raw key for a repo no machine currently
  offers. When two distinct keys share a label, group heads append a short key prefix to
  disambiguate.
- **MACHINES panel** on the project screen: each machine by name with online state, attached
  repos each with DETACH, remaining candidates each with ATTACH. Rendered only when
  `refusal === null` — absent, not disabled, for spectators (projects spec §4.4 rule).
  ATTACH/DETACH reuse the create button's pending + 30s timeout pattern
  (`SessionPicker.tsx:15-21, 117-121`) — same routed-command no-reply failure mode. A detach
  refusal prints the blocker list verbatim in the panel's error line.
- The retired `RepoInfo`/single-`repo` consumers are swept as part of the plan (D10).

## 9. Error paths

**Launch-time — fail loud, never limp:** corrupt `machine.json` refuses launch (§3);
nonexistent/non-directory `--root` refuses launch; empty roots are legal; duplicate repoKey
first-wins with a warning (§4).

**Laptop handlers — idempotent acks, specific refusals:**

| Case | Behavior |
|---|---|
| `attach_repo`, key already attached | idempotent ack (matches `create_session`'s existing-session ack) |
| `attach_repo`, key not a candidate | refuse: "not in this machine's repo list" |
| `attach_repo`, git fails computing default branch / workspace | reply the git error; stay unattached |
| `detach_repo`, open-lifecycle sessions bound to key | refuse listing blockers by name: `cannot detach: 2 open sessions (auth-fix, perf-spike)` (D5) |
| `detach_repo`, candidate but already detached | idempotent ack |
| `detach_repo`, never a candidate | refuse: unknown repo |
| `create_session`, no repoKey, >1 attached | refuse: "specify a repo" |
| `create_session` / deep-link join, zero attached | today's `repo === null` behavior, unchanged (§6, I3) |
| `create_session`, unknown/unattached repoKey | refuse |
| deep-link join, no entry, >1 attached | refuse: create it from the project screen |

**Hub — refuse before tunneling:** unknown machineId, offline machine, or a machine that
doesn't offer the named repo (create with explicit machineId; attach/detach always) → the
hub answers the error itself and never spends the channel's one reply slot on a doomed
tunnel. Gate order mirrors routed `create_session`: identify → membership → project
active → resolve machine → grant → tunnel. A `repos` frame from an unknown uplink is
dropped.

## 10. Out of scope

- Multi-project machines (one daemon = one hub = one project per launch stands — D6 non-goal).
- Drain states or force-kill on detach (D5).
- Candidate-list rescan without a daemon restart (§4).
- v1 protocol compatibility (D6).
- The v7b1 "uplink fails silently" residual (handoff open question 4) — §12 notes the one
  place it intersects.
- PRD §10 Q2/Q3 (entrance scale, project `intent` line) — untouched by this section.

## 11. Testing

- **`machineIdentity` unit:** first-run mints and persists; second read returns the same id;
  corrupt file throws (never regenerates); `MPAI_HOME` redirects; name defaults to hostname.
- **Roots scan unit (real temp git repos):** root-is-a-repo; depth-1 children; non-repos
  ignored; nonexistent root throws; duplicate key first-wins.
- **`relayProtocol`:** hello v2 accepted; v1 rejected; repos cap and RepoDecl bounds
  enforced; `repos` frame parsed.
- **Hub store:** `setRepos` wholesale replacement; synthesized facts carry `repoKey: null`;
  routing picks online-machine-offering-attached-repo; machineId-directed routing refuses a
  non-offering machine; **a named restart-reclaim test** (re-attach same uplinkId,
  `setFacts` passes ownership) pinning the dissolution of debt §2.3.
- **Server handlers (mirroring the C1 gate tests):** attach/detach idempotent acks;
  candidate-only attach; detach refusal listing blocker names; `create_session` resolution
  (explicit / single-repo fallback / ambiguous refusal / unknown refusal); deep-link join
  binding and fallbacks; per-session repoKey in facts.
- **`relayIntegration.test.ts` — the seam net** (it found a Critical on its first scenario
  twice; it gets the money scenarios): full attach round-trip (tunnel → attach → `repos`
  frame → snapshot push); detach refusal end-to-end past an open session; restart-reclaim
  across a relay restart; v1-hello rejection; and the **blocker-(d) regression** — a machine
  offering two repos gets a routed `create_session` naming the second, asserted by *which*
  workspace provisioned, with the wrong repo's workspace proven untouched (two fake
  workspaces; one would pass vacuously). All reply scenarios use `laptopThatAnswers()`,
  never `laptop()` (no-op command plane).
- **Client:** select renders (machine, repo) pairs; base-ref re-prefills on repo switch;
  MACHINES panel gated by membership; blocker text rendered; attach/detach share the 30s
  timeout path.
- **Process rules:** every implementation dispatch carries revert-and-rerun; no predicted
  suite totals; single-repo *fallback* paths get fixtures as deliberately as multi-repo
  ones — three §8.2 defects hid exactly where nobody built a fixture.
- **Live walk (Task-13-style, end of plan):** two daemons on one laptop via `MPAI_HOME`
  override; attach a second repo from the hub UI; create a session in it; hit the detach
  refusal; restart a daemon and watch it reclaim its sessions.

## 12. Known bounds and honest disclosures

1. **One in-flight routed command per channel** (the pinned `create_session` bound) now also
   covers `attach_repo`/`detach_repo`. Documented, not fixed.
2. **Two daemons sharing one `MPAI_HOME`** present the same machineId and silently fight via
   the supersede rules (`hub.ts:296-306`), looking like machine flapping. The spec records
   this as the reason the env override exists; the hub logs supersede events so it's
   diagnosable.
3. **A v1 laptop against a v2 hub** is rejected at hello; the relay's reconnect loop retries
   into the same rejection. This inherits the v7b1 "uplink fails silently" residual — out of
   scope beyond the relay logging the version refusal distinctly.
4. **First-online-match routing** still applies when `create_session` carries no
   `machineId` (solo client, legacy messages); two machines offering the same repo are
   disambiguated only when the client names the machine.
5. **Candidate list is launch-fixed** — a new clone needs a daemon restart to appear (§4).
6. The laptop's `create_project` ack-only bound (no broadcast to other local entrance
   viewers) is pre-existing (`9749d53`) and untouched here.

## 13. Open questions

None blocking this spec. Resolved along the way: the path-picker question (D3 refuses to
build one); the stale-checkout default-branch trap (D8). Still open at the PRD level, not
here: PRD §10 Q2/Q3, spec §8.4's sub-session worktree question, and v7b1 residuals
(handoff open question 4) beyond the §12.3 disclosure.
