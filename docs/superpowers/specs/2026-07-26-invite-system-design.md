# Invite System — Design

**Status:** design approved by controller (user away; every decision recorded with rationale in §9 for review)
**Branch:** `feature/invite-system`, stacked on `feature/oversight-agent`
**Date:** 2026-07-26

## 1. Problem

Today a session is joined by knowing its id. `mpai new <name>` prints
`http://localhost:3001/?session=<slug>&project=<p>`, and the `join` handler
(`server.ts:242-289`) accepts any well-formed slug from anyone who can reach the
port — auto-provisioning a git worktree for ids that don't exist yet
(`server.ts:156-168`). There is no membership check anywhere in the server: no ACL
on `Project`, no per-session member list, no handshake verification on the
WebSocket (`server.ts:217`).

That is fine for a solo POC and wrong for the friends beta in
`docs/superpowers/specs/2026-07-25-deployment-strategy-design.md` §2, where 3–8
people share one deployed stack. Two distinct gaps:

1. **Capability.** An occupied session can be walked into by anyone who guesses or
   is forwarded its id. There is no way to say "these people, this room."
2. **Social artifact.** The shareable URL carries no sense of who invited you or
   into what. A teammate receives a bare localhost link and lands in a generic
   lobby. The product's whole thesis is *awareness* — the invite is the first
   awareness moment and currently it conveys nothing.

## 2. Goals and non-goals

**Goals**

- A driver or any participant can mint a **shareable invite link** for the session
  they're in, and see/revoke the ones already outstanding.
- Opening an invite link shows a **landing screen** naming the inviter, project,
  and session before the recipient commits to joining.
- Joining through an invite is **attributed on the wire** — the party sees that
  bob arrived on ana's invite.
- An opt-in server mode (`requireInvite`) where **occupied sessions cannot be
  joined without a valid invite**.

**Non-goals (explicitly out — do not build)**

- User accounts, passwords, OAuth, or any identity provider. The deployment spec
  §4 already rules GitHub OAuth as the auth answer for the public surface; this
  feature must not grow into a competing auth system.
- Persistence. Invites live in memory and die with the process, like every other
  piece of server state in this POC.
- Email/SMS delivery, org or team management, roles beyond the existing
  driver/participant split, per-invite permission scoping.
- Rate limiting, brute-force lockout, or timing-attack hardening (see §7 for the
  honest bound on what this feature does and does not claim).

## 3. What an invite is

An in-memory capability record, minted by a participant, scoped to exactly one
session:

```ts
interface Invite {
  id: string;          // public, 8 chars — safe to put on the wire
  token: string;       // secret, 32 chars base64url (24 CSPRNG bytes)
  projectId: string;
  sessionId: string;
  createdBy: string;   // userId
  createdByName: string;
  createdAt: number;
  expiresAt: number;   // createdAt + inviteTtlMs (default 24h)
  maxUses: number;     // default 10
  redeemedBy: Set<string>;  // distinct userIds; size is the use count
  revoked: boolean;
}
```

`id` and `token` are drawn from **separate** CSPRNG calls — the public id is never
derived from the secret. Uses are counted by **distinct `userId`**, so a recipient
who reloads (a new tab mints a new sessionStorage identity, `identity.ts:21-28`)
or rejoins does not burn additional slots for the same person.

**The link is `http://<host>/?invite=<token>` and carries nothing else.** The
server resolves project and session from the token, so the URL leaks no ids and
cannot be hand-edited to point at a different room.

## 4. Architecture

A new server module `poc/server/src/invites.ts` owns the whole lifecycle —
`InviteStore` with `mint`, `peek`, `redeem`, `listFor`, `revoke`, and lazy
pruning. It is a plain class with injected `now()` for testability, no timers, no
I/O, no SDK. This mirrors `overseer.ts`: the logic lives in a focused, separately
testable module and `server.ts` only wires it.

Everything rides the **WebSocket channel**. There is no HTTP route layer in this
server — `staticHandler` is the only request handler and it is `undefined` in dev
and in most tests (`server.ts:214-216`) — so an `/invite/<token>` HTTP endpoint
would mean inventing a routing layer for one read. The `?invite=` query parameter
also matches the established client URL surface (`?session`, `?project`, `?name`,
`?screen`, read at `App.tsx:28-47`) and avoids depending on SPA path fallback
behavior in the Vite dev server.

### Wire additions

**Pre-join** (alongside `peek`, `watch_project`, `set_oversight`):

| command | reply | notes |
|---|---|---|
| `peek_invite { token }` | `invite_info { projectId, sessionId, inviterName, expiresAt, remaining }` or `error` | Non-consuming preview. Does **not** count a use, does **not** provision anything. |

**Post-join** (require `ctx`; no `canPrompt` gate — see §9.3):

| command | reply | appended event |
|---|---|---|
| `create_invite {}` | `invite_list` (direct, to the requesting socket only) | `invite_created { userId, inviteId, expiresAt, maxUses }` |
| `list_invites {}` | `invite_list` (direct) | none |
| `revoke_invite { inviteId }` | `invite_list` (direct) | `invite_revoked { userId, inviteId }` |

**`join`** gains an optional `invite: string` field. On a valid token the server
appends `invite_redeemed { userId, inviteId }` after `presence_join`.

### The token never touches the session log

`invite_list` is sent **directly to the requesting socket** and is the only
message carrying `token`. The three new `SessionEvent` arms carry `inviteId`
only. Rationale: the session log is replayed in full to every late joiner
(`server.ts:263-268`), is the demo transcript, and cannot be un-replayed after a
revoke. A secret in an append-only replay log is a secret you can never withdraw.

### Enforcement: `requireInvite`

A new `startServer` option, **default `false`**. When false the entire feature is
additive — every existing URL, test, and demo keeps working, and invites are a
convenience. When true, `join` requires a valid invite token **unless the target
session currently has zero participants**, in which case the first arrival founds
the room and takes the wheel (existing `session.ts:58` behavior).

The gate sits **before** `getOrCreateProject` / `getOrCreateSession`
(`server.ts:260-262`) so a rejected join never provisions a worktree.

## 5. Client surface

- **`inviteLink.ts`** (new, pure + tested): build a link from a token and origin,
  read `?invite=` off a query string, format `expiresAt` as a relative label and
  `uses/maxUses` as a remaining count. Pure-function module beside its
  `.test.ts`, per the repo's recorded pattern (`sessionRow.ts:3-4`).
- **`components/InviteLanding.tsx`** (new): a top-level screen shown when
  `?invite=` is present, before the Lobby. Opens its own throwaway WebSocket and
  sends `peek_invite` — the same idiom `Lobby.tsx:25-35` uses for `peek` and
  `SessionPicker.tsx:20-24` uses for `watch_project`. Renders
  "◆ ANA INVITED YOU · project/session", expiry and remaining seats, and a
  PRESS START that continues into the Lobby with project and session prefilled.
  Invalid/expired/revoked/exhausted tokens render a plain terminal-styled reason
  and a link to the session picker.
- **`components/InvitePanel.tsx`** (new): the INVITE screen inside a session,
  **hotkey I** (S/W/O are taken; Esc closes, matching `App.tsx:179-202`). Lists
  outstanding invites with their full links, a CREATE INVITE button, and per-row
  REVOKE. A separate screen rather than a main-view panel, per the standing rule
  that the main view is already dense.
- **Header** gains an INVITE button beside WORKFLOWS/OVERSIGHT.
- **Transcript** renders the three new events as system lines
  ("◆ ana created an invite", "◆ bob joined via invite a1b2c3d4",
  "◆ ana revoked invite a1b2c3d4").
- **`useSessionSocket.ts`** carries the token into the join payload
  (built at `useSessionSocket.ts:40-51`).

## 6. Exact strings

Errors (server → client, verbatim):

- `"peek_invite requires a token"`
- `"invite not found"` — unknown, malformed, or over-length token
- `"invite expired"`
- `"invite revoked"`
- `"invite is full"`
- `"this session requires an invite"` — `requireInvite` join rejection
- `"revoke_invite requires an inviteId"`
- `"unknown invite: <id>"`

The post-join commands need no "you must join first" string of their own — they
sit below the existing `ctx` gate at `server.ts:369`, which already answers
`"join a session first"`.

Client copy:

- Landing headline: `<NAME> INVITED YOU`
- Landing subline: `<projectId> / <sessionId>`
- Empty invite list: `NO ACTIVE INVITES`
- Create button: `[ CREATE INVITE ]`, revoke: `[ REVOKE ]`
- Seats label: `<n> SEATS LEFT`, expiry label: `EXPIRES IN <n>H`

## 7. Security posture — the honest bound

What this feature **does** claim: an occupied session cannot be joined by someone
who does not hold a currently-valid, unexpired, unrevoked, unexhausted token,
when the server runs with `requireInvite: true`. Tokens are 192-bit CSPRNG values
(`crypto.randomBytes(24)`), never logged, never appended to the replayed session
log, and always length-checked before lookup.

What it **does not** claim, and must not be described as claiming:

- It is **not authentication.** There are no accounts; a token identifies a
  capability, not a person. The `userId` on the wire is still client-asserted,
  exactly as before. GitHub OAuth (deployment spec §4) remains the auth answer.
- The **founder slot stays open**: with `requireInvite: true`, an empty or
  not-yet-existing session id can still be founded by anyone who reaches the
  port, provisioning a worktree. Closing that requires real auth, not invites.
- **No timing hardening, no rate limiting.** Lookup is a `Map` get; a constant-time
  compare around an O(1) hash lookup would be security theater. Brute-forcing a
  192-bit token over a WebSocket is not a threat this POC needs to price in, but
  a public deployment must add rate limiting alongside OAuth.
- **No persistence** — a restart voids every outstanding invite. Acceptable and
  in keeping with the rest of the server; worth saying out loud in the beta
  onboarding.

## 8. Testing

Server, in the established `server.test.ts` idiom (`connect`/`collect`/`wait`
helpers at `server.test.ts:19-31`):

- mint → `invite_list` reply carries a token; the session log carries
  `invite_created` **without** a token
- `peek_invite` on a valid token returns project/session/inviter and does not
  consume a use
- `peek_invite` on unknown/expired/revoked/exhausted tokens returns the exact §6 strings
- join with a valid token appends `invite_redeemed` attributed to the joiner
- the same userId rejoining does not consume a second seat; a different userId does
- `requireInvite: true`: join without a token into an occupied session is rejected
  with the exact string and **no worktree is provisioned** (assert against the
  `fakeWorkspace()` recorder at `server.test.ts:934-944`)
- `requireInvite: true`: join without a token into an empty session succeeds
- revoke makes a previously valid token fail with `"invite revoked"`

`invites.test.ts` unit-tests the store directly with an injected clock: expiry
boundary, distinct-user counting, cap enforcement, revoke, lazy pruning.

Client: `inviteLink.test.ts` covers link building, `?invite=` parsing (absent,
empty, valid), and the expiry/seats label formatting including boundaries.

Expected counts: server **187 → ~205**, client **76 → ~82**. Exact arithmetic
gets recorded in the plan's Deviations section during execution.

## 9. Decisions and rationale (for review)

1. **Query param `?invite=<token>`, not `/invite/<token>`.** No HTTP routing layer
   exists; adding one for a single read is disproportionate, and the query surface
   is what every other deep link in this app already uses. The token is the whole
   link, so nothing leaks and nothing is editable.
2. **Off by default (`requireInvite: false`).** Same discipline the oversight agent
   used: a feature that changes who can join must not silently change behavior for
   the existing demo, CLI, and 187 passing tests. The friends beta flips it on.
3. **Any participant can invite, not driver-only.** Adding a person to the room is
   team infrastructure, not a driver capability — the same reasoning that made
   `set_oversight` open to anyone while `pull_oversight` is driver-gated. The
   wheel changes hands constantly; gating invites on it would make inviting
   feel arbitrary. Every mint is attributed on the wire regardless.
4. **Tokens returned only to the requesting socket, never appended.** The log is
   replayed to all late joiners and cannot be rewritten after a revoke.
5. **Uses counted by distinct userId.** A reload mints a fresh sessionStorage
   identity; counting raw joins would burn a 1-use link before the recipient
   finished reading it. Default cap 10, default TTL 24h — generous enough that
   the beta never hits them by accident, bounded enough that a leaked link is not
   permanent.
6. **Full links visible to all participants in the INVITE screen.** Any
   participant can mint a new invite anyway, so hiding existing ones adds
   ceremony without adding security, and "shown once" flows are a known source of
   user pain.
7. **Lazy pruning, no sweep timer.** The oversight agent's one real defect this
   cycle was a dispose/timer race. A store that prunes on access has no timer to
   arm, no teardown to get wrong, and no disposal path to test.
8. **Separate INVITE screen (hotkey I), not a main-view panel.** Standing rule:
   the main view is already dense.
9. **Public `inviteId` distinct from the secret token.** So the wire, the
   transcript, and revoke-by-id can all name an invite without ever handling the
   secret.

## 10. Out of scope for v1 (candidates for later)

Invite-only projects (as opposed to sessions); named/targeted invites ("for
bob@..."); per-invite expiry or seat controls in the UI; a copy-to-clipboard
affordance beyond selectable text; QR codes; invite analytics; persistence across
restart; revoking a specific *redemption* (kicking a participant).
