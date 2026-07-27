# Exit and session leave — design

*Design spec. Brainstormed and user-approved 2026-07-27 (session #12).*

## 1. What this builds

A way to leave a session.

Today there is none. `presence_leave` fires only when the WebSocket closes
(`poc/server/src/server.ts:865`), so the only way out of a session is to close the
browser tab, and there is no route back to the session picker. Joining is a
one-way door.

This adds two things that resolve to the same action:

- **`/exit`** typed in the prompt bar.
- **An EXIT control** in the header.

Both mean *I leave; the party continues*. Rejoining is always possible, and
leaving destroys nothing.

It also makes `close_session` reachable for the first time. v7a shipped the
command, the event and the server-side guards with no way to invoke them — the
known gap recorded in that plan's Deviations and in PR #17. Here it is invoked by
the server, not by a person: **when the last participant leaves deliberately, the
session closes itself.**

### 1.1 What this is not

- **Not a server shutdown.** Stopping the `mpai` process belongs to the host and
  lives in a settings screen that does not exist yet. Out of scope (§7).
- **Not a host-initiated close.** Closing a live session out from under people
  who are still in it also belongs with that settings screen. Out of scope (§7).
- **Not a worktree teardown.** Leaving releases nothing on disk. No teardown path
  exists anywhere in the codebase today and this does not add one.
- **Not an agent interrupt.** Leaving does not stop a running turn; that is
  `task_stop`. A session can be closed and still be streaming output — v7a's
  `lifecycle.ts` docstring already says so.

## 2. Decisions (user-approved 2026-07-27)

- **`/exit` is per-person, not session-wide.** One person leaving never ends
  anyone else's work. Chosen over wiring `/exit` straight to `close_session`,
  which would let any passenger end the whole party with one command.
- **The last deliberate leaver closes the session.** Nobody has to remember to
  close anything, and an abandoned session stops reading LIVE in the picker.
- **Only a deliberate `/exit` can auto-close. A disconnect never can.** This is
  the load-bearing decision of the whole design, and it exists because of a
  collision between two of the product's goals. v7a made closing **one-way —
  there is no reopen path.** Auto-closing on any last-leave would mean the team
  shutting their laptops at 6pm permanently ends the session, which directly
  contradicts the goal of persisting party groups so nobody loses track of
  their work. A dropped wifi connection is not a statement of intent. So the
  server must be able to tell the two apart, which is why §3.1 exists.
- **A session that is open with nobody in it reads EMPTY, not LIVE.** Showing an
  abandoned session identically to one with three people working in it is the
  same conflation v7a exists to remove, relocated. Rejected showing a participant
  count instead: it makes one badge carry two ideas, and the zero case still
  reads as live.
- **The confirm appears only when leaving actually strands something** — the
  agent is mid-run, or a permission gate is pending and you are the driver.
  Rejected always-confirm (heavy on a command people type often, and this
  codebase has no modal pattern) and never-confirm (silently abandoning a gate
  the agent is blocked on).
- **`/exit` is parsed by a pure module, not special-cased inline.** Matches the
  established extract-pure-then-test pattern (`slashMatch.ts`, `arrowNav.ts`,
  `sessionState.ts`, `inviteLink.ts`) and gives the command real coverage. The
  alternative — three lines in the submit handler — lands untested in a component
  with no test infrastructure, which is precisely the failure recorded in
  `docs/mistakes-and-fixes.md:9-14`.

## 3. Architecture

### 3.1 The one new wire command: `leave_session`

The server cannot otherwise distinguish *"I'm done"* from *"my wifi dropped"*.
Both arrive as a closed socket. That distinction is the entire basis of the
auto-close rule, so it needs an explicit signal.

On receiving `leave_session` from a participant:

1. Append `presence_leave` for that user (what the close handler already does).
2. **If no participants remain**, append `session_closed`, attributed to the
   leaver — honest history: that person's departure is what ended it.
3. `pushProject` immediately. Same reasoning v7a recorded for `close_session`:
   `session_closed` is not in the `INTERESTING` set, so without an explicit push
   watchers never see `lifecycle` flip.

An ordinary disconnect keeps today's behaviour exactly: `presence_leave` only,
session stays open, rejoinable, and reads EMPTY in the picker.

**`leave_session` is not lifecycle-guarded.** Leaving an already-closed session
must keep working — a participant still sitting in a closed session needs a way
out. If the session is already closed, step 2 is skipped rather than appending a
second `session_closed`.

### 3.2 The duplicate-`presence_leave` hazard

The client sends `leave_session` and *then* reloads the page. WebSocket message
ordering guarantees the server sees the command first and the socket close
moments later — and `server.ts:873`'s close handler also calls
`session.leave(ctx.userId)`. Left alone, **every deliberate exit writes two
`presence_leave` events** into an append-only log that is replayed to late
joiners.

Fix it in `Session.leave()` (`poc/server/src/session.ts:75-77`) so it is
idempotent: a user who is not currently a participant produces no event. Fixing
it at the source covers both callers and any future one; guarding at the call
site would leave the hazard live for the next caller.

This also protects the auto-close rule from firing twice.

### 3.3 Client modules

**`poc/client/src/clientCommands.ts`** (new, pure)

```
parseClientCommand(text: string): ClientCommand | null
```

Returns `{ type: "exit" }` for `/exit` and `null` for everything else. The prompt
bar consults it before sending, so `/exit` never reaches the model. Trailing and
leading whitespace tolerated; a bare `/exit` only — arguments are not part of
this design.

**`poc/client/src/sessionState.ts`** (extend)

A fourth state, `empty`, for a session that is open with zero participants.
Extends the `degradedState()` seam v7a built, so precedence keeps living in one
place and the two exhaustive lookup tables keep label and class from drifting:

```
closed > offline > ended > empty > healthy
```

`empty` sits below `ended` because a dead agent is a fact about the session
itself, while emptiness is a fact about who is currently looking at it. It sits
above healthy because a session nobody is in is not simply live.

The picker already receives `participants` on the snapshot
(`poc/server/src/project.ts:89,133`), resolved from the live participant map, so
no new server field is required.

**Header** — an EXIT control beside the existing buttons, firing the same action
as the command.

**`App.tsx`** — the exit action: confirm if warranted (§3.4), send
`leave_session`, then drop the `session` param and reload. This is symmetric with
`joinSession` (`SessionPicker.tsx:137`), which navigates by assigning
`window.location.search`. `sessionId` is read from URL params at mount, so a
reload is how this app changes sessions.

The message must be sent **before** navigation begins; a reload closes the socket
and any unsent frame is lost.

### 3.4 The confirm

Leaving is silent unless it strands something:

- the agent is mid-run (`derived.agentBusy`), or
- a permission gate is pending and you are the driver (`gatesPending`).

Both signals already exist in `App.tsx:283` and need no new plumbing.

**Rendered as an inline confirm bar above the prompt bar, not a modal.** The
codebase already answers "a decision is waiting on you" this way: the permission
gate and plan-approval cards are inline with two buttons
(`Transcript.tsx:157,227`). Reusing that idiom costs no new pattern and inherits
the existing focus and keyboard behaviour; introducing a modal system for a
two-button question would be disproportionate, and this project has none.

The bar states what leaving would strand ("the agent is still working" / "a
permission gate is waiting on you"), and offers LEAVE ANYWAY and STAY. Dismissing
it is the same as STAY. It is local component state — nothing about a confirm
belongs on the wire, since no other participant is affected by whether you
hesitated.

## 4. Naming collision, stated rather than discovered

The slash autocomplete matches **substrings across all plugin skills**
(`slashMatch.ts`). If a plugin ever ships a skill named `exit`, the menu will
offer it while the client intercepts the text first.

**The client command wins.** `/exit` is reserved. This is recorded here so the
behaviour is a decision rather than something a future maintainer discovers and
"fixes" in the wrong direction.

## 5. Testing

**Pure, unit-tested:**

- `clientCommands.test.ts` — `/exit` recognised; whitespace tolerated; `/exits`,
  `/ex`, `exit`, and a prompt merely containing the word all return `null`.
- `sessionState.test.ts` — the `empty` state and its position in the precedence
  chain, including that `closed` and `ended` still outrank it, extended into the
  existing shared-fixture table so label and class cannot drift.

**Server wire tests** in `server.test.ts`, matching how `close_session` was
covered:

- `leave_session` removes the sender from the roster.
- The last deliberate leaver closes the session; `session_closed` is attributed
  to them.
- A leaver who is *not* the last one does **not** close it.
- A socket close does **not** close the session, even when it is the last
  participant — the design's central guarantee.
- No duplicate `presence_leave` when `leave_session` is followed by a socket
  close.
- `leave_session` still works on an already-closed session and does not append a
  second `session_closed`.

**Driven in a browser once**, per `docs/mistakes-and-fixes.md:9-14`: the EXIT
control, the confirm bar's two buttons, the return to the picker, and an EMPTY
badge appearing in the picker after the last person leaves. The header and
confirm-bar wiring have no component-test infrastructure and none is being added.

**Not tested, and deliberately so:** that the socket-close path and the
`leave_session` path cannot interleave in the other order. WebSocket ordering
guarantees it, and a test that pins message ordering would be pinning the
transport rather than our code.

## 6. What this depends on

Builds directly on v7a: it extends `sessionState.ts`'s `degradedState` seam and
gives `close_session` its first caller. The branch is stacked on
`feature/v7a-repo-identity-lifecycle` (PR #17) for that reason.

## 7. Out of scope

- Server shutdown / the host settings screen.
- Host-initiated close of a session with people still in it.
- Worktree teardown or any on-disk cleanup.
- Interrupting a running agent turn (`task_stop` already exists).
- A reopen path for closed sessions. v7a made closing one-way; §2 works within
  that rather than revisiting it.
- Any `/` command other than `/exit`. The module is the seam for later ones; this
  design ships exactly one.
- Persistence. "Keep party data so nobody loses track" is v7c's job — this design
  contributes to it only by refusing to close sessions accidentally.
