# A2a — GitHub OAuth, Allowlist, and Verified Identity

**Date:** 2026-07-27
**Status:** Approved design (brainstormed with user; sections reviewed and approved)
**Scope:** Identity only. The per-session credential and provider work is A2b — see §9.
**Supersedes nothing.** Amends the deployment strategy spec `2026-07-25-deployment-strategy-design.md` §4 on one point (§1.2 below).

---

## 0. Context and decision record

Reading A of the production-readiness programme decomposes into A1a → A2 → A3 → A4 → A1b.
A1a (deployment wiring) is merged. This spec covers the first half of A2.

**A2 was split during brainstorming.** The original A2 bundled identity (OAuth + allowlist) with
billing (bring-your-own API key). The billing half turned out to depend on an unresolved question
about model providers, which in turn depends on an unrun experiment. The identity half depends on
nothing. Splitting lets identity ship immediately instead of waiting behind a spike.

| Decision | Choice | Why |
|---|---|---|
| Invites vs OAuth | **Both — two layers** | They answer different questions (§1.2) |
| Landing page | **Yes, and invite links get their own sign-in screen** | An invite is personal; a generic login page wastes the moment (§3) |
| Identity source | **GitHub login, server-derived** | The client's `userId` is currently self-asserted and unverifiable (§2) |
| Access control | **Flat allowlist of GitHub usernames** | No user database; add = grant, remove = revoke |
| Auth activation | **Only when `GITHUB_CLIENT_ID` is set** | Mirrors A1a's `CLIENT_DIST` production signal; dev and tests untouched (§5) |
| Deploy safety | **Config validator refuses production without auth** | Enforces §3e's "no public URL without auth" in code, not discipline (§5) |
| Session credential | **One API key per session** (A2b) | Preserves deployment spec §3e; see §9 for why per-user was analysed and deferred |
| Model provider | **Pluggable, session-scoped** (A2b) | See §9 |

### 0.1 Prior decisions this preserves

- Deployment spec §3e's **identity/billing decoupling** stands unchanged. Identity comes from
  GitHub; compute bills per session. Per-user keys were analysed in detail during this
  brainstorm and deliberately deferred (§9.2) — §3e needs no amendment.
- The **invite system** (#12) is retained in full. Nothing in this spec deprecates it.
- **Credentials-as-identity remains rejected** (deployment spec §3e). An API key is an opaque
  bearer with no name; it cannot support the wedge. This spec is the positive form of that
  ruling — identity comes from OAuth, and only from OAuth.

---

## 1. The access-control model

### 1.1 Three layers

| Layer | Question it answers | Mechanism | Default |
|---|---|---|---|
| GitHub OAuth | *Who are you?* | Authorization-code flow, signed cookie | On when configured |
| Allowlist | *May you use this server?* | Flat list of GitHub logins in env | On when configured |
| Invites (#12) | *May you enter this session?* | Project-scoped token, TTL, revocation | **Off** (`REQUIRE_INVITE=0`) |

### 1.2 Amendment to the deployment strategy spec

`2026-07-25-deployment-strategy-design.md` §4 states that GitHub OAuth "replaces both the week-1
secret-URL idea and the week-2 invite-token idea." That was written **before** the invite system
was built and merged. It is amended: OAuth replaces the secret-URL idea only. Invites remain the
in-session seat mechanic.

**Why both.** OAuth answers *who are you* and is required for the wedge — every decision on the
wire carrying a verified human name. Invites answer *which session may you enter*, and are the
natural artifact a beta user actually shares ("here, drop into my session"). Neither subsumes the
other. For the friends beta the allowlist alone gates the server, so `REQUIRE_INVITE` stays off;
it becomes useful when session-level scoping is wanted.

---

## 2. The core change: identity stops being self-asserted

Today the browser generates its own identity and the server takes it on trust:

- `poc/client/src/identity.ts:20` — `loadOrCreateUserId()` mints a `crypto.randomUUID()` into
  `sessionStorage`.
- `poc/client/src/useSessionSocket.ts:44` — that value is sent in the `join` payload.
- `poc/server/src/server.ts:295-304` — the server validates only that `userId` is a *string*.

Anyone can claim to be anyone. Every downstream attribution — permission approvals, take-the-wheel,
`oversight_pull`, arcade scores — inherits that weakness.

**After A2a, when auth is enabled, the server derives `userId` from the verified session cookie and
ignores the client's claim entirely.** This is the single change that makes the product's central
claim true rather than decorative. Everything else in this spec exists to support it.

When auth is disabled (no `GITHUB_CLIENT_ID`), the current client-asserted behaviour is retained
verbatim so that development, tests, and demo recipes are untouched.

---

## 3. Screens and flow

### 3.1 Signed out at the root

A landing page: what the product is, and a **Sign in with GitHub** button. This is the only
marketing surface; it is deliberately minimal.

### 3.2 Signed out with an invite token

**Not** the landing page. A dedicated screen showing *what you were invited to* — session name and
who invited you — then the same sign-in button. The invite token survives the OAuth round trip and
the user lands directly in the session.

`peek_invite` already returns this metadata without spending the token, and is already reachable
unauthenticated (`server.ts:358-373`), so this needs no new unauthenticated surface.

**Rationale.** An invite is a personal artifact. Being met with a generic login page discards the
one moment the product is trying to make feel good. The cost is one extra screen.

### 3.3 Authenticated but not allowlisted

A denied screen showing **the user's own GitHub login**, so they can send it to the operator to be
added. Not an error page — a next-step page.

### 3.4 Authenticated and allowlisted

Straight through to the existing flow. The lobby still appears for glyph and colour selection, but
the **name field is locked to the GitHub login**. Choosing your own display name would reintroduce
exactly the impersonation this spec removes. Glyph and colour stay free — the co-op framing is
unaffected by them (deployment spec §4: "glyph/color still user-chosen").

### 3.5 Routing precedence

`App.tsx:64-67` currently branches on the invite token first. The new order is:

1. Invite token present and signed out → invite sign-in screen (§3.2)
2. Signed out → landing page (§3.1)
3. Signed in, not allowlisted → denied screen (§3.3)
4. Invite token present and signed in → invite landing (existing `InviteLanding`)
5. Otherwise → existing behaviour (session picker / lobby / session view)

When auth is disabled the first three branches are unreachable and the existing order applies
unchanged.

---

## 4. Server design

### 4.1 A dedicated `auth.ts` module

`server.ts` is 809 lines. Auth gets its own file rather than growing it further.

| Export | Purpose |
|---|---|
| `authRoutes(config)` | Request handler for the four `/auth/*` routes |
| `signSession(login, secret)` | HMAC-signed cookie value |
| `verifySession(cookieHeader, secret)` | `{ login } \| null` — pure, no I/O, directly testable |
| `isAllowlisted(login, allowlist)` | Case-insensitive, whitespace-tolerant membership |

**Routes:**

| Route | Behaviour |
|---|---|
| `GET /auth/login` | Redirect to GitHub `authorize` with a random `state` set as a short-lived cookie; optional `?next=` preserved for the invite return path |
| `GET /auth/callback` | Validate `state`, exchange `code` for an access token, fetch the login from `api.github.com/user`, set the session cookie, redirect to `next` or `/` |
| `POST /auth/logout` | Clear the cookie |
| `GET /auth/me` | `{ login, allowlisted }` or 401 — the client's authentication check |

**Cookie.** HMAC-SHA256 over `{login, issuedAt}` with `SESSION_SECRET`. `httpOnly` (so no script
can read it, including anything injected), `SameSite=Lax` (survives the OAuth redirect back),
`Secure` when the request arrived over TLS, and a fixed expiry. No server-side session store —
the cookie is self-contained, which keeps the "no user database" property.

### 4.2 HTTP handler ordering

The auth routes are registered **after `/healthz` and before the static handler**, for the reason
A1a already documented at `server.ts:224-258`: the static handler's SPA fallback serves
`index.html` for any extensionless path, so an auth route wired after it would return HTML with a
200 and never run. The guarding test asserts the response **body**, not the status.

### 4.3 WS join

`server.ts:262` is currently `wss.on("connection", (ws: WebSocket) => {`. It gains the request
argument so the cookie header is reachable: `(ws, req) => {`.

At the `join` branch (`server.ts:295`), when auth is enabled:

1. Verify the cookie. Absent or invalid → `sendError("authentication required")`.
2. Check the allowlist. Not listed → `sendError("not on the allowlist")`.
3. **Overwrite** `msg.userId` with the verified GitHub login.

This sits **before** the invite gate and therefore before any provisioning, matching the existing
ordering rationale (`server.ts:278-303` — a rejected join must never create a git worktree).

**Why join-level and not upgrade-level.** Rejecting at the WS upgrade would also block the
unauthenticated `peek` and `peek_invite` calls that the landing and invite screens depend on, and
would give the client a socket close with no explanation instead of a readable error. Join-level
also matches where the invite gate already lives.

### 4.4 Fail-fast configuration

`config.ts:12` `validateProductionConfig` gains two production requirements. When `CLIENT_DIST` is
set, the process exits 1 unless **all** of `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`SESSION_SECRET`, and a non-empty `GITHUB_ALLOWLIST` are present.

This is the code-level enforcement of the §3e property that there is never a window where a public
URL exists without authentication. The function stays pure — the filesystem probe remains injected,
as established in A1a.

### 4.5 Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `GITHUB_CLIENT_ID` | — | **Presence enables auth.** Unset = current anonymous behaviour |
| `GITHUB_CLIENT_SECRET` | with client id | OAuth app secret |
| `SESSION_SECRET` | with client id | Cookie signing key |
| `GITHUB_ALLOWLIST` | with client id | Comma-separated GitHub logins |
| `OAUTH_CALLBACK_URL` | optional | Defaults to the request origin + `/auth/callback` |

---

## 5. Why auth is opt-in rather than always-on

Mandatory auth would force a GitHub round trip into every local run, break every `?name=alice`
demo deep link, and require reworking a large share of the 227 server tests. Gating on
`GITHUB_CLIENT_ID` reuses the pattern A1a already established for `CLIENT_DIST` and keeps one
production-shaped code path rather than a permanent dev bypass flag.

The risk of opt-in auth — shipping with it accidentally off — is closed by §4.4: production mode
cannot start without it.

---

## 6. Testing

| Area | Tests |
|---|---|
| `auth.test.ts` (new) | Cookie sign/verify round trip; tampered signature rejected; expired cookie rejected; malformed and absent headers; allowlist case-insensitivity and whitespace; `state` mismatch rejected |
| `config.test.ts` (extend) | Production missing each of the four new vars; empty allowlist; all present passes; dev mode unaffected |
| `httpSurface.test.ts` (extend) | `/auth/me` returns JSON not HTML with a `staticDir` configured (the A1a ordering trap); 401 when signed out |
| `server.test.ts` (extend) | Join with no cookie rejected when auth on; join with valid cookie yields the GitHub login as `userId` **even when the client sends a different one**; non-allowlisted join rejected; auth-off path unchanged |
| Client | Pure functions only (auth-state parsing, return-path construction). There is no component-test infrastructure — the screens are verified by driving the browser, per the established pattern |

**The load-bearing test** is the one asserting that a client-supplied `userId` is discarded in
favour of the cookie's login. That single assertion is what guards §2.

---

## 7. Honest security bounds

Stated so they are not later reported as defects:

- **The allowlist is the entire access-control system.** No roles, no per-session permissions
  beyond invites, no audit of who added whom.
- **A stolen session cookie is a valid session** until it expires. There is no revocation list —
  removing someone from the allowlist blocks their *next* join, not their current socket.
- **`SESSION_SECRET` rotation invalidates every cookie.** Acceptable; it means everyone signs in
  again.
- **GitHub is a single point of failure.** If GitHub OAuth is down, nobody can sign in. Acceptable
  for a friends beta.
- **No rate limiting** on `/auth/*`. Carried from the existing posture (invite spec §7).
- **The invite token still rides the URL** and is still visible in the address bar (#12 deferred
  item). OAuth does not change that.
- Carried, unchanged by this spec: the Bash-allowlist two-hop escape and the trusted-driver
  boundary.

---

## 8. Out of scope for A2a

Email/password, any user database, roles or permissions, GitHub org membership as the allowlist
(deployment spec §6 roadmap), other OAuth providers, token refresh, session revocation, per-user
API keys (§9.2), and provider selection (§9.1).

---

## 9. Deferred, with reasons

### 9.1 A2b — provider and session credential

Decided during this brainstorm, to be specified separately:

- **One API key per session**, supplied by the founder, held in memory, falling back to the box
  key. Preserves deployment spec §3e.
- **Provider is pluggable and session-scoped.** `poc/server/src/models.ts` becomes a
  provider-scoped registry (provider → env map + model roster) rather than a flat Claude-only list.
- **The mechanism is environment variables**, verified against the installed SDK:
  `Options.env` **replaces** the subprocess environment rather than merging
  (`sdk.d.ts:1416-1432`), so it must be spread over `process.env`. The model option is typed
  `model?: string` (`sdk.d.ts:5039`) — a free string, not a Claude-only union — so any model
  identifier passes through to whatever endpoint the process is pointed at.
- **Provider coverage available through env vars alone** (grepped from the shipped SDK bundle):
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (gateway), `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_GATEWAY`.

**A2b is gated on a spike** (§10). The permission gate survives a model swap — `canUseTool` is a
harness feature that fires before the model is consulted — but three things do not survive and
must be expected: thinking blocks (no equivalent outside Anthropic), server-side tools
(WebSearch/WebFetch run on Anthropic infrastructure), and prompt caching. The system prompt at
`agentDriver.ts:137` is also written specifically for Claude; per-provider prompt tuning is real
work, not a footnote.

### 9.2 Per-user API keys — analysed, deferred

The user asked whether six people in a party could each use their own key. It is architecturally
possible: `sdk.d.ts:1784` documents `resume?: string`, which loads conversation history from
`~/.claude/projects/`, so a turn can start a fresh agent process under a different key and continue
the same conversation. This **invalidates the original §3e reasoning** that re-keying would kill
context — but §3e's *conclusion* was kept anyway, on cost grounds:

1. **Per-turn process startup.** Every turn would respawn the agent and rehydrate history from
   disk. `sdk.d.ts:1590` references a resume-materialisation timeout, so this is non-trivial, and
   it scales with conversation length.
2. **Prompt cache invalidation — the expensive one.** Caches are per key. Strict alternation
   between drivers yields zero cache hits and can cost several times a single shared key. Per-user
   keys, done naively, make the total larger for everyone.
3. **Cross-provider replay.** Handing off from Claude to another model family replays
   Claude-shaped history — dropped thinking blocks, differing tool-result formats — into a model
   that did not produce it.

**If per-user keys are ever built, the shape is:** billing follows the wheel (whoever starts a turn
pays for it; approvals never re-key), re-key on *handoff* rather than per turn (bounding costs 1
and 2 to handoff boundaries), and provider pinned per session with only the key varying per person
(eliminating cost 3 entirely). Also unresolved: custody of N live keys in server memory, which
§3e's assume-breach framing explicitly warned against, and the failure UX when one participant's
key is rate-limited while others are not.

Tracked as a research item to run after A2b.

---

## 10. Prerequisites and risks

**User action required before building:** register a GitHub OAuth app with callback
`http://localhost:3001/auth/callback`. No public URL is needed — GitHub accepts localhost callbacks
for development, which is the reason deployment could be moved last (§3e).

**Risks:**

- The WS `connection` handler is the busiest code path in the server. The change is small (one
  extra parameter) but the blast radius is not.
- Cookie behaviour across the OAuth redirect (`SameSite`) is the classic failure point and cannot
  be fully verified by unit tests — it needs a real browser run before A2a is called done.
- The invite return path (token → sign in → back to the invite) crosses client routing, the OAuth
  `state`/`next` round trip, and the existing invite landing. It is the most likely place for a
  defect and deserves an explicit end-to-end browser check.
