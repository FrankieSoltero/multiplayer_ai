# Identity & access + Operating a hub — design (PRD §8.1 + §8.10)

*Status: APPROVED 2026-07-31 — including A5 (list hub-wide, everything deeper membership-gated) and B1 (retention opt-in, `HUB_RETENTION_DAYS` unset = keep forever). Written 2026-07-31 (session #23 exploration, session #24 write-up).*

One spec, two branches. The two sections are a single gate — D12 says §8.10 gates network
exposure, and §8.10's rate limiting and audit trail need to know who a caller is, which is §8.1.
Splitting the spec would make the access-control decisions incoherent; splitting the branches
keeps each cycle a normal size. **Branch A (§8.1 identity & access) lands first; Branch B
(§8.10 operating) follows after A merges.**

---

## 1. What is true today (verified 2026-07-31; supersedes stale doc claims)

### The holes Branch A closes

- **`join` has no membership check.** `poc/hub/src/hub.ts:734-798` validates shape and
  liveness, then binds and replays — there is no `store.isMember` call anywhere in it. Any
  browser that can name a `projectId`+`sessionId` gets full event replay (`hub.ts:790-792`),
  the project snapshot (`:793`), and a live tunnel into the owning laptop (`:796`) — from which
  it can drive the agent and approve permission gates. Membership gates guard *provisioning*
  (`create_session` `hub.ts:830`, `attach_repo` `:904`, `set_project_lifecycle` `:725`);
  nothing guards *participation*.
- **`watch_project`/`peek` (`hub.ts:926-936`) require neither identity nor membership**, and
  `pushProject` (`hub.ts:177-193`) fans out to any channel whose `channel.projectId` matches —
  a field the browser sets itself via `watch_project` (`:933`). That snapshot carries
  `SessionFacts.touched`, the full changed-path list of every session.
  `poc/server/src/relayProtocol.ts:47-55` states "the bound that holds today is project
  membership" — **it does not hold.**
- **`pushProjects` (`hub.ts:338-341`) broadcasts every project's member roster**
  (`hubStore.ts:355`) to every connected channel. Under real auth that is a roster of GitHub
  logins.
- **Uplink auth is a URL path prefix and nothing else.** `hub.ts:417` routes `/uplink` to
  `handleUplink`; the `hello` branch (`hub.ts:448-493`) checks frame shape only, then
  `uplinks.set(frame.uplinkId, socket)` unconditionally — and a new `hello` with an existing
  `uplinkId` **evicts the incumbent** (`hub.ts:465-470`). Any peer that can reach the port can
  hijack a machine's sessions, flap it offline, or publish events into its log.
- **The hub takes the browser's word for identity.** `hub.ts:670-671` (`identify`) and
  `hub.ts:766-767` (`join`) truncate whatever the browser sent. (PRD §8.1 cites `hub.ts:337-338`
  for this — stale; that line is now a doc comment.)
- Audit M4 (`Docs/audit-2026-07-30.md:139-153`) is the standing record of this gap. The panel
  refuted the *severity framing* only because `main.ts:7` binds `127.0.0.1` by default and no
  deploy artifact exposes the hub.

**Correctly scoped already — do not "fix":** `emitContested` (`hub.ts:224-300`) targets only
the owning uplink; the reply narrowcast (`hub.ts:566-593`) requires session ownership or a
hub-issued single-use `pendingReplyFrom` grant.

### The operating gaps Branch B closes

- **Config is 5 env vars, no validation:** `PORT` (`main.ts:4`, `Number()` unvalidated — a typo
  yields `NaN` → port 0), `HOST` (`main.ts:7`, defaults `127.0.0.1`), `CLIENT_DIST`
  (`main.ts:20`), `HUB_DB` + `MPAI_HOME` (`bootConfig.ts:20-24`). There is no `config.ts`
  equivalent on the hub. `deploy/env.example` contains no hub variables at all.
- **No rate limiting anywhere:** no connection-count cap, no per-socket message cap, no
  `bufferedAmount` backpressure check (`hub.ts:172-174` checks only `readyState`). The only
  throttles are outbound fan-out dampers (`PROJECT_PUSH_INTERVAL_MS = 1000`, `hub.ts:20`).
- **Zero retention/pruning/vacuum.** `HubDb` (`poc/hub/src/hubDb.ts`, 533 lines, 6 tables,
  `SCHEMA_VERSION = 1`): `events` is INSERT-only, one row per `LoggedEvent` (`:403-405`) —
  including throttled agent progress frames. No `DELETE FROM events`, no `VACUUM`, no
  `journal_size_limit`, no TTL. Archiving a project (`hubStore.ts:249-258`) retains every event
  row. At-rest posture is already good (dir `0700` `:129-137`, files `0600` `:441-446`, WAL,
  PID lockfile `:456-485`).
- **Fail-stop blast radius:** `defaultFatal` (`hub.ts:74-101`) — any failed write exits the
  process, killing every uplink and browser; disk-full therefore crash-loops on the first
  publish after each restart. A corrupt `hub.db` has no recovery before backups land
  (`hub.ts:94-97`). Its one diagnostic line is a bare `console.error` immediately before
  `process.exit(1)` — not guaranteed to flush (tech-debt §2.8).
- **No hub deploy artifact exists.** `deploy/Caddyfile`, `deploy/multiplayer-ai.service`,
  `deploy/env.example`, `deploy/RUNBOOK.md` all target the standalone server on 3001, all
  headed "NOT YET VERIFIED against a real box." Security headers live only in the Caddyfile,
  not `staticFiles.ts` (`:65-67` sets `content-type` and nothing else).
- **Stale-doc note:** `docs/tech-debt.md` §1.1 ("hub has no `maxPayload`") is wrong in both
  directions — the hub *has* one (`hub.ts:411`, `MAX_FRAME_BYTES = 1_000_000` at
  `poc/server/src/relayProtocol.ts:23`) and always did; the server gained one at `server.ts:805`
  (audit M5). PRD §8.10's "Today" line inherits this error. Corrected in this branch's first
  docs commit.

### Reusable assets

- **`poc/server/src/auth.ts` (387 lines) is near-drop-in for the hub.** Takes
  `IncomingMessage`/`ServerResponse` — exactly what `hub.ts:377`'s `createServer` handler
  passes; `authRoutes(cfg)` returns a did-I-consume-this boolean and slots in at `hub.ts:390`
  beside `/healthz`. HMAC-SHA256 session token (`auth.ts:38-41`), 7-day max age,
  `timingSafeEqual`, `mpai_session` cookie with `Secure` via a three-signal `isSecure()`
  (`auth.ts:150-154`), allowlist fail-closed on empty (`auth.ts:74-82`), `requireAuth` single
  policy point (`auth.ts:168-179`). The `identify` handler is the natural insertion point —
  `hub.ts:661-665`'s own comment already names this as the plan.
- **`docs/superpowers/plans/2026-07-27-v7b2-trust-and-pairing.md` (8 tasks) is a complete
  task-level design for exactly §8.1's uplink half — ~70% reusable.** Device pairing:
  `mpai --hub` prints a short code → signed-in browser approves → hub issues an opaque bearer,
  stores only its **hash** against a revocable per-device record; bearer travels in
  `Authorization`, never a query string. Stale because it predates §8.2 (projects/membership),
  §8.3 (persisted `machineId`), §8.7 (HubDb), §8.8. Its biggest stated bound — "device records
  are in memory, a hub restart un-pairs every laptop" — **is now dissolvable: HubDb exists**,
  so device records belong in schema v2.
- **`docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md` §10** is the security
  floor §8.10 must satisfy: 10.1 no secrets in query params; 10.2 payload limits precede auth;
  10.3 every wire field bounded + charset-checked; 10.4 trust covers identity only (laptop
  still validates shape) + hub-assigned `channelId`; 10.5 pairing codes short-TTL/single-use/
  rate-limited; 10.6 Origin check + rate limiting.
- **`relay.ts:426-433` (`defaultConnect`) passes no `headers` option**, so a bearer cannot be
  sent today without changing that line. Uplink token work starts there.

---

## 2. Branch A — §8.1 Identity & access

**A1 — Hub-side GitHub identity (reuse `auth.ts`).** Move/adapt `poc/server/src/auth.ts` to
the hub; browsers sign in with GitHub *at the hub*; the hub stamps `userId` on the channel
itself instead of truncating the browser's claim (`identify` becomes "read the verified
cookie", not "trust the frame"). The laptop trusts the hub's stamp (v7 spec §10.4: trust
covers identity only — the laptop still validates shape). Near-zero-change reuse; the
allowlist stays `GITHUB_ALLOWLIST` env, fail-closed on empty.

**A2 — Uplink auth: pairing → opaque bearer, persisted in HubDb.** v7b2's flow, updated:
`mpai --hub` with no stored token prints a short pairing code; a signed-in, allowlisted
browser approves it; the hub issues an opaque bearer and stores only its hash in a revocable
per-device record — **in HubDb schema v2, not memory** (closes v7b2's biggest bound: a hub
restart no longer un-pairs every laptop). Bearer sent via `Authorization` header
(`relay.ts:426-433` gains a `headers` option), never a query string (v7 spec §10.1). Pairing
codes are short-TTL, single-use, rate-limited (§10.5). An authenticated `hello` for an
already-connected `uplinkId` still evicts the incumbent, but only with a valid bearer for
*that device record* — eviction becomes reconnect-recovery instead of hijack.

**A3 — Device records bind to §8.3's persisted `machineId`**, not a fresh device id — reuses
the durable identity that already exists.

**A4 — `join` requires membership.** Add the missing `store.isMember` gate to `join`
(`hub.ts:734-798`). Participation gets the same gate provisioning already has.

**A5 — Visibility (OPEN DECISION, see §5).** Recommended: the project **list** stays hub-wide
(it is the join affordance — you cannot join what you cannot see), but **snapshots, `touched`,
the record, and `watch_project`/`peek` require membership**, and `pushProjects` stops
broadcasting member rosters to non-members (list entries carry name + member *count*, not
logins). Rationale: this makes `relayProtocol.ts:47-55`'s already-stated bound true rather
than inventing new policy.

**A6 — Allowlist stays `GITHUB_ALLOWLIST` env.** Host settings UI is §8.10-final-state /
out of scope here.

**Unblocked by A but explicitly out of scope:** tech-debt §2.5 — the invite flow is dead
through the hub (every invite link is broken against a hub); it needs a hub identity plane,
which is exactly A, but it is §8.2's final-state item. Rides in a later §8.2 cycle.

## 3. Branch B — §8.10 Operating a hub

**B1 — Backup + retention (OPEN DECISION on the retention default, see §5).** Backup via
SQLite `VACUUM INTO` — atomic, hot-safe, single output file; sidesteps the
`.db`/`-wal`/`-shm` trio-copy hazard (spec §8a ruling 7). Retention **opt-in**
(`HUB_RETENTION_DAYS`, unset = keep forever) because the record IS the product (§8.7) and
silently deleting turns undermines it. Plus a disk-headroom preflight that turns the
disk-full crash-loop into a loud warning and a clean refusal before the disk fills.

**B2 — Rate limiting.** Per-IP token bucket on the WS upgrade, `/auth/*`, and pairing-code
submission; per-connection message-rate cap; connection-count caps; `bufferedAmount`
backpressure on fan-out.

**B3 — Origin check on the WS upgrade** (`HUB_ORIGIN`), fail-closed.

**B4 — Hub deploy artifacts** (Caddyfile, systemd unit, env template, RUNBOOK section).
**Disclosure: cannot be verified against a real box — the user has none. Shipped as
unverified drafts, never claimed deployable.**

**B5 — Harden `defaultFatal`'s stderr flush** so the crash-loop is diagnosable from the first
restart (tech-debt §2.8's diagnostic half).

**B6 — HOST fail-closed: refuse to boot if `HOST` is non-loopback and auth is unconfigured.**
Cheapest, strongest single answer to audit M4. Implies a small validated `config.ts` for the
hub (also fixes `PORT` `NaN` → port 0).

## 4. Testing

Same discipline as prior sections: lean-tdd per task; every access-control change gets a
refusal test (unauthenticated / non-member / wrong-device-bearer) plus the pass-through test;
eviction-with-valid-bearer and eviction-refused-without get explicit tests; rate limits and
the HOST fail-closed boot check get unit tests at the config/module seam. No live deploy
verification is possible (B4 disclosure).

## 5. Open decisions — need the user's call before planning

1. **A5, the visibility fork.** Today P2 says "every browser sees every project" — a
   deliberate spec position, so changing it is a spec change, not a bug fix.
   **Recommended:** list hub-wide, everything deeper membership-gated (makes
   `relayProtocol.ts:47-55` true). **Alternative:** keep everything hub-wide and require only
   identity (D1: one team, one hub — everyone is a colleague).
2. **B1 retention default.** **Recommended:** opt-in (`HUB_RETENTION_DAYS` unset = keep
   forever) — the record is the product. **Alternative:** a default age cap — closes
   tech-debt §2.8 harder but can silently destroy the deliverable.

## 6. Stale citations to correct in Branch A's first docs commit

1. PRD §8.1 (`docs/PRD.md:362`) cites `hub.ts:337-338` for identity truncation — actual sites
   are `hub.ts:670-671` (`identify`) and `hub.ts:766-767` (`join`).
2. `docs/tech-debt.md` §1.1 and PRD §8.10's "Today" line — the hub *does* have a pre-auth
   payload limit (`MAX_FRAME_BYTES`, `relayProtocol.ts:23`, enforced `hub.ts:411`); the server
   gained `maxPayload` at `server.ts:805`. The two halves no longer diverge.
3. `Docs/audit-2026-07-30.md` M4 remains the live gap, with the panel's severity note
   (loopback default) intact — this spec is its remediation of record.
