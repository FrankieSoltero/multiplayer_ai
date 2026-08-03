# §8.6 The agent surface — implementation plan (cycle 1: the wire)

**Spec of record:** `docs/specs/2026-08-01-agent-surface-gap-inventory.md` (the PRD-mandated gap
inventory, 2026-08-01). PRD §8.6: "The likely shape is surfacing SDK capabilities that already
exist behind the driver rather than building new agent machinery." This cycle is exactly that.

**Process note:** executed in Kimi Code CLI, no soltero council; plan carries its own scoping.

**Goal:** make the agent's own state visible and controllable — cost/usage/context numbers the
HUD was designed for, a real STOP for the turn, truthful error/compaction signals — by surfacing
what the SDK already emits. No new agent machinery; no permission-model redesign; no rewind.

**Stack / suites (baselines at stack head `feature/project-lifecycle`, 2026-08-01):**
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (766)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (368)
- client: `cd poc/client && npx tsc -b && npx vitest run` (534)
- Never predict post-change totals; read them from runs.

**Plan done gate (objective):**
1. Tasks 1–7 landed; all three suites fresh, exit 0, zero failures, tsc clean.
2. Live wire proof (scripted, like the invites/lifecycle demo): a real session emits a `turn_end`
   carrying cost/usage; an interrupt mid-turn produces the interrupted outcome, not `turn_end`;
   numbers reach the HUD (asserted via headless-chromium screenshot, `/tmp/pw` harness exists).
3. No placeholder left feeding nothing: CONTEXT/XP/elapsed either wired or the segment removed —
   decided per §1.2, pinned by test.
4. The record stays truthful: new event fields are additive-only; old logs replay (server's
   replay tolerance pattern holds).

## §1 Scoping (from the inventory)

**In — cycle 1 (the wire + the displays it unblocks):**
1. **Usage/cost/context surfacing** (inventory §1): result fields ride `turn_end` (additive
   payload: `total_cost_usd`, `usage`, `modelUsage`, `duration_ms`, `num_turns`);
   `rate_limit_event` → a wire event; HUD CONTEXT + elapsed + PARTY XP wired or removed;
   AgentStatus bars wired or the screen retired.
2. **Turn interrupt** (§2): `stop_turn` message → `Query.interrupt()`; driver-only STOP on the
   prompt row; interrupted outcome distinguishable from `turn_end` on the wire.
3. **Error truth** (§3): `SDKResultError` subtypes + `terminal_reason` → `agent_error` with a
   real reason; `api_retry`/`permission_denied`/refusal-fallback (`supersedes`/`aborted`)
   surfaced as transcript signals, not silence.
4. **Compaction visibility** (§4): `compact_boundary` → transcript marker; `system/status`
   compacting → thinking-strip state.
5. **Subagent summaries on** (§5): `agentProgressSummaries: true` (the already-wired
   `task_event.summary` comes alive) + `task_notification.output_file` carried on the event.
6. **Roster freshness** (§6): `commands_changed` re-fetches `supportedCommands()` and emits a
   fresh `skill_roster`; `plugin_change` triggers `reloadSkills()`/`reloadPlugins()`.

**Out — named, next cycles:** permission "always allow" rules + six modes (inventory §7 — needs
rule storage and a multiplayer ownership ruling); token-level streaming (§8 — record-shape
decision); rewind/checkpoints/resume (§2 — driver persistence design); SDK hooks as touched-set
invalidation (§9 — perf refactor); effort/thinking controls; background-tasks UI; MCP lifecycle
UI. TUI idioms (inventory §10) stay out by product shape.

## §2 Global constraints

1. **Additive wire changes only.** New fields/events are optional on read; old hubs/clients/logs
   tolerate them (the LoggedEvent loose-type pattern holds). The hub relays events opaquely —
   zero hub changes expected; if one appears, stop and amend the plan.
2. **The record stays complete and truthful.** Nothing emitted today is dropped silently from
   the new payloads; error outcomes must be distinguishable from success in the log, not just
   the UI (D11).
3. **Driver-only controls.** STOP and mode/model changes gate on the wheel exactly as today.
4. **No placeholder without a feed.** Every HUD/panel number is wired to a real event or deleted
   — a meter that can't be fed must not render (truthful-UI rule, same as the record copy rule).
5. **Multiplayer first.** Cost/usage displays are per-session and attributed; nothing leaks one
   machine's account state into another project's surface (the hub relay boundary holds).

## §3 Tasks

Dependency order; one writer per file set; each lands green before the next starts. Server tasks
own `poc/server`, client tasks `poc/client`; the hub should be untouched (constraint 1).

1. **Wire: usage/cost on turn_end + rate limits** — agentDriver reads the result payload;
   events.ts additive types; `rate_limit_event` → `rate_limit` event (throttled). Server tests:
   payload fields reach the log; error result subtypes map correctly (pairs with Task 3's
   fixtures).
2. **Wire: turn interrupt** — `stop_turn` message (driver-gated, like `stop_task`);
   `Query.interrupt()`; outcome event (`turn_interrupted` or a `turn_end` subtype — picked at
   implementation and named in the commit). Server tests: interrupt mid-turn, interrupt with no
   turn running is a no-op, non-driver refused.
3. **Wire: error truth** — result error subtypes/terminal_reason → `agent_error` reasons;
   `api_retry` → status event; refusal-fallback supersedes signal carried on `agent_text_delta`
   (additive flag). Server tests per subtype.
4. **Wire: compaction + status** — `compact_boundary` → `compaction` event;
   `system/status` → busy-state signal. Server tests.
5. **Wire: summaries + roster freshness** — `agentProgressSummaries: true`;
   `task_notification.output_file` on the task event; `commands_changed` → roster refetch +
   fresh `skill_roster`; `plugin_change` → SDK reload calls. Server tests.
6. **Client: HUD + transcript truth** — CONTEXT bar wired to the new usage payload (or segment
   removed per §1.1 decision, justified in the commit); TURN elapsed wired; PARTY XP wired to
   session cost/tokens or removed; `agent_error` renders its reason; compaction marker renders;
   interrupted turn renders as interrupted. STOP button on the prompt row (driver-only, busy
   only) sending `stop_turn`. Thinking-strip shows compacting state. T14 parity holds.
7. **Client: AgentStatus decision + docs** — wire the HP/MP bars to real usage or retire
   `?screen=status` (decision recorded); PRD §8.6 *Today*/*Final state* update; HANDOFF wrap.

## §4 Verification per task

- T1–T5: server suite green; each new event/field pinned by an integration test against the
  driver harness (the `echoRun`/fake-query seams the suite already uses).
- T6: client suite green incl. T14 parity; no placeholder left unfed (grep the HUD fixtures);
  STOP pinned through the hooks-shim mount.
- T7 + final: all three suites fresh; done-gate §0 line by line; scripted live proof per gate 2.
