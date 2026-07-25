# "Terminal, but multiplayer" (v4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the PoC client into a faithful Claude-Code-terminal shell with game-feel flourishes (inline dino mini-game while the agent thinks, party sidebar, quest-log intents, take-the-wheel flourish, lobby) plus per-session driver-picked agent/model — and produce the Claude Design brief and a frontend-design skill comparison pass.

**Spec:** `docs/superpowers/specs/2026-07-24-product-design-terminal-multiplayer.md` (user-approved). Read it first.

**Architecture:** Server gains three small, append-only capabilities: a `turn_end` event (the driver already sees the SDK's `result` message), a `set_model` wire message → `model_change` event (via the SDK `Query.setModel`, surfaced through an optional member on `RunQuery`'s return type so existing test fakes stay assignable), and optional `glyph`/`color` identity fields on join/`presence_join` plus a pre-join `peek` message for the lobby. The client is decomposed from one 310-line `App.tsx` into focused modules: pure, unit-tested logic (`derive.ts` event fold, `game/dino.ts` game engine, `identity.ts`) and presentational components (`Header`, `Transcript`, `PartyPane`, `ThinkingStrip`, `PromptBar`, `Lobby`) under a single terminal stylesheet.

**Tech Stack:** TypeScript (strict), Node + `ws` + `@anthropic-ai/claude-agent-sdk` (server), React 19 + Vite (client), vitest (server already; ADDED to client for pure modules), Playwright MCP for live acceptance.

## Global Constraints

- Tests are **append-only**: never modify existing tests; 60/60 server tests must stay green (`cd poc/server && npx vitest run`).
- Existing `RunQuery` test fakes must stay assignable — extend types only with **optional** members / trailing optional params.
- SDK type casts live at the SDK boundary only (`runAgentQuery` return), as today.
- Client component correctness is verified by `npm run build` (tsc strict) + the Task 12 live Playwright acceptance; **all decision logic must live in the pure tested modules** (`derive.ts`, `game/dino.ts`, `identity.ts`), not in components.
- Do NOT touch `poc/server/src/permissions.ts` allowlist or containment logic (open ratification items — HANDOFF §7).
- Filesystem is case-insensitive: always lowercase `docs/`.
- No new runtime dependencies. Only new devDependency: `vitest` in `poc/client`.
- Model keys are `"opus" | "sonnet" | "haiku"` mapping to ids `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`; labels `opus 4.8`, `sonnet 5`, `haiku 4.5`. Default `opus` (today's behavior, unchanged).
- Glyph set `■ ▲ ● ✦ ◆ ♠`; identity palette `#e06c75 #61afef #98c379 #e5c07b #c678dd #56b6c2` (used identically on server-agnostic client fallback and lobby picker).
- Commit after every task with a conventional message; run the task's verify commands before claiming done.

---

### Task 1: Claude Design brief

**Files:**
- Create: `docs/design/claude-design-brief.md`

**Interfaces:**
- Consumes: the spec (path above), current UI `poc/client/src/App.tsx` + `poc/client/src/App.css`, screenshots `step1-autoapprove.png` … `step4-sidebar.png` (repo root).
- Produces: a **self-contained** brief an external design agent ("Claude Design") can act on with zero repo access beyond this file.

- [ ] **Step 1: Write the brief** with exactly these sections (each fully written out, no stubs):
  1. **Product one-pager** — Multiplayer AI: shared live agent sessions per project; one driver at a time, take-the-wheel handoff; agent-side awareness (self-declared intents + teammate digest); multiplayer approval gate (any driver can approve/deny the agent's privileged tool calls); per-session agent/model choice. Audience: dev teams. Competitive frame in one paragraph (Amp Multiplayer, Warp Remote Control exist; nobody combines shared session + take-the-wheel + awareness + multiplayer approvals).
  2. **Current UI state** — describe today's plain dark web app (chat bubbles, blue Send button, 860px column, teammate cards, purple permission cards) and reference the four screenshots by filename with one line each on what they show.
  3. **Approved aesthetic direction** — restate spec §§1–2 verbatim-faithful: faithful terminal (no bubbles/cards), mono stack, palette, glyph vocabulary, box-drawing frames, two-pane tmux split, ~1280px, boxed prompt + status line.
  4. **Component inventory to design** — header rule, transcript event lines (copy the spec §3 event→rendering table), permission block, thinking strip + dino lane, PARTY pane, lobby screen, agent picker, prompt bar + status line.
  5. **Motion** — take-the-wheel one-beat sweep; thinking-strip fade-out; nothing else animates.
  6. **Hard constraints** — must render the existing event union (list the event types from `poc/server/src/events.ts` including `turn_end`/`model_change`); web app (React/CSS), keyboard-first, dark-only, no external fonts/CDNs required, desktop-first with party pane collapsing under ~900px.
  7. **What to design (explicit asks)** — exact spacing/type scale, final palette values, dino sprite treatment (ASCII vs pixel), permission-block visual weight, party-entry layout, lobby composition, empty/edge states (no party members, agent dead, disconnected).
- [ ] **Step 2: Self-check** — could a designer with ONLY this file produce screens? If any section references repo internals without explaining them, inline the explanation.
- [ ] **Step 3: Commit**

```bash
git add docs/design/claude-design-brief.md
git commit -m "docs: Claude Design brief — self-contained v4 design handoff"
```

---

### Task 2: Server — turn lifecycle (`turn_end`) + model switching (`set_model` → `model_change`)

**Files:**
- Create: `poc/server/src/models.ts`
- Modify: `poc/server/src/events.ts:11-12` (extend union), `poc/server/src/agentDriver.ts` (RunQuery return type ~:53-56, `runAgentQuery` options `model:` :99 and final cast :145, `AgentDriver` class), `poc/server/src/server.ts` (~:192, new message handler)
- Test: `poc/server/test/agentDriver.test.ts`, `poc/server/test/server.test.ts` (append only)

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `models.ts`: `MODELS: Record<"opus"|"sonnet"|"haiku", { id: string; label: string }>`, `type ModelKey`, `DEFAULT_MODEL: ModelKey = "opus"`, `isModelKey(v: unknown): v is ModelKey`
  - events: `{ type: "turn_end" }` and `{ type: "model_change"; model: string; userId: string }`
  - `agentDriver.ts`: `type RunQueryResult = AsyncIterable<SdkMessage> & { setModel?(model: string): Promise<void> }`; `RunQuery` now returns `RunQueryResult`; `AgentDriver.setModel(key: ModelKey, userId: string): { ok: true } | { ok: false; error: string }`
  - wire: client→server `{ type: "set_model", model: "opus"|"sonnet"|"haiku" }`

- [ ] **Step 1: Write failing driver tests** — append to `poc/server/test/agentDriver.test.ts`:

```ts
const resultRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield { type: "assistant", content: [{ type: "text", text: "done" }] };
    yield { type: "result" };
    // keep the stream open for the next prompt (do NOT return)
  }
};

describe("turn lifecycle", () => {
  it("appends turn_end when the SDK emits a result message", async () => {
    const session = new Session("s");
    const driver = new AgentDriver(session, resultRun);
    driver.sendPrompt("u1", "hi");
    await vi.waitFor(() =>
      expect(session.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true),
    );
  });
});

describe("setModel", () => {
  const makeRunWithSetModel = (spy: (m: string) => Promise<void>): RunQuery =>
    (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) {
          yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as SdkMessage;
          yield { type: "result" } as SdkMessage;
        }
      })();
      return Object.assign(gen, { setModel: spy });
    };

  it("switches between turns: calls SDK setModel with the mapped id and logs model_change", async () => {
    const spy = vi.fn(async (_m: string) => {});
    const session = new Session("s");
    const driver = new AgentDriver(session, makeRunWithSetModel(spy));
    driver.sendPrompt("u1", "hi");
    await vi.waitFor(() =>
      expect(session.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true),
    );
    const res = driver.setModel("sonnet", "u1");
    expect(res).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith("claude-sonnet-5");
    const ev = session.eventsFrom(0).find((e) => e.type === "model_change");
    expect(ev).toMatchObject({ model: "sonnet", userId: "u1" });
  });

  it("rejects a switch mid-turn", async () => {
    const spy = vi.fn(async (_m: string) => {});
    const session = new Session("s");
    const driver = new AgentDriver(session, makeRunWithSetModel(spy));
    driver.sendPrompt("u1", "hi"); // turn active until result consumed…
    const res = driver.setModel("haiku", "u1"); // …but call synchronously before waitFor
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports unsupported when the stream has no setModel (plain fakes)", () => {
    const session = new Session("s");
    const driver = new AgentDriver(session, fakeRun);
    const res = driver.setModel("sonnet", "u1");
    expect(res.ok).toBe(false);
  });
});
```

(`SdkMessage` may need adding to the existing import from `../src/agentDriver.js`.)

- [ ] **Step 2: Run to verify failure** — `cd poc/server && npx vitest run test/agentDriver.test.ts` → FAIL (`setModel` not a function / no `turn_end`).
- [ ] **Step 3: Implement.**

`poc/server/src/models.ts` (new):

```ts
export const MODELS = {
  opus: { id: "claude-opus-4-8", label: "opus 4.8" },
  sonnet: { id: "claude-sonnet-5", label: "sonnet 5" },
  haiku: { id: "claude-haiku-4-5-20251001", label: "haiku 4.5" },
} as const;

export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelKey = "opus";

export function isModelKey(v: unknown): v is ModelKey {
  return typeof v === "string" && v in MODELS;
}
```

`events.ts` — extend the union (append two members):

```ts
  | { type: "model_change"; model: string; userId: string }
  | { type: "turn_end" };
```

`agentDriver.ts`:
- Add near `RunQuery`:

```ts
export type RunQueryResult = AsyncIterable<SdkMessage> & {
  /** Present on the real SDK Query (sdk.d.ts Query.setModel); absent on plain test fakes. */
  setModel?(model: string): Promise<void>;
};

export type RunQuery = (
  prompts: AsyncIterable<SdkUserMessage>,
  hooks: DriverHooks,
) => RunQueryResult;
```

- `runAgentQuery`: change the final cast to `as unknown as RunQueryResult` and set `model: MODELS[DEFAULT_MODEL].id` (import from `./models.js`) instead of the string literal.
- `AgentDriver`: add fields `private turnActive = false;` and `private stream: RunQueryResult;`. In the constructor, capture the stream before consuming:

```ts
this.stream = run(this.prompts, { /* existing hooks object unchanged */ });
void this.consume(this.stream);
```

- In `sendPrompt`, after the dead-check passes, set `this.turnActive = true;` (before pushing the prompt).
- In `handleMessage`, at the top of the existing `message.type === "result" || message.type === "user"` handling, add a result-only branch (result messages mark turn end; `user` messages do not):

```ts
if (message.type === "result") {
  this.turnActive = false;
  this.session.append({ type: "turn_end" });
}
```

- New public method:

```ts
setModel(
  key: ModelKey,
  userId: string,
): { ok: true } | { ok: false; error: string } {
  if (this.dead) return { ok: false, error: "agent session has ended" };
  if (this.turnActive)
    return { ok: false, error: "agent is mid-turn — wait for it to finish" };
  if (!this.stream.setModel)
    return { ok: false, error: "model switching not supported by this agent" };
  // Fire-and-forget: the SDK call is a control request; failures surface as
  // agent_error rather than blocking the wire handler.
  void this.stream.setModel(MODELS[key].id).catch((err) =>
    this.session.append({
      type: "agent_error",
      message: `model switch failed: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  this.session.append({ type: "model_change", model: key, userId });
  return { ok: true };
}
```

(import `MODELS, type ModelKey` from `./models.js`.)

- [ ] **Step 4: Run driver tests** — `npx vitest run test/agentDriver.test.ts` → PASS (existing + new).
- [ ] **Step 5: Write failing server test** — append to `poc/server/test/server.test.ts` (reuse its `connect`/`collect` helpers and fake-run style):

```ts
describe("set_model", () => {
  it("driver can switch; non-driver and bad model rejected", async () => {
    // run fake: reply then result, stream stays open (same shape as resultRun above)
    const run: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) {
          yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as SdkMessage;
          yield { type: "result" } as SdkMessage;
        }
      })();
      return Object.assign(gen, { setModel: async (_m: string) => {} });
    };
    const server = await startServer({ port: 0, runQuery: run });
    const a = await connect(server.port);
    const b = await connect(server.port);
    const aSink: any[] = []; const bSink: any[] = [];
    collect(a, aSink); collect(b, bSink);
    a.send(JSON.stringify({ type: "join", sessionId: "m1", userId: "ua", name: "ana", lastSeq: 0 }));
    b.send(JSON.stringify({ type: "join", sessionId: "m1", userId: "ub", name: "ben", lastSeq: 0 }));
    await vi.waitFor(() => expect(bSink.some((m) => m.type === "event" && m.event.type === "presence_join" && m.event.userId === "ub")).toBe(true));

    b.send(JSON.stringify({ type: "set_model", model: "sonnet" })); // ub is not driving
    await vi.waitFor(() => expect(bSink.some((m) => m.type === "error" && /driver/.test(m.message))).toBe(true));

    a.send(JSON.stringify({ type: "set_model", model: "gpt-5" })); // invalid key
    await vi.waitFor(() => expect(aSink.some((m) => m.type === "error" && /opus\|sonnet\|haiku/.test(m.message))).toBe(true));

    a.send(JSON.stringify({ type: "set_model", model: "sonnet" })); // ua drives (first join)
    await vi.waitFor(() => expect(aSink.some((m) => m.type === "event" && m.event.type === "model_change" && m.event.model === "sonnet" && m.event.userId === "ua")).toBe(true));
    a.close(); b.close(); await server.close();
  });
});
```

- [ ] **Step 6: Run to verify failure** — `npx vitest run test/server.test.ts` → FAIL ("unknown message type: set_model").
- [ ] **Step 7: Implement the wire handler** — in `server.ts`, after the `permission` handler (~:208), add (import `isModelKey` from `./models.js`):

```ts
if (msg.type === "set_model") {
  if (!isModelKey(msg.model)) {
    return sendError("set_model requires model: opus|sonnet|haiku");
  }
  if (!ctx.entry.session.canPrompt(ctx.userId)) {
    return sendError("only the current driver can switch models — take the wheel first");
  }
  const result = ctx.entry.driver.setModel(msg.model, ctx.userId);
  if (!result.ok) return sendError(result.error);
  return;
}
```

- [ ] **Step 8: Full verify** — `cd poc/server && npx vitest run` → all pass (60 existing + new); `npx tsc --noEmit` clean.
- [ ] **Step 9: Commit**

```bash
git add poc/server/src poc/server/test
git commit -m "feat(server): turn_end lifecycle event + driver-gated set_model/model_change"
```

---

### Task 3: Server — identity on join (glyph/color) + pre-join `peek`

**Files:**
- Modify: `poc/server/src/events.ts:7` (presence_join), `poc/server/src/session.ts:45-49` (join), `poc/server/src/server.ts` (join handler ~:126-163, new peek handler before the `!ctx` guard ~:166)
- Test: `poc/server/test/session.test.ts`, `poc/server/test/server.test.ts` (append only)

**Interfaces:**
- Produces:
  - event: `{ type: "presence_join"; userId: string; name: string; glyph?: string; color?: string }`
  - `Session.join(userId: string, name: string, identity?: { glyph?: string; color?: string }): void` (trailing optional — existing callers/tests unchanged)
  - wire: client→server `{ type: "join", ..., glyph?: string, color?: string }` and pre-join `{ type: "peek", projectId: string }` → server replies with the same `{ type: "project", sessions: [...] }` snapshot message the sidebar already consumes (empty `sessions` for unknown projects).

- [ ] **Step 1: Write failing session test** — append to `poc/server/test/session.test.ts`:

```ts
it("presence_join carries optional glyph and color", () => {
  const session = new Session("s");
  session.join("u1", "ana", { glyph: "▲", color: "#61afef" });
  const ev = session.eventsFrom(0).find((e) => e.type === "presence_join");
  expect(ev).toMatchObject({ userId: "u1", name: "ana", glyph: "▲", color: "#61afef" });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/session.test.ts` → FAIL (arity/type).
- [ ] **Step 3: Implement** — `events.ts` presence_join member becomes:

```ts
  | { type: "presence_join"; userId: string; name: string; glyph?: string; color?: string }
```

`session.ts` join becomes:

```ts
join(
  userId: string,
  name: string,
  identity?: { glyph?: string; color?: string },
): void {
  this.participants.set(userId, name);
  this.append({
    type: "presence_join",
    userId,
    name,
    ...(identity?.glyph ? { glyph: identity.glyph } : {}),
    ...(identity?.color ? { color: identity.color } : {}),
  });
  if (this.currentDriverId === null) this.takeWheel(userId);
}
```

- [ ] **Step 4: Run** — `npx vitest run test/session.test.ts` → PASS.
- [ ] **Step 5: Write failing server tests** — append to `poc/server/test/server.test.ts`:

```ts
it("join forwards validated glyph/color; junk is dropped", async () => {
  const server = await startServer({ port: 0, runQuery: echoRun });
  const ws = await connect(server.port);
  const sink: any[] = []; collect(ws, sink);
  ws.send(JSON.stringify({ type: "join", sessionId: "g1", userId: "u1", name: "ana", lastSeq: 0, glyph: "▲", color: "#61afef" }));
  await vi.waitFor(() => expect(sink.some((m) => m.type === "event" && m.event.type === "presence_join" && m.event.glyph === "▲" && m.event.color === "#61afef")).toBe(true));
  ws.close();
  const ws2 = await connect(server.port);
  const sink2: any[] = []; collect(ws2, sink2);
  ws2.send(JSON.stringify({ type: "join", sessionId: "g2", userId: "u2", name: "ben", lastSeq: 0, glyph: "<script>", color: "red" }));
  await vi.waitFor(() => {
    const ev = sink2.find((m) => m.type === "event" && m.event.type === "presence_join" && m.event.userId === "u2");
    expect(ev).toBeTruthy();
    expect(ev.event.glyph).toBeUndefined();
    expect(ev.event.color).toBeUndefined();
  });
  ws2.close(); await server.close();
});

it("peek returns a project snapshot without joining", async () => {
  const server = await startServer({ port: 0, runQuery: echoRun });
  const member = await connect(server.port);
  member.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "p1", userId: "u1", name: "ana", lastSeq: 0 }));
  const peeker = await connect(server.port);
  const sink: any[] = []; collect(peeker, sink);
  peeker.send(JSON.stringify({ type: "peek", projectId: "demo" }));
  await vi.waitFor(() => {
    const snap = sink.find((m) => m.type === "project");
    expect(snap).toBeTruthy();
    expect(snap.sessions.map((s: any) => s.id)).toContain("p1");
  });
  peeker.send(JSON.stringify({ type: "peek", projectId: "nope" }));
  await vi.waitFor(() => expect(sink.filter((m) => m.type === "project").length).toBeGreaterThanOrEqual(2));
  member.close(); peeker.close(); await server.close();
});
```

- [ ] **Step 6: Run to verify failure** — `npx vitest run test/server.test.ts` → FAIL.
- [ ] **Step 7: Implement in `server.ts`** — module-level validation constants next to `MAX_PROMPT_LENGTH`:

```ts
const ALLOWED_GLYPHS = new Set(["■", "▲", "●", "✦", "◆", "♠"]);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
```

In the join handler, replace `entry.session.join(msg.userId, msg.name.slice(0, 40));` with:

```ts
const glyph =
  typeof msg.glyph === "string" && ALLOWED_GLYPHS.has(msg.glyph)
    ? msg.glyph
    : undefined;
const color =
  typeof msg.color === "string" && COLOR_RE.test(msg.color)
    ? msg.color.toLowerCase()
    : undefined;
entry.session.join(msg.userId, msg.name.slice(0, 40), { glyph, color });
```

Immediately BEFORE the `if (!ctx) return sendError("join a session first");` line, add the pre-join peek handler:

```ts
if (msg.type === "peek") {
  const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
  if (!SLUG.test(projectId)) {
    return sendError("peek requires a valid projectId");
  }
  const project = projects.get(projectId);
  ws.send(
    JSON.stringify(
      project ? projectSnapshot(project) : { type: "project", sessions: [] },
    ),
  );
  return;
}
```

- [ ] **Step 8: Full verify** — `npx vitest run` all green; `npx tsc --noEmit` clean.
- [ ] **Step 9: Commit**

```bash
git add poc/server/src poc/server/test
git commit -m "feat(server): identity glyph/color on join + pre-join peek snapshot"
```

---

### Task 4: Client — vitest infra + `types.ts` + `identity.ts` + `derive.ts`

**Files:**
- Create: `poc/client/src/types.ts`, `poc/client/src/identity.ts`, `poc/client/src/derive.ts`, `poc/client/src/identity.test.ts`, `poc/client/src/derive.test.ts`
- Modify: `poc/client/package.json` (add vitest + test script)

**Interfaces:**
- Produces:
  - `types.ts`: `LoggedEvent` (today's App.tsx shape + `model?: string; glyph?: string; color?: string`), `ProjectSessionInfo` (moved verbatim from App.tsx), `SERVER_URL = "ws://localhost:3001"`.
  - `identity.ts`: `GLYPHS: readonly string[]`, `IDENTITY_COLORS: readonly string[]`, `hashIdentity(userId: string): { glyph: string; color: string }` (deterministic), `loadOrCreateUserId(): string` (sessionStorage `mpai-userId`, as today), `loadProfile(): { name: string; glyph: string; color: string } | null` (sessionStorage `mpai-profile`, JSON), `saveProfile(p: { name: string; glyph: string; color: string }): void`.
  - `derive.ts`: `interface Participant { name: string; glyph: string; color: string }`; `interface DerivedState { driverId: string | null; participants: Map<string, Participant>; objective: string | null; lastIntentSeq: number | null; permissionDecisions: Map<string, { decision: string; userId: string }>; model: string; agentBusy: boolean }`; `deriveState(events: LoggedEvent[]): DerivedState`.

- [ ] **Step 1: Add vitest** — `cd poc/client && npm install -D vitest`; add `"test": "vitest run"` to scripts.
- [ ] **Step 2: Write failing tests.**

`identity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GLYPHS, IDENTITY_COLORS, hashIdentity } from "./identity";

describe("hashIdentity", () => {
  it("is deterministic and draws from the fixed sets", () => {
    const a1 = hashIdentity("user-abc");
    const a2 = hashIdentity("user-abc");
    expect(a1).toEqual(a2);
    expect(GLYPHS).toContain(a1.glyph);
    expect(IDENTITY_COLORS).toContain(a1.color);
  });
  it("varies across users", () => {
    const seen = new Set(
      ["a", "b", "c", "d", "e", "f", "g"].map((u) => hashIdentity(u).color),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
```

`derive.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveState } from "./derive";
import type { LoggedEvent } from "./types";

const ev = (partial: Partial<LoggedEvent> & { type: string }, seq: number): LoggedEvent =>
  ({ ts: "2026-07-24T00:00:00Z", ...partial, seq }) as LoggedEvent;

describe("deriveState", () => {
  it("folds presence, driver, objective, model, permissions", () => {
    const s = deriveState([
      ev({ type: "presence_join", userId: "u1", name: "ana", glyph: "▲", color: "#61afef" }, 0),
      ev({ type: "presence_join", userId: "u2", name: "ben" }, 1),
      ev({ type: "control_change", userId: "u1" }, 2),
      ev({ type: "intent_update", text: "old goal" }, 3),
      ev({ type: "intent_update", text: "migrate auth" }, 4),
      ev({ type: "model_change", model: "sonnet", userId: "u1" }, 5),
      ev({ type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1" }, 6),
      ev({ type: "presence_leave", userId: "u2" }, 7),
    ]);
    expect(s.driverId).toBe("u1");
    expect(s.participants.get("u1")).toEqual({ name: "ana", glyph: "▲", color: "#61afef" });
    expect(s.participants.has("u2")).toBe(false);
    expect(s.objective).toBe("migrate auth");
    expect(s.lastIntentSeq).toBe(4);
    expect(s.model).toBe("sonnet");
    expect(s.permissionDecisions.get("r1")).toEqual({ decision: "allow", userId: "u1" });
  });

  it("fills glyph/color deterministically when presence_join omits them", () => {
    const s = deriveState([ev({ type: "presence_join", userId: "u9", name: "cam" }, 0)]);
    const p = s.participants.get("u9")!;
    expect(p.glyph).toBeTruthy();
    expect(p.color).toMatch(/^#/);
  });

  it("tracks agentBusy from user_message to turn_end (and clears on agent_error)", () => {
    expect(deriveState([ev({ type: "user_message", userId: "u1", text: "go" }, 0)]).agentBusy).toBe(true);
    expect(
      deriveState([
        ev({ type: "user_message", userId: "u1", text: "go" }, 0),
        ev({ type: "turn_end" }, 1),
      ]).agentBusy,
    ).toBe(false);
    expect(
      deriveState([
        ev({ type: "user_message", userId: "u1", text: "go" }, 0),
        ev({ type: "agent_error", message: "boom" }, 1),
      ]).agentBusy,
    ).toBe(false);
  });

  it("defaults model to opus", () => {
    expect(deriveState([]).model).toBe("opus");
  });
});
```

- [ ] **Step 3: Run to verify failure** — `cd poc/client && npm test` → FAIL (modules missing).
- [ ] **Step 4: Implement.**

`types.ts` — move the `LoggedEvent` / `ProjectSessionInfo` types out of `App.tsx` verbatim, add the three optional fields, export `SERVER_URL`:

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
};

export type ProjectSessionInfo = {
  id: string;
  participants: string[];
  driverName: string | null;
  intent: string | null;
  lastActivityTs: string | null;
  ended: boolean;
};

export const SERVER_URL = "ws://localhost:3001";
```

`identity.ts`:

```ts
export const GLYPHS = ["■", "▲", "●", "✦", "◆", "♠"] as const;
export const IDENTITY_COLORS = [
  "#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2",
] as const;

export interface Profile {
  name: string;
  glyph: string;
  color: string;
}

export function hashIdentity(userId: string): { glyph: string; color: string } {
  let h = 0;
  for (const ch of userId) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return {
    glyph: GLYPHS[h % GLYPHS.length],
    color: IDENTITY_COLORS[(h >>> 3) % IDENTITY_COLORS.length],
  };
}

export function loadOrCreateUserId(): string {
  let id = sessionStorage.getItem("mpai-userId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mpai-userId", id);
  }
  return id;
}

export function loadProfile(): Profile | null {
  const raw = sessionStorage.getItem("mpai-profile");
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p.name === "string" && typeof p.glyph === "string" && typeof p.color === "string") return p;
  } catch { /* fall through */ }
  return null;
}

export function saveProfile(p: Profile): void {
  sessionStorage.setItem("mpai-profile", JSON.stringify(p));
}
```

`derive.ts`:

```ts
import { hashIdentity } from "./identity";
import type { LoggedEvent } from "./types";

export interface Participant {
  name: string;
  glyph: string;
  color: string;
}

export interface DerivedState {
  driverId: string | null;
  participants: Map<string, Participant>;
  objective: string | null;
  lastIntentSeq: number | null;
  permissionDecisions: Map<string, { decision: string; userId: string }>;
  model: string;
  agentBusy: boolean;
}

export function deriveState(events: LoggedEvent[]): DerivedState {
  const s: DerivedState = {
    driverId: null,
    participants: new Map(),
    objective: null,
    lastIntentSeq: null,
    permissionDecisions: new Map(),
    model: "opus",
    agentBusy: false,
  };
  for (const ev of events) {
    switch (ev.type) {
      case "presence_join":
        if (ev.userId && ev.name) {
          const fallback = hashIdentity(ev.userId);
          s.participants.set(ev.userId, {
            name: ev.name,
            glyph: ev.glyph ?? fallback.glyph,
            color: ev.color ?? fallback.color,
          });
        }
        break;
      case "presence_leave":
        if (ev.userId) s.participants.delete(ev.userId);
        break;
      case "control_change":
        if (ev.userId) s.driverId = ev.userId;
        break;
      case "intent_update":
        s.objective = ev.text ?? null;
        s.lastIntentSeq = ev.seq;
        break;
      case "permission_decision":
        if (ev.requestId && ev.decision && ev.userId)
          s.permissionDecisions.set(ev.requestId, {
            decision: ev.decision,
            userId: ev.userId,
          });
        break;
      case "model_change":
        if (ev.model) s.model = ev.model;
        break;
      case "user_message":
        s.agentBusy = true;
        break;
      case "turn_end":
      case "agent_error":
        s.agentBusy = false;
        break;
    }
  }
  return s;
}
```

Note: `identity.test.ts` only imports pure functions, so no DOM/sessionStorage shim is needed; do NOT add jsdom.

- [ ] **Step 5: Run** — `npm test` → PASS; `npm run build` still clean (App.tsx untouched so far — the moved types stay duplicated until Task 6 rewires App).
- [ ] **Step 6: Commit**

```bash
git add poc/client/package.json poc/client/package-lock.json poc/client/src/types.ts poc/client/src/identity.ts poc/client/src/derive.ts poc/client/src/identity.test.ts poc/client/src/derive.test.ts
git commit -m "feat(client): vitest infra + identity/derive pure modules"
```

---

### Task 5: Client — dino game engine (pure)

**Files:**
- Create: `poc/client/src/game/dino.ts`, `poc/client/src/game/dino.test.ts`

**Interfaces:**
- Produces: `interface DinoState { t: number; y: number; vy: number; obstacles: number[]; nextGap: number; rng: number; score: number; alive: boolean }`; `LANE_WIDTH = 40`; `DINO_X = 4`; `initialState(seed?: number): DinoState`; `jump(s: DinoState): DinoState`; `tick(s: DinoState, dt: number): DinoState` (pure, deterministic — LCG in state, no `Math.random`); `renderLane(s: DinoState): [string, string]` (two `LANE_WIDTH`-char rows: air row, ground row).

- [ ] **Step 1: Write failing tests** — `dino.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initialState, jump, tick, renderLane, DINO_X, LANE_WIDTH } from "./dino";

const run = (s: ReturnType<typeof initialState>, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) s = tick(s, 1 / 60);
  return s;
};

describe("dino", () => {
  it("is deterministic for a given seed", () => {
    expect(run(initialState(7), 3)).toEqual(run(initialState(7), 3));
  });

  it("jump arcs up and returns to ground", () => {
    let s = jump(initialState());
    let peaked = 0;
    for (let i = 0; i < 120; i++) {
      s = tick(s, 1 / 60);
      peaked = Math.max(peaked, s.y);
    }
    expect(peaked).toBeGreaterThan(0.5);
    expect(s.y).toBe(0);
  });

  it("dies when an obstacle reaches the dino column on the ground", () => {
    let s = { ...initialState(), obstacles: [DINO_X + 3], nextGap: 999 };
    s = run(s, 1);
    expect(s.alive).toBe(false);
    const frozen = tick(s, 1 / 60);
    expect(frozen).toEqual(s); // dead state is inert
  });

  it("survives the same obstacle when jumping over it", () => {
    let s = { ...initialState(), obstacles: [DINO_X + 4], nextGap: 999 };
    s = jump(s);
    s = run(s, 1);
    expect(s.alive).toBe(true);
  });

  it("score rises with time; renderLane emits two fixed-width rows", () => {
    const s = run(initialState(), 2);
    expect(s.score).toBeGreaterThan(0);
    const [air, ground] = renderLane(s);
    expect(air).toHaveLength(LANE_WIDTH);
    expect(ground).toHaveLength(LANE_WIDTH);
    expect(ground[DINO_X] === "ᗢ" || air[DINO_X] === "ᗢ").toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL.
- [ ] **Step 3: Implement** — `dino.ts`:

```ts
export const LANE_WIDTH = 40;
export const DINO_X = 4;
const SPEED = 14;       // columns / second
const GRAVITY = 30;     // rows / s²
const JUMP_V = 9;       // rows / s

export interface DinoState {
  t: number;
  y: number;
  vy: number;
  obstacles: number[];
  nextGap: number;
  rng: number;
  score: number;
  alive: boolean;
}

export function initialState(seed = 1): DinoState {
  return {
    t: 0, y: 0, vy: 0, obstacles: [], nextGap: 18,
    rng: seed >>> 0 || 1, score: 0, alive: true,
  };
}

const lcg = (r: number): number => (r * 1664525 + 1013904223) >>> 0;

export function jump(s: DinoState): DinoState {
  return s.alive && s.y === 0 ? { ...s, vy: JUMP_V } : s;
}

export function tick(s: DinoState, dt: number): DinoState {
  if (!s.alive) return s;
  const t = s.t + dt;
  let vy = s.vy - GRAVITY * dt;
  let y = s.y + vy * dt;
  if (y <= 0) { y = 0; vy = 0; }
  const dx = SPEED * dt;
  let obstacles = s.obstacles.map((x) => x - dx).filter((x) => x > -2);
  let { nextGap, rng } = s;
  nextGap -= dx;
  if (nextGap <= 0) {
    rng = lcg(rng);
    obstacles = [...obstacles, LANE_WIDTH + 2];
    nextGap = 12 + (rng % 14);
  }
  const hit = obstacles.some((x) => Math.abs(x - DINO_X) < 1 && y < 1);
  return {
    t, y, vy, obstacles, nextGap, rng,
    score: Math.floor(t * 10),
    alive: !hit,
  };
}

export function renderLane(s: DinoState): [string, string] {
  const air = Array<string>(LANE_WIDTH).fill(" ");
  const ground = Array<string>(LANE_WIDTH).fill(" ");
  for (const x of s.obstacles) {
    const c = Math.round(x);
    if (c >= 0 && c < LANE_WIDTH) ground[c] = "▲";
  }
  const sprite = s.alive ? "ᗢ" : "✖";
  if (s.y >= 1) air[DINO_X] = sprite;
  else ground[DINO_X] = sprite;
  return [air.join(""), ground.join("")];
}
```

- [ ] **Step 4: Run** — `npm test` → PASS. If the jump-over test fails, tune `JUMP_V`/`GRAVITY`/obstacle start column until BOTH collision tests pass — the physics must make clearing an obstacle possible with a well-timed jump; do not weaken the tests.
- [ ] **Step 5: Commit**

```bash
git add poc/client/src/game
git commit -m "feat(client): deterministic dino game engine (pure, tested)"
```

---

### Task 6: Client — socket hook + terminal shell recomposition

**Files:**
- Create: `poc/client/src/useSessionSocket.ts`, `poc/client/src/components/Header.tsx`, `poc/client/src/components/PromptBar.tsx`, `poc/client/src/terminal.css`
- Modify: `poc/client/src/App.tsx` (full rewrite), `poc/client/src/App.css` (delete file; import `terminal.css` instead)

**Interfaces:**
- Consumes: `types.ts`, `identity.ts`, `derive.ts` (Task 4).
- Produces:
  - `useSessionSocket(opts: { sessionId: string; projectId: string; userId: string; profile: Profile }): { events: LoggedEvent[]; errors: string[]; connected: boolean; projectSessions: ProjectSessionInfo[]; send: (msg: object) => void }` — the ws lifecycle from today's App.tsx moved verbatim, joining with `name: profile.name, glyph: profile.glyph, color: profile.color`.
  - `Header` props: `{ projectId: string; sessionId: string; model: string; connected: boolean; objective: string | null; canSetModel: boolean; onSetModel: (key: string) => void }`.
  - `PromptBar` props: `{ isDriver: boolean; agentBusy: boolean; watcherNames: string[]; onPrompt: (text: string) => void; onTakeWheel: () => void; inputRef: React.RefObject<HTMLInputElement | null> }`.
  - CSS custom properties every later task uses: `--bg --panel --fg --dim --frame --gold --red --amber --green --accent` and classes `.term`, `.term-frame`, `.statusline`, `.line`, `.line.dim`, `.line.gold`, `.line.red`.
  - A client-side model map in `Header.tsx`: `const MODEL_LABELS: Record<string, string> = { opus: "opus 4.8", sonnet: "sonnet 5", haiku: "haiku 4.5" };` (also exported for ThinkingStrip).

- [ ] **Step 1: Extract `useSessionSocket.ts`** — today's `useEffect` ws block (App.tsx:59-91) moved into the hook, plus a `send` helper (`wsRef.current?.send(JSON.stringify(msg))`). No behavior change beyond the extra join fields.
- [ ] **Step 2: Write `terminal.css`** (imported from App.tsx; delete `App.css`):

```css
* { box-sizing: border-box; }
:root {
  --bg: #0b0d10; --panel: #101318; --fg: #d8dee6; --dim: #6b7482;
  --frame: #333b49; --gold: #d9b86b; --red: #e0685f; --amber: #e0a458;
  --green: #7fbf7f; --accent: #d97757;
}
html, body, #root { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
}
button, input, select { font: inherit; color: inherit; }

.term {
  display: flex; flex-direction: column;
  height: 100%; max-width: 1280px; margin: 0 auto; padding: 10px 14px;
}
.term-frame { border: 1px solid var(--frame); border-radius: 6px; background: var(--panel); }

/* header */
.term-header {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 12px; margin-bottom: 8px;
  color: var(--dim); white-space: nowrap; overflow: hidden;
}
.term-header .crumb b { color: var(--fg); font-weight: 600; }
.term-header .rule { flex: 1; border-top: 1px dashed var(--frame); }
.term-header select {
  background: transparent; border: none; color: var(--accent); cursor: pointer;
}
.term-header select:disabled { color: var(--dim); cursor: default; }
.conn { color: var(--green); } .conn.off { color: var(--red); }

/* objective quest line */
.objective { color: var(--gold); padding: 0 12px 6px; }
.objective .label { letter-spacing: 0.08em; font-weight: 600; }

/* two-pane split */
.split { flex: 1; display: flex; gap: 8px; min-height: 0; }
.transcript { flex: 1; overflow-y: auto; padding: 10px 12px; }

/* transcript lines (Task 7 renders into these) */
.line { white-space: pre-wrap; overflow-wrap: anywhere; }
.line + .line { margin-top: 2px; }
.line.dim { color: var(--dim); }
.line.gold { color: var(--gold); }
.line.red { color: var(--red); }
.line.done { text-decoration: line-through; opacity: 0.6; }
.line .who { font-weight: 600; }

/* prompt bar + status line */
.promptbar { margin-top: 8px; }
.promptbar .inputbox {
  display: flex; gap: 8px; padding: 8px 12px;
  border: 1px solid var(--frame); border-radius: 6px; background: var(--panel);
}
.promptbar .inputbox:focus-within { border-color: var(--accent); }
.promptbar .caret { color: var(--accent); }
.promptbar input { flex: 1; background: transparent; border: none; outline: none; }
.promptbar button.wheel {
  width: 100%; padding: 8px 12px; text-align: left; cursor: pointer;
  border: 1px dashed var(--frame); border-radius: 6px;
  background: transparent; color: var(--gold);
}
.promptbar button.wheel:hover { border-color: var(--gold); }
.statusline {
  display: flex; gap: 14px; padding: 4px 12px 0; color: var(--dim); font-size: 12px;
}
.statusline .driving { color: var(--green); }

/* party pane (Task 8), thinking strip (Task 9), lobby (Task 10) add their
   sections below this line */
@media (max-width: 900px) { .party { display: none; } }
```

- [ ] **Step 3: Write `Header.tsx`:**

```tsx
export const MODEL_LABELS: Record<string, string> = {
  opus: "opus 4.8", sonnet: "sonnet 5", haiku: "haiku 4.5",
};

export function Header(props: {
  projectId: string; sessionId: string; model: string; connected: boolean;
  objective: string | null; canSetModel: boolean; onSetModel: (key: string) => void;
}) {
  return (
    <>
      <div className="term-header term-frame">
        <span className="crumb">
          multiplayer_ai · <b>{props.projectId}</b> · session <b>{props.sessionId}</b>
        </span>
        <span className="rule" />
        <label>
          agent:{" "}
          <select
            value={props.model}
            disabled={!props.canSetModel}
            onChange={(e) => props.onSetModel(e.target.value)}
            title={props.canSetModel ? "switch model (applies next turn)" : "only the driver can switch, between turns"}
          >
            {Object.entries(MODEL_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <span className={props.connected ? "conn" : "conn off"}>
          {props.connected ? "● connected" : "○ disconnected"}
        </span>
      </div>
      {props.objective && (
        <div className="objective">
          ✦ <span className="label">OBJECTIVE:</span> {props.objective}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Write `PromptBar.tsx`:**

```tsx
import { useState } from "react";

export function PromptBar(props: {
  isDriver: boolean; agentBusy: boolean; watcherNames: string[];
  onPrompt: (text: string) => void; onTakeWheel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    props.onPrompt(t);
    setText("");
  };
  return (
    <div className="promptbar">
      {props.isDriver ? (
        <div className="inputbox">
          <span className="caret">&gt;</span>
          <input
            ref={props.inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="you're driving — prompt the agent…"
            maxLength={4000}
          />
        </div>
      ) : (
        <button className="wheel" onClick={props.onTakeWheel}>
          🛞 take the wheel
        </button>
      )}
      <div className="statusline">
        <span className={props.isDriver ? "driving" : ""}>
          {props.isDriver ? "🛞 you are driving" : "watching"}
        </span>
        {props.agentBusy && <span>✦ agent working…</span>}
        {props.watcherNames.length > 0 && (
          <span>{props.watcherNames.join(", ")} watching</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Rewrite `App.tsx`** as composition root: `loadOrCreateUserId()` + `loadProfile()` (profile fallback for this task: `?name=` param or auto `user-xxxx` name with `hashIdentity` glyph/color — the lobby gate arrives in Task 10); `useSessionSocket`; `const derived = useMemo(() => deriveState(events), [events])`; renders `Header`, a temporary transcript that reuses today's event `switch` (adapted to the new derived types — `participants.get(id)?.name` instead of the old string map, and `permissionDecisions.get(id)?.decision` instead of the old string value; restyled classes come in Task 7), the existing teammates list (replaced in Task 8), `PromptBar`. Handlers: `onPrompt` → `send({ type: "prompt", text })`, `onTakeWheel` → `send({ type: "take_wheel" })`, `onSetModel` → `send({ type: "set_model", model: key })`, `sendPermission` as today via `send`. `canSetModel = isDriver && !derived.agentBusy`. `watcherNames` = participants minus driver minus self. Delete the now-duplicated local type declarations and `getIdentity` (use `types.ts`/`identity.ts`).
- [ ] **Step 6: Verify** — `npm run build` clean; `npm test` still green. Launch the demo (server + client, see HANDOFF §8) and screenshot: header rule + boxed prompt + status line render; prompting still works end-to-end.
- [ ] **Step 7: Commit**

```bash
git add poc/client/src
git rm poc/client/src/App.css
git commit -m "feat(client): terminal shell — socket hook, header, prompt bar, terminal.css"
```

---

### Task 7: Client — transcript rendering (event lines, permission block, flourish, quest log)

**Files:**
- Create: `poc/client/src/components/Transcript.tsx`
- Modify: `poc/client/src/App.tsx` (swap temp transcript for the component), `poc/client/src/terminal.css` (append transcript styles)

**Interfaces:**
- Consumes: `DerivedState`, `LoggedEvent`, `sendPermission`.
- Produces: `Transcript` props: `{ events: LoggedEvent[]; derived: DerivedState; isDriver: boolean; selfId: string; onPermission: (requestId: string, decision: "allow" | "deny") => void }`. Auto-scroll `bottomRef` moves in here.

- [ ] **Step 1: Implement `Transcript.tsx`** — one `renderEvent(ev)` switch producing spec §3's lines:

```tsx
import { useEffect, useRef } from "react";
import type { DerivedState } from "../derive";
import type { LoggedEvent } from "../types";

const isFresh = (ev: LoggedEvent) => Date.now() - new Date(ev.ts).getTime() < 5000;

export function Transcript(props: {
  events: LoggedEvent[]; derived: DerivedState; isDriver: boolean;
  selfId: string;
  onPermission: (requestId: string, decision: "allow" | "deny") => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.events]);
  const { participants, permissionDecisions, lastIntentSeq } = props.derived;
  const nameOf = (id?: string) => (id && participants.get(id)?.name) ?? id ?? "?";
  const colorOf = (id?: string) => (id && participants.get(id)?.color) ?? "var(--fg)";

  // a/d keyboard shortcuts for the newest undecided permission (driver only)
  const pending = props.events.filter(
    (e) => e.type === "permission_request" && e.requestId && !permissionDecisions.has(e.requestId),
  );
  const newest = pending.at(-1);
  useEffect(() => {
    if (!props.isDriver || !newest?.requestId) return;
    const onKey = (e: KeyboardEvent) => {
      if ((document.activeElement as HTMLElement | null)?.tagName === "INPUT") return;
      if (e.key === "a") props.onPermission(newest.requestId!, "allow");
      if (e.key === "d") props.onPermission(newest.requestId!, "deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.isDriver, newest?.requestId]);

  return (
    <main className="transcript term-frame">
      {props.events.map((ev) => {
        switch (ev.type) {
          case "user_message":
            return (
              <div key={ev.seq} className="line">
                <span className="who" style={{ color: colorOf(ev.userId) }}>
                  &gt; {nameOf(ev.userId)}:
                </span>{" "}
                {ev.text}
              </div>
            );
          case "agent_text_delta":
            return <div key={ev.seq} className="line">⏺ {ev.text}</div>;
          case "tool_call":
            return (
              <div key={ev.seq} className="line dim">
                ⏺ {ev.toolName}({JSON.stringify(ev.input)?.slice(0, 200)})
              </div>
            );
          case "tool_result":
            return (
              <div key={ev.seq} className="line dim">
                {"  ⎿ "}{ev.output?.slice(0, 300)}
              </div>
            );
          case "control_change":
            return (
              <div key={ev.seq} className={isFresh(ev) ? "line wheel fresh" : "line wheel"}>
                🛞 {nameOf(ev.userId)} took the wheel
              </div>
            );
          case "agent_error":
            return <div key={ev.seq} className="line red">⚠ {ev.message}</div>;
          case "intent_update":
            return (
              <div key={ev.seq} className={ev.seq === lastIntentSeq ? "line gold" : "line gold done"}>
                ✦ objective: {ev.text}
              </div>
            );
          case "model_change":
            return (
              <div key={ev.seq} className="line gold">
                ✦ {nameOf(ev.userId)} switched the agent to {ev.model}
              </div>
            );
          case "permission_request": {
            const decided = ev.requestId ? permissionDecisions.get(ev.requestId) : undefined;
            const cmd = (ev.input as { command?: unknown } | undefined)?.command;
            const preview = typeof cmd === "string" ? cmd : JSON.stringify(ev.input);
            return (
              <div key={ev.seq} className="perm">
                <div className="perm-title">🔐 agent wants to run <b>{ev.toolName}</b></div>
                <code className="perm-input">{preview?.slice(0, 300)}</code>
                {decided ? (
                  <div className="perm-outcome">
                    {decided.decision === "allow" ? "✅ approved" : "⛔ denied"} by {nameOf(decided.userId)}
                  </div>
                ) : props.isDriver && ev.requestId ? (
                  <div className="perm-actions">
                    <button onClick={() => props.onPermission(ev.requestId!, "allow")}>[a]pprove</button>
                    <button className="deny" onClick={() => props.onPermission(ev.requestId!, "deny")}>[d]eny</button>
                  </div>
                ) : (
                  <div className="perm-outcome">⏳ driver deciding…</div>
                )}
              </div>
            );
          }
          case "permission_decision":
            return null; // folded into the request block via permissionDecisions
          default:
            return null; // presence_join/leave, turn_end: no transcript line
        }
      })}
      <div ref={bottomRef} />
    </main>
  );
}
```

Note two deliberate changes from today: `permission_decision` no longer renders its own system line (the block shows "by <name>"), and presence events render nothing (the party pane + status line carry presence).

- [ ] **Step 2: Append transcript CSS** to `terminal.css`:

```css
/* take-the-wheel flourish */
.line.wheel { color: var(--gold); border-top: 1px dashed var(--frame); border-bottom: 1px dashed var(--frame); padding: 3px 0; margin: 6px 0; }
.line.wheel.fresh { animation: wheel-sweep 0.9s ease-out 1; }
@keyframes wheel-sweep {
  0% { background: linear-gradient(90deg, var(--gold) 0%, transparent 0%); color: var(--bg); }
  60% { background: linear-gradient(90deg, transparent 0%, rgba(217, 184, 107, 0.25) 50%, transparent 100%); color: var(--gold); }
  100% { background: transparent; }
}

/* permission block */
.perm { border: 1px solid var(--amber); border-left-width: 3px; border-radius: 4px; padding: 6px 10px; margin: 6px 0; display: flex; flex-direction: column; gap: 4px; }
.perm-title { color: var(--amber); }
.perm-input { background: var(--bg); border-radius: 3px; padding: 4px 8px; overflow-wrap: anywhere; color: var(--fg); }
.perm-actions { display: flex; gap: 10px; }
.perm-actions button { background: transparent; border: 1px solid var(--green); color: var(--green); border-radius: 4px; padding: 2px 10px; cursor: pointer; }
.perm-actions button.deny { border-color: var(--red); color: var(--red); }
.perm-outcome { color: var(--dim); font-size: 12px; }
```

- [ ] **Step 3: Wire into App.tsx** (replace the temporary transcript block).
- [ ] **Step 4: Verify** — `npm run build` clean, `npm test` green. Live check with two tabs: user line colored, tool lines dim with `⎿`, take-the-wheel sweeps once on the fresh event only (reload → no sweep on replayed ones), a gated Bash raises the amber block, `a`/`d` keys work for the driver only and not while typing in the prompt.
- [ ] **Step 5: Commit**

```bash
git add poc/client/src
git commit -m "feat(client): terminal transcript — event lines, permission block, wheel flourish, quest log"
```

---

### Task 8: Client — PARTY pane

**Files:**
- Create: `poc/client/src/components/PartyPane.tsx`
- Modify: `poc/client/src/App.tsx` (replace `<aside className="teammates">`), `poc/client/src/terminal.css` (append)

**Interfaces:**
- Consumes: `ProjectSessionInfo[]` from `useSessionSocket`.
- Produces: `PartyPane` props: `{ projectId: string; sessionId: string; sessions: ProjectSessionInfo[] }` — shows ALL sessions (own session marked `you are here`), each with a session-glyph (`hashIdentity(s.id)` reused for deterministic glyph/color), participants, `🛞 driverName`, quest line (`✦ intent` or dim `no quest declared`), relative last-activity (`3m ago`), ended dimmed. Other sessions link to `?project=…&session=…` as today.

- [ ] **Step 1: Implement `PartyPane.tsx`:**

```tsx
import { hashIdentity } from "../identity";
import type { ProjectSessionInfo } from "../types";

const ago = (ts: string | null) => {
  if (!ts) return "";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
};

export function PartyPane(props: {
  projectId: string; sessionId: string; sessions: ProjectSessionInfo[];
}) {
  return (
    <aside className="party term-frame">
      <div className="party-title">PARTY · {props.projectId}</div>
      {props.sessions.map((s) => {
        const id = hashIdentity(s.id);
        const here = s.id === props.sessionId;
        return (
          <a
            key={s.id}
            className={s.ended ? "member ended" : "member"}
            href={here ? undefined : `?project=${props.projectId}&session=${s.id}`}
          >
            <div className="member-head">
              <span style={{ color: id.color }}>{id.glyph}</span> {s.id}
              {here && <span className="here"> · you are here</span>}
              {s.ended && " (ended)"}
            </div>
            <div className={s.intent ? "member-quest" : "member-quest none"}>
              ✦ {s.intent ?? "no quest declared"}
            </div>
            <div className="member-meta">
              {s.participants.join(", ") || "empty"}
              {s.driverName ? ` · 🛞 ${s.driverName}` : ""}
              {s.lastActivityTs ? ` · ${ago(s.lastActivityTs)}` : ""}
            </div>
          </a>
        );
      })}
      {props.sessions.length === 0 && <div className="member-meta">no sessions yet</div>}
    </aside>
  );
}
```

- [ ] **Step 2: Append CSS:**

```css
.party { width: 280px; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.party-title { color: var(--dim); letter-spacing: 0.12em; font-size: 11px; }
.member { display: block; border: 1px solid var(--frame); border-radius: 4px; padding: 6px 8px; color: inherit; text-decoration: none; }
.member:hover { border-color: var(--accent); }
.member.ended { opacity: 0.5; }
.member-head { font-weight: 600; }
.member-head .here { color: var(--dim); font-weight: 400; }
.member-quest { color: var(--gold); font-size: 12px; margin: 2px 0; }
.member-quest.none { color: var(--dim); }
.member-meta { color: var(--dim); font-size: 11px; }
```

- [ ] **Step 3: Wire into App.tsx** inside `.split` next to the transcript; delete the old teammates markup (and its now-unused `.filter((s) => s.id !== sessionId)` — the pane shows all and marks "you are here").
- [ ] **Step 4: Verify** — build + tests green; live: two sessions in one project show each other with glyphs and quest lines; narrow the window under 900px → pane hides.
- [ ] **Step 5: Commit**

```bash
git add poc/client/src
git commit -m "feat(client): PARTY pane — session roster with glyphs and quest lines"
```

---

### Task 9: Client — thinking strip + mini-game integration

**Files:**
- Create: `poc/client/src/components/ThinkingStrip.tsx`
- Modify: `poc/client/src/App.tsx` (render under Transcript when busy), `poc/client/src/terminal.css` (append)

**Interfaces:**
- Consumes: `game/dino.ts` (Task 5), `derived.agentBusy`, `derived.model`, `MODEL_LABELS` from `Header.tsx`, the `inputRef` shared with PromptBar.
- Produces: `ThinkingStrip` props: `{ busy: boolean; modelLabel: string }`. localStorage key `mpai-dino-high`.

- [ ] **Step 1: Implement `ThinkingStrip.tsx`:**

```tsx
import { useEffect, useRef, useState } from "react";
import { initialState, jump, tick, renderLane, type DinoState } from "../game/dino";

const HIGH_KEY = "mpai-dino-high";

export function ThinkingStrip(props: { busy: boolean; modelLabel: string }) {
  const [state, setState] = useState<DinoState>(() => initialState(Date.now() % 100000 | 1));
  const [high, setHigh] = useState(() => Number(localStorage.getItem(HIGH_KEY) ?? 0));
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

  // game loop while busy
  useEffect(() => {
    if (!props.busy) return;
    startRef.current = performance.now();
    setState(initialState((Date.now() % 100000) | 1));
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      setElapsed(Math.floor((now - startRef.current) / 1000));
      setState((s) => {
        if (!s.alive) return s;
        return tick(s, dt);
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [props.busy]);

  // dead → auto-restart after a beat; persist high score
  useEffect(() => {
    if (state.alive) return;
    if (state.score > high) {
      setHigh(state.score);
      localStorage.setItem(HIGH_KEY, String(state.score));
    }
    const t = setTimeout(() => setState(initialState((state.rng % 100000) | 1)), 1000);
    return () => clearTimeout(t);
  }, [state.alive]);

  // space to jump when not typing
  useEffect(() => {
    if (!props.busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      e.preventDefault();
      setState((s) => jump(s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.busy]);

  if (!props.busy) return null;
  const [air, ground] = renderLane(state);
  const pad = (n: number) => String(n).padStart(4, "0");
  return (
    <div className="thinking term-frame">
      <div className="thinking-head">
        <span className="pulse">✦</span> {props.modelLabel} is thinking… ({elapsed}s)
        <span className="thinking-score">score {pad(state.score)} · high {pad(high)}</span>
      </div>
      <pre className="lane">{air + "\n" + ground}</pre>
      <div className="thinking-hint">space to jump · click the prompt to type instead</div>
    </div>
  );
}
```

- [ ] **Step 2: Append CSS** (includes the fade — the strip unmounts on `busy=false`, so fade the whole strip IN on mount and rely on removal being visually clean; a one-beat fade-out needs the strip to render for 600ms after busy flips — implement that inside the component with a `visible` state that delays `return null` by 600ms and adds the `.leaving` class):

```css
.thinking { margin-top: 8px; padding: 6px 12px; color: var(--gold); animation: strip-in 0.3s ease-out; }
.thinking.leaving { opacity: 0; transition: opacity 0.6s ease-out; }
.thinking-head { display: flex; gap: 8px; }
.thinking-score { margin-left: auto; color: var(--dim); }
.pulse { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
@keyframes strip-in { from { opacity: 0; } }
.lane { margin: 2px 0; border-top: 1px dashed var(--frame); border-bottom: 1px dashed var(--frame); padding: 2px 0; color: var(--fg); line-height: 1.2; }
.thinking-hint { color: var(--dim); font-size: 11px; }
```

Add the delayed-unmount: track `props.busy` in a `useEffect`; when it flips false, set `leaving=true`, and after 600ms render null. (Keep this logic in the component, ~10 lines.)

- [ ] **Step 3: Wire into App.tsx** — directly below `<Transcript …/>`: `<ThinkingStrip busy={derived.agentBusy} modelLabel={MODEL_LABELS[derived.model] ?? derived.model} />`.
- [ ] **Step 4: Verify** — build + tests green. Live: prompt the agent → strip appears with the correct model label, dino runs, space jumps (but typing in the prompt still inserts spaces), score survives death restarts, high score persists across reloads, strip fades when the turn ends (`turn_end` arrives).
- [ ] **Step 5: Commit**

```bash
git add poc/client/src
git commit -m "feat(client): thinking strip with playable dino mini-game"
```

---

### Task 10: Client — lobby + agent-picker wiring

**Files:**
- Create: `poc/client/src/components/Lobby.tsx`
- Modify: `poc/client/src/App.tsx` (lobby gate), `poc/client/src/terminal.css` (append)

**Interfaces:**
- Consumes: `identity.ts` (GLYPHS, IDENTITY_COLORS, loadProfile, saveProfile), `SERVER_URL`, the `peek` wire message (Task 3), `ProjectSessionInfo`.
- Produces: `Lobby` props: `{ projectId: string; sessionId: string; defaultName: string; onEnter: (p: Profile) => void }`. App gate: profile from `loadProfile()`, else `?name=` param (auto-profile via `hashIdentity(userId)`, skipping the lobby — demo compatibility), else render `Lobby`; `onEnter` saves and sets state, which mounts the session UI (socket connects only once a profile exists).

- [ ] **Step 1: Implement `Lobby.tsx`:**

```tsx
import { useEffect, useState } from "react";
import { GLYPHS, IDENTITY_COLORS, type Profile } from "../identity";
import { SERVER_URL, type ProjectSessionInfo } from "../types";

export function Lobby(props: {
  projectId: string; sessionId: string; defaultName: string;
  onEnter: (p: Profile) => void;
}) {
  const [name, setName] = useState(props.defaultName);
  const [glyph, setGlyph] = useState<string>(GLYPHS[0]);
  const [color, setColor] = useState<string>(IDENTITY_COLORS[0]);
  const [party, setParty] = useState<ProjectSessionInfo[]>([]);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "peek", projectId: props.projectId }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "project") setParty(m.sessions);
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [props.projectId]);

  const enter = () => {
    const n = name.trim().slice(0, 40);
    if (n) props.onEnter({ name: n, glyph, color });
  };

  return (
    <div className="lobby term-frame">
      <div className="lobby-title">JOIN SESSION {props.sessionId} · {props.projectId}</div>
      <label className="lobby-row">
        name <span className="caret">›</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && enter()} maxLength={40} />
      </label>
      <div className="lobby-row">
        glyph <span className="caret">›</span>
        {GLYPHS.map((g) => (
          <button key={g} className={g === glyph ? "pick on" : "pick"}
            style={{ color }} onClick={() => setGlyph(g)}>{g}</button>
        ))}
      </div>
      <div className="lobby-row">
        color <span className="caret">›</span>
        {IDENTITY_COLORS.map((c) => (
          <button key={c} className={c === color ? "pick on" : "pick"}
            style={{ color: c }} onClick={() => setColor(c)}>■</button>
        ))}
      </div>
      <div className="lobby-party">
        party:{" "}
        {party.length === 0
          ? "no one here yet"
          : party.map((s) => `${s.id} (${s.participants.join(", ") || "empty"})`).join(" · ")}
      </div>
      <button className="lobby-enter" onClick={enter} disabled={!name.trim()}>
        [ enter session ]
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Append CSS:**

```css
.lobby { max-width: 480px; margin: 15vh auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 12px; }
.lobby-title { color: var(--dim); letter-spacing: 0.12em; font-size: 11px; }
.lobby-row { display: flex; align-items: center; gap: 8px; }
.lobby-row .caret { color: var(--accent); }
.lobby-row input { flex: 1; background: var(--bg); border: 1px solid var(--frame); border-radius: 4px; padding: 6px 10px; outline: none; }
.lobby-row input:focus { border-color: var(--accent); }
.pick { background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 2px 6px; cursor: pointer; }
.pick.on { border-color: var(--accent); }
.lobby-party { color: var(--dim); font-size: 12px; }
.lobby-enter { border: 1px solid var(--green); color: var(--green); background: transparent; border-radius: 4px; padding: 8px; cursor: pointer; }
.lobby-enter:disabled { border-color: var(--frame); color: var(--dim); }
```

- [ ] **Step 3: Gate in App.tsx** — `const [profile, setProfile] = useState<Profile | null>(() => { const nameParam = new URLSearchParams(window.location.search).get("name"); if (nameParam) return { name: nameParam.slice(0, 40), ...hashIdentity(loadOrCreateUserId()) }; return loadProfile(); });` If `profile === null` render `<Lobby … defaultName={"user-" + userId.slice(0, 4)} onEnter={(p) => { saveProfile(p); setProfile(p); }} />`, else the session UI. `useSessionSocket` must therefore accept `profile: Profile` and only be mounted in the session branch (split App into `App` gate + `SessionView` inner component so hooks stay unconditional).
- [ ] **Step 4: Verify** — build + tests green. Live: fresh tab (or new sessionStorage) → lobby with live party preview; enter → joined with chosen glyph/color visible to the other tab's presence (check the join event in the other tab's devtools or the PARTY pane participant list); `?name=ana` URL skips the lobby (demo scripts unaffected); driver switches model in the header → `✦ … switched the agent to sonnet` appears in both tabs and the next thinking strip says `sonnet 5`.
- [ ] **Step 5: Commit**

```bash
git add poc/client/src
git commit -m "feat(client): lobby join screen + agent picker wiring"
```

---

### Task 11: frontend-design skill pass + comparison

**Files:**
- Create: `docs/design/frontend-design-skill-notes.md`
- Modify: `poc/client/src/terminal.css` (refinements only — no structural/component changes)

**Interfaces:**
- Consumes: the built v4 UI (Tasks 6–10), the spec, the Claude Design brief (Task 1).

- [ ] **Step 1: Invoke the skill** — `Skill(soltero-skills:frontend-design)` (in the executing session; if a subagent runs this task it must have Skill-tool access, otherwise run this task in the main session).
- [ ] **Step 2: Apply its process to this UI** — follow the skill's actual guidance (aesthetic direction, typography, intentionality checks) against the running app; capture every concrete recommendation it produces.
- [ ] **Step 3: Write `docs/design/frontend-design-skill-notes.md`** with: (a) what the skill prescribed, verbatim-faithful summaries; (b) where it agreed/disagreed with the spec + brief; (c) which recommendations were adopted; (d) a verdict paragraph — is the skill useful alongside a hand-written brief for this kind of work? (This is the user's requested skill TEST — the comparison is the deliverable, not just polish.)
- [ ] **Step 4: Apply adopted refinements** to `terminal.css` (type scale, spacing, palette nudges). Keep changes CSS-only; if the skill demands structural change, record it in the notes as future work instead.
- [ ] **Step 5: Verify** — `npm run build` clean; visual spot-check.
- [ ] **Step 6: Commit**

```bash
git add docs/design/frontend-design-skill-notes.md poc/client/src/terminal.css
git commit -m "docs+style: frontend-design skill pass — notes, comparison, adopted refinements"
```

---

### Task 12: Live acceptance + screenshots + HANDOFF refresh

**Files:**
- Create: `v4-lobby.png`, `v4-shell.png`, `v4-thinking-game.png`, `v4-permission.png`, `v4-party-wheel.png` (repo root, matching the step*.png convention)
- Modify: `HANDOFF.md`

- [ ] **Step 1: Start the demo stack** — kill stale listeners first (`kill $(lsof -tiTCP:3001 -sTCP:LISTEN)` etc.), then `poc/scripts/demo-setup.sh`; server: `cd poc/server && AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`; client: `cd poc/client && npm run dev` (check the vite banner for the real port).
- [ ] **Step 2: Playwright acceptance** (two tabs, `?project=demo&session=ana` fresh-storage and `?project=demo&session=ben&name=ben`):
  1. Fresh tab shows the LOBBY with live party preview → enter as `ana` with a picked glyph/color → `v4-lobby.png`.
  2. Terminal shell renders: header rule with `agent: opus 4.8`, boxed prompt, status line, PARTY pane listing both sessions → `v4-shell.png`.
  3. Prompt the agent → thinking strip appears with dino lane; press space → dino jumps; score ticks → `v4-thinking-game.png`; on turn end the strip fades and `✦ objective:` line + pinned OBJECTIVE appear (agent's set_intent).
  4. Ask for a gated command (e.g. "run `rm -rf /tmp/x`") → amber 🔐 block; non-driver tab shows `⏳ driver deciding…`; approve with the `a` key → block collapses to `✅ approved by ana` → `v4-permission.png`.
  5. Tab 2 takes the wheel → flourish sweeps in both tabs; tab 2 switches model to `sonnet 5` → `✦ ben switched the agent to sonnet` in both tabs; next prompt's strip reads `sonnet 5 is thinking…` → `v4-party-wheel.png`.
  6. Regression: full server suite `cd poc/server && npx vitest run` green; client `npm test` + `npm run build` green.
- [ ] **Step 3: Fix-forward any findings** (systematic-debugging skill if a scenario fails), re-run the failed scenario.
- [ ] **Step 4: Update `HANDOFF.md`** — v4 status, new files with line refs, acceptance results, remaining open items (the §7 ratification thread stays).
- [ ] **Step 5: Commit**

```bash
git add v4-*.png HANDOFF.md
git commit -m "test: v4 live acceptance — screenshots + HANDOFF refresh"
```
