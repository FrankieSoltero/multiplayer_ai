# v6a — Mode Cycling + Skills Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three-state permission mode (DEFAULT → AUTO → PLAN) with relay-enforced auto-approval and an `M` hotkey, plus an in-app discoverable skills screen (header button + `S` hotkey), per spec `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md`.

**Architecture:** AUTO lives entirely at the relay: `AgentDriver` tracks the mode, answers `permission_request`s itself while auto is on (appending a driver-attributed `permission_decision` with `auto: true` to the append-only wire), and sweeps pending gates when auto is entered. The SDK's own permission mode is never set to anything new — auto maps to SDK `default`. The client derives the mode from `permission_mode_change` events as today and gains a pure `nextMode` cycle helper; the `screen` URL param becomes React state so SKILLS is reachable without a reload.

**Tech Stack:** TypeScript, Node (ws server, vitest), React 18 + Vite (client, vitest), @anthropic-ai/claude-agent-sdk.

## Global Constraints

- Work on branch `feature/v6a-modes-skills` off `main`; one commit per task minimum.
- **Before editing anything under `poc/server`:** run `lsof -ti :3001` — if a live demo server is running, STOP and ask the user; tsx watch hot-reload kills live turns (documented live incident).
- Append-only wire + client derivation: never mutate or remove logged events; the client derives all state from the log.
- No fake affordances: `?screen=status` stays URL-only; every auto-approval must appear on the wire.
- Mode cycle order is fixed: `default → auto → plan → default`.
- Auto-decision attribution: gates arriving while auto is on → `session.driverId ?? "system"`; the entry sweep → the userId who set the mode (already driver-validated by the server).
- Plan approvals (`plan_request`/`resolvePlan`) are NEVER auto-approved — plan review is a human checkpoint.
- SDK casts only at the SDK boundary (existing rule in `agentDriver.ts`).
- Use `docs/` (lowercase) in all git commands — case-insensitive filesystem.
- Test baselines that must stay green: server 94 passed, client 39 passed (new tests add on top).
- Run server tests from `poc/server/`, client tests from `poc/client/`.

---

### Task 1: Server — event types + relay AUTO mode in AgentDriver

**Files:**
- Modify: `poc/server/src/events.ts:24-34`
- Modify: `poc/server/src/agentDriver.ts` (constructor hook ~line 207, `resolvePlan` ~line 362, `setPermissionMode` ~line 384, new private field + sweep method)
- Test: `poc/server/test/agentDriver.test.ts`

**Interfaces:**
- Consumes: existing `Session` (`session.driverId`, `append`), existing `RunQuery`/`DriverHooks`.
- Produces: `AgentDriver.setPermissionMode(mode: "plan" | "default" | "auto", userId: string): { ok: true } | { ok: false; error: string }` — mid-turn now allowed for all modes; `"auto"` succeeds even when the stream lacks `setPermissionMode`. Wire events: `permission_mode_change.mode` gains `"auto"`; `permission_decision` gains optional `auto?: true`. Task 2 (server handler) and Task 3 (client types) rely on exactly these shapes.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
lsof -ti :3001 && echo "STOP: live demo server running — ask the user" || true
git checkout main && git pull && git checkout -b feature/v6a-modes-skills
```

- [ ] **Step 2: Lift `waitForEvent` to module scope in the test file**

In `poc/server/test/agentDriver.test.ts`, the `waitForEvent` helper is currently defined INSIDE the `describe("driver approval gate")` block (~line 293). Move it unchanged to module scope (below the `RunQuery` fakes at the top of the file) so the new describe block below can use it:

```ts
async function waitForEvent(
  session: Session,
  type: string,
  tries = 40,
): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const ev = session.eventsFrom(0).find((e) => e.type === type);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${type}`);
}
```

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: all existing tests still PASS (pure move).

- [ ] **Step 3: Write the failing tests**

Append a new describe block to `poc/server/test/agentDriver.test.ts`:

```ts
describe("auto permission mode", () => {
  const gateRun: RunQuery = async function* (prompts, hooks) {
    for await (const _prompt of prompts) {
      const decision = await hooks.onPermissionRequest("Bash", {
        command: "npm run build",
      });
      yield {
        type: "assistant",
        content: [{ type: "text", text: `decision: ${decision}` }],
      };
      return;
    }
  };

  it("auto-allows a fresh permission request with driver attribution", async () => {
    const session = new Session("s-auto-1");
    session.join("u1", "Ana"); // first join takes the wheel → driverId = u1
    const driver = new AgentDriver(session, gateRun);
    expect(driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });
    driver.sendPrompt("u1", "build it");

    const decision = await waitForEvent(session, "permission_decision");
    expect(decision).toMatchObject({ decision: "allow", userId: "u1", auto: true });
    // the request itself still landed on the wire (no invisible bypass)
    const request = await waitForEvent(session, "permission_request");
    expect(request.requestId).toBe(decision.requestId);
    const echoed = await waitForEvent(session, "agent_text_delta");
    expect(echoed.text).toBe("decision: allow");
  });

  it("entering auto sweeps pending gates exactly once, attributed to the mode-setter", async () => {
    const session = new Session("s-auto-2");
    session.join("u1", "Ana");
    const driver = new AgentDriver(session, gateRun);
    driver.sendPrompt("u1", "build it");
    const request = await waitForEvent(session, "permission_request");

    expect(driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });
    const decision = await waitForEvent(session, "permission_decision");
    expect(decision).toMatchObject({
      requestId: request.requestId,
      decision: "allow",
      userId: "u1",
      auto: true,
    });
    // swept request is closed out — a later manual decision must be rejected
    expect(driver.resolvePermission(request.requestId, "deny", "u1")).toBe(false);
  });

  it("leaving auto restores gating", async () => {
    // A two-gate run WITH a setPermissionMode mock (leaving auto for
    // "default" forwards to the SDK, so the fake must support it):
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const twoGateRun: RunQuery = (prompts, hooks) => {
      const gen = (async function* () {
        for await (const _prompt of prompts) {
          const d1 = await hooks.onPermissionRequest("Bash", { command: "one" });
          const d2 = await hooks.onPermissionRequest("Bash", { command: "two" });
          yield {
            type: "assistant",
            content: [{ type: "text", text: `${d1},${d2}` }],
          };
          return;
        }
      })();
      return Object.assign(gen, { setPermissionMode });
    };
    const session = new Session("s-auto-3");
    session.join("u1", "Ana");
    const driver = new AgentDriver(session, twoGateRun);
    expect(driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });
    driver.sendPrompt("u1", "run both");
    await waitForEvent(session, "permission_decision"); // gate one auto-allowed

    expect(driver.setPermissionMode("default", "u1")).toEqual({ ok: true });
    // wait for gate two to be raised, then confirm it is NOT auto-decided
    const requests = async () =>
      session.eventsFrom(0).filter((e) => e.type === "permission_request");
    let tries = 40;
    while ((await requests()).length < 2 && tries-- > 0)
      await new Promise((r) => setTimeout(r, 25));
    const second = (await requests())[1];
    await new Promise((r) => setTimeout(r, 150));
    const decisions = session
      .eventsFrom(0)
      .filter((e) => e.type === "permission_decision");
    expect(decisions).toHaveLength(1); // only gate one decided so far
    expect(driver.resolvePermission(second.requestId, "allow", "u1")).toBe(true);
    const echoed = await waitForEvent(session, "agent_text_delta");
    expect(echoed.text).toBe("allow,allow");
  });

  it("does not auto-approve plan requests", async () => {
    const planRun: RunQuery = async function* (prompts, hooks) {
      for await (const _prompt of prompts) {
        const d = await hooks.onPlanRequest("my plan");
        yield {
          type: "assistant",
          content: [{ type: "text", text: `plan: ${d}` }],
        };
        return;
      }
    };
    const session = new Session("s-auto-4");
    session.join("u1", "Ana");
    const driver = new AgentDriver(session, planRun);
    expect(driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });
    driver.sendPrompt("u1", "plan something");
    const request = await waitForEvent(session, "plan_request");
    await new Promise((r) => setTimeout(r, 150));
    expect(
      session.eventsFrom(0).filter((e) => e.type === "plan_decision"),
    ).toHaveLength(0);
    expect(driver.resolvePlan(request.requestId, "approve", "u1")).toBe(true);
  });

  it("auto succeeds on fakes without setPermissionMode support", () => {
    const session = new Session("s-auto-5");
    const driver = new AgentDriver(session, fakeRun);
    expect(driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });
  });

  it("attributes to system when auto-allowing with no driver present", async () => {
    const session = new Session("s-auto-6"); // no join → driverId null
    const driver = new AgentDriver(session, gateRun);
    expect(driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });
    driver.sendPrompt("u1", "build it");
    const decision = await waitForEvent(session, "permission_decision");
    expect(decision).toMatchObject({ decision: "allow", userId: "system", auto: true });
  });
});
```

Also UPDATE two existing tests in the same file:

1. `"setPermissionMode mirrors the setModel guards and logs optimistically"` (~line 843): the mid-turn rejection is now mid-turn ACCEPTANCE. Replace the last three lines of the test:

```ts
    driver.sendPrompt("u1", "go"); // mid-turn — v6a: mode changes are allowed anytime
    expect(driver.setPermissionMode("default", "u1")).toEqual({ ok: true });
    expect(setPermissionMode).toHaveBeenLastCalledWith("default");
```

2. `"reports not-supported on fakes without setPermissionMode"` (~line 868): unchanged in behavior (plan still requires SDK support) — leave as is, just verify it still passes.

- [ ] **Step 4: Run tests to verify the new ones fail**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: the 6 new tests FAIL (mode "auto" rejected as invalid / mid-turn error), updated test FAILS; all others pass.

- [ ] **Step 5: Implement**

`poc/server/src/events.ts` — two union members change:

```ts
  | { type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string; auto?: true }
```

```ts
  | { type: "permission_mode_change"; mode: "plan" | "default" | "auto"; userId: string }
```

`poc/server/src/agentDriver.ts`:

(a) Add a field next to `pendingPermissions` (~line 175):

```ts
  // Relay-level permission mode. "auto" is enforced HERE, not in the SDK:
  // the SDK keeps streaming permission_requests and this driver answers
  // them itself, so every gate still lands on the wire (spec §2). The SDK's
  // own mode is only ever set to "plan" or "default".
  private permissionMode: "default" | "plan" | "auto" = "default";
```

(b) In the `onPermissionRequest` hook (constructor, ~line 207), insert the auto path right after `const requestId = randomUUID();`:

```ts
        if (this.permissionMode === "auto") {
          this.session.append({
            type: "permission_request",
            requestId,
            toolName,
            input,
          });
          this.session.append({
            type: "permission_decision",
            requestId,
            decision: "allow",
            userId: this.session.driverId ?? "system",
            auto: true,
          });
          return Promise.resolve("allow" as const);
        }
```

(c) Add the sweep method next to `denyAllPending`:

```ts
  /**
   * Entering auto mode: allow every still-pending permission request,
   * attributed to the driver who set the mode (server-validated). Mirrors
   * denyAllPending's delete-first shape so the abort listeners registered in
   * onPermissionRequest can never double-log (their delete() returns false).
   * Plan requests are deliberately NOT touched — plan review is a human
   * checkpoint, not a tool gate.
   */
  private allowAllPending(userId: string): void {
    for (const [requestId, resolve] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      this.session.append({
        type: "permission_decision",
        requestId,
        decision: "allow",
        userId,
        auto: true,
      });
      resolve("allow");
    }
  }
```

(d) Replace `setPermissionMode` (~line 384) entirely:

```ts
  setPermissionMode(
    mode: "plan" | "default" | "auto",
    userId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    // v6a: no mid-turn guard — flipping to auto mid-turn is how a driver
    // rescues a turn stuck on gates, and the SDK accepts setPermissionMode
    // control requests mid-turn.
    if (mode !== "auto" && !this.stream.setPermissionMode)
      return { ok: false, error: "plan mode not supported by this agent" };
    // auto maps to SDK "default": gates keep flowing, the relay answers them.
    const sdkMode = mode === "auto" ? "default" : mode;
    void this.stream.setPermissionMode?.(sdkMode).catch((err) =>
      this.session.append({
        type: "agent_error",
        message: `permission mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    this.permissionMode = mode;
    this.session.append({ type: "permission_mode_change", mode, userId });
    if (mode === "auto") this.allowAllPending(userId);
    return { ok: true };
  }
```

(e) In `resolvePlan`'s approve branch (~line 371), keep the relay mode in sync — add one line before the `permission_mode_change` append:

```ts
      this.permissionMode = "default";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, ALL tests pass (94 baseline + 6 new).

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/events.ts poc/server/src/agentDriver.ts poc/server/test/agentDriver.test.ts
git commit -m "feat(v6a): relay-enforced AUTO permission mode in AgentDriver"
```

---

### Task 2: Server — `set_permission_mode` accepts auto; e2e over the socket

**Files:**
- Modify: `poc/server/src/server.ts:331-341`
- Test: `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `AgentDriver.setPermissionMode(mode, userId)` from Task 1 (three-value union).
- Produces: wire message `{ type: "set_permission_mode", mode: "plan" | "default" | "auto" }`; driver-guard error copy becomes `"only the current driver can change the permission mode — take the wheel first"`. Task 4's client sends exactly this message.

- [ ] **Step 1: Write the failing tests**

In `poc/server/test/server.test.ts`, inside `describe("plan mode")` (~line 640), UPDATE the guard-test regex — the error copy changes:

```ts
    expect(errors.some((e) => /change the permission mode/.test(e))).toBe(true);
```

Then append a new describe block at the end of the file:

```ts
describe("auto mode (e2e)", () => {
  it("auto-approves gates end-to-end with driver attribution on the wire", async () => {
    const gateRun: RunQuery = async function* (prompts, hooks) {
      for await (const _prompt of prompts) {
        const decision = await hooks.onPermissionRequest("Bash", {
          command: "npm run build",
        });
        yield {
          type: "assistant",
          content: [{ type: "text", text: `went: ${decision}` }],
        };
      }
    };
    const server = await startServer({ port: 0, runQuery: gateRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "auto1", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "set_permission_mode", mode: "auto" }));
    ws.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(300);

    const events = seen.map((m) => m.event).filter(Boolean);
    expect(events.find((e) => e.type === "permission_mode_change")).toMatchObject({
      mode: "auto",
      userId: "u1",
    });
    expect(events.find((e) => e.type === "permission_request")).toBeTruthy();
    expect(events.find((e) => e.type === "permission_decision")).toMatchObject({
      decision: "allow",
      userId: "u1",
      auto: true,
    });
    expect(
      events.some((e) => e.type === "agent_text_delta" && e.text === "went: allow"),
    ).toBe(true);
    ws.close();
  });

  it("rejects an unknown mode", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "auto2", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "set_permission_mode", mode: "yolo" }));
    await wait(100);
    const errors = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors.some((e) => /plan\|default\|auto/.test(e))).toBe(true);
    ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: new tests FAIL ("set_permission_mode requires mode: plan|default" rejects auto); updated guard test FAILS on the old copy.

- [ ] **Step 3: Implement**

Replace the handler in `poc/server/src/server.ts:331-341`:

```ts
      if (msg.type === "set_permission_mode") {
        if (msg.mode !== "plan" && msg.mode !== "default" && msg.mode !== "auto") {
          return sendError("set_permission_mode requires mode: plan|default|auto");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can change the permission mode — take the wheel first");
        }
        const result = ctx.entry.driver.setPermissionMode(msg.mode, ctx.userId);
        if (!result.ok) return sendError(result.error);
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat(v6a): set_permission_mode accepts auto; guard copy covers all modes"
```

---

### Task 3: Client — types, derive, and the pure mode-cycle helper

**Files:**
- Modify: `poc/client/src/types.ts` (LoggedEvent)
- Modify: `poc/client/src/derive.ts:15,62-68` (DerivedState + permission_decision case)
- Create: `poc/client/src/modes.ts`
- Test: `poc/client/src/derive.test.ts`, create `poc/client/src/modes.test.ts`

**Interfaces:**
- Consumes: wire shapes from Tasks 1-2 (`auto?: true` on decisions, `mode: "auto"` on mode changes).
- Produces: `nextMode(mode: string): "default" | "auto" | "plan"` and `MODE_ORDER` from `modes.ts`; `DerivedState.permissionDecisions: Map<string, { decision: string; userId: string; auto?: boolean }>`. Tasks 4 and 6 consume both.

- [ ] **Step 1: Write the failing tests**

Create `poc/client/src/modes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextMode, MODE_ORDER } from "./modes";

describe("nextMode", () => {
  it("cycles default → auto → plan → default", () => {
    expect(nextMode("default")).toBe("auto");
    expect(nextMode("auto")).toBe("plan");
    expect(nextMode("plan")).toBe("default");
  });

  it("recovers from an unknown mode by restarting the cycle at default", () => {
    expect(nextMode("yolo")).toBe("default");
  });

  it("exposes the canonical order for UI labels", () => {
    expect(MODE_ORDER).toEqual(["default", "auto", "plan"]);
  });
});
```

Append to `describe("deriveState")` in `poc/client/src/derive.test.ts` (uses the existing `ev` helper):

```ts
  it("tracks auto permission mode and auto-marked decisions", () => {
    const s = deriveState([
      ev({ type: "permission_mode_change", mode: "auto", userId: "u1" }, 0),
      ev({ type: "permission_request", requestId: "r9", toolName: "Bash", input: {} }, 1),
      ev({ type: "permission_decision", requestId: "r9", decision: "allow", userId: "u1", auto: true }, 2),
    ]);
    expect(s.permissionMode).toBe("auto");
    expect(s.permissionDecisions.get("r9")).toEqual({ decision: "allow", userId: "u1", auto: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npx vitest run src/modes.test.ts src/derive.test.ts`
Expected: modes.test FAILS (module not found); derive test FAILS (`auto` not carried into the map).

- [ ] **Step 3: Implement**

Create `poc/client/src/modes.ts`:

```ts
/** Canonical permission-mode cycle (v6a spec §1): DEFAULT → AUTO → PLAN.
 *  Pure so the M hotkey and the header button share one tested source of
 *  truth. An unknown mode restarts the cycle at "default" (indexOf -1 + 1
 *  lands on index 0) rather than throwing on a malformed wire value. */
export const MODE_ORDER = ["default", "auto", "plan"] as const;
export type PermissionMode = (typeof MODE_ORDER)[number];

export function nextMode(mode: string): PermissionMode {
  const i = MODE_ORDER.indexOf(mode as PermissionMode);
  return MODE_ORDER[(i + 1) % MODE_ORDER.length];
}
```

In `poc/client/src/types.ts`, add to `LoggedEvent` (after `mode?: string;`):

```ts
  auto?: boolean;
```

In `poc/client/src/derive.ts`:

Line 15, the map type in `DerivedState`:

```ts
  permissionDecisions: Map<string, { decision: string; userId: string; auto?: boolean }>;
```

The `permission_decision` case (~line 62):

```ts
      case "permission_decision":
        if (ev.requestId && ev.decision && ev.userId)
          s.permissionDecisions.set(ev.requestId, {
            decision: ev.decision,
            userId: ev.userId,
            ...(ev.auto ? { auto: true } : {}),
          });
        break;
```

(The conditional spread keeps non-auto entries exactly `{ decision, userId }`, so the existing test at the top of the file that `toEqual`s that shape still passes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/client && npm test`
Expected: all pass (39 baseline + 4 new).

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/modes.ts poc/client/src/modes.test.ts poc/client/src/types.ts poc/client/src/derive.ts poc/client/src/derive.test.ts
git commit -m "feat(v6a): client mode-cycle helper + auto-marked decisions in derive"
```

---

### Task 4: Client — header MODE control, M hotkey, AUTO styling

**Files:**
- Modify: `poc/client/src/components/Header.tsx:21-82`
- Modify: `poc/client/src/App.tsx` (SessionView: replace plan wiring ~lines 100-101, 175-177, 213-227; add M-hotkey effect)
- Modify: `poc/client/src/terminal.css` (one static rule near the existing `.planmode` rules)

**Interfaces:**
- Consumes: `nextMode` from Task 3; `derived.permissionMode`; wire message from Task 2.
- Produces: Header props change — `planMode/canTogglePlan/onTogglePlan` are REPLACED by `permissionMode: string; canCycleMode: boolean; onCycleMode: () => void`. Task 5 modifies the same two files afterward and must build on these names.

No component-test infra exists (standing project constraint) — the cycle logic is already unit-tested via `modes.ts`; this task is wiring, verified by typecheck + build + the manual step.

- [ ] **Step 1: Update Header.tsx**

Replace the plan-mode props in the `Header` signature:

```ts
  permissionMode: string; canCycleMode: boolean; onCycleMode: () => void;
```

(delete `planMode: boolean; canTogglePlan: boolean; onTogglePlan: () => void;`).

Replace the PLAN `<button>` (lines 55-66) with:

```tsx
        <button
          className={
            props.permissionMode === "auto"
              ? "planmode auto on"
              : props.permissionMode === "plan"
                ? "planmode on"
                : "planmode"
          }
          disabled={!props.canCycleMode}
          onClick={props.onCycleMode}
          title={
            props.canCycleMode
              ? props.permissionMode === "auto"
                ? "AUTO: permission gates self-approve — every decision still lands on the wire. Click or press M to cycle."
                : props.permissionMode === "plan"
                  ? "PLAN: the agent must present a plan for approval before acting. Click or press M to cycle."
                  : "DEFAULT: gates ask the driver. Click or press M to cycle."
              : "only the driver can change the permission mode — take the wheel first"
          }
        >
          {props.permissionMode === "auto"
            ? "⚡ MODE: AUTO"
            : props.permissionMode === "plan"
              ? "◉ MODE: PLAN"
              : "▢ MODE: DEFAULT"}
        </button>
```

- [ ] **Step 2: Add the AUTO styling to terminal.css**

Directly after the existing `.planmode`/`.planmode.on` rules (search for `.planmode`), add:

```css
/* v6a: AUTO mode is loud on purpose — gates self-approve while it's on
   (spec §7: this visibility is load-bearing, not decoration). */
.planmode.auto.on { border-color: var(--amber); color: var(--amber); background: var(--amber-wash); }
```

Static rule only — respect the standing animation-ordering constraint (no new animations).

- [ ] **Step 3: Rewire App.tsx**

In `SessionView`:

Add the import at the top of the file:

```ts
import { nextMode } from "./modes";
```

Replace lines 100-101 (`const planMode = ...; const canTogglePlan = ...;`) with:

```ts
  const permissionMode = derived.permissionMode;
  // v6a: driver can cycle anytime, including mid-turn (rescues gate-stuck turns)
  const canCycleMode = isDriver;
```

Replace `onTogglePlan` (lines 175-177) with:

```ts
  function onCycleMode() {
    send({ type: "set_permission_mode", mode: nextMode(permissionMode) });
  }
```

In the `<Header ...>` call, replace the three plan props with:

```tsx
        permissionMode={permissionMode}
        canCycleMode={canCycleMode}
        onCycleMode={onCycleMode}
```

Add the M-hotkey effect directly below the existing A-hotkey effect (which ends at line 133), mirroring its guard style:

```ts
  // "M" cycles the permission mode (driver only, works even while the agent
  // is busy — that's the point: flipping to AUTO rescues a gate-stuck turn).
  // Same keyboard etiquette as "A": never while typing, never while an
  // arcade run has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "m" || e.key === "M") && isDriver && !arcadeCapturing) {
        e.preventDefault();
        send({ type: "set_permission_mode", mode: nextMode(permissionMode) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDriver, arcadeCapturing, permissionMode, send]);
```

- [ ] **Step 4: Verify**

Run: `cd poc/client && npm test && npm run build`
Expected: tests pass, build clean (typecheck catches any missed prop rename).

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/components/Header.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(v6a): three-state MODE control in header + M hotkey, amber AUTO styling"
```

---

### Task 5: Client — skills screen discoverable (state, SKILLS button, S/Esc, back affordance)

**Files:**
- Modify: `poc/client/src/App.tsx` (App: screen state ~lines 23-26, 55; SessionView: skills branch ~lines 193-205, S/Esc effect, A/M hotkey main-screen guard)
- Modify: `poc/client/src/components/Header.tsx` (SKILLS button after the ARCADE button)
- Modify: `poc/client/src/components/SkillsPanel.tsx` (onBack prop + button)

**Interfaces:**
- Consumes: Header/App shapes as left by Task 4.
- Produces: `App` owns `screen: string | null` state; `SessionView` gains props `screen: string | null; onScreenChange: (s: string | null) => void`; `Header` gains `onOpenSkills: () => void`; `SkillsPanel` gains `onBack?: () => void`.

- [ ] **Step 1: Lift screen into state in App**

In `App()` (line 26), replace `const screen = params.get("screen");` with:

```ts
  // v6a: screen is state seeded by ?screen= — deep links keep working, but
  // SKILLS is reachable in-app without a reload. ?screen=status stays a
  // URL-only design surface (no nav points at it).
  const [screen, setScreen] = useState<string | null>(() => params.get("screen"));
```

Pass both down (line 55):

```tsx
          <SessionView userId={userId} sessionId={sessionId} projectId={projectId} profile={profile} screen={screen} onScreenChange={setScreen} />
```

Update `SessionView`'s props type: change `screen: string | null;` to:

```ts
  screen: string | null;
  onScreenChange: (screen: string | null) => void;
```

- [ ] **Step 2: S/Esc hotkeys + guards in SessionView**

Add below the M-hotkey effect from Task 4:

```ts
  // "S" toggles the skills screen; Esc always returns to the session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "s" || e.key === "S") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "skills" ? null : "skills");
      }
      if (e.key === "Escape" && props.screen === "skills") {
        props.onScreenChange(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.screen, props.onScreenChange, arcadeCapturing]);
```

Then scope the A and M hotkeys to the main screen so they can't act invisibly from the skills screen — add `props.screen === null` (as `screen == null` truth: use `props.screen === null`) to their trigger conditions:

- A-effect condition (line 123-126) gains `&& props.screen === null` (and `props.screen` joins its dep array).
- M-effect condition from Task 4 gains `&& props.screen === null` (and `props.screen` joins its dep array).

- [ ] **Step 3: Wire the skills branch + SkillsPanel back affordance**

In `SessionView`'s skills early-return (line 198), pass the back handler:

```tsx
      <SkillsPanel
        sessions={projectSessions}
        sessionId={sessionId}
        roster={derived.skills}
        subruns={subruns}
        onBack={() => props.onScreenChange(null)}
      />
```

In `SkillsPanel.tsx`, add to the props type:

```ts
  onBack?: () => void;
```

and render a back button at the end of the `screen-head` div (after the dim tagline span):

```tsx
        {props.onBack && (
          <button className="btn" onClick={props.onBack} title="back to the session (S or Esc)">
            ⮐ BACK [S]
          </button>
        )}
```

- [ ] **Step 4: SKILLS button in the header**

In `Header.tsx`, add to the props type:

```ts
  onOpenSkills: () => void;
```

and add after the ARCADE button (line 78):

```tsx
        <button
          className="planmode"
          onClick={props.onOpenSkills}
          title="skills & workflows (S)"
        >
          ▢ SKILLS
        </button>
```

In `App.tsx`'s `<Header ...>` call, add:

```tsx
        onOpenSkills={() => props.onScreenChange("skills")}
```

- [ ] **Step 5: Verify**

Run: `cd poc/client && npm test && npm run build`
Expected: tests pass, build clean.

Manual check (only if the demo stack is already safe to run — client is HMR-safe, do NOT restart the server): open `http://localhost:5173/?project=default&session=demo&name=check` — SKILLS button opens the panel without a reload, `S` toggles it, `Esc` returns, BACK button works, `?screen=skills` deep link still lands on the panel, and from the skills screen `A` does NOT open the arcade.

- [ ] **Step 6: Commit**

```bash
git add poc/client/src/App.tsx poc/client/src/components/Header.tsx poc/client/src/components/SkillsPanel.tsx
git commit -m "feat(v6a): skills screen discoverable — header button, S/Esc, in-app state"
```

---

### Task 6: Client — transcript rendering for AUTO decisions and mode changes

**Files:**
- Modify: `poc/client/src/components/Transcript.tsx:139-142` (perm-outcome), `:233-238` (permission_mode_change line)

**Interfaces:**
- Consumes: `permissionDecisions` map values with `auto?: boolean` (Task 3).
- Produces: rendering only — no new exports.

- [ ] **Step 1: Render the AUTO outcome on gate cards**

In the `permission_request` case, replace the decided outcome div (lines 139-143):

```tsx
            {decided ? (
              <div className="perm-outcome">
                {decided.auto ? (
                  <span style={{ color: "var(--amber)" }}>
                    ⚡ auto-approved · AUTO set by {nameOf(decided.userId)}
                  </span>
                ) : (
                  <>
                    {decided.decision === "allow" ? "✅ approved" : "⛔ denied"} by {nameOf(decided.userId)}
                  </>
                )}
              </div>
            ) : props.isDriver && ev.requestId ? (
```

(`nameOf("system")` renders "system" — correct for the no-driver edge.)

- [ ] **Step 2: Generalize the mode-change transcript line**

Replace the `permission_mode_change` case (lines 233-238):

```tsx
      case "permission_mode_change":
        return (
          <div
            key={ev.seq}
            className="line gold"
            style={ev.mode === "auto" ? { color: "var(--amber)" } : undefined}
          >
            ✦ {nameOf(ev.userId)} set permission mode to {(ev.mode ?? "default").toUpperCase()}
            {ev.mode === "auto" && " — gates self-approve until it's switched off"}
          </div>
        );
```

- [ ] **Step 3: Verify and commit**

Run: `cd poc/client && npm test && npm run build`
Expected: pass, clean.

```bash
git add poc/client/src/components/Transcript.tsx
git commit -m "feat(v6a): transcript renders auto-approved gates and three-state mode changes"
```

---

### Task 7: Full verification

**Files:**
- No source changes expected; fixes only if verification fails.

- [ ] **Step 1: Full server suite**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; ≥100 tests pass (94 baseline + Task 1-2 additions), 0 failures.

- [ ] **Step 2: Full client suite + build**

Run: `cd poc/client && npm test && npm run build`
Expected: ≥43 tests pass (39 baseline + Task 3 additions), clean build.

- [ ] **Step 3: Spec conformance skim**

Re-read `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md` §2-§6 against the diff (`git diff main --stat` and spot-check each bullet). Every spec requirement must map to landed code; note any deliberate deviation in the plan file under a "Deviations" heading (create it only if needed).

- [ ] **Step 4: Commit any fixes and stop**

```bash
git add -A && git commit -m "chore(v6a): verification fixes" # only if anything changed
```

Then follow superpowers:finishing-a-development-branch (PR against main, same no-ff merge style as PRs #2-#4).

## Deviations (recorded during execution)

- **"Leaving auto restores gating" test restructured** (commit d76b44f): the plan's single-prompt two-gate version was non-deterministic — relay auto-approval resolves synchronously, so the fake's second gate fired before the mode could flip back. Replaced with a two-prompt structure (gate 1 under auto, mode flip, gate 2 on a second prompt stays pending). Controller-authorized.
- **⚡ AUTO gate-card marker renders the driver's name, not glyph** (spec §3 said "with the driver's glyph beside it"): plan's Task 6 code block used `nameOf`, consistent with every other decision line in the transcript. Accepted as spec drift at final review.
