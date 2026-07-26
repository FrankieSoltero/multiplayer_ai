# Oversight Agent — Design Spec

Date: 2026-07-26. Status: approved by user (brainstorm session), pending plan.

## §1 Goal & thesis position

One opt-in, server-side **oversight agent** per project that watches structured activity
digests across all sessions and maintains a short prose summary of what the whole team
(humans + agents) is doing. Primarily human-facing; a session's driver can deliberately
pull the current summary into their own agent's context.

**Thesis note (deliberate):** the recorded principles (market-research.md, v6b banked
decisions) say "awareness, not shared context" and "no agent reads another's transcript."
This feature stays inside that line by construction: the overseer reads **structured
digests only** (never transcript prose), its output goes to humans by default, and
context enters an agent session only through an explicit, attributed, driver-scoped pull
(or a permission-gated tool call). It is the awareness story scaled to the team, not a
shared-context pool. Off by default so cost/noise doesn't grow with party size.

## §2 Data & wire

- `OversightSummary = { text: string; ts: string; seq: number }`. Server keeps only the
  latest per project (plus the seq counter), in memory. No persistence across restarts —
  the overseer regenerates on next activity. No history UI (the project channel is
  snapshot-shaped; history can be added later without wire changes).
- The `project` snapshot message gains `oversight: { enabled: boolean; latest: OversightSummary | null }`.
  Every refresh or toggle triggers the existing `pushProject` broadcast; late watchers
  get current state on their first snapshot. No new replay machinery.
- New project-channel command `set_oversight { projectId, enabled }` — anyone may toggle
  (team infrastructure, not a driver capability). Enabled defaults to **false**.
  Toggling on triggers one immediate refresh; toggling off stops all overseer activity
  (latest summary retained and still displayed, marked stale by its timestamp).
- New session-wire command `pull_oversight {}` — **driver-only**. Appends an attributed
  session event `oversight_pull { requestedBy, seq }` (append-only session wire rule;
  everyone in the session sees who pulled team context, same pattern as `task_stop`),
  and arms a one-shot injection (§5).

## §3 Overseer module (`poc/server/src/overseer.ts`)

- One instance per server. Constructor `(summarize, debounceMs = 30_000)` where
  `summarize: (input: OversightInput) => Promise<string>` is injected — production
  default is a one-shot SDK call on **haiku** (`MODELS.haiku`), no tools; tests inject a
  fake (same pattern as `runQuery`).
- Server hooks call `overseer.notify(projectId)` on meaningful events only: prompt sent,
  session created/ended, permission gate raised, error event, intent change. Notify
  while disabled is a no-op (zero cost).
- Debounce: `notify` starts/extends a timer; on fire, one refresh runs. Single in-flight
  guard: notifies during a running refresh coalesce into exactly one follow-up refresh.
- Refresh input (`OversightInput`): per-session structured digest via an extended
  `digest.ts` — intent, driver, participants, last few tool-call targets, prompt count,
  pending permission gates, errors, lifecycle (created/ended). **No transcript prose.**
  Plus the previous summary text for continuity.
- Output contract prompted for: 2–3 sentence team narrative, then one line per active
  session. Length-capped in the prompt instruction.
- Failure: log to stderr, keep previous summary, wait for next activity. No retries, no
  crash. A summarize call that rejects must never take the server down.

## §4 Client — OVERSIGHT screen

- New screen following the workflows-screen pattern: `?screen=oversight`, hotkey `O`
  (extends the existing S/W hotkey effect), header button after WORKFLOWS with a
  fresh-dot when an unseen `seq` has arrived (cleared on viewing — derived client-side,
  no server involvement).
- Screen contents: narrative summary text, updated-at timestamp, ENABLE/DISABLE toggle
  (anyone), PULL INTO SESSION button (driver-only; dimmed with reason for non-drivers;
  hidden while oversight is disabled).
- Data flow: client already receives `project` snapshots; `derive.ts` folds the new
  `oversight` field and the `oversight_pull` session event (transcript line: who pulled
  update #N). Pure logic (freshness, labels) in a small tested module — no
  component-test infra (recorded pattern).

## §5 Pull paths (both read the stored summary; neither triggers an LLM call)

1. **Driver button:** `pull_oversight` appends the session event and arms a one-shot
   flag; the server's existing prompt composition (where `<teammates>` goes,
   `buildTeammateDigest` call site in `server.ts`) includes an `<oversight>` block with
   the summary text on the **next agent turn only**. No persistent context growth.
2. **Agent tool:** the existing `awareness` SDK MCP server (`agentDriver.ts`) gains
   `team_update` (no args) returning the latest summary text, or the exact string
   `"team oversight is disabled"` when off. Not allowlisted by default — it rides the
   normal permission-gate flow, so in gated modes the driver approves the call; that
   approval is the human consent for bringing team context in.

## §6 Error strings (exact)

- `"oversight requires driver"` — non-driver sends `pull_oversight`.
- `"unknown project: <id>"` — `set_oversight` for an unregistered project (reuse
  existing project validation idiom).
- `"team oversight is disabled"` — `team_update` tool result and `pull_oversight`
  rejection while disabled.

## §7 Testing

Server (vitest, fake `summarize`): debounce collapses bursts into one call; in-flight
coalescing; disabled = zero summarize calls; failure keeps previous summary; toggle-on
immediate refresh; `set_oversight` broadcast + default-off; `pull_oversight` driver-only
rejection + attributed event + `<oversight>` block in exactly one next prompt;
digest-extension unit tests. Client: derive folds for `oversight` field and
`oversight_pull` event; freshness/label pure functions. Summary content quality is
demo-judged, not asserted (same stance as the workflows screen).

## §8 Out of scope (explicit)

Summary history UI; persistence across restarts; per-session consent/detail levels
(digests-only makes it unnecessary); agent-initiated push of context into other
sessions; cross-project rollups; fixed-interval scheduling; any surface on the
SessionPicker (in-session screen only, v1).
