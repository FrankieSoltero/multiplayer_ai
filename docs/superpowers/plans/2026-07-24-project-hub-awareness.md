# Project Hub with Agent-Side Awareness (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple engineers each drive their own live agent session (own git worktree) within one project; sessions share an awareness layer — agents declare intent via a `set_intent` tool and receive a `<teammates>` digest of other sessions' intent + activity at prompt time.

**Architecture:** Extends the v1 PoC in place. New: `intent_update` session event emitted through an in-process MCP `set_intent` tool; a pure digest builder over session logs; a `Project` registry grouping sessions with a throttled `{type:"project"}` snapshot push; per-session worktree cwd via `AGENT_WORKDIR_ROOT`; a teammates sidebar in the client.

**Tech Stack:** unchanged (Node 20+, TS strict ESM, ws, `@anthropic-ai/claude-agent-sdk`, vitest, React/Vite) + `zod` (v4, already an SDK dependency — install as a direct dep).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-project-hub-awareness-design.md` — event shape, wire shape, and demo target come verbatim from it.
- New event type exactly: `{ type: "intent_update"; text: string }`, text capped at **200** chars at append time.
- New wire message exactly: `{ type: "project", sessions: [{ id, participants, driverName, intent, lastActivityTs, ended }] }`; project pushes throttled to ≥**1000ms** per project (leading push immediate, trailing push after the window).
- `join` gains `projectId` (optional; default `"default"`). Both `projectId` and `sessionId` must match `/^[a-z0-9-]{1,40}$/` — invalid → `{type:"error"}`.
- Digest injected into the SDK prompt only — the session log records the raw user text (transcripts stay clean).
- Session workdir = `path.join(AGENT_WORKDIR_ROOT, sessionId)` only when `AGENT_WORKDIR_ROOT` is set; otherwise v1 behavior. Never trust a client-supplied path.
- MCP tool: server name `awareness`, tool name `set_intent` → full tool id `mcp__awareness__set_intent` (add to `allowedTools`; do NOT add to `tools`, which lists built-in tools only). Verified against installed sdk.d.ts: `createSdkMcpServer({name, version?, tools})`, `tool(name, description, zodRawShape, handler)` with handler returning `Promise<{content: [{type:"text", text: string}]}>`; wire via `options.mcpServers: { awareness: <server> }`. If the installed SDK's types force a different shape, adapt at the SDK boundary only.
- `set_intent` failures must never break the agent turn (return an error tool result, don't throw past the handler).
- All existing v1 tests must keep passing unmodified (except where a task explicitly says to extend a file's tests — never edit existing assertions).
- TypeScript strict, ESM, `.js` local import extensions; no secrets in code or logs.

---

### Task 1: Intent events + `set_intent` tool

**Files:**
- Modify: `poc/server/src/events.ts`
- Modify: `poc/server/src/agentDriver.ts`
- Test: `poc/server/test/agentDriver.test.ts` (append only)

**Interfaces:**
- Consumes: `Session.append` (v1).
- Produces: `SessionEvent` gains `{ type: "intent_update"; text: string }`. `DriverHooks = { onIntent: (text: string) => void; workdir?: string }`. `RunQuery` becomes `(prompts, hooks: DriverHooks) => AsyncIterable<SdkMessage>` (v1 fakes with one param remain assignable). `AgentDriver` constructor becomes `(session, run?: RunQuery, workdir?: string)` and gains `get isDead(): boolean`.

- [ ] **Step 1: Install zod**

Run: `cd poc/server && npm install zod`
Expected: zod v4.x added to dependencies.

- [ ] **Step 2: Add the event type**

In `poc/server/src/events.ts`, add to the `SessionEvent` union (after the `agent_error` line):

```typescript
  | { type: "agent_error"; message: string }
  | { type: "intent_update"; text: string };
```

(i.e. replace the terminating `;` on `agent_error` and append the new variant.)

- [ ] **Step 3: Write the failing tests**

Append to `poc/server/test/agentDriver.test.ts`:

```typescript
describe("intent updates", () => {
  it("appends intent_update (truncated to 200 chars) when the SDK layer reports intent", async () => {
    const s = new Session("s1");
    const longIntent = "x".repeat(250);
    const intentRun: RunQuery = async function* (prompts, hooks) {
      for await (const _prompt of prompts) {
        hooks.onIntent("Migrating auth middleware to JWT");
        hooks.onIntent(longIntent);
        yield { type: "assistant", content: [{ type: "text", text: "done" }] };
        return;
      }
    };
    const driver = new AgentDriver(s, intentRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      const intents = s
        .eventsFrom(0)
        .filter((e) => e.type === "intent_update") as { text: string }[];
      expect(intents).toHaveLength(2);
      expect(intents[0].text).toBe("Migrating auth middleware to JWT");
      expect(intents[1].text).toHaveLength(200);
    });
  });

  it("exposes liveness via isDead", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, fakeRun);
    expect(driver.isDead).toBe(false);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => expect(driver.isDead).toBe(true)); // fakeRun returns after one prompt
  });
});
```

- [ ] **Step 4: Run to verify the new block fails**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: existing tests PASS; new tests FAIL (hooks param/isDead missing).

- [ ] **Step 5: Implement**

In `poc/server/src/agentDriver.ts`:

a) Change the imports and `RunQuery`/hooks types:

```typescript
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
```

```typescript
export interface DriverHooks {
  onIntent: (text: string) => void;
  workdir?: string;
}

export type RunQuery = (
  prompts: AsyncIterable<SdkUserMessage>,
  hooks: DriverHooks,
) => AsyncIterable<SdkMessage>;
```

b) Replace `runAgentQuery` with:

```typescript
export const runAgentQuery: RunQuery = (prompts, hooks) => {
  const awareness = createSdkMcpServer({
    name: "awareness",
    tools: [
      tool(
        "set_intent",
        "Declare or update the one-sentence summary of what you are currently working on, so teammates and their agents stay aware of it. Call this when you start a task and whenever your direction changes.",
        { text: z.string() },
        async ({ text }) => {
          try {
            hooks.onIntent(text);
            return { content: [{ type: "text", text: "intent recorded" }] };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `intent not recorded: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      ),
    ],
  });
  return query({
    prompt: prompts,
    options: {
      model: "claude-opus-4-8",
      systemPrompt:
        "You are a shared agent in a multiplayer project. Multiple teammates watch this session live and may hand control between them mid-task; other teammates run their own sessions in the same project. Keep responses focused. When you start working on a task, and whenever your direction changes, call the set_intent tool with one short sentence describing what you are doing. A <teammates> block in a prompt describes what other sessions in the project are doing — take it into account and avoid conflicting with in-flight work.",
      // `tools` restricts BUILT-IN tools only; the MCP set_intent tool arrives
      // via mcpServers and is auto-approved through allowedTools.
      allowedTools: ["Read", "Glob", "Grep", "mcp__awareness__set_intent"],
      tools: ["Read", "Glob", "Grep"],
      permissionMode: "default",
      mcpServers: { awareness },
      cwd: hooks.workdir ?? process.env.AGENT_WORKDIR ?? process.cwd(),
    },
  }) as unknown as AsyncIterable<SdkMessage>;
};
```

(Keep the existing boundary-cast comment above the cast.)

c) In `AgentDriver`: constructor becomes

```typescript
  constructor(
    private session: Session,
    run: RunQuery = runAgentQuery,
    workdir?: string,
  ) {
    void this.consume(
      run(this.prompts, {
        onIntent: (text) =>
          this.session.append({ type: "intent_update", text: text.slice(0, 200) }),
        workdir,
      }),
    );
  }

  get isDead(): boolean {
    return this.dead;
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS (v1 fakes typed `(prompts)` stay assignable to the two-param `RunQuery`), typecheck clean. If `tsc` rejects the `mcpServers`/`tool` shapes, adapt at the SDK boundary only per Global Constraints and record what changed.

- [ ] **Step 7: Commit**

```bash
git add poc/server
git commit -m "feat: intent_update events via in-process set_intent MCP tool"
```

---

### Task 2: Teammate digest (pure builder + prompt injection)

**Files:**
- Create: `poc/server/src/digest.ts`
- Modify: `poc/server/src/agentDriver.ts` (sendPrompt only)
- Test: `poc/server/test/digest.test.ts`; append one test to `poc/server/test/agentDriver.test.ts`

**Interfaces:**
- Consumes: `Session.eventsFrom(0)`, `LoggedEvent` (v1), `AgentDriver.isDead` (Task 1).
- Produces: `interface TeammateSummary { id: string; intent: string | null; recentToolCalls: { toolName: string; target: string }[]; ended: boolean }`; `summarizeSession(id: string, events: LoggedEvent[], ended: boolean): TeammateSummary`; `buildTeammateDigest(others: TeammateSummary[]): string` ("" when `others` empty). `AgentDriver.sendPrompt(userId, text, contextBlock?: string)`.

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/digest.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildTeammateDigest, summarizeSession } from "../src/digest.js";
import { Session } from "../src/session.js";

describe("summarizeSession", () => {
  it("extracts latest intent and last 5 tool-call targets", () => {
    const s = new Session("ana");
    s.append({ type: "intent_update", text: "old intent" });
    s.append({ type: "intent_update", text: "Migrating auth to JWT" });
    for (let i = 0; i < 6; i++) {
      s.append({
        type: "tool_call",
        toolName: "Read",
        input: { file_path: `src/f${i}.ts` },
      });
    }
    const sum = summarizeSession("ana", s.eventsFrom(0), false);
    expect(sum.intent).toBe("Migrating auth to JWT");
    expect(sum.recentToolCalls).toHaveLength(5);
    expect(sum.recentToolCalls[0].target).toBe("src/f1.ts"); // oldest of the last 5
    expect(sum.recentToolCalls[4].target).toBe("src/f5.ts");
    expect(sum.ended).toBe(false);
  });

  it("handles sessions with no intent and non-path tool inputs", () => {
    const s = new Session("ben");
    s.append({ type: "tool_call", toolName: "Glob", input: { pattern: "src/**" } });
    const sum = summarizeSession("ben", s.eventsFrom(0), true);
    expect(sum.intent).toBeNull();
    expect(sum.recentToolCalls[0].target).toBe("src/**");
    expect(sum.ended).toBe(true);
  });
});

describe("buildTeammateDigest", () => {
  it("returns empty string for no teammates", () => {
    expect(buildTeammateDigest([])).toBe("");
  });

  it("renders intent, activity, and ended state", () => {
    const digest = buildTeammateDigest([
      {
        id: "ana",
        intent: "Migrating auth to JWT",
        recentToolCalls: [{ toolName: "Read", target: "src/auth.ts" }],
        ended: false,
      },
      { id: "old", intent: "Did a thing", recentToolCalls: [], ended: true },
    ]);
    expect(digest).toContain("<teammates>");
    expect(digest).toContain("</teammates>");
    expect(digest).toContain('session "ana"');
    expect(digest).toContain("Migrating auth to JWT");
    expect(digest).toContain("Read(src/auth.ts)");
    expect(digest).toContain("(ended)");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd poc/server && npx vitest run test/digest.test.ts`
Expected: FAIL — cannot resolve `../src/digest.js`.

- [ ] **Step 3: Implement digest.ts**

```typescript
import type { LoggedEvent } from "./events.js";

export interface TeammateSummary {
  id: string;
  intent: string | null;
  recentToolCalls: { toolName: string; target: string }[];
  ended: boolean;
}

export function summarizeSession(
  id: string,
  events: LoggedEvent[],
  ended: boolean,
): TeammateSummary {
  let intent: string | null = null;
  const toolCalls: { toolName: string; target: string }[] = [];
  for (const ev of events) {
    if (ev.type === "intent_update") intent = ev.text;
    if (ev.type === "tool_call") {
      const input = (ev.input ?? {}) as Record<string, unknown>;
      const target = String(
        input.file_path ?? input.pattern ?? input.path ?? "",
      );
      toolCalls.push({ toolName: ev.toolName, target });
    }
  }
  return { id, intent, recentToolCalls: toolCalls.slice(-5), ended };
}

export function buildTeammateDigest(others: TeammateSummary[]): string {
  if (others.length === 0) return "";
  const lines: string[] = ["<teammates>"];
  for (const o of others) {
    const status = o.ended ? " (ended)" : "";
    lines.push(
      `- session "${o.id}"${status}: ${o.intent ?? "no declared intent yet"}`,
    );
    if (o.recentToolCalls.length > 0) {
      const activity = o.recentToolCalls
        .map((c) => `${c.toolName}(${c.target})`)
        .join(", ");
      lines.push(`  recent activity: ${activity}`);
    }
  }
  lines.push("</teammates>");
  return lines.join("\n");
}
```

- [ ] **Step 4: Extend sendPrompt**

In `poc/server/src/agentDriver.ts`, change `sendPrompt` so the log gets the raw text and the SDK gets the digest-prefixed text:

```typescript
  sendPrompt(userId: string, text: string, contextBlock?: string): void {
    if (this.dead) {
      this.session.append({
        type: "agent_error",
        message: "agent session has ended — restart the server to continue",
      });
      return;
    }
    this.session.append({ type: "user_message", userId, text });
    const promptText = contextBlock ? `${contextBlock}\n\n${text}` : text;
    this.prompts.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: promptText }] },
      parent_tool_use_id: null,
    });
  }
```

Append this test to `poc/server/test/agentDriver.test.ts` (echoRun-style fake that echoes the pushed prompt text back, proving injection reaches the SDK but not the log):

```typescript
describe("digest injection", () => {
  it("prefixes the SDK prompt with the context block but logs raw text only", async () => {
    const s = new Session("s1");
    const echoPrompt: RunQuery = async function* (prompts) {
      for await (const prompt of prompts) {
        yield {
          type: "assistant",
          content: [
            { type: "text", text: `SDK saw: ${prompt.message.content[0].text}` },
          ],
        };
        return;
      }
    };
    const driver = new AgentDriver(s, echoPrompt);
    driver.sendPrompt("u1", "add rate limiting", "<teammates>\n- session \"ana\": Migrating auth\n</teammates>");
    await vi.waitFor(() => {
      const events = s.eventsFrom(0);
      const userMsg = events.find((e) => e.type === "user_message") as { text: string };
      const agentText = events.find((e) => e.type === "agent_text_delta") as { text: string };
      expect(userMsg.text).toBe("add rate limiting");
      expect(agentText.text).toContain("<teammates>");
      expect(agentText.text).toContain("add rate limiting");
    });
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: all PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add poc/server
git commit -m "feat: teammate digest builder and prompt-time injection"
```

---

### Task 3: Project registry, snapshots, and server wiring

**Files:**
- Create: `poc/server/src/project.ts`
- Modify: `poc/server/src/session.ts` (add `participantList` getter)
- Modify: `poc/server/src/server.ts` (full replacement below)
- Test: `poc/server/test/project.test.ts`; append to `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `Session`, `AgentDriver` (+`isDead`, 3-arg constructor, 3-arg `sendPrompt`), `summarizeSession`, `buildTeammateDigest`.
- Produces: `Session.participantList: { userId: string; name: string }[]` (getter). `class Project { readonly id; readonly sessions: Map<string, ProjectSessionEntry>; readonly watchers: Set<WebSocket-like> }` with `interface ProjectSessionEntry { session: Session; driver: AgentDriver }`; `projectSnapshot(project): ProjectMessage` where `ProjectMessage = { type: "project"; sessions: { id: string; participants: string[]; driverName: string | null; intent: string | null; lastActivityTs: string | null; ended: boolean }[] }`; `SLUG = /^[a-z0-9-]{1,40}$/`. `startServer` unchanged signature.

- [ ] **Step 1: Session getter**

Add to `Session` (after `driverId` getter):

```typescript
  get participantList(): { userId: string; name: string }[] {
    return [...this.participants.entries()].map(([userId, name]) => ({
      userId,
      name,
    }));
  }
```

- [ ] **Step 2: Write failing project tests**

Create `poc/server/test/project.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Project, projectSnapshot, SLUG } from "../src/project.js";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery } from "../src/agentDriver.js";

const idleRun: RunQuery = async function* (prompts) {
  for await (const _p of prompts) {
    /* never yields; stays alive */
  }
};

function addSession(project: Project, id: string): Session {
  const session = new Session(id);
  project.sessions.set(id, { session, driver: new AgentDriver(session, idleRun) });
  return session;
}

describe("SLUG", () => {
  it("accepts lowercase slugs and rejects traversal/uppercase/overlong ids", () => {
    expect(SLUG.test("ana-1")).toBe(true);
    expect(SLUG.test("../etc")).toBe(false);
    expect(SLUG.test("Ana")).toBe(false);
    expect(SLUG.test("a".repeat(41))).toBe(false);
    expect(SLUG.test("")).toBe(false);
  });
});

describe("projectSnapshot", () => {
  it("derives participants, driver, intent, lastActivity, ended per session", () => {
    const project = new Project("demo");
    const ana = addSession(project, "ana");
    ana.join("u1", "Ana");
    ana.append({ type: "intent_update", text: "Migrating auth" });
    addSession(project, "ben");

    const snap = projectSnapshot(project);
    expect(snap.type).toBe("project");
    expect(snap.sessions).toHaveLength(2);
    const anaSnap = snap.sessions.find((s) => s.id === "ana")!;
    expect(anaSnap.participants).toEqual(["Ana"]);
    expect(anaSnap.driverName).toBe("Ana");
    expect(anaSnap.intent).toBe("Migrating auth");
    expect(anaSnap.ended).toBe(false);
    expect(typeof anaSnap.lastActivityTs).toBe("string");
    const benSnap = snap.sessions.find((s) => s.id === "ben")!;
    expect(benSnap.intent).toBeNull();
    expect(benSnap.driverName).toBeNull();
    expect(benSnap.lastActivityTs).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd poc/server && npx vitest run test/project.test.ts`
Expected: FAIL — cannot resolve `../src/project.js`.

- [ ] **Step 4: Implement project.ts**

```typescript
import type { AgentDriver } from "./agentDriver.js";
import { summarizeSession } from "./digest.js";
import type { Session } from "./session.js";

export const SLUG = /^[a-z0-9-]{1,40}$/;

export interface ProjectSessionEntry {
  session: Session;
  driver: AgentDriver;
}

/** Minimal structural type so tests don't need real sockets. */
export interface ProjectWatcher {
  send(data: string): void;
  readyState: number;
}

export class Project {
  readonly id: string;
  readonly sessions = new Map<string, ProjectSessionEntry>();
  readonly watchers = new Set<ProjectWatcher>();

  constructor(id: string) {
    this.id = id;
  }
}

export interface ProjectMessage {
  type: "project";
  sessions: {
    id: string;
    participants: string[];
    driverName: string | null;
    intent: string | null;
    lastActivityTs: string | null;
    ended: boolean;
  }[];
}

export function projectSnapshot(project: Project): ProjectMessage {
  const sessions = [...project.sessions.entries()].map(([id, entry]) => {
    const events = entry.session.eventsFrom(0);
    const summary = summarizeSession(id, events, entry.driver.isDead);
    const participants = entry.session.participantList;
    const driverId = entry.session.driverId;
    return {
      id,
      participants: participants.map((p) => p.name),
      driverName:
        participants.find((p) => p.userId === driverId)?.name ?? null,
      intent: summary.intent,
      lastActivityTs: events.at(-1)?.ts ?? null,
      ended: summary.ended,
    };
  });
  return { type: "project", sessions };
}
```

- [ ] **Step 5: Replace server.ts**

Replace `poc/server/src/server.ts` entirely with:

```typescript
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { AgentDriver, runAgentQuery, type RunQuery } from "./agentDriver.js";
import { buildTeammateDigest, summarizeSession } from "./digest.js";
import {
  Project,
  projectSnapshot,
  SLUG,
  type ProjectSessionEntry,
} from "./project.js";
import { Session } from "./session.js";

const MAX_PROMPT_LENGTH = 4000;
const PROJECT_PUSH_INTERVAL_MS = 1000;

interface ClientContext {
  project: Project;
  entry: ProjectSessionEntry;
  userId: string;
  unsubscribe: () => void;
}

const INTERESTING = new Set([
  "intent_update",
  "presence_join",
  "presence_leave",
  "user_message",
]);

export async function startServer(opts: { port: number; runQuery?: RunQuery }) {
  const runQuery = opts.runQuery ?? runAgentQuery;
  const projects = new Map<string, Project>();
  const lastPush = new Map<Project, number>();
  const pushTimers = new Map<Project, NodeJS.Timeout>();

  function pushProject(project: Project): void {
    const payload = JSON.stringify(projectSnapshot(project));
    for (const watcher of project.watchers) {
      if (watcher.readyState === WebSocket.OPEN) watcher.send(payload);
    }
    lastPush.set(project, Date.now());
  }

  function schedulePush(project: Project): void {
    if (pushTimers.has(project)) return; // trailing push already queued
    const elapsed = Date.now() - (lastPush.get(project) ?? 0);
    if (elapsed >= PROJECT_PUSH_INTERVAL_MS) {
      pushProject(project);
      return;
    }
    const timer = setTimeout(() => {
      pushTimers.delete(project);
      pushProject(project);
    }, PROJECT_PUSH_INTERVAL_MS - elapsed);
    pushTimers.set(project, timer);
  }

  function getOrCreateProject(projectId: string): Project {
    let project = projects.get(projectId);
    if (!project) {
      project = new Project(projectId);
      projects.set(projectId, project);
    }
    return project;
  }

  function getOrCreateSession(
    project: Project,
    sessionId: string,
  ): ProjectSessionEntry {
    let entry = project.sessions.get(sessionId);
    if (!entry) {
      const session = new Session(sessionId);
      const root = process.env.AGENT_WORKDIR_ROOT;
      const workdir = root ? path.join(root, sessionId) : undefined;
      entry = { session, driver: new AgentDriver(session, runQuery, workdir) };
      project.sessions.set(sessionId, entry);
      // Project-level awareness: any interesting event on any member session
      // schedules a throttled snapshot push to the whole project.
      session.subscribe((event) => {
        if (INTERESTING.has(event.type)) schedulePush(project);
      });
    }
    return entry;
  }

  function digestFor(project: Project, sessionId: string): string {
    const others = [...project.sessions.entries()]
      .filter(([id]) => id !== sessionId)
      .map(([id, entry]) =>
        summarizeSession(id, entry.session.eventsFrom(0), entry.driver.isDead),
      );
    return buildTeammateDigest(others);
  }

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    let ctx: ClientContext | null = null;

    const sendError = (message: string) =>
      ws.send(JSON.stringify({ type: "error", message }));

    // Without a listener, an "error" event on this socket would be an
    // unhandled EventEmitter error and crash the whole process. Cleanup
    // (unsubscribe/leave) is handled by the "close" handler, which always
    // follows an "error" event on a ws socket.
    ws.on("error", (err: NodeJS.ErrnoException) => {
      void err?.code;
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError("invalid JSON");
      }

      if (msg.type === "join") {
        if (ctx) {
          return sendError("already joined");
        }
        if (
          typeof msg.sessionId !== "string" ||
          typeof msg.userId !== "string" ||
          typeof msg.name !== "string"
        ) {
          return sendError("join requires sessionId, userId, name");
        }
        const projectId =
          typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId) || !SLUG.test(msg.sessionId)) {
          return sendError(
            "projectId and sessionId must be 1-40 chars of a-z, 0-9, -",
          );
        }
        const project = getOrCreateProject(projectId);
        const entry = getOrCreateSession(project, msg.sessionId);
        // Replay first, then subscribe, then join — single-threaded, so no gap.
        const from =
          Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0 ? msg.lastSeq : 0;
        for (const event of entry.session.eventsFrom(from)) {
          ws.send(JSON.stringify({ type: "event", event }));
        }
        const unsubscribe = entry.session.subscribe((event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "event", event }));
          }
        });
        ctx = { project, entry, userId: msg.userId, unsubscribe };
        project.watchers.add(ws);
        entry.session.join(msg.userId, msg.name.slice(0, 40));
        // Immediate personal snapshot so the sidebar isn't blank until the
        // next throttled push.
        ws.send(JSON.stringify(projectSnapshot(project)));
        return;
      }

      if (!ctx) return sendError("join a session first");

      if (msg.type === "prompt") {
        if (typeof msg.text !== "string" || msg.text.length === 0) {
          return sendError("prompt requires text");
        }
        if (msg.text.length > MAX_PROMPT_LENGTH) {
          return sendError(`prompt too long (max ${MAX_PROMPT_LENGTH})`);
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("you are not driving — take the wheel first");
        }
        const digest = digestFor(ctx.project, ctx.entry.session.id);
        ctx.entry.driver.sendPrompt(
          ctx.userId,
          msg.text,
          digest || undefined,
        );
        return;
      }

      if (msg.type === "take_wheel") {
        ctx.entry.session.takeWheel(ctx.userId);
        return;
      }

      sendError(`unknown message type: ${String(msg.type)}`);
    });

    ws.on("close", () => {
      if (ctx) {
        ctx.unsubscribe();
        ctx.project.watchers.delete(ws);
        ctx.entry.session.leave(ctx.userId);
        ctx = null;
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, resolve));
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

- [ ] **Step 6: Append integration tests**

Append to `poc/server/test/server.test.ts` (reuse its existing `connect`/`collect`/`wait` helpers and `afterEach` cleanup):

```typescript
describe("project awareness", () => {
  const intentEchoRun: RunQuery = async function* (prompts, hooks) {
    for await (const prompt of prompts) {
      hooks.onIntent("Migrating auth to JWT");
      yield {
        type: "assistant",
        content: [
          { type: "text", text: `echo: ${prompt.message.content[0].text}` },
        ],
      };
    }
  };

  it("rejects invalid project/session slugs", async () => {
    const server = await startServer({ port: 0, runQuery: intentEchoRun });
    close = server.close;
    const ws1 = await connect(server.port);
    const seen: any[] = [];
    collect(ws1, seen);
    ws1.send(
      JSON.stringify({
        type: "join",
        projectId: "demo",
        sessionId: "../oops",
        userId: "u1",
        name: "Ana",
      }),
    );
    await wait(100);
    expect(seen.some((m) => m.type === "error")).toBe(true);
    ws1.close();
  });

  it("pushes project snapshots with intent across sessions and injects the digest", async () => {
    const server = await startServer({ port: 0, runQuery: intentEchoRun });
    close = server.close;

    // Ana joins session "ana" in project "demo" and prompts (agent declares intent)
    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(
      JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }),
    );
    wsAna.send(JSON.stringify({ type: "prompt", text: "migrate auth" }));
    await wait(200);

    // Ben joins a DIFFERENT session in the same project
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(
      JSON.stringify({ type: "join", projectId: "demo", sessionId: "ben", userId: "u2", name: "Ben" }),
    );
    await wait(200);

    // Ben's immediate project snapshot includes Ana's session and intent
    const projectMsgs = seenBen.filter((m) => m.type === "project");
    expect(projectMsgs.length).toBeGreaterThan(0);
    const anaEntry = projectMsgs
      .at(-1)
      .sessions.find((s: any) => s.id === "ana");
    expect(anaEntry.intent).toBe("Migrating auth to JWT");

    // Ben prompts: the digest (with Ana's intent) is injected into HIS prompt
    wsBen.send(JSON.stringify({ type: "prompt", text: "add rate limiting" }));
    await wait(300);
    const benEcho = seenBen
      .map((m) => m.event)
      .find((e) => e?.type === "agent_text_delta" && e.text.includes("echo:"));
    expect(benEcho.text).toContain("<teammates>");
    expect(benEcho.text).toContain("Migrating auth to JWT");
    expect(benEcho.text).toContain("add rate limiting");
    // Ben's own transcript logs the raw text only
    const benUserMsg = seenBen
      .map((m) => m.event)
      .find((e) => e?.type === "user_message");
    expect(benUserMsg.text).toBe("add rate limiting");

    wsAna.close();
    wsBen.close();
  });
});
```

Note: the existing v1 tests join without `projectId` and must keep passing (default project).

- [ ] **Step 7: Run all tests + typecheck**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: all PASS (existing 21 + new), clean.

- [ ] **Step 8: Commit**

```bash
git add poc/server
git commit -m "feat: project registry with throttled awareness snapshots and digest wiring"
```

---

### Task 4: Demo setup script + env/README

**Files:**
- Create: `poc/scripts/demo-setup.sh` (chmod +x)
- Modify: `poc/server/.env.example`, `README.md`, `.gitignore`

- [ ] **Step 1: Setup script**

Create `poc/scripts/demo-setup.sh`:

```bash
#!/usr/bin/env bash
# Creates a tiny demo repo + per-session git worktrees for the v2 demo.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf demo-project demo-worktrees
mkdir -p demo-project demo-worktrees
cd demo-project
git init -q -b main

mkdir -p src
cat > src/auth.ts <<'TS'
// Legacy session-cookie auth middleware (to be migrated to JWT).
export function authMiddleware(req: { cookies: Record<string, string> }): boolean {
  return Boolean(req.cookies["session_id"]);
}
TS
cat > src/api.ts <<'TS'
// API entry points. Rate limiting not yet implemented.
import { authMiddleware } from "./auth.js";
export function handleRequest(req: { cookies: Record<string, string> }): string {
  if (!authMiddleware(req)) return "401";
  return "200 ok";
}
TS
cat > README.md <<'MD'
# Demo project
A tiny fake service used to demo multiplayer agent sessions.
MD
git add -A && git commit -qm "init demo project"

git worktree add -q ../demo-worktrees/ana -b ana
git worktree add -q ../demo-worktrees/ben -b ben
echo "Worktrees ready. Start the server with:"
echo "  AGENT_WORKDIR_ROOT=$(cd ../demo-worktrees && pwd) npm run dev"
```

Run: `chmod +x poc/scripts/demo-setup.sh && poc/scripts/demo-setup.sh`
Expected: prints the worktrees-ready message; `poc/demo-worktrees/{ana,ben}` exist.

- [ ] **Step 2: Env + gitignore + README**

Append to `.gitignore` (repo root):

```gitignore
poc/demo-project/
poc/demo-worktrees/
```

Append to `poc/server/.env.example`:

```
# Optional: per-session worktree root for multi-session projects (v2).
# Each session gets AGENT_WORKDIR_ROOT/<sessionId> as its working directory.
AGENT_WORKDIR_ROOT=
```

Add to `README.md` after the "Run the PoC" section:

```markdown
## Run the v2 multi-session demo

1. `poc/scripts/demo-setup.sh` — creates a demo repo + `ana`/`ben` worktrees.
2. `cd poc/server && AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees npm run dev`
3. `cd poc/client && npm run dev`
4. Tab A: http://localhost:5173/?project=demo&session=ana — prompt: an auth→JWT
   migration task. The agent declares its intent (🎯) and it appears in Tab B's
   teammates sidebar.
5. Tab B: http://localhost:5173/?project=demo&session=ben — prompt: a
   rate-limiting task *without mentioning Ana*. Ben's agent should acknowledge
   Ana's in-flight migration via the injected `<teammates>` digest.
```

- [ ] **Step 3: Commit**

```bash
git add poc/scripts .gitignore poc/server/.env.example README.md
git commit -m "feat: demo worktree setup script and v2 run instructions"
```

---

### Task 5: Client — project param, teammates sidebar, intent display

**Files:**
- Modify: `poc/client/src/App.tsx`
- Modify: `poc/client/src/App.css` (append)

**Interfaces:**
- Consumes: wire messages from Task 3 (`join` with `projectId`; `{type:"project"}` pushes; `intent_update` events in the session stream).
- Produces: UI only.

- [ ] **Step 1: App.tsx changes** (surgical edits, not a rewrite)

a) Add types + state:

```typescript
type ProjectSessionInfo = {
  id: string;
  participants: string[];
  driverName: string | null;
  intent: string | null;
  lastActivityTs: string | null;
  ended: boolean;
};
```

Inside `App()`: `const [projectSessions, setProjectSessions] = useState<ProjectSessionInfo[]>([]);` and URL parsing:

```typescript
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session") ?? "demo";
  const projectId = params.get("project") ?? "default";
```

b) `join` message gains `projectId`; `ws.onmessage` gains:

```typescript
        if (msg.type === "project") setProjectSessions(msg.sessions);
```

(Update the effect dependency array to `[projectId, sessionId, userId, name]`.)

c) Own intent derived in the existing `useMemo` (add `let myIntent: string | null = null;` and `if (ev.type === "intent_update") myIntent = ev.text ?? null;`, return it) and rendered under the header:

```tsx
      {myIntent && <div className="my-intent">🎯 {myIntent}</div>}
```

d) Transcript renders `intent_update`:

```tsx
            case "intent_update":
              return (
                <div key={ev.seq} className="msg system">
                  🎯 agent intent: {ev.text}
                </div>
              );
```

e) Teammates sidebar — wrap the current `<main className="transcript">` in a flex row with an aside listing every project session except the current one:

```tsx
      <div className="workspace">
        <main className="transcript">{/* existing transcript children unchanged */}</main>
        <aside className="teammates">
          <h2>Project: {projectId}</h2>
          {projectSessions
            .filter((s) => s.id !== sessionId)
            .map((s) => (
              <a
                key={s.id}
                className={s.ended ? "teammate ended" : "teammate"}
                href={`?project=${projectId}&session=${s.id}`}
              >
                <div className="teammate-id">
                  {s.id} {s.ended ? "(ended)" : ""}
                </div>
                <div className="teammate-intent">
                  {s.intent ?? "no declared intent yet"}
                </div>
                <div className="teammate-meta">
                  {s.participants.join(", ") || "empty"}
                  {s.driverName ? ` · 🛞 ${s.driverName}` : ""}
                  {s.lastActivityTs
                    ? ` · ${new Date(s.lastActivityTs).toLocaleTimeString()}`
                    : ""}
                </div>
              </a>
            ))}
          {projectSessions.filter((s) => s.id !== sessionId).length === 0 && (
            <div className="teammate-empty">No other sessions yet</div>
          )}
        </aside>
      </div>
```

Header shows the project too: `session <code>{sessionId}</code> · project <code>{projectId}</code>`.

- [ ] **Step 2: Append CSS**

Append to `poc/client/src/App.css`:

```css
.workspace { flex: 1; display: flex; gap: 12px; min-height: 0; }
.workspace .transcript { flex: 1; }
.teammates { width: 240px; overflow-y: auto; border: 1px solid #262b38; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.teammates h2 { font-size: 0.9rem; margin: 0 0 4px; color: #8fa3c0; }
.teammate { display: block; background: #171a21; border: 1px solid #262b38; border-radius: 6px; padding: 8px; text-decoration: none; color: inherit; }
.teammate:hover { border-color: #3b82f6; }
.teammate.ended { opacity: 0.55; }
.teammate-id { font-family: monospace; font-size: 0.8rem; color: #8fa3c0; }
.teammate-intent { font-size: 0.9rem; margin: 4px 0; }
.teammate-meta { font-size: 0.75rem; color: #6b7280; }
.teammate-empty { font-size: 0.85rem; color: #6b7280; }
.my-intent { font-size: 0.9rem; color: #b9a44c; padding: 2px 0 8px; }
```

- [ ] **Step 3: Build**

Run: `cd poc/client && npm run build`
Expected: clean, zero TS errors.

- [ ] **Step 4: Commit**

```bash
git add poc/client
git commit -m "feat: project param, teammates sidebar, and intent display in client"
```

---

### Task 6: v2 acceptance (controller-run)

**Files:** none (evidence recorded in the run report; deviations to `docs/mistakes-and-fixes.md`).

- [ ] **Step 1:** Run `poc/scripts/demo-setup.sh`; start server with `AGENT_WORKDIR_ROOT` pointing at `poc/demo-worktrees`; start client.
- [ ] **Step 2:** Browser tab A → `?project=demo&session=ana`; prompt: "Migrate the auth middleware in src/auth.ts from session cookies to JWT. Start by reading the current implementation and describing your plan." Verify: `set_intent` fires (🎯 in transcript + Tab B sidebar shows the intent), agent reads files from the **ana** worktree.
- [ ] **Step 3:** Browser tab B → `?project=demo&session=ben`; prompt (no mention of Ana): "Add rate limiting to the API in src/api.ts — read it first and describe your plan." PASS requires Ben's agent's reply to reference Ana's in-flight auth/JWT work unprompted (via the digest) and shape its plan accordingly.
- [ ] **Step 4:** Verify the sidebar's drop-in link: from tab B, open Ana's session, take the wheel, confirm v1 mechanics still work in the project world.
- [ ] **Step 5:** Record results (and any live bugs → fix rounds, as in v1) before final review.
