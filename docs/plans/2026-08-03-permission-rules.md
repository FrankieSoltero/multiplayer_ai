# §8.6 cycle 2 — permission "always-allow" rules — implementation plan

**Spec of record:** the gap inventory `docs/specs/2026-08-01-agent-surface-gap-inventory.md` §7,
plus tech-debt §2.9's watch item ("the one where every shipped cycle makes the eventual fix a
bigger diff"). Cycle 1 (`feature/agent-surface`, PR #36) shipped the wire; this cycle ships the
permission-rules half. The six-mode mapping stays deferred (§1.4 below).

**Process note:** Kimi Code CLI, no soltero council; plan carries its own design section.

**Goal:** a driver can answer a permission gate with **ALWAYS** — the SDK's own suggested rule is
returned as `updatedPermissions` with destination forced to `session` — so the agent stops
re-asking for that call pattern for the rest of the session, and the standing approval is on the
record with who set it. Gates also surface the SDK's enrichment text (title/description/reason)
instead of only our reconstructed tool+input line.

**The multiplayer ruling (the design heart, locked):**
1. **Rules are session-scoped, always.** The driver forces every suggestion's `destination` to
   `"session"` regardless of what the SDK suggests. A driver's click never writes
   userSettings/projectSettings/localSettings — those files outlive the session, affect other
   projects, and mutate the operator's own machine state. A session rule dies with the agent
   session: contained, reviewable, gone on restart.
2. **Driver-only, like every gate decision.** ALWAYS is a decision, not a mode.
3. **The record tells the truth about standing approvals.** The `permission_decision` event for
   an ALWAYS carries the rule's display form and the decider; later calls the rule covers simply
   proceed (no gate) — identical to today's auto-approved Bash prefixes, so the transcript idiom
   already exists.
4. **Accepted bound:** a session-allowed rule bypasses our `canUseTool` wrapper entirely (the
   SDK doesn't call it), so the contested-file auto-approve withdrawal (awareness tier b) does
   not run for rule-covered calls. The driver who sets the rule accepts that; named here, not
   silently.
5. **Mode mapping stays deferred.** Our three modes (default/auto/plan) are untouched;
   `acceptEdits`/`bypassPermissions`/`dontAsk` remain unexposed — that's a UX design of its own
   and this cycle doesn't need it.

**Stack / suites (baselines at `feature/agent-surface` head, 2026-08-03):**
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (789)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (368)
- client: `cd poc/client && npx tsc -b && npx vitest run` (566)

**Plan done gate (objective):**
1. Tasks 1–3 landed; all three suites fresh, exit 0, tsc clean.
2. Server test proves the exact contract: an ALWAYS decision resolves the SDK callback with
   `{behavior:"allow", updatedPermissions:[…destination:"session"…]}` — forced even when the
   suggestion says otherwise — and the decision event carries the rule display + decider.
3. Old logs replay (additive-only), T14 parity green, and a gate with NO suggestion renders
   exactly as before (no ALWAYS button).

## §1 Wire design (locked)

SDK shapes (verified against sdk.d.ts): `CanUseTool` options carry `suggestions?: PermissionUpdate[]`,
`title?`, `displayName?`, `description?`, `decisionReason?`, `blockedPath?`, `matchedAskRule?`
(sdk.d.ts:206-266); the allow result takes `updatedPermissions?: PermissionUpdate[]`
(sdk.d.ts:2098); a rule suggestion is `{type:"addRules", rules: PermissionRuleValue[],
behavior, destination}` with destination ∈ userSettings|projectSettings|localSettings|session|cliArg.

1. **`permission_request` gains additive fields:** `title`, `displayName`, `description`,
   `decisionReason`, `blockedPath`, `matchedAskRule` (source+ruleContent), and `ruleSuggestion` —
   a compact display string derived server-side from the first `addRules` suggestion
   (e.g. `Bash(npm test:*)`); absent when the SDK suggests nothing. The raw suggestion is kept
   with the pending gate server-side (pendingGate) — never re-derived client-side.
2. **`permission_decision` gains a third decision value:** `"always"` (beside approve/deny) with
   additive `rule?: string` (the display form) — the event is the record of the standing
   approval. On `"always"` the driver resolves the SDK callback with
   `{behavior:"allow", updatedPermissions: suggestions.map(forceDestination("session"))}`.
   No suggestion held → `"always"` is refused like a malformed decision (cannot invent a rule).
3. **Sub-session gates** keep working: ALWAYS on a `⚒`-attributed gate is the same path
   (attribution is display metadata, never load-bearing — §8.4's ruling holds).
4. **Out of scope:** mode mapping (§0.5); rule LISTING/revocation UI (session rules die with the
   session — nothing to manage); hooks-based touched-set invalidation; `dontAsk`.

## §2 Global constraints

1. **Additive wire only** — old logs replay, mid-upgrade clients/servers degrade to today's
   rendering (no ALWAYS without a suggestion).
2. **Truthful record (D11)** — standing approvals are events: decider, rule, timestamp. Nothing
   silent.
3. **Destination is forced, not suggested** — the server rewrites every suggestion's destination
   to `"session"` before returning it; a future SDK default change can't leak a rule into files.
4. **Driver-only** — same gate as APPROVE/DENY; watchers see the outcome, never the button.
5. **T14 parity** — the new control renders identically in both themes (theme-independent label).

## §3 Tasks

1. **Server** — `permissions.ts`/`pendingGate.ts`/`agentDriver.ts`/`server.ts`/`events.ts`:
   capture enrichments + suggestions at gate creation; additive event fields; the `"always"`
   decision path with forced-session `updatedPermissions`; refusal when no suggestion held.
   Tests: the §0-gate-2 contract test (exact resolved payload), no-suggestion refusal, event
   fields, non-driver refusal, sub-session attributed gate, contested-withdrawal still runs for
   UNCOVERED calls.
2. **Client** — gate card + GateBar ALWAYS control (driver-only, only when `ruleSuggestion`
   present), hotkey `l` beside a/d; enrichment text rendered (title/description/reason) in place
   of the reconstructed line when present; outcome line "always allowed by X · Bash(npm test:*)";
   theme-parity. Tests on the house seams (hooks-shim, static markup, derive extensions).
3. **Docs** — PRD §8.6 *Today* addendum; tech-debt §2.9 watch item updated (rules shipped,
   mode mapping still deferred); HANDOFF wrap.

## §4 Verification per task

- T1: server suite green incl. the contract test; hub suite green untouched (368).
- T2: client suite green incl. T14; no weakened assertions.
- Final: all three fresh; done gate §0 line by line; scripted live proof deferred to the Claude
  account's weekly-limit reset (2026-08-04 ~7pm ET — the reset blocks any real gated turn today;
  recorded in HANDOFF).
