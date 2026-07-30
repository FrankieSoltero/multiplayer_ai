# Awareness — file-collision detection across sessions (PRD §8.8, first half)

Scope ruling (owner, 2026-07-30): §8.8 is split. This spec covers **collision detection**
end-to-end (laptop signal → hub → UI → agent tier). "Oversight configured hub-side" is a
separate follow-up branch (spec §3.7 territory: host-configured key custody).

## 1. Problem

The thesis (PRD §1.1): sessions stay isolated; only enough *signal* is shared for people and
agents to avoid colliding. Today no collision signal exists at all — two sessions in the same
repo edit the same files and nobody learns until merge time. The agent's system prompt
(`agentDriver.ts:189`) already *promises* teammate-overlap awareness that nothing implements.

## 2. Banked decisions (session #11, ratified here as the baseline)

1. **Collision definition:** two sessions in the same repo group have both **diverged from
   their shared base on the same path** — git-derived, whole-file. No hunk/semantic analysis.
2. **Advisory only** — awareness and warnings, never locks, never task boards.
3. **Surfaces:** its own header badge in a **calm colour** (amber stays reserved for permission
   gates), sharing the OTHER PARTIES row rail; per-repo group indicator on the session list.
4. **Agent tier, two levels:** (a) the prompt digest names contested files; (b) **auto-approve
   is withdrawn** for a write to a contested path — the gate asks a human, once per file per
   session.
5. **On by default.**
6. **Ended sessions included** while their divergence is still real, and labelled as ended.
7. **Accepted bound (PRD):** forks do not group — different remotes → different repoKeys.

## 3. The signal: `touched` — repo-relative changed paths per session

### 3.1 Computation (laptop-side, per session worktree)

`touchedFiles(workdir, baseRef): string[]` — union of:
- committed divergence: `git diff --name-only <merge-base(baseRef, HEAD)>..HEAD`
- uncommitted work: `git status --porcelain` paths (agents frequently never commit)

Paths are **repo-relative** (as git emits them), deduped, sorted, capped at `TOUCH_CAP = 500`
(over-cap sets are truncated after sort and flagged with a final literal entry `"…"`). Rename
entries contribute both sides. Computation shells out to git in the session's worktree; a git
failure yields the previous value (stale beats absent) and logs once.

### 3.2 Freshness (owner ruling, 2026-07-30)

Recomputed at **turn boundaries** (on `turn_end` append) and **before answering a permission
gate** whose tool is a write (so tier (b) always judges against fresh data). No file watchers.
A mid-turn write becomes visible at the next boundary — accepted.

### 3.3 Transport

`SessionFacts` gains `touched: string[] | null` (null = no repo / never computed). Produced by
`sessionFactsOf`, validated in `relayProtocol` (array of strings, each ≤ 512 chars, length ≤
TOUCH_CAP + 1; additive optional field, **no protocol version bump** — v2 validators tolerate
it). The hub stores and passes it through like every other facts field; it therefore persists
in the §8.7 journal for free and survives hub restarts.

## 4. Derivation: `collisionsFrom` — pure, shared

New pure module in the server package beside `record.ts` (same reuse pattern, exported as
`multiplayer-ai-server/collisions`), consumed by hub-side/solo-side digests and (types +
function) the client:

```
CollisionInput = { sessionId, repoKey, lifecycle, touched }
Collision      = { repoKey, path, sessionIds: string[] }   // sessionIds.length ≥ 2
collisionsFrom(sessions: CollisionInput[]): Collision[]
```

Group by `repoKey` (null/absent excluded); a path appearing in ≥ 2 sessions' `touched` within
a group is a collision. The truncation sentinel `"…"` never matches. Closed sessions
participate (banked decision 6) — their `touched` reflects their last computed divergence.
Deterministic: output sorted by repoKey, then path, then sessionIds ascending.

## 5. Surfaces

- **Session list (project screen):** per-repo group head gains a contested chip
  (`⚠ N contested`) when its group has collisions; per-session rows involved get a `contested`
  marker beside the state badge; ended sessions show it with their CLOSED label (banked 6).
- **Session view header:** a new badge beside `🔐 PULLS ▸ N`: `⚠ CONTESTED ▸ N` where N =
  contested paths involving *this* session; calm colour token (not amber); hidden at 0.
- **OTHER PARTIES rows (PartyPane):** a row whose session shares contested paths with yours
  lists up to 3 of them (`⚠ shares: src/a.ts, src/b.ts +2`).
- All client-side derivation via `collisionsFrom` over the snapshot's facts — no new wire
  reads; it rides the existing 1s-throttled project push on both servers.

## 6. Agent tier

- **(a) Digest:** the per-prompt `<teammates>` block gains contested-path lines
  ("`session X (driven by Y) has also changed: src/a.ts, src/b.ts`"). In hub mode the laptop
  cannot see other machines' sessions today (`digestFor` iterates the local map), so the hub
  sends a compact **`contested` down-frame** to each affected uplink whenever the project's
  collision set involving that session changes (piggybacking the existing push throttle):
  `{ type: "contested", sessionId, paths: string[] }` (paths capped at TOUCH_CAP). The laptop
  stores it per session; digest and tier (b) read the union of local derivation and the hub's
  frame. Solo mode needs no frame — all sessions are local.
- **(b) Auto-approve withdrawal:** when a permission request targets a write tool
  (Edit/Write/NotebookEdit — `file_path ?? notebook_path`) whose repo-relative path is
  currently contested, an auto-approval is suppressed and the gate asks a human. Asked **once
  per (file, session)**: after any human decision on that file, subsequent writes to it follow
  the normal rules again. The gate's UI line names why: `contested with session X`.
- Signal only, never artifact (thesis §1.1): paths, session ids, and driver names cross
  sessions — never transcript content.

## 7. Tech-debt §2.1 fix (owner ruling, 2026-07-30: root cause, this branch)

Worktree provisioning becomes **project-scoped**: key `(projectId, slug)`, path
`<repoRoot>/.mpai/worktrees/<projectId>/<slug>`, branch `mpai/<projectId>/<slug>`. The
idempotent-reuse check runs against the project-scoped key. Existing worktrees under the old
flat scheme are not migrated (POC posture — old sessions keep working until closed; new
sessions provision under the new scheme; disclosed in the PR). Debt §2.1 closes; collision
derivation then never needs same-working-copy dedup.

## 8. Non-goals

1. Hub-side oversight configuration — split to its own branch (scope ruling above).
2. Locks, reservations, task boards — advisory forever (banked 2).
3. Hunk/semantic-level conflict prediction — whole-file only.
4. Mid-turn freshness / file watchers — turn boundaries + gates only.
5. Fork grouping — PRD's accepted bound.
6. Cross-transcript sharing of any kind — thesis.

## 9. Testing

- `touchedFiles`: real temp-git fixtures — committed divergence, uncommitted files, renames,
  cap + sentinel, merge-base after base advances, git-failure staleness.
- `collisionsFrom`: pure tables — grouping, null repoKey exclusion, closed sessions included,
  sentinel never matches, determinism/order, ≥3-way collisions.
- Relay: facts round-trip with `touched`; `contested` down-frame delivery + per-session
  storage; hub restart preserves `touched` via the journal (extends §8.7's restart harness).
- Gate tier: auto-approve suppressed exactly once per (file, session); non-contested writes
  unaffected; the gate line names the other session.
- UI: render tests for badge/chip/row lines against `collisionsFrom` fixtures.
- Live walk: two sessions, one repo, overlapping edits — badge, chip, PartyPane line, digest
  block, and a withheld auto-approval observed for real; solo-mode parity leg.

## 10. Open questions (not blocking)

1. Should the RECORD panel eventually mark historically-contested turns? (Display-only; defer.)
2. `touched` staleness display — show "as of turn N"? Defer until it confuses someone.

## 8a. Owner rulings (2026-07-30)

1. **Scope:** §8.8 split — collisions this branch; hub-side oversight follows separately.
2. **Freshness:** turn boundaries + pre-gate recomputation; no watchers.
3. **Debt §2.1:** fixed at the root here — project-scoped worktree provisioning.
4. **§6b kill switch:** env `MPAI_CONTESTED_GATE=0` restores today's auto-approve path
   entirely (default ON per banked decision 5); discriminating test required. Covers the
   degenerate case (huge touched set → auto-approve effectively off repo-wide, still never
   blocking a write).
5. **§3.3 exposure:** `facts.touched` broadcasting full per-session path lists to all project
   members (and into the hub journal, journal retention policy applying) is ACCEPTED — same
   exposure class as the record's filesChanged; sweep together with v7b2 auth.
6. **§6a frame shape (amends §6a):** the down-frame is
   `{ type: "contested", sessionId, paths: string[], collisions: { path: string; sessionIds: string[] }[] }`
   so hub-mode gate reasons and digest lines can NAME the colliding session, as §6 requires.
7. **§7 old-scheme orphaning:** pre-branch flat-scheme sessions do NOT survive a daemon
   restart under project-scoped provisioning — their worktrees/branches sit unreferenced on
   disk. Accepted POC breakage; PR discloses; no legacy compat path.
8. **§3.2 sync latency:** `touchedFiles` runs synchronously with a 5s git timeout — a
   worst-case whole-daemon freeze of 5s at a turn boundary/gate is ACCEPTED (git name-only
   diffs are ms-scale in practice); revisit only on an observed freeze.
