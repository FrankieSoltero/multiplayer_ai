# v5a Agent-Harness Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the shared multiplayer agent a real harness surface: slash-command skills (any member suggests, driver approves), first-class rendering of skill invocations and subagent activity, a live party-visible todo panel, and a driver-controlled plan-approval gate.

**Architecture:** Append-only additions to the `SessionEvent` wire union; the server stays a relay + approval gate (all new gating rides `canUseTool` / driver-guard patterns that already exist); the client's pure `derive.ts` layer turns the flat event stream into entities. Late-joiner replay works by construction because every addition is an appended event.

**Tech Stack:** TypeScript, Node 20, `@anthropic-ai/claude-agent-sdk`, `ws`, vitest (server: `poc/server/test/*.test.ts`; client: node-env pure-module tests only, no jsdom), React 18 + vite (components verified by `npm run build` + live acceptance).

**Spec:** `docs/superpowers/specs/2026-07-25-harness-capabilities-design.md`

## Global Constraints

- Wire changes are APPEND-ONLY: never rename or remove existing `SessionEvent` members or fields.
- SDK casts happen at the SDK boundary only (`runAgentQuery`'s single `as unknown as RunQueryResult`); everywhere else uses our own minimal types.
- New `Query` capabilities are surfaced as OPTIONAL members on `RunQueryResult` (the `setModel` pattern) so plain async-generator test fakes stay assignable.
- Client unit tests are node-env pure-module tests only (derive/identity/game); React components are verified by `npm run build` and live acceptance — do not add jsdom.
- All styling uses the existing `terminal.css` token system (`--fg`, `--dim`, `--gold`, `--amber`, `--accent`, `--sp-*`); no new dependencies anywhere.
- Server test commands: `cd poc/server && npx vitest run`. Client: `cd poc/client && npm test` and `npm run build`.
- Commit after every task with the message given in the task's final step.

---

### Task 1: Wire types — server event union + client event type

**Files:**
- Modify: `poc/server/src/events.ts` (whole file shown below)
- Modify: `poc/client/src/types.ts:1-17` (`LoggedEvent`)

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: the `SessionEvent` union members and `LoggedEvent` fields every later task references: `skill_roster`, `skill_suggest`, `skill_decision`, `todo_update`, `plan_request`, `plan_decision`, `permission_mode_change`, plus `toolUseId?`/`parentToolUseId?` on tool events and `parentToolUseId?` on `agent_text_delta`. Also exports `TodoItem` and `SkillInfo` types from `events.ts`.

- [ ] **Step 1: Replace `poc/server/src/events.ts` with the extended union**

```ts
export interface SkillInfo {
  name: string;
  description: string;
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export type SessionEvent =
  | { type: "user_message"; userId: string; text: string }
  | { type: "agent_text_delta"; text: string; parentToolUseId?: string }
  | { type: "tool_call"; toolName: string; input: unknown; toolUseId?: string; parentToolUseId?: string }
  | { type: "tool_result"; toolName: string; output: string; toolUseId?: string; parentToolUseId?: string }
  | { type: "control_change"; userId: string }
  | { type: "presence_join"; userId: string; name: string; glyph?: string; color?: string }
  | { type: "presence_leave"; userId: string }
  | { type: "agent_error"; message: string }
  | { type: "intent_update"; text: string }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string }
  | { type: "model_change"; model: string; userId: string }
  | { type: "turn_end" }
  | { type: "skill_roster"; skills: SkillInfo[] }
  | { type: "skill_suggest"; suggestId: string; userId: string; skill: string; args: string }
  | { type: "skill_decision"; suggestId: string; decision: "run" | "dismiss"; userId: string }
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "plan_request"; requestId: string; plan: string }
  | { type: "plan_decision"; requestId: string; decision: "approve" | "reject"; userId: string }
  | { type: "permission_mode_change"; mode: "plan" | "default"; userId: string };

export type LoggedEvent = SessionEvent & { seq: number; ts: string };
```

- [ ] **Step 2: Extend the client's flat `LoggedEvent` in `poc/client/src/types.ts`**

The client type is deliberately a single flat optional-field bag (events arrive as JSON). Replace the `LoggedEvent` type (keep `ProjectSessionInfo` and `SERVER_URL` untouched):

```ts
export type LoggedEvent = {
  seq: number;
  ts: string;
  type: string;
  userId?: string;
  name?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
  message?: string;
  requestId?: string;
  decision?: string;
  model?: string;
  glyph?: string;
  color?: string;
  toolUseId?: string;
  parentToolUseId?: string;
  skills?: { name: string; description: string }[];
  suggestId?: string;
  skill?: string;
  args?: string;
  todos?: { text: string; status: string }[];
  plan?: string;
  mode?: string;
};
```

- [ ] **Step 3: Verify both packages still compile and all existing tests pass**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: clean compile, all tests pass (type additions are append-only).

Run: `cd ../client && npm test && npm run build`
Expected: 11+ tests pass, build clean.

- [ ] **Step 4: Commit**

```bash
git add poc/server/src/events.ts poc/client/src/types.ts
git commit -m "feat(wire): v5a event types — skills, todos, plan gate, subagent lineage (append-only)"
```

---

### Task 2: Server — subagent lineage plumbing

**Files:**
- Modify: `poc/server/src/agentDriver.ts:29-33` (`SdkMessage`), `:102-152` (`runAgentQuery` options), `:340-390` (`handleMessage`)
- Test: `poc/server/test/agentDriver.test.ts`

**Interfaces:**
- Consumes: Task 1's `parentToolUseId?`/`toolUseId?` event fields.
- Produces: `SdkMessage.parent_tool_use_id?: string | null`; emitted `agent_text_delta`/`tool_call`/`tool_result` events carry `parentToolUseId` when the SDK message has a non-null `parent_tool_use_id`, and tool events carry `toolUseId` (the block's `id` / `tool_use_id`). `runAgentQuery` passes `forwardSubagentText: true`.

- [ ] **Step 1: Write the failing tests** (append to `poc/server/test/agentDriver.test.ts`, matching the existing fake-`RunQuery` style)

```ts
const subagentRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    // Main agent spawns a subagent via Task
    yield {
      type: "assistant",
      content: [{ type: "tool_use", id: "task-1", name: "Task", input: { description: "audit deps" } }],
    };
    // Subagent traffic arrives tagged with parent_tool_use_id
    yield {
      type: "assistant",
      parent_tool_use_id: "task-1",
      content: [
        { type: "text", text: "scanning lockfile" },
        { type: "tool_use", id: "t-sub", name: "Read", input: { file: "package.json" } },
      ],
    };
    yield {
      type: "user",
      parent_tool_use_id: "task-1",
      content: [{ type: "tool_result", tool_use_id: "t-sub", content: "lockfile ok" }],
    };
    // Task completes: parent-level tool_result for task-1
    yield {
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "task-1", content: "audit done" }],
    };
    return;
  }
};

describe("subagent lineage", () => {
  it("threads parent_tool_use_id and block ids onto emitted events", async () => {
    const session = new Session("s-lineage");
    const events: any[] = [];
    session.subscribe((e) => events.push(e));
    const driver = new AgentDriver(session, subagentRun);
    driver.sendPrompt("u1", "audit");
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === "tool_result").length).toBe(2);
    });
    const spawn = events.find((e) => e.type === "tool_call" && e.toolName === "Task");
    expect(spawn.toolUseId).toBe("task-1");
    expect(spawn.parentToolUseId).toBeUndefined();
    const subText = events.find((e) => e.type === "agent_text_delta" && e.text === "scanning lockfile");
    expect(subText.parentToolUseId).toBe("task-1");
    const subCall = events.find((e) => e.type === "tool_call" && e.toolName === "Read");
    expect(subCall.parentToolUseId).toBe("task-1");
    expect(subCall.toolUseId).toBe("t-sub");
    const subResult = events.find((e) => e.type === "tool_result" && e.output === "lockfile ok");
    expect(subResult.parentToolUseId).toBe("task-1");
    expect(subResult.toolUseId).toBe("t-sub");
    const done = events.find((e) => e.type === "tool_result" && e.output === "audit done");
    expect(done.parentToolUseId).toBeUndefined();
    expect(done.toolUseId).toBe("task-1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: FAIL — `toolUseId`/`parentToolUseId` undefined on emitted events.

- [ ] **Step 3: Implement**

In `SdkMessage` (agentDriver.ts:29-33) add the lineage field:

```ts
export interface SdkMessage {
  type: string;
  content?: unknown[];
  message?: { content?: unknown[] };
  parent_tool_use_id?: string | null;
}
```

In `handleMessage`, extract the parent id once at the top (after `blocks`):

```ts
    const parentId = message.parent_tool_use_id ?? undefined;
```

In the `assistant` branch, spread lineage onto both appends:

```ts
        if (block.type === "text" && block.text) {
          this.session.append({
            type: "agent_text_delta",
            text: block.text,
            ...(parentId ? { parentToolUseId: parentId } : {}),
          });
        } else if (block.type === "tool_use" && block.name) {
          if (block.id) this.toolNamesById.set(block.id, block.name);
          this.session.append({
            type: "tool_call",
            toolName: block.name,
            input: block.input,
            ...(block.id ? { toolUseId: block.id } : {}),
            ...(parentId ? { parentToolUseId: parentId } : {}),
          });
        }
```

In the `result`/`user` branch's `tool_result` append:

```ts
          this.session.append({
            type: "tool_result",
            toolName,
            output: text.slice(0, 2000),
            ...(block.tool_use_id ? { toolUseId: block.tool_use_id } : {}),
            ...(parentId ? { parentToolUseId: parentId } : {}),
          });
```

In `runAgentQuery` options (after `settingSources: []`), enable full subagent forwarding — without it the SDK only emits subagent tool_use/tool_result, not text (sdk.d.ts `forwardSubagentText` doc):

```ts
      // Forward subagent text/thinking as messages tagged with
      // parent_tool_use_id so the client can render a nested transcript.
      // Default (false) only forwards subagent tool_use/tool_result blocks.
      forwardSubagentText: true,
```

- [ ] **Step 4: Run the full server suite**

Run: `cd poc/server && npx vitest run`
Expected: all pass, including the new lineage test.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/agentDriver.ts poc/server/test/agentDriver.test.ts
git commit -m "feat(server): thread subagent lineage (parent_tool_use_id, block ids) onto wire events"
```

---

### Task 3: Server — TodoWrite auto-approve + todo_update mirror

**Files:**
- Modify: `poc/server/src/permissions.ts:88-114` (`buildCanUseTool`)
- Modify: `poc/server/src/agentDriver.ts` (`handleMessage` assistant branch; new private helper)
- Test: `poc/server/test/permissions.test.ts`, `poc/server/test/agentDriver.test.ts`

**Interfaces:**
- Consumes: Task 1's `todo_update` event + `TodoItem`; Task 2's `parentId` local in `handleMessage`.
- Produces: `TodoWrite` never reaches the driver-approval hook; a main-agent `TodoWrite` tool_use additionally appends `{ type: "todo_update", todos: TodoItem[] }` (content→text, invalid entries dropped, max 50 items, text capped at 200 chars). Subagent `TodoWrite` (parentId set) emits no `todo_update`.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/permissions.test.ts` (match its existing hooks-literal style — and note Task 6 later adds `onPlanRequest` to `DriverHooks`; here the hooks literal only needs the current members):

```ts
  it("auto-approves TodoWrite without consulting the driver", async () => {
    const onPermissionRequest = vi.fn();
    const canUse = buildCanUseTool({ onIntent: () => {}, onPermissionRequest });
    const result = await canUse(
      "TodoWrite",
      { todos: [{ content: "step 1", status: "pending", activeForm: "doing step 1" }] },
      { signal: new AbortController().signal } as any,
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });
```

Append to `poc/server/test/agentDriver.test.ts`:

```ts
const todoRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "assistant",
      content: [
        {
          type: "tool_use",
          id: "td-1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "write tests", status: "completed", activeForm: "writing tests" },
              { content: "implement", status: "in_progress", activeForm: "implementing" },
              { content: 42, status: "pending" },              // invalid content — dropped
              { content: "ship", status: "someday" },          // invalid status — dropped
            ],
          },
        },
      ],
    };
    // Subagent TodoWrite must NOT mirror to the panel
    yield {
      type: "assistant",
      parent_tool_use_id: "task-9",
      content: [
        { type: "tool_use", id: "td-2", name: "TodoWrite", input: { todos: [{ content: "sub", status: "pending" }] } },
      ],
    };
    return;
  }
};

describe("todo mirror", () => {
  it("emits todo_update from main-agent TodoWrite only, dropping invalid entries", async () => {
    const session = new Session("s-todo");
    const events: any[] = [];
    session.subscribe((e) => events.push(e));
    const driver = new AgentDriver(session, todoRun);
    driver.sendPrompt("u1", "plan it");
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === "tool_call" && e.toolName === "TodoWrite").length).toBe(2);
    });
    const updates = events.filter((e) => e.type === "todo_update");
    expect(updates.length).toBe(1);
    expect(updates[0].todos).toEqual([
      { text: "write tests", status: "completed" },
      { text: "implement", status: "in_progress" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run`
Expected: FAIL — TodoWrite reaches `onPermissionRequest`; no `todo_update` emitted.

- [ ] **Step 3: Implement**

`permissions.ts` — first check inside the returned `canUseTool`, above the Bash check, with the why:

```ts
    // TodoWrite is the agent's own bookkeeping (mirrored to the party as a
    // todo_update event by the driver) — pausing the session to approve it is
    // pure noise, and it writes no files and runs no commands.
    if (toolName === "TodoWrite") {
      return { behavior: "allow" };
    }
```

`agentDriver.ts` — in the assistant `tool_use` branch, right after the `tool_call` append from Task 2:

```ts
          if (block.name === "TodoWrite" && !parentId) {
            const todos = this.todosFrom(block.input);
            if (todos) this.session.append({ type: "todo_update", todos });
          }
```

New private helper on `AgentDriver` (import `TodoItem` from `./events.js`):

```ts
  /**
   * Parse a TodoWrite input into wire TodoItems. The SDK's TodoWrite input is
   * { todos: [{ content, status, activeForm }] }; we keep content/status only,
   * drop malformed entries, and cap list size and text length for wire hygiene.
   */
  private todosFrom(input: unknown): TodoItem[] | null {
    const todos = (input as { todos?: unknown }).todos;
    if (!Array.isArray(todos)) return null;
    const valid = new Set(["pending", "in_progress", "completed"]);
    return todos.slice(0, 50).flatMap((t) => {
      const { content, status } = t as { content?: unknown; status?: unknown };
      if (typeof content !== "string" || typeof status !== "string" || !valid.has(status)) return [];
      return [{ text: content.slice(0, 200), status: status as TodoItem["status"] }];
    });
  }
```

- [ ] **Step 4: Run the full server suite**

Run: `cd poc/server && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/permissions.ts poc/server/src/agentDriver.ts poc/server/test/permissions.test.ts poc/server/test/agentDriver.test.ts
git commit -m "feat(server): auto-approve TodoWrite and mirror main-agent todos as todo_update"
```

---

### Task 4: Server — skill roster loaded per session, appended to the log

**Files:**
- Create: `poc/server/src/skillRoster.ts`
- Modify: `poc/server/src/project.ts:7-10` (`ProjectSessionEntry`)
- Modify: `poc/server/src/server.ts:75-93` (`getOrCreateSession`)
- Test: create `poc/server/test/skillRoster.test.ts`; modify `poc/server/test/server.test.ts`, plus any `ProjectSessionEntry` literals in `poc/server/test/project.test.ts` / `poc/server/test/digest.test.ts`

**Interfaces:**
- Consumes: Task 1's `skill_roster` event + `SkillInfo`.
- Produces: `loadSkillRoster(workdir: string | undefined, names: string[]): SkillInfo[]` (exported from `skillRoster.ts`); `ProjectSessionEntry` gains `skills: SkillInfo[]` and `pendingSuggests: Map<string, { skill: string; args: string }>` (Task 5 consumes both); every new session's log starts with one `skill_roster` event (empty list when `AGENT_SKILLS` is unset), so replay delivers it to every joiner.

- [ ] **Step 1: Write the failing roster-loader test** (`poc/server/test/skillRoster.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkillRoster } from "../src/skillRoster.js";

describe("loadSkillRoster", () => {
  it("reads the frontmatter description from the worktree's SKILL.md, best-effort", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
    const dir = path.join(workdir, ".claude", "skills", "auth-migration-guide");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: auth-migration-guide\ndescription: Guide for migrating the auth stack\n---\n\n# body\n",
    );
    const roster = loadSkillRoster(workdir, ["auth-migration-guide", "missing-skill", "plugin:remote-skill"]);
    expect(roster).toEqual([
      { name: "auth-migration-guide", description: "Guide for migrating the auth stack" },
      { name: "missing-skill", description: "" },
      { name: "plugin:remote-skill", description: "" },
    ]);
  });

  it("returns empty descriptions with no workdir and [] for no names", () => {
    expect(loadSkillRoster(undefined, ["a"])).toEqual([{ name: "a", description: "" }]);
    expect(loadSkillRoster("/nope", [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd poc/server && npx vitest run test/skillRoster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `poc/server/src/skillRoster.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import type { SkillInfo } from "./events.js";

/**
 * Build the session's skill roster from the AGENT_SKILLS allowlist names.
 * Descriptions are best-effort: read from the agent worktree's checked-in
 * `.claude/skills/<name>/SKILL.md` frontmatter (that is where the SDK loads
 * project skills from — see agentDriver.ts `skills` option). `plugin:name`
 * entries and unreadable files fall back to an empty description; the roster
 * exists so the client can autocomplete, not as documentation.
 */
export function loadSkillRoster(
  workdir: string | undefined,
  names: string[],
): SkillInfo[] {
  return names.map((name) => ({
    name,
    description: readDescription(workdir, name),
  }));
}

function readDescription(workdir: string | undefined, name: string): string {
  if (!workdir || name.includes(":")) return "";
  try {
    const raw = fs.readFileSync(
      path.join(workdir, ".claude", "skills", name, "SKILL.md"),
      "utf8",
    );
    const match = raw.match(/^description:\s*(.+)$/m);
    return match ? match[1].trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Extend `ProjectSessionEntry` and wire roster into session creation**

`project.ts` — extend the interface (import `SkillInfo` from `./events.js`):

```ts
export interface ProjectSessionEntry {
  session: Session;
  driver: AgentDriver;
  skills: SkillInfo[];
  pendingSuggests: Map<string, { skill: string; args: string }>;
}
```

`server.ts` `getOrCreateSession` — build the roster and append it as the session's first event (import `loadSkillRoster` from `./skillRoster.js`):

```ts
    if (!entry) {
      const session = new Session(sessionId);
      const root = process.env.AGENT_WORKDIR_ROOT;
      const workdir = root ? path.join(root, sessionId) : undefined;
      const skillNames = (process.env.AGENT_SKILLS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const skills = loadSkillRoster(workdir, skillNames);
      // Appended (not side-channeled) so late joiners get the roster from the
      // same replay path as everything else. Empty roster still appends — the
      // client treats "no skill_roster yet" and "empty roster" identically,
      // but a uniform log is easier to reason about.
      session.append({ type: "skill_roster", skills });
      entry = {
        session,
        driver: new AgentDriver(session, runQuery, workdir),
        skills,
        pendingSuggests: new Map(),
      };
      project.sessions.set(sessionId, entry);
      session.subscribe((event) => {
        if (INTERESTING.has(event.type)) schedulePush(project);
      });
    }
```

(Note the roster append happens before the `AgentDriver` is constructed — order matters only for log tidiness, not correctness.)

Fix any test fixtures that construct `ProjectSessionEntry` literals (`project.test.ts`, `digest.test.ts` — search for `{ session`, and add `skills: [], pendingSuggests: new Map()`).

- [ ] **Step 5: Add the server-level roster test** (append to `poc/server/test/server.test.ts`)

```ts
  it("replays a skill_roster event to every joiner", async () => {
    process.env.AGENT_SKILLS = "alpha, beta";
    try {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "join", sessionId: "s-roster", userId: "u1", name: "Ana" }));
      await wait(100);
      const roster = seen.find((m) => m.event?.type === "skill_roster");
      expect(roster.event.skills).toEqual([
        { name: "alpha", description: "" },
        { name: "beta", description: "" },
      ]);
      ws.close();
    } finally {
      delete process.env.AGENT_SKILLS;
    }
  });
```

- [ ] **Step 6: Run the full server suite**

Run: `cd poc/server && npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/skillRoster.ts poc/server/src/project.ts poc/server/src/server.ts poc/server/test/
git commit -m "feat(server): per-session skill roster from AGENT_SKILLS, appended to the log for replay"
```

---

### Task 5: Server — skill suggest/decide flow

**Files:**
- Modify: `poc/server/src/agentDriver.ts` (new `runSkill` method, after `sendPrompt`)
- Modify: `poc/server/src/server.ts` (two new message handlers after the `set_model` handler)
- Test: `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: Task 1's `skill_suggest`/`skill_decision` events; Task 4's `entry.skills` + `entry.pendingSuggests`.
- Produces: `AgentDriver.runSkill(skill: string, args: string): void`; wire messages `{ type: "suggest_skill", skill, args? }` (any member) and `{ type: "decide_skill", suggestId, decision: "run" | "dismiss" }` (driver only). A driver's own `suggest_skill` auto-emits the `run` decision (one message, uniform two-event transcript record).

- [ ] **Step 1: Write the failing tests** (append to `poc/server/test/server.test.ts`; `echoRun` responds to any prompt so a run shows up as `agent_text_delta`)

```ts
describe("skill suggest/decide", () => {
  async function rosterServer() {
    process.env.AGENT_SKILLS = "alpha";
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = async () => {
      delete process.env.AGENT_SKILLS;
      await server.close();
    };
    return server;
  }

  it("driver slash-run: one suggest_skill message yields suggest + run decision + agent activity", async () => {
    const server = await rosterServer();
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "sk1", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "suggest_skill", skill: "alpha", args: "the login flow" }));
    await wait(200);
    const types = seen.map((m) => m.event?.type);
    expect(types).toContain("skill_suggest");
    expect(types).toContain("skill_decision");
    const decision = seen.find((m) => m.event?.type === "skill_decision").event;
    expect(decision.decision).toBe("run");
    expect(decision.userId).toBe("u1");
    expect(types).toContain("agent_text_delta"); // the enqueued skill prompt ran
    expect(types).not.toContain("user_message"); // skill runs are recorded by the suggest/decision pair, not a user row
    ws.close();
  });

  it("passenger suggestion waits; driver run decision executes it; non-driver decisions rejected", async () => {
    const server = await rosterServer();
    const wsA = await connect(server.port);
    const seenA: any[] = [];
    collect(wsA, seenA);
    wsA.send(JSON.stringify({ type: "join", sessionId: "sk2", userId: "u1", name: "Ana" }));
    await wait(50);
    const wsB = await connect(server.port);
    const seenB: any[] = [];
    collect(wsB, seenB);
    wsB.send(JSON.stringify({ type: "join", sessionId: "sk2", userId: "u2", name: "Ben" }));
    await wait(50);

    wsB.send(JSON.stringify({ type: "suggest_skill", skill: "alpha", args: "" }));
    await wait(150);
    const suggest = seenA.find((m) => m.event?.type === "skill_suggest").event;
    expect(suggest.userId).toBe("u2");
    expect(seenA.some((m) => m.event?.type === "skill_decision")).toBe(false);

    // Passenger cannot decide their own suggestion
    wsB.send(JSON.stringify({ type: "decide_skill", suggestId: suggest.suggestId, decision: "run" }));
    await wait(100);
    expect(seenB.some((m) => m.type === "error" && /driver/.test(m.message))).toBe(true);

    // Driver runs it — attributed to the SUGGESTER (u2)
    wsA.send(JSON.stringify({ type: "decide_skill", suggestId: suggest.suggestId, decision: "run" }));
    await wait(200);
    const decision = seenA.find((m) => m.event?.type === "skill_decision").event;
    expect(decision).toMatchObject({ suggestId: suggest.suggestId, decision: "run", userId: "u1" });
    expect(seenA.map((m) => m.event?.type)).toContain("agent_text_delta");

    // Already decided → error
    wsA.send(JSON.stringify({ type: "decide_skill", suggestId: suggest.suggestId, decision: "run" }));
    await wait(100);
    expect(seenA.some((m) => m.type === "error" && /unknown or already-decided/.test(m.message))).toBe(true);
    wsA.close();
    wsB.close();
  });

  it("rejects suggestions for skills not in the roster", async () => {
    const server = await rosterServer();
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "sk3", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "suggest_skill", skill: "rm-rf-everything", args: "" }));
    await wait(100);
    expect(seen.some((m) => m.type === "error" && /roster/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.event?.type === "skill_suggest")).toBe(false);
    ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: FAIL — `unknown message type: suggest_skill`.

- [ ] **Step 3: Implement `AgentDriver.runSkill`** (after `sendPrompt`, agentDriver.ts:~242)

```ts
  /**
   * Enqueue a driver-approved skill invocation. Unlike sendPrompt this appends
   * NO user_message — the skill_suggest/skill_decision pair (appended by the
   * server) is the transcript record; a synthetic user row would double-log it.
   */
  runSkill(skill: string, args: string): void {
    if (this.dead) {
      this.session.append({
        type: "agent_error",
        message: "agent session has ended — restart the server to continue",
      });
      return;
    }
    this.pendingTurns++;
    const argText = args ? ` with these arguments: ${args}` : "";
    this.prompts.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `Invoke the project skill "${skill}" using the Skill tool${argText}, then follow the skill's instructions.`,
          },
        ],
      },
      parent_tool_use_id: null,
    });
  }
```

- [ ] **Step 4: Implement the server handlers** (server.ts, after the `set_model` block; import `randomUUID` from `node:crypto`)

```ts
      if (msg.type === "suggest_skill") {
        if (typeof msg.skill !== "string") {
          return sendError("suggest_skill requires skill");
        }
        const args = typeof msg.args === "string" ? msg.args.slice(0, 500) : "";
        if (!ctx.entry.skills.some((s) => s.name === msg.skill)) {
          return sendError("unknown skill — not in this session's roster");
        }
        const suggestId = randomUUID();
        ctx.entry.session.append({
          type: "skill_suggest",
          suggestId,
          userId: ctx.userId,
          skill: msg.skill,
          args,
        });
        if (ctx.entry.session.canPrompt(ctx.userId)) {
          // Driver suggesting = driver approving: emit the decision pair so
          // the transcript record is uniform with the passenger flow.
          ctx.entry.session.append({
            type: "skill_decision",
            suggestId,
            decision: "run",
            userId: ctx.userId,
          });
          ctx.entry.driver.runSkill(msg.skill, args);
        } else {
          ctx.entry.pendingSuggests.set(suggestId, { skill: msg.skill, args });
        }
        return;
      }

      if (msg.type === "decide_skill") {
        if (
          typeof msg.suggestId !== "string" ||
          (msg.decision !== "run" && msg.decision !== "dismiss")
        ) {
          return sendError("decide_skill requires suggestId and decision run|dismiss");
        }
        // Validated at DECISION time — wheel handoffs mid-suggestion are a
        // feature, same as the permission gate above.
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can decide suggestions — take the wheel first");
        }
        const pending = ctx.entry.pendingSuggests.get(msg.suggestId);
        if (!pending) {
          return sendError("unknown or already-decided suggestion");
        }
        ctx.entry.pendingSuggests.delete(msg.suggestId);
        ctx.entry.session.append({
          type: "skill_decision",
          suggestId: msg.suggestId,
          decision: msg.decision,
          userId: ctx.userId,
        });
        if (msg.decision === "run") {
          ctx.entry.driver.runSkill(pending.skill, pending.args);
        }
        return;
      }
```

Also add `"skill_suggest"` and `"skill_decision"` to the `INTERESTING` set (server.ts:27-36) so project snapshots refresh on suggestion activity.

- [ ] **Step 5: Run the full server suite**

Run: `cd poc/server && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add poc/server/src/agentDriver.ts poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat(server): skill suggest/decide flow — passengers propose, driver approves, driver slash auto-runs"
```

---

### Task 6: Server — plan mode toggle + plan-approval gate

**Files:**
- Modify: `poc/server/src/agentDriver.ts` (`RunQueryResult`, `DriverHooks`, constructor hooks, new `resolvePlan`/`setPermissionMode` methods, `denyAllPending`)
- Modify: `poc/server/src/permissions.ts` (`buildCanUseTool` ExitPlanMode branch)
- Modify: `poc/server/src/server.ts` (two new handlers)
- Test: `poc/server/test/agentDriver.test.ts`, `poc/server/test/permissions.test.ts`, `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: Task 1's `plan_request`/`plan_decision`/`permission_mode_change` events.
- Produces: `RunQueryResult.setPermissionMode?(mode: string): Promise<void>`; `DriverHooks.onPlanRequest: (plan: string, signal?: AbortSignal) => Promise<"approve" | "reject">`; `AgentDriver.resolvePlan(requestId, decision: "approve" | "reject", userId): boolean`; `AgentDriver.setPermissionMode(mode: "plan" | "default", userId)` returning `{ ok: true } | { ok: false; error: string }`; wire messages `{ type: "set_permission_mode", mode }` and `{ type: "decide_plan", requestId, decision: "approve" | "reject" }` (both driver-only).

- [ ] **Step 1: Write the failing permissions test** (append to `poc/server/test/permissions.test.ts`; existing hooks literals must gain a stub `onPlanRequest: async () => "approve" as const` once the type lands — update them in this step)

```ts
  it("routes ExitPlanMode to onPlanRequest: approve allows, reject denies with a revise message", async () => {
    const onPermissionRequest = vi.fn();
    const decisions: Array<"approve" | "reject"> = ["approve", "reject"];
    const seenPlans: string[] = [];
    const canUse = buildCanUseTool({
      onIntent: () => {},
      onPermissionRequest,
      onPlanRequest: async (plan) => {
        seenPlans.push(plan);
        return decisions.shift()!;
      },
    });
    const opts = { signal: new AbortController().signal } as any;
    const first = await canUse("ExitPlanMode", { plan: "1. do the thing" }, opts);
    expect(first).toEqual({ behavior: "allow" });
    const second = await canUse("ExitPlanMode", { plan: "2. revised" }, opts);
    expect(second).toMatchObject({ behavior: "deny", message: expect.stringMatching(/revis/i) });
    expect(seenPlans).toEqual(["1. do the thing", "2. revised"]);
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Write the failing driver tests** (append to `poc/server/test/agentDriver.test.ts`)

```ts
describe("plan gate", () => {
  it("appends plan_request, resolves approve, switches mode back to default", async () => {
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    let planPromise: Promise<"approve" | "reject"> | undefined;
    const planRun: RunQuery = (prompts, hooks) => {
      const gen = (async function* () {
        for await (const _prompt of prompts) {
          planPromise = hooks.onPlanRequest("1. audit\n2. fix", undefined);
          await planPromise;
          return;
        }
      })();
      return Object.assign(gen, { setPermissionMode });
    };
    const session = new Session("s-plan");
    const events: any[] = [];
    session.subscribe((e) => events.push(e));
    const driver = new AgentDriver(session, planRun);
    driver.sendPrompt("u1", "build it");
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "plan_request")).toBe(true);
    });
    const request = events.find((e) => e.type === "plan_request");
    expect(request.plan).toBe("1. audit\n2. fix");

    expect(driver.resolvePlan(request.requestId, "approve", "u1")).toBe(true);
    await expect(planPromise).resolves.toBe("approve");
    const decision = events.find((e) => e.type === "plan_decision");
    expect(decision).toMatchObject({ requestId: request.requestId, decision: "approve", userId: "u1" });
    const modeChange = events.find((e) => e.type === "permission_mode_change");
    expect(modeChange).toMatchObject({ mode: "default", userId: "u1" });
    expect(setPermissionMode).toHaveBeenCalledWith("default");
    // Second resolve is a no-op
    expect(driver.resolvePlan(request.requestId, "approve", "u1")).toBe(false);
  });

  it("setPermissionMode mirrors the setModel guards and logs optimistically", async () => {
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const idleRun: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const _prompt of prompts) {
          /* never yields */
        }
      })();
      return Object.assign(gen, { setPermissionMode });
    };
    const session = new Session("s-mode");
    const events: any[] = [];
    session.subscribe((e) => events.push(e));
    const driver = new AgentDriver(session, idleRun);
    expect(driver.setPermissionMode("plan", "u1")).toEqual({ ok: true });
    expect(setPermissionMode).toHaveBeenCalledWith("plan");
    expect(events.find((e) => e.type === "permission_mode_change")).toMatchObject({ mode: "plan", userId: "u1" });

    driver.sendPrompt("u1", "go"); // now mid-turn
    expect(driver.setPermissionMode("default", "u1")).toEqual({
      ok: false,
      error: "agent is mid-turn — wait for it to finish",
    });
  });

  it("reports not-supported on fakes without setPermissionMode", () => {
    const session = new Session("s-nomode");
    const driver = new AgentDriver(session, fakeRun);
    expect(driver.setPermissionMode("plan", "u1")).toEqual({
      ok: false,
      error: "plan mode not supported by this agent",
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run`
Expected: FAIL — `onPlanRequest` missing from hooks type, `resolvePlan`/`setPermissionMode` undefined.

- [ ] **Step 4: Implement in `agentDriver.ts`**

Extend `RunQueryResult`:

```ts
export type RunQueryResult = AsyncIterable<SdkMessage> & {
  /** Present on the real SDK Query (sdk.d.ts Query.setModel); absent on plain test fakes. */
  setModel?(model: string): Promise<void>;
  /** Present on the real SDK Query (sdk.d.ts Query.setPermissionMode); absent on plain test fakes. */
  setPermissionMode?(mode: string): Promise<void>;
};
```

Extend `DriverHooks` (after `onPermissionRequest`):

```ts
  /**
   * Ask the session's current driver to approve the agent's plan (the
   * ExitPlanMode tool call, held at canUseTool). Same lifetime semantics as
   * onPermissionRequest: no timeout, resolvable by whoever is driving at
   * decision time, abort-safe.
   */
  onPlanRequest: (
    plan: string,
    signal?: AbortSignal,
  ) => Promise<"approve" | "reject">;
```

Add to `AgentDriver` fields:

```ts
  private pendingPlans = new Map<string, (d: "approve" | "reject") => void>();
```

In the constructor's hooks object (after `onPermissionRequest`), mirror its shape exactly:

```ts
      onPlanRequest: (plan, signal) => {
        const requestId = randomUUID();
        let resolve!: (d: "approve" | "reject") => void;
        const pending = new Promise<"approve" | "reject">((res) => {
          resolve = res;
        });
        this.pendingPlans.set(requestId, resolve);
        this.session.append({
          type: "plan_request",
          requestId,
          plan: plan.slice(0, 20000),
        });
        if (signal) {
          const rejectOnAbort = () => {
            if (!this.pendingPlans.delete(requestId)) return;
            this.session.append({
              type: "plan_decision",
              requestId,
              decision: "reject",
              userId: "system",
            });
            resolve("reject");
          };
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        }
        return pending;
      },
```

New methods (after `resolvePermission`):

```ts
  /**
   * Resolve a pending plan request. Driver-validated by the server at
   * DECISION time (wheel handoffs mid-plan are a feature). On approve, also
   * switch the SDK back to default permission mode — plan mode's job is done
   * once a plan is accepted; without this the agent would present plans
   * forever. The switch is fire-and-forget like setModel: mode-change is
   * logged optimistically and a trailing agent_error means it may not have
   * taken.
   */
  resolvePlan(
    requestId: string,
    decision: "approve" | "reject",
    userId: string,
  ): boolean {
    const resolve = this.pendingPlans.get(requestId);
    if (!resolve) return false;
    this.pendingPlans.delete(requestId);
    this.session.append({ type: "plan_decision", requestId, decision, userId });
    if (decision === "approve") {
      void this.stream.setPermissionMode?.("default").catch((err) =>
        this.session.append({
          type: "agent_error",
          message: `permission mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      this.session.append({ type: "permission_mode_change", mode: "default", userId });
    }
    resolve(decision);
    return true;
  }

  setPermissionMode(
    mode: "plan" | "default",
    userId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    if (this.pendingTurns > 0)
      return { ok: false, error: "agent is mid-turn — wait for it to finish" };
    if (!this.stream.setPermissionMode)
      return { ok: false, error: "plan mode not supported by this agent" };
    void this.stream.setPermissionMode(mode).catch((err) =>
      this.session.append({
        type: "agent_error",
        message: `permission mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    this.session.append({ type: "permission_mode_change", mode, userId });
    return { ok: true };
  }
```

Extend `denyAllPending` to flush plans too (append inside the method, after the permissions loop):

```ts
    for (const [requestId, resolve] of this.pendingPlans) {
      this.pendingPlans.delete(requestId);
      this.session.append({
        type: "plan_decision",
        requestId,
        decision: "reject",
        userId: "system",
      });
      resolve("reject");
    }
```

- [ ] **Step 5: Implement the `permissions.ts` branch** (in `buildCanUseTool`, after the TodoWrite check from Task 3, before the Bash check)

```ts
    // Plan mode's exit tool is the plan-approval gate: the plan rides the
    // tool input, the driver's decision rides the same held-promise machinery
    // as permission requests, but with its own event pair so the client can
    // render an approval card instead of a generic permission row.
    if (toolName === "ExitPlanMode") {
      const plan = (input as { plan?: unknown }).plan;
      const planText = typeof plan === "string" ? plan : "";
      try {
        const decision = await Promise.race([
          hooks.onPlanRequest(planText, options.signal),
          abortsToDeny(options.signal),
        ]);
        if (decision === "approve") return { behavior: "allow" };
        return {
          behavior: "deny",
          message:
            "The driving teammate asked for revisions. Revise the plan based on the conversation so far and present it again with ExitPlanMode.",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        hooks.onPermissionError?.(`plan flow failed: ${message}`);
        return { behavior: "deny", message: `plan flow failed: ${message}` };
      }
    }
```

- [ ] **Step 6: Implement the server handlers** (server.ts, after the `decide_skill` handler) and add a server-level test

```ts
      if (msg.type === "set_permission_mode") {
        if (msg.mode !== "plan" && msg.mode !== "default") {
          return sendError("set_permission_mode requires mode: plan|default");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can toggle plan mode — take the wheel first");
        }
        const result = ctx.entry.driver.setPermissionMode(msg.mode, ctx.userId);
        if (!result.ok) return sendError(result.error);
        return;
      }

      if (msg.type === "decide_plan") {
        if (
          typeof msg.requestId !== "string" ||
          (msg.decision !== "approve" && msg.decision !== "reject")
        ) {
          return sendError("decide_plan requires requestId and decision approve|reject");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can decide plans — take the wheel first");
        }
        if (!ctx.entry.driver.resolvePlan(msg.requestId, msg.decision, ctx.userId)) {
          return sendError("unknown or already-decided plan request");
        }
        return;
      }
```

Add `"plan_request"`, `"plan_decision"`, and `"permission_mode_change"` to the `INTERESTING` set. Append to `poc/server/test/server.test.ts`:

```ts
  it("guards set_permission_mode and decide_plan to the current driver", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const wsA = await connect(server.port);
    collect(wsA, []);
    wsA.send(JSON.stringify({ type: "join", sessionId: "pg1", userId: "u1", name: "Ana" }));
    await wait(50);
    const wsB = await connect(server.port);
    const seenB: any[] = [];
    collect(wsB, seenB);
    wsB.send(JSON.stringify({ type: "join", sessionId: "pg1", userId: "u2", name: "Ben" }));
    await wait(50);
    wsB.send(JSON.stringify({ type: "set_permission_mode", mode: "plan" }));
    wsB.send(JSON.stringify({ type: "decide_plan", requestId: "r1", decision: "approve" }));
    await wait(100);
    const errors = seenB.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors.some((e) => /toggle plan mode/.test(e))).toBe(true);
    expect(errors.some((e) => /decide plans/.test(e))).toBe(true);
    wsA.close();
    wsB.close();
  });
```

(The echoRun generator has no `setPermissionMode`, so a driver-side `set_permission_mode` test at this level would hit "plan mode not supported" — the supported path is covered by the driver-level tests in Step 2.)

- [ ] **Step 7: Run the full server suite**

Run: `cd poc/server && npx vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add poc/server/src/agentDriver.ts poc/server/src/permissions.ts poc/server/src/server.ts poc/server/test/
git commit -m "feat(server): plan mode toggle + ExitPlanMode approval gate with driver decisions"
```

---

### Task 7: Client — derivation for skills, todos, plan, subagent groups

**Files:**
- Modify: `poc/client/src/derive.ts`
- Test: `poc/client/src/derive.test.ts`

**Interfaces:**
- Consumes: Task 1's client `LoggedEvent` fields.
- Produces (all consumed by Tasks 8–11):

```ts
// added to DerivedState
skills: { name: string; description: string }[];
todos: { text: string; status: string }[];
suggestDecisions: Map<string, { decision: string; userId: string }>;
planDecisions: Map<string, { decision: string; userId: string }>;
permissionMode: string; // "default" | "plan"

// new exports
export type TranscriptGroup =
  | { kind: "main"; events: LoggedEvent[] }
  | { kind: "subagent"; parentId: string; label: string; status: "running" | "done"; events: LoggedEvent[] };
export function deriveTranscriptGroups(events: LoggedEvent[]): TranscriptGroup[];
```

- [ ] **Step 1: Write the failing tests** (append to `poc/client/src/derive.test.ts`, using its `ev()` helper)

```ts
describe("harness state", () => {
  it("folds roster, todos, suggest/plan decisions, and permission mode", () => {
    const s = deriveState([
      ev({ type: "skill_roster", skills: [{ name: "alpha", description: "d" }] }, 0),
      ev({ type: "todo_update", todos: [{ text: "old", status: "pending" }] }, 1),
      ev({ type: "todo_update", todos: [{ text: "new", status: "in_progress" }] }, 2),
      ev({ type: "skill_decision", suggestId: "sg1", decision: "run", userId: "u1" }, 3),
      ev({ type: "plan_decision", requestId: "pr1", decision: "reject", userId: "u1" }, 4),
      ev({ type: "permission_mode_change", mode: "plan", userId: "u1" }, 5),
    ]);
    expect(s.skills).toEqual([{ name: "alpha", description: "d" }]);
    expect(s.todos).toEqual([{ text: "new", status: "in_progress" }]); // latest wins
    expect(s.suggestDecisions.get("sg1")).toEqual({ decision: "run", userId: "u1" });
    expect(s.planDecisions.get("pr1")).toEqual({ decision: "reject", userId: "u1" });
    expect(s.permissionMode).toBe("plan");
  });

  it("defaults to empty harness state and default mode", () => {
    const s = deriveState([]);
    expect(s.skills).toEqual([]);
    expect(s.todos).toEqual([]);
    expect(s.permissionMode).toBe("default");
  });
});

describe("deriveTranscriptGroups", () => {
  const events = [
    ev({ type: "user_message", userId: "u1", text: "audit" }, 0),
    ev({ type: "tool_call", toolName: "Task", input: { description: "audit deps" }, toolUseId: "task-1" }, 1),
    ev({ type: "agent_text_delta", text: "scanning", parentToolUseId: "task-1" }, 2),
    ev({ type: "tool_call", toolName: "Read", input: {}, toolUseId: "t-sub", parentToolUseId: "task-1" }, 3),
    ev({ type: "agent_text_delta", text: "meanwhile, main agent" }, 4),
    ev({ type: "tool_result", toolName: "Read", output: "ok", toolUseId: "t-sub", parentToolUseId: "task-1" }, 5),
    ev({ type: "tool_result", toolName: "Task", output: "audit done", toolUseId: "task-1" }, 6),
  ];

  it("splits consecutive runs into main and labeled subagent groups", () => {
    const groups = deriveTranscriptGroups(events);
    expect(groups.map((g) => g.kind)).toEqual(["main", "subagent", "main", "subagent", "main"]);
    const sub = groups[1] as Extract<ReturnType<typeof deriveTranscriptGroups>[number], { kind: "subagent" }>;
    expect(sub.parentId).toBe("task-1");
    expect(sub.label).toBe("audit deps");
    expect(sub.status).toBe("done"); // parent Task tool_result exists in the log
    expect(sub.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("marks a subagent running until its parent tool_result arrives", () => {
    const groups = deriveTranscriptGroups(events.slice(0, 4));
    const sub = groups[1] as any;
    expect(sub.status).toBe("running");
  });

  it("labels orphan parent ids as a plain subagent instead of crashing", () => {
    const groups = deriveTranscriptGroups([
      ev({ type: "agent_text_delta", text: "ghost", parentToolUseId: "unknown-9" }, 0),
    ]);
    expect(groups).toEqual([
      {
        kind: "subagent",
        parentId: "unknown-9",
        label: "subagent",
        status: "running",
        events: [expect.objectContaining({ seq: 0 })],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npm test`
Expected: FAIL — new fields/function missing.

- [ ] **Step 3: Implement in `derive.ts`**

Extend `DerivedState` and its initializer:

```ts
export interface DerivedState {
  driverId: string | null;
  participants: Map<string, Participant>;
  objective: string | null;
  lastIntentSeq: number | null;
  permissionDecisions: Map<string, { decision: string; userId: string }>;
  model: string;
  agentBusy: boolean;
  skills: { name: string; description: string }[];
  todos: { text: string; status: string }[];
  suggestDecisions: Map<string, { decision: string; userId: string }>;
  planDecisions: Map<string, { decision: string; userId: string }>;
  permissionMode: string;
}
```

Initializer additions: `skills: [], todos: [], suggestDecisions: new Map(), planDecisions: new Map(), permissionMode: "default"`.

New switch cases (before the `user_message` busy block):

```ts
      case "skill_roster":
        s.skills = ev.skills ?? [];
        break;
      case "todo_update":
        s.todos = ev.todos ?? [];
        break;
      case "skill_decision":
        if (ev.suggestId && ev.decision && ev.userId)
          s.suggestDecisions.set(ev.suggestId, { decision: ev.decision, userId: ev.userId });
        break;
      case "plan_decision":
        if (ev.requestId && ev.decision && ev.userId)
          s.planDecisions.set(ev.requestId, { decision: ev.decision, userId: ev.userId });
        break;
      case "permission_mode_change":
        s.permissionMode = ev.mode ?? "default";
        break;
```

New grouping function (bottom of the file):

```ts
export type TranscriptGroup =
  | { kind: "main"; events: LoggedEvent[] }
  | {
      kind: "subagent";
      parentId: string;
      label: string;
      status: "running" | "done";
      events: LoggedEvent[];
    };

/**
 * Split the flat event log into consecutive main/subagent runs for nested
 * rendering. A subagent is keyed by the tool_use id of its spawning Task
 * call; its label comes from that call's input.description, its status flips
 * to done when the parent-level Task tool_result for that id appears. Orphan
 * parent ids (spawning call not in view) get a generic label — replay always
 * includes the spawn, but a malformed stream must degrade, not crash.
 */
export function deriveTranscriptGroups(events: LoggedEvent[]): TranscriptGroup[] {
  const labels = new Map<string, string>();
  const done = new Set<string>();
  for (const ev of events) {
    if (ev.type === "tool_call" && ev.toolName === "Task" && ev.toolUseId && !ev.parentToolUseId) {
      const desc = (ev.input as { description?: unknown } | undefined)?.description;
      labels.set(ev.toolUseId, typeof desc === "string" && desc ? desc : "subagent");
    }
    if (ev.type === "tool_result" && ev.toolUseId && !ev.parentToolUseId && labels.has(ev.toolUseId)) {
      done.add(ev.toolUseId);
    }
  }
  const groups: TranscriptGroup[] = [];
  for (const ev of events) {
    const parentId = ev.parentToolUseId;
    const last = groups.at(-1);
    if (parentId) {
      if (last?.kind === "subagent" && last.parentId === parentId) {
        last.events.push(ev);
      } else {
        groups.push({
          kind: "subagent",
          parentId,
          label: labels.get(parentId) ?? "subagent",
          status: done.has(parentId) ? "done" : "running",
          events: [ev],
        });
      }
    } else {
      if (last?.kind === "main") {
        last.events.push(ev);
      } else {
        groups.push({ kind: "main", events: [ev] });
      }
    }
  }
  return groups;
}
```

- [ ] **Step 4: Run tests and build**

Run: `cd poc/client && npm test && npm run build`
Expected: all pass, build clean.

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/derive.ts poc/client/src/derive.test.ts
git commit -m "feat(client): derive harness state and transcript groups (skills, todos, plan, subagents)"
```

---

### Task 8: Client — TodoPanel beside the party pane

**Files:**
- Create: `poc/client/src/components/TodoPanel.tsx`
- Modify: `poc/client/src/App.tsx:110-120` (the `.split` block)
- Modify: `poc/client/src/terminal.css` (after the `.party` block, `:184-203`)

**Interfaces:**
- Consumes: `derived.todos` from Task 7.
- Produces: `TodoPanel(props: { todos: { text: string; status: string }[] })` — renders `null` when empty.

- [ ] **Step 1: Create `TodoPanel.tsx`**

```tsx
const GLYPHS: Record<string, string> = {
  completed: "☒",
  in_progress: "◐",
  pending: "☐",
};

export function TodoPanel(props: { todos: { text: string; status: string }[] }) {
  if (props.todos.length === 0) return null;
  return (
    <aside className="todopanel term-frame">
      <div className="party-title">AGENT TODOS</div>
      {props.todos.map((t, i) => (
        <div key={i} className={`todo ${t.status}`}>
          {GLYPHS[t.status] ?? "☐"} {t.text}
        </div>
      ))}
    </aside>
  );
}
```

- [ ] **Step 2: Mount it in `App.tsx`** — inside the `.split` div, after `<PartyPane … />`:

```tsx
        <TodoPanel todos={derived.todos} />
```

(plus `import { TodoPanel } from "./components/TodoPanel";` at the top.)

- [ ] **Step 3: Style it in `terminal.css`** (after the `.party` media query at :203; same hide-below-900px behavior — the <900px summary treatment is an OPEN v4 decision, HANDOFF §7, don't solve it here)

```css
/* agent todo panel — mirrors the agent's TodoWrite list, hidden when empty */
.todopanel {
  width: 200px; overflow-y: auto; padding: var(--sp-3);
  display: flex; flex-direction: column; gap: var(--sp-1);
}
.todo { color: var(--dim); }
.todo.in_progress { color: var(--gold); }
.todo.completed { text-decoration: line-through; }
@media (max-width: 900px) { .todopanel { display: none; } }
```

- [ ] **Step 4: Verify build and tests**

Run: `cd poc/client && npm test && npm run build`
Expected: pass, clean.

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/components/TodoPanel.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): live agent todo panel beside the party pane"
```

---

### Task 9: Client — nested subagent groups + first-class skill cards in the transcript

**Files:**
- Modify: `poc/client/src/components/Transcript.tsx` (restructure the render loop around `deriveTranscriptGroups`)
- Modify: `poc/client/src/terminal.css` (new `.subagent`, `.skillcard` rules)

**Interfaces:**
- Consumes: `deriveTranscriptGroups` + `TranscriptGroup` from Task 7.
- Produces: no new exports — `Transcript` keeps its existing props (Tasks 10/11 add more).

- [ ] **Step 1: Restructure `Transcript.tsx`**

Extract the existing per-event `switch` into a local function so groups can reuse it:

```tsx
  const renderEvent = (ev: LoggedEvent) => {
    switch (ev.type) {
      // ... the existing cases, verbatim, with ONE addition to tool_call:
      case "tool_call": {
        const input = ev.input as { skill?: unknown; args?: unknown } | undefined;
        if (ev.toolName === "Skill") {
          return (
            <div key={ev.seq} className="skillcard">
              <span className="skillname">⚡ {typeof input?.skill === "string" ? input.skill : "skill"}</span>
              {typeof input?.args === "string" && input.args && <span className="dim"> {input.args.slice(0, 120)}</span>}
            </div>
          );
        }
        return (
          <div key={ev.seq} className="line dim">
            ⏺ {ev.toolName}({JSON.stringify(ev.input)?.slice(0, 200)})
          </div>
        );
      }
      // ...
    }
  };
```

Replace the `props.events.map(...)` body with grouped rendering (import `deriveTranscriptGroups` from `../derive`):

```tsx
      {deriveTranscriptGroups(props.events).map((group, gi) =>
        group.kind === "main" ? (
          group.events.map(renderEvent)
        ) : (
          <details key={`sub-${gi}-${group.parentId}`} className="subagent">
            <summary>
              ⚒ subagent: {group.label} · {group.status === "done" ? "done" : "running…"} · {group.events.length} rows
            </summary>
            {group.events.map(renderEvent)}
          </details>
        ),
      )}
```

Note: the `pending` permission filter and keyboard-shortcut effect above the return statement stay exactly as they are — they operate on the flat `props.events`, and grouping only changes presentation.

- [ ] **Step 2: Style in `terminal.css`** (after the permission block styles)

```css
/* subagent groups — collapsed nested transcript segments */
.subagent { border-left: 2px solid var(--frame); padding-left: var(--sp-3); margin: var(--sp-1) 0; }
.subagent > summary { color: var(--dim); cursor: pointer; list-style: none; }
.subagent > summary::before { content: "▸ "; }
.subagent[open] > summary::before { content: "▾ "; }

/* skill invocation — first-class, not a generic tool row */
.skillcard { color: var(--gold); }
.skillcard .skillname { font-weight: 600; }
```

- [ ] **Step 3: Verify build and tests**

Run: `cd poc/client && npm test && npm run build`
Expected: pass, clean.

- [ ] **Step 4: Commit**

```bash
git add poc/client/src/components/Transcript.tsx poc/client/src/terminal.css
git commit -m "feat(client): collapsible subagent groups and first-class skill cards in the transcript"
```

---

### Task 10: Client — slash autocomplete + suggestion chips

**Files:**
- Modify: `poc/client/src/components/PromptBar.tsx` (rewrite shown below)
- Modify: `poc/client/src/components/Transcript.tsx` (new `skill_suggest` case + props)
- Modify: `poc/client/src/App.tsx` (pass skills/handlers)
- Modify: `poc/client/src/terminal.css`

**Interfaces:**
- Consumes: `derived.skills`, `derived.suggestDecisions` (Task 7); server messages `suggest_skill`/`decide_skill` (Task 5).
- Produces: `PromptBar` props gain `skills: { name: string; description: string }[]` and `onSuggestSkill: (skill: string, args: string) => void`; `Transcript` props gain `onDecideSkill: (suggestId: string, decision: "run" | "dismiss") => void`.

- [ ] **Step 1: Rewrite `PromptBar.tsx`**

Behavior: `/` opens a roster autocomplete; `/name args` submits as a suggestion (driver's auto-run happens server-side); plain text still prompts (driver) or shows a hint (passenger). Passengers now get the input too — that is the point of the suggest flow.

```tsx
import { useState } from "react";

export function PromptBar(props: {
  isDriver: boolean; agentBusy: boolean; watcherNames: string[];
  skills: { name: string; description: string }[];
  onPrompt: (text: string) => void; onTakeWheel: () => void;
  onSuggestSkill: (skill: string, args: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const slash = text.match(/^\/(\S*)$/); // "/par" while still typing the name
  const matches = slash
    ? props.skills.filter((s) => s.name.startsWith(slash[1]))
    : [];

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    const cmd = t.match(/^\/(\S+)\s*(.*)$/);
    if (cmd) {
      props.onSuggestSkill(cmd[1], cmd[2]);
      setText("");
      setHint(null);
      return;
    }
    if (!props.isDriver) {
      setHint("watching — suggest a skill with /name, or take the wheel to prompt");
      return;
    }
    props.onPrompt(t);
    setText("");
    setHint(null);
  };

  return (
    <div className="promptbar">
      <div className="inputbox">
        <span className="caret">&gt;</span>
        <input
          ref={props.inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setHint(null); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={
            props.isDriver
              ? "you're driving — prompt the agent, or /skill…"
              : "watching — suggest a skill with /name args…"
          }
          maxLength={4000}
        />
        {matches.length > 0 && (
          <div className="slashmenu">
            {matches.map((s) => (
              <button key={s.name} onClick={() => { setText(`/${s.name} `); props.inputRef.current?.focus(); }}>
                <b>/{s.name}</b>{s.description && <span className="dim"> — {s.description}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {!props.isDriver && (
        <button className="wheel" onClick={props.onTakeWheel}>
          🛞 take the wheel
        </button>
      )}
      <div className="statusline">
        <span className={props.isDriver ? "driving" : ""}>
          {props.isDriver ? "🛞 you are driving" : "watching"}
        </span>
        {props.agentBusy && <span>✦ agent working…</span>}
        {hint && <span className="red">{hint}</span>}
        {props.watcherNames.length > 0 && (
          <span>{props.watcherNames.join(", ")} watching</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render suggestion chips in `Transcript.tsx`**

Add `onDecideSkill: (suggestId: string, decision: "run" | "dismiss") => void;` to the props, destructure `suggestDecisions` from `props.derived`, and add cases to `renderEvent`:

```tsx
          case "skill_suggest": {
            const decided = ev.suggestId ? suggestDecisions.get(ev.suggestId) : undefined;
            return (
              <div key={ev.seq} className="perm suggest">
                <div className="perm-title">
                  ⚡ {nameOf(ev.userId)} suggests <b>/{ev.skill}</b>
                  {ev.args && <span className="dim"> {ev.args.slice(0, 120)}</span>}
                </div>
                {decided ? (
                  <div className="perm-outcome">
                    {decided.decision === "run" ? "⚡ run" : "✕ dismissed"} by {nameOf(decided.userId)}
                  </div>
                ) : props.isDriver && ev.suggestId ? (
                  <div className="perm-actions">
                    <button onClick={() => props.onDecideSkill(ev.suggestId!, "run")}>run</button>
                    <button className="deny" onClick={() => props.onDecideSkill(ev.suggestId!, "dismiss")}>dismiss</button>
                  </div>
                ) : (
                  <div className="perm-outcome">⏳ driver deciding…</div>
                )}
              </div>
            );
          }
          case "skill_decision":
            return null; // folded into the suggest chip via suggestDecisions
```

- [ ] **Step 3: Wire `App.tsx`**

```tsx
  function onSuggestSkill(skill: string, args: string) {
    send({ type: "suggest_skill", skill, args });
  }

  function onDecideSkill(suggestId: string, decision: "run" | "dismiss") {
    send({ type: "decide_skill", suggestId, decision });
  }
```

Pass `skills={derived.skills}` and `onSuggestSkill={onSuggestSkill}` to `PromptBar`, `onDecideSkill={onDecideSkill}` to `Transcript`.

- [ ] **Step 4: Style the slash menu in `terminal.css`** (near the `.inputbox` styles; `.inputbox` needs `position: relative` if it doesn't have it)

```css
/* slash autocomplete — anchored above the prompt input */
.slashmenu {
  position: absolute; bottom: 100%; left: 0; right: 0;
  background: var(--input); border: 1px solid var(--frame);
  display: flex; flex-direction: column;
}
.slashmenu button {
  text-align: left; padding: var(--sp-1) var(--sp-3);
  background: none; border: 0; color: var(--fg); cursor: pointer;
  font: inherit;
}
.slashmenu button:hover { background: rgba(217, 119, 87, 0.12); }
.suggest .perm-title { color: var(--gold); }
```

- [ ] **Step 5: Verify build and tests**

Run: `cd poc/client && npm test && npm run build`
Expected: pass, clean.

- [ ] **Step 6: Commit**

```bash
git add poc/client/src/components/PromptBar.tsx poc/client/src/components/Transcript.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): slash-command autocomplete and passenger suggest/driver approve chips"
```

---

### Task 11: Client — plan-mode toggle + plan approval card

**Files:**
- Modify: `poc/client/src/components/Header.tsx`
- Modify: `poc/client/src/components/Transcript.tsx` (new `plan_request`/`permission_mode_change` cases + prop)
- Modify: `poc/client/src/App.tsx`
- Modify: `poc/client/src/terminal.css`

**Interfaces:**
- Consumes: `derived.permissionMode`, `derived.planDecisions` (Task 7); server messages `set_permission_mode`/`decide_plan` (Task 6).
- Produces: `Header` props gain `planMode: boolean; canTogglePlan: boolean; onTogglePlan: () => void`; `Transcript` props gain `onDecidePlan: (requestId: string, decision: "approve" | "reject") => void`.

- [ ] **Step 1: Add the toggle to `Header.tsx`** (after the model `<label>`, before the conn span)

```tsx
        <button
          className={props.planMode ? "planmode on" : "planmode"}
          disabled={!props.canTogglePlan}
          onClick={props.onTogglePlan}
          title={
            props.canTogglePlan
              ? "plan mode: the agent must present a plan for approval before acting"
              : "only the driver can toggle plan mode, between turns"
          }
        >
          {props.planMode ? "▣ plan mode" : "▢ plan mode"}
        </button>
```

with the new props added to the props type.

- [ ] **Step 2: Add transcript cases** (in `renderEvent`; destructure `planDecisions` from `props.derived`; add the `onDecidePlan` prop)

```tsx
          case "plan_request": {
            const decided = ev.requestId ? planDecisions.get(ev.requestId) : undefined;
            return (
              <div key={ev.seq} className="perm plancard">
                <div className="perm-title">📋 agent proposes a plan</div>
                <pre className="plan-body">{ev.plan}</pre>
                {decided ? (
                  <div className="perm-outcome">
                    {decided.decision === "approve" ? "✅ approved" : "↩ revisions requested"} by {nameOf(decided.userId)}
                  </div>
                ) : props.isDriver && ev.requestId ? (
                  <div className="perm-actions">
                    <button onClick={() => props.onDecidePlan(ev.requestId!, "approve")}>approve</button>
                    <button className="deny" onClick={() => props.onDecidePlan(ev.requestId!, "reject")}>request revision</button>
                  </div>
                ) : (
                  <div className="perm-outcome">⏳ driver deciding…</div>
                )}
              </div>
            );
          }
          case "plan_decision":
            return null; // folded into the plan card via planDecisions
          case "permission_mode_change":
            return (
              <div key={ev.seq} className="line gold">
                ✦ {nameOf(ev.userId)} switched plan mode {ev.mode === "plan" ? "on" : "off"}
              </div>
            );
```

(The plan body renders as preformatted text, not rendered markdown — no-new-dependencies constraint; the terminal aesthetic reads markdown source fine.)

- [ ] **Step 3: Wire `App.tsx`**

```tsx
  const planMode = derived.permissionMode === "plan";

  function onTogglePlan() {
    send({ type: "set_permission_mode", mode: planMode ? "default" : "plan" });
  }

  function onDecidePlan(requestId: string, decision: "approve" | "reject") {
    send({ type: "decide_plan", requestId, decision });
  }
```

Pass `planMode={planMode}`, `canTogglePlan={isDriver && !derived.agentBusy}`, `onTogglePlan={onTogglePlan}` to `Header`; `onDecidePlan={onDecidePlan}` to `Transcript`.

- [ ] **Step 4: Style in `terminal.css`**

```css
/* plan mode toggle + plan approval card */
.planmode {
  background: none; border: 1px solid var(--frame); color: var(--dim);
  padding: 0 var(--sp-2); cursor: pointer; font: inherit;
}
.planmode.on { color: var(--gold); border-color: var(--gold); }
.planmode:disabled { opacity: 0.5; cursor: default; }
.plan-body {
  margin: var(--sp-2) 0; padding: var(--sp-2) var(--sp-3);
  background: var(--input); overflow-x: auto; white-space: pre-wrap;
}
```

- [ ] **Step 5: Verify build and tests**

Run: `cd poc/client && npm test && npm run build`
Expected: pass, clean.

- [ ] **Step 6: Commit**

```bash
git add poc/client/src/components/Header.tsx poc/client/src/components/Transcript.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): driver plan-mode toggle and inline plan approval card"
```

---

### Task 12: Full verification + HANDOFF refresh

**Files:**
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch and an updated resume packet.

- [ ] **Step 1: Run every gate**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: clean compile; all tests pass (was 68 pre-v5a; now more).

Run: `cd ../client && npm test && npm run build`
Expected: all tests pass (was 11 pre-v5a; now more); build clean.

- [ ] **Step 2: Spec coverage check**

Open `docs/superpowers/specs/2026-07-25-harness-capabilities-design.md` and confirm each numbered section maps to landed code: §1 wire (Task 1), §2 server (Tasks 2–6), §3 client (Tasks 7–11), §4 testing (each task's tests). Record any gap as a fix commit, not a note.

- [ ] **Step 3: Live acceptance walkthrough** (controller session must start the stack — subagent sandboxes CANNOT launch the SDK native binary, HANDOFF §6)

Setup: kill stale listeners on 3001/5173/5174; `poc/scripts/demo-setup.sh`; server with `AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees AGENT_SKILLS=auth-migration-guide`; vite on :5173. Two tabs: `?project=demo&session=ana&name=ana` and `?project=demo&session=ana&name=ben`.

Checklist:
1. Both tabs show the roster-driven `/` autocomplete (type `/` in the prompt bar).
2. Passenger (non-driver tab) submits `/auth-migration-guide` → pending chip; driver clicks run → skill card renders, agent activity follows, chip shows "⚡ run by".
3. Driver asks for a task that spawns a subagent ("use a subagent to survey this repo's files") → collapsed `⚒ subagent` group appears, expands, flips to done.
4. Agent uses TodoWrite (ask it to plan a multi-step task) → TodoPanel appears beside the party pane and updates statuses.
5. Driver toggles `▣ plan mode` between turns → gold transcript line; next prompt produces a plan card; "request revision" makes the agent re-present; "approve" executes and flips mode off.
6. Wheel handoff mid-pending-plan: ben takes the wheel and approves — decision accepted.

- [ ] **Step 4: Refresh `HANDOFF.md`** (update in place: status → v5a implemented + verified; next steps → final whole-branch review, then finishing-a-development-branch; carry §7 items forward).

- [ ] **Step 5: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: HANDOFF — v5a harness capabilities implemented and live-verified"
```
