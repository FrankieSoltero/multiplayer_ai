# A3 Pull Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a permission gate in another session goes unanswered longer than *your* chosen delay, that session's row in OTHER PARTIES lights up as a pull and the header shows `PULLS ▸ N`.

**Architecture:** The server derives "is a gate pending, and since when" as a pure function over the existing session event log and publishes it as one new optional field on the project snapshot that already broadcasts. It never decides a pull is *due* — every deadline lives with the recipient, which is what makes per-person thresholds cost nothing server-side. The client compares that timestamp against its own threshold on a 10-second tick.

**Tech Stack:** TypeScript, Node (no framework) on the server; React + Vite on the client; vitest both sides.

**Spec:** `docs/superpowers/specs/2026-07-27-a3-pull-notifications-design.md` — the authority. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- Server tests live in `poc/server/test/*.test.ts` (NOT `src/`); client tests are co-located in `poc/client/src/`.
- Extract logic worth testing as a pure function. There is no component-test infrastructure in this project — pure-function extraction plus one real browser pass is the pattern.
- **A `<label>` must never wrap a form control.** It forwards a second synthesized click, which for a `<select>` opens and instantly closes the native dropdown, and the control looks dead with no error anywhere. Use a `<span>` + `aria-label`.
- Never `git add -A`. Every commit spells out its paths; verify with `git diff-tree --no-commit-id --name-status -r HEAD`.
- Do not add server timers, per-user server state, or new wire message types. The whole feature is one optional snapshot field plus client-side arithmetic.
- Baselines before this work: **server 297 tests, client 147 tests**, both `tsc --noEmit` clean, client build clean.

---

## File Structure

| File | Responsibility |
|---|---|
| `poc/server/src/pendingGate.ts` *(create)* | Pure: given a session's event log, return the oldest unresolved permission request, or null. |
| `poc/server/test/pendingGate.test.ts` *(create)* | Tests for the above. |
| `poc/server/src/project.ts` *(modify)* | `projectSnapshot` publishes `pendingGate` per session. |
| `poc/server/test/server.test.ts` *(modify)* | One wire test asserting the snapshot carries it. |
| `poc/client/src/types.ts` *(modify)* | `ProjectSessionInfo` mirrors the new field. |
| `poc/client/src/pulls.ts` *(create)* | Pure: which sessions are pulling me right now, and the threshold option list + parse. |
| `poc/client/src/pulls.test.ts` *(create)* | Tests for the above. |
| `poc/client/src/App.tsx` *(modify)* | Threshold state, the 10s tick, computes pulls, passes down. |
| `poc/client/src/components/PartyPane.tsx` *(modify)* | Marks pulling rows; hosts the threshold `<select>`. |
| `poc/client/src/components/Header.tsx` *(modify)* | `PULLS ▸ N` badge. |
| `poc/client/src/terminal.css` *(modify)* | `.pull` row styling. |

---

### Task 1: Server — derive the pending gate

**Files:**
- Create: `poc/server/src/pendingGate.ts`
- Test: `poc/server/test/pendingGate.test.ts`

**Interfaces:**
- Consumes: `LoggedEvent` from `./events.js` (`events.ts:48` — `SessionEvent & { seq: number; ts: string }`). The two relevant arms are at `events.ts:24-25`:
  `{ type: "permission_request"; requestId: string; toolName: string; input: unknown }` and
  `{ type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string; auto?: true }`.
- Produces: `interface PendingGate { toolName: string; sinceTs: string }` and
  `pendingGateOf(events: LoggedEvent[]): PendingGate | null`.

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/pendingGate.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { pendingGateOf } from "../src/pendingGate.js";
import type { LoggedEvent } from "../src/events.js";

/** Events carry seq and ts in real logs; these helpers keep the tests readable. */
function req(requestId: string, toolName: string, ts: string, seq = 0): LoggedEvent {
  return { type: "permission_request", requestId, toolName, input: {}, seq, ts } as LoggedEvent;
}
function dec(requestId: string, ts: string, seq = 0, auto?: true): LoggedEvent {
  return {
    type: "permission_decision", requestId, decision: "allow", userId: "ana",
    ...(auto ? { auto } : {}), seq, ts,
  } as LoggedEvent;
}

describe("pendingGateOf", () => {
  test("returns null when there are no permission events at all", () => {
    expect(pendingGateOf([])).toBeNull();
  });

  test("returns the request when nothing has decided it yet", () => {
    const events = [req("r1", "Bash", "2026-07-27T10:00:00.000Z")];

    expect(pendingGateOf(events)).toEqual({ toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z" });
  });

  test("returns null once a decision resolves the request", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      dec("r1", "2026-07-27T10:00:05.000Z", 1),
    ];

    expect(pendingGateOf(events)).toBeNull();
  });

  test("an auto decision resolves the request, so AUTO mode never pulls anyone", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      dec("r1", "2026-07-27T10:00:00.100Z", 1, true),
    ];

    expect(pendingGateOf(events)).toBeNull();
  });

  test("returns the oldest gate when several are pending at once", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      req("r2", "Write", "2026-07-27T10:00:30.000Z", 1),
    ];

    expect(pendingGateOf(events)).toEqual({ toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z" });
  });

  test("skips a resolved gate and reports the one still waiting", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      dec("r1", "2026-07-27T10:00:05.000Z", 1),
      req("r2", "Write", "2026-07-27T10:00:30.000Z", 2),
    ];

    expect(pendingGateOf(events)).toEqual({ toolName: "Write", sinceTs: "2026-07-27T10:00:30.000Z" });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails for the right reason**

Run: `cd poc/server && npx vitest run test/pendingGate.test.ts`
Expected: FAIL — cannot resolve `../src/pendingGate.js`. Not a type error, not a typo in an import of something that exists.

- [ ] **Step 3: Write the minimal implementation**

Create `poc/server/src/pendingGate.ts`:

```ts
import type { LoggedEvent } from "./events.js";

/** A permission request nobody has answered yet. `sinceTs` is when the agent
 *  asked — the client compares it against its own threshold, because the
 *  server has no opinion about when waiting becomes worth interrupting
 *  someone over. */
export interface PendingGate {
  toolName: string;
  sinceTs: string;
}

/** The oldest unanswered permission request in this log, or null.
 *
 *  Auto-approved calls append a `permission_decision` with `auto: true`, which
 *  resolves the request like any other — so AUTO mode produces no pending gates
 *  without needing a special case. */
export function pendingGateOf(events: LoggedEvent[]): PendingGate | null {
  const decided = new Set<string>();
  for (const ev of events) {
    if (ev.type === "permission_decision") decided.add(ev.requestId);
  }
  for (const ev of events) {
    if (ev.type === "permission_request" && !decided.has(ev.requestId)) {
      return { toolName: ev.toolName, sinceTs: ev.ts };
    }
  }
  return null;
}
```

The log is append-only and ordered by `seq`, so the first undecided request encountered *is* the oldest — no sorting needed.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd poc/server && npx vitest run test/pendingGate.test.ts`
Expected: PASS, 6 tests. Output pristine — no warnings.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/pendingGate.ts poc/server/test/pendingGate.test.ts
git commit -m "feat(server): derive the oldest unresolved permission gate"
git diff-tree --no-commit-id --name-status -r HEAD
```

---

### Task 2: Server — publish it on the project snapshot

**Files:**
- Modify: `poc/server/src/project.ts` (the `ProjectMessage` interface at `:83` and `projectSnapshot` at `:106`)
- Test: `poc/server/test/server.test.ts` (add one wire test)

**Interfaces:**
- Consumes: `pendingGateOf` and `PendingGate` from Task 1.
- Produces: `ProjectMessage["sessions"][number].pendingGate: PendingGate | null` — the field the client reads in Task 4.

- [ ] **Step 1: Write the failing test**

Add a new describe block to `poc/server/test/server.test.ts`. It uses the file's existing helpers — `connect` (`:20`), `collect` (`:36`), `wait` (`:40`) — and the `RunQuery` generator idiom from the "driver approval gate over the wire" block at `:352`. Place it after the `describe("project awareness", …)` block:

```ts
describe("pending gate on the project snapshot", () => {
  // Asks for permission and then waits forever: the request stays unanswered
  // unless a test explicitly decides it.
  const bashAskRun: RunQuery = async function* (prompts, hooks) {
    for await (const prompt of prompts) {
      const decision = await hooks.onPermissionRequest("Bash", { command: "npm run build" });
      yield { type: "assistant", content: [{ type: "text", text: `bash: ${decision}` }] };
    }
  };

  /** The most recent project snapshot this socket has been pushed. */
  const lastProject = (seen: any[]) =>
    [...seen].reverse().find((m) => m.type === "project");

  it("reports a gate that nobody has answered", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);

    // Ben watches the project from a different session in it.
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ben", userId: "u2", name: "Ben" }));
    await wait(200);

    const entry = lastProject(seenBen)?.sessions.find((s: any) => s.id === "ana");
    expect(entry.pendingGate).toEqual({ toolName: "Bash", sinceTs: expect.any(String) });

    wsAna.close();
    wsBen.close();
  });

  it("clears the gate once the driver decides", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);

    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ben", userId: "u2", name: "Ben" }));
    await wait(200);

    const req = seenAna.map((m) => m.event).find((e) => e?.type === "permission_request");
    wsAna.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "allow" }));
    await wait(300);

    const entry = lastProject(seenBen)?.sessions.find((s: any) => s.id === "ana");
    expect(entry.pendingGate).toBeNull();

    wsAna.close();
    wsBen.close();
  });
});
```

`close` is the suite-level teardown variable this file already uses; follow the surrounding blocks exactly.

- [ ] **Step 2: Run the test and confirm it fails for the right reason**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: FAIL — `pendingGate` is `undefined`, not the expected object. If it fails because the harness names are wrong, fix the harness usage first; the failure must be about the missing field.

- [ ] **Step 3: Write the minimal implementation**

In `poc/server/src/project.ts`, add the import:

```ts
import { pendingGateOf, type PendingGate } from "./pendingGate.js";
```

Add the field to the `ProjectMessage` interface (`:83`), inside the `sessions` element type, after `ended`:

```ts
    ended: boolean;
    pendingGate: PendingGate | null;
    skills: SkillInfo[];
```

And populate it in `projectSnapshot` (`:106`). The function already reads the log — reuse that same `events` array rather than fetching it twice:

```ts
    const events = entry.session.eventsFrom(0);
    const summary = summarizeSession(id, events, entry.driver.isDead);
    // ...
    return {
      id,
      participants: participants.map((p) => p.name),
      driverName:
        participants.find((p) => p.userId === driverId)?.name ?? null,
      intent: summary.intent,
      lastActivityTs: events.at(-1)?.ts ?? null,
      ended: summary.ended,
      pendingGate: pendingGateOf(events),
      skills: entry.skills,
    };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: PASS — 299 tests (297 baseline + 2 new). `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/project.ts poc/server/test/server.test.ts
git commit -m "feat(server): publish pendingGate on the project snapshot"
git diff-tree --no-commit-id --name-status -r HEAD
```

---

### Task 3: Client — decide which sessions are pulling me

**Files:**
- Modify: `poc/client/src/types.ts` (`ProjectSessionInfo` at `:61`)
- Create: `poc/client/src/pulls.ts`
- Test: `poc/client/src/pulls.test.ts`

**Interfaces:**
- Consumes: `ProjectSessionInfo` from `./types`, now carrying `pendingGate`.
- Produces:
  - `interface Pull { sessionId: string; toolName: string; sinceTs: string; driverName: string | null }`
  - `pullsFrom(sessions: ProjectSessionInfo[], opts: { thresholdMs: number | null; currentSessionId: string | null; now: number }): Pull[]`
  - `THRESHOLD_OPTIONS: { label: string; ms: number | null }[]`
  - `thresholdFromStorage(raw: string | null): number | null`
  - `PULL_STORAGE_KEY: string`

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/pulls.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { pullsFrom, thresholdFromStorage, THRESHOLD_OPTIONS } from "./pulls";
import type { ProjectSessionInfo } from "./types";

const T0 = Date.parse("2026-07-27T10:00:00.000Z");

function session(over: Partial<ProjectSessionInfo> = {}): ProjectSessionInfo {
  return {
    id: "ana",
    participants: ["ana"],
    driverName: "ana",
    intent: null,
    lastActivityTs: null,
    ended: false,
    pendingGate: { toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z" },
    ...over,
  };
}

describe("pullsFrom", () => {
  test("returns nothing when the feature is off", () => {
    const pulls = pullsFrom([session()], {
      thresholdMs: null, currentSessionId: "mine", now: T0 + 60_000,
    });

    expect(pulls).toEqual([]);
  });

  test("returns nothing before the threshold has elapsed", () => {
    const pulls = pullsFrom([session()], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 59_000,
    });

    expect(pulls).toEqual([]);
  });

  test("pulls exactly at the threshold", () => {
    const pulls = pullsFrom([session()], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 60_000,
    });

    expect(pulls).toEqual([
      { sessionId: "ana", toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", driverName: "ana" },
    ]);
  });

  test("never pulls for the session you are already in", () => {
    const pulls = pullsFrom([session({ id: "mine" })], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 300_000,
    });

    expect(pulls).toEqual([]);
  });

  test("ignores an ended session", () => {
    const pulls = pullsFrom([session({ ended: true })], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 300_000,
    });

    expect(pulls).toEqual([]);
  });

  test("ignores a session with no pending gate", () => {
    const pulls = pullsFrom([session({ pendingGate: null })], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 300_000,
    });

    expect(pulls).toEqual([]);
  });
});

describe("thresholdFromStorage", () => {
  test("an absent key means the feature is off", () => {
    expect(thresholdFromStorage(null)).toBeNull();
  });

  test("garbage means off rather than a crash or a surprise interval", () => {
    expect(thresholdFromStorage("banana")).toBeNull();
  });

  test("reads back a value this module could have written", () => {
    expect(thresholdFromStorage("60000")).toBe(60_000);
  });

  test("every offered option round-trips through storage", () => {
    for (const opt of THRESHOLD_OPTIONS) {
      expect(thresholdFromStorage(opt.ms === null ? null : String(opt.ms))).toBe(opt.ms);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails for the right reason**

Run: `cd poc/client && npx vitest run src/pulls.test.ts`
Expected: FAIL — cannot resolve `./pulls`.

- [ ] **Step 3: Add the field to the client type**

In `poc/client/src/types.ts`, extend `ProjectSessionInfo` (`:61`) after `ended`:

```ts
export type ProjectSessionInfo = {
  id: string;
  participants: string[];
  driverName: string | null;
  intent: string | null;
  lastActivityTs: string | null;
  ended: boolean;
  /** The oldest permission request nobody has answered, or null. Mirrors the
   *  server's ProjectMessage. Optional so a snapshot from an older server does
   *  not break the client. */
  pendingGate?: { toolName: string; sinceTs: string } | null;
  skills?: { name: string; description: string }[];
};
```

- [ ] **Step 4: Write the minimal implementation**

Create `poc/client/src/pulls.ts`:

```ts
import type { ProjectSessionInfo } from "./types";

/** A teammate's session that has been waiting on a permission decision longer
 *  than this viewer is willing to ignore. */
export interface Pull {
  sessionId: string;
  toolName: string;
  sinceTs: string;
  driverName: string | null;
}

export const PULL_STORAGE_KEY = "mpai-pull-after-ms";

/** null = off. Off is the default: a pull nobody asked for is just noise. */
export const THRESHOLD_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "OFF", ms: null },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "2m", ms: 120_000 },
  { label: "5m", ms: 300_000 },
];

/** Anything this module did not write is treated as off, so a stale or
 *  hand-edited localStorage value can never produce a surprise interval. */
export function thresholdFromStorage(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return THRESHOLD_OPTIONS.some((o) => o.ms === n) ? n : null;
}

/** Which sessions are pulling this viewer right now.
 *
 *  The threshold is compared client-side on purpose: the server publishes only
 *  when a gate started waiting, so two people watching the same gate can hold
 *  completely different opinions about when it becomes worth interrupting them,
 *  at zero server cost. */
export function pullsFrom(
  sessions: ProjectSessionInfo[],
  opts: { thresholdMs: number | null; currentSessionId: string | null; now: number },
): Pull[] {
  if (opts.thresholdMs === null) return [];
  const out: Pull[] = [];
  for (const s of sessions) {
    if (s.id === opts.currentSessionId) continue;
    if (s.ended) continue;
    const gate = s.pendingGate;
    if (!gate) continue;
    const waited = opts.now - Date.parse(gate.sinceTs);
    if (waited < opts.thresholdMs) continue;
    out.push({
      sessionId: s.id,
      toolName: gate.toolName,
      sinceTs: gate.sinceTs,
      driverName: s.driverName,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd poc/client && npx tsc --noEmit && npx vitest run`
Expected: PASS — 157 tests (147 baseline + 10 new). `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add poc/client/src/pulls.ts poc/client/src/pulls.test.ts poc/client/src/types.ts
git commit -m "feat(client): derive pulls from pending gates against a personal threshold"
git diff-tree --no-commit-id --name-status -r HEAD
```

---

### Task 4: Client — render the pull and let people tune it

**Files:**
- Modify: `poc/client/src/App.tsx` (`SessionView`, which holds `projectSessions` and `sessionId`; `<PartyPane>` at `:466`, `<Header>` at `:425`)
- Modify: `poc/client/src/components/PartyPane.tsx` (props at `:14`, OTHER PARTIES block at `:56-80`)
- Modify: `poc/client/src/components/Header.tsx` (button row, beside the WORKFLOWS badge at `:116-120`)
- Modify: `poc/client/src/terminal.css`

**Interfaces:**
- Consumes: `pullsFrom`, `thresholdFromStorage`, `THRESHOLD_OPTIONS`, `PULL_STORAGE_KEY`, `Pull` from Task 3.
- Produces: no new exports — this task is wiring and markup.

There is no component-test infrastructure in this project, so this task's verification is a real browser pass (Step 6). That is the standing pattern here and it is what caught the arrow-navigation `<select>` bug that pure tests could not see.

- [ ] **Step 1: Compute pulls in `SessionView`**

In `poc/client/src/App.tsx`, add the import:

```ts
import { pullsFrom, thresholdFromStorage, PULL_STORAGE_KEY } from "./pulls";
```

Inside `SessionView` (the component starting at `:160` — it already has `projectSessions` from `useSessionSocket` and `sessionId` from props), add:

```tsx
  const [pullThresholdMs, setPullThresholdMs] = useState<number | null>(() =>
    thresholdFromStorage(localStorage.getItem(PULL_STORAGE_KEY)),
  );

  // Crossing the threshold is an event only this clock can see: while a gate
  // sits pending no events fire, so no fresh snapshot arrives and nothing
  // re-renders. Without this tick a pull would surface only by coincidence,
  // when unrelated activity happened to push a new snapshot.
  const [pullTick, setPullTick] = useState(0);
  useEffect(() => {
    if (pullThresholdMs === null) return;
    const id = setInterval(() => setPullTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [pullThresholdMs]);

  const pulls = useMemo(
    () =>
      pullsFrom(projectSessions, {
        thresholdMs: pullThresholdMs,
        currentSessionId: sessionId,
        now: Date.now(),
      }),
    // pullTick is a deliberate dependency: it is the only thing that changes
    // when time passes and nothing else does.
    [projectSessions, pullThresholdMs, sessionId, pullTick],
  );

  const setPullThreshold = (ms: number | null) => {
    setPullThresholdMs(ms);
    if (ms === null) localStorage.removeItem(PULL_STORAGE_KEY);
    else localStorage.setItem(PULL_STORAGE_KEY, String(ms));
  };
```

Ensure `useEffect`, `useMemo` and `useState` are in the existing React import at the top of the file.

- [ ] **Step 2: Pass them down**

Still in `App.tsx`, at the `<Header>` call (`:425`) add:

```tsx
        pulls={pulls.length}
```

and at the `<PartyPane>` call (`:466`) add:

```tsx
          pulls={pulls}
          pullThresholdMs={pullThresholdMs}
          onPullThresholdChange={setPullThreshold}
```

- [ ] **Step 3: Render the header badge**

In `poc/client/src/components/Header.tsx`, add to the props object (beside `runningTasks`):

```ts
  /** How many other sessions are waiting on an approval past this viewer's
   *  threshold. 0 renders nothing — an always-present PULLS ▸ 0 would train
   *  people to ignore the one place this feature speaks. */
  pulls?: number;
```

And render it immediately after the `ONLINE`/`OFFLINE` span, before the sign-out control:

```tsx
        {(props.pulls ?? 0) > 0 && (
          <span className="conn pull-badge" title="sessions waiting on an approval">
            🔐 PULLS ▸ {props.pulls}
          </span>
        )}
```

- [ ] **Step 4: Mark the pulling rows and add the setting**

In `poc/client/src/components/PartyPane.tsx`, extend the props (`:14`):

```ts
export function PartyPane(props: {
  projectId: string; sessionId: string; sessions: ProjectSessionInfo[];
  participants: Map<string, Participant>;
  driverId: string | null;
  selfId: string;
  pulls?: Pull[];
  pullThresholdMs?: number | null;
  onPullThresholdChange?: (ms: number | null) => void;
}) {
```

with the imports:

```ts
import { THRESHOLD_OPTIONS, type Pull } from "../pulls";
```

Inside the component, before the return:

```tsx
  const pullBySession = new Map((props.pulls ?? []).map((p) => [p.sessionId, p]));
```

Replace the OTHER PARTIES title block (`:56-58`) with a title that carries the control. **The `<select>` gets a `<span>` + `aria-label`, never a wrapping `<label>`** — a wrapping label forwards a second synthesized click and the dropdown opens and instantly closes:

```tsx
      <div className="party-title pix" style={{ marginTop: 6 }}>
        <span>OTHER PARTIES</span>
        {props.onPullThresholdChange && (
          <span className="pull-setting">
            <span id="pull-after-label">PULL AFTER</span>
            <select
              aria-labelledby="pull-after-label"
              value={props.pullThresholdMs === null || props.pullThresholdMs === undefined
                ? ""
                : String(props.pullThresholdMs)}
              onChange={(e) =>
                props.onPullThresholdChange!(e.target.value === "" ? null : Number(e.target.value))
              }
            >
              {THRESHOLD_OPTIONS.map((o) => (
                <option key={o.label} value={o.ms === null ? "" : String(o.ms)}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
```

Then, inside the `others.map(...)` row (`:60-79`), change the anchor's className and add the pull line. Keep everything already there:

```tsx
        const pull = pullBySession.get(s.id);
        return (
          <a
            key={s.id}
            className={(s.ended ? "member ended" : "member") + (pull ? " pull" : "")}
            href={`?project=${props.projectId}&session=${s.id}`}
          >
            <div className="member-head">
              <span style={{ color: id.color }}>{id.glyph}</span> {s.id}
              {s.ended && <span className="here"> · ended</span>}
            </div>
            {pull && (
              <div className="member-pull">
                🔐 waiting {ago(pull.sinceTs)} — approval to run {pull.toolName}
              </div>
            )}
            {/* ...the existing member-quest and member-meta divs, unchanged... */}
          </a>
        );
```

`ago()` already exists at `PartyPane.tsx:6` and renders `"just now"` under a minute, `"Nm ago"` above it. Reuse it rather than writing a second time formatter.

- [ ] **Step 5: Style it**

Append to `poc/client/src/terminal.css`:

```css
.member.pull { border-color: var(--amber); }
.member-pull { color: var(--amber); font-size: 11px; margin-top: 2px; }
.pull-badge { color: var(--amber); }
.pull-setting { display: inline-flex; gap: 4px; align-items: center; font-size: 10px; margin-left: 8px; }
```

`--amber` (`terminal.css:37`, `#e0a458`, 8.91:1 contrast) is the token this project already
designates for the permission gate — the pull is that same gate seen from another session, so it
reuses the colour rather than introducing a new one.

- [ ] **Step 6: Verify in a real browser — two sessions, one pull**

This is the step that matters. Build and run the single-port path, then open two sessions:

```bash
cd poc/client && npm run build && cd ../server && npm run build
CLIENT_DIST=$(cd ../client/dist && pwd) HOST=127.0.0.1 PORT=3001 \
  ANTHROPIC_API_KEY=placeholder-not-a-real-key node dist/main.js
```

Confirm, in order:

1. With PULL AFTER on OFF (the default), no badge and no marked rows, however long a gate waits.
2. Set PULL AFTER to 30s in one tab. Reload — it is still 30s (localStorage round-trip).
3. In the other session, get a gate pending. Within ~40 seconds and **with no interaction in the first tab**, the row lights up and `🔐 PULLS ▸ 1` appears. *If it only appears when you click something, the 10s tick is not wired — that is the exact failure this feature is most likely to have.*
4. Click the pulling row — it navigates into that session.
5. Answer the gate. The pull clears on the next snapshot.
6. The session you are *in* never pulls you, even with its own gate pending.

**Getting a real gate without an API key:** the agent cannot run, so drive it from the server side instead — append a `permission_request` event to a session through whatever the test harness in `poc/server/test/server.test.ts` uses, or run a short `.mts` harness inside `poc/server/` that calls `startServer` and appends the event directly. A harness must be `.mts` or live inside `poc/server/`; a stray `.ts` outside the package is transformed as CJS and top-level `await` fails.

- [ ] **Step 7: Full green check**

```bash
cd poc/server && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc --noEmit && npx vitest run && npm run build
```

Expected: server 299, client 157, both `tsc` clean, build clean.

- [ ] **Step 8: Remove stray screenshots and commit**

`browser_take_screenshot` writes into the **repo root**, not `.playwright-mcp/`. Run `git status` and delete any stray `.png` first. Never `git add -A` — `market-research.md`, `poc/demo-plugins/` and `tour-skill-suggest.png` are permanently untracked user files and must never enter history.

```bash
git add poc/client/src/App.tsx poc/client/src/components/PartyPane.tsx \
        poc/client/src/components/Header.tsx poc/client/src/terminal.css
git commit -m "feat(client): render pulls in the party pane and header"
git diff-tree --no-commit-id --name-status -r HEAD
```

---

## Deviations

*(Implementers: record here any place the plan was wrong or a decision had to be made mid-run, with the reason. This section is why the plan is trustworthy next time.)*

### Recorded during execution (session #10)

- **Task 2 — the wire test's 300ms wait was too short, and the reason is worth knowing.** `permission_decision` *is* in the `INTERESTING` set (`server.ts:45`), so a decision does schedule a project push — but `schedulePush` throttles snapshots to `PROJECT_PUSH_INTERVAL_MS = 1000` with a *trailing* push (`server.ts:138-151`). At 300ms the test read the pre-decision snapshot and failed as though the derivation were broken. Raised to 1400ms with a comment. **Product consequence, not a bug:** a pull clears within about a second of the decision rather than instantly, which is right — the alternative is a snapshot push per permission event.
- **Task 4 — the plan's row copy was wrong, and only the browser could see it.** The plan reused the party pane's `ago()`, which appends "ago", so the row rendered `🔐 waiting 2m ago — approval to run Bash`. Both the word "waiting" and the string "2m ago" are individually correct, which is exactly why no unit test would have caught it. Fixed by adding a tested `waitedLabel(sinceMs, nowMs)` to `pulls.ts` returning a bare duration (`"under a minute"` / `"2m"`), with three tests. This is the second time in this project that driving the real UI caught something pure tests structurally could not.
- **Task 4 — clicking a pull lands on the lobby, not inside the session, when the URL carries no `&name=`.** The OTHER PARTIES row href is `?project=…&session=…` and is **pre-existing and shared with every non-pull row**, so this was left alone rather than widened into A3's scope. It does mean "drop in" is one click short of literal. If that matters, the fix belongs to whoever owns the other-parties link format, and it should change all rows at once.
- **Verified in the browser, single-port build, two sessions:** OFF by default shows nothing even with a gate pending; the threshold persists across navigation via `localStorage`; **the pull appears with no interaction at all** (gate opened 19:15:42, threshold 30s, badge and row present at 19:16:19 — the 10s tick works, which was the failure this task was written to catch); clicking navigates to the pulling session; and the pull clears after the decision (decided 19:16:57, gone by 19:17:05). A throwaway `poc/server/pullcheck.mts` harness held one gate open and auto-approved it after 75s; it was deleted afterwards.
