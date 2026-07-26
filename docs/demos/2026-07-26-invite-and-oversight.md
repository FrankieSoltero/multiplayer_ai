# Demo — invite system + oversight agent (stacked branches)

Covers both features in one run: `feature/invite-system` stacked on
`feature/oversight-agent`. Verified end-to-end on 2026-07-26 (13/13 wire beats
plus a browser pass through the landing screen, lobby, session, and INVITE
panel).

## Setup

The invite gate is **off by default**, so it must be switched on to demo it.

For a wire-only run (no UI), the env var is enough:

```bash
cd poc/server && REQUIRE_INVITE=1 npx tsx src/main.ts
# optional: INVITE_TTL_MS=3600000 INVITE_MAX_USES=5
```

`main.ts` serves no static files, so for the **browser** demo below use a
single-port harness serving the built client:

```bash
cd poc/client && npm run build          # dist/ must exist
```

```ts
// run with: cd poc/server && npx tsx <thisfile>.mts
import { startServer } from "<repo>/poc/server/src/server.js";
startServer({
  port: 3001,
  staticDir: "<repo>/poc/client/dist",
  requireInvite: true,       // the whole point of the demo
  inviteTtlMs: 60 * 60 * 1000,
  inviteMaxUses: 5,
}).then((s) => console.log(`up on http://localhost:${s.port}/`));
```

Note the file must be `.mts` (or live inside `poc/server/`) — a stray `.ts`
outside the package is transformed as CJS and top-level `await` fails.

Everything below runs at `http://localhost:3001/`.

## The invite beats

1. **Found the room.** Open `http://localhost:3001/?session=invite-demo&name=ana`.
   Ana lands directly in the session and takes the wheel. With `requireInvite`
   on, this works *because the room is empty* — the founder slot is deliberately
   open (spec §7 is explicit that this is not authentication).
2. **A stranger is turned away.** In a private window, open
   `?session=invite-demo&name=mallory`. Rejected: `this session requires an invite`.
   The room is occupied and mallory holds no token.
3. **Mint an invite.** As ana, press **I** (or click ▢ INVITE) → `[ CREATE INVITE ]`.
   The panel lists the invite: short id, who made it, the full copyable link,
   `5 SEATS LEFT`, and an expiry countdown. The transcript shows
   `✦ ana created invite <id>`.
4. **The link is just a token.** It reads `http://localhost:3001/?invite=<32 chars>`
   — no project or session id. The server resolves the room from the token, so
   the URL can't be edited to point somewhere else.
5. **Land the invite.** Paste it into a private window. Before any commitment,
   the recipient sees **ANA INVITED YOU**, `default / invite-demo`, and
   `EXPIRES IN 59M · 5 SEATS LEFT`. Press START → the lobby, pre-scoped to the
   right project and session → join.
6. **Attribution.** Ana's transcript shows `✦ bob joined via invite <id>`, and
   the panel's seat count drops.
7. **Revoke.** Ana presses `[ REVOKE ]`. A third person pasting the same link
   now gets `invite revoked` on the landing screen.
8. **Refresh doesn't lock you out.** Reload ana's tab. She rejoins with no token
   even though the room is occupied, because she was admitted before. A brand-new
   userId in the same state is still refused. (This is the admitted-set
   exemption — without it, the founder is locked out of her own room the first
   time she refreshes.)

## The oversight beats (base branch)

9. Press **O** → `ENABLE`. Prompt in one session; after the 30s debounce the team
   summary appears and the header dot lights in the other session.
10. As driver, `PULL INTO SESSION` — the next prompt carries the team context,
    and the transcript records the attributed pull. A non-driver sees PULL dimmed.
11. Ask the agent to call `team_update` — the permission gate fires, because the
    tool is deliberately not auto-allowed.

## What to watch for

- Summary quality and latency from the live haiku call — never exercised by
  tests, by design.
- Whether the 30s oversight debounce and the 24h/10-seat invite defaults feel
  right in practice.
- The invite panel's expiry label doesn't tick down while the screen sits open
  (it re-reads the clock on render only) — known, deferred.
