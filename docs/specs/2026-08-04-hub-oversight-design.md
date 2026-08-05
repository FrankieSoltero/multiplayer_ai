# §8.8 second half — hub-side oversight — design

**Closes:** PRD §8.8 *Final state* remainder ("Oversight configured hub-side"), split out by
the awareness spec's scope ruling (`docs/specs/2026-07-30-awareness-collisions-design.md` §143).

**User rulings (2026-08-04, all four decided in the question round):**
R1 hub host credentials · R2 member-gated toggle · R3 persist flag AND summary (HubDb v4) ·
R4 full agent parity (summaries pushed to uplinks).

## 0. The gap

The solo server has the whole oversight machine: `Overseer` (per-project 30s-debounced,
single-in-flight, coalescing summarizer over `OversightSessionDigest`s), `set_oversight`,
`pull_oversight` (one-shot `<oversight>` block injected at the next prompt), the `team_update`
agent tool text, and the client OVERSIGHT screen. The hub has none of it:
`hubStore.projectSnapshotFrom` hardcodes `oversight: { enabled:false, latest:null }`, and
`set_oversight`/`pull_oversight` are unanswered hub-side. A hub project spans laptops, so only
the hub can summarize the whole team — a laptop overseer sees only its own sessions.

## 1. Capability — host-configured (R1)

- The hub can summarize iff its own process env carries `ANTHROPIC_API_KEY` (validated for
  presence at boot via the `hubEnv.ts` pattern; no live API probe). The summarize call reuses
  `runOversightSummarize` from `multiplayer-ai-server` (already a `file:` dependency).
- **Unavailable is truthful, never silent:** with no key, `set_oversight enabled:true` is
  refused with the exact string `oversight is unavailable on this hub — no ANTHROPIC_API_KEY
  configured`, and every snapshot carries additive `oversight.available: false`. The solo
  server always reports `available: true` (its SDK creds are the laptop's own).
- Model: same constant the solo summarizer uses (no new knob this cycle — a
  `HUB_OVERSIGHT_MODEL` override is deliberately deferred until someone needs it).

## 2. Hub overseer

- One `Overseer` instance on the hub (imported, not reimplemented), keyed by projectId.
  `digestsFor` builds `OversightSessionDigest[]` from the hub's own session logs across ALL
  machines via the same pure `oversightSessionDigest` the solo server uses.
- Activity: the hub calls `overseer.notify(projectId)` (the Overseer's actual public method —
  corrected post-review; the spec originally wrote `activity`) where it already fans out
  project-interesting events (same event classes as solo — reuse, don't re-derive).
- `onUpdate`: push the project snapshot to watchers AND emit the new down-frame (§4).

## 3. Toggle + persistence (R2, R3)

- `set_oversight { projectId, enabled }` becomes hub-answered, **membership-gated with the
  lifecycle convention**: the same uncoded refusal shape, verbatim string
  `join this project before changing it` (byte-identical to `set_project_lifecycle`'s, so the
  client's existing `not_a_member` normalization covers it unchanged).
- **HubDb schema v4:** new table `project_oversight (project_id TEXT PRIMARY KEY, enabled
  INTEGER NOT NULL, summary TEXT, seq INTEGER NOT NULL DEFAULT 0, ts TEXT)`. Migration mirrors
  the v2/v3 shape. Boot loads rows into the overseer's state; a hub restart keeps both the
  posture and the latest summary (R3) — seq continues from the stored value so clients never
  see it move backwards.
- Every state change (toggle, refresh landing) writes through to the row before the snapshot
  push — same durable-before-visible rule as invites.

## 4. Agent parity — summaries reach laptops (R4)

- New **`oversight_update` down-frame** (hub → owning uplinks, `emitContested` pattern,
  project-scoped): `{ type:"oversight_update", projectId, latest: OversightSummary | null,
  enabled }`. Emitted on refresh and on toggle (disable pushes `latest:null`-equivalent state
  so the tool text goes back to `team oversight is disabled`).
- The laptop relay stores the last frame per project (`hubOversight` map, memory-only — the
  hub re-pushes on reconnect/replay, so laptop restarts self-heal).
- **Injection precedence:** at the existing `pendingOversight` injection site and in the
  `team_update` tool text, a hub-attached project reads the hub-pushed state; solo projects
  read the local overseer exactly as today. Hub-attached, the local overseer is not consulted
  (it only knows one laptop — answering from it would be the lie this cycle removes).
- `pull_oversight` stays a session-socket message handled by the laptop (it only flips the
  one-shot `pendingOversight` flag); no hub round-trip needed since the summary is already
  pushed down.

## 5. Client (minor)

- OVERSIGHT screen renders `available:false` truthfully: toggle disabled with the reason line
  (exact string from §1) instead of a dead switch. Everything else — screen, `O` hotkey,
  seen-seq badge, PULL — is unchanged and now simply receives real data on hub projects.

## 6. Constraints

1. **Additive wire only** — old snapshots/frames parse; a pre-v4 hub DB migrates forward.
2. **Truthful record** — toggles are project events? No: matching solo, toggling is state,
   not a logged session event; the snapshot is the record of posture. (Unchanged from solo —
   flagged as a default, not a new decision.)
3. **No cost runaway** — the existing debounce/single-in-flight/coalescing machine is the
   throttle; failure keeps the previous summary (already Overseer semantics).
4. **Tests use the injected `Summarize` seam** — no real API calls in any suite.

## 7. Testing

- Hub: member-gate refusal (byte-exact string), no-key refusal + `available:false` snapshot,
  digest aggregation across two uplinks' sessions, v4 migration + restart keeps
  enabled/summary/seq, down-frame emitted on refresh and toggle, durable-before-visible order.
- Server: injection precedence (hub-attached reads pushed state; solo unchanged),
  `team_update` text parity, relay stores/replaces per-project frames.
- Client: unavailable rendering; existing oversight tests stay green untouched.
