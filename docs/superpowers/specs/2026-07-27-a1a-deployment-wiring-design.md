# A1a — Deployment Wiring (making the server deployable)

**Date:** 2026-07-27
**Status:** Approved design (brainstormed with user; all three sections reviewed section-by-section)
**Type:** Infrastructure spec. A1b, A2, A3 and A4 get their own specs.

---

## 0. Context and where this sits

The user's goal is production readiness. That request spans 8–10 independent subsystems, so it was
split into two readings and the first was chosen:

- **Reading A (chosen, now):** ready to run in front of real users on a real box — deploy, TLS,
  authentication. This is `2026-07-25-deployment-strategy-design.md` §2/§4.
- **Reading B (after A):** real teams can use it unattended — persistence, reconnect,
  multi-tenancy, sandboxing, audit, rate limiting. This is that spec's §6 roadmap, unchanged.

Reading A decomposes into five sub-projects, each with its own spec → plan → implementation cycle:

| ID | Scope |
|---|---|
| **A1a** | **Deployment wiring — this spec. In-repo only; no box required.** |
| A1b | Deployment execution: provision, DNS, Caddy, systemd, live verification |
| A2 | GitHub OAuth + allowlist; per-session BYO Anthropic key |
| A3 | Pull notification ("🔐 Ana's session needs an approval — drop in") |
| A4 | Canned demo scenario that reliably reaches a permission gate |

**Build order: A1a → A2 → A3 → A4 → A1b.** Deployment is deliberately *last*.

The original strategy put deployment first, on the reasoning that a GitHub OAuth callback needs a
public HTTPS URL. That reasoning was wrong in a useful way: GitHub OAuth apps accept
`http://localhost` callbacks for development, so A2 only needs the public URL for *final
verification*, not to be built. Deploying last means the product is deployed once, complete,
rather than standing up an unauthenticated skeleton and redeploying after every subsequent piece.

It also dissolves a real hazard. A1a through A4 contain no authentication (that is A2). Had we
deployed first, there would have been a window in which a public URL let anyone join a session and
drive an agent on the box. Deploy-last means that window never exists.

---

## 1. Goal and non-goals

**Goal:** the server in this repository can be built and run as a long-lived production process
behind a TLS-terminating reverse proxy, serving the built client and the WebSocket from a single
origin, with misconfiguration failing loudly at startup rather than silently at demo time.

**Definition of done:** local verification (§6.2) passes and the work is merged to main. No box,
domain, or DNS is involved.

**Non-goals, deliberately:** authentication of any kind (A2); executing a deployment (A1b);
persistence, client reconnect, rate limiting, real sandboxing, audit export, or a Content Security
Policy (all Reading B); any auto-deploy pipeline — deploys stay a manual runbook, which is correct
for one box.

---

## 2. Architecture

```
Browser ──https:// + wss://──▶  Caddy :443  (automatic TLS)
                                     │  reverse_proxy
                                     ▼
                               Node 127.0.0.1:3001
                                     ├─ GET /healthz    → {"status":"ok"}
                                     ├─ staticHandler   → poc/client/dist
                                     └─ WebSocketServer → upgrade (any path)
```

**Node serves the client; Caddy is a pure TLS-terminating reverse proxy.** Two alternatives were
considered and rejected:

- *Caddy serves the static client, proxying only WebSocket traffic.* Rejected because the
  WebSocket server is attached with no path restriction (`server.ts:225`,
  `new WebSocketServer({ server: httpServer })`), so it accepts upgrades on any path. Caddy would
  have to route on the `Upgrade` header rather than a clean path prefix — a subtle configuration
  that fails confusingly. It would also put knowledge of `dist` in two places and leave
  `staticFiles.ts` — already written, path-contained and tested for exactly this job — dead in
  production.
- *No Caddy; Node terminates TLS directly.* Rejected because certificate issuance and renewal
  become our code and our pager. Caddy's automatic HTTPS is the main reason to have it.

The chosen shape keeps one origin, one process, and one place that knows where `dist` lives. It
preserves **dev/prod parity**: it is the same single-port code path the `mpai` CLI and session
launcher already assume, so what is verified locally is what runs on the box. Caddy compresses
proxied responses via `encode gzip`, so serving static content from Node costs essentially nothing
at demo scale. Moving static serving to Caddy later is a configuration edit, not a rewrite.

---

## 3. Changes

### 3.1 `server.ts` — bind host

Add `host?: string` to the `startServer` options (`server.ts:60`) and pass it to
`httpServer.listen(opts.port, opts.host)` (`server.ts:758`). Optional and defaulting to today's
behaviour so the existing 215 server tests are untouched.

Today the server binds every interface. On a public box that makes port 3001 directly reachable,
letting anyone bypass Caddy and TLS entirely. Caddy must be the only way in.

### 3.2 `main.ts` — environment wiring and fail-fast validation

Wire three settings that currently have nowhere to land:

| Variable | Meaning | Default |
|---|---|---|
| `CLIENT_DIST` | Absolute path to the built client; **its presence means production mode** | unset |
| `HOST` | Bind address | `127.0.0.1` |
| `PORT` | Listen port | `3001` (unchanged) |

`HOST` defaulting to loopback is a deliberate change to `main.ts`'s current behaviour. It is the
safe default for the box; anyone needing LAN access (for example testing from a phone) sets
`HOST=0.0.0.0` explicitly. The existing local flows are unaffected — the `mpai` CLI already
connects to `ws://127.0.0.1` (`cli.ts:137`).

Also fix the startup log line (`main.ts:30`), which currently prints `ws://localhost:${actual}`
regardless of the actual host or scheme.

**Fail-fast validation, applied only in production mode** (that is, only when `CLIENT_DIST` is
set, so local development behaviour is completely unchanged):

1. `CLIENT_DIST` must be an existing directory containing `index.html` → otherwise exit 1.
2. `ANTHROPIC_API_KEY` must be present and non-empty → otherwise exit 1.

Today a missing key only warns (`main.ts:3-7`). On a box that means the server starts happily, a
friend joins, and the demo dies three minutes later when the agent cannot authenticate. A missing
or unbuilt `CLIENT_DIST` similarly yields a running server serving a blank page. Both should be
boot failures with a clear message.

The validation is extracted as a pure function over an environment object plus a directory-check
callback, so it is testable without `process.exit` — matching the repository's established
pure-function-extraction pattern.

### 3.3 Client — derive the WebSocket scheme

`types.ts:88-90` currently hardcodes `ws://` in the production branch. A browser blocks a `ws://`
connection opened from an `https://` page, so **the product cannot connect at all once served over
TLS**. This is a functional blocker, not only a confidentiality fix — though it is also that,
since invite tokens travel on this socket (`server.ts:236-242`).

Extract a pure `socketUrlFor(protocol, host)` and test it; the current expression reads `window` at
module load and cannot be tested directly. The scheme is derived from `window.location.protocol`
(`https:` → `wss:`, otherwise `ws:`) rather than hardcoded to `wss:`, which keeps the plain-HTTP
single-port path working for the local demo recipes and the CLI. The `import.meta.env.DEV`
short-circuit stays as-is.

### 3.4 `/healthz`

`GET`/`HEAD /healthz` returns 200 with `content-type: application/json` and the body
`{"status":"ok"}` — nothing more. It is publicly reachable through the domain, so it must not
expose session counts, participant names, or any internal state.

It is registered **unconditionally**, independent of whether `staticDir` is configured, so the
same probe works in development and in production.

**It must be handled before `staticHandler`.** That handler's SPA fallback
(`staticFiles.ts:51-53`) serves `index.html` for any extensionless path, so a health route wired
after it silently returns the HTML page with a 200 — a health check that passes forever while the
application is broken. This ordering is load-bearing and is guarded by a test that asserts the
response *body* (§6.1).

### 3.5 Build step

Production should not run `tsx`: it is a development dependency performing on-the-fly
transformation at every start. Add `tsconfig.build.json` extending the existing config with
`noEmit: false`, `outDir: "dist"`, `rootDir: "src"`, `include: ["src"]`, plus a `build` script, so
the service runs `node dist/main.js`.

**`rootDir: "src"` is required, not optional.** Without it, TypeScript 7.0.2 refuses to emit
(TS5011 — it cannot infer a single root when `include` is narrower than the tsconfig's own
directory) and, if forced anyway, emits to `dist/src/main.js` instead of `dist/main.js` — breaking
both `node dist/main.js` and the systemd unit's `ExecStart=/usr/bin/node dist/main.js`. Anyone
re-deriving this config from this section alone must include `rootDir` to get a working build.

This needs no other source changes: the project is already `module: NodeNext` and its imports
already carry `.js` extensions (`from "./server.js"`), so emitted ESM resolves correctly.

`bin/mpai.js` continues to use `tsx` at runtime — that is the local CLI and is out of scope.

---

## 4. Ops artifacts (written now, unverified until A1b)

These live under `deploy/` and are committed in A1a even though they cannot be executed yet. They
are already designed, they are text, and their environment variable names must stay consistent
with §3.2's validation — writing them alongside the code is what keeps the two in sync. Each file
carries a header comment stating plainly that it has never been run against a real box.

**`deploy/Caddyfile`**

`<hostname>` is a parameter, filled in during A1b once the domain exists — not an unresolved
question.

```
<hostname> {
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer
    }
    reverse_proxy 127.0.0.1:3001
}
```

`reverse_proxy` passes WebSocket upgrades through natively.

**`deploy/multiplayer-ai.service`**

```ini
[Service]
Type=simple
User=mpai
WorkingDirectory=/opt/multiplayer-ai/poc/server
EnvironmentFile=/etc/multiplayer-ai/env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
```

**Filesystem layout**

| Path | Purpose | Ownership / mode |
|---|---|---|
| `/opt/multiplayer-ai` | git checkout; built client and server | `mpai` |
| `/srv/mpai-work` | `AGENT_WORKDIR_ROOT` — agent worktrees | `mpai` |
| `/srv/mpai-plugins` | `AGENT_PLUGINS_ROOT` | `mpai` |
| `/etc/multiplayer-ai/env` | secrets and configuration | **0600, `mpai:mpai`** |

The service runs as non-root `mpai` with a real home directory, because the Claude Code subprocess
needs `~/.claude` for its own configuration.

**`deploy/env.example`** — the `EnvironmentFile` template, with the key left blank. Carries every
variable the service reads: `ANTHROPIC_API_KEY`, `CLIENT_DIST`, `HOST`, `PORT` (§3.2),
`AGENT_WORKDIR_ROOT`, `AGENT_PLUGINS_ROOT` (`server.ts:173`, `server.ts:74`), and the optional
invite settings `REQUIRE_INVITE`, `INVITE_TTL_MS`, `INVITE_MAX_USES` (`main.ts:21-23`). This file
is the reason the ops artifacts are written in A1a rather than A1b: it and §3.2's validation must
name the same variables, and splitting them across two work items is how they drift.

**`deploy/RUNBOOK.md`** — ordered, copy-paste steps with expected output at each step, since the
user executes them over SSH rather than granting an agent access to the box. Includes the `ufw`
rules referenced in §5 (allow 22/80/443 only).

---

## 5. Security posture

**What this spec establishes:**

- **Loopback binding** (§3.1) so the application port is unreachable except through Caddy.
  `ufw` allowing only 22/80/443 is defence in depth on top of that, not the primary control.
- **`X-Frame-Options: DENY` is not boilerplate here.** This product's core interaction is a human
  clicking "approve" on a privileged action. Without frame denial that UI can be clickjacked — an
  invisible overlaid iframe harvesting a real approval. It is a live threat against this specific
  application.
- **Secrets in `EnvironmentFile`, never inline in the unit.** Unit files in
  `/etc/systemd/system` are world-readable, so an inline key is readable by every user on the box.
  The key is a capped Anthropic Console workspace key. It is never committed and never logged.

**What this spec deliberately does not do.** The reflex additions `ProtectSystem=strict` and
`ProtectHome=yes` are both omitted, because they break this service in ways that surface as
mysterious agent failures rather than clean permission errors:

- `ProtectSystem=strict` makes the filesystem read-only except for explicit `ReadWritePaths`, but
  the agent legitimately writes git worktrees, clones plugins (`pluginStore.ts:109`), and runs
  Bash that may install packages. Every missed path becomes an agent that inexplicably cannot do
  its job.
- `ProtectHome=yes` hides `/home`, including the `~/.claude` directory the agent subprocess
  requires. This would likely break the agent outright.

Stated honestly: **`NoNewPrivileges` + `PrivateTmp` on a process whose purpose is spawning an
unconstrained agent is close to theatre.** They cost nothing, so they are taken, but they are not
isolation. Real isolation is Reading B item 4 and means namespaces or containers *per agent
session*, not directives on the shared service. Writing that down is preferable to letting a
hardened-looking unit file imply a boundary that does not exist.

**The authentication gap and why it is now harmless.** A1a through A4 contain no authentication.
Under the original deploy-first order this would have left a public, unauthenticated URL exposed
between A1 and A2. The deploy-last order in §0 removes that window entirely: no URL exists until
A2 is already merged. Should an interim demo ever be needed, `REQUIRE_INVITE=1` is built and
merged and provides a capability token — but the invite spec is explicit that invites are a
capability, **not authentication**.

---

## 6. Testing and verification

### 6.1 Automated tests

Added to the existing 116 client / 215 server baseline:

- `socketUrlFor` — `https:` → `wss:`, `http:` → `ws:`, host preserved.
- **`/healthz` returns JSON, not HTML.** This asserts the response *body*, not the status code,
  and exists specifically to guard the §3.4 ordering constraint against a future reorder.
- Production-config validation — pure function over an environment object: missing key, missing
  `CLIENT_DIST`, `CLIENT_DIST` without `index.html`, and the development-mode passthrough.

### 6.2 Local verification (the gate for A1a being done)

1. Build client and server; run with `CLIENT_DIST` set and `HOST=127.0.0.1`.
2. `curl /healthz` → confirm JSON, **not** the HTML page.
3. Load in a browser over plain HTTP → page renders, WebSocket connects as `ws://`.
4. ~~Two tabs, two participants, driver and passenger, reach a real permission gate and approve
   it.~~ **Reassigned to A1b.** Blocked on this machine: no `ANTHROPIC_API_KEY` is configured here,
   so the agent cannot authenticate and no real permission gate can be reached to approve. This is
   not a code gap in A1a — it is an environment gap in the machine this spec was verified on — but
   it means the claim "the product works through the single-port path" is unproven until A1b, where
   a real key is available.
5. `ss -tlnp` / `lsof` → 3001 bound to `127.0.0.1` only.
6. ~~Local TLS rehearsal: run the real `deploy/Caddyfile` against `localhost` using Caddy's
   `tls internal`, trust the local CA, and confirm an established `wss://` connection in
   DevTools.~~ **Reassigned to A1b.** Blocked on this machine: it requires an interactive `caddy`
   install plus `sudo` to trust a local CA, neither of which is available in this environment. The
   `socketUrlFor` unit tests (§6.1) cover the scheme-derivation logic, but an actual established
   `wss://` connection remains unobserved until this rehearsal — or the real A1b deployment — runs.

All other steps in this list passed as originally specified.

Steps 4 and 6 matter more than their size suggests — step 6 in particular, because without it the
`wss://` fix would ship on the strength of a unit test and a strong argument alone. Deferring both
to A1b is a statement about this machine's environment, not a downgrade of their importance;
neither should be treated as met until they are actually run. Cost of step 6 when it does run:
`brew install caddy` (or the platform equivalent).

### 6.3 What remains unprovable until A1b

- Caddy certificate issuance against a real domain (needs live DNS).
- systemd genuinely recovering from `kill -9`.
- **The agent actually running on the box.** The subagent sandbox cannot launch the SDK binary, so
  "does Claude Code run under the `mpai` service user with that key" is a real unknown.
- Node version compatibility and memory headroom under two or three concurrent sessions. 4 GB
  should hold it; nobody has measured it.

---

## 7. Decisions and why (do not re-litigate)

| Decision | Choice and reason |
|---|---|
| Static serving | Node serves everything, Caddy is pure TLS — WS has no path restriction, `staticFiles.ts` is already built and tested, dev/prod parity |
| Deployment order | A1a → A2 → A3 → A4 → A1b — localhost OAuth callbacks make deploy-first unnecessary; deploy-last removes the unauthenticated-URL window |
| Identity vs. billing | Identity from GitHub OAuth (A2); compute billed **per session**, not per person — one session runs one agent process, so per-person keys would force a restart and break the "the agent never stopped" claim |
| Credentials as identity | Rejected — an API key is an opaque bearer with no name, cannot support the attributable-approval claim, collapses shared-key users into one identity, and storing users' keys on an assume-breach box is the worst liability on it |
| `HOST` default | `127.0.0.1`; explicit `0.0.0.0` for LAN testing |
| Production mode signal | Presence of `CLIENT_DIST` — only the box sets it, so development behaviour is untouched |
| systemd hardening | `NoNewPrivileges` + `PrivateTmp` only; stronger directives break the agent (§5) |
| Ops artifacts | Committed in A1a, marked unverified — keeps env names in sync with §3.2 |
| Run `tsx` in production | No — compile with `tsc` and run `node dist/main.js` |

---

## 8. Risks and known bounds

- **Committed-but-unrun configuration can rot** between A1a and A1b. Mitigated by the header
  comments and by the local Caddy rehearsal (§6.2 step 6), which exercises the real Caddyfile.
- **`HOST` default change** alters `main.ts` behaviour for anyone who relied on all-interface
  binding. Documented above; the override is one variable.
- **No Content Security Policy.** Deferred to Reading B because it needs testing against the built
  bundle rather than guessing at directives.
- **Deploys are manual.** Correct for one box; revisit only if a second appears.

---

## 9. A1b — what remains (follow-on spec)

- **Hard blocker: session workspace provisioning does not exist.**
  `poc/server/src/main.ts` never passes a `workspace` to `startServer`, so at
  `server.ts:174-175` a session's workdir is computed as
  `path.join(AGENT_WORKDIR_ROOT, sessionId)` and **nothing on that path ever
  creates the directory** — `mkdir` appears only in `workspace.ts`, `cli.ts`,
  and `pluginStore.ts`. If `AGENT_WORKDIR_ROOT` is unset, `agentDriver.ts:133`
  falls back to `process.cwd()`, which under the systemd unit is
  `/opt/multiplayer-ai/poc/server` — the agent would then edit the running
  deployment's own source tree. This must be resolved (real per-session
  workspace provisioning, not a bare `mkdir` of an empty non-git directory,
  which would only make the failure silent instead of loud) before any real
  session runs in production.

Provision the Hetzner box (CX22 class: 2 vCPU / 4 GB / 40 GB; 4 GB is the floor because the Claude
Code subprocess is itself a Node process); buy the domain and point an A record at the box **before
Caddy first starts**, since certificate issuance happens at startup and fails confusingly
otherwise; if using Cloudflare DNS keep the record "DNS only" rather than proxied; install Node 22+,
Caddy and the unit file; run the runbook; then verify:

HTTPS loads with a valid certificate · `/healthz` returns JSON over HTTPS · DevTools shows an
established `wss://` connection · **two people on two different networks run a session with a real
approval** · an agent turn completes end-to-end · `kill -9` recovers · `http://<ip>:3001` from
outside is refused.

The last three matter most. It would be easy to stop at "the site loads" and call it deployed while
the product itself has never run on that machine.
