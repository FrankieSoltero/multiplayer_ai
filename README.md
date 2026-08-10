# multiplayer_ai

**A team hub for agent-assisted engineering.** Engineers attach their laptops to one
shared hub, open the repos they're working in, and run coding agents there. Everyone can
see what everyone else is doing, drop into anyone's session, and take control of a live
agent run mid-task.

The thesis (and what makes this different from "shared AI workspace" products): **sessions
stay isolated — only enough signal is shared for people and agents to avoid colliding.**
The unit of sharing is *awareness* (who is doing what, right now), not artifact. The
primitive the whole product defends is **transfer of control over a live agent run between
people** — the headline case being a teammate who drops in solely to answer a pending 🔐
permission gate and leaves.

Product of record: [`docs/PRD.md`](docs/PRD.md). All feature sections (§8.1–§8.9) are at
their stated final state; §8.10's real-box verification runs via
[`deploy/multi-machine-test.md`](deploy/multi-machine-test.md).

## The model

```
hub → project → session → sub-session
                  ↑
             (one repo, one machine, one git worktree)
```

- **Hub** — one per team, self-hosted. Owns identity (GitHub OAuth + allowlist), the
  project directory, and the durable record. Runs no agent, holds no API key*, clones no
  repo. (*except the optional hub-side oversight summarizer's key.)
- **Machine** — a laptop running `mpai --hub <url>`, headless. It contributes repos and
  runs the agents on its owner's own credentials. Laptops dial outbound; no inbound ports.
- **Project** — a bounded piece of work: repos + people + sessions + a record, with a
  lifecycle (active → closed → archived) and project-scoped invites.
- **Session** — one agent in one repo in its own worktree: participants, one driver at a
  time, a transcript, a permission gate. Sessions can spawn sub-agent **sub-sessions**,
  viewed by swapping within the parent.

## What's built

- **Identity & access** — GitHub OAuth with a fail-closed allowlist; laptops pair via
  short-lived codes into revocable, hash-stored device bearers.
- **Control transfer** — watch any session live, take the wheel mid-task (including
  straight from an undecided permission card), drive an agent running on someone else's
  machine, proven end to end across the relay.
- **Permission gates** — driver-gated approve/deny with a pinned gate bar, hotkeys,
  SDK-enriched gate text, and session-scoped **ALWAYS** rules (a driver's click never
  writes settings files; rules die with the session and land on the record with decider).
- **The agent surface** — live usage/cost/context HUD, mid-turn ■ STOP, truthful
  error/compaction/rate-limit reporting, model picker — including **local models** through
  a LiteLLM shim ([`deploy/local-models.md`](deploy/local-models.md)).
- **Awareness** — presence, pull notifications, cross-session contested-file detection
  (`⚠ CONTESTED` when two sessions touch the same file, with the auto-approve downgraded
  to an ask), and **hub-side oversight**: a team summarizer running on the hub across all
  machines, member-toggled, persisted, and fed to every agent's `team_update` tool.
- **The record** — durable SQLite on the hub (WAL, single-writer lock), hot `VACUUM INTO`
  backups, opt-in retention with sequence continuity, replay on restart. The record is
  the product; teardown docs say "keep hub.db" for a reason.
- **Presentation** — a 90s-terminal arcade theme and a quieter Clean theme over one
  component tree, switchable per user at runtime; playable mini-games in the thinking
  strip.
- **Hub operations** — fail-closed boot config, origin checks, per-IP rate limits,
  connection caps, backpressure closes, disk-headroom refusal, TLS/systemd/firewall
  deploy artifacts.

## Status & security

This is a **proof-of-concept and research project**, not a hardened production service.
It is single-tenant and self-hosted by design, ships with no warranty, and has known
security gaps documented below. **Do not expose it to the untrusted internet** — run the
hub on a network you control, behind TLS and its GitHub allowlist, and treat every attached
machine as a trusted operator.

Known limitations, as of the latest security review — read these before deploying:

- **Solo/standalone mode trusts the client-claimed identity.** The team *hub* path verifies
  identity via GitHub OAuth against a fail-closed allowlist. The standalone single-machine
  server (the [solo-mode quickstart](#quickstart--solo-mode-no-hub)) does **not** re-bind a
  client-claimed user id to a verified login — use it only in local/trusted contexts, never
  facing an untrusted network.
- **Auth-off and LAN modes bind without authentication.** Convenience flags for local
  testing (auth disabled, `HOST=0.0.0.0`, plain `http://`/`ws://`) intentionally skip auth
  and TLS. They are for a trusted LAN or loopback only — never an untrusted network.
- **Member-added model endpoints are not range-restricted.** A project member can point the
  model proxy at any URL, including loopback/LAN addresses (this is deliberate — local
  Ollama/LAN GPUs are the intended use). Every member already drives an agent with local
  tool access, so this adds no privilege beyond what membership already grants; treat
  project membership accordingly.
- **TLS is terminated by an operator-configured reverse proxy** (e.g. the provided
  Caddyfile), not by the app itself. There is no application-layer TLS enforcement.

Contributions that harden any of these are welcome. If you find a security issue, please
open an issue describing the impact rather than posting a working exploit.

## Quickstart — solo mode (no hub)

**Prerequisites:** Node.js v22+ and npm, git, and either an `ANTHROPIC_API_KEY` or working
`claude` CLI credentials (or a local model — see [below](#local-models)).

Plain `mpai` keeps a local single-machine mode: run the server and client from source and
open two browser tabs to try driving/watching/take-the-wheel.

```bash
cd poc/server && cp .env.example .env   # set ANTHROPIC_API_KEY, or rely on claude CLI creds
npm install && npm run dev              # ws://localhost:3001
cd ../client && npm install && npm run dev   # http://localhost:5173
```

## Run a team hub

One command on a fresh Ubuntu/Debian box:

```bash
sudo HUB_HOSTNAME=hub.yourdomain.com REPO_URL=<this-repo-url> bash deploy/hub/setup.sh
```

Then fill the four secrets it names (`GITHUB_CLIENT_ID/SECRET`, `GITHUB_ALLOWLIST`,
`ANTHROPIC_API_KEY`) in `/etc/multiplayer-ai/hub.env` and `systemctl start
multiplayer-ai-hub`. Registering the GitHub OAuth app (homepage + callback URLs) and the
rest of the flow — install, pairing, backup/restore, disk-full recovery, revocation,
upgrades — is in [`deploy/hub/RUNBOOK.md`](deploy/hub/RUNBOOK.md).

No domain or TLS? [`deploy/home-lab.md`](deploy/home-lab.md) is the cheap real-box variant:
the hub on a LAN box (e.g. WSL2 on a Windows PC) over plain `http://`, TLS/firewall skipped.
**Trusted home network only** — no TLS means plaintext on the wire; never port-forward it to
the internet.

Each laptop then attaches with:

```bash
mpai --hub wss://hub.yourdomain.com/uplink --root <repo-path> --root <repo-path>
```

approving its pairing code from a signed-in browser. The CLI prints `dialing hub …` and
reports `attached` only after the hub's real handshake — a wrong URL warns loudly instead
of failing silently.

There is deliberately no hosted/multi-tenant offering: every team runs its own hub, owns
its own record, and allowlists its own people (PRD §2, decision D1).

## Local models

Claude is the default, but any OpenAI-compatible or Ollama backend works — the harness
routes through a managed LiteLLM proxy it spawns itself. Add a model from the project
screen's MODELS panel (label, provider, base URL, provider model) and it is available with
no restart. Full setup, version pins, and the operator-run-proxy escape hatch:
[`deploy/local-models.md`](deploy/local-models.md).

## Development

Three packages, three suites — run them from their own directories:

```bash
cd poc/server && npx tsc --noEmit && npx vitest run
cd poc/hub    && npm --prefix ../server run build && npx tsc --noEmit && npx vitest run
cd poc/client && npx tsc -b && npx vitest run
```

The hub and client import `poc/server`'s built dist — build the server first.

## Documentation map

| Where | What |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | the product of record — object model, decisions, §8 section states |
| `docs/specs/` · `docs/plans/` · `docs/plan-reviews/` | per-cycle design specs, implementation plans, and review verdicts |
| [`docs/tech-debt.md`](docs/tech-debt.md) | accepted debts and deferrals, each with "fixed looks like" |
| `deploy/hub/` | hub deployment: setup script, runbook, env template, systemd unit, Caddyfile |
| [`deploy/home-lab.md`](deploy/home-lab.md) | LAN-mode hub on a home box (WSL2/Windows PC), plain `http://`, no TLS — trusted networks only |
| [`deploy/multi-machine-test.md`](deploy/multi-machine-test.md) | the cross-machine acceptance runbook (doubles as §8.10 verification) |
| [`deploy/local-models.md`](deploy/local-models.md) | running local models beside Claude via a LiteLLM shim |
| `docs/superpowers/` · `docs/research-report.md` | historical: the original research and pre-PRD spec chain |
