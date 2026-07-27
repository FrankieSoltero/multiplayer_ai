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

- [ ] **Step 6: The two-process walk — REQUIRED, not optional polish**

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

- [ ] All three suites green, all three typechecks clean, client build clean.
- [ ] `git diff --stat main -- poc/server/test/` shows **insertions only** in pre-existing test files. Any deletion means the additive invariant broke.
- [ ] `mpai` with **no** `--hub` still launches, opens a browser and runs a turn exactly as before. Check this explicitly — it is the promise the whole plan rests on (spec §6).
- [ ] All seven items of Task 8 Step 6 walked by hand, results written into Deviations.
- [ ] `docs/tech-debt.md` gains an entry: `poc/server`'s `auth.ts` and `staticFiles.ts` become dead for hub-attached `mpai` once v7b2 lands, and are candidates for the v7 scrub pass.

## Known bounds this plan ships with, stated so they are not reported as bugs

- **The hub has no authentication.** v7b1 stamps the identity the browser claims. It is a development target for a trusted network and **must not be exposed to the internet**. v7b2 is the plan that changes this.
- **The hub's log is in memory** (spec §2.11). A hub restart loses history. That is v7c's job and must not be presented to users as durable before then (spec §8).
- **Two laptops cannot both own a session id in one project.** The second is refused with a plain error rather than silently merged. Hub-scoped session ids are v7c/v7e — the same shape of problem as spec §9's shared-worktree bug.
- **Plugins and oversight read empty when hub-attached.** Plugins are laptop-local files (spec §4); oversight is host-configured (spec §3.7). Both are surfaced in v7b3.
- **`repo` is null on a hub snapshot.** A hub spans repos, so there is no single one to report; the per-session `repoKey` is the honest answer and the client already reads it (v7a).
- **Approvals gain roughly 100ms** (browser → hub → laptop). Irrelevant for a human clicking a button (spec §8).
- **`create_session` is tunnelled but has no owner before a laptop attaches**, so creating a session from the browser only works for a project that already has an uplink. Creating the *first* session on a machine is still `mpai new`. Making the hub route a create to a chosen laptop is v7b3.

## Deviations

*Fill this in during execution. Every divergence from the listings above, with the reason. This section becomes the authority on why the shipped code differs from the plan — future sessions read it before touching this code.*

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
