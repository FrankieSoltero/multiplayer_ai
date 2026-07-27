# A3 — Pull notifications (design)

*Date: 2026-07-27. Status: approved, not yet built. Sub-project A3 of Reading A (`2026-07-25-deployment-strategy-design.md` §2/§4).*

## 1. What this builds

When a permission gate in one session goes unanswered for longer than *your* chosen delay, that
session's row in the OTHER PARTIES panel lights up as a **pull**, and the header shows `PULLS ▸ N`.
Clicking the row drops you into that session.

The deployment spec (§2 item 3) describes this as "the lite interrupt rail from the v6b backlog"
and the thing that "makes the demo moment self-explanatory": a teammate is blocked on an approval,
and anyone can see it and step in.

### 1.1 Amendment to the deployment spec

That spec says to pull when a gate is pending **and the driver is idle/away**. This design drops
the idle half and lets elapsed time carry the rule alone.

Reason: tracking "away" needs new activity plumbing (focus events, heartbeats, or an idle timer per
participant), and a gate that has sat unanswered past the recipient's own threshold *is already the
evidence* that nobody is answering it. The two conditions collapse into one, and the one that
survives is the one we can derive from data the wire already carries.

## 2. Decisions (user-approved 2026-07-27)

- **The delay is a per-recipient preference, not a session or server setting.** Each person picks
  how eager they want to be interrupted. Chosen over a session-wide threshold because a shared
  number cannot be right for both the teammate waiting on the answer and the teammate heads-down in
  their own worktree. It is also the cheaper design: preferences never reach the server.
- **In-app only.** No OS notifications, no tab-title or favicon signalling, no sound. A pull waits
  for you inside the app. Rejected the Notification API for v1: it needs a permission prompt,
  degrades differently per browser and OS, and needs a careful mute story or it becomes the feature
  everyone turns off.
- **Off by default; opt in.** Matches the standing ruling on oversight ("optional so the headache
  doesn't grow as the team grows"). Guarantees this feature can never be the reason the app feels
  noisy to someone who never asked for it.
- **The pull names the tool, not the input.** "approval to run Bash", never the command string.
  `summarizeSession` (`digest.ts:10`) already ships tool names and file targets across session
  boundaries in the `<teammates>` digest, so this widens no disclosure that does not already exist.
- **A pull never shows for the session you are currently in.** You can already see that gate.

## 3. Architecture

### 3.1 Server: one pure module, one snapshot field

The wire already carries everything needed. `events.ts:24-25` defines:

```
| { type: "permission_request"; requestId: string; toolName: string; input: unknown }
| { type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string; auto?: true }
```

and every logged event is timestamped by `Session.append`. So a pending gate is simply *a request
with no matching decision*, and "pending since" is that event's `ts`.

**New file `poc/server/src/pendingGate.ts`:**

```ts
export interface PendingGate { toolName: string; sinceTs: string }
export function pendingGateOf(events: LoggedEvent[]): PendingGate | null
```

It scans the log once, collects `permission_request` events, removes any whose `requestId` has a
matching `permission_decision`, and returns the **oldest** survivor. No state, no timers, ~15 lines.

Auto-approved calls resolve immediately (`permission_decision` with `auto: true`), so AUTO mode
generates no pulls without any special-casing.

**Modified `poc/server/src/project.ts`:** `projectSnapshot` (`:106`) adds one optional field to each
entry of `ProjectMessage.sessions[]`:

```ts
pendingGate: { toolName: string; sinceTs: string } | null
```

That is the entire wire change. No new message type, no new socket traffic, and late joiners get it
free — the same reason the oversight summary rode this channel rather than the append-only session
wire.

### 3.2 The server never decides a pull is due

It publishes only *when the gate started waiting*. Every deadline lives with the recipient. This is
what makes per-person thresholds cost nothing server-side: no timers, no per-user state, no fan-out
logic, and no way for one person's preference to affect anyone else's traffic.

### 3.3 Client: one pure module, one tick

**New file `poc/client/src/pulls.ts`:**

```ts
export interface Pull {
  sessionId: string;
  toolName: string;
  sinceTs: string;
  driverName: string | null;
}

export function pullsFrom(
  sessions: ProjectSession[],   // the client's own mirror of the snapshot's session shape, in types.ts
  opts: { thresholdMs: number | null; currentSessionId: string | null; now: number },
): Pull[]
```

Rules, in order: `thresholdMs === null` → return nothing (feature off); skip the session whose id
equals `currentSessionId`; skip sessions marked `ended`; skip sessions with no `pendingGate`;
include when `now - Date.parse(sinceTs) >= thresholdMs`.

**A 10-second interval that bumps state.** This is load-bearing and non-obvious: while a gate sits
pending, *no events fire*, so no new snapshot arrives, so nothing re-renders. Crossing the threshold
is an event only the client's own clock can observe. Without the tick the pull would appear only by
coincidence, when unrelated activity happened to push a fresh snapshot.

**Modified `poc/client/src/components/PartyPane.tsx`:** rows already are
`<a href="?project=…&session=…">`, so one-click jump-in needs no new navigation code. A pull row
gains a 🔐 marker and a line reading `waiting 2m — approval to run Bash`, reusing the existing
`ago()` helper.

**Modified `poc/client/src/components/Header.tsx`:** a `PULLS ▸ N` badge following the existing
`WORKFLOWS ▸ N` pattern.

**Setting UI:** a `<select>` in the OTHER PARTIES panel header — OFF / 30s / 1m / 2m / 5m —
persisted to `localStorage["mpai-pull-after-ms"]`, with an absent key meaning OFF.

The control must use a `<span>` + `aria-label`, **never a wrapping `<label>`**: a wrapping label
forwards a second synthesized click, which for a `<select>` opens and instantly closes the native
dropdown, and the control looks dead with no error anywhere. That bug cost real debugging time on
the AGENT model picker.

## 4. Testing

- `poc/server/test/pendingGate.test.ts` — unresolved request; resolved request; `auto: true`
  decision resolves; multiple pending gates return the oldest; no gates returns null.
- `poc/client/src/pulls.test.ts` — off (`null` threshold); below, exactly at, and above the
  threshold; the current session excluded; an ended session excluded.
- One wire test in `poc/server/test/server.test.ts` asserting the project snapshot carries
  `pendingGate`.

There is no component-test infra in this project, so the PartyPane and Header rendering is verified
by **driving the real browser once** before the work is called done. That is the standing pattern
here, and it is what caught the arrow-navigation `<select>` bug that pure tests could not see.

## 5. Out of scope

OS notifications and the Notification API; tab-title and favicon signalling; sound; per-session
threshold overrides; pull history or a "pulls you missed" view; pulls for anything other than a
pending permission gate.

**File-collision alerts are explicitly not here.** Detecting that two sessions are editing the same
file is the v6b interrupt rail and deserves its own spec. It shares this feature's delivery surface
(the OTHER PARTIES panel and the header badge), which is a reason to build A3 first and let v6b
extend it — not a reason to merge the two.

## 6. Known consequence

Off-by-default means **the pull will not fire in a demo unless someone enables it first**. A4 is a
canned demo scenario built around reliably hitting a permission gate, so the A4 script needs an
explicit "set PULLS to 30s" step, or the moment the feature exists to create will not land.
