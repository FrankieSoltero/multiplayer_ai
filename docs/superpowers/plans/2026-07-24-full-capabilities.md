# Full Claude Code Capabilities + Driver Approval Gate (v3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give per-session agents the full Claude Code tool set (Bash, Task, WebSearch/WebFetch, TodoWrite, project-scoped Skills), with non-trivial tool calls gated by a driver Approve/Deny flow that the whole session sees.

**Architecture:** The Agent SDK's `canUseTool` callback pauses any tool call not auto-approved by `allowedTools`; trivially-safe Bash prefixes auto-approve, everything else becomes a `permission_request` event in the shared session log. The driving user's client renders Approve/Deny; the server validates the decider is the CURRENT driver at decision time and resolves the pending promise on the `AgentDriver`. Skills come from the demo project's own `.claude/skills/` (versioned with the code), keeping the v2 isolation (`settingSources: []`, `strictMcpConfig: true`) intact.

**Tech Stack:** Node 20+, TypeScript, `@anthropic-ai/claude-agent-sdk` (installed version's `sdk.d.ts` is authoritative), `ws`, vitest, React + Vite client.

**Spec:** `docs/superpowers/specs/2026-07-24-full-capabilities-design.md`

## Global Constraints

- Branch: continue on `feature/project-hub` (v2 + write-access commits already there). Do NOT create a new branch.
- All 31 existing server tests must pass unmodified after every task (`cd poc/server && npx vitest run`).
- Existing fake `RunQuery` functions in tests stay assignable — fewer-params functions are assignable in TS; do NOT "fix" them to accept new hook fields they don't use.
- Casts at the SDK boundary only (`runAgentQuery` / `buildCanUseTool`); everywhere else strict types.
- SDK facts (verified in `poc/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):
  - `canUseTool?: CanUseTool` at options level (line ~1361). `CanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; requestId: string; ... }) => Promise<PermissionResult | null>` (lines ~206–266). **Never return `null`** — the doc says fail-closed: null means the tool stays blocked forever. Always return a `PermissionResult`.
  - `PermissionResult` (line ~2095) = `{ behavior: 'allow'; ... }` | `{ behavior: 'deny'; message: string; interrupt?: boolean; ... }`.
  - `tools?: string[] | { type: 'preset'; preset: 'claude_code' }` (line ~1413).
  - `skills?: string[] | 'all'` (line ~1914). Enabling skills via this option also enables the `Skill` tool — do NOT add `'Skill'` to `allowedTools` manually.
- Auto-approve Bash prefixes (configurable const, exactly these): `npx vitest`, `npx tsc`, `npm test`, `git status`, `git diff`, `git log`. Prefix match on the Bash `command` input only, with a word boundary (exact match or next char is a space).
- New session events: `permission_request { requestId, toolName, input }`, `permission_decision { requestId, decision: "allow" | "deny", userId }`. New wire message from client: `{ type: "permission", requestId, decision }`.
- `Docs/` == `docs/` on this macOS FS — always write lowercase `docs/`.
- Commit after every task with a conventional-commit message ending in the standard Claude co-author trailer.

## File Structure

- `poc/server/src/permissions.ts` (NEW) — all permission-gate logic that doesn't need the `AgentDriver` instance: the allowlist const, `isAutoApprovedBash`, and `buildCanUseTool` (Task 2). Imports `DriverHooks` type-only from `agentDriver.ts` (type-only, so no runtime cycle).
- `poc/server/src/events.ts` — union gains the two permission events.
- `poc/server/src/agentDriver.ts` — `DriverHooks` gains `onPermissionRequest` + optional `onPermissionError`; `AgentDriver` gains a pending-permissions map and `resolvePermission()`; `runAgentQuery` options gain `canUseTool`, full tool preset, `skills`, updated system prompt.
- `poc/server/src/server.ts` — `{ type: "permission" }` wire handler; `INTERESTING` gains the two permission events.
- `poc/client/src/App.tsx` + `App.css` — permission request card with Approve/Deny, decision rendering.
- `poc/scripts/demo-setup.sh` — demo repo gains `.claude/skills/auth-migration-guide/SKILL.md` (committed BEFORE worktrees are created so both worktrees contain it).
- `README.md` (repo root) — v3 demo section.

---

### Task 1: Bash allowlist matcher + permission event types

*Recommended implementer model: haiku (all code given verbatim).*

**Files:**
- Create: `poc/server/src/permissions.ts`
- Create: `poc/server/test/permissions.test.ts`
- Modify: `poc/server/src/events.ts` (9-line union, append two members before `intent_update`'s line ends the union)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AUTO_APPROVED_BASH_PREFIXES: string[]`, `isAutoApprovedBash(command: string): boolean` (Task 2 imports both); `SessionEvent` union members `{ type: "permission_request"; requestId: string; toolName: string; input: unknown }` and `{ type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string }` (Tasks 2–4 rely on these exact field names).

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAutoApprovedBash } from "../src/permissions.js";

describe("isAutoApprovedBash", () => {
  it("approves exact allowlisted commands", () => {
    expect(isAutoApprovedBash("git status")).toBe(true);
    expect(isAutoApprovedBash("git log")).toBe(true);
    expect(isAutoApprovedBash("npm test")).toBe(true);
  });

  it("approves allowlisted prefixes followed by arguments", () => {
    expect(isAutoApprovedBash("npx vitest run")).toBe(true);
    expect(isAutoApprovedBash("npx tsc --noEmit")).toBe(true);
    expect(isAutoApprovedBash("git diff --stat HEAD~1")).toBe(true);
  });

  it("rejects prefix look-alikes without a word boundary", () => {
    expect(isAutoApprovedBash("git logger")).toBe(false);
    expect(isAutoApprovedBash("npm testx")).toBe(false);
  });

  it("rejects everything else", () => {
    expect(isAutoApprovedBash("rm -rf /")).toBe(false);
    expect(isAutoApprovedBash("npm install left-pad")).toBe(false);
    expect(isAutoApprovedBash("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/permissions.test.ts`
Expected: FAIL — cannot resolve `../src/permissions.js`.

- [ ] **Step 3: Write the implementation**

Create `poc/server/src/permissions.ts`:

```ts
/**
 * Driver approval gate — pure logic (no AgentDriver instance needed).
 *
 * `allowedTools` auto-approves the read/write file tools and set_intent;
 * every OTHER tool call reaches the SDK's `canUseTool` callback. Bash
 * commands matching one of these prefixes are trivially safe (tests, type
 * checks, read-only git) and auto-approve so agents can verify their own
 * work without pausing the session; everything else asks the driver.
 */
export const AUTO_APPROVED_BASH_PREFIXES = [
  "npx vitest",
  "npx tsc",
  "npm test",
  "git status",
  "git diff",
  "git log",
];

export function isAutoApprovedBash(command: string): boolean {
  return AUTO_APPROVED_BASH_PREFIXES.some(
    (prefix) =>
      command === prefix ||
      (command.startsWith(prefix) && command[prefix.length] === " "),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd poc/server && npx vitest run test/permissions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the permission events to the union**

In `poc/server/src/events.ts`, the union currently ends with:

```ts
  | { type: "agent_error"; message: string }
  | { type: "intent_update"; text: string };
```

Replace those two lines with:

```ts
  | { type: "agent_error"; message: string }
  | { type: "intent_update"; text: string }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string };
```

- [ ] **Step 6: Full verification**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 35 tests pass (31 existing + 4 new), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/permissions.ts poc/server/test/permissions.test.ts poc/server/src/events.ts
git commit -m "feat: bash auto-approve allowlist + permission event types"
```

---

### Task 2: AgentDriver permission gate + full tool preset + skills

*Recommended implementer model: sonnet (SDK boundary judgment).*

**Files:**
- Modify: `poc/server/src/permissions.ts` (append `buildCanUseTool`)
- Modify: `poc/server/src/agentDriver.ts:32-35` (DriverHooks), `:68-106` (runAgentQuery options), `:108-146` (AgentDriver fields/ctor/methods)
- Test: `poc/server/test/permissions.test.ts`, `poc/server/test/agentDriver.test.ts` (append; never modify existing tests)

**Interfaces:**
- Consumes: `isAutoApprovedBash` from Task 1; `SessionEvent` permission members from Task 1.
- Produces:
  - `DriverHooks.onPermissionRequest: (toolName: string, input: unknown) => Promise<"allow" | "deny">` (required) and `DriverHooks.onPermissionError?: (message: string) => void` (optional).
  - `buildCanUseTool(hooks: DriverHooks): CanUseTool` exported from `permissions.ts`.
  - `AgentDriver.resolvePermission(requestId: string, decision: "allow" | "deny", userId: string): boolean` — Task 3's server handler calls this; returns `false` for unknown/already-decided requestIds.

- [ ] **Step 1: Write the failing tests for buildCanUseTool**

Append to `poc/server/test/permissions.test.ts`:

```ts
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { buildCanUseTool } from "../src/permissions.js";
import type { DriverHooks } from "../src/agentDriver.js";

function fakeHooks(decision: "allow" | "deny" | "hang" | "throw") {
  const calls: { toolName: string; input: unknown }[] = [];
  const errors: string[] = [];
  const hooks: DriverHooks = {
    onIntent: () => {},
    onPermissionError: (m) => errors.push(m),
    onPermissionRequest: (toolName, input) => {
      calls.push({ toolName, input });
      if (decision === "hang") return new Promise<never>(() => {});
      if (decision === "throw") return Promise.reject(new Error("boom"));
      return Promise.resolve(decision);
    },
  };
  return { hooks, calls, errors };
}

function opts(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    toolUseID: "t1",
    requestId: "cr1",
  } as Parameters<CanUseTool>[2];
}

describe("buildCanUseTool", () => {
  it("auto-approves allowlisted Bash without asking the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    const result = await buildCanUseTool(hooks)("Bash", { command: "git status" }, opts());
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("routes non-allowlisted Bash to the driver and maps allow", async () => {
    const { hooks, calls } = fakeHooks("allow");
    const result = await buildCanUseTool(hooks)("Bash", { command: "rm -rf build" }, opts());
    expect(result).toEqual({ behavior: "allow" });
    expect(calls).toEqual([{ toolName: "Bash", input: { command: "rm -rf build" } }]);
  });

  it("routes non-Bash tools to the driver and maps deny with a message", async () => {
    const { hooks, calls } = fakeHooks("deny");
    const result = await buildCanUseTool(hooks)("WebSearch", { query: "x" }, opts());
    expect(result?.behavior).toBe("deny");
    expect(result && "message" in result && result.message.length > 0).toBe(true);
    expect(calls[0].toolName).toBe("WebSearch");
  });

  it("denies (never null) when the hook rejects, and reports the error", async () => {
    const { hooks, errors } = fakeHooks("throw");
    const result = await buildCanUseTool(hooks)("Bash", { command: "rm -rf build" }, opts());
    expect(result?.behavior).toBe("deny");
    expect(errors.some((m) => m.includes("boom"))).toBe(true);
  });

  it("denies when the abort signal fires while the request is pending", async () => {
    const { hooks } = fakeHooks("hang");
    const controller = new AbortController();
    const pending = buildCanUseTool(hooks)("Bash", { command: "rm -rf build" }, opts(controller.signal));
    controller.abort();
    const result = await pending;
    expect(result?.behavior).toBe("deny");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/permissions.test.ts`
Expected: FAIL — `buildCanUseTool` is not exported; `onPermissionRequest` not in `DriverHooks`.

- [ ] **Step 3: Extend DriverHooks and implement buildCanUseTool**

In `poc/server/src/agentDriver.ts`, replace the `DriverHooks` interface (lines 32–35) with:

```ts
export interface DriverHooks {
  onIntent: (text: string) => void;
  /**
   * Ask the session's current driver to approve a tool call. Resolves when
   * a driver decides via AgentDriver.resolvePermission — possibly a
   * DIFFERENT user than when the request was raised (wheel handoffs are a
   * feature: a teammate can drop in specifically to approve something).
   * The promise intentionally has no timeout; the agent waits.
   */
  onPermissionRequest: (
    toolName: string,
    input: unknown,
  ) => Promise<"allow" | "deny">;
  /** Surface a permission-flow failure into the session log (agent_error). */
  onPermissionError?: (message: string) => void;
  workdir?: string;
}
```

Append to `poc/server/src/permissions.ts`:

```ts
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { DriverHooks } from "./agentDriver.js";

/**
 * Bridge the SDK's canUseTool callback to the driver-approval hook.
 * MUST always resolve to a PermissionResult — returning null tells the SDK
 * "the response was sent out-of-band" and blocks the tool forever
 * (fail-closed; see sdk.d.ts CanUseTool docs). Abort or hook failure
 * therefore maps to an explicit deny.
 */
export function buildCanUseTool(hooks: DriverHooks): CanUseTool {
  return async (toolName, input, options) => {
    const command = (input as { command?: unknown }).command;
    if (toolName === "Bash" && typeof command === "string" && isAutoApprovedBash(command)) {
      return { behavior: "allow" };
    }
    try {
      const decision = await Promise.race([
        hooks.onPermissionRequest(toolName, input),
        abortsToDeny(options.signal),
      ]);
      if (decision === "allow") return { behavior: "allow" };
      return {
        behavior: "deny",
        message:
          "The driving teammate denied this tool call. Adapt your approach, or explain in your reply what you need and why.",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hooks.onPermissionError?.(`permission flow failed: ${message}`);
      return { behavior: "deny", message: `permission flow failed: ${message}` };
    }
  };
}

function abortsToDeny(signal: AbortSignal): Promise<"deny"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("deny");
    signal.addEventListener("abort", () => resolve("deny"), { once: true });
  });
}
```

Note the import placement: keep all imports at the top of `permissions.ts` (move them above the existing const if appending naively would put imports mid-file).

- [ ] **Step 4: Run the buildCanUseTool tests**

Run: `cd poc/server && npx vitest run test/permissions.test.ts`
Expected: PASS. (`npx tsc --noEmit` will still fail — `AgentDriver`'s ctor doesn't provide the new required hook yet. That's Step 5.)

- [ ] **Step 5: Write the failing AgentDriver tests**

Append to `poc/server/test/agentDriver.test.ts` (reuse the file's existing `Session` import and wait patterns):

```ts
describe("driver approval gate", () => {
  const permissionRun: RunQuery = async function* (prompts, hooks) {
    for await (const _prompt of prompts) {
      const decision = await hooks.onPermissionRequest("Bash", {
        command: "rm -rf build",
      });
      yield {
        type: "assistant",
        content: [{ type: "text", text: `decision: ${decision}` }],
      };
    }
  };

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

  it("logs permission_request, resolves allow, and logs the decision", async () => {
    const session = new Session("s-perm-1");
    const driver = new AgentDriver(session, permissionRun);
    driver.sendPrompt("u1", "clean the build dir");

    const request = await waitForEvent(session, "permission_request");
    expect(request.toolName).toBe("Bash");
    expect(request.input).toEqual({ command: "rm -rf build" });
    expect(typeof request.requestId).toBe("string");

    expect(driver.resolvePermission(request.requestId, "allow", "u1")).toBe(true);

    const decision = await waitForEvent(session, "permission_decision");
    expect(decision).toMatchObject({
      requestId: request.requestId,
      decision: "allow",
      userId: "u1",
    });
    const echoed = await waitForEvent(session, "agent_text_delta");
    expect(echoed.text).toBe("decision: allow");
  });

  it("passes deny through to the waiting query", async () => {
    const session = new Session("s-perm-2");
    const driver = new AgentDriver(session, permissionRun);
    driver.sendPrompt("u1", "clean the build dir");
    const request = await waitForEvent(session, "permission_request");
    expect(driver.resolvePermission(request.requestId, "deny", "u2")).toBe(true);
    const echoed = await waitForEvent(session, "agent_text_delta");
    expect(echoed.text).toBe("decision: deny");
  });

  it("rejects unknown and already-decided requestIds", async () => {
    const session = new Session("s-perm-3");
    const driver = new AgentDriver(session, permissionRun);
    expect(driver.resolvePermission("nope", "allow", "u1")).toBe(false);

    driver.sendPrompt("u1", "go");
    const request = await waitForEvent(session, "permission_request");
    expect(driver.resolvePermission(request.requestId, "allow", "u1")).toBe(true);
    expect(driver.resolvePermission(request.requestId, "deny", "u1")).toBe(false);
    // exactly one decision event
    const decisions = session
      .eventsFrom(0)
      .filter((e) => e.type === "permission_decision");
    expect(decisions.length).toBe(1);
  });
});
```

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: FAIL — `resolvePermission` doesn't exist; tsc error on missing hook.

- [ ] **Step 6: Implement the AgentDriver side**

In `poc/server/src/agentDriver.ts`:

Add to the imports: `import { randomUUID } from "node:crypto";` and `import { buildCanUseTool } from "./permissions.js";`

In class `AgentDriver`, add a field next to `toolNamesById`:

```ts
  private pendingPermissions = new Map<string, (d: "allow" | "deny") => void>();
```

Replace the constructor's hooks object (currently `{ onIntent: ..., workdir }`) with:

```ts
      run(this.prompts, {
        onIntent: (text) =>
          this.session.append({ type: "intent_update", text: text.slice(0, 200) }),
        onPermissionRequest: (toolName, input) => {
          const requestId = randomUUID();
          // Register the resolver BEFORE appending, so a subscriber that
          // decides synchronously on seeing the event still finds it.
          const pending = new Promise<"allow" | "deny">((resolve) =>
            this.pendingPermissions.set(requestId, resolve),
          );
          this.session.append({
            type: "permission_request",
            requestId,
            toolName,
            input,
          });
          return pending;
        },
        onPermissionError: (message) =>
          this.session.append({ type: "agent_error", message }),
        workdir,
      }),
```

Add a public method after `sendPrompt`:

```ts
  /**
   * Resolve a pending permission request. Validated by the caller (server)
   * to be the session's CURRENT driver — which may be a different user than
   * when the request was raised. Returns false for unknown or
   * already-decided requestIds.
   */
  resolvePermission(
    requestId: string,
    decision: "allow" | "deny",
    userId: string,
  ): boolean {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    this.session.append({ type: "permission_decision", requestId, decision, userId });
    resolve(decision);
    return true;
  }
```

- [ ] **Step 7: Expand runAgentQuery's options**

In `runAgentQuery`'s `query()` options:

1. Replace `tools: ["Read", "Glob", "Grep", "Write", "Edit"],` and its comment block with:

```ts
      // Full Claude Code built-in tool set. `allowedTools` below auto-approves
      // only the file tools + set_intent; every other call (Bash, Task,
      // WebSearch, WebFetch, TodoWrite, ...) routes through canUseTool =
      // the driver approval gate, except allowlisted Bash prefixes
      // (see permissions.ts).
      tools: { type: "preset", preset: "claude_code" },
      canUseTool: buildCanUseTool(hooks),
      // Skills come from the project the agent works in (its worktree cwd
      // has .claude/skills/ checked in) — the single, explicit re-opening of
      // the settingSources isolation below. This option also enables the
      // Skill tool; do not add 'Skill' to allowedTools.
      skills: "all",
```

(`allowedTools`, `permissionMode`, `mcpServers`, `strictMcpConfig`, `settingSources`, `cwd` all stay exactly as they are.)

2. Replace the `systemPrompt` string with:

```ts
      systemPrompt:
        "You are a shared agent in a multiplayer project. Multiple teammates watch this session live and may hand control between them mid-task; other teammates run their own sessions in the same project. Keep responses focused. The FIRST thing you do when given a new task — before any other tool call — is call the set_intent tool with one short sentence describing what you are about to work on. Update it whenever your direction changes. Do this without being asked. Your working directory is your own git worktree on your own branch — you may implement changes directly with Write/Edit when asked to build; your edits never touch teammates' worktrees, but overlapping changes will collide later at merge time. A <teammates> block in a prompt describes what other sessions in the project are doing — take it into account: avoid conflicting with in-flight work, keep your footprint on shared files minimal when a teammate is mid-change there, and say so when a merge conflict looks likely. You have the full tool set including Bash, subagents, and web tools. Most Bash commands and other powerful tools pause until the teammate currently driving approves them in the UI — the whole session sees each request and decision, so prefer batching related commands and say briefly what a command is for before running it. Test/type-check/read-only-git commands run without approval. If a request is denied, adapt your approach or explain what you need instead of retrying the same call. If the project provides skills, use the Skill tool when one clearly matches the task.",
```

- [ ] **Step 8: Full verification**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: all tests pass (35 from Task 1 + 5 buildCanUseTool + 3 driver = 43 total), tsc clean. Existing fakes compile untouched (they receive `hooks` — fewer-params fakes remain assignable; fakes that use `hooks` only touch `onIntent`).

- [ ] **Step 9: Commit**

```bash
git add poc/server/src/permissions.ts poc/server/src/agentDriver.ts poc/server/test/permissions.test.ts poc/server/test/agentDriver.test.ts
git commit -m "feat: driver approval gate in AgentDriver + full claude_code tool preset + project skills"
```

---

### Task 3: Server permission wire message + project-awareness coverage

*Recommended implementer model: sonnet (integration).*

**Files:**
- Modify: `poc/server/src/server.ts:24-31` (INTERESTING), `:185-190` (insert handler between `take_wheel` and the unknown-type fallthrough)
- Test: `poc/server/test/server.test.ts` (append only)

**Interfaces:**
- Consumes: `AgentDriver.resolvePermission(requestId, decision, userId): boolean` (Task 2); `Session.canPrompt(userId)` (existing).
- Produces: wire contract for Task 4's client — client sends `{ type: "permission", requestId: string, decision: "allow" | "deny" }`; invalid shapes/non-driver/unknown ids get `{ type: "error", message }`.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/server.test.ts`:

```ts
describe("driver approval gate over the wire", () => {
  const bashAskRun: RunQuery = async function* (prompts, hooks) {
    for await (const prompt of prompts) {
      const decision = await hooks.onPermissionRequest("Bash", {
        command: "npm run build",
      });
      yield {
        type: "assistant",
        content: [{ type: "text", text: `bash: ${decision}` }],
      };
    }
  };

  it("broadcasts the request, rejects non-driver decisions, accepts the driver's", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", sessionId: "p1", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);

    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", sessionId: "p1", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(200);

    // Both the live watcher and the late joiner see the pending request.
    const reqAna = seenAna.map((m) => m.event).find((e) => e?.type === "permission_request");
    const reqBen = seenBen.map((m) => m.event).find((e) => e?.type === "permission_request");
    expect(reqAna?.toolName).toBe("Bash");
    expect(reqBen?.requestId).toBe(reqAna?.requestId);

    // Ben (not driving) may not decide.
    wsBen.send(JSON.stringify({ type: "permission", requestId: reqAna.requestId, decision: "allow" }));
    await wait(100);
    expect(seenBen.some((m) => m.type === "error" && /driver/.test(m.message))).toBe(true);

    // Ana (driver) decides; everyone sees the decision and the agent proceeds.
    wsAna.send(JSON.stringify({ type: "permission", requestId: reqAna.requestId, decision: "allow" }));
    await wait(200);
    const decision = seenBen.map((m) => m.event).find((e) => e?.type === "permission_decision");
    expect(decision).toMatchObject({ requestId: reqAna.requestId, decision: "allow", userId: "u1" });
    const echoed = seenBen.map((m) => m.event).find((e) => e?.type === "agent_text_delta");
    expect(echoed?.text).toBe("bash: allow");

    // Replaying the same decision is rejected.
    wsAna.send(JSON.stringify({ type: "permission", requestId: reqAna.requestId, decision: "deny" }));
    await wait(100);
    expect(seenAna.some((m) => m.type === "error" && /unknown or already-decided/.test(m.message))).toBe(true);

    wsAna.close();
    wsBen.close();
  });

  it("lets a NEW driver decide a request raised under the previous driver", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", sessionId: "p2", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);
    const req = seenAna.map((m) => m.event).find((e) => e?.type === "permission_request");
    expect(req).toBeTruthy();

    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", sessionId: "p2", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(100);
    wsBen.send(JSON.stringify({ type: "take_wheel" }));
    await wait(100);
    wsBen.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "deny" }));
    await wait(200);

    const decision = seenBen.map((m) => m.event).find((e) => e?.type === "permission_decision");
    expect(decision).toMatchObject({ requestId: req.requestId, decision: "deny", userId: "u2" });
    const echoed = seenBen.map((m) => m.event).find((e) => e?.type === "agent_text_delta");
    expect(echoed?.text).toBe("bash: deny");

    wsAna.close();
    wsBen.close();
  });

  it("rejects malformed permission messages", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;
    const ws1 = await connect(server.port);
    const seen: any[] = [];
    collect(ws1, seen);
    ws1.send(JSON.stringify({ type: "join", sessionId: "p3", userId: "u1", name: "Ana" }));
    await wait(50);
    ws1.send(JSON.stringify({ type: "permission", requestId: 5, decision: "allow" }));
    ws1.send(JSON.stringify({ type: "permission", requestId: "r1", decision: "maybe" }));
    await wait(100);
    const errors = seen.filter((m) => m.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    ws1.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: FAIL — server answers `unknown message type: permission`.

- [ ] **Step 3: Implement the handler and INTERESTING coverage**

In `poc/server/src/server.ts`:

1. Add the two permission events to `INTERESTING` (so teammates' sidebars refresh when a session is waiting on an approval — same rationale as `agent_error`/`control_change` in commit 4a4faff):

```ts
const INTERESTING = new Set([
  "intent_update",
  "presence_join",
  "presence_leave",
  "user_message",
  "agent_error",
  "control_change",
  "permission_request",
  "permission_decision",
]);
```

2. Insert after the `take_wheel` handler (before the final `sendError(...)`):

```ts
      if (msg.type === "permission") {
        if (
          typeof msg.requestId !== "string" ||
          (msg.decision !== "allow" && msg.decision !== "deny")
        ) {
          return sendError("permission requires requestId and decision allow|deny");
        }
        // Validated at DECISION time, not request time: wheel handoffs mid-
        // request are a feature (a teammate can drop in just to approve).
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can decide permissions — take the wheel first");
        }
        if (!ctx.entry.driver.resolvePermission(msg.requestId, msg.decision, ctx.userId)) {
          return sendError("unknown or already-decided permission request");
        }
        return;
      }
```

- [ ] **Step 4: Full verification**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 46 tests pass (43 + 3 new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat: permission wire message with driver-at-decision-time enforcement"
```

---

### Task 4: Client permission cards

*Recommended implementer model: haiku (full code given).*

**Files:**
- Modify: `poc/client/src/App.tsx:4-15` (LoggedEvent), `:91-104` (derived state), `:108-117` (senders), transcript switch (`:146-195`)
- Modify: `poc/client/src/App.css` (append)

**Interfaces:**
- Consumes: events `permission_request { requestId, toolName, input }` / `permission_decision { requestId, decision, userId }`; wire message `{ type: "permission", requestId, decision }` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Extend the LoggedEvent type**

In `poc/client/src/App.tsx`, add two optional fields to `LoggedEvent` (after `message?: string;`):

```ts
  requestId?: string;
  decision?: string;
```

- [ ] **Step 2: Track decisions in the derived-state memo**

Replace the `useMemo` destructuring line

```ts
  const { driverId, participants, myIntent } = useMemo(() => {
```

with

```ts
  const { driverId, participants, myIntent, permissionDecisions } = useMemo(() => {
```

Inside the memo, add after `let myIntent: string | null = null;`:

```ts
    const permissionDecisions = new Map<string, string>();
```

Add inside the `for` loop:

```ts
      if (ev.type === "permission_decision" && ev.requestId && ev.decision)
        permissionDecisions.set(ev.requestId, ev.decision);
```

And return it: `return { driverId, participants, myIntent, permissionDecisions };`

- [ ] **Step 3: Add the sender**

After the `takeWheel()` function:

```ts
  function sendPermission(requestId: string, decision: "allow" | "deny") {
    wsRef.current?.send(JSON.stringify({ type: "permission", requestId, decision }));
  }
```

- [ ] **Step 4: Render the two event types**

In the transcript `switch`, add before `default:`:

```tsx
              case "permission_request": {
                const decided = ev.requestId
                  ? permissionDecisions.get(ev.requestId)
                  : undefined;
                const cmd = (ev.input as { command?: unknown } | undefined)?.command;
                const preview =
                  typeof cmd === "string" ? cmd : JSON.stringify(ev.input);
                return (
                  <div key={ev.seq} className="msg permission">
                    <div className="permission-title">
                      🔐 agent wants to run <b>{ev.toolName}</b>
                    </div>
                    <code className="permission-input">
                      {preview?.slice(0, 300)}
                    </code>
                    {decided ? (
                      <div className="permission-outcome">
                        {decided === "allow" ? "✅ approved" : "⛔ denied"}
                      </div>
                    ) : isDriver && ev.requestId ? (
                      <div className="permission-actions">
                        <button onClick={() => sendPermission(ev.requestId!, "allow")}>
                          Approve
                        </button>
                        <button
                          className="deny"
                          onClick={() => sendPermission(ev.requestId!, "deny")}
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <div className="permission-outcome">
                        ⏳ waiting for the driver to decide…
                      </div>
                    )}
                  </div>
                );
              }
              case "permission_decision":
                return (
                  <div key={ev.seq} className="msg system">
                    {ev.decision === "allow" ? "✅" : "⛔"}{" "}
                    {participants.get(ev.userId ?? "") ?? ev.userId}{" "}
                    {ev.decision === "allow" ? "approved" : "denied"} a tool
                    request
                  </div>
                );
```

- [ ] **Step 5: Style the card**

Append to `poc/client/src/App.css`:

```css
.msg.permission { background: #2a2337; border: 1px solid #6d5aa8; display: flex; flex-direction: column; gap: 6px; }
.permission-title { font-size: 0.9rem; }
.permission-input { font-family: monospace; font-size: 0.8rem; background: #171a21; border-radius: 4px; padding: 6px 8px; overflow-wrap: anywhere; }
.permission-actions { display: flex; gap: 8px; }
.permission-actions button { padding: 6px 14px; border-radius: 6px; border: none; background: #2b4a2f; color: white; cursor: pointer; }
.permission-actions button.deny { background: #5a2b2b; }
.permission-outcome { font-size: 0.85rem; color: #8fa3c0; }
```

- [ ] **Step 6: Verify the build**

Run: `cd poc/client && npm run build`
Expected: vite build succeeds, no TS errors. Also run `cd poc/server && npx vitest run` (still 46 — client change can't break it, but the gate is cheap).

- [ ] **Step 7: Commit**

```bash
git add poc/client/src/App.tsx poc/client/src/App.css
git commit -m "feat: permission approval cards in client UI"
```

---

### Task 5: Demo project skill + README

*Recommended implementer model: haiku.*

**Files:**
- Modify: `poc/scripts/demo-setup.sh:26-30` (insert skill creation before `git add -A`)
- Modify: `README.md` (repo root — append a v3 section after "Run the v2 multi-session demo")

**Interfaces:**
- Consumes: `skills: "all"` in `runAgentQuery` (Task 2) discovering `.claude/skills/` in the agent's worktree cwd.
- Produces: skill named `auth-migration-guide` — Task 6's acceptance run invokes it.

- [ ] **Step 1: Add the example skill to the demo repo**

In `poc/scripts/demo-setup.sh`, insert between the `README.md` heredoc and the `git add -A && git commit` line (skill must be committed BEFORE the worktrees are created so `ana`/`ben` both contain it):

```bash
mkdir -p .claude/skills/auth-migration-guide
cat > .claude/skills/auth-migration-guide/SKILL.md <<'MD'
---
name: auth-migration-guide
description: Use when migrating this project's session-cookie auth to JWT — the team's agreed steps and constraints for the migration.
---

# Auth migration guide (team convention)

When migrating `src/auth.ts` off session cookies:

1. Keep `authMiddleware`'s exported signature; put JWT verification behind it.
2. Accept BOTH the `session_id` cookie and an `Authorization: Bearer` header during the transition window.
3. Never log token contents — not even at debug level.
4. Only touch `src/api.ts` call sites after `src/auth.ts` compiles clean.
MD
```

- [ ] **Step 2: Verify the script**

Run: `poc/scripts/demo-setup.sh && ls poc/demo-worktrees/ana/.claude/skills/auth-migration-guide/SKILL.md poc/demo-worktrees/ben/.claude/skills/auth-migration-guide/SKILL.md`
Expected: both paths print (skill present in both worktrees).

- [ ] **Step 3: Document the v3 demo**

In the repo-root `README.md`, insert after the "Run the v2 multi-session demo" section:

```markdown
## Run the v3 full-capabilities demo

Setup is the same as v2 (demo-setup.sh, `AGENT_WORKDIR_ROOT`, two tabs). New in v3:

- Agents have the full Claude Code tool set (Bash, subagents, web tools,
  project skills). Test/type-check/read-only-git commands run without asking;
  any other Bash command (or Task/WebSearch/WebFetch/...) shows a 🔐 approval
  card. Only the current driver can Approve/Deny — and taking the wheel lets a
  teammate decide a pending request (drop in just to approve something).
- The demo repo ships a project skill (`.claude/skills/auth-migration-guide/`);
  ask the ana agent to "migrate auth to JWT" and it should consult the skill.
```

- [ ] **Step 4: Commit**

```bash
git add poc/scripts/demo-setup.sh README.md
git commit -m "feat: demo project skill + v3 demo docs"
```

---

### Task 6: Live acceptance (controller-run — do NOT dispatch a subagent)

The session controller runs this directly with Playwright MCP tools, exactly like v2 Task 6. `ANTHROPIC_API_KEY` is available via `poc/server/.env`.

**Setup:**

- [ ] **Step 1:** `poc/scripts/demo-setup.sh`
- [ ] **Step 2:** In `poc/server`: `AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees npm run dev` (background). In `poc/client`: `npm run dev` (background).
- [ ] **Step 3:** Two browser tabs: `http://localhost:5173/?project=demo&session=ana` and `...&session=ben`.

**Scenarios (all four must pass; record evidence in `.superpowers/sdd/task-6-v3-report.md`):**

- [ ] **A — allowlisted Bash runs without asking:** In ana, prompt: "Run `git status` in your worktree and tell me what you see." Expect a Bash tool_call and result in the transcript with NO 🔐 card.
- [ ] **B — approval flow:** In ana, prompt: "Create a `notes/` directory using a bash mkdir command." Expect a 🔐 card with the command; only ana's tab (driver) shows Approve/Deny; click Approve; command runs; both events visible; ben's tab (watching ana via the sidebar link, or joining the ana session in a third tab) shows the same card read-only.
- [ ] **C — wheel handoff decides a pending request:** In ana, prompt something that triggers another non-allowlisted command, do NOT decide. In a second tab joined to the SAME ana session as a different user, click "Take the wheel", then Deny. Expect the decision event attributed to the second user and the agent adapting to the denial.
- [ ] **D — project skill:** In ana, prompt: "Migrate src/auth.ts to JWT following our team's migration guide." Expect a `Skill` tool_call for `auth-migration-guide` (or the agent quoting the guide's constraints) and edits honoring it.

**Known-unknowns to verify live (adapt at the SDK boundary only; record what was true in the ledger):**

- Whether `skills: "all"` discovers `.claude/skills/` from the worktree `cwd` with `settingSources: []`. Fallbacks in order: (1) `skills: ["auth-migration-guide"]` explicit list; (2) check sdk.d.ts for a skill-paths option; (3) if discovery requires project settings, document the conflict with the isolation decision and surface to the user rather than silently re-opening `settingSources`.
- Whether the `claude_code` tools preset + `canUseTool` + `allowedTools` interact as typed (preset tools not in `allowedTools` must hit `canUseTool`). If `allowedTools` is ignored under the preset, fall back to enumerating: keep gate behavior identical.
- Approval-noise check: if TodoWrite (or another chatty low-risk tool) floods the gate during the demo, note it as a finding for the user — do NOT unilaterally add it to `allowedTools` (spec fixed the auto-approve list).

- [ ] **Fix live bugs found (commit each with a test where feasible), then run the full gates:** `cd poc/server && npx vitest run && npx tsc --noEmit` and `cd poc/client && npm run build`.
- [ ] **Commit** any fixes: `git add -A && git commit -m "fix: v3 live acceptance findings"`

---

### After Task 6

Final whole-branch review (most capable model) over the v3 diff (`git diff <task-1-base>..HEAD`), triage deferred minors from the ledger, one fix subagent if needed, re-review. Then hand back to the user: the branch also holds unreviewed-by-user v2 work — do NOT merge without their verdict.
