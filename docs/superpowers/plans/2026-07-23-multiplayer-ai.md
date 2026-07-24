# Multiplayer AI Research + PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a proof-of-concept where multiple browser tabs share one live Claude agent session (watch, take the wheel, redirect), plus a research/feasibility report on YC's "Multiplayer AI" RFS for the dev-tools vertical.

**Architecture:** A single Node/TypeScript server owns each session as an in-memory object holding an append-only event log with monotonic sequence numbers. An agent driver feeds prompts to one long-lived Claude Agent SDK `query()` session (streaming-input mode) and appends every agent message to the log. A WebSocket hub broadcasts each appended event to all connected clients; late joiners replay the log from seq 0. A grab-based steering lock decides who may prompt. React/Vite client renders the shared transcript.

**Tech Stack:** Node 20+, TypeScript (strict, ESM), `ws`, `@anthropic-ai/claude-agent-sdk`, vitest, React + Vite.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-multiplayer-ai-design.md` — event types and control model come verbatim from it.
- Event types: `user_message`, `agent_text_delta`, `tool_call`, `tool_result`, `control_change`, `presence_join`, `presence_leave`, `agent_error`.
- API key only via `.env` (`ANTHROPIC_API_KEY`), gitignored; never hardcoded, never logged.
- User message text capped at 4000 chars, validated server-side.
- Server listens on port 3001; Vite client on its default 5173.
- Agent model: `claude-opus-4-8`; agent tools restricted to read-only (`Read`, `Glob`, `Grep`) for the PoC.
- All server/client code is ESM (`"type": "module"`); imports of local files use `.js` extensions.
- The Claude Agent SDK message shapes below match the current docs; if the installed SDK's TypeScript types disagree, adapt at the driver boundary only (Task 3) — the event-log types never change.

---

### Task 1: Server scaffold + Session event log

**Files:**
- Create: `.gitignore` (repo root)
- Create: `poc/server/package.json`
- Create: `poc/server/tsconfig.json`
- Create: `poc/server/src/events.ts`
- Create: `poc/server/src/session.ts`
- Test: `poc/server/test/session.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `SessionEvent` (union of the 8 spec event types), `LoggedEvent = SessionEvent & { seq: number; ts: string }`, `class Session` with `append(event: SessionEvent): LoggedEvent`, `eventsFrom(seq: number): LoggedEvent[]`, `subscribe(fn: (e: LoggedEvent) => void): () => void`, and `readonly id: string`.

- [ ] **Step 1: Create repo-level .gitignore**

```gitignore
node_modules/
dist/
.env
.DS_Store
```

- [ ] **Step 2: Scaffold the server package**

Create `poc/server/package.json`:

```json
{
  "name": "multiplayer-ai-server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Create `poc/server/tsconfig.json`:

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

Install dependencies:

```bash
cd poc/server
npm install ws @anthropic-ai/claude-agent-sdk
npm install -D typescript tsx vitest @types/node @types/ws
```

Expected: `package.json` gains `dependencies` and `devDependencies`; `node_modules` created.

- [ ] **Step 3: Write the event types**

Create `poc/server/src/events.ts`:

```typescript
export type SessionEvent =
  | { type: "user_message"; userId: string; text: string }
  | { type: "agent_text_delta"; text: string }
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; output: string }
  | { type: "control_change"; userId: string }
  | { type: "presence_join"; userId: string; name: string }
  | { type: "presence_leave"; userId: string }
  | { type: "agent_error"; message: string };

export type LoggedEvent = SessionEvent & { seq: number; ts: string };
```

- [ ] **Step 4: Write the failing tests for the event log**

Create `poc/server/test/session.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import type { LoggedEvent } from "../src/events.js";

describe("Session event log", () => {
  it("appends events with monotonic sequence numbers and timestamps", () => {
    const s = new Session("s1");
    const a = s.append({ type: "user_message", userId: "u1", text: "hi" });
    const b = s.append({ type: "agent_text_delta", text: "hello" });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(typeof a.ts).toBe("string");
  });

  it("replays events from a given sequence number", () => {
    const s = new Session("s1");
    s.append({ type: "agent_text_delta", text: "one" });
    s.append({ type: "agent_text_delta", text: "two" });
    s.append({ type: "agent_text_delta", text: "three" });
    const replay = s.eventsFrom(1);
    expect(replay.map((e) => e.seq)).toEqual([1, 2]);
    expect(s.eventsFrom(0)).toHaveLength(3);
  });

  it("notifies subscribers of new events and stops after unsubscribe", () => {
    const s = new Session("s1");
    const received: LoggedEvent[] = [];
    const unsubscribe = s.subscribe((e) => received.push(e));
    s.append({ type: "agent_text_delta", text: "one" });
    unsubscribe();
    s.append({ type: "agent_text_delta", text: "two" });
    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(0);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run`
Expected: FAIL — cannot resolve `../src/session.js`.

- [ ] **Step 6: Implement Session**

Create `poc/server/src/session.ts`:

```typescript
import type { LoggedEvent, SessionEvent } from "./events.js";

export class Session {
  readonly id: string;
  private log: LoggedEvent[] = [];
  private subscribers = new Set<(e: LoggedEvent) => void>();

  constructor(id: string) {
    this.id = id;
  }

  append(event: SessionEvent): LoggedEvent {
    const logged: LoggedEvent = {
      ...event,
      seq: this.log.length,
      ts: new Date().toISOString(),
    };
    this.log.push(logged);
    for (const fn of this.subscribers) fn(logged);
    return logged;
  }

  eventsFrom(seq: number): LoggedEvent[] {
    return this.log.slice(seq);
  }

  subscribe(fn: (e: LoggedEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 3 tests PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add .gitignore poc/server
git commit -m "feat: session event log with replay and subscriptions"
```

---

### Task 2: Steering lock (control model)

**Files:**
- Modify: `poc/server/src/session.ts`
- Test: `poc/server/test/session.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: `Session`, `SessionEvent` from Task 1.
- Produces: on `Session` — `driverId: string | null` (getter), `join(userId: string, name: string): void`, `leave(userId: string): void`, `takeWheel(userId: string): void`, `canPrompt(userId: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/session.test.ts`:

```typescript
describe("Steering lock", () => {
  it("makes the first joiner the driver and logs presence + control events", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    expect(s.driverId).toBe("u1");
    const types = s.eventsFrom(0).map((e) => e.type);
    expect(types).toEqual(["presence_join", "control_change"]);
  });

  it("does not change the driver when a second user joins", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.join("u2", "Ben");
    expect(s.driverId).toBe("u1");
  });

  it("transfers the wheel on takeWheel and gates canPrompt on the driver", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.join("u2", "Ben");
    expect(s.canPrompt("u2")).toBe(false);
    s.takeWheel("u2");
    expect(s.driverId).toBe("u2");
    expect(s.canPrompt("u2")).toBe(true);
    expect(s.canPrompt("u1")).toBe(false);
  });

  it("clears the driver when the driver leaves and logs presence_leave", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.leave("u1");
    expect(s.driverId).toBeNull();
    const last = s.eventsFrom(0).at(-1);
    expect(last?.type).toBe("presence_leave");
  });
});
```

- [ ] **Step 2: Run tests to verify the new block fails**

Run: `cd poc/server && npx vitest run`
Expected: Task 1 tests PASS; new tests FAIL (`s.join is not a function`).

- [ ] **Step 3: Implement the steering lock**

Add to the `Session` class in `poc/server/src/session.ts`:

```typescript
  private currentDriverId: string | null = null;

  get driverId(): string | null {
    return this.currentDriverId;
  }

  join(userId: string, name: string): void {
    this.append({ type: "presence_join", userId, name });
    if (this.currentDriverId === null) this.takeWheel(userId);
  }

  leave(userId: string): void {
    this.append({ type: "presence_leave", userId });
    if (this.currentDriverId === userId) this.currentDriverId = null;
  }

  takeWheel(userId: string): void {
    this.currentDriverId = userId;
    this.append({ type: "control_change", userId });
  }

  canPrompt(userId: string): boolean {
    return this.currentDriverId === userId;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 7 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/session.ts poc/server/test/session.test.ts
git commit -m "feat: grab-based steering lock on sessions"
```

---

### Task 3: Agent driver (Claude Agent SDK)

**Files:**
- Create: `poc/server/src/asyncQueue.ts`
- Create: `poc/server/src/agentDriver.ts`
- Test: `poc/server/test/agentDriver.test.ts`

**Interfaces:**
- Consumes: `Session` from Tasks 1–2.
- Produces: `class AsyncQueue<T>` with `push(item: T): void` and `[Symbol.asyncIterator]()`; `type RunQuery = (prompts: AsyncIterable<SdkUserMessage>) => AsyncIterable<SdkMessage>`; `runAgentQuery: RunQuery` (real SDK); `class AgentDriver` with `constructor(session: Session, run?: RunQuery)` and `sendPrompt(userId: string, text: string): void`.

The SDK is injected as a function so tests never hit the network. `SdkUserMessage`/`SdkMessage` are minimal structural types matching the Agent SDK docs; if the installed SDK's exported types differ, cast at the `query()` call only.

- [ ] **Step 1: Write AsyncQueue (plumbing, tested indirectly via the driver)**

Create `poc/server/src/asyncQueue.ts`:

```typescript
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((value: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.items.shift();
      if (next !== undefined) yield next;
      else yield await new Promise<T>((resolve) => this.waiters.push(resolve));
    }
  }
}
```

- [ ] **Step 2: Write the failing driver tests**

Create `poc/server/test/agentDriver.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery } from "../src/agentDriver.js";

const fakeRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "assistant",
      content: [
        { type: "text", text: "hi there" },
        { type: "tool_use", id: "t1", name: "Read", input: { file: "a.ts" } },
      ],
    };
    return; // end the session after one prompt so tests terminate
  }
};

const failingRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    throw new Error("api exploded");
  }
};

describe("AgentDriver", () => {
  it("logs the user message, agent text, and tool calls", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, fakeRun);
    driver.sendPrompt("u1", "do the thing");
    await vi.waitFor(() => {
      const types = s.eventsFrom(0).map((e) => e.type);
      expect(types).toEqual(["user_message", "agent_text_delta", "tool_call"]);
    });
  });

  it("logs agent errors as agent_error events instead of crashing", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, failingRun);
    driver.sendPrompt("u1", "boom");
    await vi.waitFor(() => {
      const last = s.eventsFrom(0).at(-1);
      expect(last?.type).toBe("agent_error");
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: FAIL — cannot resolve `../src/agentDriver.js`.

- [ ] **Step 4: Implement the driver**

Create `poc/server/src/agentDriver.ts`:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./asyncQueue.js";
import type { Session } from "./session.js";

export interface SdkUserMessage {
  type: "user";
  content: { type: "text"; text: string }[];
}

export interface SdkMessage {
  type: string;
  content?: unknown[];
  message?: { content?: unknown[] };
}

export type RunQuery = (
  prompts: AsyncIterable<SdkUserMessage>,
) => AsyncIterable<SdkMessage>;

export const runAgentQuery: RunQuery = (prompts) =>
  query({
    // Cast at the SDK boundary only — see Global Constraints.
    prompt: prompts as never,
    options: {
      model: "claude-opus-4-8",
      systemPrompt:
        "You are a shared agent in a multiplayer session. Multiple teammates watch this session live and may hand control between them mid-task. Keep responses focused.",
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "default",
      cwd: process.env.AGENT_WORKDIR ?? process.cwd(),
    },
  }) as AsyncIterable<SdkMessage>;

export class AgentDriver {
  private prompts = new AsyncQueue<SdkUserMessage>();

  constructor(
    private session: Session,
    run: RunQuery = runAgentQuery,
  ) {
    void this.consume(run(this.prompts));
  }

  sendPrompt(userId: string, text: string): void {
    this.session.append({ type: "user_message", userId, text });
    this.prompts.push({ type: "user", content: [{ type: "text", text }] });
  }

  private async consume(messages: AsyncIterable<SdkMessage>): Promise<void> {
    try {
      for await (const message of messages) {
        // Docs show content on the message; some SDK versions nest it under .message
        const blocks = (message.content ?? message.message?.content ?? []) as {
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
          content?: { type: string; text?: string }[];
        }[];
        if (message.type === "assistant") {
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              this.session.append({ type: "agent_text_delta", text: block.text });
            } else if (block.type === "tool_use" && block.name) {
              this.session.append({
                type: "tool_call",
                toolName: block.name,
                input: block.input,
              });
            }
          }
        } else if (message.type === "result" || message.type === "user") {
          for (const block of blocks) {
            if (block.type === "tool_result") {
              const text = (block.content ?? [])
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text)
                .join("\n");
              this.session.append({
                type: "tool_result",
                toolName: "tool",
                output: text.slice(0, 2000),
              });
            }
          }
        }
      }
    } catch (err) {
      this.session.append({
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 9 tests PASS, typecheck clean. If `tsc` errors inside the `query()` call because the installed SDK types differ from the docs, fix only the boundary (the `options` shape or the cast), never the event-log side.

- [ ] **Step 6: Commit**

```bash
git add poc/server/src/asyncQueue.ts poc/server/src/agentDriver.ts poc/server/test/agentDriver.test.ts
git commit -m "feat: agent driver streaming Claude Agent SDK output into the event log"
```

---

### Task 4: WebSocket hub

**Files:**
- Create: `poc/server/src/server.ts`
- Create: `poc/server/src/main.ts`
- Test: `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `Session`, `AgentDriver`, `RunQuery` from Tasks 1–3.
- Produces: `startServer(opts: { port: number; runQuery?: RunQuery }): Promise<{ port: number; close: () => Promise<void> }>`.

Wire protocol (JSON over WS):
- Client→server: `{type:"join", sessionId, userId, name, lastSeq?}` · `{type:"prompt", text}` · `{type:"take_wheel"}`
- Server→client: `{type:"event", event: LoggedEvent}` · `{type:"error", message}`

- [ ] **Step 1: Write the failing integration tests**

Create `poc/server/test/server.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import type { RunQuery } from "../src/agentDriver.js";

const echoRun: RunQuery = async function* (prompts) {
  for await (const prompt of prompts) {
    yield {
      type: "assistant",
      content: [{ type: "text", text: `echo: ${prompt.content[0].text}` }],
    };
  }
};

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collect(ws: WebSocket, sink: unknown[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("WebSocket hub", () => {
  it("broadcasts live events and replays the log to late joiners", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws1 = await connect(server.port);
    const seen1: any[] = [];
    collect(ws1, seen1);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    ws1.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(200);

    // Late joiner replays the full log
    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(200);

    const types1 = seen1.map((m) => m.event?.type);
    expect(types1).toContain("user_message");
    expect(types1).toContain("agent_text_delta");
    const types2 = seen2.map((m) => m.event?.type);
    // Replay includes everything ws1 saw, plus ws2's own join
    expect(types2).toContain("user_message");
    expect(types2).toContain("agent_text_delta");
    expect(types2).toContain("presence_join");
    ws1.close();
    ws2.close();
  });

  it("rejects prompts from non-drivers and allows them after take_wheel", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s2", userId: "u1", name: "Ana" }));
    await wait(50);

    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "s2", userId: "u2", name: "Ben" }));
    await wait(50);

    ws2.send(JSON.stringify({ type: "prompt", text: "not my turn" }));
    await wait(100);
    expect(seen2.some((m) => m.type === "error")).toBe(true);

    ws2.send(JSON.stringify({ type: "take_wheel" }));
    ws2.send(JSON.stringify({ type: "prompt", text: "my turn now" }));
    await wait(200);
    const eventTypes = seen2.map((m) => m.event?.type);
    expect(eventTypes).toContain("control_change");
    expect(eventTypes).toContain("user_message");
    ws1.close();
    ws2.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Implement the hub**

Create `poc/server/src/server.ts`:

```typescript
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { AgentDriver, runAgentQuery, type RunQuery } from "./agentDriver.js";
import { Session } from "./session.js";

const MAX_PROMPT_LENGTH = 4000;

interface SessionEntry {
  session: Session;
  driver: AgentDriver;
}

interface ClientContext {
  entry: SessionEntry;
  userId: string;
  unsubscribe: () => void;
}

export async function startServer(opts: { port: number; runQuery?: RunQuery }) {
  const runQuery = opts.runQuery ?? runAgentQuery;
  const sessions = new Map<string, SessionEntry>();

  function getOrCreate(id: string): SessionEntry {
    let entry = sessions.get(id);
    if (!entry) {
      const session = new Session(id);
      entry = { session, driver: new AgentDriver(session, runQuery) };
      sessions.set(id, entry);
    }
    return entry;
  }

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    let ctx: ClientContext | null = null;

    const sendError = (message: string) =>
      ws.send(JSON.stringify({ type: "error", message }));

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError("invalid JSON");
      }

      if (msg.type === "join") {
        if (
          typeof msg.sessionId !== "string" ||
          typeof msg.userId !== "string" ||
          typeof msg.name !== "string"
        ) {
          return sendError("join requires sessionId, userId, name");
        }
        const entry = getOrCreate(msg.sessionId);
        // Replay first, then subscribe, then join — single-threaded, so no gap.
        const from = typeof msg.lastSeq === "number" ? msg.lastSeq : 0;
        for (const event of entry.session.eventsFrom(from)) {
          ws.send(JSON.stringify({ type: "event", event }));
        }
        const unsubscribe = entry.session.subscribe((event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "event", event }));
          }
        });
        ctx = { entry, userId: msg.userId, unsubscribe };
        entry.session.join(msg.userId, msg.name.slice(0, 40));
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
        ctx.entry.driver.sendPrompt(ctx.userId, msg.text);
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
        for (const client of wss.clients) client.terminate();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

Create `poc/server/src/main.ts`:

```typescript
import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const { port: actual } = await startServer({ port });
console.log(`multiplayer-ai server listening on ws://localhost:${actual}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 11 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/server.ts poc/server/src/main.ts poc/server/test/server.test.ts
git commit -m "feat: websocket hub with replay, broadcast, and steering enforcement"
```

---

### Task 5: React client

**Files:**
- Create: `poc/client/` (Vite scaffold)
- Modify: `poc/client/src/App.tsx` (full replacement)
- Modify: `poc/client/src/App.css` (full replacement)

**Interfaces:**
- Consumes: the Task 4 wire protocol (`join` / `prompt` / `take_wheel` out; `{type:"event"}` / `{type:"error"}` in) on `ws://localhost:3001`.
- Produces: browser UI — shared transcript, participant list, driving indicator, take-the-wheel button, driver-gated prompt box. Session picked via `?session=` query param (default `demo`).

- [ ] **Step 1: Scaffold with Vite**

```bash
cd poc
npm create vite@latest client -- --template react-ts
cd client && npm install
```

Expected: `poc/client` created with React+TS template; `npm run dev` would serve on 5173.

- [ ] **Step 2: Replace App.tsx**

Replace `poc/client/src/App.tsx` entirely:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type LoggedEvent = {
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
};

const SERVER_URL = "ws://localhost:3001";

function getIdentity(): { id: string; name: string } {
  let id = sessionStorage.getItem("mpai-userId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mpai-userId", id);
  }
  let name = sessionStorage.getItem("mpai-userName");
  if (!name) {
    name = `user-${id.slice(0, 4)}`;
    sessionStorage.setItem("mpai-userName", name);
  }
  return { id, name };
}

export default function App() {
  const [{ id: userId, name }] = useState(getIdentity);
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const sessionId =
    new URLSearchParams(window.location.search).get("session") ?? "demo";

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(
        JSON.stringify({ type: "join", sessionId, userId, name, lastSeq: 0 }),
      );
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "event") setEvents((prev) => [...prev, msg.event]);
      if (msg.type === "error") setErrors((prev) => [...prev, msg.message]);
    };
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, [sessionId, userId, name]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const { driverId, participants } = useMemo(() => {
    let driverId: string | null = null;
    const participants = new Map<string, string>();
    for (const ev of events) {
      if (ev.type === "presence_join" && ev.userId && ev.name)
        participants.set(ev.userId, ev.name);
      if (ev.type === "presence_leave" && ev.userId)
        participants.delete(ev.userId);
      if (ev.type === "control_change" && ev.userId) driverId = ev.userId;
    }
    return { driverId, participants };
  }, [events]);

  const isDriver = driverId === userId;

  function sendPrompt() {
    const text = input.trim();
    if (!text || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "prompt", text }));
    setInput("");
  }

  function takeWheel() {
    wsRef.current?.send(JSON.stringify({ type: "take_wheel" }));
  }

  return (
    <div className="app">
      <header>
        <h1>
          Multiplayer AI — session <code>{sessionId}</code>
        </h1>
        <div className="status">
          <span className={connected ? "dot on" : "dot off"} />
          {connected ? "connected" : "disconnected"}
        </div>
      </header>

      <div className="participants">
        {[...participants.entries()].map(([id, pname]) => (
          <span key={id} className={id === driverId ? "avatar driving" : "avatar"}>
            {pname}
            {id === driverId ? " 🛞" : ""}
            {id === userId ? " (you)" : ""}
          </span>
        ))}
      </div>

      <main className="transcript">
        {events.map((ev) => {
          switch (ev.type) {
            case "user_message":
              return (
                <div key={ev.seq} className="msg user">
                  <b>{participants.get(ev.userId ?? "") ?? ev.userId}:</b>{" "}
                  {ev.text}
                </div>
              );
            case "agent_text_delta":
              return (
                <div key={ev.seq} className="msg agent">
                  {ev.text}
                </div>
              );
            case "tool_call":
              return (
                <div key={ev.seq} className="msg tool">
                  ⚙ {ev.toolName}({JSON.stringify(ev.input)})
                </div>
              );
            case "tool_result":
              return (
                <div key={ev.seq} className="msg tool">
                  ↳ {ev.output?.slice(0, 300)}
                </div>
              );
            case "control_change":
              return (
                <div key={ev.seq} className="msg system">
                  🛞 {participants.get(ev.userId ?? "") ?? ev.userId} took the wheel
                </div>
              );
            case "agent_error":
              return (
                <div key={ev.seq} className="msg error">
                  ⚠ {ev.message}
                </div>
              );
            default:
              return null;
          }
        })}
        <div ref={bottomRef} />
      </main>

      {errors.length > 0 && (
        <div className="msg error">⚠ {errors.at(-1)}</div>
      )}

      <footer>
        {isDriver ? (
          <>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendPrompt()}
              placeholder="You're driving — prompt the agent…"
              maxLength={4000}
            />
            <button onClick={sendPrompt}>Send</button>
          </>
        ) : (
          <button className="wheel" onClick={takeWheel}>
            Take the wheel 🛞
          </button>
        )}
      </footer>
    </div>
  );
}
```

- [ ] **Step 3: Replace App.css**

Replace `poc/client/src/App.css` entirely:

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6; }
.app { display: flex; flex-direction: column; height: 100vh; max-width: 860px; margin: 0 auto; padding: 0 16px; }
header { display: flex; justify-content: space-between; align-items: center; }
header h1 { font-size: 1.1rem; }
.status { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot.on { background: #3ddc84; }
.dot.off { background: #e05555; }
.participants { display: flex; gap: 8px; padding-bottom: 8px; flex-wrap: wrap; }
.avatar { background: #1d2230; border-radius: 999px; padding: 4px 12px; font-size: 0.85rem; }
.avatar.driving { background: #2b4a2f; }
.transcript { flex: 1; overflow-y: auto; border: 1px solid #262b38; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.msg { padding: 6px 10px; border-radius: 6px; white-space: pre-wrap; }
.msg.user { background: #1d2b45; align-self: flex-end; max-width: 80%; }
.msg.agent { background: #1b2027; }
.msg.tool { color: #8fa3c0; font-size: 0.8rem; font-family: monospace; }
.msg.system { color: #b9a44c; font-size: 0.85rem; text-align: center; }
.msg.error { color: #e05555; }
footer { display: flex; gap: 8px; padding: 12px 0; }
footer input { flex: 1; padding: 10px; border-radius: 6px; border: 1px solid #262b38; background: #171a21; color: inherit; }
footer button { padding: 10px 18px; border-radius: 6px; border: none; background: #3b82f6; color: white; cursor: pointer; }
footer button.wheel { background: #2b4a2f; flex: 1; }
```

- [ ] **Step 4: Verify the client builds**

Run: `cd poc/client && npm run build`
Expected: `vite build` succeeds with no TypeScript errors. (Delete unused template files `src/index.css` import errors if the template wired them — keep `main.tsx` importing only what exists.)

- [ ] **Step 5: Commit**

```bash
git add poc/client
git commit -m "feat: react client with shared transcript and steering controls"
```

---

### Task 6: End-to-end acceptance + docs

**Files:**
- Create: `poc/server/.env.example`
- Create: `README.md` (repo root)
- Create: `Docs/mistakes-and-fixes.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable demo and its documentation. This is the YC-demo moment check.

- [ ] **Step 1: Create env template and docs**

Create `poc/server/.env.example`:

```
# Copy to .env — never commit the real key
ANTHROPIC_API_KEY=sk-ant-...
# Optional: directory the agent's read-only tools operate in
AGENT_WORKDIR=
```

Create `README.md`:

```markdown
# Multiplayer AI — Research + PoC

Exploration of YC's Fall 2026 "Multiplayer AI" RFS: shared live agent sessions
for dev teams. See `Docs/research-report.md` for the research and
`docs/superpowers/specs/` for the design.

## Run the PoC

1. `cd poc/server && cp .env.example .env` and set `ANTHROPIC_API_KEY`
   (or rely on an active `claude` / `ant auth login` credential).
2. `cd poc/server && npm install && npm run dev` — server on ws://localhost:3001
3. `cd poc/client && npm install && npm run dev` — UI on http://localhost:5173
4. Open http://localhost:5173 in **two tabs**. Tab A is driving; prompt the
   agent. Tab B watches the same stream live, clicks "Take the wheel", and
   redirects the agent mid-task.

## Tests

`cd poc/server && npm test`
```

Create `Docs/mistakes-and-fixes.md`:

```markdown
# Mistakes and Fixes

Running log of non-obvious problems hit in this project and how they were fixed.

| Date | Problem | Fix |
|---|---|---|
```

- [ ] **Step 2: Run the full server test suite and typecheck**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS.

- [ ] **Step 3: Manual acceptance test (requires ANTHROPIC_API_KEY or logged-in claude CLI)**

1. Start server (`npm run dev` in `poc/server`) and client (`npm run dev` in `poc/client`).
2. Open http://localhost:5173 in two browser tabs (each tab gets its own identity via sessionStorage).
3. Tab A: send a prompt like "List the files in your working directory and summarize what this project is." Verify agent text and tool calls stream into **both** tabs.
4. Tab B: click "Take the wheel", verify the 🛞 indicator moves in both tabs, and send a redirect prompt like "Stop that — instead tell me which file is largest." Verify the agent responds to Tab B's steer.
5. Record any deviations in `Docs/mistakes-and-fixes.md`.

Expected: the spec's acceptance criteria hold — live shared stream, working handoff, driver-gated prompting.

- [ ] **Step 4: Commit**

```bash
git add poc/server/.env.example README.md Docs/mistakes-and-fixes.md
git commit -m "docs: run instructions, env template, and acceptance checklist"
```

---

### Task 7: Research report

**Files:**
- Create: `Docs/research-report.md`

**Interfaces:**
- Consumes: WebSearch/WebFetch for competitive research; PoC findings from Task 6.
- Produces: the four-part feasibility report from the spec.

- [ ] **Step 1: Research the competitive landscape**

Using WebSearch/WebFetch (run these in parallel where possible), research each of the following for *what is actually multiplayer (shared live sessions) vs. single-player-with-sharing*, and note pricing/team features where visible:

1. Cursor (background agents, team features)
2. Devin / Cognition (session sharing, Slack integration)
3. Claude Code (teams/cloud sessions, claude.ai/code)
4. OpenAI Codex (cloud tasks, delegation)
5. Factory.ai (droids, team workflows)
6. Amp (Sourcegraph) (thread sharing)
7. YC W25/S25/F25/W26 batch companies explicitly targeting multiplayer/collaborative agents (search "YC batch multiplayer AI agents startup")
8. Technical prior art: Figma multiplayer architecture, Liveblocks/PartyKit/Cloudflare Durable Objects positioning for AI session sync

- [ ] **Step 2: Write the report**

Create `Docs/research-report.md` with exactly these four sections (from the spec):

```markdown
# Multiplayer AI for Dev Teams — Research & Feasibility Report

*Date: <fill in>. Prepared as part of a startup exploration of YC's Fall 2026
"Multiplayer AI" RFS (Aaron Epstein).*

## 1. The Opportunity
<!-- YC's RFS framing (quote it), the Figma/Google Docs multiplayer precedent,
why agents make this newly relevant: multi-day autonomous tasks need watching,
redirecting, and handoff. -->

## 2. Competitive Landscape
<!-- One subsection per company from Step 1. For each: what exists today,
is it truly multiplayer or single-player-with-sharing, and the gap.
End with a table summarizing multiplayer capability per product and a
"where the open wedges are" subsection. -->

## 3. Technical Feasibility
<!-- The event-log architecture and why it works (reference the PoC);
turn-taking vs CRDT trade-off; what the PoC demonstrated (cite the acceptance
test results from Task 6) and what it exposed; production requirements:
Durable Objects/persistence, auth, reconnection, multi-day session hibernation.
Include the C-vs-event-loop analysis: agent sessions are I/O-bound, so
thread-per-session C is the wrong tool; the concurrency problem is real but
lives at the architecture level. -->

## 4. Go / No-Go Assessment
<!-- Open wedges ranked; moat risk (incumbents adding multiplayer as a
feature); a concrete recommendation with the conditions under which to
proceed (e.g. "build X wedge if Y is still open by Z"). -->
```

Fill every section with the researched content — no placeholder comments may remain in the committed file.

- [ ] **Step 3: Commit**

```bash
git add Docs/research-report.md
git commit -m "docs: multiplayer AI research and feasibility report"
```
