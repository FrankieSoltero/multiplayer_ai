# Project-scoped invites — implementation plan

**PRD of record:** `docs/PRD.md` §8.1 final-state gap ("invites still predate projects") and §8.2
final state ("the invite flow scoped to projects"). Debt of record: `docs/tech-debt.md` §2.5
(option (c), narrowed: hub-side invite store + projectId in the invite URL) and §1.2 (token in the
address bar / `next`). Prior art: `docs/superpowers/specs/2026-07-26-invite-system-design.md`
(the session-scoped system this replaces) and `docs/superpowers/specs/2026-07-28-projects-design.md`
("the project screen's Invite control reuses the existing invite flow, retargeted from a session
to a project" — this plan is that retarget, plus the hub half).

**Process note:** written and executed directly in Kimi Code CLI — the soltero-skills
spec→council→lean-sdd pipeline is not installed in this environment, so this plan carries its own
design section (§1) and the done gate is the objective check. No council was convened.

**Goal:** invites become **project-scoped, hub-held, and durable**. The hub (and the standalone
server in solo mode) mints, lists, revokes, peeks, and redeems invites for a *project*; redemption
happens at `join_project`; the invitee lands on the project's session picker. Every invite link
works against a hub — today every one is dead (tech-debt §2.5).

**Stack / suites (baselines on this branch, read from runs 2026-08-01):**
- client: `cd poc/client && npx tsc -b && npx vitest run` (baseline 492)
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (baseline 762)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (baseline 352)
- Never predict post-change totals; read them from runs.

**Plan done gate (objective):**
1. Tasks 1–6 landed; all three suite commands run fresh, exit 0, zero failures, tsc clean.
2. `peek_invite` against a live hub answers `invite_info` for a hub-minted token (the §2.5 death
   scenario, now green) — covered by a hub integration test, not a manual walk.
3. No invite token in any persisted event / record / replayed log (grep the suites' fixtures and
   the hub events path: tokens ride `invite_list` to the requesting socket and nothing else).
4. `git diff --name-only main` touches only `poc/server/**`, `poc/hub/**`, `poc/client/**`,
   `docs/**` (and HANDOFF.md per house convention).

## §1 Design (the decisions, locked)

1. **Scope: project, not session.** `Invite` loses `sessionId`. Minting requires project
   membership; redeeming adds the invitee to the project (via `join_project`); the invitee then
   picks or creates a session like any member. PRD: "A project is the unit you invite someone into."
2. **Hub-held and durable.** New hubDb tables (schema **v3**): `invites(id TEXT PK, token TEXT
   UNIQUE, project_id, created_by, created_by_name, created_at, expires_at, max_uses, revoked
   INTEGER DEFAULT 0)` and `invite_redemptions(invite_id, user_id, composite PK)`. Migration
   follows the v1→v2 `devices` template exactly (DDL constant shared by fresh sweep and
   migration; WAL checkpoint + `.v2.bak` 0600 copy; one transaction; meta bump;
   `assertSchemaUnderstood` accepts ≤ 3). Token stored plaintext — a deliberate choice: the hub
   operator already holds every project's events, and the panel's copy-link-later UX (shipped
   behavior) needs the token back. Tokens still never touch the events/record path.
3. **Wire protocol (identical on hub and standalone server):**
   - `create_invite { projectId }` → member-gated → `invite_list` to the **requesting** socket
     (carries tokens; never broadcast — same rule as today).
   - `list_invites { projectId }` → member-gated → `invite_list`.
   - `revoke_invite { projectId, inviteId }` → member-gated → fresh `invite_list`.
   - `peek_invite { token }` → **unauthenticated** (the invitee is by definition neither a member
     nor necessarily signed in) → `invite_info { projectId, projectName, inviterName, expiresAt,
     remaining }`; errors stay the four `InviteFailure` strings, cross-project probing still
     collapses to "invite not found".
   - `join_project { projectId, invite? }` → with a token: consuming redeem **before** membership
     is written (failure → error, no membership); without: today's open join, unchanged.
   - Seat semantics unchanged: TTL 24 h, 10 uses default, distinct-userId seats, re-join by the
     same userId doesn't burn a seat, revoked > expired > full error precedence.
4. **No invite-only policy on the hub.** Projects stay openly joinable from the hub-wide entrance
   list (PRD §8.1: the list is the join affordance). Invites are directed landing + join links.
   The standalone server's opt-in `REQUIRE_INVITE` gate is **retargeted**, not ported: with the
   env on, joining an *occupied project* (instead of an occupied session) requires an invite;
   the founder joins free. Session `join` loses its `invite` field everywhere.
5. **Invite URL carries the project (option (c)):** `/?project=<id>&invite=<token>`.
   `inviteLinkFor(token, origin, projectId)`.
6. **Accept flow (client):** `InviteLanding` peeks, shows inviter + **project name**, PRESS START
   sends `join_project` with the token on its socket; success routes to `?project=<id>` (the
   picker) and `history.replaceState` strips the token from the address bar (tech-debt §1.2,
   second half). `authRoute`'s `inviteTarget` becomes `{ projectId }`.
7. **§1.2 first half:** the signed-out invite path stashes the token in `sessionStorage` and
   strips `invite` from the `next` param before building the login URL; on return the token is
   restored from storage. A lost stash (different tab/browser) degrades to "reopen the link",
   never to a wrong join.
8. **Client surface moves to the project screen.** `InvitePanel` renders inside `SessionPicker`
   (the project screen — spec 2026-07-28-projects-design). The session-level invite UI is
   **removed**: App's `"invite"` screen, the Header `▢ INVITE` button, the `I` hotkey, and
   `useSessionSocket`'s join-`invite` field + `invite_list` re-request (no more `invite_*`
   session events exist to trigger it).
9. **Off the record.** `invite_created`/`invite_revoked`/`invite_redeemed` were session events;
   project invites have no session, so they emit **no** events. The transcript and the hub record
   stay token-free by construction.
10. **Out of scope (named, not forgotten):** project close/archive client controls (the other
    §8.2 remainder); per-project invite-required policy on the hub; invite analytics.

## §2 Global constraints

1. **One protocol, two answerers.** Hub and standalone server implement the same five messages
   with the same shapes and error strings; client code paths never branch on which it's talking
   to. (Solo mode keeps its one-project entrance.)
2. **Tokens off the wire except to the requester.** `invite_list` only ever answers the socket
   that asked; `peek_invite`/`invite_info` never echo the token; nothing invite-shaped enters the
   events table or the session log.
3. **Membership is the gate for management, never for peek.** create/list/revoke require
   `store.isMember` (hub) / project membership (server); peek and redeem-with-token stay open —
   the token itself is the capability.
4. **Durable before visible** (hub house rule): redemptions and revocations write through to
   hubDb before in-memory state flips / replies go out.
5. **No spec-governed behavior silently dropped.** Anything the old session-scoped system did
   that this design removes (session join gate, session invite events, in-session panel) is
   listed in §1.4/§1.8 — if a removal turns out load-bearing, stop and amend the plan.

## §3 Tasks

Order is the dependency order; each task lands with its tests green before the next starts.
Writer rule: one task owns a file at a time.

1. **Server store retarget** — `poc/server/src/invites.ts`: drop `sessionId` from `Invite`/
   `InviteView`/`mint`/`redeem`/`listFor`/`revoke`; `InviteView` gains `projectId`. Unit tests
   (`poc/server/test/invites.test.ts`) retargeted: same coverage, project-scoped (incl. the
   cross-project "not found" collapse, now keyed on project alone).
2. **Server protocol** — `poc/server/src/server.ts` (+ `main.ts` env doc comments): the five
   messages at project level; `create/list/revoke` member-gated; `peek_invite` open;
   `join_project` gains optional `invite` redemption (redeem before membership, before any
   provisioning); `REQUIRE_INVITE` gate moves from session `join` to `join_project` on occupied
   projects; session `join` loses `invite`; `invite_*` session events removed. Integration tests
   in `poc/server/test/server.test.ts` retargeted (mint/peek/redeem/revoke/cross-project/
   requireInvite suites) — same scenarios, project scope.
3. **Hub store** — `poc/hub/src/hubDb.ts`: schema v3 (`INVITES_DDL` + redemption table), a
   `HubInviteStore` interface beside `DeviceStore` (mint/peek/redeem/listFor/revoke, injected
   `now`), migration test in `poc/hub/test/hubDb.test.ts` (v2 file → v3, backup made, rows
   survive, newer-stamp refusal still works).
4. **Hub protocol** — `poc/hub/src/hub.ts`: handler branches for the five messages beside
   `watch_project`/`peek` (identity stamping already in place); create/list/revoke gated on
   `store.isMember` with the `denyMember` refusal; `peek_invite` open; `join_project` extended
   with redemption (write-through, constraint 4). Integration tests in
   `poc/hub/test/routing.test.ts` (boot pattern + `member()` helper already exist): the §2.5
   death scenario flipped green is the first test written — `peek_invite` to a hub with no
   session joined answers `invite_info`.
5. **Client** — `inviteLink.ts` (+test): project-param link, label helpers unchanged.
   `SessionPicker.tsx`: INVITE section hosting `InvitePanel` (moved, restyled only if its
   classes demand it). `InvitePanel.tsx`: mints/lists/revokes against `projectId`, links via the
   new `inviteLinkFor`. `InviteLanding.tsx`: project name + inviter; accept = `join_project`
   with token → route to picker + `replaceState` strip. `InviteSignIn.tsx`: sessionStorage stash
   + `next` strip (§1.7). `authRoute.ts` (+test): `inviteTarget { projectId }`; precedence
   unchanged. `App.tsx`: invite param handling, strip-on-accept, remove `"invite"` screen.
   `Header.tsx`: remove `▢ INVITE` button + `onOpenInvite`. `useSessionSocket.ts`: drop join
   `invite` + invite_list re-request. `pickerUrl.ts`: verify `invite` already stripped (test
   exists). Parity: picker control set must stay theme-identical (T14 row still green).
6. **Docs sweep** — PRD §8.1/§8.2 final-state text; tech-debt §2.5 → RESOLVED, §1.2 → RESOLVED;
   HANDOFF wrap entry. Mechanical.

## §4 Verification per task

- T1/T2: `cd poc/server && npx tsc --noEmit && npx vitest run` green; invite scenarios cover the
  §1.3 seat semantics end to end.
- T3/T4: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run`
  green; migration test proves the v2→v3 path on a real file; routing tests prove membership
  gating (non-member create → `not_a_member` refusal) and the open peek.
- T5: `cd poc/client && npx tsc -b && npx vitest run` green incl. T14 picker parity; static-markup
  tests for the landing/SignIn copy changes where the no-DOM seam allows.
- Final: all three suites fresh, done gate §0 re-checked line by line.
