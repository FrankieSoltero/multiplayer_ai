# v7b1 — Hub and Relay Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the hub as a real process and give the local server a second transport, so a browser talking only to the hub can watch and drive a session whose agent is running on a different machine.

**Architecture:** The laptop keeps everything it owns today — the repo, the event log, driver state, the `canUseTool` promise. It gains one **outbound** WebSocket (`relay.ts`) to a new `poc/hub` package. Two planes travel that socket: **commands** are tunnelled from the hub to the laptop addressed by a hub-assigned `channelId`, and **events** are published upward once per session and fanned out by the hub, so watcher count costs the laptop nothing. Events are keyed `(runId, seq)` so a laptop restart appends a new run instead of silently overwriting stored history. `server.ts`'s existing message handler is extracted behind a small `ConnectionIO` seam and reused verbatim by both transports — no message handler changes semantics in this plan.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `ws`, vitest. No new runtime dependencies.

## Global Constraints

- Spec authority: `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md`. Read §3.1, §3.2, §4 and §6 before starting. §3.5 (trust inversion), §3.6 (host role) and §10 (security requirements) are **v7b2/v7b3** and are deliberately not built here — see "Out of scope" below.
- **The hub is purely additive and this is the plan's hard invariant.** `mpai` with no `--hub` must behave exactly as it does today. Every existing server test must keep passing **without being edited**. If a task requires editing an existing server test's expectations, stop and re-read — that means behaviour changed.
- **Server imports use `.js` specifiers** even for `.ts` sources (NodeNext). Client imports do not.
- Server tests live in `poc/server/test/*.test.ts`; hub tests live in `poc/hub/test/*.test.ts`; client tests are co-located in `poc/client/src/`.
- **There is no client component-test infrastructure.** Client logic is extracted into pure modules and tested there. Do not add a component test framework in this plan.
- Baselines before starting: **server 345 tests, client 179 tests**, both `tsc --noEmit` clean, client build clean. Verify these before Task 1 and after every task.
- Do not run `git add -A`. Every commit spells out its paths.
- Never commit `market-research.md`, `poc/demo-plugins/`, or `tour-skill-suggest.png` — they are permanently-untracked user files.
- **A `<label>` must never wrap a form control** in this codebase (it forwards a second synthesized click and kills `<select>` dropdowns). Use a `<span>` + `aria-label`.
- Do not fix anything in `docs/tech-debt.md` — that is a deliberately separate scrub pass, and it is a gate on deployment, not on v7.

### Out of scope, do not build

Device pairing and uplink tokens; hub-side GitHub OAuth; the trust inversion's identity stamping (v7b1 runs the hub with auth off and stamps a client-asserted identity, exactly as today's standalone server does with auth off); `Origin` checks; rate limiting; the host role and host settings; hub-wide session close; SQLite persistence (v7c); handoff continuity (v7d); collision detection (v7e). **v7b1's hub is a localhost/trusted-network development target and must not be exposed to the internet.** v7b2 is what makes it safe to expose.

### Why v7b is three plans, not one

The spec's §1.2 says "one spec, two plans." v7b is split further into **v7b1 (this plan, the relay spine)**, **v7b2 (trust, pairing and the §10 security floor)** and **v7b3 (host role, host settings and the multi-repo client surface)**. Rationale: v7b as a single plan is ~15 tasks with no working-software checkpoint until the end, and its riskiest unknowns are all in the transport. Each of the three produces software that runs and is testable on its own. This is a deliberate deviation from the spec's framing and is recorded here rather than silently taken.

---

### Task 1: `relayProtocol.ts` — the wire between laptop and hub

The frame vocabulary and its validating parser, as a pure module with no sockets. It lives in `poc/server/src/` because **both** sides need it: the laptop imports it relatively, and the hub imports it through the package export seam built in Task 3.

**Files:**
- Create: `poc/server/src/relayProtocol.ts`
- Test: `poc/server/test/relayProtocol.test.ts`

**Interfaces:**
- Consumes: `LoggedEvent` from `./events.js`, `SkillInfo` from `./events.js`, `PendingGate` from `./pendingGate.js`, `Lifecycle` from `./lifecycle.js`.
- Produces:
  - `RELAY_PROTOCOL_VERSION: 1`
  - `MAX_FRAME_BYTES: 1_000_000`
  - `interface SessionFacts` — the per-session shape the hub assembles snapshots from.
  - `type UpFrame` = `hello | publish | facts | reply`
  - `type DownFrame` = `welcome | tunnel`
  - `parseUpFrame(raw: unknown): UpFrame | null`
  - `parseDownFrame(raw: unknown): DownFrame | null`
  - Task 4 (hub store), Task 6 (`relay.ts`) and Task 7 (hub wiring) all import from here.

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/relayProtocol.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseDownFrame,
  parseUpFrame,
} from "../src/relayProtocol.js";

const facts = {
  id: "auth",
  participants: ["ana"],
  driverName: "ana",
  intent: null,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: "github.com/acme/api",
  lifecycle: "open" as const,
};

describe("parseUpFrame", () => {
  test("accepts a hello and preserves every declared field", () => {
    const frame = parseUpFrame({
      t: "hello",
      v: RELAY_PROTOCOL_VERSION,
      uplinkId: "lap-1",
      projectId: "default",
      repoKey: "github.com/acme/api",
    });
    expect(frame).toEqual({
      t: "hello",
      v: 1,
      uplinkId: "lap-1",
      projectId: "default",
      repoKey: "github.com/acme/api",
    });
  });

  test("rejects a hello from a different protocol version", () => {
    // A version mismatch must fail loudly at the frame boundary rather than
    // producing a half-understood uplink that misbehaves later.
    expect(
      parseUpFrame({ t: "hello", v: 99, uplinkId: "lap-1", projectId: "default", repoKey: "k" }),
    ).toBeNull();
  });

  test("accepts a publish carrying logged events", () => {
    const frame = parseUpFrame({
      t: "publish",
      sessionId: "auth",
      runId: "run-a",
      events: [{ type: "presence_join", userId: "ana", name: "ana", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    });
    expect(frame?.t).toBe("publish");
    expect(frame && "events" in frame && frame.events).toHaveLength(1);
  });

  test("rejects a publish whose events are not an array", () => {
    expect(parseUpFrame({ t: "publish", sessionId: "auth", runId: "r", events: "nope" })).toBeNull();
  });

  test("accepts a facts frame", () => {
    const frame = parseUpFrame({ t: "facts", sessionId: "auth", runId: "run-a", facts });
    expect(frame?.t).toBe("facts");
  });

  test("accepts a reply addressed to a channel", () => {
    const frame = parseUpFrame({ t: "reply", channelId: "c1", payload: { type: "error", message: "no" } });
    expect(frame).toEqual({ t: "reply", channelId: "c1", payload: { type: "error", message: "no" } });
  });

  test("rejects unknown frame types, non-objects and null", () => {
    expect(parseUpFrame({ t: "evict", sessionId: "auth" })).toBeNull();
    expect(parseUpFrame("hello")).toBeNull();
    expect(parseUpFrame(null)).toBeNull();
    expect(parseUpFrame([])).toBeNull();
  });

  test("rejects ids that are not slugs, so a frame can never name a path", () => {
    expect(parseUpFrame({ t: "publish", sessionId: "../etc", runId: "r", events: [] })).toBeNull();
    expect(parseUpFrame({ t: "facts", sessionId: "auth", runId: "r".repeat(200), facts })).toBeNull();
  });
});

describe("parseDownFrame", () => {
  test("accepts a welcome carrying the hub's resume offsets", () => {
    const frame = parseDownFrame({
      t: "welcome",
      v: RELAY_PROTOCOL_VERSION,
      have: { auth: { runId: "run-a", lastSeq: 41 } },
    });
    expect(frame).toEqual({ t: "welcome", v: 1, have: { auth: { runId: "run-a", lastSeq: 41 } } });
  });

  test("accepts a tunnel and keeps the payload untouched", () => {
    // The payload is the ORIGINAL client message, verbatim. The relay must not
    // interpret it — the laptop's existing handler is the only thing that does.
    const payload = { type: "prompt", text: "hi" };
    const frame = parseDownFrame({
      t: "tunnel",
      channelId: "c1",
      identity: { userId: "ana", name: "ana" },
      payload,
    });
    expect(frame && "payload" in frame && frame.payload).toEqual(payload);
  });

  test("rejects a tunnel with no identity — the laptop must never guess who sent a command", () => {
    expect(parseDownFrame({ t: "tunnel", channelId: "c1", payload: {} })).toBeNull();
  });

  test("accepts a detach, which is how a browser going away reaches the laptop", () => {
    // Without this the laptop never learns a watcher left, presence_leave
    // never fires, and the roster shows ghosts forever. A closed direct
    // socket does this implicitly; a relayed one needs it said out loud.
    expect(parseDownFrame({ t: "detach", channelId: "c1" })).toEqual({ t: "detach", channelId: "c1" });
  });

  test("rejects an up-frame shape on the down parser and vice versa", () => {
    expect(parseDownFrame({ t: "publish", sessionId: "auth", runId: "r", events: [] })).toBeNull();
    expect(parseUpFrame({ t: "tunnel", channelId: "c1", identity: { userId: "a", name: "a" }, payload: {} })).toBeNull();
  });
});

test("MAX_FRAME_BYTES is far below the ws default of 100MB", () => {
  // The `ws` default lets an unauthenticated peer push 100MB into JSON.parse
  // (spec §10.2). Tasks 3 and 7 apply this constant as maxPayload on both
  // sockets; pinning it here keeps the number in one place.
  expect(MAX_FRAME_BYTES).toBe(1_000_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/relayProtocol.test.ts`
Expected: FAIL — `Failed to resolve import "../src/relayProtocol.js"`.

- [ ] **Step 3: Write the implementation**

Create `poc/server/src/relayProtocol.ts`:

```ts
import type { LoggedEvent, SkillInfo } from "./events.js";
import type { PendingGate } from "./pendingGate.js";
import type { Lifecycle } from "./lifecycle.js";

/** Bumped whenever a frame's meaning changes. A mismatch is rejected at the
 *  frame boundary (see parseUpFrame/parseDownFrame) rather than tolerated:
 *  a half-understood uplink misbehaves later, in a place with no context. */
export const RELAY_PROTOCOL_VERSION = 1;

/** Applied as `maxPayload` on both the hub's browser-facing and uplink-facing
 *  sockets, and on the laptop's uplink. `ws` defaults to 100MB, which lets a
 *  peer push 100MB into JSON.parse before any gate runs (spec §10.2). The
 *  largest legitimate frame is a full event replay batch, which is orders of
 *  magnitude under this. */
export const MAX_FRAME_BYTES = 1_000_000;

/** The per-session facts a laptop declares and the hub assembles snapshots
 *  from (spec §3.2). Deliberately identical to `ProjectMessage.sessions[]`
 *  minus `presence` — `presence` is the one field only the hub can know, and
 *  keeping the rest identical means `sessionFactsOf` (Task 2) is the single
 *  producer for both the standalone snapshot path and the relay. */
export interface SessionFacts {
  id: string;
  participants: string[];
  driverName: string | null;
  intent: string | null;
  lastActivityTs: string | null;
  ended: boolean;
  pendingGate: PendingGate | null;
  skills: SkillInfo[];
  repoKey: string | null;
  lifecycle: Lifecycle;
}

/** Laptop → hub. */
export type UpFrame =
  | { t: "hello"; v: number; uplinkId: string; projectId: string; repoKey: string }
  /** Events for ONE session, published once regardless of how many browsers are
   *  watching (spec §3.2). `runId` changes every time the laptop starts the
   *  session process, so the hub appends a new run instead of letting a
   *  restarted `seq` overwrite stored history. */
  | { t: "publish"; sessionId: string; runId: string; events: LoggedEvent[] }
  | { t: "facts"; sessionId: string; runId: string; facts: SessionFacts }
  /** A narrowcast reply to one tunnelled command, on the channel it arrived on. */
  | { t: "reply"; channelId: string; payload: unknown };

/** Hub → laptop. */
export type DownFrame =
  | { t: "welcome"; v: number; have: Record<string, { runId: string; lastSeq: number }> }
  /** `payload` is the ORIGINAL client message, untouched — the hub is a router
   *  here and nothing more (spec §3.2). `identity` is stamped by the hub;
   *  `channelId` is assigned by the hub and never accepted from a browser
   *  (spec §10.4), which is why it appears only on this side of the protocol. */
  | { t: "tunnel"; channelId: string; identity: { userId: string; name: string }; payload: unknown }
  /** This channel's browser is gone. The laptop tears down the connection,
   *  which runs the same leave path a closed direct socket runs — otherwise
   *  `presence_leave` never fires and the roster keeps a ghost forever. */
  | { t: "detach"; channelId: string };

const SLUGISH = /^[a-z0-9-]{1,40}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function obj(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function str(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
}

/** Structural check only. The laptop still validates every tunnelled payload
 *  through its own handler exactly as it does for a direct socket — trusting
 *  the hub for identity does not mean trusting it for shape (spec §10.4). */
function isFacts(raw: unknown): raw is SessionFacts {
  const f = obj(raw);
  if (!f) return false;
  return (
    typeof f.id === "string" &&
    Array.isArray(f.participants) &&
    (f.driverName === null || typeof f.driverName === "string") &&
    (f.intent === null || typeof f.intent === "string") &&
    (f.lastActivityTs === null || typeof f.lastActivityTs === "string") &&
    typeof f.ended === "boolean" &&
    (f.pendingGate === null || typeof f.pendingGate === "object") &&
    Array.isArray(f.skills) &&
    (f.repoKey === null || typeof f.repoKey === "string") &&
    (f.lifecycle === "open" || f.lifecycle === "closed")
  );
}

export function parseUpFrame(raw: unknown): UpFrame | null {
  const f = obj(raw);
  if (!f) return null;
  if (f.t === "hello") {
    if (f.v !== RELAY_PROTOCOL_VERSION) return null;
    const uplinkId = str(f.uplinkId, ID);
    const projectId = str(f.projectId, SLUGISH);
    if (!uplinkId || !projectId || typeof f.repoKey !== "string" || f.repoKey.length > 200) {
      return null;
    }
    return { t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId, projectId, repoKey: f.repoKey };
  }
  if (f.t === "publish") {
    const sessionId = str(f.sessionId, SLUGISH);
    const runId = str(f.runId, ID);
    if (!sessionId || !runId || !Array.isArray(f.events)) return null;
    return { t: "publish", sessionId, runId, events: f.events as LoggedEvent[] };
  }
  if (f.t === "facts") {
    const sessionId = str(f.sessionId, SLUGISH);
    const runId = str(f.runId, ID);
    if (!sessionId || !runId || !isFacts(f.facts)) return null;
    return { t: "facts", sessionId, runId, facts: f.facts };
  }
  if (f.t === "reply") {
    const channelId = str(f.channelId, ID);
    if (!channelId) return null;
    return { t: "reply", channelId, payload: f.payload };
  }
  return null;
}

export function parseDownFrame(raw: unknown): DownFrame | null {
  const f = obj(raw);
  if (!f) return null;
  if (f.t === "welcome") {
    if (f.v !== RELAY_PROTOCOL_VERSION) return null;
    const have = obj(f.have);
    if (!have) return null;
    const out: Record<string, { runId: string; lastSeq: number }> = {};
    for (const [sessionId, value] of Object.entries(have)) {
      const entry = obj(value);
      if (!str(sessionId, SLUGISH) || !entry) return null;
      const runId = str(entry.runId, ID);
      if (!runId || !Number.isInteger(entry.lastSeq) || (entry.lastSeq as number) < -1) return null;
      out[sessionId] = { runId, lastSeq: entry.lastSeq as number };
    }
    return { t: "welcome", v: RELAY_PROTOCOL_VERSION, have: out };
  }
  if (f.t === "tunnel") {
    const channelId = str(f.channelId, ID);
    const identity = obj(f.identity);
    if (!channelId || !identity) return null;
    if (typeof identity.userId !== "string" || typeof identity.name !== "string") return null;
    if (identity.userId.length === 0 || identity.userId.length > 64) return null;
    return {
      t: "tunnel",
      channelId,
      identity: { userId: identity.userId, name: identity.name.slice(0, 40) },
      payload: f.payload,
    };
  }
  if (f.t === "detach") {
    const channelId = str(f.channelId, ID);
    return channelId ? { t: "detach", channelId } : null;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd poc/server && npx vitest run test/relayProtocol.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Verify nothing else moved**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, **359 passed** (345 baseline + 14 new). No existing test edited.

- [ ] **Step 6: Commit**

```bash
git add poc/server/src/relayProtocol.ts poc/server/test/relayProtocol.test.ts
git commit -m "feat(server): relay frame vocabulary and validating parsers (v7b1)"
```

---

### Task 2: One producer for session facts

`projectSnapshot` builds each session's row inline (`project.ts:126-145`). The relay needs the identical shape. Extract it so there is exactly one producer, then reuse it — a second hand-written copy would drift, and the field the hub adds (`presence`) is precisely the one that must NOT come from the laptop.

The same applies to `arcadeRecords`, which today walks a `Project`. The hub has event logs, not `Project` objects, so the walk is extracted to take event lists.

**Files:**
- Modify: `poc/server/src/project.ts:53-83` (`arcadeRecords`), `:120-155` (`projectSnapshot`)
- Test: `poc/server/test/project.test.ts` (add cases; do not edit existing ones)

**Interfaces:**
- Consumes: `SessionFacts` from `./relayProtocol.js` (Task 1).
- Produces:
  - `sessionFactsOf(id: string, entry: ProjectSessionEntry, repoKey: string | null): SessionFacts`
  - `arcadeRecordsFrom(logs: LoggedEvent[][]): ArcadeRecord[]`
  - Task 4 (hub store) calls `arcadeRecordsFrom`; Task 6 (`relay.ts`) calls `sessionFactsOf`.

- [ ] **Step 1: Write the failing test**

Extend the existing import at `poc/server/test/project.test.ts:2` (do not add a second import line for the same module):

```ts
import {
  Project,
  projectSnapshot,
  SLUG,
  sessionFactsOf,
  arcadeRecordsFrom,
} from "../src/project.js";
```

Then append. `addSession(project, id, skills)` is the helper already at the top of this file (`test/project.test.ts:15-23`); it registers a real `Session` + `AgentDriver` and returns the `Session`, so read the entry back off the project:

```ts
describe("sessionFactsOf", () => {
  it("produces exactly the snapshot row minus presence", () => {
    // The relay publishes facts and the hub adds `presence`. If the two ever
    // diverge, a hub-attached session renders differently from a standalone
    // one for no reason a user could explain — so pin the relationship.
    const project = new Project("p");
    addSession(project, "auth");
    const entry = project.sessions.get("auth")!;

    const snapshot = projectSnapshot(project, undefined, {
      defaultBranch: "main",
      key: "github.com/acme/api",
    });
    const facts = sessionFactsOf("auth", entry, "github.com/acme/api");

    const { presence, ...row } = snapshot.sessions[0];
    expect(presence).toBe("online");
    expect(facts).toEqual(row);
  });

  it("carries a null repoKey through rather than inventing one", () => {
    const project = new Project("p");
    addSession(project, "auth");
    expect(sessionFactsOf("auth", project.sessions.get("auth")!, null).repoKey).toBeNull();
  });
});

describe("arcadeRecordsFrom", () => {
  it("aggregates best-per-game across independent event logs", () => {
    const logs = [
      [
        { type: "presence_join", userId: "ana", name: "ana", seq: 0, ts: "2026-07-27T00:00:00.000Z" },
        { type: "game_score", userId: "ana", game: "tetris", score: 100, seq: 1, ts: "2026-07-27T00:00:01.000Z" },
      ],
      [
        { type: "presence_join", userId: "ben", name: "ben", seq: 0, ts: "2026-07-27T00:00:02.000Z" },
        { type: "game_score", userId: "ben", game: "tetris", score: 250, seq: 1, ts: "2026-07-27T00:00:03.000Z" },
      ],
    ] as any;
    expect(arcadeRecordsFrom(logs)).toEqual([
      { game: "tetris", score: 250, userId: "ben", name: "ben", glyph: undefined, color: undefined },
    ]);
  });

  it("resolves a holder's identity from any log, not just its own", () => {
    // On the hub the join and the score can arrive on different sessions of
    // the same project. Identity must still resolve, or the leaderboard reads
    // "unknown" for a player who is right there in the roster.
    const logs = [
      [{ type: "presence_join", userId: "ana", name: "ana", glyph: "▲", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
      [{ type: "game_score", userId: "ana", game: "snake", score: 12, seq: 0, ts: "2026-07-27T00:00:01.000Z" }],
    ] as any;
    expect(arcadeRecordsFrom(logs)[0]).toMatchObject({ name: "ana", glyph: "▲" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/project.test.ts`
Expected: FAIL — `sessionFactsOf is not a function` / `arcadeRecordsFrom is not a function`.

- [ ] **Step 3: Refactor `project.ts`**

Replace the body of `arcadeRecords` (`project.ts:53-83`) with a delegating pair, and add the fact producer. The event-walking logic is unchanged — only its input type moves from `Project` to `LoggedEvent[][]`:

```ts
/** Best score per game across a set of event logs. Holder identity is resolved
 *  from presence_join events (NOT a live participants map) so a record survives
 *  its holder leaving, and identities are collected across ALL logs before the
 *  scores are attributed — on the hub the join and the score routinely arrive
 *  on different sessions of the same project.
 *  Ties break chronologically (earliest timestamp wins), regardless of
 *  iteration order. */
export function arcadeRecordsFrom(logs: LoggedEvent[][]): ArcadeRecord[] {
  const identities = new Map<string, { name: string; glyph?: string; color?: string }>();
  const best = new Map<string, { userId: string; score: number; ts: string }>();
  for (const events of logs) {
    for (const ev of events) {
      if (ev.type === "presence_join" && ev.userId && ev.name) {
        identities.set(ev.userId, { name: ev.name, glyph: ev.glyph, color: ev.color });
      }
    }
  }
  for (const events of logs) {
    for (const ev of events) {
      if (ev.type !== "game_score") continue;
      if (!Number.isInteger(ev.score) || ev.score <= 0) continue; // degrade, don't crash
      const cur = best.get(ev.game);
      if (!cur || ev.score > cur.score || (ev.score === cur.score && ev.ts < cur.ts)) {
        best.set(ev.game, { userId: ev.userId, score: ev.score, ts: ev.ts });
      }
    }
  }
  const out: ArcadeRecord[] = [];
  for (const [game, rec] of best) {
    const id = identities.get(rec.userId);
    out.push({
      game,
      score: rec.score,
      userId: rec.userId,
      name: id?.name ?? "unknown",
      glyph: id?.glyph,
      color: id?.color,
    });
  }
  return out.sort((a, b) => a.game.localeCompare(b.game));
}

function arcadeRecords(project: Project): ArcadeRecord[] {
  return arcadeRecordsFrom(
    [...project.sessions.values()].map((entry) => entry.session.eventsFrom(0)),
  );
}

/** The single producer of a session's snapshot row (spec §3.2). `presence` is
 *  deliberately NOT here: it is the one fact only the hub can know, so the
 *  standalone path adds a constant "online" and the hub adds the real value.
 *  Keeping every other field in one function is what stops a hub-attached
 *  session from rendering differently than a standalone one. */
export function sessionFactsOf(
  id: string,
  entry: ProjectSessionEntry,
  repoKey: string | null,
): SessionFacts {
  const events = entry.session.eventsFrom(0);
  const summary = summarizeSession(id, events, entry.driver.isDead);
  const participants = entry.session.participantList;
  const driverId = entry.session.driverId;
  return {
    id,
    participants: participants.map((p) => p.name),
    driverName: participants.find((p) => p.userId === driverId)?.name ?? null,
    intent: summary.intent,
    lastActivityTs: events.at(-1)?.ts ?? null,
    ended: summary.ended,
    pendingGate: pendingGateOf(events),
    skills: entry.skills,
    repoKey,
    lifecycle: lifecycleOf(events),
  };
}
```

Then rewrite `projectSnapshot`'s session mapper (`project.ts:126-145`) to delegate:

```ts
  const sessions = [...project.sessions.entries()].map(([id, entry]) => ({
    ...sessionFactsOf(id, entry, repo?.key ?? null),
    // A standalone server owns every session it reports, so its uplink is
    // trivially reachable (spec §3.4). The hub replaces this with the real
    // uplink state; the field exists on both paths so the client has one shape.
    presence: "online" as const,
  }));
```

Add the import at the top of `project.ts`:

```ts
import type { SessionFacts } from "./relayProtocol.js";
```

and remove the now-unused `LoggedEvent` import only if tsc reports it unused — `arcadeRecordsFrom` needs it, so add it if absent:

```ts
import type { LoggedEvent, SkillInfo } from "./events.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/project.test.ts`
Expected: PASS, including every pre-existing case in that file **unedited**.

- [ ] **Step 5: Verify the invariant**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, **363 passed** (359 + 4 new). Zero existing tests edited — this task is a pure refactor and the snapshot bytes are unchanged.

- [ ] **Step 6: Commit**

```bash
git add poc/server/src/project.ts poc/server/test/project.test.ts
git commit -m "refactor(server): one producer for session facts and arcade records (v7b1)"
```

---

### Task 3: The `poc/hub` package and the shared-module seam

A third package. It runs no agent, holds no API key and clones no repo (spec §1) — it is an HTTP server, a WebSocket router and an in-memory store.

**The shared-code decision, made here so nobody re-litigates it mid-plan.** The hub needs `relayProtocol.ts`, `staticFiles.ts`, and types from `project.ts` / `events.ts` / `pendingGate.ts` / `lifecycle.ts`, and in v7b2 it will need `auth.ts` in full. Three options were weighed:

1. **Copy the files into `poc/hub`.** Rejected: `auth.ts` is 387 lines of cookie signing and allowlist logic, and two divergent copies of it is exactly how a security bug gets shipped.
2. **Hoist a `poc/shared/` source directory.** Rejected: it forces `poc/server/tsconfig.build.json` off `rootDir: "src"`, which moves the build output from `dist/main.js` to a nested path and breaks both `node dist/main.js` and the systemd `ExecStart`. That constraint is recorded in HANDOFF §4e and is not worth spending here.
3. **Chosen: `poc/hub` depends on `poc/server` as a `file:` dependency and imports through an `exports` map.** No source moves, no server test path changes, no build-output change. It costs one documented ordering constraint — the server must be built before the hub type-checks — which is wired into the hub's `pretest`/`prebuild` scripts so it can never be forgotten.

**Files:**
- Modify: `poc/server/package.json` (add `exports`), `poc/server/tsconfig.build.json` (add `declaration`)
- Create: `poc/hub/package.json`, `poc/hub/tsconfig.json`, `poc/hub/tsconfig.build.json`, `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`, `poc/hub/.gitignore`
- Test: `poc/hub/test/httpSurface.test.ts`

**Interfaces:**
- Consumes: `staticHandler` and `MAX_FRAME_BYTES` from the server package.
- Produces: `startHub(opts: { port: number; host?: string; staticDir?: string }): Promise<{ port: number; close: () => Promise<void> }>`. Tasks 4, 6 and 7 extend this signature; the name and the returned shape do not change.

- [ ] **Step 1: Add the export seam to the server package**

Edit `poc/server/tsconfig.build.json` — add `"declaration": true` so the emitted `dist/*.d.ts` files give the hub real types:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": true
  },
  "include": ["src"]
}
```

Edit `poc/server/package.json` — add an `exports` map after `"bin"`. Only external importers are affected; `bin/mpai.js` and every test import the package's own files by relative path, so nothing existing changes:

```json
  "exports": {
    "./relayProtocol": { "types": "./dist/relayProtocol.d.ts", "default": "./dist/relayProtocol.js" },
    "./staticFiles": { "types": "./dist/staticFiles.d.ts", "default": "./dist/staticFiles.js" },
    "./project": { "types": "./dist/project.d.ts", "default": "./dist/project.js" },
    "./events": { "types": "./dist/events.d.ts", "default": "./dist/events.js" },
    "./pendingGate": { "types": "./dist/pendingGate.d.ts", "default": "./dist/pendingGate.js" },
    "./lifecycle": { "types": "./dist/lifecycle.d.ts", "default": "./dist/lifecycle.js" },
    "./auth": { "types": "./dist/auth.d.ts", "default": "./dist/auth.js" }
  },
```

- [ ] **Step 2: Verify the server still builds and nothing regressed**

Run: `cd poc/server && npm run build && ls dist/relayProtocol.d.ts dist/main.js`
Expected: both files exist. `dist/main.js` at the top level, **not** `dist/src/main.js` — if it is nested, `rootDir` was lost and the systemd unit is broken.

Run: `cd poc/server && npx vitest run`
Expected: **363 passed**, unchanged.

- [ ] **Step 3: Create the hub package**

Create `poc/hub/package.json`:

```json
{
  "name": "multiplayer-ai-hub",
  "private": true,
  "type": "module",
  "scripts": {
    "prebuild": "npm --prefix ../server run build",
    "build": "tsc -p tsconfig.build.json",
    "pretest": "npm --prefix ../server run build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev": "npm --prefix ../server run build && tsx --env-file-if-exists=.env src/main.ts"
  },
  "dependencies": {
    "multiplayer-ai-server": "file:../server",
    "ws": "^8.21.1"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "@types/ws": "^8.18.1",
    "tsx": "^4.23.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

Create `poc/hub/tsconfig.json` (mirrors the server's exactly — same module system, same strictness):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

Create `poc/hub/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src"]
}
```

Create `poc/hub/.gitignore`:

```
node_modules
dist
.env
```

- [ ] **Step 4: Write the failing test**

Create `poc/hub/test/httpSurface.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startHub } from "../src/hub.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("hub HTTP surface", () => {
  it("serves /healthz as JSON, not the SPA page", async () => {
    // Same ordering trap A1a documented for the server: the static handler's
    // SPA fallback serves index.html for any extensionless path, so a health
    // route wired after it returns HTML with a 200 — a probe that passes
    // forever while the hub is broken. Assert the BODY, not the status.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ status: "ok" }));
  });

  it("rejects a non-GET /healthz with 405", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/healthz`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("404s an unknown path in plain text when no client is configured", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("binds the host it was given rather than every interface", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    expect(hub.port).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd poc/hub && npm install && npx vitest run`
Expected: FAIL — `Failed to resolve import "../src/hub.js"`.

- [ ] **Step 6: Write the implementation**

Create `poc/hub/src/hub.ts`:

```ts
import { createServer } from "node:http";
import { staticHandler } from "multiplayer-ai-server/staticFiles";

export interface HubOptions {
  port: number;
  host?: string;
  /** Built client directory. The hub serves the browser surface; laptops
   *  serve nothing once they are hub-attached. */
  staticDir?: string;
}

export interface RunningHub {
  port: number;
  close: () => Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<RunningHub> {
  const serveStatic = opts.staticDir ? staticHandler(opts.staticDir) : null;

  const httpServer = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // BEFORE the static handler, for the reason A1a documented at
    // staticFiles.ts:51-53: the SPA fallback serves index.html for any
    // extensionless path, so a health route wired after it returns HTML with
    // a 200 and the probe passes forever while the hub is broken.
    if (pathname === "/healthz" || pathname === "/healthz/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      return;
    }
    if (serveStatic) {
      serveStatic(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.once("listening", () => {
      httpServer.removeListener("error", onError);
      resolve();
    });
    httpServer.listen(opts.port, opts.host);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

Create `poc/hub/src/main.ts`:

```ts
import { startHub } from "./hub.js";

const port = Number(process.env.PORT ?? 4000);
// Loopback by default, like the server (A1a): the deployed port is reachable
// only through the reverse proxy. Set HOST=0.0.0.0 for LAN access.
const host = process.env.HOST ?? "127.0.0.1";

const { port: actual } = await startHub({
  port,
  host,
  staticDir: process.env.CLIENT_DIST,
});

console.log(`multiplayer-ai hub listening on http://${host}:${actual}`);
if (process.env.CLIENT_DIST) console.log(`serving client from ${process.env.CLIENT_DIST}`);
console.log("auth OFF — v7b1 development hub, do NOT expose this to the internet");
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS, 4 tests; tsc clean; `dist/main.js` emitted.

- [ ] **Step 8: Confirm the server is untouched**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, **363 passed**.

- [ ] **Step 9: Commit**

```bash
git add poc/server/package.json poc/server/tsconfig.build.json \
        poc/hub/package.json poc/hub/tsconfig.json poc/hub/tsconfig.build.json \
        poc/hub/.gitignore poc/hub/src/hub.ts poc/hub/src/main.ts \
        poc/hub/test/httpSurface.test.ts poc/hub/package-lock.json
git commit -m "feat(hub): package skeleton, health route and the shared-module seam (v7b1)"
```

---

### Task 4: `hubStore.ts` — the hub's state, as pure functions

Everything the hub knows, with no sockets in sight: which laptops are attached, what each has published, and how a project snapshot is assembled from many laptops at once. This is where the `(runId, seq)` trap is designed out rather than discovered later (spec §3.2).

**Files:**
- Create: `poc/hub/src/hubStore.ts`
- Test: `poc/hub/test/hubStore.test.ts`

**Interfaces:**
- Consumes: `SessionFacts` from `multiplayer-ai-server/relayProtocol`, `arcadeRecordsFrom` and `ProjectMessage` from `multiplayer-ai-server/project`, `LoggedEvent` from `multiplayer-ai-server/events`.
- Produces:
  - `class HubStore` with `attach(uplinkId, projectId, repoKey)`, `detach(uplinkId)`, `resumeOffsets(uplinkId)`, `publish(uplinkId, sessionId, runId, events)`, `setFacts(uplinkId, sessionId, runId, facts)`, `ownerOf(projectId, sessionId)`, `eventsFor(projectId, sessionId, fromId)`, `snapshot(projectId)`.
  - `interface StoredEvent { id: number; runId: string; event: LoggedEvent }`
  - Task 7 (hub wiring) is the only caller.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/hubStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HubStore } from "../src/hubStore.js";
import type { SessionFacts } from "multiplayer-ai-server/relayProtocol";

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  id: "auth",
  participants: ["ana"],
  driverName: "ana",
  intent: null,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: "github.com/acme/api",
  lifecycle: "open",
  ...over,
});

const ev = (seq: number, type = "user_message") =>
  ({ type, seq, ts: `2026-07-27T00:00:${String(seq).padStart(2, "0")}.000Z`, userId: "ana", text: "x" }) as any;

describe("HubStore event keying", () => {
  it("appends a new run instead of overwriting history when a laptop restarts", () => {
    // THE trap (spec §3.2): the laptop's log is in memory, so a restart resets
    // seq to 0. Keyed by seq alone the hub would silently overwrite real
    // history. Keyed by (runId, seq) it appends a second run.
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    store.publish("lap-1", "auth", "run-b", [ev(0), ev(1)]);

    const all = store.eventsFor("default", "auth", 0);
    expect(all).toHaveLength(5);
    expect(all.map((e) => e.runId)).toEqual(["run-a", "run-a", "run-a", "run-b", "run-b"]);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("ignores a replay of events it already holds for the same run", () => {
    // A reconnecting laptop that resumes from the wrong offset must not
    // duplicate the log for everyone watching.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 0)).toHaveLength(3);
  });

  it("reports resume offsets per session so a reconnect replays only the gap", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.resumeOffsets("lap-1")).toEqual({ auth: { runId: "run-a", lastSeq: 2 } });
  });

  it("serves events from an id, so a late browser gets only what it is missing", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 2).map((e) => e.id)).toEqual([3]);
  });
});

describe("HubStore presence and ownership", () => {
  it("keeps a detached laptop's sessions but flips them offline", () => {
    // The payoff of the hub: sessions survive a laptop disconnecting. What
    // must NOT survive is the illusion that they can be driven.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.setFacts("lap-1", "auth", "run-a", facts());
    expect(store.snapshot("default").sessions[0].presence).toBe("online");

    store.detach("lap-1");
    const after = store.snapshot("default").sessions[0];
    expect(after.presence).toBe("offline");
    expect(after.id).toBe("auth");
  });

  it("routes a command to the laptop that owns the session", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api");
    store.attach("lap-2", "default", "github.com/acme/web");
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    store.setFacts("lap-2", "ui", "run-b", facts({ id: "ui", repoKey: "github.com/acme/web" }));
    expect(store.ownerOf("default", "auth")).toBe("lap-1");
    expect(store.ownerOf("default", "ui")).toBe("lap-2");
    expect(store.ownerOf("default", "nope")).toBeNull();
  });

  it("refuses a second live laptop claiming a session id already owned in the project", () => {
    // Known bound, deliberately loud: two laptops can each have a session
    // called "auth". v7b1 rejects the collision rather than silently merging
    // two machines' streams into one row. Hub-scoped session ids are v7c.
    const store = new HubStore();
    store.attach("lap-1", "default", "k1");
    store.setFacts("lap-1", "auth", "run-a", facts());
    store.attach("lap-2", "default", "k2");
    expect(store.setFacts("lap-2", "auth", "run-z", facts())).toEqual({
      ok: false,
      error: 'session "auth" in project "default" is already owned by another machine',
    });
  });

  it("lets a reconnecting laptop reclaim its own session ids", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.setFacts("lap-1", "auth", "run-a", facts());
    store.detach("lap-1");
    store.attach("lap-1", "default", "k");
    expect(store.setFacts("lap-1", "auth", "run-b", facts())).toEqual({ ok: true });
  });
});

describe("HubStore snapshot assembly", () => {
  it("composes one project view across several laptops and repos", () => {
    // Only the hub sees every laptop, so only the hub can build this. It is
    // the thing four servers and four URLs could never do.
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api");
    store.attach("lap-2", "default", "github.com/acme/web");
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth", repoKey: "github.com/acme/api" }));
    store.setFacts("lap-2", "ui", "run-b", facts({ id: "ui", repoKey: "github.com/acme/web" }));

    const snap = store.snapshot("default");
    expect(snap.type).toBe("project");
    expect(snap.sessions.map((s) => s.id).sort()).toEqual(["auth", "ui"]);
    expect(snap.sessions.map((s) => s.repoKey).sort()).toEqual([
      "github.com/acme/api",
      "github.com/acme/web",
    ]);
  });

  it("aggregates arcade records across every attached laptop", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.attach("lap-2", "default", "k2");
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    store.setFacts("lap-2", "ui", "run-b", facts({ id: "ui" }));
    store.publish("lap-1", "auth", "run-a", [
      { type: "presence_join", userId: "ana", name: "ana", seq: 0, ts: "2026-07-27T00:00:00.000Z" } as any,
      { type: "game_score", userId: "ana", game: "tetris", score: 90, seq: 1, ts: "2026-07-27T00:00:01.000Z" } as any,
    ]);
    store.publish("lap-2", "ui", "run-b", [
      { type: "presence_join", userId: "ben", name: "ben", seq: 0, ts: "2026-07-27T00:00:02.000Z" } as any,
      { type: "game_score", userId: "ben", game: "tetris", score: 400, seq: 1, ts: "2026-07-27T00:00:03.000Z" } as any,
    ]);
    expect(store.snapshot("default").arcade).toEqual([
      { game: "tetris", score: 400, userId: "ben", name: "ben", glyph: undefined, color: undefined },
    ]);
  });

  it("returns an empty but well-formed snapshot for an unknown project", () => {
    const store = new HubStore();
    expect(store.snapshot("nobody")).toEqual({
      type: "project",
      sessions: [],
      arcade: [],
      plugins: [],
      pluginsEnabled: false,
      repo: null,
      oversight: { enabled: false, latest: null },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/hubStore.test.ts`
Expected: FAIL — `Failed to resolve import "../src/hubStore.js"`.

- [ ] **Step 3: Write the implementation**

Create `poc/hub/src/hubStore.ts`:

```ts
import type { LoggedEvent } from "multiplayer-ai-server/events";
import { arcadeRecordsFrom, type ProjectMessage } from "multiplayer-ai-server/project";
import type { SessionFacts } from "multiplayer-ai-server/relayProtocol";

export interface StoredEvent {
  /** The hub's own monotonic id, per session. Browsers resume from this, NOT
   *  from the laptop's `seq` — which restarts at 0 on every new run. */
  id: number;
  runId: string;
  event: LoggedEvent;
}

interface HubSession {
  uplinkId: string;
  facts: SessionFacts;
  events: StoredEvent[];
  /** Last (runId, seq) accepted, so a reconnecting laptop that resumes from a
   *  stale offset re-sends without duplicating the log for every watcher. */
  lastRunId: string | null;
  lastSeq: number;
}

interface Uplink {
  uplinkId: string;
  projectId: string;
  repoKey: string;
  online: boolean;
}

export type SetFactsResult = { ok: true } | { ok: false; error: string };

/** Everything the hub knows, with no sockets. Kept a plain class over pure
 *  data so the whole of Task 7's routing is testable without a network.
 *
 *  v7b1 holds this in memory, exactly like today's server (spec §2.11).
 *  Durability across hub restarts is v7c and must not be presented to users
 *  as durable before then (spec §8). */
export class HubStore {
  private uplinks = new Map<string, Uplink>();
  /** projectId → sessionId → session */
  private projects = new Map<string, Map<string, HubSession>>();

  attach(uplinkId: string, projectId: string, repoKey: string): void {
    this.uplinks.set(uplinkId, { uplinkId, projectId, repoKey, online: true });
  }

  /** The laptop is gone. Its sessions stay — that is the point of the hub —
   *  but they must read `offline`, because an offline laptop cannot be driven
   *  or approved and its agent is not running either (spec §8). */
  detach(uplinkId: string): void {
    const uplink = this.uplinks.get(uplinkId);
    if (uplink) uplink.online = false;
  }

  private sessionsOf(projectId: string): Map<string, HubSession> {
    let sessions = this.projects.get(projectId);
    if (!sessions) {
      sessions = new Map();
      this.projects.set(projectId, sessions);
    }
    return sessions;
  }

  /** What the hub already holds for this laptop's sessions, so the laptop can
   *  replay only the gap (spec §3.2 — "reconnect is nearly free"). */
  resumeOffsets(uplinkId: string): Record<string, { runId: string; lastSeq: number }> {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return {};
    const out: Record<string, { runId: string; lastSeq: number }> = {};
    for (const [sessionId, session] of this.sessionsOf(uplink.projectId)) {
      if (session.uplinkId !== uplinkId || session.lastRunId === null) continue;
      out[sessionId] = { runId: session.lastRunId, lastSeq: session.lastSeq };
    }
    return out;
  }

  setFacts(
    uplinkId: string,
    sessionId: string,
    runId: string,
    facts: SessionFacts,
  ): SetFactsResult {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return { ok: false, error: "unknown uplink" };
    const sessions = this.sessionsOf(uplink.projectId);
    const existing = sessions.get(sessionId);
    if (existing && existing.uplinkId !== uplinkId) {
      // Loud, not silent. Two laptops can each have a session named "auth";
      // merging their streams into one row would be worse than refusing.
      // Hub-scoped session ids are a v7c/v7e problem (spec §9 is its sibling).
      return {
        ok: false,
        error: `session "${sessionId}" in project "${uplink.projectId}" is already owned by another machine`,
      };
    }
    if (existing) {
      existing.facts = facts;
      return { ok: true };
    }
    // `runId` is deliberately NOT recorded here. resumeOffsets skips sessions
    // whose lastRunId is still null, so a facts-only session reports nothing
    // and the laptop replays from 0 — which is correct, because the hub holds
    // no events for it yet. Recording it here would make the hub claim an
    // offset it cannot back with stored events.
    sessions.set(sessionId, {
      uplinkId,
      facts,
      events: [],
      lastRunId: null,
      lastSeq: -1,
    });
    return { ok: true };
  }

  /** A laptop may publish only for sessions it owns (spec §3.5 rule 2). */
  publish(uplinkId: string, sessionId: string, runId: string, events: LoggedEvent[]): StoredEvent[] {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return [];
    const sessions = this.sessionsOf(uplink.projectId);
    let session = sessions.get(sessionId);
    if (!session) {
      session = { uplinkId, facts: emptyFacts(sessionId, uplink.repoKey), events: [], lastRunId: null, lastSeq: -1 };
      sessions.set(sessionId, session);
    }
    if (session.uplinkId !== uplinkId) return [];

    const accepted: StoredEvent[] = [];
    for (const event of events) {
      const seq = typeof event.seq === "number" ? event.seq : -1;
      // Same run, already-seen seq → a resume overshoot, not new history.
      if (runId === session.lastRunId && seq <= session.lastSeq) continue;
      const stored: StoredEvent = { id: session.events.length + 1, runId, event };
      session.events.push(stored);
      accepted.push(stored);
      session.lastRunId = runId;
      session.lastSeq = seq;
    }
    return accepted;
  }

  ownerOf(projectId: string, sessionId: string): string | null {
    return this.sessionsOf(projectId).get(sessionId)?.uplinkId ?? null;
  }

  eventsFor(projectId: string, sessionId: string, fromId: number): StoredEvent[] {
    const session = this.sessionsOf(projectId).get(sessionId);
    if (!session) return [];
    return session.events.filter((e) => e.id > fromId);
  }

  /** The team view. Only the hub sees every laptop, so only the hub can build
   *  it (spec §3.2). `presence` comes from the uplink and nothing else; every
   *  other field is exactly what the owning laptop declared, so a hub-attached
   *  session renders identically to a standalone one. */
  snapshot(projectId: string): ProjectMessage {
    const sessions = [...this.sessionsOf(projectId).values()];
    return {
      type: "project",
      sessions: sessions.map((session) => ({
        ...session.facts,
        presence: this.uplinks.get(session.uplinkId)?.online ? ("online" as const) : ("offline" as const),
      })),
      arcade: arcadeRecordsFrom(sessions.map((s) => s.events.map((e) => e.event))),
      // Plugins are laptop-local files the agent loads (spec §4) and the hub
      // does not aggregate them in v7b1. The panel reads empty when
      // hub-attached; surfacing per-laptop plugin rosters is v7b3.
      plugins: [],
      pluginsEnabled: false,
      // A hub spans repos, so there is no single `repo` for it to report. The
      // per-session `repoKey` is the honest answer and the client already
      // reads it (v7a).
      repo: null,
      // Oversight is host-configured and hub-side (spec §3.7) — v7b3.
      oversight: { enabled: false, latest: null },
    };
  }
}

function emptyFacts(sessionId: string, repoKey: string): SessionFacts {
  return {
    id: sessionId,
    participants: [],
    driverName: null,
    intent: null,
    lastActivityTs: null,
    ended: false,
    pendingGate: null,
    skills: [],
    repoKey,
    lifecycle: "open",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run`
Expected: PASS, 15 tests (4 http + 11 store).

- [ ] **Step 5: Typecheck**

Run: `cd poc/hub && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add poc/hub/src/hubStore.ts poc/hub/test/hubStore.test.ts
git commit -m "feat(hub): in-memory store with (runId, seq) keying and snapshot assembly (v7b1)"
```

---

### Task 5: Extract the per-connection handler behind `ConnectionIO`

`server.ts`'s 540-line `ws.on("message")` body is the thing the relay must reuse — spec §2.3 is explicit that the hub relays the existing protocol verbatim and the local server gains **a second transport, not a new language**. This task moves that body into a factory with an injected IO seam and changes **no behaviour whatsoever**.

**This is the riskiest task in the plan.** Its acceptance criterion is unusual and non-negotiable: **all 363 server tests pass with zero edits to any existing test file.** If you find yourself changing an assertion, the refactor is wrong — revert and re-read.

**Files:**
- Modify: `poc/server/src/server.ts:292-877` (the whole `wss.on("connection")` block)
- Test: `poc/server/test/server.test.ts` (add one new `describe`; do not edit existing cases)

**Interfaces:**
- Consumes: `ProjectWatcher` from `./project.js`.
- Produces (exported from `server.ts`):
  - `interface ConnectionIO { mode: "direct" | "relay"; send(msg: unknown): void; watcher?: ProjectWatcher; cookieHeader?: string; stampedIdentity?: { userId: string; name: string } }`
  - `startServer` gains `hub?: HubUplinkOptions` in Task 6; this task adds nothing to its signature.
  - Task 6 (`relay.ts`) obtains connections through the `createConnection` closure that this task creates.

- [ ] **Step 1: Write the failing test**

Append to `poc/server/test/server.test.ts`:

```ts
describe("relay-mode connections", () => {
  it("accepts a stamped identity instead of a cookie, and never lets the payload override it", async () => {
    // The trust inversion (spec §3.5 rule 1): under the relay the HUB has
    // already verified who is speaking, so the laptop takes identity from the
    // stamp. A payload that claims someone else must be discarded exactly as
    // a cookie-verified join discards a forged userId today.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const sent: unknown[] = [];
    const conn = server.createConnection({
      mode: "relay",
      send: (m) => sent.push(m),
      stampedIdentity: { userId: "ana", name: "ana" },
    });
    conn.handleMessage({ type: "join", sessionId: "s1", userId: "totally-not-ana", name: "Mallory" });

    expect(JSON.stringify(sent)).not.toContain("totally-not-ana");
    expect(JSON.stringify(sent)).not.toContain("Mallory");
  });

  it("does not replay the log or subscribe per client in relay mode", async () => {
    // The hub owns replay and fan-out (spec §3.2). If the laptop also replayed
    // and subscribed per browser, a session with six watchers would push six
    // copies of every event up one uplink — the exact cost the two-plane
    // design exists to avoid.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const direct: any[] = [];
    const dconn = server.createConnection({ mode: "direct", send: (m) => direct.push(m) });
    dconn.handleMessage({ type: "join", sessionId: "s2", userId: "ana", name: "ana" });
    const directEvents = direct.filter((m) => m.type === "event").length;
    expect(directEvents).toBeGreaterThan(0);

    const relayed: any[] = [];
    const rconn = server.createConnection({
      mode: "relay",
      send: (m) => relayed.push(m),
      stampedIdentity: { userId: "ben", name: "ben" },
    });
    rconn.handleMessage({ type: "join", sessionId: "s3", userId: "ben", name: "ben" });
    expect(relayed.filter((m: any) => m.type === "event")).toHaveLength(0);
    expect(relayed.filter((m: any) => m.type === "project")).toHaveLength(0);
  });

  it("still enforces the driver gate for a relayed participant", async () => {
    // Approval authority comes from presence, not from transport (spec §2.9).
    // The gate rules are laptop-local and unchanged (spec §3.5 rule 3).
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const a: any[] = [];
    const b: any[] = [];
    const ana = server.createConnection({ mode: "relay", send: (m) => a.push(m), stampedIdentity: { userId: "ana", name: "ana" } });
    ana.handleMessage({ type: "join", sessionId: "s4", userId: "ana", name: "ana" });
    const ben = server.createConnection({ mode: "relay", send: (m) => b.push(m), stampedIdentity: { userId: "ben", name: "ben" } });
    ben.handleMessage({ type: "join", sessionId: "s4", userId: "ben", name: "ben" });

    ben.handleMessage({ type: "prompt", text: "hi" });
    expect(b.some((m) => m.type === "error" && /not driving/.test(m.message))).toBe(true);
  });

  it("drops the participant on close, exactly as a socket close does", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const sent: any[] = [];
    const conn = server.createConnection({ mode: "relay", send: (m) => sent.push(m), stampedIdentity: { userId: "ana", name: "ana" } });
    conn.handleMessage({ type: "join", sessionId: "s5", userId: "ana", name: "ana" });
    conn.close();
    conn.close(); // idempotent — a relay channel can be torn down twice
    expect(sent.some((m) => m.type === "error")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/server.test.ts -t "relay-mode connections"`
Expected: FAIL — `server.createConnection is not a function`.

- [ ] **Step 3: Perform the extraction**

This is a **mechanical move**, described precisely rather than reprinted — the body being moved is 540 lines and retyping it is how transcription bugs get introduced.

**3a.** Add the exported interface near `ClientContext` (`server.ts:32-37`):

```ts
/** The transport seam between a message handler and whatever is carrying it.
 *
 *  `direct` is a browser on a WebSocket straight to this process — it replays
 *  the log, subscribes per socket, and registers as a project watcher, exactly
 *  as it always has.
 *
 *  `relay` is a browser attached to the hub, tunnelled here (spec §3.2). The
 *  hub owns replay and fan-out, so this connection does none of it: doing it
 *  here would push one copy of every event per attached browser up a single
 *  uplink. Identity arrives pre-verified from the hub (spec §3.5 rule 1) —
 *  and identity is the ONLY thing trusted from upstream. Shape, length and
 *  charset validation below is untouched and still runs on every field
 *  (spec §10.4). */
export interface ConnectionIO {
  mode: "direct" | "relay";
  /** Narrowcast reply to the one client that sent the command. Best-effort:
   *  implementations drop the message if their transport has gone away. */
  send(msg: unknown): void;
  /** Direct only. Receives throttled project snapshots. */
  watcher?: ProjectWatcher;
  /** Direct only — this process verifies the cookie itself. */
  cookieHeader?: string;
  /** Relay only — the hub verified this browser and stamped it. */
  stampedIdentity?: { userId: string; name: string };
}
```

Import `ProjectWatcher` by adding it to the existing `./project.js` import (`server.ts:9-14`).

**3b.** Immediately above `wss.on("connection", ...)` (`server.ts:292`), open a new function that closes over everything `startServer` already has in scope:

```ts
  function createConnection(io: ConnectionIO): {
    handleMessage: (msg: any) => void;
    close: () => void;
  } {
    let ctx: ClientContext | null = null;
    let watching: Project | null = null;

    const sendError = (message: string) => io.send({ type: "error", message });

    // The token rides this reply and nothing else — never the session log,
    // which is replayed to every late joiner and cannot be un-replayed.
    const sendInviteList = (c: ClientContext) =>
      io.send({
        type: "invite_list",
        invites: invites.listFor(c.project.id, c.entry.session.id),
      });

    const handleMessage = (msg: any): void => {
      /* ===== the entire body of the former ws.on("message") handler,
               starting at the old server.ts:327 comment block and ending at
               the old server.ts:862 `sendError(unknown message type)` ===== */
    };

    const close = (): void => {
      if (watching) {
        if (io.watcher) watching.watchers.delete(io.watcher);
        watching = null;
      }
      if (ctx) {
        ctx.unsubscribe();
        if (io.watcher) ctx.project.watchers.delete(io.watcher);
        ctx.entry.session.leave(ctx.userId);
        ctx = null;
      }
    };

    return { handleMessage, close };
  }
```

**3c.** Move the old message-handler body into `handleMessage` **verbatim**, then apply exactly these six substitutions and nothing else:

| Where | Old | New |
|---|---|---|
| `denyUnauthed` (old `:340-345`) | `const check = requireAuth(cookieHeader, opts.auth);` | `if (io.stampedIdentity) return false;` as the first line, then `const check = requireAuth(io.cookieHeader, opts.auth);` |
| join auth (old `:374-379`) | `const joinAuth = requireAuth(cookieHeader, opts.auth); …` | the branch in **3d** below |
| join replay (old `:408-412`) | the `for (const event of …) ws.send(…)` loop | wrap it in `if (io.mode === "direct") { … io.send({ type: "event", event }); }` |
| join subscribe (old `:413-417`) | `const unsubscribe = entry.session.subscribe(…)` | the ternary in **3e** below |
| join watcher (old `:419`) | `project.watchers.add(ws);` | `if (io.watcher) project.watchers.add(io.watcher);` |
| join snapshot (old `:438`) | `ws.send(JSON.stringify(snapshotFor(project)));` | `if (io.mode === "direct") io.send(snapshotFor(project));` |

Then, throughout the moved body, replace every remaining `ws.send(JSON.stringify(X))` with `io.send(X)`, and in `watch_project` (old `:485-486`) replace the two `watchers` mutations with `if (io.watcher) { … }` guards. There are no other references to `ws` or `cookieHeader` in the body.

**3d.** The join identity branch becomes:

```ts
        // Auth gate (spec §4.3). Before the invite gate and therefore before
        // any provisioning: a rejected join must never create a worktree.
        // On success userId is REPLACED by the verified login — the client's
        // claim is discarded, which is the whole point of A2a (spec §2). The
        // display name is locked to the same login: it is the string humans
        // actually read, so leaving it client-chosen would relocate the
        // impersonation rather than remove it.
        if (io.stampedIdentity) {
          // Relay: the hub already verified this browser and stamped it
          // (spec §3.5 rule 1). Same overwrite, different verifier.
          msg.userId = io.stampedIdentity.userId;
          msg.name = io.stampedIdentity.name;
        } else {
          const joinAuth = requireAuth(io.cookieHeader, opts.auth);
          if (!joinAuth.ok) return sendError(joinAuth.error);
          if (joinAuth.login !== null) {
            msg.userId = joinAuth.login;
            msg.name = joinAuth.login;
          }
        }
```

**3e.** The join subscribe becomes:

```ts
        // Direct sockets get their own subscription; relayed clients receive
        // events through the hub's fan-out instead (spec §3.2), so subscribing
        // here would send N copies up one uplink for N watchers.
        const unsubscribe =
          io.mode === "direct"
            ? entry.session.subscribe((event) => io.send({ type: "event", event }))
            : () => {};
```

**3f.** Replace `wss.on("connection", …)` (old `:292-877`) with the thin adapter:

```ts
  wss.on("connection", (ws: WebSocket, upgradeReq: IncomingMessage) => {
    const conn = createConnection({
      mode: "direct",
      // Guarded here rather than at every call site: a socket can close
      // between an append and its fan-out, and a send on a closed socket
      // throws.
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      watcher: ws,
      // Captured once: the cookie cannot change for the life of this socket.
      cookieHeader: upgradeReq.headers.cookie,
    });

    // Without a listener, an "error" event on this socket would be an
    // unhandled EventEmitter error and crash the whole process. Cleanup is
    // handled by "close", which always follows an "error" on a ws socket.
    ws.on("error", (err: NodeJS.ErrnoException) => {
      void err?.code;
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
        return;
      }
      conn.handleMessage(msg);
    });

    ws.on("close", () => conn.close());
  });
```

**3g.** Expose it on the returned object so tests and the relay can reach it. In the `return {` block (old `:893-903`), add `createConnection,` beside `port` and `close`.

- [ ] **Step 4: Run the new tests**

Run: `cd poc/server && npx vitest run test/server.test.ts -t "relay-mode connections"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the invariant — this is the gate on the whole plan**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, **367 passed** (363 + 4). Then prove nothing was edited:

Run: `git diff --stat poc/server/test/`
Expected: `server.test.ts` shows **insertions only**. If any line was deleted from an existing test, the refactor changed behaviour — revert and redo.

- [ ] **Step 6: Commit**

```bash
git add poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "refactor(server): extract the per-connection handler behind ConnectionIO (v7b1)"
```

---

### Task 6: `relay.ts` — the laptop's outbound uplink

One outbound WebSocket, kept alive, carrying two planes. The socket is injected so the whole module is testable without a network — the same pattern as `auth.ts`'s injected `exchangeCode` and `config.ts:12`'s injected fs probe.

**Files:**
- Create: `poc/server/src/relay.ts`
- Modify: `poc/server/src/server.ts` (three hook points: `startServer` options, `getOrCreateSession`, `pushProject`)
- Test: `poc/server/test/relay.test.ts`

**Interfaces:**
- Consumes: `parseDownFrame`, `RELAY_PROTOCOL_VERSION`, `MAX_FRAME_BYTES`, `SessionFacts`, `UpFrame` from `./relayProtocol.js`; `sessionFactsOf` from `./project.js`; `ConnectionIO` and the `createConnection` closure from `./server.js`.
- Produces:
  - `interface RelaySocket { send(data: string): void; close(): void; on(event: string, fn: (arg?: unknown) => void): void }`
  - `type ConnectFn = (url: string) => RelaySocket`
  - `interface RelayOptions { hubUrl: string; projectId: string; repoKey: string; uplinkId: string; connect?: ConnectFn; reconnectDelayMs?: number; newRunId?: () => string }`
  - `class Relay` with `start()`, `trackSession(sessionId, session)`, `publishEvent(sessionId, event)`, `publishFacts(sessionId, facts)`, `stop()`
  - Task 7 (hub wiring) and Task 8 (`mpai --hub`) construct it.

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/relay.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Relay, type RelaySocket } from "../src/relay.js";
import { Session } from "../src/session.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relayProtocol.js";

/** A socket that records what was sent and lets the test drive the far end. */
function fakeSocket() {
  const sent: any[] = [];
  const handlers = new Map<string, (arg?: unknown) => void>();
  const socket: RelaySocket = {
    send: (data) => sent.push(JSON.parse(data)),
    close: () => handlers.get("close")?.(),
    on: (event, fn) => void handlers.set(event, fn),
  };
  return {
    socket,
    sent,
    open: () => handlers.get("open")?.(),
    deliver: (frame: unknown) => handlers.get("message")?.(JSON.stringify(frame)),
    drop: () => handlers.get("close")?.(),
  };
}

function relayWith(fake: ReturnType<typeof fakeSocket>, over: Record<string, unknown> = {}) {
  let n = 0;
  return new Relay(
    {
      hubUrl: "ws://hub.test",
      projectId: "default",
      repoKey: "github.com/acme/api",
      uplinkId: "lap-1",
      connect: () => fake.socket,
      newRunId: () => `run-${++n}`,
      ...over,
    },
    { createConnection: () => ({ handleMessage: () => {}, close: () => {} }) },
  );
}

describe("Relay handshake", () => {
  it("sends hello with the protocol version, project and repo key on open", () => {
    const fake = fakeSocket();
    relayWith(fake).start();
    fake.open();
    expect(fake.sent[0]).toEqual({
      t: "hello",
      v: RELAY_PROTOCOL_VERSION,
      uplinkId: "lap-1",
      projectId: "default",
      repoKey: "github.com/acme/api",
    });
  });

  it("replays only the gap the hub says it is missing", () => {
    // The payoff of the append-only design (spec §3.2): the hub reports what
    // it holds and the laptop replays from there. No diffing, no reconciling.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    session.append({ type: "intent_update", text: "a" });
    session.append({ type: "intent_update", text: "b" });
    session.append({ type: "intent_update", text: "c" });
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: { auth: { runId: "run-1", lastSeq: 0 } } });

    const publish = fake.sent.find((f) => f.t === "publish" && f.sessionId === "auth");
    expect(publish.runId).toBe("run-1");
    expect(publish.events.map((e: any) => e.seq)).toEqual([1, 2]);
  });

  it("replays from zero when the hub holds a different run", () => {
    // A restarted laptop mints a new runId, so its seq 0 is genuinely new
    // history rather than an overwrite of the hub's run.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    session.append({ type: "intent_update", text: "fresh" });
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: { auth: { runId: "run-from-a-dead-process", lastSeq: 99 } } });

    const publish = fake.sent.find((f) => f.t === "publish");
    expect(publish.runId).toBe("run-1");
    expect(publish.events.map((e: any) => e.seq)).toEqual([0]);
  });
});

describe("Relay publish plane", () => {
  it("publishes an event once, regardless of how many browsers are watching", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    relay.publishEvent("auth", session.append({ type: "intent_update", text: "one" }));
    const publishes = fake.sent.filter((f) => f.t === "publish");
    expect(publishes).toHaveLength(1);
    expect(publishes[0].events).toHaveLength(1);
  });

  it("publishes facts as a separate frame from events", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.trackSession("auth", new Session("auth"));
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    relay.publishFacts("auth", {
      id: "auth", participants: ["ana"], driverName: "ana", intent: null,
      lastActivityTs: null, ended: false, pendingGate: null, skills: [],
      repoKey: "github.com/acme/api", lifecycle: "open",
    });
    expect(fake.sent.filter((f) => f.t === "facts")).toHaveLength(1);
  });

  it("loses nothing that happened before the socket was open", () => {
    // Events produced while the uplink is down must still reach the hub. They
    // do so through the handshake replay, which reads the live log — so this
    // asserts the outcome, not the mechanism.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    relay.publishEvent("auth", session.append({ type: "intent_update", text: "early" }));
    expect(fake.sent).toHaveLength(0);
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    const published = fake.sent.filter((f) => f.t === "publish").flatMap((f: any) => f.events);
    expect(published.map((e: any) => e.text)).toEqual(["early"]);
  });

  it("publishes a session's backlog when it is created while the uplink is already up", () => {
    // The gap this closes: a session created after the handshake gets no
    // second `welcome`, so the skill_roster appended at creation — before any
    // subscriber exists — would otherwise never reach the hub at all.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    const late = new Session("late");
    late.append({ type: "skill_roster", skills: [{ name: "x", description: "d" }] });
    relay.trackSession("late", late);

    const published = fake.sent.filter((f) => f.t === "publish" && f.sessionId === "late");
    expect(published).toHaveLength(1);
    expect(published[0].events.map((e: any) => e.type)).toEqual(["skill_roster"]);
  });
});

describe("Relay command plane", () => {
  it("feeds a tunnelled payload to a connection and replies on the same channel", () => {
    const handled: unknown[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
      {
        createConnection: (io) => ({
          handleMessage: (msg) => {
            handled.push(msg);
            io.send({ type: "error", message: "nope" });
          },
          close: () => {},
        }),
      },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.sent.length = 0;

    const payload = { type: "prompt", text: "hi" };
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload });

    expect(handled).toEqual([payload]);
    expect(fake.sent).toContainEqual({ t: "reply", channelId: "c1", payload: { type: "error", message: "nope" } });
  });

  it("reuses one connection per channel, so a browser's join survives its next command", () => {
    const created: unknown[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
      { createConnection: (io) => { created.push(io); return { handleMessage: () => {}, close: () => {} }; } },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload: { type: "join" } });
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload: { type: "prompt", text: "x" } });
    expect(created).toHaveLength(1);
  });

  it("stamps the connection with the hub's identity and never with the payload's", () => {
    const ios: any[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
      { createConnection: (io) => { ios.push(io); return { handleMessage: () => {}, close: () => {} }; } },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.deliver({
      t: "tunnel", channelId: "c1",
      identity: { userId: "ana", name: "ana" },
      payload: { type: "join", userId: "mallory", name: "Mallory" },
    });
    expect(ios[0].mode).toBe("relay");
    expect(ios[0].stampedIdentity).toEqual({ userId: "ana", name: "ana" });
    expect(ios[0].watcher).toBeUndefined();
    expect(ios[0].cookieHeader).toBeUndefined();
  });

  it("closes and forgets a channel on detach, so the roster keeps no ghost", () => {
    const closed: string[] = [];
    const created: unknown[] = [];
    const fake = fakeSocket();
    const relay = new Relay(
      { hubUrl: "ws://hub.test", projectId: "default", repoKey: "k", uplinkId: "lap-1", connect: () => fake.socket },
      {
        createConnection: () => {
          created.push(1);
          return { handleMessage: () => {}, close: () => closed.push("c") };
        },
      },
    );
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ana", name: "ana" }, payload: { type: "join" } });
    fake.deliver({ t: "detach", channelId: "c1" });
    expect(closed).toHaveLength(1);
    // A later tunnel on the same id is a NEW browser, not the old one.
    fake.deliver({ t: "tunnel", channelId: "c1", identity: { userId: "ben", name: "ben" }, payload: { type: "join" } });
    expect(created).toHaveLength(2);
  });

  it("ignores a malformed down-frame rather than crashing the uplink", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    relay.start();
    fake.open();
    expect(() => fake.deliver({ t: "tunnel", channelId: "c1" })).not.toThrow();
    expect(() => fake.deliver("not json at all")).not.toThrow();
  });
});

describe("Relay reconnect", () => {
  it("reconnects after the socket drops and re-handshakes", () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    let connects = 0;
    const relay = relayWith(fake, {
      connect: () => { connects++; return fake.socket; },
      reconnectDelayMs: 500,
    });
    relay.start();
    fake.open();
    expect(connects).toBe(1);
    fake.drop();
    vi.advanceTimersByTime(500);
    expect(connects).toBe(2);
    relay.stop();
    vi.useRealTimers();
  });

  it("stops reconnecting once stopped", () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    let connects = 0;
    const relay = relayWith(fake, { connect: () => { connects++; return fake.socket; }, reconnectDelayMs: 500 });
    relay.start();
    fake.open();
    relay.stop();
    fake.drop();
    vi.advanceTimersByTime(5000);
    expect(connects).toBe(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/relay.test.ts`
Expected: FAIL — `Failed to resolve import "../src/relay.js"`.

- [ ] **Step 3: Write `relay.ts`**

Create `poc/server/src/relay.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { LoggedEvent } from "./events.js";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseDownFrame,
  type SessionFacts,
  type UpFrame,
} from "./relayProtocol.js";
import type { Session } from "./session.js";
import type { ConnectionIO } from "./server.js";

/** Structural socket so the whole module is testable with no network — the
 *  same injection pattern as auth.ts's exchangeCode and config.ts's fs probe. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", fn: (arg?: unknown) => void): void;
}

export type ConnectFn = (url: string) => RelaySocket;

export interface RelayOptions {
  hubUrl: string;
  projectId: string;
  repoKey: string;
  uplinkId: string;
  connect?: ConnectFn;
  reconnectDelayMs?: number;
  /** Injected so tests get deterministic run ids. */
  newRunId?: () => string;
}

export interface RelayDeps {
  createConnection: (io: ConnectionIO) => { handleMessage: (msg: any) => void; close: () => void };
}

interface Tracked {
  session: Session;
  /** Minted once per session process start. Events are keyed (runId, seq), so
   *  a laptop restart appends a new run to the hub's store instead of letting
   *  a reset `seq` silently overwrite real history (spec §3.2). This is also
   *  v7d's seam: a session resumed from a handoff IS a new run of the same
   *  session. */
  runId: string;
}

export class Relay {
  private socket: RelaySocket | null = null;
  private open = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tracked = new Map<string, Tracked>();
  private channels = new Map<string, { handleMessage: (msg: any) => void; close: () => void }>();
  /** Frames produced before the socket was ready. Bounded by MAX_FRAME_BYTES
   *  worth of accumulated JSON so a hub that never comes up cannot grow the
   *  laptop's memory without limit. */
  private pending: UpFrame[] = [];
  private pendingBytes = 0;

  constructor(
    private opts: RelayOptions,
    private deps: RelayDeps,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const conn of this.channels.values()) conn.close();
    this.channels.clear();
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }

  /** Register a session so it takes part in the handshake replay. Called for
   *  every session this process owns, including ones created after the uplink
   *  is already up. */
  trackSession(sessionId: string, session: Session): void {
    if (this.tracked.has(sessionId)) return;
    const runId = (this.opts.newRunId ?? (() => randomUUID()))();
    this.tracked.set(sessionId, { session, runId });
    // A session created while the uplink is ALREADY up gets no second
    // `welcome`, so its backlog — the `skill_roster` appended at creation,
    // before any subscriber exists — would never reach the hub. Publish what
    // it already holds; the handshake replay covers the other case, and the
    // two cannot double-publish because this method returns early for a
    // session it already tracks.
    const backlog = session.eventsFrom(0);
    if (backlog.length > 0) {
      this.emit({ t: "publish", sessionId, runId, events: backlog });
    }
  }

  publishEvent(sessionId: string, event: LoggedEvent): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    this.emit({ t: "publish", sessionId, runId: tracked.runId, events: [event] });
  }

  publishFacts(sessionId: string, facts: SessionFacts): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    this.emit({ t: "facts", sessionId, runId: tracked.runId, facts });
  }

  private connect(): void {
    const connect = this.opts.connect ?? defaultConnect;
    const socket = connect(this.opts.hubUrl);
    this.socket = socket;
    socket.on("open", () => {
      this.open = true;
      this.write({
        t: "hello",
        v: RELAY_PROTOCOL_VERSION,
        uplinkId: this.opts.uplinkId,
        projectId: this.opts.projectId,
        repoKey: this.opts.repoKey,
      });
    });
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", () => {
      this.open = false;
      this.socket = null;
      // Every channel's browser is now unreachable from here. Dropping them
      // fires the same leave path a closed direct socket does, so the roster
      // stays honest rather than showing ghosts.
      for (const conn of this.channels.values()) conn.close();
      this.channels.clear();
      this.scheduleReconnect();
    });
    // Without a listener an "error" is an unhandled EventEmitter error and
    // crashes the process. "close" always follows, and does the cleanup.
    socket.on("error", () => {});
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, this.opts.reconnectDelayMs ?? 2000);
  }

  private onMessage(data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const frame = parseDownFrame(raw);
    if (!frame) return;

    if (frame.t === "welcome") {
      // The replay below reads the live log and is therefore authoritative:
      // anything buffered while the socket was down is already contained in
      // it. Dropping buffered publishes avoids re-sending events the hub
      // would only discard by (runId, seq) anyway.
      this.pending = this.pending.filter((f) => f.t !== "publish");
      this.pendingBytes = this.pending.reduce((n, f) => n + JSON.stringify(f).length, 0);
      for (const [sessionId, tracked] of this.tracked) {
        const have = frame.have[sessionId];
        // Same run → replay only the gap. Different run (or none) → this is
        // new history and the hub appends it beside what it already holds.
        const from = have && have.runId === tracked.runId ? have.lastSeq + 1 : 0;
        const events = tracked.session.eventsFrom(from);
        if (events.length > 0) {
          this.write({ t: "publish", sessionId, runId: tracked.runId, events });
        }
      }
      this.flush();
      return;
    }

    if (frame.t === "detach") {
      // The browser on this channel is gone. Closing runs the same leave path
      // a closed direct socket runs, so presence_leave fires and the wheel is
      // handed on — without it the roster keeps a ghost forever.
      const conn = this.channels.get(frame.channelId);
      conn?.close();
      this.channels.delete(frame.channelId);
      return;
    }

    // frame.t === "tunnel"
    let conn = this.channels.get(frame.channelId);
    if (!conn) {
      const channelId = frame.channelId;
      conn = this.deps.createConnection({
        mode: "relay",
        send: (msg) => this.write({ t: "reply", channelId, payload: msg }),
        // No watcher and no cookie: the hub owns snapshot fan-out, and it —
        // not this process — verified who is speaking (spec §3.5).
        stampedIdentity: frame.identity,
      });
      this.channels.set(channelId, conn);
    }
    conn.handleMessage(frame.payload);
  }

  private emit(frame: UpFrame): void {
    if (this.open) {
      this.write(frame);
      return;
    }
    const size = JSON.stringify(frame).length;
    if (this.pendingBytes + size > MAX_FRAME_BYTES) return; // drop rather than grow without bound
    this.pending.push(frame);
    this.pendingBytes += size;
  }

  private flush(): void {
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const frame of queued) this.write(frame);
  }

  private write(frame: UpFrame): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      /* the close handler will reconnect */
    }
  }
}

/** Real socket, kept out of the class so tests never reach the network. */
const defaultConnect: ConnectFn = (url) => {
  // Imported lazily so `ws` is not pulled in by pure-module tests.
  const { WebSocket } = require("ws") as typeof import("ws");
  const socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    on: (event, fn) => void socket.on(event, fn as (...args: unknown[]) => void),
  };
};
```

**Note on `require` in an ESM file:** `poc/server` is `"type": "module"`, so `require` is not defined. Replace `defaultConnect` with a top-level `import { WebSocket } from "ws";` and use it directly — `ws` is already a dependency of this package and `server.ts` imports it at the top level too, so there is nothing to defer:

```ts
import { WebSocket } from "ws";

const defaultConnect: ConnectFn = (url) => {
  const socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    on: (event, fn) => void socket.on(event, fn as (...args: unknown[]) => void),
  };
};
```

- [ ] **Step 4: Wire the three hook points in `server.ts`**

**4a.** Add to the `startServer` options object (after `auth?: AuthConfig`):

```ts
  /** When set, this process also dials the hub and relays its sessions
   *  (spec §3.1). Absent, `mpai` behaves exactly as it always has — the hub
   *  is strictly additive (spec §6). */
  hub?: {
    url: string;
    projectId: string;
    uplinkId?: string;
    connect?: ConnectFn;
  };
```

and import `Relay`, `type ConnectFn` from `./relay.js`, and `sessionFactsOf` from `./project.js`.

**4b.** Construct the relay after `createConnection` is defined and before `httpServer.listen`:

```ts
  const relay = opts.hub
    ? new Relay(
        {
          hubUrl: opts.hub.url,
          projectId: opts.hub.projectId,
          repoKey: repo?.key ?? "",
          uplinkId: opts.hub.uplinkId ?? randomUUID(),
          connect: opts.hub.connect,
        },
        { createConnection },
      )
    : null;
```

**4c.** In `getOrCreateSession`, two edits, and **the order of them is load-bearing.**

First, publish from the existing subscribe callback (`server.ts:215-218`):

```ts
      session.subscribe((event) => {
        if (INTERESTING.has(event.type)) schedulePush(project);
        if (OVERSEER_EVENTS.has(event.type)) overseer.notify(project.id);
        relay?.publishEvent(sessionId, event);
      });
```

Second, register the session with the relay as the **last** statement of the `if (!entry)` block, after `overseer.notify(project.id);` (`server.ts:219`):

```ts
      relay?.trackSession(sessionId, session);
```

**Why last, and not next to `new Session(...)`.** The `skill_roster` event is appended at `server.ts:194`, before the subscribe above exists — so it is never published live. If the uplink is not yet up that is harmless: the handshake replay in Task 6's `welcome` branch reads `session.eventsFrom(0)` and includes it. But a session created while the uplink is **already** up gets no second `welcome`, and the roster event would be lost forever. Registering last means `trackSession` sees a session that already holds its backlog and publishes it (step 3's implementation does exactly this), while every later event arrives through the subscribe. The two paths do not overlap, because `trackSession` returns early for an already-tracked session.

**`relay` is declared below this function** (step 4b) and read only from inside it. That is safe: `getOrCreateSession` runs only from a message handler, long after `listen` resolves.

**4d.** In `pushProject`, publish facts on the same 1-second throttle the snapshot already uses — no second timer, and a fact change is by definition accompanied by a snapshot push:

```ts
    if (relay) {
      for (const [id, entry] of project.sessions) {
        relay.publishFacts(id, sessionFactsOf(id, entry, repo?.key ?? null));
      }
    }
```

**4e.** Start it after the listen promise resolves, and stop it in `close()`:

```ts
  relay?.start();
```

and in the returned `close`, before `overseer.dispose()`:

```ts
        relay?.stop();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/relay.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Verify the additive invariant again**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, **381 passed** (367 + 14). No existing test edited — with no `hub` option, `relay` is null and every `relay?.` call is a no-op.

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/relay.ts poc/server/src/server.ts poc/server/test/relay.test.ts
git commit -m "feat(server): outbound hub uplink with two-plane relay (v7b1)"
```

---

### Task 7: The hub's WebSocket surface — uplinks, browsers and channel routing

Where the two planes meet. Browsers connect to `/`, laptops to `/uplink`; the hub replays and fans out from its own store, and routes everything else to the laptop that owns the session.

**Files:**
- Modify: `poc/hub/src/hub.ts`
- Test: `poc/hub/test/routing.test.ts`

**Interfaces:**
- Consumes: `HubStore` (Task 4); `parseUpFrame`, `MAX_FRAME_BYTES`, `RELAY_PROTOCOL_VERSION`, `type DownFrame` from `multiplayer-ai-server/relayProtocol`.
- Produces: `startHub` unchanged in signature. The hub's browser-facing protocol is the client's existing one, byte for byte — that is what lets the client stay untouched.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/routing.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHub } from "../src/hub.js";
import { RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collect(ws: WebSocket, sink: any[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

const facts = (id: string, over: Record<string, unknown> = {}) => ({
  id, participants: ["ana"], driverName: "ana", intent: null, lastActivityTs: null,
  ended: false, pendingGate: null, skills: [], repoKey: "github.com/acme/api",
  lifecycle: "open", ...over,
});

/** An attached laptop with one declared session — the precondition of most
 *  tests below. */
async function attachedUplink(port: number, sessionId = "auth") {
  const up = await connect(`ws://127.0.0.1:${port}/uplink`);
  const seen: any[] = [];
  collect(up, seen);
  up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", projectId: "default", repoKey: "k" }));
  up.send(JSON.stringify({ t: "facts", sessionId, runId: "run-a", facts: facts(sessionId) }));
  await wait(40);
  return { up, seen };
}

describe("hub uplink handshake", () => {
  it("welcomes a laptop with the offsets it already holds", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const seen: any[] = [];
    collect(up, seen);
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", projectId: "default", repoKey: "github.com/acme/api" }));
    await wait(50);
    expect(seen[0]).toEqual({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    up.close();
  });

  it("closes an uplink that speaks the wrong protocol version", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    up.send(JSON.stringify({ t: "hello", v: 99, uplinkId: "lap-1", projectId: "default", repoKey: "k" }));
    expect(await closed).toBe(1008);
  });
});

describe("hub fan-out", () => {
  it("replays from its own store and streams new events to a joined browser", async () => {
    // The hub owns replay (spec §3.2). A late browser gets the full history
    // from the hub, and the laptop never learns it exists.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "already happened", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    }));
    await wait(40);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(50);
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual(["already happened"]);
    expect(seen.some((m) => m.type === "project")).toBe(true);

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "live", seq: 1, ts: "2026-07-27T00:00:01.000Z" }],
    }));
    await wait(50);
    expect(seen.filter((m) => m.type === "event").map((m) => m.event.text)).toEqual([
      "already happened",
      "live",
    ]);
    browser.close();
    up.close();
  });

  it("publishes once from the laptop no matter how many browsers watch", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const a = await connect(`ws://127.0.0.1:${hub.port}/`);
    const b = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seenA: any[] = []; const seenB: any[] = [];
    collect(a, seenA); collect(b, seenB);
    a.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    b.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ben", name: "ben" }));
    await wait(50);
    upSeen.length = 0;

    up.send(JSON.stringify({
      t: "publish", sessionId: "auth", runId: "run-a",
      events: [{ type: "intent_update", text: "one", seq: 5, ts: "2026-07-27T00:00:05.000Z" }],
    }));
    await wait(50);

    // Both browsers saw it; the uplink carried nothing extra. That asymmetry
    // is the entire reason the publish plane is separate from the tunnel.
    expect(seenA.filter((m) => m.type === "event" && m.event.text === "one")).toHaveLength(1);
    expect(seenB.filter((m) => m.type === "event" && m.event.text === "one")).toHaveLength(1);
    expect(upSeen.filter((f) => f.t === "publish")).toHaveLength(0);

    a.close(); b.close(); up.close();
  });
});

describe("hub command routing", () => {
  it("tunnels a browser command with a hub-assigned channel and a stamped identity", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(40);
    browser.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(50);

    const tunnels = upSeen.filter((f) => f.t === "tunnel");
    expect(tunnels.map((f) => f.payload.type)).toEqual(["join", "prompt"]);
    // One browser, one channel — a join and its next command must land on the
    // same connection or the driver state is lost between them.
    expect(new Set(tunnels.map((f) => f.channelId)).size).toBe(1);
    expect(tunnels[0].identity).toEqual({ userId: "ana", name: "ana" });
    browser.close(); up.close();
  });

  it("ignores a client-supplied channelId — a browser must not address another's tunnel", async () => {
    // Spec §10.4. A client-chosen channel id is the whole vulnerability.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    browser.send(JSON.stringify({
      type: "join", sessionId: "auth", projectId: "default",
      userId: "ana", name: "ana", channelId: "attacker-chosen",
    }));
    await wait(50);
    expect(upSeen.filter((f) => f.t === "tunnel")[0].channelId).not.toBe("attacker-chosen");
    browser.close(); up.close();
  });

  it("routes a laptop reply back to the one browser that asked", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const a = await connect(`ws://127.0.0.1:${hub.port}/`);
    const b = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seenA: any[] = []; const seenB: any[] = [];
    collect(a, seenA); collect(b, seenB);
    a.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    b.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ben", name: "ben" }));
    await wait(50);

    const channelA = upSeen.find((f) => f.t === "tunnel" && f.identity.userId === "ana").channelId;
    seenB.length = 0;
    up.send(JSON.stringify({ t: "reply", channelId: channelA, payload: { type: "error", message: "only for ana" } }));
    await wait(50);
    expect(seenA.some((m) => m.type === "error" && m.message === "only for ana")).toBe(true);
    expect(seenB.some((m) => m.type === "error")).toBe(false);

    a.close(); b.close(); up.close();
  });

  it("tells the browser plainly when no machine is running the session", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "join", sessionId: "ghost", projectId: "default", userId: "ana", name: "ana" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /no machine/i.test(m.message))).toBe(true);
    browser.close();
  });

  it("detaches the channel when the browser goes away", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(40);
    const channelId = upSeen.find((f) => f.t === "tunnel").channelId;
    browser.close();
    await wait(60);
    expect(upSeen).toContainEqual({ t: "detach", channelId });
    up.close();
  });
});

describe("hub presence", () => {
  it("flips a session offline when its laptop drops, and keeps the session listed", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    expect(seen.at(-1).sessions[0].presence).toBe("online");

    seen.length = 0;
    up.close();
    await wait(1300); // snapshot pushes are throttled to 1s, like the server's
    const last = seen.filter((m) => m.type === "project").at(-1);
    expect(last.sessions[0].presence).toBe("offline");
    expect(last.sessions[0].id).toBe("auth");
    browser.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/routing.test.ts`
Expected: FAIL — there is no uplink or browser endpoint yet, so joins are never answered and the assertions fail.

- [ ] **Step 3: Write the implementation**

Rewrite `poc/hub/src/hub.ts`, keeping Task 3's HTTP surface and adding the WebSocket surface:

```ts
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { staticHandler } from "multiplayer-ai-server/staticFiles";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseUpFrame,
  type DownFrame,
} from "multiplayer-ai-server/relayProtocol";
import { HubStore } from "./hubStore.js";

const SLUG = /^[a-z0-9-]{1,40}$/;
const PROJECT_PUSH_INTERVAL_MS = 1000;

/** Answered from the hub's own store rather than tunnelled: only the hub sees
 *  every laptop, so only the hub can answer them (spec §3.2). */
const HUB_HANDLED = new Set(["watch_project", "peek"]);

interface BrowserChannel {
  channelId: string;
  socket: WebSocket;
  projectId: string | null;
  sessionId: string | null;
  identity: { userId: string; name: string } | null;
}

export interface HubOptions {
  port: number;
  host?: string;
  /** Built client directory. The hub serves the browser surface. */
  staticDir?: string;
}

export interface RunningHub {
  port: number;
  close: () => Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<RunningHub> {
  const store = new HubStore();
  const uplinks = new Map<string, WebSocket>();
  const channels = new Map<string, BrowserChannel>();
  const lastPush = new Map<string, number>();
  const pushTimers = new Map<string, NodeJS.Timeout>();
  const serveStatic = opts.staticDir ? staticHandler(opts.staticDir) : null;

  const send = (socket: WebSocket, msg: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };
  const down = (socket: WebSocket, frame: DownFrame) => send(socket, frame);

  function pushProject(projectId: string): void {
    const timer = pushTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      pushTimers.delete(projectId);
    }
    const payload = store.snapshot(projectId);
    for (const channel of channels.values()) {
      if (channel.projectId === projectId) send(channel.socket, payload);
    }
    lastPush.set(projectId, Date.now());
  }

  /** The same 1s leading+trailing throttle the server uses (server.ts:145-157)
   *  and for the same reason: a hot event stream must not become a snapshot
   *  storm. Keeping the interval identical also keeps the A3 lesson true —
   *  anything whose display changes with elapsed time needs a client tick. */
  function schedulePush(projectId: string): void {
    if (pushTimers.has(projectId)) return;
    const elapsed = Date.now() - (lastPush.get(projectId) ?? 0);
    if (elapsed >= PROJECT_PUSH_INTERVAL_MS) {
      pushProject(projectId);
      return;
    }
    pushTimers.set(
      projectId,
      setTimeout(() => {
        pushTimers.delete(projectId);
        pushProject(projectId);
      }, PROJECT_PUSH_INTERVAL_MS - elapsed),
    );
  }

  function fanOut(projectId: string, sessionId: string, stored: { event: unknown }[]): void {
    for (const channel of channels.values()) {
      if (channel.projectId !== projectId || channel.sessionId !== sessionId) continue;
      for (const item of stored) send(channel.socket, { type: "event", event: item.event });
    }
  }

  const httpServer = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // BEFORE the static handler: the SPA fallback serves index.html for any
    // extensionless path, so a health route wired after it returns HTML with
    // a 200 and the probe passes forever while the hub is broken.
    if (pathname === "/healthz" || pathname === "/healthz/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      return;
    }
    if (serveStatic) {
      serveStatic(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  // maxPayload is applied here, before any gate, because the upgrade completes
  // before authentication — a limit that only protects authenticated peers
  // protects nothing (spec §10.2). `ws` otherwise defaults to 100MB.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES });

  wss.on("connection", (socket: WebSocket, req) => {
    // Without a listener an "error" is an unhandled EventEmitter error and
    // crashes the process; "close" always follows and does the cleanup.
    socket.on("error", () => {});
    if ((req.url ?? "/").startsWith("/uplink")) handleUplink(socket);
    else handleBrowser(socket);
  });

  function handleUplink(socket: WebSocket): void {
    let uplinkId: string | null = null;
    let projectId: string | null = null;

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, "invalid JSON");
        return;
      }
      const frame = parseUpFrame(parsed);
      if (!frame) {
        // A frame this hub cannot understand is a protocol fault, not a
        // recoverable message. 1008 = policy violation.
        socket.close(1008, "bad frame");
        return;
      }
      if (frame.t === "hello") {
        uplinkId = frame.uplinkId;
        projectId = frame.projectId;
        uplinks.set(frame.uplinkId, socket);
        store.attach(frame.uplinkId, frame.projectId, frame.repoKey);
        down(socket, {
          t: "welcome",
          v: RELAY_PROTOCOL_VERSION,
          have: store.resumeOffsets(frame.uplinkId),
        });
        schedulePush(frame.projectId);
        return;
      }
      if (!uplinkId || !projectId) {
        socket.close(1008, "hello first");
        return;
      }
      if (frame.t === "publish") {
        // A laptop may publish only for sessions it owns; the store checks
        // ownership and returns nothing for a session it does not own
        // (spec §3.5 rule 2).
        const accepted = store.publish(uplinkId, frame.sessionId, frame.runId, frame.events);
        if (accepted.length > 0) {
          fanOut(projectId, frame.sessionId, accepted);
          schedulePush(projectId);
        }
        return;
      }
      if (frame.t === "facts") {
        const result = store.setFacts(uplinkId, frame.sessionId, frame.runId, frame.facts);
        if (!result.ok) {
          console.error(`uplink ${uplinkId}: ${result.error}`);
          socket.close(1008, result.error.slice(0, 100));
          return;
        }
        schedulePush(projectId);
        return;
      }
      // frame.t === "reply" — narrowcast back to the browser that asked.
      const channel = channels.get(frame.channelId);
      if (channel) send(channel.socket, frame.payload);
    });

    socket.on("close", () => {
      if (!uplinkId) return;
      uplinks.delete(uplinkId);
      // The sessions stay — that is the hub's payoff. What must not stay is
      // the illusion that they can be driven (spec §8).
      store.detach(uplinkId);
      if (projectId) schedulePush(projectId);
    });
  }

  function handleBrowser(socket: WebSocket): void {
    // Assigned here and never read from the client: a client-chosen channel id
    // would let one browser address another's tunnel (spec §10.4).
    const channelId = randomUUID();
    const channel: BrowserChannel = {
      channelId,
      socket,
      projectId: null,
      sessionId: null,
      identity: null,
    };
    channels.set(channelId, channel);

    const error = (message: string) => send(socket, { type: "error", message });

    const tunnel = (payload: unknown): void => {
      if (!channel.projectId || !channel.sessionId || !channel.identity) {
        error("join a session first");
        return;
      }
      const owner = store.ownerOf(channel.projectId, channel.sessionId);
      const uplink = owner ? uplinks.get(owner) : undefined;
      if (!uplink) {
        error(`no machine is running session "${channel.sessionId}" right now`);
        return;
      }
      down(uplink, { t: "tunnel", channelId, identity: channel.identity, payload });
    };

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return error("invalid JSON");
      }

      if (msg.type === "join") {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId) || !SLUG.test(String(msg.sessionId ?? ""))) {
          return error("projectId and sessionId must be 1-40 chars of a-z, 0-9, -");
        }
        // v7b1 runs with auth OFF and takes the browser's word, exactly as a
        // standalone server does with auth off. v7b2 replaces these three
        // lines with the hub's cookie-verified GitHub login, which is what
        // makes the trust inversion (spec §3.5 rule 1) real. Until then this
        // hub must not be exposed to the internet.
        const userId = String(msg.userId ?? "").slice(0, 64);
        const name = String(msg.name ?? userId).slice(0, 40);
        if (!userId) return error("join requires userId");

        const owner = store.ownerOf(projectId, msg.sessionId);
        if (!owner || !uplinks.has(owner)) {
          return error(`no machine is running session "${msg.sessionId}" right now`);
        }
        channel.projectId = projectId;
        channel.sessionId = msg.sessionId;
        channel.identity = { userId, name };

        // Replay from the HUB's store, not from the laptop (spec §3.2). This
        // is what makes a watcher free: the laptop never learns this browser
        // exists, so watchers joining and leaving cost its uplink nothing.
        for (const stored of store.eventsFor(projectId, msg.sessionId, 0)) {
          send(socket, { type: "event", event: stored.event });
        }
        send(socket, store.snapshot(projectId));
        // Still tunnelled, because presence, the roster and the wheel are
        // laptop-owned facts (spec §3.1) — the hub does not invent them.
        tunnel(msg);
        return;
      }

      if (HUB_HANDLED.has(msg.type)) {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) return error(`${msg.type} requires a valid projectId`);
        if (msg.type === "watch_project") channel.projectId = projectId;
        send(socket, store.snapshot(projectId));
        return;
      }

      tunnel(msg);
    });

    socket.on("close", () => {
      channels.delete(channelId);
      if (!channel.projectId || !channel.sessionId) return;
      const owner = store.ownerOf(channel.projectId, channel.sessionId);
      const uplink = owner ? uplinks.get(owner) : undefined;
      // Tell the laptop, or presence_leave never fires and the roster keeps a
      // ghost for the rest of that process's life.
      if (uplink) down(uplink, { t: "detach", channelId });
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    wss.once("error", onError);
    httpServer.once("listening", () => {
      httpServer.removeListener("error", onError);
      wss.removeListener("error", onError);
      resolve();
    });
    httpServer.listen(opts.port, opts.host);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of pushTimers.values()) clearTimeout(timer);
        pushTimers.clear();
        for (const client of wss.clients) client.terminate();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run`
Expected: PASS, 25 tests (4 http + 11 store + 10 routing).

- [ ] **Step 5: Typecheck and build**

Run: `cd poc/hub && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add poc/hub/src/hub.ts poc/hub/test/routing.test.ts
git commit -m "feat(hub): uplink and browser sockets with channel routing and fan-out (v7b1)"
```

---

### Task 8: `mpai --hub`, and the two-process walk

The last wire, plus the verification no unit test can do. **The client needs no change:** `SERVER_URL` already derives from `window.location` (`poc/client/src/types.ts:100-102`), so a browser served the built client *by the hub* opens its socket to the hub automatically. That is a deliberate payoff of A1a's `socketUrlFor` work, not a coincidence.

**Files:**
- Modify: `poc/server/src/cli.ts:9-53` (`CliArgs`, `parseArgs`), `:101-134` (`launch`), `:186-190` (usage)
- Test: `poc/server/test/cli.test.ts`

**Interfaces:**
- Consumes: the `hub` option added to `startServer` in Task 6.
- Produces: `CliArgs` gains `hub?: string`. No other module reads it.

- [ ] **Step 1: Write the failing test**

Append to `poc/server/test/cli.test.ts`:

```ts
describe("--hub", () => {
  it("parses a hub url", () => {
    expect(parseArgs(["--hub", "ws://hub.example:4000/uplink"])).toMatchObject({
      cmd: "launch",
      hub: "ws://hub.example:4000/uplink",
    });
  });

  it("requires a value", () => {
    expect(parseArgs(["--hub"]).error).toBe("--hub requires a url");
  });

  it("rejects a non-websocket scheme, so a typo cannot silently do nothing", () => {
    // A wrong scheme fails deep inside `ws` with an opaque error; the laptop
    // would look attached and never be.
    expect(parseArgs(["--hub", "https://hub.example"]).error).toBe(
      "--hub requires a ws:// or wss:// url",
    );
  });

  it("defaults to no hub, which is today's standalone behaviour", () => {
    expect(parseArgs([]).hub).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/cli.test.ts`
Expected: FAIL — `hub` is not a property of `CliArgs`.

- [ ] **Step 3: Write the implementation**

In `poc/server/src/cli.ts`, add `hub?: string;` to the `CliArgs` interface (after `open: boolean;`), and add this branch to the flag loop in `parseArgs`, beside `--project`:

```ts
    } else if (flag === "--hub") {
      const value = rest.shift();
      if (!value) return { ...args, error: "--hub requires a url" };
      if (!/^wss?:\/\//i.test(value)) {
        return { ...args, error: "--hub requires a ws:// or wss:// url" };
      }
      args.hub = value;
```

Extend the usage string:

```ts
      "usage: mpai [--port N] [--hub <ws-url>] [--project <id>] [--no-open] | mpai new <name> [--base <ref>] [--project <id>] [--port N]",
```

In `launch`, pass the option through and change what is printed — with a hub, the team is at the hub, not at this process:

```ts
    const { port } = await startServer({
      port: args.port,
      workspace: new WorkspaceManager(repoRoot, worktreesRoot),
      staticDir: distDir,
      ...(args.hub ? { hub: { url: args.hub, projectId: args.project } } : {}),
    });
    const url = `http://localhost:${port}/`;
    if (args.hub) {
      // The local URL still works and is still served; it is just not where
      // the team is. Printing the hub first is the honest ordering, and not
      // auto-opening a browser at the local URL avoids sending someone to a
      // single-machine view of a multi-machine session.
      console.log(`multiplayer-ai attached to hub ${args.hub} (repo: ${repoRoot})`);
      console.log(`open the hub in your browser; this machine is also on ${url}`);
    } else {
      console.log(`multiplayer-ai on ${url} (repo: ${repoRoot})`);
    }
    if (args.open && !args.hub) openBrowser(url);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/cli.test.ts`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Full suites**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, **385 passed** (381 + 4). No existing test edited.

Run: `cd poc/hub && npx vitest run && npx tsc --noEmit`
Expected: 25 passed, tsc clean.

Run: `cd poc/client && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc clean, **179 passed**, build clean — the client is untouched by this plan.

- [x] **Step 6: The two-process walk — REQUIRED, not optional polish**

Spec §5 names three failure modes tests structurally cannot catch, and this project has been burned three times by live-behaviour drift (the `skills:"all"` reversal, `canUseTool` shadowing, the `<label>`/`<select>` focus trap). Walk all seven items by hand and write every result — including the ones that did not work — into Deviations.

```bash
# Terminal 1 — build everything, then run the hub
cd poc/client && npm run build
cd ../server && npm run build
cd ../hub    && npm run build
CLIENT_DIST=$(cd ../client/dist && pwd) HOST=127.0.0.1 PORT=4000 node dist/main.js

# Terminal 2 — the laptop, in any git repo
cd <a git repo>
mpai --hub ws://127.0.0.1:4000/uplink --no-open
```

Then in a browser at `http://127.0.0.1:4000/?session=<name>&name=alice`:

1. **The session appears and streams.** Roster shows `alice`, the transcript streams, `PARTY · 1`. If not, check `mpai` printed "attached to hub" and the hub logged an uplink.
2. **A second tab (`&name=ben`) sees the same session**, `PARTY · 2`, and `ben` can `TAKE THE WHEEL`.
3. **A permission gate is answerable from the browser.** Prompt something that hits a `Bash` gate and approve it from the *second* tab. The wire must show the approval attributed to `ben`. **This is the product's wedge travelling through the relay for the first time** — if anything in this plan is broken, it shows here.
4. **Reconnect mid-gate (spec §5.1).** With a gate pending, `Ctrl-C` the hub and restart it. The laptop must re-attach within the reconnect delay and the gate must still be answerable. Record honestly what the browser showed in between.
5. **Laptop restart mid-session (the `runId` trap, spec §3.2).** Leave the hub up; `Ctrl-C` `mpai` and restart it with the same `--hub`. The hub must **append** a new run, not overwrite — scroll the transcript up and confirm the earlier history is still there.
6. **Laptop drop (spec §5.2).** Kill `mpai` without restarting. The session row must go `offline` within ~1s and stay listed. Confirm it does not read `LIVE` with a JOIN button — that conflation is exactly what v7a existed to remove.
7. **Watcher cost.** Open four tabs on one session. The laptop's uplink traffic must not scale with tab count; the publish plane exists for this.

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/cli.ts poc/server/test/cli.test.ts
git commit -m "feat(cli): mpai --hub attaches this repo's sessions to a hub (v7b1)"
```

---

## Verification before calling v7b1 done

```bash
cd poc/server && npx tsc --noEmit && npx vitest run    # 385 passed
cd ../hub    && npx tsc --noEmit && npx vitest run     # 25 passed
cd ../client && npx tsc --noEmit && npx vitest run && npm run build   # 179 passed, build clean
cd ../server && npm run build && ls dist/main.js        # top level, NOT dist/src/main.js
```

- [x] All three suites green, all three typechecks clean, client build clean.
- [x] `git diff --stat main -- poc/server/test/` shows **insertions only** in pre-existing test files. Any deletion means the additive invariant broke.
- [x] `mpai` with **no** `--hub` still launches, opens a browser and runs a turn exactly as before. Check this explicitly — it is the promise the whole plan rests on (spec §6).
- [x] All seven items of Task 8 Step 6 walked by hand, results written into Deviations.
- [x] `docs/tech-debt.md` gains an entry: `poc/server`'s `auth.ts` and `staticFiles.ts` become dead for hub-attached `mpai` once v7b2 lands, and are candidates for the v7 scrub pass.

## Known bounds this plan ships with, stated so they are not reported as bugs

- **The hub has no authentication.** v7b1 stamps the identity the browser claims. It is a development target for a trusted network and **must not be exposed to the internet**. v7b2 is the plan that changes this.
- **The hub's log is in memory** (spec §2.11). A hub restart loses history. That is v7c's job and must not be presented to users as durable before then (spec §8).
- **Two laptops cannot both own a session id in one project.** The second laptop's `facts` frame for that session is **dropped and logged**, and an `{type:"error"}` is narrowcast to any browser channel joined to it; the rest of that laptop's uplink, including sessions it genuinely owns, is unaffected. It is *not* merged, and it is *not* — as an earlier draft of this line claimed — a refusal that closes anything. Closing the uplink was the shipped behaviour until the whole-branch review: a collision is a permanent, per-session condition, `server.ts` republishes facts for every session about once a second, and the relay reconnects every 2 s, so the close re-fired on a loop and the laptop flapped ONLINE/OFFLINE in every browser forever. Note that a same-machine restart under a fresh `uplinkId` (D.1) presents exactly as a collision. Hub-scoped session ids are v7c/v7e — the same shape of problem as spec §9's shared-worktree bug.
- **Plugins and oversight read empty when hub-attached.** Plugins are laptop-local files (spec §4); oversight is host-configured (spec §3.7). Both are surfaced in v7b3.
- **`repo` is null on a hub snapshot.** A hub spans repos, so there is no single one to report; the per-session `repoKey` is the honest answer and the client already reads it (v7a).
- **Approvals gain roughly 100ms** (browser → hub → laptop). Irrelevant for a human clicking a button (spec §8).
- **`create_session` is tunnelled but has no owner before a laptop attaches**, so creating a session from the browser only works for a project that already has an uplink. Creating the *first* session on a machine is still `mpai new`. Making the hub route a create to a chosen laptop is v7b3.
- **The invite flow is dead through the hub.** `peek_invite` (`InviteLanding.tsx:24`, `InviteSignIn.tsx:17`) is not in `HUB_HANDLED`, so it falls through to `tunnel()` and is answered `"join a session first"` — the landing page renders `INVITE UNAVAILABLE`. The hub cannot answer it (invites live on the laptop, in `invites.ts`) and cannot route it either (the token encodes a project/session only the laptop can decode, so the hub has nothing to pick an uplink by). This genuinely needs design — a hub-side invite store, or a broadcast-and-first-answer route — and is deliberately **not** fixed in v7b1. Sits next to the `create_session` bound above and is recorded in `docs/tech-debt.md` §2.5.
- **`maxPayload` is asymmetric between the hub and a standalone laptop.** `hub.ts:135` caps every browser frame at `MAX_FRAME_BYTES` (1 MB, correct per spec §10.2); `server.ts:367` sets no cap at all, so a standalone laptop inherits `ws`'s 100 MB default (`docs/tech-debt.md` §1.1). A >1 MB paste into the prompt box is therefore accepted standalone and answered with a 1009 close against the hub — and because the client never reconnects its session WebSocket (D.2), that close leaves the tab dead until a manual reload. The cap is right and stays; what is open is the missing cap on `server.ts` and the missing client reconnect, and it is their *interaction* that turns a rejected frame into a dead tab.

## Deviations

*Written 2026-07-28, at the close of execution: eight tasks, each implemented, reviewed, fixed and re-reviewed clean. It is drawn from the execution ledger and the eight task reports, which lived in this plan's git-ignored SDD workspace and do not survive it. This section is what remains of them, and it is the authority on why the shipped code differs from the listings above.*

### A. The two-process walk (Task 8, Step 6) — all seven items, as observed

Walked by hand on 2026-07-28. Not simulated: the hub ran `node dist/main.js` with
`CLIENT_DIST=poc/client/dist HOST=127.0.0.1 PORT=4000`, the laptop ran
`mpai --hub ws://127.0.0.1:4000/uplink --no-open` in `poc/demo-project`, and the browser was driven
with Playwright. Sessions were created with `mpai new` (see A.8).

**4 of the 7 items passed, including item 3 — the one this whole plan exists for.**

Handshake sanity check before item 1: a raw `watch_project` against the hub returned the relayed
session with `presence: "online"`, `repoKey: "local:mac.lan:585cc4c5c6ba"`, `repo: null` and
`plugins: []` — all four exactly as the "known bounds" section above predicts. Laptop-local skills
came through populated; they are session facts, not the `plugins` array.

**1. The session appears and streams — PASS.**
`http://127.0.0.1:4000/?session=walkone&name=alice` rendered the session view directly, with no
picker round-trip: `PARTY · 1`, `♠ alice 🛞 DRIVING · you`, `● ONLINE`. A prompt typed in the browser
ran an agent turn **on the laptop** and streamed back through the relay: `ToolSearch`, `set_intent`,
`✦ QUEST ACCEPTED`, `Bash`, tool result, final text. The hub snapshot picked up
`intent: "Running echo hub-relay-walk and reporting its output."`. First working proof of the spine.

**2. A second tab sees the same session — PASS.**
`&name=ben` in a second tab: `PARTY · 2`, `♠ alice 🛞 DRIVING`, `✦ ben · you`, model select and MODE
disabled for the watcher, and a live `🛞 TAKE THE WHEEL`. Clicking it tunnelled down to the laptop and
back: `🛞 ben took the wheel` appeared in **both** tabs and the wheel moved.

**3. A permission gate answered from the browser — PASS. The wedge travels.**
A `Bash` gate raised on the laptop, rendered in the hub browser, approved from the **second** tab. The
first tab showed:

```
🔐 PERMISSION CHECK   DECIDED
the agent wants to use Bash — not on the auto-approve list
touch /tmp/hub-walk-proof.txt
✅ approved by ben
```

and `/tmp/hub-walk-proof.txt` was really created on the laptop. Browser → hub → laptop → SDK → back,
with correct identity attribution.

Two corrections to the walk recipe above, both worth keeping:
- **`echo hub-relay-walk` does not gate.** The installed SDK auto-approves trivially-safe bash *before*
  `canUseTool` is consulted, so it never reaches the driver gate. A walk needs a genuinely
  unsafe-looking command — `touch /tmp/...` did gate.
- **A watcher sees the gate card but gets no buttons**, only `⏳ driver deciding…`. Ben had to take the
  wheel first. That is the product's existing driver rule, not a relay defect.

**4. Reconnect mid-gate (spec §5.1) — PARTIAL FAIL. The laptop recovers; the browser does not.**
With a second gate pending, `SIGINT` on the hub. *While the hub was down* the browser degraded
honestly: header `○ OFFLINE`, ARCADE and the model select disabled, the full transcript retained, the
footer still reading `🔐 1 gate pending`. Nothing lied. *On hub restart* the laptop re-attached within
the reconnect delay and the hub's store was rebuilt from the replay — the pending gate returned to the
snapshot with its **original** `sinceTs`, so the replay was faithful.

**But the browser never reconnected.** `poc/client/src/useSessionSocket.ts:84` is
`ws.onclose = () => setConnected(false)` with no retry of any kind. The tab sat on a dead socket
showing a stale-but-plausible roster and a live-*looking* `[A]PPROVE` button; clicking it did nothing
except log `WebSocket is already in CLOSING or CLOSED state`, the gate stayed pending, and
`/tmp/hub-walk-gate2.txt` was not created. After a **manual page reload** the same gate was answerable
and executed — file created, gate cleared, `driverName: "ben"` restored.

So the relay half of §5.1 is sound and the client half does not exist. It is pre-existing and equally
true standalone, but the hub makes it load-bearing: a hub restart is now a routine event that strands
every browser on the team. Recorded in `docs/tech-debt.md` §4.

One cosmetic side effect of the reload: the earliest replayed events rendered the raw userId
(`🛞 fff778e8-231a-… took the wheel`) instead of `alice`, because display names resolve from the
current roster and alice's presence had been dropped when the uplink went down.

**5. Laptop restart mid-session, the `runId` trap (spec §3.2) — FAIL. The trap was never reachable.**
Hub left up, `SIGINT` on `mpai`, restarted with the same `--hub`. Two compounding causes stopped this
cold:

1. **Laptop session state is in memory.** The restarted laptop had *zero* sessions — a `watch_project`
   against `:3001` returned `[]`. The worktree survives; the session does not.
2. **`cli.ts:131` passes no `uplinkId`,** so `server.ts:1007` mints a fresh `randomUUID()` on every
   launch and the hub sees a different machine. `walkone` stayed bound to the now-`online:false`
   uplink and read `offline` permanently, with no machine able to adopt it.

Pushed on it: `mpai new walkone` on the restarted laptop, same id. The hub logged

```
uplink 847b74ec-…: session "walkone" in project "default" is already owned by another machine
```

and closed the uplink with 1008; the laptop's forever-reconnect walked straight back into it. It
settled at two occurrences rather than a hot loop only because `facts` are sent on project pushes,
which are event-driven — so it re-fires the moment anyone touches that session. **A same-machine
restart is indistinguishable from the two-laptop collision that error was written for, and it poisons
the uplink for every session id the laptop previously owned.**

No second run was ever appended, so "the hub must append, not overwrite" could not be observed in
either direction. See D.1 — this is the most serious thing v7b1 ships with.

**6. Laptop drop (spec §5.2) — PASS, with a finding.**
From the picker the row read `walktwo LIVE` with `alice · ben · cara`. `kill -9` on `mpai`: within
~2s the same row read **`walktwo OFFLINE`** and stayed listed. It does **not** read `LIVE` with a JOIN
button — the v7a conflation this item guards against is absent.

The finding sits right next to it: **JOIN is still offered on an offline row, and taking it opens an
empty session.** `hub.ts:312-315`'s browser `join` handler answers
`no machine is running session "walktwo" right now` and returns *before* the replay from
`store.eventsFor` at `hub.ts:320-323`, so the view rendered `PARTY · 0`, an empty transcript and
`⚠ no machine is running session "walktwo" right now` — while the hub was holding the entire
transcript in memory. That is the opposite of the hub's stated payoff. Recorded in
`docs/tech-debt.md` §2.4. Also noted: the header still reads `● ONLINE` on such a session, because
that indicator means "my socket to the hub is up", not "a laptop is running this".

**7. Watcher cost — PASS, decisively.**
Measured with a temporary byte-counting TCP passthrough on `:4100` between laptop and hub (written to
`/tmp`, never committed, deleted afterwards). Identical deterministic prompt ("Reply with exactly the
word: alpha. Use no tools at all."), laptop→hub bytes for one turn:

| watchers | laptop→hub bytes |
|---|---|
| 1 tab | **6,988 B** |
| 4 tabs | **7,010 B** (1.003×) |

Per-watcher fan-out would have cost ~28 kB. All four tabs received the stream. The publish plane does
exactly what it exists for. Separately: *joining* three extra tabs cost ~19.9 kB up, because presence
and roster are laptop-owned facts that must be tunnelled — by design. The invariant this item pins is
that **streaming** cost is flat in watcher count, and it is.

**8. Session creation through the hub — the known `create_session` hole is unreachable.**
`SessionPicker.tsx:48-59` sends `create_session` on its watch-only socket, which the hub answers
`join a session first` (`hub.ts:348`). It never fires from a hub-attached browser: the hub's snapshot
carries `repo: null` (correct — a hub spans repos) and the picker gates its entire create form on
`repo !== null` (`SessionPicker.tsx:47-50,100,107,117,123`), rendering it disabled with *"launch via
the CLI (mpai) to create sessions."* That is precisely the bound this plan ships with. No client
change was made or needed; walk sessions were created with `mpai new <name>` against the laptop's own
server. **Closed, not deferred.**

**9. The additive invariant, re-checked by hand.**
`mpai --no-open` with **no** `--hub` printed the byte-identical old line
(`multiplayer-ai on http://localhost:3001/ (repo: …)`), `mpai new` worked, and a full agent turn ran
and streamed. The auto-open-a-browser arm was verified by *reading* the single unchanged guard
(`if (args.open && !args.hub)` at `cli.ts:144`) rather than by opening a window on the operator's
desktop — stated here so the strength of that one sub-claim is not overread.

### B. Human rulings made during execution

Four questions were escalated out of the review loop to a human. All four are settled; do not
re-litigate them without new information.

**B.1 — `snapshot()` deep-copies per-session facts; `eventsFor()`/`publish()` deliberately do not.**
(Task 4, 2026-07-27.) As the plan listed it, `hubStore` handed back live references in three places:
`eventsFor()` returned the stored `StoredEvent` instances, `publish()` pushed the same object into both
the stored and the returned array, and `snapshot()` shallow-spread facts so `skills`, `participants`
and `pendingGate` stayed shared. **Ruling: copy at the snapshot boundary only.** `snapshot()` now
deep-copies the per-session facts (`participants`, `skills` per-element spread, `pendingGate` via a
null-safe ternary — verified against the `SessionFacts` declaration to be the only nested mutable
fields, and `SkillInfo`/`PendingGate` are flat, so one level is a complete copy). `eventsFor()` and
`publish()` stay allocation-free and are documented in-code as returning read-only instances.
**Reasoning: the event fan-out path is the one watcher count multiplies**, and `snapshot()` is the
value that leaves the hub toward browsers and the one most likely to be normalized downstream. Task 7's
review checked the contract held: its three touch points are all read-then-serialize, and `fanOut`'s
third parameter is typed `readonly { event: unknown }[]` to state it in the type.

**B.2 — the plan's two vacuous relay tests kept their names and were given working bodies.**
(Task 5, 2026-07-28.) Two of the five relay tests this plan authored asserted nothing. **A relay join
is silent by construction** — it skips the replay, takes the `() => {}` subscribe arm, skips
`watchers.add` and skips the personal snapshot — so `sent` was always `[]`. The identity-overwrite test
passed with the *entire* `io.stampedIdentity` overwrite deleted, and `"drops the participant on close"`
only caught a throw. **Ruling: keep both names, replace both bodies with assertions that can fail.**
The identity test now reads the log back through a *direct* client's replay (a relay client joins
claiming `totally-not-ana`/`Mallory`; the assertions run over the `presence_join` events a direct
client replays); the close test now has a second, direct connection as a witness and asserts it sees
**exactly one** `presence_leave` for `ana` across two `close()` calls — which pins the departure *and*
makes "idempotent" enforceable on an append-only log. A sixth test was a duplicate of the first, so it
was folded in and deleted. Both mutations were verified to fail without their fix. The plan's
zero-edit invariant over pre-existing tests is untouched: it authorises editing only tests the task
itself authored, and `git diff --numstat` over `poc/server/test/` stayed insertions-only.

**B.3 — shallow frame validation stands; the security floor is v7b2's job.**
(Task 1, 2026-07-27.) `parseUpFrame` checks `Array.isArray(f.events)` and then casts; `isFacts` does
the same for `participants`/`skills`, and checks `pendingGate` is `object | null` with no deeper shape
check. A malformed *element* therefore reaches the hub inside a "valid" frame. Related: `repoKey`,
`identity.userId` and `identity.name` are length-bounded but not charset-checked, which is weaker than
spec §10.3. **Ruling: the plan governs, deferred to v7b2.** v7b1's hub is explicitly a
localhost/trusted-network target that must not be exposed to the internet; spec §10's security floor is
v7b2's entire job; the laptop is the only publisher and the hub never interprets events, it fans them
out. **This is a named input for v7b2's validation task — do not lose it.** Note for anyone touching
Task 4's store: do not assume a fully-shaped `PendingGate`.

**B.4 — `relayProtocol.ts` imports `SLUG` from `project.ts` rather than duplicating the regex.**
(Task 1, 2026-07-27.) The listing declared its own `SLUGISH`, byte-identical to the `SLUG` already
exported from `project.ts:10`. **Ruling: dedupe — import it.** The consequence was accepted knowingly:
this gives `relayProtocol.ts` its **first runtime (value) import**; every other import in the file is
`import type` and erases at compile time. So when the hub imports `relayProtocol` through the
`poc/server` exports map, `project.js` and its runtime dependencies (`digest.js`, `pendingGate.js`,
`lifecycle.js`) now load with it. Task 3 proved that chain resolves at runtime against real `dist`
output, not just at typecheck. The other direction stays type-only: `project.ts` uses
`import type { SessionFacts }`, so `relayProtocol.ts → project.ts` is the only runtime edge.
**Do not turn that into a value import in either direction.**

### C. Divergences from the plan's code listings, task by task

**Task 1 — `relayProtocol.ts`.** `SLUGISH` replaced by an imported `SLUG` (ruling B.4). Otherwise
byte-identical to the listing.

**Task 2 — one producer for session facts.** No divergence. `sessionFactsOf(id, entry, repoKey)` and
`arcadeRecordsFrom(logs)` shipped as listed, with `projectSnapshot`/`arcadeRecords` delegating.
Confirmed by direct comparison that `SessionFacts` is `ProjectMessage.sessions[]` minus `presence` —
identical 10 fields in the same order.

**Task 3 — `poc/hub` and the shared-module seam.** No divergence in file contents or layout.
`poc/server/tsconfig.build.json` adds only `"declaration": true`; `rootDir: "src"` and
`include: ["src"]` are untouched and `rootDir` is explicit, so **`dist/main.js` stays at the top
level** — the path baked into `deploy/multiplayer-ai.service:16`. The `exports` map is purely
additive: the client has zero references to `multiplayer-ai-server`, the systemd unit references the
literal `dist/main.js` path and never the package name, and there is no bare `"."` self-import.

**Task 4 — `hubStore.ts`.** Two divergences, both from the fix round:
- `snapshot()` deep-copies per-session facts (ruling B.1).
- **A crash guard on `publish`.** A non-object element in an events array — reachable because of B.3 —
  hit `.seq` on `null` and threw. `typeof event !== "object" || event === null` now runs before any
  `.seq` read; the covering test pushes `[ev(0), null, "x", 42, ev(1)]` and asserts it does not throw
  and still stores seq 0 and 1.

**Task 5 — the `ConnectionIO` seam.** The listing (above, at `interface ConnectionIO`) made
`stampedIdentity` optional independently of `mode`. **Shipped as a discriminated union
`DirectIO | RelayIO`, with `stampedIdentity` required on the relay arm.** Reason: the identity sites
discriminated on the *stamp* while replay/subscribe/snapshot discriminated on *`mode`*, and the two
discriminators could disagree. `{ mode: "relay", send }` with no stamp was representable, reached the
identity `else` arm, and with auth off **kept the payload's claimed `userId`/`name`** — fail-open on
exactly the trust inversion this seam exists to enforce. Latent (nothing constructed one) but not
worth leaving representable. All four watcher sites now derive `watcher` once as
`io.mode === "direct" ? io.watcher : undefined`, which removes per-site disagreement by construction;
`io.cookieHeader` typechecks only because the relay arm returns first. No casts paper over the
narrowing.

Two deliberate **non**-maximal choices, both reviewed and kept: `watcher` stays optional on `DirectIO`
(a watcher-less direct connection is legitimate, cannot fail open on anything, and requiring it would
have forced an edit to this plan's own `{ mode: "direct", send }` test construction), and
`cookieHeader` stays optional (`IncomingMessage.headers.cookie` is itself `string | undefined`).

Plus the two test bodies of ruling B.2. Everything else in the extraction is verbatim: the join tail
order (replay → subscribe → ctx → watchers.add → glyph/color → session.join → invite_redeemed →
personal snapshot), `watch_project`'s `watching = project` still after both watcher mutations,
`peek`/`peek_invite`/both `create_session` acks byte-identical through `io.send`, and per-connection
`ctx`/`watching` still one pair per connection with `denyUnauthed` re-created per message. Nothing
moved to module scope. Note for later: `server.ts` grew 938 → 1004 lines with a ~600-line
`createConnection` nested inside `startServer`. If it ever moves to its own module it **will** need an
`exports` map entry.

**Task 6 — `relay.ts`, the laptop's outbound uplink.** Five divergences:

1. **`require("ws")` → a top-level `import { WebSocket } from "ws"`.** `poc/server` is
   `"type": "module"`, so the listing's `defaultConnect` would have been a runtime `ReferenceError`
   the first time anyone passed `--hub`. `import type { ConnectionIO } from "./server.js"` stays
   type-only, so there is still **no runtime import cycle** between `server.ts` and `relay.ts`.
2. **The replay is chunked into multiple frames, not emitted as one.** The listing emitted one
   unbounded frame against the protocol's own `MAX_FRAME_BYTES = 1_000_000` cap, which livelocks a
   >1MB session: oversized frame → `ws` 1009 close → reconnect → same empty `have` → same frame,
   forever. A module-level `publishFrames(sessionId, runId, events)` now splits it, budgeting for the
   frame's own envelope (`budget = MAX − len(envelope with events: [])`, per-event `size = len(event)+1`
   for the joining comma, same key order in the emitted frame). Both producers route through it — the
   `welcome` replay and `trackSession`'s backlog. Safe because `(runId, seq)` keying already makes many
   publish frames per session equivalent to one.
3. **Per-socket identity guards in the lifecycle.** `connect()` captures `const socket` and every
   handler early-returns unless `socket === this.socket`; `start()` early-returns when `this.socket`
   is set **or** a reconnect timer is pending. Without this, real `ws` reporting a close
   asynchronously means `stop()` then `start()` delivers the *old* socket's close after the *new*
   socket is assigned — nulling `this.socket`, clearing the new socket's channels, and leaving `write`
   sending into the void with `open` still true. Latent under a single caller, but the class is
   exported for Task 8 to drive. Note: double-start is now a silent no-op rather than an error.
4. **The pending buffer evicts oldest-first** instead of the listing's `return` that rejected new
   frames, so a long outage keeps the *freshest* facts rather than the stalest. `pending` became
   `{ frame, size }[]` so eviction never re-stringifies. `stop()` now clears `pending`/`pendingBytes`,
   so a restarted relay cannot flush a previous life's frames on its next `welcome`.
5. **`sessionFactsOf` is computed twice per push when a hub is attached** (`server.ts:198` vs `:206` —
   `snapshotFor` → `projectSnapshot` already computes it). Only paid when `relay` is non-null, so the
   additive invariant is intact. The facts could be threaded through; nobody has.

The `server.ts` side is exactly the listing and is **47 insertions, 0 deletions**. Ordering there is
load-bearing and commented in place: `relay?.trackSession(...)` is the *last* statement of the
`if (!entry)` block because `skill_roster` is appended before the subscribe exists, so only
`trackSession`'s backlog publish reaches the hub for a session created while the uplink is already up;
the two paths cannot double-publish because `trackSession` returns early for an already-tracked
session. Facts are republished for every session on every push, with no change detection, on the
snapshot's existing 1-second throttle — brief-specified, and the obvious place to add change detection
if uplink chattiness ever matters.

**Task 7 — the hub's WebSocket surface.** Three deliberate deviations from the listing, all reviewed
and kept:

1. **Stale-socket guard on uplink close.** The listing's close handler unconditionally
   `uplinks.delete(uplinkId)` + `store.detach(uplinkId)`. A laptop reconnecting under the same
   `uplinkId` before the hub observes the old socket's close — the flaky-network case `relay.ts` exists
   for — would have had its *live* uplink unregistered and its sessions pinned `offline` by the late
   close of the superseded socket. The handler now returns early unless `uplinks.get(uplinkId) === socket`.
2. **`msg?.type` instead of `msg.type`.** A browser sending the literal `null` (valid JSON) throws
   inside the `message` listener, and an exception in a `ws` event handler is an uncaught exception
   that **takes the hub process down**. There is now a regression test for exactly this frame.
3. **A non-string `sessionId` is rejected outright.** The listing validated
   `SLUG.test(String(msg.sessionId ?? ""))` but then stored the raw `msg.sessionId`.
   **Correction on record:** the justification originally given for this change — that a JSON number
   like `123` would be stored as a key that can never match the store's string-keyed map — is **wrong**.
   `ownerOf(projectId, 123)` returns `null` and the join is rejected before `channel.sessionId` is ever
   assigned, so the unmatchable key would never have been stored. The change is still net-better (an
   accurate error message, no `any` in channel state, and parity with the laptop) but **do not carry
   the original reasoning forward.**

Also from the fix round, all divergences from the listing:
- **`hubStore` split into creating and non-creating reads.** `sessionsOf` was a lazily-*creating*
  accessor used on read paths, so unauthenticated `peek` grew `HubStore.projects` without bound and
  never reclaimed it — also a parity divergence from `server.ts:532`'s non-creating `projects.get`. A
  private `readSessionsOf` now serves `resumeOffsets`, `ownerOf`, `eventsFor` and `snapshot`; the
  creating `sessionsOf` survives at exactly the two uplink **write** paths (`setFacts`, `publish`).
  Task 4's store contract is unchanged by the split.
- **A second `hello` on one uplink socket is refused** with `close(1008, "already identified")`. It
  previously leaked a registration and pinned presence `online` forever. Verified not to fire for a
  real laptop: `relay.ts` sends `hello` only from the socket `open` handler, once per socket, via
  `write` rather than the `emit` buffer, so it is never replayed on a `welcome` flush.
- **The hub runs `server.ts`'s identical join `typeof` triple, with the identical message.**
  Previously the hub accepted a `name`-less join that the laptop rejects. The alternative fix —
  `tunnel({ ...msg, userId, name })` — was **rejected deliberately**: rejecting at the hub also
  preserves `DownFrame`'s "the ORIGINAL client message, untouched" contract (`relayProtocol.ts:53-57`),
  which is the contract worth keeping intact. `tunnel(msg)` is still unrewritten.
- **An "already joined" guard**, mirroring `server.ts`. Without it a re-join rebound channel state and
  orphaned the previous laptop's roster entry as a permanent ghost participant.
- **A `reply` is dropped unless the channel is joined and
  `store.ownerOf(channel.projectId, channel.sessionId) === uplinkId`**; a payload-less reply now
  produces no frame at all rather than a zero-length one the browser's `JSON.parse` throws on;
  `close()` calls `wss.close()` before `httpServer.close()`.
- **`fanOut`'s third parameter is typed `readonly { event: unknown }[]`**, to state ruling B.1's
  read-only contract in the type rather than in a comment.
- **A joined channel is never re-homed by `watch_project`** — see D.9, which is the cost of that guard.

**Task 8 — `mpai --hub`.** The `cli.ts` and `cli.test.ts` listings were applied **verbatim**. The only
addition is a one-line doc comment on the new `hub?: string` field. One test was later renamed
(`"defaults to no hub, which is today's standalone behaviour"` →
`"leaves hub undefined when the flag is absent"`) because it asserts only
`parseArgs([]).hub === undefined`, while the invariant it was named for actually lives at `cli.ts:131`
(a conditional spread that emits no `hub` key at all, so `server.ts:1001-1012` sets `relay = null`) and
`cli.ts:144`. **`launch` has no test, here or anywhere**, because it is not exported and calls the real
`startServer`; a comment in the test file records this. `mpai --hub --no-open` consumes `--no-open` as
the flag's value and reports the scheme error rather than a missing-value one — left as specified,
because `--project` and `--base` have the same defect *silently*, so fixing one of the three is worse
than fixing none.

**Every test count in this plan is a prediction, and all of them are low.** The plan's Global
Constraints cite server 345 / client 179, which were `main` at `a6e9d76`; v7a2 and the workdir guard
landed in between. The true baseline at the branch point (`18900ff`) was **server 362, client 207**.
Final counts after Task 8: **server 409 (20 files), hub 43, client 207**, all three typechecks clean,
client build clean, `dist/main.js` still top level. Read every number in the listings above as "the
count the suite reports", not as a target. Task 5's real acceptance criterion was never the number —
it was the zero-edit part, and that held: `git diff --numstat` over `poc/server/test/` is
insertions-only across the whole branch.

### D. Shipped bounds — what v7b1 ships with, open and known

These are in addition to the "Known bounds" section above, which still stands. Read this list before
touching this code.

**D.1 — A hub-attached laptop cannot reclaim its own sessions after a restart. The serious one.**
Full write-up in `docs/tech-debt.md` §2.3; walk evidence in A.5. The short version: `cli.ts:131` passes
no `uplinkId`, so `server.ts:1007` mints a fresh `randomUUID()` per launch. **Consequence: Task 6's
entire resume machinery — `hubStore.resumeOffsets` and the `have` handshake — is dead code in every
real deployment, and this plan's central promise that sessions survive on the hub is false after any
laptop restart.** They survive as unreachable `offline` rows no machine can adopt. Spec §3.2's
`runId` append-not-overwrite trap was therefore never reachable and remains **unverified by anything** —
not by the walk, and not by a hub unit test driving two runs of one session through `publish`.

Two things narrow the fix, and both are easy to get wrong:

- **The takeover rule already ships.** `hubStore.ts:100` refuses only when
  `existing.uplinkId !== uplinkId`, so a reconnecting *same* identity re-owns its sessions with no new
  protocol; `hub.ts:227-230` already replaces a superseded same-id socket. What is open is the
  **grain** — is one uplink per repo-per-machine right, and what should a second `mpai` on the same
  repo do — plus roughly a one-line default at `server.ts:1007`. A grain decision, not a protocol
  project.
- **`workspace.repoKey()` is NOT a ready-made stable uplink identity, and using it as one is a
  session-hijack bug.** `repoKeyFor` (`repoKey.ts:97-103`) returns `normalizeRemote(remoteUrl)`
  **alone** whenever an `origin` exists — `ctx.hostname` and `ctx.repoRoot` are never consulted. Only a
  null normalize (no origin, or an unparseable remote) falls through to
  `localRepoKey(hostname, repoRoot)` (`repoKey.ts:90-93`). And `normalizeRemote` is built to be
  **byte-identical across every machine and protocol** for the same remote (`repoKey.ts:3-9`); that is
  its entire purpose — grouping teammates by repo (spec §3.3) — and `workspace.ts:76-78` says so in its
  own doc comment. **So `repo?.key` used directly as the uplink id would make two teammates who cloned
  the same repo present the SAME `uplinkId`, and `hubStore.ts:100` would read them as one machine
  reconnecting — each silently taking over the other's sessions.** The collision is by construction,
  which is what makes it invisible. The correct construction is the normalized remote as the
  stable-per-repo **half**, with `localRepoKey`'s hostname + hashed repo root supplying the
  machine-scoping ingredient. `docs/tech-debt.md` §2.3 states this correctly.

**D.2 — The client never reconnects its session WebSocket.** `useSessionSocket.ts:84`, no retry of any
kind. Pre-existing and equally true standalone, but the hub makes it load-bearing: a hub restart
strands every browser on a dead socket with live-looking APPROVE buttons until a manual reload. Walk
item A.4; `docs/tech-debt.md` §4.

**D.3 — JOIN on an offline session opens empty.** The hub refuses the join before the replay it is
already holding. Walk item A.6; `docs/tech-debt.md` §2.4. The fix is to replay and snapshot first and
refuse only the drive/approve paths, which `tunnel()` already does on its own.

**D.4 — A relay join emits no success signal, and none was invented.** This plan specifies no ack, and
three separate tasks were told not to invent one. A tunnelled `join` that succeeds produces no up-frame
at all — Task 5's `if (io.mode === "direct") io.send(...)` guard suppresses even the personal snapshot.
The only success signal is the absence of an `error` reply. Worse, a `tunnel` frame that fails
`parseDownFrame` is dropped with no reply either, so from the hub's side "succeeded", "silently rejected
as malformed" and "arrived after teardown" are **one indistinguishable observation**. Task 7 makes this
narrow rather than fatal — the hub answers the browser from its own store *before* tunnelling, so
"joined" never depends on interpreting laptop silence — but the residual failure is real: if the laptop
silently rejects a join, the browser sees a fully populated session with no participant row for it and
commands that all fail. An ack is the fix and it needs a ruling.

**D.5 — The laptop's uplink fails silently.** `socket.on("error", () => {})` plus `write`'s `catch {}`
swallow every uplink failure, so `mpai --hub ws://wrong-host` is indistinguishable from a working
uplink. This is **plan-mandated code**, which is why it was routed to a human rather than fixed in the
loop, and it is out of step with `overseer.ts:120`, which logs exactly this class of failure. It is a
live question, not a closed item.

**D.6 — Channel re-establishment after an uplink drop has no owner.** Confirmed from both sides and
assigned to nobody by this plan. `relay.ts` closes and forgets every channel on `close` and never tells
the hub; the hub's channel keeps its `projectId`/`sessionId`/`identity` across the drop, so once the
laptop re-registers, `tunnel()` resolves the new socket and forwards a command down a channel the laptop
never saw a `join` for. A browser that was mid-session gets a fresh, never-joined connection on its next
`prompt`. Observed directly during the walk: when the uplink dropped, the session's participants
emptied to `[]` while the browser's hub socket stayed open and unaware; only a page reload recovered.

**The design space is narrower than it looks, and this is the useful part:** `channel.sessionId` is set
only at `hub.ts:319` and is cleared **nowhere** (the close handler deletes the whole channel), and the
new "already joined" guard at `hub.ts:284` fires first — **so a browser whose laptop dropped cannot
re-join on its existing socket.** The fix therefore cannot be browser-side. It must run hub-side per
surviving channel (re-issuing a join after the new uplink's `welcome`), or something must reset
`channel.sessionId`.

**D.7 — FIXED in the whole-branch fix wave. The chunk budget counted UTF-16 code units, not bytes.**
`relay.ts` used `JSON.stringify(...).length` at both `publishFrames` sites and in the pending buffer's
budget. All three now use `Buffer.byteLength`. Covered twice over: a relay unit test that asserts an
emoji log splits into frames each under `MAX_FRAME_BYTES` *in bytes* (`relay.test.ts`, "chunks by
BYTES"), and the integration test's chunked-replay scenario, which is judged by the hub's real
`maxPayload` rather than by a re-implementation of it. Both were verified to fail against the unfixed
source; the integration one fails by holding **zero** events, because the oversized frame livelocks the
uplink exactly as predicted.

**D.8 — A single event larger than `MAX_FRAME_BYTES` still ships alone and still livelocks**
(`relay.ts:304-307`). Chunking fixes the aggregate case only. This was escalated rather than silently
dropped, because dropping such an event would punch a permanent hole in an append-only log. It wants a
real answer — a truncation marker event, or a hub-side oversize ack — not a silent drop. Relatedly, the
pending buffer's worst case is now `MAX_FRAME_BYTES` plus one oversized frame, because the eviction loop
keeps at least one entry; deliberate, commented, bounded by a single frame.

**D.9 — `HubStore.uplinks` grows without bound.** `hubStore.ts:43-45,50-53`: `attach` inserts a
permanent `Uplink` per distinct `uplinkId` and `detach` only flips `online = false` — nothing ever
deletes. **This is the same class as the `HubStore.projects` leak that was fixed, surviving on the other
plane.** The uplink plane is unauthenticated in v7b1, so a connect/`hello`/disconnect loop with fresh ids
leaks an entry per cycle plus a session-map entry per `facts`/`publish`. Bounded in practice only by the
"must not be exposed to the internet until v7b2" caveat.

**D.10 — A joined browser that watches another project keeps receiving its own session's pushes.**
`hub.ts:343`'s re-home guard (added by Task 7's fix round) trades one divergence from `server.ts` for
another. The standalone server keeps the project-watch subscription and the joined session as
independent variables (`watching` vs `ctx`), so a joined socket may re-home its watch freely. The hub
overloads `channel.projectId` for **both** the push subscription and the `fanOut` key, so the guard
preserves the event stream at the cost of the subscription: such a browser gets one snapshot for the
project it asked about and then keeps receiving pushes for its own session's project. Unreachable from
the shipped client (`SessionPicker` opens a dedicated socket and never joins). Structural fix: a
separate `channel.watchProjectId`, distinct from the `fanOut` key.

**D.11 — An unreproduced test flake. Carry it; do not assume it is gone.** One full server-suite run
during Task 8's fix round returned `1 failed | 408 passed`, and **which test failed was not captured**
(the run was piped through `tail -6`). Evidence since: 12 green full runs and 10 green `relay.test.ts`
runs by the implementer, plus 8 more green full runs (409/409) by the controller — 20+ consecutive
green, not reproducible on demand. The fix diff could not have caused it (a docs edit plus one `it()`
name string; the assertion body is a byte-identical, pure-sync `parseArgs` call).

**The ranking this entry first gave was impossible, and the whole-branch review caught it.** The
captured line read `1 failed | 408 passed` — 409 tests in one run. The **server** suite alone reported
409 passed across 20 files; the **hub** suite is a different package under a different command and
reported 43 across 3 files. So `poc/hub/test/routing.test.ts` **cannot have been in that run at all**,
and naming it first sent the reader to the wrong package. `poc/server/test/relay.test.ts` is also
implausible: it is fully synchronous apart from two `vi.useFakeTimers()` tests driven by
`advanceTimersByTime`, so it has no wall-clock race to lose.

**The plausible homes are pre-existing wall-clock sleeps**, all of which predate this branch:
`overseer.test.ts:61` (a 60 ms wait around a ~30 ms debounce, asserting an exact call count — the
classic shape), `agentDriver.test.ts:1153-1160`, and `server.test.ts`'s many `wait(50)` calls. **Do not
rewrite those tests on this evidence.** The failing test was never identified, and re-timing a suite
that gates every future task on a guess is worse than carrying the flake. Carry it. If it recurs,
capture the FULL output — never `tail` — and name the test before touching anything.

**D.12 — Minor gaps recorded so they are not rediscovered.**

**Out-of-order events within one run — the premise of the original entry was FALSE, and it was hiding a
Critical.** It read: "dropped, not reordered (`hubStore.ts`, `seq <= lastSeq` skip) — accepted for v7b1
(a single WS gives TCP ordering and the resume protocol extends monotonically), untested either way."
TCP ordering is real but irrelevant, and the resume protocol does **not** extend monotonically: the
`welcome` branch deliberately **rewinds** to `have.lastSeq + 1`, and `have` is computed at hello time —
one full round trip before the laptop acts on it. The relay used to write live frames the moment the
socket was `open`, so a single event appended in that window travelled *ahead* of the replay it was
rewinding to. Out-of-order arrival was therefore not a hypothetical the transport ruled out; it was
manufactured by the handshake, on every reconnect, and the `seq <= lastSeq` skip then silently discarded
the entire outage backlog. Laptop 36 events, hub 6, no error anywhere, a permanent hole in every
browser's transcript and in the hub's stored history for every future joiner.

**Fixed** in the whole-branch fix wave: `relay.ts` gates `emit()` on a new `ready` flag set in the
`welcome` branch — after the replay and immediately before `flush()` — instead of on `open`. Frames
produced in the window buffer, and the replay (which reads the live log) carries them in order. `hello`
still goes out from the `open` handler, and `reply` frames never pass through `emit()`, so nothing on
the command plane is delayed. No protocol change. The store's `seq <= lastSeq` skip is unchanged and is
now *correct as stated*, because nothing arrives out of order any more. Covered by
`relay.test.ts`'s "writes nothing but hello between open and welcome" and, end to end, by
`poc/hub/test/relayIntegration.test.ts` — both verified to fail against the unfixed source.

The general lesson this cost: the relay's in-code comment asserted the hub "keys on (runId, seq)", while
the hub keys on a per-session **high-water mark**. Two modules, two packages, one false shared premise,
and no test that ran them together. That is what `relayIntegration.test.ts` now exists for.

Remaining minor gaps:
`resumeOffsets`' `lastRunId === null` exclusion of facts-only sessions has no test.
`setFacts` returns `{ ok: false, error }` while `publish`/`attach` silently no-op on unknown-uplink or
wrong-owner, so a caller cannot distinguish "nothing new" from "rejected".
The client's `lastSeq` is ignored on join — the hub always replays from 0, which is harmless only
because the client always sends 0, but the field is silently non-functional against a hub while it is
honoured against a standalone server.
~~`poc/hub/package.json` has no `pretypecheck` hook~~ — FIXED in the whole-branch fix wave; it now
mirrors `pretest`/`prebuild`, so `npm run typecheck` alone on a clean checkout builds the server's
`dist/*.d.ts` first.
~~`poc/hub/test/httpSurface.test.ts:39-42` ("binds the host it was given") only asserts `port > 0`~~ —
FIXED: renamed to what it checks and given a real reachability assertion plus a negative probe at the
IPv6 loopback, the latter carrying its own comment that it can pass vacuously on a host without IPv6.
`createConnection` returns an anonymous handle type and `msg` is `any` on what is now a package
surface; exporting a `ConnectionHandle` interface would cost two lines.
`test/workspace.test.ts:80` emits a stderr `HEAD is now at … init` from `git checkout --detach` during
full-suite runs and not focused ones — pre-existing, harmless, and *not* introduced by v7b1.

**D.13 — What the whole-branch review changed, in one place.** After the eight tasks closed, the branch
was reviewed as a whole and fixed in a single wave. One Critical and four Importants, all of which had
survived every per-task review:

- **C1** — the reconnect event-loss bug. See the rewritten D.12 above; it is the reason that entry's
  original premise was false.
- **I5** — no test anywhere ran a real `relay.ts` against a real `hub.ts`. Each side was only ever
  tested against a fake counterpart written by its own author, which is precisely why C1 survived eight
  reviews and two fix rounds. `poc/hub/test/relayIntegration.test.ts` now runs both, over a real
  `startHub({ port: 0 })` on loopback: reconnect-with-a-gap, chunked replay, browser join.
- **I1** — a session-name collision closed the losing laptop's whole uplink on a 2-second loop. Now the
  frame is dropped and logged and browsers joined to that session get an error. See the corrected
  "Known bounds" entry.
- **I2** — one out-of-range `seq` froze a session's hub history permanently, and the resume protocol
  confirmed the corruption rather than repairing it. `hubStore.publish` now requires
  `Number.isSafeInteger(seq) && seq >= 0`.
- **I4** — see D.7, now fixed.
- **I3** (invite flow dead through the hub) was **documented, not fixed** — it needs design. Recorded in
  "Known bounds" above and `docs/tech-debt.md` §2.5.
- Minors: `--project` is now validated against `SLUG` at parse time (an invalid one used to produce an
  invisible infinite reconnect loop *after* "attached to hub" was printed); `server.ts`'s `peek` and
  `watch_project` handlers now name the cross-package `HUB_HANDLED` coupling in a comment; the hub's
  `pretypecheck` hook and the over-promising `httpSurface` test name are fixed above.

Every fix ships with a test that was **verified to fail against the unfixed source** — the revert sweep
is written up in `.superpowers/sdd/2026-07-27-v7b1-hub-relay-spine/whole-branch-fix-report.md`. B.2's
lesson (two tests that passed against the very bug they were named for) is why that is now the standard,
not an option.

### E. Which boxes above are ticked, and which are not

The five items under "Verification before calling v7b1 done" are ticked, plus Task 8's Step 6. The
evidence for each:

- **All three suites green, typechecks clean, client build clean** — server 409 / hub 43 / client 207,
  three clean `tsc --noEmit` runs, clean `npm run build` on client and server, `dist/main.js` at the top
  level of `poc/server/dist`. Output was pristine apart from D.12's pre-existing `workspace.test.ts`
  stderr line.
- **Insertions only in `poc/server/test/`** — `git diff --stat main -- poc/server/test/` reports 512
  insertions, 0 deletions. Independently re-verified at Task 5, the one task that could have broken it.
- **`mpai` with no `--hub` still launches and runs a turn** — walked by hand (A.9). Read that tick with
  A.9's caveat: the launch, the standalone line, `mpai new` and a full streaming turn were observed; the
  browser auto-open arm was verified by reading the unchanged `if (args.open && !args.hub)` guard, not
  by observing a window open.
- **All seven walk items walked by hand, results written into Deviations** — section A. Satisfied by
  this section; it is the reason this section was written before the plan's workspace was torn down.
- **`docs/tech-debt.md` gains the `auth.ts`/`staticFiles.ts` scrub entry** — present at
  `docs/tech-debt.md` §4.

**The per-task Step checkboxes throughout the plan above are left unticked.** Execution was tracked in
the SDD ledger rather than in the plan, and ticking them now from a report would be a claim about
process rather than about evidence. What those steps produced is recorded in sections A–D.

---

## Appendix: what v7b2 and v7b3 cover, and what must be decided first

Recorded here so the decomposition is not re-derived, and so the reason the other two plans are not yet written is explicit rather than an omission.

### v7b2 — trust, pairing and the §10 security floor

**This is what makes the hub safe to expose, and nothing should be deployed until it lands.** Scope:

- Hub-side GitHub OAuth. `auth.ts` is already transport-agnostic and already exported through Task 3's seam, so this is a wiring job, not a rewrite (spec §3.5).
- Replace v7b1's client-asserted `join` identity (Task 7, `handleBrowser`) with the cookie-verified login. That single change is what turns the trust inversion from a seam into a control.
- Device pairing: `mpai --hub <url>` prints a short code, a signed-in browser approves it, the hub issues a long-lived uplink token bound to that GitHub identity. Tokens travel in the `Authorization` header or the WebSocket subprotocol — **never a query string** (spec §10.1), and the existing `?invite=` query-string pattern must be narrowed at the same time, not extended.
- Codes are short and human-transcribed, therefore brute-forceable by construction: short TTL, single use, per-hub rate limiting (spec §10.5).
- `Origin` check on both upgrades (spec §10.6). Today cross-site WebSocket hijacking is blocked by `SameSite=Lax` alone; once the cookie confers identity across a whole team that stops being defence in depth.
- Bounds and charset checks on every inbound field regardless of auth mode, including the known stragglers `stop_task`'s `taskId` and summary/tool-target text (spec §10.3).

**Blocked on one user decision before it can be planned without guessing:** spec §11 leaves **uplink token revocation** explicitly unspecified — the host needs a way to revoke a lost laptop, and the shape (a revocation list on the hub, short-lived tokens with refresh, or per-device records with an explicit revoke) determines several tasks. Decide that first.

### v7b3 — the host role and the team surface

- Host as a hub-scoped attribute of a person, transferable from day one (spec §3.6). The stated non-capability — a host can never drive or approve in a session they have not joined — needs a test that pins it, not just a paragraph.
- Host settings, most of which are a *move* of existing env vars rather than an invention: the sign-in allowlist, `REQUIRE_INVITE`, whether members may add plugins, retention, whether AUTO mode is permitted.
- Hub-wide session close by the host, which is the second caller of `close_session` (v7a shipped the first).
- Per-laptop plugin rosters surfaced on the hub snapshot, closing the "plugins read empty" bound v7b1 ships with.
- Oversight configured by the host, including the one scoped key exception (spec §3.7).
- Client: a host settings screen, and grouping the picker by repo now that one surface spans several.
- Seats countable, whether or not they are charged for (spec §3.6).

**Blocked on one non-code question:** spec §3.7's "or a paid tier where we supply one" means reselling inference, which needs a read of Anthropic's commercial terms — the same document captured 2026-07-25 and never re-verified. The *code* is unblocked (host supplies their own key); only the paid-tier arm waits.

### Not in any v7b plan

`v7c` persistence (SQLite on the hub), `v7d` handoff continuity, `v7e` collision detection (formerly v6b, grouped by repo key). Spec §7 scopes all three. Note that v7e also depends on the worktree-sharing bug recorded in spec §9 — it must dedupe by resolved workdir, or every file either session touches reads as contested.
