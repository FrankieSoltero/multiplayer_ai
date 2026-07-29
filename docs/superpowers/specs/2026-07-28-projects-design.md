# Projects — the container (design)

*Implements **PRD §8.2**, plus **§5.1** (full-bleed layout) because the screens here depend on it.
Brainstormed and user-approved 2026-07-28.*

**Read `docs/PRD.md` first.** This spec assumes its object model (§3), topology (§4) and decisions
(§6) and does not restate them.

---

## 1. What this builds

**A project you can name, see, enter and work in.** Today `projectId` is the hub's top-level key
with no name, no members and no lifecycle, reaching the client as a hidden URL parameter defaulting
to `default` (`SessionPicker.tsx:11`, `App.tsx:45`). This gives it an identity and the two screens
that make a hub navigable.

It also closes the workflow break that made the hub feel broken: **you cannot create a session from
the hub at all today**, so people fall back to a `localhost` tab and then wonder which surface they
are looking at.

### 1.1 The user-facing result

1. Land on the hub. See **every** project on it and what is happening inside each.
2. Create one with a name, or enter an existing one.
3. Inside, see every session across every repo — each labelled with its repo, its machine and who
   is in it.
4. Create a session, pick a repo, and land in it ready to work.
5. Leave back out to the hub and watch any other project without joining it.

---

## 2. Decisions

**P1 — A project is created with a display name and nothing else.** No repo, no members, no
description. *Why:* anything else is a form standing between you and starting work, and requiring a
repo at creation would couple this section to §8.3's repo attachment — the coupling the ordering
was chosen to avoid.

**P2 — Visibility is hub-wide; participation is membership-scoped.** Everyone on a hub sees every
project and what is happening in it. Membership governs whether you can act — drive, approve, create
sessions, spawn. *Why:* this amends PRD §8.1's "project membership is the access unit," which was
written before spectating existed. It is on-thesis rather than a compromise: PRD §1.1 makes
*awareness* the shared unit, and hub-wide awareness with scoped participation states that more
directly than membership-gated visibility did. It is also nearly free — spectating reads the hub's
own relayed copy and never wakes a laptop.

**P3 — Spectating a project is silent; opening a live session announces you.** You browse the hub,
see every project, see who is where, and nobody is notified. The moment you open a session's live
transcript you appear in its roster as a watcher. *Why:* `market-research.md` names the **co-op
social model** as part of what makes this defensible, and silent observation of a colleague's live
work is a different social contract — the kind that makes people self-conscious about using the
tool for real work. Also the cheapest option: it is the behaviour that already exists, since `join`
tunnels to the laptop and fires `presence_join`.

**P4 — Identity is established per connection, not per join.** *Why:* forced by P5. `tunnel()`
requires `channel.identity`, which today is only set inside the `join` handler
(`hub.ts:337-338`), so any message routed before joining a session has no one to attribute it to.
This is also a stepping stone to §8.1: the field the browser supplies today becomes the field the
hub verifies later, and nothing downstream changes shape.

**P5 — `create_session` is routed to a named machine by the hub.** The browser names the repo it
wants; the hub picks the online machine offering it and tunnels the create there. *Why:* the hub
cannot answer `create_session` itself — provisioning a worktree requires the repo, which only a
machine has. It cannot use the existing `tunnel()` either, which presupposes a joined session
(`hub.ts:285`).

**P6 — The client disambiguates a colliding session name before sending; the hub validates and the
store's refusal stays.** *Why:* today two people naming a session `auth` in one project means the
second is refused outright (`hubStore.ts:100-108`). The obvious fix — have the hub rename it — was
**rejected during planning because it breaks §5.3**: the hub would have to rewrite the payload it
is contractually required to forward untouched, and a router that edits semantics is not a router.
Instead the browser, which already holds the full session list, picks a free name before sending
(`auth` → `auth-2`), so the message the hub forwards is already correct. The hub still validates
and refuses a genuine conflict — that guard is right — but the refusal stops being reachable
through ordinary use.

**P7 — The full-bleed relayout ships first, inside this section.** *Why:* PRD §5.1 — at 1296px the
project screen has room for one column, which is why today's picker is a flat list. Building these
screens first and widening them after means building them twice.

**P8 — Projects are not durable, and the UI must not imply they are.** The hub's log is in memory
(`hubStore.ts:38`), so a hub restart loses every project and every session. *Why it ships anyway:*
durability is §8.7 and is a large section; blocking a navigable hub on it helps nobody. *Why it
must be visible:* a container that silently evaporates is worse than one that says it will.

---

## 3. The project object

| Field | Notes |
|---|---|
| `id` | slug, `^[a-z0-9-]{1,40}$` — the existing `SLUG` shape (`hub.ts:13`) |
| `name` | display name, ≤ 60 chars, what the user typed |
| `createdBy` | userId |
| `createdAt` | timestamp |
| `members` | userIds who may act |
| `lifecycle` | `active` \| `closed` \| `archived` |

`id` is derived from `name` by the existing `slugify`, so `Acme Migration` → `acme-migration`. The
slug remains the wire identifier everywhere (`watch_project`, `create_session`, `join`, the
`?project=` parameter), which is what keeps this a rename-with-identity rather than a new key.

**Lifecycle.** `active` is the only state work happens in. `closed` stops new sessions and new
members; existing sessions stay readable. `archived` hides it from the default entrance list.
Closing is reversible; there is no delete in this section.

**Membership.** You are a member if you created it or were invited and joined. Members act;
non-members spectate (P2). Leaving is allowed and does not close anything.

---

## 4. Screens

### 4.1 Entrance

Replaces today's implicit "no `?session=` means show the picker for `default`" (`App.tsx:44-45`).

Lists **every** `active` project on the hub — name, member count, live session count, whether
anything is happening right now, and whether you are a member. Sorted by activity. Plus a
NEW PROJECT control taking a name.

Archived projects are behind a toggle, not on the default list.

### 4.2 Project

Today's `SessionPicker`, widened into the screen the PRD describes.

- **Sessions** — every session across every repo in the project. Each row carries **repo, machine,
  participants, state badge and intent**. `repoKey` and `uplinkId` are already stored per session
  (`hubStore.ts:13-21`) and simply never rendered; this is the single biggest readability win in the
  section and most of it is display work.
- **Repos** — which repos are present in this project and which machine offers each. Derived from
  the attached uplinks, not stored separately.
- **People** — members, who is online, who is in which session.
- **NEW SESSION** — name plus a repo choice plus an optional base ref.
- **Invite** — reuses the existing invite flow, retargeted from a session to a project.

Grouping: sessions group under their repo. With one repo that reads as a flat list, which is
correct — the grouping should appear because there is something to group, not as permanent chrome.

### 4.3 Falling into the session

Creating a session lands you **in** it, driving, ready to type. No intermediate confirmation and no
return to the list. The existing `session_created` → `joinSession` navigation
(`SessionPicker.tsx:33`) already has this shape; it needs to survive the hub round trip.

### 4.4 Spectating

From the entrance, entering a project you are not a member of is silent and read-only: you see
sessions, rosters and activity. Opening a live session announces you as a watcher (P3), which is
the existing join path. Action controls are absent for non-members, not present-and-disabled — a
disabled button is a promise you cannot keep.

---

## 5. Protocol

Three changes to the hub's browser plane. The laptop-facing relay protocol is unchanged in shape.

### 5.1 Per-connection identity

A new browser message — `identify { userId, name }` — sets `channel.identity` without joining a
session. `join` keeps setting it too, so existing clients are unaffected.

Validation is exactly what `join` does today, in the same order: `typeof` triple, `SLUG` on ids,
64/40-char truncation, non-empty `userId` (`hub.ts:320-341`). **The hub must reject precisely what
a laptop rejects** — a message the hub accepts and the laptop drops is a failure that looks like
success, which is the class of bug that cost this project a whole session before.

Auth is still off: v7b1's rule stands, the hub takes the browser's word, and **this hub must not be
exposed to a network beyond a trusted one** until §8.1 and §8.10.

### 5.2 Project registry messages

Answered by the hub from its own store — added to `HUB_HANDLED` (`hub.ts:18`):

- `list_projects` → every project with name, counts, membership and lifecycle.
- `create_project { name }` → mints slug and record, replies `project_created { projectId }`.
- `join_project` / `leave_project { projectId }` → membership.
- `close_project` / `archive_project { projectId }` → lifecycle, creator or member only.

`watch_project` and `peek` keep working unchanged.

### 5.3 Routed `create_session`

The browser sends `create_session { projectId, name, repoKey, baseRef? }`. The hub:

1. Requires `channel.identity` (P4) and membership of `projectId` (P2).
2. Finds the **online** uplink in that project offering `repoKey`. None → an error naming the repo,
   not a silent drop.
3. Tunnels the original message to that machine, carrying `channelId` and `identity` — `DownFrame`'s
   "the original client message, untouched" contract holds (`relayProtocol.ts:54-58`).
4. Routes the machine's `session_created` reply back to the originating channel.

**Step 4 needs no new protocol.** `UpFrame` already carries
`reply { channelId, payload }` — "a narrowcast reply to one tunnelled command, on the channel it
arrived on" (`relayProtocol.ts:48-49`). So the only genuinely new mechanism in this section is
*routing a command to a machine before a session exists*; getting the answer back is a path that
already works and is already exercised.

**The message must be forwarded byte-identical.** The laptop's handler (`server.ts:600-631`) is
already correct and idempotent — an existing session acks rather than erroring — and that
idempotence is what makes a retried create safe.

### 5.4 Session identity scoping (P6)

`setFacts`'s ownership refusal (`hubStore.ts:100-108`) is correct and stays untouched.

Disambiguation happens **in the browser, before the message is sent** — it already has every
session in the project and their owning machines, so it can pick the first free name (`auth` →
`auth-2`). This keeps §5.3's byte-identical forwarding intact. The hub then validates that the
requested name is free for a *different* machine and refuses if not; same machine, same name still
acks idempotently through the laptop's existing handler (`server.ts:612-616`).

Naming is therefore a pure function of the session list and a desired name, which makes it a
logic-module test rather than a UI one — see §8.

---

## 6. Full-bleed layout (P7)

Per PRD §5.1. `.cabinet-inner`'s `width: 1296px` (`terminal.css:196`) goes full width, cabinet
padding (`:193`) is trimmed, and the marquee (`:200`) and legend (`Crt.tsx:54-60`) fold **into** the
CRT as chrome rather than stacking outside it.

The bezel, scanlines, vignette, roll and the `Crt` `intensity` knob all survive unchanged — this
removes letterboxing, not the arcade identity. Every screen must still scroll inside its own region
and never scroll the page, which is the invariant `terminal.css:185-187` already states.

**Not in this section:** the Clean theme. It needs shape and density extracted into tokens first,
and bundling them makes one large change out of two clean ones.

---

## 7. Out of scope

- **§8.3 machines & repos.** A machine still declares its project at launch and offers exactly one
  repo. See §9.
- **Clean theme** (§8.9), **sub-sessions** (§8.4), **hub-verified identity** (§8.1), **persistence**
  (§8.7), **collision detection** (§8.8).
- **Deleting a project.** Close and archive only.
- **Per-project settings.** Host settings are §8.10.

---

## 8. Testing

- **Hub store, no network:** project CRUD, slug derivation, membership, lifecycle transitions,
  spectator vs member permission, and the machine-scoped naming of P6.
- **Hub socket surface:** `identify` before join; `create_session` refused without identity;
  refused for a non-member; refused when no online machine offers the repo; forwarded byte-identical
  when one does; `session_created` routed back to the originating channel and to no other.
- **Real relay against real hub:** extend `poc/hub/test/relayIntegration.test.ts` — the only test
  anywhere that runs a real `relay.ts` against a real `hub.ts`, and the regression net for this
  seam. Creating a session through the hub and landing in it is exactly the kind of cross-component
  path that the per-component tests missed once before.
- **Client:** entrance list sort and summary; project screen grouping with one repo and with
  several; the spectator predicate; free-name selection (P6); create → land-in-session.

  **Client tests are pure-logic modules, never component renders.** This repo has no
  testing-library and no DOM environment — all 207 client tests are `.test.ts` over extracted
  modules (`sessionState.ts`, `sessionRow.ts`, `pickerUrl.ts`), a pattern `sessionRow.ts:3-4`
  states outright. Every decision in this section must therefore live in a module a test can call,
  with the `.tsx` left thin.
- **Layout:** the page itself never scrolls at narrow and wide widths.

**A standing countermeasure, because this plan has now had three tests that could not fail for the
reason they were named:** for each fix, revert it and re-run its test. A test that still passes is
not testing what its name claims.

---

## 9. Known bounds and honest disclosures

- **The launch-time seam.** A machine still binds to one project and one repo at launch
  (`cli.ts:120`, `--project`). So creating a project in the UI gives you an **empty** project, and
  you populate it by copying its slug into each machine's CLI. Five `mpai` processes in five repos
  delivers the five-repo scenario today; "open all of their client repos" from inside the product
  is §8.3. **Accepted for this section and to be fixed immediately after it** — the UI must not
  pretend the seam is absent.
- **Nothing is durable** (P8). A hub restart loses every project. Stated in the UI.
- **The hub trusts the browser's identity claim** (§5.1). Not internet-safe.
- **A project with no online machine can be entered and read but not worked in.** Correct, and it
  must say so rather than offering a NEW SESSION control that cannot succeed.
- **Membership is not enforced on the laptop.** The hub checks it; a laptop reached directly still
  serves anyone who can talk to it. Real enforcement is §8.1's trust inversion.

---

## 10. Open questions

1. ~~Does leaving a project you created transfer ownership, or may the last member leave and strand
   it?~~ **RESOLVED 2026-07-28 (user): the last member may leave, and an empty project stays
   active.** *Why:* a project's lifetime is independent of who happens to be in it right now.
   Someone may want to join a project precisely because everyone else has gone — to pick the work
   up — and projects should sit empty and repopulate as people come into and leave work. So an
   empty project is a **normal state, not a stranded one**, and there is no auto-archive on empty.
   This also means "members" is a record of who is currently participating, not of who owns it.
2. **Does the entrance list every project on a hub even at hundreds?** Fine for a team-sized hub
   (PRD §2), and the point at which it stops being fine should be measured rather than guessed.
3. **Does `intent` belong on a project?** A one-line "what is this project for" would carry a lot
   on the entrance screen, but it violates P1's name-and-nothing-else. Left out; revisit if the
   entrance reads thin.
