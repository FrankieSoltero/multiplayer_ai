# Identity & Access (PRD §8.1, Branch A) Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd (or
> superpowers:subagent-driven-development). The Task Dependency Table below is
> the scheduling and review-depth contract.

**Goal:** the hub verifies identity itself (GitHub sign-in at the hub, verified
stamp replacing the browser's claim), machines authenticate with pairing-code
bearers persisted in HubDb schema v2 and bound to their persisted `machineId`,
and participation (join / watch / peek / record) is membership-gated while the
project list stays hub-wide with rosters redacted.

**Architecture:** the hub reuses the server package's `auth.ts` verbatim via the
already-exported `multiplayer-ai-server/auth` subpath — `authRoutes` mounts in
`hub.ts`'s `createServer` handler beside `/healthz`, and `requireAuth(cookieHeader,
cfg)` stamps identity at `identify`/`join` exactly as `server.ts:1045-1058` does.
Uplink auth is a new `pairing.ts` module (HTTP routes, same boolean-handler
pattern) plus a `devices` table in HubDb schema v2; the laptop side is a token
store + pairing loop in the CLI and a `headers` option on the relay's connect.
**Auth OFF (no `GITHUB_CLIENT_ID`) preserves today's behavior on every path** —
dev flows and existing tests keep working; membership gates apply regardless of
auth (they gate on `channel.identity`, verified or claimed).

**Tech stack / test runner:** TypeScript, Node, `ws`, `better-sqlite3`, vitest.
`cd poc/server && npx tsc --noEmit && npx vitest run` ·
`cd poc/hub && npx tsc --noEmit && npx vitest run` ·
`cd poc/client && npx tsc -b && npx vitest run`.
**Hub/client checks need `poc/server` built first** (`cd poc/server && npm run build`)
whenever a server export changed — pretest does not fire under `npx vitest run`.
Suite baselines on main: server 725 · hub 195 · client 361. Suite counts only
grow on this branch; a task's Verify must show its NAMED new cases in the run
output, not just an unchanged green (exact totals are read from the run, never
predicted).

**Plan-level done criterion:** all 13 task Verify lines pass on the final tree,
every suite count is strictly above its baseline, and each behavior-table row
across the plan is covered by a test that appears in a run's output.

## Global Constraints

- Spec of record: `docs/specs/2026-07-31-identity-and-operating-design.md`
  (APPROVED, incl. A5 = list hub-wide / depth membership-gated, B1 deferred to
  Branch B). Spec beats plan code (standing ruling).
- `SLUG = /^[a-z0-9-]{1,40}$/` (project/session ids); `ID = /^[A-Za-z0-9_-]{1,64}$/`
  (uplink/channel ids) — both already exist; never re-declare.
- Browser error shape: `{ type: "error", message: string }`, now optionally
  `{ ..., code: "not_a_member" }`. `code` is sent ONLY where a task below says so.
- Auth env vars (hub, mirroring `poc/server/src/config.ts` semantics):
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`,
  `GITHUB_ALLOWLIST`, optional `OAUTH_CALLBACK_URL`. Intent is signalled by
  `GITHUB_CLIENT_ID` alone; all-or-nothing; values trimmed on assignment.
- Secrets never travel in URLs (v7 spec §10.1): bearer tokens in
  `Authorization: Bearer <token>` headers; pairing codes in POST bodies.
- Uplink credential refusal close code: **4401**, reason `"unauthorized"`
  (NOT 1008 — the relay reads 1008 as a protocol/version mismatch).
- Standing gotchas: never `git add -A` (user WIP in tree); client typecheck is
  `npx tsc -b`; TDD per soltero-skills:lean-tdd; every access-control change
  gets refusal tests AND a pass-through test.

## Task Dependency Table

| Task | Files touched | Depends on | Risk tier |
|------|---------------|------------|-----------|
| 1. Stale-citation docs fixes | `docs/PRD.md`, `docs/tech-debt.md` | — | mechanical |
| 2. Hub auth config + HTTP routes | `poc/hub/src/hubEnv.ts` (new), `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/hubEnv.test.ts` (new), `poc/hub/test/httpSurface.test.ts` | — | standard |
| 3. Verified identity stamping | `poc/hub/src/hub.ts`, `poc/hub/test/routing.test.ts` | 2 | judgment |
| 4. Membership gates on participation | `poc/hub/src/hub.ts`, `poc/hub/test/routing.test.ts` | 3 | standard |
| 5. Project-list redaction | `poc/hub/src/hub.ts`, `poc/server/src/server.ts`, `poc/hub/test/routing.test.ts`, `poc/server/test/server.test.ts` | 4 | standard |
| 6. HubDb schema v2: devices | `poc/hub/src/hubDb.ts`, `poc/hub/test/hubDb.test.ts` | — | judgment |
| 7. Pairing module | `poc/hub/src/pairing.ts` (new), `poc/hub/test/pairing.test.ts` (new) | 6 | judgment |
| 8. Uplink bearer enforcement + route mounting | `poc/hub/src/hub.ts`, `poc/hub/test/relayIntegration.test.ts`, `poc/hub/test/httpSurface.test.ts` | 5, 7 | judgment |
| 9. Relay auth headers | `poc/server/src/relay.ts`, `poc/server/test/relay.test.ts` | — | standard |
| 10. CLI pairing + token store | `poc/server/src/hubPairing.ts` (new), `poc/server/src/cli.ts`, `poc/server/test/hubPairing.test.ts` (new), `poc/server/test/cli.test.ts` | 7 (contract), 9; 8 (runtime only — live end-to-end pairing needs the routes mounted, unit tests inject fetch) | judgment |
| 11. Client: redacted entrance + join affordance | `poc/client/src/types.ts`, `poc/client/src/components/ProjectPicker.tsx`, `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/components/ProjectPicker.test.tsx`, `poc/client/src/components/SessionPicker.test.tsx` | 5 (contract), 4 (contract) | standard |
| 12. Client: pairing approval UI | `poc/client/src/components/ProjectPicker.tsx`, `poc/client/src/components/ProjectPicker.test.tsx` | 7 (contract), 11 | standard |
| 13. Docs sweep: today-state | `docs/PRD.md`, `docs/tech-debt.md`, `poc/server/src/relayProtocol.ts` (comment only) | 1–12 | mechanical |

`poc/hub/src/hub.ts` is shared by tasks 2, 3, 4, 5, 8 — those run SERIAL in that
order. Tasks 11 and 12 both touch `ProjectPicker.tsx` — serial, 11 then 12.
Disjoint and parallel-safe alongside the hub.ts chain: 1, 6, 9 (then 7 after 6,
10 after 9, 11–12 anytime after the plan's contracts are fixed — they code
against the wire shapes pinned here, not against landed hub code). Tasks 5, 9,
10 touch the server package — rebuild `poc/server` before hub/client verifies
that follow.

---

## Task 1: Stale-citation docs fixes *(spec §6)*

**Files:** Modify: `docs/PRD.md`, `docs/tech-debt.md`

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| PRD §8.1 cite | `docs/PRD.md:362` cites `hub.ts:337-338` for identity truncation | cites `hub.ts` `identify` (~:670-671) and `join` (~:766-767) instead |
| tech-debt §1.1 | claims hub has no `maxPayload` | rewritten: hub enforces `MAX_FRAME_BYTES` (`relayProtocol.ts:23`) at `hub.ts` (`new WebSocketServer({..., maxPayload})`); server gained `maxPayload` at audit M5; halves no longer diverge |
| PRD §8.10 Today | inherits the §1.1 error ("no pre-authentication payload limit") | corrected to match |

**Verify:** `command grep -n "337-338" docs/PRD.md` → no matches; `cd poc/hub && npx vitest run` → 195 passed (no code touched)
**Commit:** `docs: correct stale §8.1/§8.10 citations — identity-stamp sites, hub maxPayload`

## Task 2: Hub auth config + HTTP routes *(spec A1, A6)*

**Files:**
- Create: `poc/hub/src/hubEnv.ts`, `poc/hub/test/hubEnv.test.ts`
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/test/httpSurface.test.ts`

**Interfaces:**
- Consumes: `authRoutes(cfg: AuthConfig | undefined): (req, res) => boolean` and
  `type AuthConfig` from `multiplayer-ai-server/auth` (already exported,
  `poc/server/package.json:15`).
- Produces:
  - `hubEnv.ts`: `export function hubAuthFrom(env: NodeJS.ProcessEnv): { ok: true; auth: AuthConfig | undefined } | { ok: false; error: string }`
  - `HubOptions` gains `auth?: AuthConfig` (`poc/hub/src/hub.ts:52`).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| no auth intent | none of the 4 vars set | `{ ok: true, auth: undefined }` |
| full config | all 4 set (values with stray whitespace) | `{ ok: true, auth }` with every value trimmed; `callbackUrl` only when `OAUTH_CALLBACK_URL` non-empty |
| partial config | `GITHUB_CLIENT_ID` set, `SESSION_SECRET` missing | `{ ok: false, error: "SESSION_SECRET is required once GITHUB_CLIENT_ID is set — configure auth fully or not at all" }` (same wording pattern as `config.ts:44`) |
| route mounting | GET `/auth/me` on a hub with `auth` set | answered by `authRoutes` (JSON, not the SPA fallback); handler runs AFTER `/healthz`, BEFORE `serveStatic` in `hub.ts`'s `createServer` handler |
| auth off route | GET `/auth/me`, no `auth` | `{"enabled":false}` (authRoutes' own cfg-undefined branch) |
| boot refusal | `main.ts` with partial auth env | process exits non-zero printing the `hubEnv` error |
| boot line | auth configured | `main.ts` replaces the `"auth OFF — v7b1 development hub..."` line with `` `auth ON — allowlist: ${n} login(s)` ``; auth off keeps a warning line: `"auth OFF — development hub, do NOT expose this to the internet"` |

**Verify:** `cd poc/server && npm run build && cd ../hub && npx tsc --noEmit && npx vitest run` → all green, hub suite strictly above 195, run output shows the new `hubEnv` cases (no-intent / full / partial refusal) and the `/auth/me` mounted-vs-off cases
**Commit:** `feat(hub): GitHub auth routes on the hub — hubEnv validation, authRoutes mounted`

## Task 3: Verified identity stamping *(spec A1)*

**Files:**
- Modify: `poc/hub/src/hub.ts`, `poc/hub/test/routing.test.ts`

**Interfaces:**
- Consumes: `requireAuth(cookieHeader: string | undefined, cfg: AuthConfig | undefined): { ok: true; login: string | null } | { ok: false; error: string }` from `multiplayer-ai-server/auth`; `HubOptions.auth` (Task 2).
- Produces: `handleBrowser(socket, cookieHeader: string | undefined)` — the
  `wss.on("connection")` handler (`hub.ts:413-419`) passes
  `req.headers.cookie` for browser sockets.

**Behavior:** (mirrors `server.ts:1045-1058` — same rejections, same order, same
lock of display name to login)

| Case | Input / state | Expected |
|------|---------------|----------|
| identify, auth on, valid cookie, allowlisted `alice` | `{type:"identify", userId:"mallory", name:"m"}` | identity becomes `{userId:"alice", name:"alice"}`; reply `{type:"identified", userId:"alice", name:"alice"}` |
| identify, auth on, no/invalid cookie | any identify | `{type:"error", message:"authentication required"}` |
| identify, auth on, not allowlisted | valid cookie, login off-list | `{type:"error", message:"not on the allowlist"}` |
| join, auth on | join claiming `userId:"mallory"` | stamped `userId = login`, `name = login` before the membership check and before tunnelling; tunnelled `identity` carries the verified login |
| auth off | identify/join as today | claimed identity kept verbatim (existing truncation `slice(0,64)`/`slice(0,40)` unchanged) — existing tests still pass |
| already-joined guard | second identify after join | unchanged (`"already joined"`) |

**Exact values:** cookie header read once at connection upgrade (`req.headers.cookie`), held on the channel — WS messages carry no cookies.

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above Task 2's count; run output shows the stamped-identity case, both auth-on refusals, and the auth-off pass-through
**Commit:** `feat(hub): stamp verified GitHub identity on identify/join — the trust inversion`

## Task 4: Membership gates on participation *(spec A4, A5)*

**Files:**
- Modify: `poc/hub/src/hub.ts`, `poc/hub/test/routing.test.ts`

**Interfaces:**
- Consumes: `store.isMember(id: string, userId: string): boolean` (`hubStore.ts:281`); channel identity from Task 3.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| join, non-member | valid join, identity not in project members | `{type:"error", message:"join this project before joining its sessions", code:"not_a_member"}`; no replay, no snapshot, no tunnel |
| join, member | member of project | binds, replays, snapshots, tunnels exactly as today |
| watch_project / peek, no identity | either message before identify | `{type:"error", message:"identify first"}` |
| watch_project / peek, non-member | identified, not a member | `{type:"error", message:"join this project to see it", code:"not_a_member"}`; channel NOT re-homed |
| watch_project / peek, member | identified member | snapshot answered; re-home rules unchanged (`hub.ts:929-933`) |
| get_record, non-member | identified, not a member | `{type:"error", message:"join this project to see its record", code:"not_a_member"}` |
| get_record, member | identified member | record answered as today |
| snapshot fan-out | `pushProject` iterating channels | a channel receives the project snapshot only if its identity is a member (`isMember` checked at fan-out; a `leave_project` therefore silences pushes without disconnecting) |
| membership after stamping | auth on | every `isMember` call sees the VERIFIED login (Task 3 ran first in the handler) |

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above Task 3's count; run output shows each gate's refusal test AND its sibling member pass-through (existing tests that watched/joined without membership are updated to `join_project` first — each keeps the sibling refusal so the gate discriminates)
**Commit:** `feat(hub): membership gates participation — join, watch, peek, record, fan-out`

## Task 5: Project-list redaction *(spec A5)*

**Files:**
- Modify: `poc/hub/src/hub.ts`, `poc/server/src/server.ts`, `poc/hub/test/routing.test.ts`, `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `store.listProjects(): ProjectSummary[]` (`hubStore.ts:348`) — store unchanged; redaction is a hub.ts view concern.
- Produces (wire shape, both servers — one browser bundle talks to both, which is
  why the standalone `server.ts` change and the `isMember` flag ride here even
  though spec A5 names only the hub list: a field the hub sends and the
  standalone omits would fork the client's parsing):
  each `projects` list entry gains `memberCount: number` and `isMember: boolean`;
  `members` is the real roster when `isMember`, else `[]`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| list_projects, member of P | requester in P.members | entry P: `members` full, `memberCount` = roster size, `isMember: true` |
| list_projects, non-member of Q | requester not in Q.members | entry Q: `members: []`, `memberCount` = real size, `isMember: false` — no logins disclosed |
| list_projects, unidentified | no identity yet | every entry redacted (`members: []`, `isMember: false`, real `memberCount`) — the list stays the join affordance (spec A5) |
| pushProjects | project directory changed | per-channel TAILORED payloads (each channel's own redaction) replace the single broadcast at `hub.ts:338-341` |
| standalone parity | `server.ts` `list_projects` answer | same three fields added; solo values: `memberCount = members.length`, `isMember: true` |

**Verify:** `cd poc/server && npx tsc --noEmit && npx vitest run && npm run build && cd ../hub && npx tsc --noEmit && npx vitest run` → both green, both suites strictly above their prior counts; run output shows the non-member redaction case (`members: []` with real `memberCount`) and the standalone-parity case
**Commit:** `feat(hub): redact member rosters from non-members — memberCount/isMember on the list`

## Task 6: HubDb schema v2 — devices *(spec A2, A3)*

**Files:**
- Modify: `poc/hub/src/hubDb.ts`, `poc/hub/test/hubDb.test.ts`

**Interfaces:**
- Produces:
  - `export interface DeviceStore { deviceApproved(d: { machineId: string; name: string; tokenHash: string; approvedBy: string; approvedAt: string }): void; deviceByTokenHash(tokenHash: string): { machineId: string; name: string } | null; deviceRevoked(machineId: string): boolean }`
  - `HubDb implements HubPersister, DeviceStore`. `HubHydration`/`HubStore` untouched — devices are read per-lookup, never hydrated.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| fresh DB | new file | `SCHEMA_VERSION = 2` stamped; `devices` table present |
| v1 record | existing DB with `schema_version = 1` | migrated in ONE transaction: devices DDL + meta update to `'2'`; every v1 row untouched; `load()` output identical to before migration |
| newer record | `schema_version = 3` | refused with the existing message shape (`hubDb.ts:200-202`) — migration only runs FORWARD |
| approve | `deviceApproved` for new machineId | row inserted, `revoked = 0` |
| re-pair | `deviceApproved` for existing machineId (revoked or not) | upsert: new `token_hash`, `approved_by`, `approved_at`; `revoked` reset to 0; rowid preserved (`ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE` — `hubDb.ts:22-26`'s rule) |
| lookup hit | `deviceByTokenHash` of a live device | `{ machineId, name }` |
| lookup miss / revoked | unknown hash, or device with `revoked = 1` | `null` (revocation enforced in the query) |
| revoke | `deviceRevoked("m1")` | sets `revoked = 1`, returns `true`; unknown machineId returns `false` |

**Exact values:**
```sql
CREATE TABLE IF NOT EXISTS devices
                (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                 token_hash TEXT NOT NULL, approved_by TEXT NOT NULL,
                 approved_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
```
Token hash: `crypto.createHash("sha256").update(token).digest("hex")` — hashing
is the CALLER's job (Task 7); HubDb stores/compares opaque hex strings.

**Blast radius / rollback:** the v1→v2 migration is additive (one new table +
meta bump) and runs inside one transaction — a crash mid-migration leaves the v1
file intact. Before migrating a real file, the hub copies it to `<dbPath>.v1.bak`
(main-file only; taken BEFORE the migration transaction opens, while the record
is still pure v1 — the WAL is checkpointed by the open). Rollback = restore the
`.bak`; reverting to pre-branch code against a migrated file refuses at boot
with the existing newer-schema message, which is the designed fail-stop, not a
bug. `:memory:` and fresh files take no backup (nothing to lose).

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above its prior count; run output shows the v1→v2 migration case (built by writing a v1 file with raw SQL), the `.v1.bak` creation case, and the revoked-lookup `null` case
**Commit:** `feat(hub): HubDb schema v2 — revocable device records for uplink auth`

## Task 7: Pairing module *(spec A2; v7 §10.1, §10.5)*

**Files:**
- Create: `poc/hub/src/pairing.ts`, `poc/hub/test/pairing.test.ts`

**Interfaces:**
- Consumes: `DeviceStore` (Task 6); `requireAuth`, `AuthConfig` from `multiplayer-ai-server/auth`.
- Produces:
  - `export function pairingRoutes(deps: { auth: AuthConfig | undefined; devices: DeviceStore | null; onRevoked: (machineId: string) => void; now?: () => number }): (req: IncomingMessage, res: ServerResponse) => boolean` — boolean-handler pattern, same as `authRoutes`.
  - `export function hashToken(token: string): string` (sha256 hex — shared with Task 8's lookup).
  - `export const PAIRING_CODE_TTL_MS = 600_000;`
  - `export const MAX_PENDING_PAIRINGS = 100;`

**Behavior:** (all routes under `/pair/`; JSON bodies; body reads bounded to 4096 bytes — larger requests answered 413)

| Case | Input / state | Expected |
|------|---------------|----------|
| auth off | any `/pair/*`, `deps.auth` undefined | 404 `{"error":"auth is not configured"}` |
| no device store | auth on, `deps.devices` null (hub has no record) | 503 `{"error":"pairing requires a persistent hub record — set HUB_DB"}` |
| request | POST `/pair/request` `{machineId, name}` (machineId matches `ID` regex, name 1–40 chars) | 200 `{code}`; code pending for `PAIRING_CODE_TTL_MS` |
| request, bad body | missing/malformed machineId or name | 400 `{"error":"pair request requires machineId and name"}` |
| request, flooded | 100 pendings outstanding | 429 `{"error":"too many pending pairings"}` |
| approve | POST `/pair/approve` `{code}` with signed-in allowlisted cookie | 200 `{machineId, name}`; token minted, `deviceApproved` called with its hash and `approvedBy = login`; token held for exactly one poll |
| approve, anonymous | no/invalid cookie | 401 `{"error":"authentication required"}` |
| approve, denied | valid cookie, not allowlisted | 403 `{"error":"not on the allowlist"}` |
| approve, unknown/expired | bad or expired code | 404 `{"error":"unknown or expired code"}` |
| poll pending | POST `/pair/poll` `{code}` before approval | 200 `{"status":"pending"}` |
| poll approved | first poll after approval | 200 `{token}`; pairing entry deleted — a second poll gets 404 (single-use, v7 spec §10.5) |
| poll unknown | bad/expired/consumed code | 404 `{"error":"unknown or expired code"}` |
| revoke | POST `/pair/revoke` `{machineId}` with signed-in allowlisted cookie | 200 `{"revoked":true}` when `deviceRevoked` returned true, then `onRevoked(machineId)`; 404 when it returned false |
| expiry sweep | entry older than TTL | treated as absent on every touch (lazy expiry — no timer) |

**Exact values:**
- Code: 8 chars from `ABCDEFGHJKMNPQRSTVWXYZ23456789` via `crypto.randomInt`; compared after uppercasing and stripping `-` (display grouping `XXXX-XXXX` is the client's choice).
- Token: `crypto.randomBytes(32).toString("base64url")`; plaintext exists only in the pending entry between approve and poll, and in the 200 poll body — never stored, never in a URL.
- Pending state is in-memory only (a hub restart drops pending pairings; approved devices persist in HubDb).

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above its prior count; run output shows the full pairing round-trip (request → approve → single poll), the three approve refusals (401/403/404), and the single-use second-poll 404
**Commit:** `feat(hub): pairing — short-lived codes, browser approval, hash-stored bearers`

## Task 8: Uplink bearer enforcement + route mounting *(spec A2, A3)*

**Files:**
- Modify: `poc/hub/src/hub.ts`, `poc/hub/test/relayIntegration.test.ts`, `poc/hub/test/httpSurface.test.ts`

**Interfaces:**
- Consumes: `pairingRoutes`, `hashToken` (Task 7); `DeviceStore` via `db` (Task 6); `HubOptions.auth` (Task 2).
- Produces: `handleUplink(socket, req: IncomingMessage)`; pairing routes mounted in the HTTP handler after auth routes, before static.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| auth off | any uplink connection | accepted exactly as today (no header required) — existing uplink tests unchanged |
| auth on, no header | `/uplink` upgrade without `Authorization` | socket closed `4401` `"unauthorized"` before any frame is processed |
| auth on, bad token | `Authorization: Bearer x` with unknown/revoked hash | closed `4401` `"unauthorized"` |
| auth on, valid token, matching hello | device record machineId `m1`, `hello` with `uplinkId:"m1"` | accepted; attach/welcome exactly as today |
| auth on, identity mismatch (A3) | valid token for `m1`, `hello` with `uplinkId:"m2"` | closed `4401` `"unauthorized"` — a bearer authenticates exactly the machineId it was approved for |
| eviction now gated | incumbent `m1` live; second connection presents `m1`'s valid bearer and hellos as `m1` | supersede path runs as today (`hub.ts:465-470`) — reconnect-recovery preserved, hijack closed |
| live revocation | `onRevoked("m1")` while `m1` connected | that uplink's socket closed `4401`; store `detach` runs via the existing close handler |
| auth on, no device store | `auth` set but hub has no `db` | every uplink refused `4401` (fail-closed; pairing already answers 503 per Task 7) |

**Verify:** `cd poc/hub && npx tsc --noEmit && npx vitest run` → green, suite strictly above its prior count; run output shows the 4401 refusals (no header / bad token / identity mismatch / no-store fail-closed), the valid-bearer pass-through, and the gated-eviction case
**Commit:** `feat(hub): uplinks authenticate — bearer bound to machineId, eviction gated, revocation live`

## Task 9: Relay auth headers *(spec A2)*

**Files:**
- Modify: `poc/server/src/relay.ts`, `poc/server/test/relay.test.ts`

**Interfaces:**
- Produces:
  - `RelayOptions` gains `headers?: Record<string, string>` and `onUnauthorized?: () => void`.
  - `export type ConnectFn = (url: string, headers?: Record<string, string>) => RelaySocket;`
  - `defaultConnect` passes headers through: `new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, headers })`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| headers plumbed | relay started with `headers` | every `connect()` call (initial and reconnect) receives them |
| no headers | option absent | `connect(url, undefined)` — today's behavior byte-for-byte |
| 4401 close | socket closes with code 4401 | log ONCE `"hub refused this machine's credentials — re-pair with the hub (run mpai --hub again)"`, call `onUnauthorized?.()`, set `stopped = true` (NO reconnect loop against a refusal that cannot succeed) |
| 1008 close | unchanged | existing protocol-mismatch latch behavior untouched |

**Verify:** `cd poc/server && npx tsc --noEmit && npx vitest run` → green, server suite strictly above 725; run output shows the headers-on-reconnect case and the 4401 stop-no-reconnect case
**Commit:** `feat(server): relay sends Authorization headers, stops on credential refusal`

## Task 10: CLI pairing + token store *(spec A2, A3)*

**Files:**
- Create: `poc/server/src/hubPairing.ts`, `poc/server/test/hubPairing.test.ts`
- Modify: `poc/server/src/cli.ts`, `poc/server/test/cli.test.ts`

**Interfaces:**
- Consumes: `mpaiHome(env)` from `./machineIdentity.js`; Task 7's wire contract; Task 9's `headers`/`onUnauthorized`.
- Produces:
  - `export function httpBaseOf(hubUrl: string): string` — `ws://` → `http://`, `wss://` → `https://` (everything after the scheme verbatim, path/query dropped to origin).
  - `export function loadHubToken(home: string, hubUrl: string): string | null` / `export function saveHubToken(home: string, hubUrl: string, token: string): void` / `export function clearHubToken(home: string, hubUrl: string): void` — backed by `<home>/hubTokens.json`, `{ [hubUrl]: token }`, file mode `0600`; a malformed file is treated as empty, never a crash.
  - `export async function pairWithHub(deps: { httpBase: string; machineId: string; name: string; fetchImpl?: typeof fetch; print: (line: string) => void; pollIntervalMs?: number }): Promise<{ ok: true; token: string } | { ok: false; error: string }>`

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| stored token | `--hub` launch, token on file for this URL | relay gets `headers: { authorization: "Bearer <token>" }`; no pairing round |
| no token, auth-on hub | `/pair/request` succeeds | prints exactly: `` `pair this machine: open ${httpBase} in a signed-in browser and approve code ${XXXX-XXXX}` `` (code displayed grouped 4-4); polls every 2s; on `{token}` saves it and proceeds to launch |
| no token, auth-off hub | `/pair/request` answers 404 | proceed WITHOUT a token or headers — an auth-off hub accepts bare uplinks (Task 8), so dev flow stays zero-config |
| pairing expires | polls reach TTL / poll answers 404 after pending | `{ ok: false, error: "pairing expired — approve the code within 10 minutes" }`; CLI exits non-zero with that line |
| hub unreachable | fetch rejects | `{ ok: false, error }` naming the URL; CLI exits non-zero |
| mid-run revocation | relay fires `onUnauthorized` | the CLI-wired callback runs `clearHubToken` (the relay already logged the re-pair instruction); the next launch re-pairs cleanly |

**Verify:** `cd poc/server && npx tsc --noEmit && npx vitest run` → green, server suite strictly above Task 9's count (fetch injected; no network); run output shows the stored-token skip, the full pairing loop, the auth-off 404 passthrough, and the expiry error line
**Commit:** `feat(cli): pair with the hub — token store, pairing loop, bearer on the uplink`

## Task 11: Client — redacted entrance + join affordance *(spec A5)*

**Files:**
- Modify: `poc/client/src/types.ts`, `poc/client/src/components/ProjectPicker.tsx`, `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/components/ProjectPicker.test.tsx`, `poc/client/src/components/SessionPicker.test.tsx`

**Interfaces:**
- Consumes: Task 5's list shape (`memberCount`, `isMember`, redacted `members`); Task 4's `code: "not_a_member"`. `/auth/me`-driven sign-in state already works against the hub once Task 2 lands (`authState.ts` fetches the same route).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| member count | entrance list | reads `memberCount` (falls back to `members.length` when the field is absent — old-server tolerance), so redacted projects still show true counts — `ProjectPicker.test.tsx` |
| JOIN badge | `isMember: false` | JOIN affordance shown from `isMember`, no longer from `members.includes(userId)` (`ProjectPicker.tsx:102`) — `ProjectPicker.test.tsx` |
| membership refusal | any `{type:"error", code:"not_a_member"}` on the project screen | SessionPicker shows the join-project affordance (the existing `join_project` sender at `SessionPicker.tsx:177`) instead of an error toast; after `join_project` is sent and a `projects` push shows membership, `watch_project` is re-sent — `SessionPicker.test.tsx` |

**Verify:** `cd poc/server && npm run build && cd ../client && npx tsc -b && npx vitest run` → green, client suite strictly above 361; run output shows the memberCount fallback, the isMember JOIN badge, and the not_a_member join-affordance cases
**Commit:** `feat(client): membership-aware entrance — redaction-safe counts, join affordance`

## Task 12: Client — pairing approval UI *(spec A2)*

**Files:**
- Modify: `poc/client/src/components/ProjectPicker.tsx`, `poc/client/src/components/ProjectPicker.test.tsx`

**Interfaces:**
- Consumes: Task 7's `/pair/approve` route contract; the signed-in state ProjectPicker already receives.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| visibility | signed-in user on the entrance | a "pair a machine" input is shown; anonymous/auth-off users never see it |
| approve | code typed (any case, with or without `-`) | normalized (uppercase, strip `-`), POSTed to `/pair/approve` as `{code}` same-origin (cookie rides); on 200 shows `paired: <name>` |
| approve fails | non-200 response | the response's error text shown inline |
| stale comment | `ProjectPicker.tsx:14-15` ("Visibility is hub-wide; membership only governs acting") | updated to the approved A5 policy: the LIST is hub-wide; depth is membership-gated |

**Verify:** `cd poc/client && npx tsc -b && npx vitest run` → green, client suite strictly above Task 11's count; run output shows the signed-in-only visibility case, the normalize-and-POST case, and the error-text case
**Commit:** `feat(client): pairing approval on the entrance — signed-in code approval`

## Task 13: Docs sweep — today-state *(spec §6)*

**Files:** Modify: `docs/PRD.md` (§8.1 *Today* block, `docs/PRD.md:357-363`), `docs/tech-debt.md` (§2.5), `poc/server/src/relayProtocol.ts` (comment only, `relayProtocol.ts:47-55`)

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| PRD §8.1 Today | `docs/PRD.md:357-363` describes the pre-branch state | rewritten: hub verifies identity (GitHub at the hub), machines pair with hash-stored revocable bearers bound to machineId, participation membership-gated; remaining final-state gap = project-scoped invites (§8.2) |
| relayProtocol comment | `relayProtocol.ts:47-55` "the bound that holds today is project membership" | note updated: the bound is now ENFORCED (join/watch/peek/record + fan-out gates) — comment only, zero code change |
| tech-debt | §2.5 (invite flow dead through hub) | annotated: unblocked by this branch's identity plane, still §8.2's item; add any new debt discovered during the branch |
| audit M4 | `Docs/audit-2026-07-30.md` unchanged (audit files are records) | PRD/tech-debt reference this branch as M4's remediation of record; the HOST fail-closed boot check is disclosed as Branch B (B6) |

**Verify:** `cd poc/server && npx tsc --noEmit && npx vitest run && npm run build && cd ../hub && npx tsc --noEmit && npx vitest run && cd ../client && npx tsc -b && npx vitest run` → all three suites green at their final branch counts (each strictly above its main baseline: server >725, hub >195, client >361)
**Commit:** `docs: §8.1 shipped — today-state sweep, membership bound now enforced`
