# PRD finishing cycle — v7b1 residuals + multi-machine test runbook — design

**Closes:** PRD §10.4's two unresolved residuals; stages §8.10's real-box verification as a
runbook for the user's 3-computer test. **Process note:** the user pre-delegated design
approval to PR review (/goal 2026-08-05: "finish out the prd and then put up a pr i will
review it"); the council still gates the plan.

## F1 — hub URL normalization (kills the half-attach trap at the source)

A `--hub` URL whose pathname is empty or `/` gets `/uplink` appended before any connect —
in ONE place (the CLI's URL handling, before the relay sees it), so relay tests and custom
`connect` fns are untouched. A URL with any other explicit path is respected verbatim (an
operator pointing at a proxy path knows why). The normalized URL is what the attach line
prints, so the operator sees what was actually dialed.

## F2 — truthful attach (welcome-gated, loud on silence)

- `RelayOptions` gains two OPTIONAL callbacks: `onAttached?: () => void` — fired on the FIRST
  `welcome` only (not per reconnect); `onNoWelcome?: (ms: number) => void` — fired once if a
  socket reaches `open` and no `welcome` arrives within `welcomeTimeoutMs` (option, default
  5000). Absence of either callback changes nothing (same posture as `onUnauthorized`).
- CLI: the `attached to hub` line moves from launch-time to `onAttached`. Launch prints
  `dialing hub <url> …` instead. `onNoWelcome` prints a loud warning naming the likely
  causes: wrong URL / missing `/uplink` path / hub not running — the socket may be open
  against a non-uplink endpoint and will never attach.
- The reconnect loop is unchanged; the timeout re-arms per connection but the warning prints
  once per process (a flapping hub must not spam).

## F3 — join success signal (hub-answered, additive)

The hub's session `join` handler sends an explicit `{ type: "joined", sessionId, projectId }`
event-stream message to the joining channel BEFORE the replay (an empty session's joiner
currently gets pure silence). Additive: old clients ignore unknown types (existing posture);
old hubs simply never send it. The solo server sends the same message at its join path for
parity. Client: `useSessionSocket` records it as `joined: boolean`; the Header's existing
status region shows the session as joined vs connecting — exact rendering is the
implementer's choice within existing status idioms; absent message (old server) renders
exactly today's UI.

## F4 — multi-machine test runbook (`deploy/multi-machine-test.md`)

The user's acceptance topology, written as a step-by-step operator doc: 1 hub (any of the
three machines or a fourth box; auth on with GITHUB_ALLOWLIST, ANTHROPIC_API_KEY set for
§8.8 oversight), 3 machines × `mpai --hub`, 4 unique repos with deliberate overlap —
computer 1: repos 1+2 · computer 2: repos 2+3 · computer 3: repos 3+4. Repos 2 and 3 being
shared across machines is the point: the §8.8 collision/contested surfaces and §8.5
approval-handoff are the headline checks. Checklist maps each PRD claim to an observable:
pairing, project membership, session create per repo, cross-machine watch + take-the-wheel,
contested badge on shared-repo writes, oversight summary spanning machines, the record
after. Ends with the §8.10 real-box checklist (this test IS the real-box verification) and
a results table to fill in.

## Constraints

1. Additive wire only (F3's message; F2 is process-local; F1 is dial-time only).
2. Truthful reporting — nothing prints "attached" before the hub said welcome.
3. No behavior change for existing tests absent the new options/message.
4. Out of scope, recorded: §10.1 sub-session worktrees (design question), §10.5 party
   terminology retirement (scheduling), §8.6 backlog (tech-debt §2.9).
