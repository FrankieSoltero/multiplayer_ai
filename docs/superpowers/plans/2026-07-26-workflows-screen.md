# Workflows Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, session-scoped workflows screen: the SDK's subagent/task lifecycle forwarded onto the append-only wire, derived client-side into a task list with running/finished sections and a driver-gated STOP per running task.

**Architecture:** The relay (AgentDriver) forwards the SDK's four `system` task subtypes as normalized `task_event` session events (progress throttled per task); a `stop_task` WS command appends an attributed `task_stop` event and calls the SDK's `stopTask`. The client folds both into `DerivedState.tasks` (pure, tested) and renders a `WorkflowsPanel` screen behind the v6a screen machinery (`W` hotkey, header button with running count).

**Tech Stack:** Node/TypeScript server (ws relay over `@anthropic-ai/claude-agent-sdk`), React 18 client, Vitest both sides, plain CSS (`terminal.css`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-workflows-screen-design.md`. Deviations get recorded in this plan's Deviations section at the end.
- Branch: `feature/workflows-screen` (already created, off main post-PR-#9). Never merge without the user.
- **A demo stack may be running** (`lsof -ti :3001`): editing `poc/server/` triggers tsx-watch hot reload, which kills live demo turns. Editing files is allowed (no live demo turn is in flight during implementation), but NEVER switch branches, and don't restart/kill the running processes.
- The wire stays **append-only**; all folding is client derivation (standing architecture decision). No snapshots for tasks.
- `task_stop` is appended **before** the SDK call (wire honesty). Stop is driver-only, enforced server-side.
- `progress` events are throttled per task (leading append + trailing flush, window `progressThrottleMs`, default 2000ms); `started`/`updated`/`done` are never throttled; a task's `done` supersedes and clears its pending progress.
- Server commands run from `poc/server/`: `npx vitest run <file>`, full `npx vitest run`, `npx tsc --noEmit`. Client from `poc/client/`: `npm test`, `npm run build`.
- Baselines going in: **server 123 passing, client 57 passing**, both builds clean.
- Casts at the SDK boundary only (the codebase's recorded rule for `runAgentQuery`).

---

### Task 1: wire events + relay forwarding of SDK task messages

**Files:**
- Modify: `poc/server/src/events.ts:14-36` (the `SessionEvent` union)
- Modify: `poc/server/src/agentDriver.ts` — `SdkMessage` (`:30-35`), `RunQueryResult` (`:68-75` untouched here), `AgentDriver` fields (`:168-198`), constructor (`:200-206`), `consume` (`:473-502`), `handleMessage` (`:561`)
- Test: `poc/server/test/agentDriver.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: existing `Session.append(event)`, existing `SdkMessage`/`RunQuery` fakes.
- Produces (Tasks 2-4 rely on these):
  - `SessionEvent` members:
    `{ type: "task_event"; taskId: string; subtype: "started" | "progress" | "updated" | "done"; description?: string; subagentType?: string; workflowName?: string; status?: string; summary?: string; error?: string; tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string }`
    and `{ type: "task_stop"; taskId: string; userId: string }`
  - `AgentDriver` constructor gains a 6th optional param `progressThrottleMs = 2000`.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/agentDriver.test.ts` (uses the file's existing `Session`, `AgentDriver`, `RunQuery`, `SdkMessage` imports, `wait`, and `vi`):

```ts
describe("task events (workflows)", () => {
  // SDK-shaped system messages; SdkMessage is widened in this task to carry them.
  const taskRun: RunQuery = async function* (prompts) {
    for await (const _prompt of prompts) {
      yield {
        type: "system", subtype: "task_started", task_id: "T1",
        description: "audit the repo", subagent_type: "general-purpose",
        workflow_name: "audit",
      } as SdkMessage;
      yield {
        type: "system", subtype: "task_progress", task_id: "T1",
        description: "audit the repo", last_tool_name: "Grep",
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
      } as SdkMessage;
      yield {
        type: "system", subtype: "task_updated", task_id: "T1",
        patch: { status: "running", description: "audit the repo (deep)" },
      } as SdkMessage;
      yield {
        type: "system", subtype: "task_notification", task_id: "T1",
        status: "completed", summary: "3 findings",
        usage: { total_tokens: 9000, tool_uses: 12, duration_ms: 60000 },
      } as SdkMessage;
      return;
    }
  };

  it("forwards started/progress/updated/done with normalized fields", async () => {
    const s = new Session("t1");
    const driver = new AgentDriver(s, taskRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      const tasks = s.eventsFrom(0).filter((e) => e.type === "task_event");
      expect(tasks.map((e: any) => e.subtype)).toEqual(["started", "progress", "updated", "done"]);
    });
    const [started, progress, updated, done] = s
      .eventsFrom(0)
      .filter((e) => e.type === "task_event") as any[];
    expect(started).toMatchObject({
      taskId: "T1", description: "audit the repo",
      subagentType: "general-purpose", workflowName: "audit",
    });
    expect(progress).toMatchObject({
      taskId: "T1", tokens: 1200, toolUses: 3, durationMs: 4000, lastTool: "Grep",
    });
    expect(updated).toMatchObject({ taskId: "T1", status: "running", description: "audit the repo (deep)" });
    expect(done).toMatchObject({
      taskId: "T1", status: "completed", summary: "3 findings",
      tokens: 9000, toolUses: 12, durationMs: 60000,
    });
  });

  it("throttles progress per task: leading append, trailing flush with latest values", async () => {
    const burstRun: RunQuery = async function* (prompts) {
      for await (const _prompt of prompts) {
        for (let i = 1; i <= 4; i++) {
          yield {
            type: "system", subtype: "task_progress", task_id: "T2",
            usage: { total_tokens: i * 100, tool_uses: i, duration_ms: i * 10 },
          } as SdkMessage;
        }
        // Keep the stream alive past the throttle window: normal stream end
        // flushes pending progress immediately, which would defeat the
        // inside-the-window assertion below.
        await wait(200);
        return;
      }
    };
    const s = new Session("t2");
    const driver = new AgentDriver(s, burstRun, undefined, [], undefined, 80);
    driver.sendPrompt("u1", "go");
    await wait(40); // inside the window: only the leading event so far
    expect(s.eventsFrom(0).filter((e) => e.type === "task_event").length).toBe(1);
    await vi.waitFor(() => {
      const evs = s.eventsFrom(0).filter((e) => e.type === "task_event") as any[];
      expect(evs.length).toBe(2); // leading + one trailing flush
      expect(evs[0]).toMatchObject({ tokens: 100 });
      expect(evs[1]).toMatchObject({ tokens: 400 }); // latest-wins
    });
  });

  it("done supersedes pending progress and appends immediately", async () => {
    const doneRun: RunQuery = async function* (prompts) {
      for await (const _prompt of prompts) {
        yield {
          type: "system", subtype: "task_progress", task_id: "T3",
          usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        } as SdkMessage;
        yield {
          type: "system", subtype: "task_progress", task_id: "T3",
          usage: { total_tokens: 200, tool_uses: 2, duration_ms: 20 },
        } as SdkMessage;
        yield {
          type: "system", subtype: "task_notification", task_id: "T3",
          status: "failed", summary: "exploded",
          usage: { total_tokens: 300, tool_uses: 3, duration_ms: 30 },
        } as SdkMessage;
        return;
      }
    };
    const s = new Session("t3");
    const driver = new AgentDriver(s, doneRun, undefined, [], undefined, 5000);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      const evs = s.eventsFrom(0).filter((e) => e.type === "task_event") as any[];
      expect(evs.map((e) => e.subtype)).toEqual(["progress", "done"]);
      expect(evs[1]).toMatchObject({ status: "failed", summary: "exploded", tokens: 300 });
    });
    await wait(60);
    // the pending progress (tokens: 200) was superseded — never flushed
    const evs = s.eventsFrom(0).filter((e) => e.type === "task_event") as any[];
    expect(evs.length).toBe(2);
  });

  it("ignores non-task system messages", async () => {
    const sysRun: RunQuery = async function* (prompts) {
      for await (const _prompt of prompts) {
        yield { type: "system", subtype: "init" } as SdkMessage;
        yield { type: "assistant", content: [{ type: "text", text: "hi" }] };
        return;
      }
    };
    const s = new Session("t4");
    const driver = new AgentDriver(s, sysRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "agent_text_delta")).toBe(true);
    });
    expect(s.eventsFrom(0).some((e) => e.type === "task_event")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: FAIL — the new describe's assertions find no `task_event` events (and the 6-arg constructor may type-error until implemented).

- [ ] **Step 3: Implement**

In `poc/server/src/events.ts`, extend the `SessionEvent` union (after the `plugin_change` member):

```ts
  | { type: "task_event"; taskId: string;
      subtype: "started" | "progress" | "updated" | "done";
      description?: string; subagentType?: string; workflowName?: string;
      status?: string; summary?: string; error?: string;
      tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string }
  | { type: "task_stop"; taskId: string; userId: string }
```

In `poc/server/src/agentDriver.ts`:

1. Widen `SdkMessage` (`:30-35`) with the system-task fields (all optional — the type stays the minimal read-side shape):

```ts
export interface SdkMessage {
  type: string;
  subtype?: string;
  content?: unknown[];
  message?: { content?: unknown[] };
  parent_tool_use_id?: string | null;
  // system task messages (task_started/task_progress/task_updated/task_notification)
  task_id?: string;
  description?: string;
  subagent_type?: string;
  workflow_name?: string;
  status?: string;
  summary?: string;
  last_tool_name?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  patch?: { status?: string; description?: string; error?: string };
}
```

2. Add fields to `AgentDriver` (beside `nextTaskId`, `:198`):

```ts
  // Per-task progress throttle (spec §3): leading append + trailing flush of
  // the latest pending progress. done supersedes and clears. Timers are
  // cleared when the stream dies so nothing appends after teardown.
  private pendingProgress = new Map<string, SessionEvent & { type: "task_event" }>();
  private progressTimers = new Map<string, NodeJS.Timeout>();
```

(`SessionEvent` is imported as a type from `./events.js` — extend the existing `import type { SkillInfo, TodoItem }` line to `import type { SessionEvent, SkillInfo, TodoItem }`.)

3. Constructor gains the throttle param (6th, optional):

```ts
  constructor(
    private session: Session,
    run: RunQuery = runAgentQuery,
    workdir?: string,
    pluginPaths: string[] = [],
    private onRoster?: (skills: SkillInfo[]) => void,
    private progressThrottleMs = 2000,
  ) {
```

4. At the top of `handleMessage` (`:561`, before the `blocks` extraction):

```ts
    if (message.type === "system") {
      this.handleTaskMessage(message);
      return;
    }
```

5. New private methods (place after `handleMessage`):

```ts
  /** Forward the SDK's task lifecycle onto the wire as task_event (spec §3).
   *  Non-task system subtypes are ignored. */
  private handleTaskMessage(message: SdkMessage): void {
    const taskId = message.task_id;
    if (typeof taskId !== "string" || taskId.length === 0) return;
    const usage = message.usage ?? {};
    if (message.subtype === "task_started") {
      this.session.append({
        type: "task_event", taskId, subtype: "started",
        ...(message.description ? { description: message.description } : {}),
        ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
        ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
      });
    } else if (message.subtype === "task_progress") {
      const ev: SessionEvent & { type: "task_event" } = {
        type: "task_event", taskId, subtype: "progress",
        ...(message.description ? { description: message.description } : {}),
        ...(message.summary ? { summary: message.summary } : {}),
        ...(message.last_tool_name ? { lastTool: message.last_tool_name } : {}),
        ...(usage.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
        ...(usage.tool_uses !== undefined ? { toolUses: usage.tool_uses } : {}),
        ...(usage.duration_ms !== undefined ? { durationMs: usage.duration_ms } : {}),
      };
      this.throttleProgress(taskId, ev);
    } else if (message.subtype === "task_updated") {
      const patch = message.patch ?? {};
      this.session.append({
        type: "task_event", taskId, subtype: "updated",
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(patch.error ? { error: patch.error } : {}),
      });
    } else if (message.subtype === "task_notification") {
      // Terminal: supersedes any pending progress for this task.
      const timer = this.progressTimers.get(taskId);
      if (timer) clearTimeout(timer);
      this.progressTimers.delete(taskId);
      this.pendingProgress.delete(taskId);
      this.session.append({
        type: "task_event", taskId, subtype: "done",
        ...(message.status ? { status: message.status } : {}),
        ...(message.summary ? { summary: message.summary } : {}),
        ...(usage.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
        ...(usage.tool_uses !== undefined ? { toolUses: usage.tool_uses } : {}),
        ...(usage.duration_ms !== undefined ? { durationMs: usage.duration_ms } : {}),
      });
    }
  }

  /** Leading append + trailing latest-wins flush, one window per task. */
  private throttleProgress(taskId: string, ev: SessionEvent & { type: "task_event" }): void {
    if (this.progressTimers.has(taskId)) {
      this.pendingProgress.set(taskId, ev); // latest wins
      return;
    }
    this.session.append(ev);
    this.progressTimers.set(
      taskId,
      setTimeout(() => {
        this.progressTimers.delete(taskId);
        const pending = this.pendingProgress.get(taskId);
        this.pendingProgress.delete(taskId);
        // Re-enter so the flush opens a fresh window (a follow-up burst
        // throttles again instead of appending unthrottled).
        if (pending) this.throttleProgress(taskId, pending);
      }, this.progressThrottleMs),
    );
  }

  /**
   * Stream teardown. On a normal end the pending trailing progress is real
   * data that would otherwise be silently dropped — flush it before clearing.
   * On a fatal stream error, discard: appending task telemetry after an
   * error event would misrepresent the failure order on the wire.
   */
  private clearProgressTimers(flushPending: boolean): void {
    for (const timer of this.progressTimers.values()) clearTimeout(timer);
    this.progressTimers.clear();
    if (flushPending) {
      for (const pending of this.pendingProgress.values()) this.session.append(pending);
    }
    this.pendingProgress.clear();
  }
```

6. In `consume` (`:473-502`): after the normal-end `this.dead = true;` call `this.clearProgressTimers(true);` (flush — trailing progress is real data); after the fatal-error `this.dead = true;` call `this.clearProgressTimers(false);` (discard — don't append telemetry after the error event).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts && npx tsc --noEmit`
Expected: PASS (existing + 4 new), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 127 passing (123 + 4).

```bash
git add poc/server/src/events.ts poc/server/src/agentDriver.ts poc/server/test/agentDriver.test.ts
git commit -m "feat(server): forward SDK task lifecycle as task_event wire events with progress throttle"
```

---

### Task 2: driver-gated stop path

**Files:**
- Modify: `poc/server/src/agentDriver.ts` — `RunQueryResult` (`:68-75`), new `stopTask` method (place after `setModel`, `:452-471`)
- Modify: `poc/server/src/server.ts` — new `stop_task` handler beside `set_permission_mode` (`:366-376`)
- Test: `poc/server/test/agentDriver.test.ts`, `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: Task 1's `task_stop` event member.
- Produces (Task 4 relies on the WS message): WS command `{ type: "stop_task", taskId: string }`; `AgentDriver.stopTask(taskId: string, userId: string): { ok: true } | { ok: false; error: string }`; `RunQueryResult.stopTask?(taskId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("task events (workflows)", ...)` block in `poc/server/test/agentDriver.test.ts`:

```ts
  it("stopTask appends an attributed task_stop and calls the stream's stopTask", async () => {
    const stopped: string[] = [];
    const run: RunQuery = (prompts) => {
      const gen = fakeRunStream(prompts as any) as any;
      gen.stopTask = async (taskId: string) => { stopped.push(taskId); };
      return gen;
    };
    const s = new Session("t5");
    const driver = new AgentDriver(s, run);
    const result = driver.stopTask("T9", "u1");
    expect(result.ok).toBe(true);
    await wait(20);
    expect(stopped).toEqual(["T9"]);
    const ev = s.eventsFrom(0).find((e) => e.type === "task_stop");
    expect(ev).toMatchObject({ taskId: "T9", userId: "u1" });
  });

  it("stopTask degrades silently when the stream has no stopTask", async () => {
    const s = new Session("t6");
    const driver = new AgentDriver(s, fakeRun); // fakeRun has no stopTask
    const result = driver.stopTask("T9", "u1");
    expect(result.ok).toBe(true); // attributed request still lands on the wire
    expect(s.eventsFrom(0).some((e) => e.type === "task_stop")).toBe(true);
    expect(s.eventsFrom(0).some((e) => e.type === "agent_error")).toBe(false);
  });

  it("stopTask surfaces SDK rejection as agent_error, not a throw", async () => {
    const run: RunQuery = (prompts) => {
      const gen = fakeRunStream(prompts as any) as any;
      gen.stopTask = async () => { throw new Error("no such task"); };
      return gen;
    };
    const s = new Session("t7");
    const driver = new AgentDriver(s, run);
    expect(driver.stopTask("T9", "u1").ok).toBe(true);
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "agent_error" && /no such task/.test((e as any).message))).toBe(true);
    });
  });
```

Append to `poc/server/test/server.test.ts` (inside the existing `describe("plan mode", ...)` block, after the driver-guard test at `:658-678` — same fixture idiom):

```ts
  it("guards stop_task to the current driver and appends task_stop for the driver", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const wsA = await connect(server.port);
    const seenA: any[] = [];
    collect(wsA, seenA);
    wsA.send(JSON.stringify({ type: "join", sessionId: "wf1", userId: "u1", name: "Ana" }));
    await wait(50);
    const wsB = await connect(server.port);
    const seenB: any[] = [];
    collect(wsB, seenB);
    wsB.send(JSON.stringify({ type: "join", sessionId: "wf1", userId: "u2", name: "Ben" }));
    await wait(50);
    wsB.send(JSON.stringify({ type: "stop_task", taskId: "T1" })); // watcher: rejected
    await wait(100);
    expect(seenB.some((m) => m.type === "error" && /stop tasks/.test(m.message))).toBe(true);
    expect(seenB.some((m) => m.event?.type === "task_stop")).toBe(false);
    wsA.send(JSON.stringify({ type: "stop_task", taskId: "T1" })); // driver: accepted
    await wait(100);
    expect(seenA.some((m) => m.event?.type === "task_stop" && m.event.taskId === "T1" && m.event.userId === "u1")).toBe(true);
    wsA.send(JSON.stringify({ type: "stop_task" })); // missing taskId: rejected
    await wait(100);
    expect(seenA.some((m) => m.type === "error" && /requires taskId/.test(m.message))).toBe(true);
    wsA.close();
    wsB.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts test/server.test.ts`
Expected: FAIL — `driver.stopTask is not a function`; server test sees no error/`task_stop`.

- [ ] **Step 3: Implement**

In `poc/server/src/agentDriver.ts`, add to `RunQueryResult` (`:68-75`):

```ts
  /** Present on the real SDK Query (sdk.d.ts Query.stopTask); absent on plain test fakes. */
  stopTask?(taskId: string): Promise<void>;
```

Add the method after `setModel` (`:452-471`):

```ts
  /**
   * Human-requested stop of a running SDK task (spec §4). The attributed
   * task_stop lands on the wire BEFORE the SDK call — the request is a fact
   * even if the task finishes first. Confirmation is never synthesized: the
   * SDK's own task_notification (status "stopped") flows back via
   * handleTaskMessage. Fire-and-forget like setModel: SDK rejection surfaces
   * as agent_error, an absent stopTask (fakes/old streams) is a no-op.
   */
  stopTask(
    taskId: string,
    userId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    this.session.append({ type: "task_stop", taskId, userId });
    void this.stream.stopTask?.(taskId).catch((err) =>
      this.session.append({
        type: "agent_error",
        message: `task stop failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return { ok: true };
  }
```

In `poc/server/src/server.ts`, add after the `set_permission_mode` handler (`:376`):

```ts
      if (msg.type === "stop_task") {
        if (typeof msg.taskId !== "string" || msg.taskId.length === 0) {
          return sendError("stop_task requires taskId");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can stop tasks — take the wheel first");
        }
        const result = ctx.entry.driver.stopTask(msg.taskId, ctx.userId);
        if (!result.ok) return sendError(result.error);
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts test/server.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 131 passing (127 + 4).

```bash
git add poc/server/src/agentDriver.ts poc/server/src/server.ts poc/server/test/agentDriver.test.ts poc/server/test/server.test.ts
git commit -m "feat(server): driver-gated stop_task — attributed task_stop event + SDK stopTask"
```

---

### Task 3: client derivation + taskLine formatter

**Files:**
- Modify: `poc/client/src/types.ts:1-31` (`LoggedEvent`)
- Modify: `poc/client/src/derive.ts` (`DerivedState`, `deriveState` switch)
- Create: `poc/client/src/taskLine.ts`
- Test: `poc/client/src/derive.test.ts` (new describe), `poc/client/src/taskLine.test.ts`

**Interfaces:**
- Consumes: Task 1's `task_event`/`task_stop` wire shapes.
- Produces (Task 4 relies on these):
  - `export interface TaskInfo { id: string; description: string; subagentType?: string; workflowName?: string; status: string; tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string; summary?: string; error?: string; stoppedBy?: string }` (in `derive.ts`)
  - `DerivedState.tasks: Map<string, TaskInfo>` (insertion-ordered)
  - `taskLine.ts`: `statusGlyph(status: string): string`; `usageLine(t: { tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string }): string`; `fmtTokens(n?: number): string`; `fmtDuration(ms?: number): string`

- [ ] **Step 1: Write the failing tests**

Create `poc/client/src/taskLine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { statusGlyph, usageLine, fmtTokens, fmtDuration } from "./taskLine";

describe("statusGlyph", () => {
  it("maps the lifecycle statuses", () => {
    expect(statusGlyph("running")).toBe("▶");
    expect(statusGlyph("completed")).toBe("✓");
    expect(statusGlyph("failed")).toBe("✗");
    expect(statusGlyph("stopped")).toBe("⛔");
  });

  it("falls back to a neutral glyph for unknown statuses", () => {
    expect(statusGlyph("paused")).toBe("◌");
  });
});

describe("fmtTokens / fmtDuration", () => {
  it("abbreviates thousands and dashes absent values", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(12345)).toBe("12.3k");
    expect(fmtTokens(undefined)).toBe("—");
  });

  it("formats durations as s / m s", () => {
    expect(fmtDuration(4000)).toBe("4s");
    expect(fmtDuration(65000)).toBe("1m 05s");
    expect(fmtDuration(undefined)).toBe("—");
  });
});

describe("usageLine", () => {
  it("joins tokens · tools · elapsed · last tool", () => {
    expect(usageLine({ tokens: 12345, toolUses: 7, durationMs: 65000, lastTool: "Grep" }))
      .toBe("12.3k tok · 7 tools · 1m 05s · Grep");
  });

  it("omits the last tool when absent", () => {
    expect(usageLine({ tokens: 100, toolUses: 1, durationMs: 4000 }))
      .toBe("100 tok · 1 tools · 4s");
  });
});
```

Append to `poc/client/src/derive.test.ts` (uses the file's existing `ev` helper):

```ts
describe("workflow tasks", () => {
  it("folds the task lifecycle into an ordered map", () => {
    const s = deriveState([
      ev({ type: "task_event", taskId: "T1", subtype: "started", description: "audit", subagentType: "general-purpose", workflowName: "audit" }, 0),
      ev({ type: "task_event", taskId: "T2", subtype: "started", description: "fix" }, 1),
      ev({ type: "task_event", taskId: "T1", subtype: "progress", tokens: 1200, toolUses: 3, durationMs: 4000, lastTool: "Grep" }, 2),
      ev({ type: "task_event", taskId: "T1", subtype: "done", status: "completed", summary: "3 findings", tokens: 9000, toolUses: 12, durationMs: 60000 }, 3),
    ]);
    expect([...s.tasks.keys()]).toEqual(["T1", "T2"]);
    expect(s.tasks.get("T1")).toMatchObject({
      description: "audit", subagentType: "general-purpose", workflowName: "audit",
      status: "completed", summary: "3 findings", tokens: 9000, toolUses: 12, durationMs: 60000, lastTool: "Grep",
    });
    expect(s.tasks.get("T2")).toMatchObject({ status: "running" });
  });

  it("creates a row from any subtype and keeps unknown statuses verbatim", () => {
    const s = deriveState([
      ev({ type: "task_event", taskId: "T3", subtype: "updated", status: "paused", error: "hung" }, 0),
    ]);
    expect(s.tasks.get("T3")).toMatchObject({ status: "paused", error: "hung", description: "" });
  });

  it("attributes stops via task_stop", () => {
    const s = deriveState([
      ev({ type: "task_event", taskId: "T4", subtype: "started", description: "sweep" }, 0),
      ev({ type: "task_stop", taskId: "T4", userId: "u2" }, 1),
      ev({ type: "task_event", taskId: "T4", subtype: "done", status: "stopped" }, 2),
    ]);
    expect(s.tasks.get("T4")).toMatchObject({ status: "stopped", stoppedBy: "u2" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npx vitest run src/taskLine.test.ts src/derive.test.ts`
Expected: FAIL — `./taskLine` unresolvable; `s.tasks` undefined.

- [ ] **Step 3: Implement**

In `poc/client/src/types.ts`, add to `LoggedEvent` (after `skillCount?: number;`):

```ts
  taskId?: string;
  subtype?: string;
  subagentType?: string;
  workflowName?: string;
  description?: string;
  status?: string;
  summary?: string;
  error?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastTool?: string;
```

Create `poc/client/src/taskLine.ts`:

```ts
/** Pure formatters for the workflows screen (component-test infra doesn't
 *  exist in this repo; established pattern). */

export function statusGlyph(status: string): string {
  if (status === "running") return "▶";
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "stopped") return "⛔";
  return "◌";
}

export function fmtTokens(n?: number): string {
  if (n === undefined) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtDuration(ms?: number): string {
  if (ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function usageLine(t: {
  tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string;
}): string {
  const parts = [`${fmtTokens(t.tokens)} tok`, `${t.toolUses ?? 0} tools`, fmtDuration(t.durationMs)];
  if (t.lastTool) parts.push(t.lastTool);
  return parts.join(" · ");
}
```

In `poc/client/src/derive.ts`:

1. Add the interface (after the `Participant` interface):

```ts
export interface TaskInfo {
  id: string;
  description: string;
  subagentType?: string;
  workflowName?: string;
  status: string; // "running" until updated/done says otherwise; unknown statuses kept verbatim
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastTool?: string;
  summary?: string;
  error?: string;
  stoppedBy?: string;
}
```

2. Add `tasks: Map<string, TaskInfo>;` to `DerivedState` and `tasks: new Map(),` to the initializer in `deriveState`.

3. Add the cases to the switch (after `plugin_change` handling; any subtype creates the row so out-of-order arrival degrades gracefully):

```ts
      case "task_event": {
        if (!ev.taskId) break;
        let t = s.tasks.get(ev.taskId);
        if (!t) {
          t = { id: ev.taskId, description: "", status: "running" };
          s.tasks.set(ev.taskId, t);
        }
        if (ev.description) t.description = ev.description;
        if (ev.subagentType) t.subagentType = ev.subagentType;
        if (ev.workflowName) t.workflowName = ev.workflowName;
        if (ev.status) t.status = ev.status;
        if (ev.subtype === "done" && !ev.status) t.status = "completed";
        if (ev.summary) t.summary = ev.summary;
        if (ev.error) t.error = ev.error;
        if (ev.tokens !== undefined) t.tokens = ev.tokens;
        if (ev.toolUses !== undefined) t.toolUses = ev.toolUses;
        if (ev.durationMs !== undefined) t.durationMs = ev.durationMs;
        if (ev.lastTool) t.lastTool = ev.lastTool;
        break;
      }
      case "task_stop": {
        if (!ev.taskId || !ev.userId) break;
        let t = s.tasks.get(ev.taskId);
        if (!t) {
          t = { id: ev.taskId, description: "", status: "running" };
          s.tasks.set(ev.taskId, t);
        }
        t.stoppedBy = ev.userId;
        break;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/client && npx vitest run src/taskLine.test.ts src/derive.test.ts`
Expected: PASS — 6 new taskLine `it`s, 3 new derive `it`s.

- [ ] **Step 5: Run the full client suite and commit**

Run: `cd poc/client && npm test && npm run build`
Expected: 66 passing (57 + 6 taskLine + 3 derive), build clean.

```bash
git add poc/client/src/types.ts poc/client/src/derive.ts poc/client/src/taskLine.ts poc/client/src/taskLine.test.ts poc/client/src/derive.test.ts
git commit -m "feat(client): derive workflow tasks from task_event/task_stop + taskLine formatters"
```

---

### Task 4: WorkflowsPanel screen + App/Header wiring + CSS

**Files:**
- Create: `poc/client/src/components/WorkflowsPanel.tsx`
- Modify: `poc/client/src/App.tsx` — skills-hotkey effect (`:159-175`), screen branches (`:235-256`), Header usage (`:260-276`)
- Modify: `poc/client/src/components/Header.tsx` — props (`:21-28`), SKILLS button block (`:94-100`)
- Modify: `poc/client/src/terminal.css` — new rules appended at the end
- Test: none new (no component-test infra — recorded pattern; the logic under the panel is Task 3's tested module). Verification = clean build + suite green.

**Interfaces:**
- Consumes: `TaskInfo`, `derived.tasks` (Task 3); `statusGlyph`, `usageLine` from `./taskLine` (note: `../taskLine` from `components/`); WS `{ type: "stop_task", taskId }` (Task 2); existing `Participant` map for name resolution.
- Produces: `<WorkflowsPanel tasks participants isDriver onStopTask onBack />`; Header props gain `onOpenWorkflows: () => void; runningTasks: number;`.

- [ ] **Step 1: Create `poc/client/src/components/WorkflowsPanel.tsx`**

```tsx
import type { TaskInfo, Participant } from "../derive";
import { statusGlyph, usageLine } from "../taskLine";

const RENDER_CAP = 50;

/** Session-scoped live view of the agent's fanned-out tasks (spec §6).
 *  Running rows first with a driver-only STOP; finished rows below with
 *  summary + stop attribution. Names resolve via the participants map and
 *  fall back to the raw id (a stopper may have left the session). */
export function WorkflowsPanel(props: {
  tasks: Map<string, TaskInfo>;
  participants: Map<string, Participant>;
  isDriver: boolean;
  onStopTask: (taskId: string) => void;
  onBack: () => void;
}) {
  const all = [...props.tasks.values()];
  const running = all.filter((t) => t.status === "running");
  const finishedAll = all.filter((t) => t.status !== "running");
  // Cap trims the OLDEST finished rows; running rows always render.
  const finished = finishedAll.slice(Math.max(0, finishedAll.length - (RENDER_CAP - running.length)));
  const name = (id: string) => props.participants.get(id)?.name ?? id;

  const tagLine = (t: TaskInfo) =>
    [t.subagentType, t.workflowName && `workflow: ${t.workflowName}`]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={props.onBack}>◂ BACK</button>
        <span className="pix lg">WORKFLOWS</span>
        <span className="rule" />
        <span className="pix">{running.length} RUNNING</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          <div className="pix">RUNNING</div>
          {running.length === 0 && (
            <div className="line dim">no workflows this session — the agent spawns them when work fans out.</div>
          )}
          {running.map((t) => (
            <div className="wfrow" key={t.id}>
              <span className="wfglyph run">{statusGlyph(t.status)}</span>
              <div className="wfbody">
                <div className="wfdesc">{t.description || t.id}</div>
                {tagLine(t) && <div className="wftag pix sm">{tagLine(t)}</div>}
                <div className="wfusage dim">{usageLine(t)}</div>
                {t.stoppedBy && (
                  <div className="wfstop">stop requested by {name(t.stoppedBy)}…</div>
                )}
              </div>
              {props.isDriver && (
                <button className="btn red" onClick={() => props.onStopTask(t.id)} title="stop this task">
                  ■ STOP
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="panel pix top">FINISHED</div>
        <div className="panel">
          {finished.length === 0 && <div className="line dim">nothing finished yet.</div>}
          {[...finished].reverse().map((t) => (
            <div className="wfrow" key={t.id}>
              <span className={`wfglyph ${t.status}`}>{statusGlyph(t.status)}</span>
              <div className="wfbody">
                <div className="wfdesc">{t.description || t.id}</div>
                {tagLine(t) && <div className="wftag pix sm">{tagLine(t)}</div>}
                {t.summary && <div className="wfsummary">{t.summary}</div>}
                {t.error && <div className="wfsummary red">{t.error}</div>}
                <div className="wfusage dim">
                  {usageLine(t)}
                  {t.status === "stopped" && t.stoppedBy ? ` · stopped by ${name(t.stoppedBy)}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire App.tsx**

1. Import (with the other component imports): `import { WorkflowsPanel } from "./components/WorkflowsPanel";`
2. Extend the S-hotkey effect (`:159-175`) to cover `W` and workflows-Esc — replace the effect body's two `if` statements with:

```ts
      if ((e.key === "s" || e.key === "S") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "skills" ? null : "skills");
      }
      if ((e.key === "w" || e.key === "W") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "workflows" ? null : "workflows");
      }
      if (e.key === "Escape" && (props.screen === "skills" || props.screen === "workflows")) {
        props.onScreenChange(null);
      }
```

3. Add the screen branch (immediately before the `props.screen === "status"` branch at `:254`):

```tsx
  if (props.screen === "workflows") {
    return (
      <WorkflowsPanel
        tasks={derived.tasks}
        participants={derived.participants}
        isDriver={isDriver}
        onStopTask={(taskId) => send({ type: "stop_task", taskId })}
        onBack={() => props.onScreenChange(null)}
      />
    );
  }
```

4. Compute the running count (beside `gatesPending`, after the `derived` memo):

```ts
  const runningTasks = useMemo(
    () => [...derived.tasks.values()].filter((t) => t.status === "running").length,
    [derived.tasks],
  );
```

5. Pass to Header (in the existing `<Header ... />` call): `onOpenWorkflows={() => props.onScreenChange("workflows")}` and `runningTasks={runningTasks}`.

- [ ] **Step 3: Wire Header.tsx**

Add to props (`:21-28`): `onOpenWorkflows: () => void; runningTasks: number;`

Add after the SKILLS button block (`:94-100`):

```tsx
        <button
          className={props.runningTasks > 0 ? "planmode on" : "planmode"}
          onClick={props.onOpenWorkflows}
          title="live subagent workflows (W)"
        >
          {props.runningTasks > 0 ? `▸ WORKFLOWS ▸ ${props.runningTasks}` : "▢ WORKFLOWS"}
        </button>
```

- [ ] **Step 4: CSS**

Append to `poc/client/src/terminal.css`:

```css
/* ================================================================ workflows
   Task rows on the workflows screen. Same idiom as the spellbook: chunky
   panels, pixel chrome, mono content. */
.wfrow {
  display: flex; align-items: flex-start; gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-bottom: 1px dashed var(--frame);
}
.wfrow:last-child { border-bottom: 0; }
.wfglyph { font-size: 15px; line-height: 1.2; }
.wfglyph.run { color: var(--green); }
.wfglyph.completed { color: var(--green); }
.wfglyph.failed { color: var(--red); }
.wfglyph.stopped { color: var(--gold); }
.wfbody { flex: 1; min-width: 0; }
.wfdesc { overflow-wrap: anywhere; }
.wftag { color: var(--accent); margin-top: 2px; }
.wfsummary { color: var(--fg); margin-top: 2px; overflow-wrap: anywhere; }
.wfusage { font-size: var(--fs-sm); margin-top: 2px; }
.wfstop { color: var(--gold); font-size: var(--fs-sm); margin-top: 2px; }
```

(`--green` / `--red` / `--gold` all exist in the `:root` tokens block, `terminal.css:35-40` — no new palette entries needed.)

- [ ] **Step 5: Verify build + suite, then commit**

Run: `cd poc/client && npm run build && npm test`
Expected: build clean, 66 passing (no count change).

```bash
git add poc/client/src/components/WorkflowsPanel.tsx poc/client/src/App.tsx poc/client/src/components/Header.tsx poc/client/src/terminal.css
git commit -m "feat(client): WORKFLOWS screen — live task rows, W hotkey, running-count header badge, driver STOP"
```

---

### Task 5: final verification sweep

**Files:** none created; read-only against the spec + full runs.

- [ ] **Step 1: Full suites + builds**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: **131 passing** (123 + 4 task events + 3 stop driver-level + 1 server guard = 131), tsc clean. If the count differs, find out why and record the arithmetic in Deviations.

Run: `cd poc/client && npm test && npm run build`
Expected: **66 passing** (57 + 6 + 3), build clean.

- [ ] **Step 2: Spec re-read**

Re-read `docs/superpowers/specs/2026-07-26-workflows-screen-design.md` §2-§7 against `git diff main --stat` and the shipped code. Every locked requirement (separate screen + W + Esc + header badge with running count; the four subtype mappings; progress throttle leading/trailing/done-supersedes; task_stop appended before the SDK call; driver-only enforcement server-side; optional `stopTask` on the stream; derive fold create-on-any-subtype + stop attribution; RUNNING/FINISHED sections; render cap 50 with running always shown; driver-only STOP button; empty states; transcript untouched) maps to shipped code with file:line, or gets a recorded deviation below.

- [ ] **Step 3: Commit any fixes and stop**

Stop for the user's manual demo checkpoint (fan a subagent out from the live session — e.g. prompt the agent to research something using a subagent — watch the row go running → done with live usage; stop one mid-flight and see ⛔ + attribution; check the header badge counts). NEW sessions only need nothing special — task events flow on any session whose agent spawns tasks. Do not merge; PR on user go.

---

## Deviations (recorded during execution)

- Task 4 / final review: the plan's verbatim WorkflowsPanel code showed the "no workflows this session" sentence whenever RUNNING was empty, contradicting spec §6 (screen-level empty state). Fixed post-final-review: spec sentence only when `tasks.size === 0`, else "none running." Also retitled the SKILLS button tooltip from "skills & workflows (S)" to "skills (S)" to avoid collision with the new WORKFLOWS button.
