# PRD finishing cycle — implementation plan

**Goal:** resolve PRD §10.4's two residuals (silent uplink failure; no join success signal)
and ship the 3-computer test runbook that doubles as §8.10's real-box verification script.
**Spec of record:** `docs/specs/2026-08-05-prd-finishing-design.md` (F1–F4).

**Architecture:** F1 normalizes the hub URL at the CLI seam (one site, before the relay).
F2 adds two optional welcome-gated callbacks to `RelayOptions` and moves the CLI's attach
line behind the first `welcome`. F3 adds an additive `joined` message at both join paths
(hub + solo) and a client `joined` state. F4 is a standalone operator doc.

**Stack / suites (baselines at main `0fd9cdb`):**
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (845)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (385)
- client: `cd poc/client && npx tsc -b && npx vitest run` (598)

## Global Constraints

1. Additive wire only — old hubs/clients/servers interoperate unchanged; unknown message
   types are already ignored client-side.
2. Truthful reporting — no "attached" print before `welcome`; the printed URL is the
   normalized URL actually dialed.
3. Optional-callback posture — absent `onAttached`/`onNoWelcome` changes nothing (mirror
   `onUnauthorized` exactly).
4. Exact strings (locked): launch line `dialing hub <url> …` · attach line
   `multiplayer-ai attached to hub <url> (repo: <root>)` (existing, moved) · no-welcome
   warning first line `hub never welcomed this machine after <ms>ms — the socket is open but this is not an uplink handshake` with second line
   `check the URL: the hub's uplink endpoint is ws(s)://host:port/uplink (bare origins are normalized; a custom path is dialed verbatim), and confirm the hub is running`.
5. `welcomeTimeoutMs` default `5000`; warning prints ONCE per process.
6. F1 rule: pathname `""` or `/` → append `/uplink`; any other pathname verbatim; query
   strings preserved (an implementation detail of `new URL` round-tripping, not a spec
   requirement — noted per council D3).
7. **Data exposure:** the launch/attach lines print the full dialed URL; secrets are never
   passed via query strings (auth is env-var/header only — existing posture, restated).
8. **Plan done criterion:** all three tasks' Verify commands pass (green, tsc clean, exit 0)
   AND Task 3's enumerated coverage checklist is fully ticked in its report.

## Task Dependency Table

| # | Task | Files | Depends on | Risk |
|---|------|-------|-----------|------|
| 1 | CLI URL normalization + welcome-gated attach reporting | `poc/server/src/cli.ts`, `poc/server/src/relay.ts`, `poc/server/test/relay.test.ts`, `poc/server/test/cli.test.ts` | — | standard |
| 2 | `joined` ack — hub + solo + client state | `poc/hub/src/hub.ts`, `poc/server/src/server.ts`, `poc/client/src/useSessionSocket.ts`, `poc/client/src/components/Header.tsx`, existing test homes: hub tests under `poc/hub/test/`, `poc/server/test/server.test.ts`, `poc/client/src/components/Header.test.tsx` (+ a hook test beside `useSessionSocket.ts` if one exists, else assertions via Header's) | — | standard |
| 3 | Runbook + PRD §10.4 resolution + HANDOFF | `deploy/multi-machine-test.md` (new), `docs/PRD.md`, `HANDOFF.md` | 1, 2 | mechanical |

Tasks 1 and 2 have disjoint file sets except NONE — verify: T1 touches cli.ts+relay.ts
(server pkg); T2 touches server.ts (server pkg) + hub + client. Disjoint. May run
concurrently.

## Task 1 — CLI URL normalization + truthful attach

*(F1+F2 grouped deliberately: both land in the same two files and the same CLI report seam —
the printed line's truth depends on both the normalized URL and the welcome gate; splitting
would put two writers in cli.ts.)*

**Files:** modify `poc/server/src/cli.ts`, `poc/server/src/relay.ts`; tests in each's
existing test home.

**Produces (exact):**
- cli: exported pure `normalizeHubUrl(url: string): string` — Global Constraint 6's rule
  (use `new URL(...)`; preserve query; never touch a non-empty non-`/` pathname).
- relay: `RelayOptions` gains `onAttached?: () => void`, `onNoWelcome?: (ms: number) => void`,
  `welcomeTimeoutMs?: number` (default 5000).

**Behavior table:**
| case | input/state | expected |
|---|---|---|
| bare origin | `ws://h:4000` | dials `ws://h:4000/uplink`; printed line shows the normalized URL |
| trailing slash | `wss://h/` | `wss://h/uplink` |
| explicit path | `wss://h/proxy/up` | verbatim, untouched |
| explicit /uplink | `ws://h/uplink` | verbatim (no double append) |
| query preserved | `ws://h:4000?x=1` | `ws://h:4000/uplink?x=1` |
| first welcome | socket open → welcome | `onAttached` fired exactly once; NOT re-fired on reconnect welcome |
| no welcome | socket open, no welcome for welcomeTimeoutMs | `onNoWelcome(ms)` fired once per process; not fired if welcome arrived first; timer cleared on close |
| re-arm without spam | first connection times out (warning fired), reconnect also gets no welcome | timeout re-arms per connection; NO second warning (once per process) |
| malformed --hub | scheme-less or garbage value | refused by the EXISTING `--hub requires a ws:// or wss:// url` validation BEFORE normalization — `normalizeHubUrl` is only ever called on a ws(s):// value (pin with a test) |
| callbacks absent | options omit both | behavior byte-identical to today (existing relay tests untouched and green) |
| CLI wiring | launch with --hub | prints `dialing hub <url> …` at launch; the attach line ONLY from onAttached; warning strings exact (constraint 4) |

**Verify:** `cd poc/server && npx tsc --noEmit && npx vitest run` — 845 + new, exit 0.
**Commit:** `fix(server): hub URL normalization + welcome-gated attach truth — silent half-attach resolved (PRD §10.4a)`

## Task 2 — joined ack, both paths + client

**Files:** modify `poc/hub/src/hub.ts` (session join handler), `poc/server/src/server.ts`
(solo join path), `poc/client/src/useSessionSocket.ts`, `poc/client/src/components/Header.tsx`;
matching existing test files.

**Produces (exact):** message `{ type: "joined", sessionId: string, projectId: string }`
sent to the joining channel BEFORE any replay, on BOTH the hub and solo join paths.
Client: `useSessionSocket` returns additive `joined: boolean` (false until the message;
reset on socket close/rejoin).

**Behavior table:**
| case | input/state | expected |
|---|---|---|
| hub join | successful session join | `joined` message first, then replay; refused joins send NO joined message — refusals keep today's error surface (spec F3 is the SUCCESS signal; refusal signaling out of scope, resolved per spec) |
| empty session | join a session with zero events | joiner still receives `joined` (the silence this fixes) |
| solo parity | solo-mode join | same message, same ordering |
| client state | message arrives | `joined === true`; close → false; old server (no message) → stays false and UI renders exactly today's |
| header surface | joined true vs false while connected | a visible status distinction using EXISTING status idioms/tokens (implementer's choice); no new layout; absent-message rendering byte-identical to today |
| additive | old client vs new server | unknown type ignored (existing posture — pin with a test only if not already pinned) |

**Verify:** each suite per the Stack section's exact commands — hub 385 + new, server 845 + new, client 598 + new; all green, tsc clean, exit 0.
**Commit:** `feat: join success signal — hub+solo joined ack, client surfaces it (PRD §10.4b)`

## Task 3 — runbook + docs

*(Grouped deliberately as the cycle-wrap doc unit: the PRD §10.4 resolution cites the
runbook, so they land in one commit.)*

**Files:** create `deploy/multi-machine-test.md`; modify `docs/PRD.md` (§10.4: both
residuals → resolved with one-line what/where; §8.10 *Today*: real-box verification now has
a runbook, executed at the user's 3-computer test), `HANDOFF.md` (cycle wrap).

**Runbook content contract (spec F4):** topology table (hub + 3 machines; C1: repos 1+2 ·
C2: repos 2+3 · C3: repos 3+4 — overlap on 2/3 deliberate); env per box (hub: auth vars +
`ANTHROPIC_API_KEY`; machines: `mpai --hub wss://…/uplink` with pairing); a numbered
checklist mapping PRD claims to observables (pairing/membership; per-repo sessions;
cross-machine watch + take-the-wheel + approval handoff (§8.5, the primitive of §1.2); contested badges on shared
repos §8.8; hub oversight summary spanning machines; the record §8.7; attach-truth and
joined signals from Tasks 1–2); the §8.10 real-box checklist (TLS via Caddyfile, systemd
unit, backups present, retention behavior) marked as "this run verifies"; a fill-in results
table.

**Runbook must ALSO contain (council D5):** a teardown section (stop order, what to keep —
the hub.db record — and what to delete), a failure-recovery note per checklist phase (what
to capture and where to resume when an item fails mid-run), and the results table pre-filled
with every checklist row.

**Verify:** `grep -n "unresolved\|unanswered" docs/PRD.md` shows §10.4's two items no
longer listed as unanswered; the report ticks EACH runbook item by name: [ ] pairing/
membership · [ ] per-repo sessions · [ ] cross-machine watch · [ ] take-the-wheel ·
[ ] approval handoff · [ ] contested badges on shared repos · [ ] hub oversight cross-machine ·
[ ] the record · [ ] attach-truth (T1) · [ ] joined signal (T2) · [ ] §8.10 TLS/systemd/
backups/retention · [ ] teardown · [ ] failure-recovery · [ ] results table.
**Commit:** `docs: multi-machine test runbook + PRD §10.4 residuals resolved`
