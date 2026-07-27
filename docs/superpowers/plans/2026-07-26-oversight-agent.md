# Oversight Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in, server-side oversight agent that watches structured cross-session digests and maintains a short prose summary of team activity, surfaced on a new OVERSIGHT screen and pullable into a session by its driver.

**Architecture:** A server module (`overseer.ts`) debounces activity notifications and makes one stateless haiku SDK call per refresh off an extended `digest.ts` (no transcript prose). The summary rides the snapshot-shaped project channel (`oversight` field + existing `pushProject`). Driver pull appends an attributed `oversight_pull` session event and injects an `<oversight>` block into exactly the next agent turn; the awareness MCP server gains a gated `team_update` tool.

**Tech Stack:** Node 22 / TypeScript server (`@anthropic-ai/claude-agent-sdk`, `ws`, no new deps), React 18 client, Vitest both sides, plain CSS (`terminal.css`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-oversight-agent-design.md`. Deviations get recorded in this plan's Deviations section at the end.
- Branch: `feature/oversight-agent` (already created off main `9700a90`). Never merge without the user.
- The overseer reads **structured digests only — never transcript prose** (`agent_text_delta`/`tool_result` content must not reach the summarizer input).
- Oversight is **off by default**; while disabled, `notify` is a no-op and zero summarize calls happen.
- Error message strings from spec §6 are exact: `"only the current driver can pull team updates — take the wheel first"`, `"unknown project: <id>"`, `"team oversight is disabled"`, `"no team summary yet"`, plus command-validation strings defined in Task 3.
- The `oversight_pull` event payload field is `summarySeq` (NOT `seq` — that's the wire's own event counter).
- Production summarizer: one-shot SDK `query()` on `MODELS.haiku.id`, `tools: []`, `maxTurns: 1`, `settingSources: []`, `strictMcpConfig: true`. Tests always inject a fake summarize — no test may call the real SDK.
- Server commands run from `poc/server/`: `npx vitest run <file>`, full `npx vitest run`, `npx tsc --noEmit`. Client from `poc/client/`: `npm test`, `npm run build`.
- Baselines going in: **server 161 passing, client 72 passing**, both builds clean. Expected after all tasks: **server 186, client 76**.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `git add` explicit paths only — never `git add .` / `-A` (untracked user files sit at the repo root).

---

### Task 1: digest extension — oversightSessionDigest

**Files:**
- Modify: `poc/server/src/digest.ts` (append after `buildTeammateDigest`)
- Test: `poc/server/test/digest.test.ts` (new file)

**Interfaces:**
- Consumes: `LoggedEvent` from `./events.js` (already imported in digest.ts).
- Produces (Tasks 2–3 rely on these exact shapes):

```ts
export interface OversightSessionDigest {
  id: string;
  intent: string | null;
  driverName: string | null;
  participants: string[];
  recentToolCalls: { toolName: string; target: string }[];
  promptCount: number;
  pendingGates: number;
  errorCount: number;
  ended: boolean;
}
export function oversightSessionDigest(
  id: string,
  events: LoggedEvent[],
  ended: boolean,
  driverName: string | null,
  participants: string[],
): OversightSessionDigest;
```

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/digest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { oversightSessionDigest } from "../src/digest.js";
import type { LoggedEvent, SessionEvent } from "../src/events.js";

let seq = 0;
const le = (ev: SessionEvent): LoggedEvent => ({
  ...ev,
  seq: ++seq,
  ts: `2026-07-26T12:00:${String(seq).padStart(2, "0")}Z`,
});

describe("oversightSessionDigest", () => {
  it("counts prompts and errors", () => {
    const d = oversightSessionDigest(
      "s1",
      [
        le({ type: "user_message", userId: "u1", text: "go" }),
        le({ type: "user_message", userId: "u1", text: "more" }),
        le({ type: "agent_error", message: "boom" }),
      ],
      false,
      "Ana",
      ["Ana"],
    );
    expect(d.promptCount).toBe(2);
    expect(d.errorCount).toBe(1);
  });

  it("counts pending gates as requests without decisions", () => {
    const d = oversightSessionDigest(
      "s1",
      [
        le({ type: "permission_request", requestId: "r1", toolName: "Bash", input: {} }),
        le({ type: "permission_request", requestId: "r2", toolName: "Bash", input: {} }),
        le({ type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1" }),
      ],
      false,
      null,
      [],
    );
    expect(d.pendingGates).toBe(1);
  });

  it("keeps the last intent and the last 5 tool-call targets", () => {
    const events: LoggedEvent[] = [
      le({ type: "intent_update", text: "old goal" }),
      le({ type: "intent_update", text: "new goal" }),
    ];
    for (let i = 1; i <= 7; i++) {
      events.push(le({ type: "tool_call", toolName: "Read", input: { file_path: `f${i}.ts` } }));
    }
    const d = oversightSessionDigest("s1", events, false, null, []);
    expect(d.intent).toBe("new goal");
    expect(d.recentToolCalls).toHaveLength(5);
    expect(d.recentToolCalls[0]).toEqual({ toolName: "Read", target: "f3.ts" });
    expect(d.recentToolCalls[4]).toEqual({ toolName: "Read", target: "f7.ts" });
  });

  it("passes through identity fields verbatim", () => {
    const d = oversightSessionDigest("s9", [], true, "Ben", ["Ben", "Ana"]);
    expect(d.id).toBe("s9");
    expect(d.ended).toBe(true);
    expect(d.driverName).toBe("Ben");
    expect(d.participants).toEqual(["Ben", "Ana"]);
  });

  it("returns zeros and nulls for an empty log", () => {
    const d = oversightSessionDigest("s1", [], false, null, []);
    expect(d).toEqual({
      id: "s1",
      intent: null,
      driverName: null,
      participants: [],
      recentToolCalls: [],
      promptCount: 0,
      pendingGates: 0,
      errorCount: 0,
      ended: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/digest.test.ts`
Expected: FAIL — `oversightSessionDigest` not exported.

- [ ] **Step 3: Implement**

Append to `poc/server/src/digest.ts`:

```ts
export interface OversightSessionDigest {
  id: string;
  intent: string | null;
  driverName: string | null;
  participants: string[];
  recentToolCalls: { toolName: string; target: string }[];
  promptCount: number;
  pendingGates: number;
  errorCount: number;
  ended: boolean;
}

/** Structured per-session digest for the oversight summarizer (spec §3).
 *  Reads event metadata only — never agent_text_delta/tool_result content:
 *  the overseer must not see transcript prose. */
export function oversightSessionDigest(
  id: string,
  events: LoggedEvent[],
  ended: boolean,
  driverName: string | null,
  participants: string[],
): OversightSessionDigest {
  let intent: string | null = null;
  const toolCalls: { toolName: string; target: string }[] = [];
  let promptCount = 0;
  let errorCount = 0;
  const openGates = new Set<string>();
  for (const ev of events) {
    if (ev.type === "intent_update") intent = ev.text;
    if (ev.type === "tool_call") {
      const input = (ev.input ?? {}) as Record<string, unknown>;
      toolCalls.push({
        toolName: ev.toolName,
        target: String(input.file_path ?? input.pattern ?? input.path ?? ""),
      });
    }
    if (ev.type === "user_message") promptCount++;
    if (ev.type === "agent_error") errorCount++;
    if (ev.type === "permission_request") openGates.add(ev.requestId);
    if (ev.type === "permission_decision") openGates.delete(ev.requestId);
  }
  return {
    id,
    intent,
    driverName,
    participants,
    recentToolCalls: toolCalls.slice(-5),
    promptCount,
    pendingGates: openGates.size,
    errorCount,
    ended,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/digest.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 166 passing (161 + 5).

```bash
git add poc/server/src/digest.ts poc/server/test/digest.test.ts
git commit -m "feat(server): oversightSessionDigest — structured per-session digest for the overseer"
```

---

### Task 2: Overseer module

**Files:**
- Create: `poc/server/src/overseer.ts`
- Test: `poc/server/test/overseer.test.ts` (new file)

**Interfaces:**
- Consumes: `OversightSessionDigest` from Task 1; `MODELS` from `./models.js`; `query` from `@anthropic-ai/claude-agent-sdk`.
- Produces (Tasks 3–4 rely on these exact shapes):

```ts
export interface OversightSummary { text: string; ts: string; seq: number }
export interface OversightInput {
  projectId: string;
  previousSummary: string | null;
  sessions: OversightSessionDigest[];
}
export type Summarize = (input: OversightInput) => Promise<string>;
export class Overseer {
  constructor(
    summarize: Summarize,
    digestsFor: (projectId: string) => OversightSessionDigest[],
    onUpdate: (projectId: string) => void,
    debounceMs?: number, // default 30_000
  );
  isEnabled(projectId: string): boolean;
  latest(projectId: string): OversightSummary | null;
  setEnabled(projectId: string, enabled: boolean): void;
  notify(projectId: string): void;
  dispose(): void;
}
export function oversightToolText(enabled: boolean, latest: OversightSummary | null): string;
export const runOversightSummarize: Summarize; // production SDK one-shot
```

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/overseer.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Overseer, oversightToolText, type OversightInput } from "../src/overseer.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeOverseer(opts?: {
  summarize?: (input: OversightInput) => Promise<string>;
  debounceMs?: number;
}) {
  const calls: OversightInput[] = [];
  const updates: string[] = [];
  const summarize =
    opts?.summarize ??
    (async (input: OversightInput) => {
      calls.push(input);
      return `summary ${calls.length}`;
    });
  const overseer = new Overseer(
    async (input) => {
      if (opts?.summarize) calls.push(input);
      return summarize(input);
    },
    () => [],
    (projectId) => updates.push(projectId),
    opts?.debounceMs ?? 20,
  );
  return { overseer, calls, updates };
}

describe("Overseer", () => {
  it("defaults to disabled with no summary", () => {
    const { overseer } = makeOverseer();
    expect(overseer.isEnabled("p1")).toBe(false);
    expect(overseer.latest("p1")).toBe(null);
  });

  it("notify while disabled never summarizes", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.notify("p1");
    await wait(60);
    expect(calls).toHaveLength(0);
  });

  it("enabling triggers an immediate refresh and broadcasts", async () => {
    const { overseer, calls, updates } = makeOverseer();
    overseer.setEnabled("p1", true);
    await wait(20);
    expect(calls).toHaveLength(1);
    expect(overseer.latest("p1")).toMatchObject({ text: "summary 1", seq: 1 });
    // one push for the toggle itself, one for the summary landing
    expect(updates).toEqual(["p1", "p1"]);
  });

  it("a burst of notifies collapses into one debounced refresh", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.setEnabled("p1", true);
    await wait(20); // initial refresh done (1 call)
    overseer.notify("p1");
    overseer.notify("p1");
    overseer.notify("p1");
    await wait(60);
    expect(calls).toHaveLength(2);
    expect(overseer.latest("p1")?.seq).toBe(2);
  });

  it("notifies during an in-flight refresh coalesce into one follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const { overseer, calls } = makeOverseer({
      summarize: async () => {
        n++;
        if (n === 1) await gate;
        return `summary ${n}`;
      },
      debounceMs: 10,
    });
    overseer.setEnabled("p1", true); // starts refresh 1, held open
    await wait(5);
    overseer.notify("p1");
    overseer.notify("p1");
    release();
    await wait(60);
    expect(calls).toHaveLength(2); // held refresh + exactly one follow-up
  });

  it("a failing summarize keeps the previous summary and recovers on next activity", async () => {
    let fail = false;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { overseer } = makeOverseer({
      summarize: async () => {
        if (fail) throw new Error("model down");
        return "good";
      },
      debounceMs: 10,
    });
    overseer.setEnabled("p1", true);
    await wait(20);
    expect(overseer.latest("p1")?.text).toBe("good");
    fail = true;
    overseer.notify("p1");
    await wait(40);
    expect(overseer.latest("p1")?.text).toBe("good");
    expect(overseer.latest("p1")?.seq).toBe(1);
    fail = false;
    overseer.notify("p1");
    await wait(40);
    expect(overseer.latest("p1")?.seq).toBe(2);
    errSpy.mockRestore();
  });

  it("disabling mid-flight drops the in-flight result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { overseer } = makeOverseer({
      summarize: async () => {
        await gate;
        return "late";
      },
      debounceMs: 10,
    });
    overseer.setEnabled("p1", true);
    await wait(5);
    overseer.setEnabled("p1", false);
    release();
    await wait(20);
    expect(overseer.latest("p1")).toBe(null);
  });

  it("passes the previous summary and project id to the summarizer", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.setEnabled("p1", true);
    await wait(20);
    overseer.notify("p1");
    await wait(60);
    expect(calls[0]).toMatchObject({ projectId: "p1", previousSummary: null });
    expect(calls[1]).toMatchObject({ projectId: "p1", previousSummary: "summary 1" });
  });
});

describe("oversightToolText", () => {
  it("says disabled when disabled", () => {
    expect(oversightToolText(false, null)).toBe("team oversight is disabled");
    expect(oversightToolText(false, { text: "x", ts: "t", seq: 1 })).toBe(
      "team oversight is disabled",
    );
  });

  it("says no summary yet when enabled but empty", () => {
    expect(oversightToolText(true, null)).toBe("no team summary yet");
  });

  it("returns the summary text when available", () => {
    expect(oversightToolText(true, { text: "the team is shipping", ts: "t", seq: 3 })).toBe(
      "the team is shipping",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/overseer.test.ts`
Expected: FAIL — `../src/overseer.js` unresolvable.

- [ ] **Step 3: Implement**

Create `poc/server/src/overseer.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODELS } from "./models.js";
import type { OversightSessionDigest } from "./digest.js";

export interface OversightSummary {
  text: string;
  ts: string;
  seq: number;
}

export interface OversightInput {
  projectId: string;
  previousSummary: string | null;
  sessions: OversightSessionDigest[];
}

export type Summarize = (input: OversightInput) => Promise<string>;

/** What the team_update tool (and any read of the stored summary) should
 *  say. Exact strings are spec §6 locked. */
export function oversightToolText(
  enabled: boolean,
  latest: OversightSummary | null,
): string {
  if (!enabled) return "team oversight is disabled";
  return latest?.text ?? "no team summary yet";
}

interface ProjectOversight {
  enabled: boolean;
  latest: OversightSummary | null;
  seq: number;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  pending: boolean;
}

/** Per-project oversight state machine (spec §3): activity-driven debounce,
 *  single in-flight refresh with coalescing, failure keeps the previous
 *  summary. Not a session — one stateless summarize call per refresh. */
export class Overseer {
  private states = new Map<string, ProjectOversight>();

  constructor(
    private summarize: Summarize,
    private digestsFor: (projectId: string) => OversightSessionDigest[],
    private onUpdate: (projectId: string) => void,
    private debounceMs = 30_000,
  ) {}

  private state(projectId: string): ProjectOversight {
    let s = this.states.get(projectId);
    if (!s) {
      s = { enabled: false, latest: null, seq: 0, timer: null, inFlight: false, pending: false };
      this.states.set(projectId, s);
    }
    return s;
  }

  isEnabled(projectId: string): boolean {
    return this.states.get(projectId)?.enabled ?? false;
  }

  latest(projectId: string): OversightSummary | null {
    return this.states.get(projectId)?.latest ?? null;
  }

  setEnabled(projectId: string, enabled: boolean): void {
    const s = this.state(projectId);
    if (s.enabled === enabled) return;
    s.enabled = enabled;
    if (!enabled && s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    this.onUpdate(projectId); // broadcast the toggle itself
    if (enabled) void this.refresh(projectId);
  }

  /** Schedule-once debounce (same shape as server.ts schedulePush): a queued
   *  refresh absorbs further notifies, so steady activity still summarizes
   *  every debounceMs instead of being postponed forever. */
  notify(projectId: string): void {
    const s = this.states.get(projectId);
    if (!s?.enabled) return;
    if (s.inFlight) {
      s.pending = true;
      return;
    }
    if (s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      void this.refresh(projectId);
    }, this.debounceMs);
  }

  private async refresh(projectId: string): Promise<void> {
    const s = this.state(projectId);
    if (s.inFlight) {
      s.pending = true;
      return;
    }
    s.inFlight = true;
    try {
      const text = await this.summarize({
        projectId,
        previousSummary: s.latest?.text ?? null,
        sessions: this.digestsFor(projectId),
      });
      if (s.enabled) {
        s.seq += 1;
        s.latest = { text, ts: new Date().toISOString(), seq: s.seq };
        this.onUpdate(projectId);
      }
    } catch (err) {
      // Keep the previous summary; the next activity retries naturally.
      console.error(
        `oversight refresh failed for ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      s.inFlight = false;
      if (s.pending) {
        s.pending = false;
        this.notify(projectId);
      }
    }
  }

  dispose(): void {
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
  }
}

/** Production summarizer: one stateless haiku call, no tools (spec §3).
 *  Throws on SDK error results — Overseer.refresh handles it. */
export const runOversightSummarize: Summarize = async (input) => {
  const lines = input.sessions.map(
    (s) =>
      `- ${s.id}${s.ended ? " (ended)" : ""}: intent=${s.intent ?? "none"}; driver=${s.driverName ?? "none"}; people=[${s.participants.join(", ")}]; prompts=${s.promptCount}; pendingGates=${s.pendingGates}; errors=${s.errorCount}; recentTools=[${s.recentToolCalls.map((c) => `${c.toolName}(${c.target})`).join(", ")}]`,
  );
  const prompt = [
    `Summarize what the team is doing in project "${input.projectId}".`,
    `Output: a 2-3 sentence narrative of overall team activity, then one line per active session in the form "<session-id>: <what's happening>". Under 150 words total. No preamble, no markdown headers.`,
    input.previousSummary ? `Previous summary (for continuity):\n${input.previousSummary}` : "",
    `Current structured activity digests (metadata only, no transcript content):\n${lines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const stream = query({
    prompt,
    options: {
      model: MODELS.haiku.id,
      systemPrompt:
        "You are the oversight summarizer for a multiplayer AI dev server. Output only the summary text.",
      tools: [],
      maxTurns: 1,
      strictMcpConfig: true,
      settingSources: [],
    },
  });
  for await (const message of stream as AsyncIterable<{
    type: string;
    subtype?: string;
    result?: string;
  }>) {
    if (message.type === "result") {
      if (message.subtype === "success" && typeof message.result === "string") {
        return message.result;
      }
      throw new Error(`summarize failed: ${message.subtype ?? "unknown"}`);
    }
  }
  throw new Error("summarize stream ended without a result");
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/overseer.test.ts && npx tsc --noEmit`
Expected: PASS (11 tests), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 177 passing (166 + 11).

```bash
git add poc/server/src/overseer.ts poc/server/test/overseer.test.ts
git commit -m "feat(server): Overseer — debounced, opt-in team summarizer with haiku one-shot backend"
```

---

### Task 3: server wire — oversight snapshot field, set_oversight, pull_oversight, prompt injection

**Files:**
- Modify: `poc/server/src/events.ts:42` (add `oversight_pull` to the union after `task_stop`)
- Modify: `poc/server/src/project.ts` (`ProjectSessionEntry` gains `pendingOversight`; `ProjectMessage`/`projectSnapshot` gain `oversight`)
- Modify: `poc/server/src/server.ts` (overseer construction, `snapshotFor`, peek fallback literal, notify hooks, `set_oversight` + `pull_oversight` handlers, prompt injection, close())
- Test: `poc/server/test/server.test.ts` (new describe at end)

**Interfaces:**
- Consumes: Task 1 `oversightSessionDigest`; Task 2 `Overseer`, `runOversightSummarize`, `OversightSummary`, `Summarize`.
- Produces (Tasks 4–6 rely on these): `startServer` opts gain `summarize?: Summarize; oversightDebounceMs?: number`; `project` message gains `oversight: { enabled: boolean; latest: OversightSummary | null }`; wire commands `set_oversight { projectId, enabled }` and `pull_oversight {}`; session event `{ type: "oversight_pull"; userId: string; summarySeq: number }`; `<oversight>` block injected into exactly the next prompt after a pull.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/server.test.ts` (reuse the file's existing `echoRun`, `connect`, `collect`, `wait`, `close` helpers; add a `RunQuery` fake that records prompt texts):

```ts
describe("oversight wire", () => {
  const instantSummarize = async () => "team is busy";

  it("snapshots carry oversight, defaulting to disabled", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(50);
    const snap = seen.find((m) => m.type === "project");
    expect(snap.oversight).toEqual({ enabled: false, latest: null });
    // peek fallback for an unknown project also carries the field
    ws.send(JSON.stringify({ type: "peek", projectId: "nosuch" }));
    await wait(50);
    const peeked = seen.filter((m) => m.type === "project").at(-1);
    expect(peeked.oversight).toEqual({ enabled: false, latest: null });
    ws.close();
  });

  it("validates set_oversight and rejects unknown projects", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "BAD SLUG", enabled: true }));
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: "yes" }));
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "ghost", enabled: true }));
    await wait(50);
    const errors = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toContain("set_oversight requires a valid projectId");
    expect(errors).toContain("set_oversight requires enabled: true|false");
    expect(errors).toContain("unknown project: ghost");
    ws.close();
  });

  it("enabling pushes the toggle and then the first summary to watchers", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(80);
    const snaps = seen.filter((m) => m.type === "project");
    expect(snaps.at(-1).oversight.enabled).toBe(true);
    expect(snaps.at(-1).oversight.latest).toMatchObject({ text: "team is busy", seq: 1 });
    ws.close();
  });

  it("session activity triggers a debounced refresh", async () => {
    let calls = 0;
    const counting = async () => `summary ${++calls}`;
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: counting, oversightDebounceMs: 30 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(50); // initial refresh (call 1)
    ws.send(JSON.stringify({ type: "prompt", text: "do the thing" }));
    await wait(150); // debounce 30ms then refresh (call 2)
    expect(calls).toBeGreaterThanOrEqual(2);
    const snaps = seen.filter((m) => m.type === "project");
    expect(snaps.at(-1).oversight.latest.seq).toBeGreaterThanOrEqual(2);
    ws.close();
  });

  it("pull_oversight is driver-only", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u2", name: "Ben" }));
    await wait(30);
    ws2.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(50);
    expect(seen2.map((m) => m.message)).toContain(
      "only the current driver can pull team updates — take the wheel first",
    );
    ws1.close();
    ws2.close();
  });

  it("pull_oversight errors while disabled and before the first summary", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = async () => {
      await gate;
      return "late summary";
    };
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: held, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(30);
    expect(seen.map((m) => m.message)).toContain("team oversight is disabled");
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(20); // refresh started but held open — no summary yet
    ws.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(30);
    expect(seen.map((m) => m.message)).toContain("no team summary yet");
    release();
    ws.close();
  });

  it("a pull appends the attributed event and injects <oversight> into exactly the next prompt", async () => {
    const promptTexts: string[] = [];
    const recordingRun: RunQuery = async function* (prompts) {
      for await (const p of prompts) {
        promptTexts.push(p.message.content[0].text);
        yield { type: "assistant", content: [{ type: "text", text: "ok" }] };
      }
    };
    const server = await startServer({ port: 0, runQuery: recordingRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(60);
    ws.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(50);
    const pull = seen.find((m) => m.event?.type === "oversight_pull")?.event;
    expect(pull).toMatchObject({ userId: "u1", summarySeq: 1 });
    ws.send(JSON.stringify({ type: "prompt", text: "first after pull" }));
    await wait(100);
    ws.send(JSON.stringify({ type: "prompt", text: "second prompt" }));
    await wait(100);
    expect(promptTexts[0]).toContain("<oversight>\nteam is busy\n</oversight>");
    expect(promptTexts[0]).toContain("first after pull");
    expect(promptTexts[1]).not.toContain("<oversight>");
    ws.close();
  });

  it("disabling clears the summary display state but keeps history honest", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(60);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: false }));
    await wait(50);
    const last = seen.filter((m) => m.type === "project").at(-1);
    expect(last.oversight.enabled).toBe(false);
    // latest retained (stale-by-timestamp per spec §2), not wiped
    expect(last.oversight.latest).toMatchObject({ text: "team is busy" });
    ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: FAIL — `summarize` not a known opt (type error) / `oversight` undefined on snapshots / unknown message type errors.

- [ ] **Step 3: Implement**

1. `poc/server/src/events.ts` — add to the `SessionEvent` union after the `task_stop` member:

```ts
  | { type: "oversight_pull"; userId: string; summarySeq: number };
```

(The `task_stop` line loses its terminating `;`, which moves to this new last member.)

2. `poc/server/src/project.ts`:

- `ProjectSessionEntry` gains a field (after `pendingSuggests`):

```ts
  /** One-shot flag: the driver pulled the team summary; inject <oversight>
   *  into the next prompt only (spec §5). */
  pendingOversight: boolean;
```

- Import the summary type and extend `ProjectMessage` (after `repo`):

```ts
import type { OversightSummary } from "./overseer.js";
```

```ts
  oversight: { enabled: boolean; latest: OversightSummary | null };
```

- `projectSnapshot` gains a 4th optional param and passes it through:

```ts
export function projectSnapshot(
  project: Project,
  pluginState?: { plugins: PluginInfo[]; enabled: boolean },
  repo?: { defaultBranch: string } | null,
  oversight?: { enabled: boolean; latest: OversightSummary | null },
): ProjectMessage {
```

and in the returned object, after `repo: repo ?? null,`:

```ts
    oversight: oversight ?? { enabled: false, latest: null },
```

3. `poc/server/src/server.ts`:

- Imports:

```ts
import { buildTeammateDigest, oversightSessionDigest, summarizeSession } from "./digest.js";
import { Overseer, runOversightSummarize, type Summarize } from "./overseer.js";
```

(Do NOT import `oversightToolText` yet — it's consumed only in Task 4, and an unused import fails the typecheck; Task 4 adds it to this import line.)

- `startServer` opts gain:

```ts
  summarize?: Summarize;
  oversightDebounceMs?: number;
```

- After the `projects` map declarations (below `const pushTimers = ...`), construct the overseer:

```ts
  const overseer = new Overseer(
    opts.summarize ?? runOversightSummarize,
    (projectId) => {
      const project = projects.get(projectId);
      if (!project) return [];
      return [...project.sessions.entries()].map(([id, entry]) => {
        const participants = entry.session.participantList;
        const driverId = entry.session.driverId;
        return oversightSessionDigest(
          id,
          entry.session.eventsFrom(0),
          entry.driver.isDead,
          participants.find((p) => p.userId === driverId)?.name ?? null,
          participants.map((p) => p.name),
        );
      });
    },
    (projectId) => {
      const project = projects.get(projectId);
      if (project) pushProject(project); // deliberate action / fresh summary — immediate push
    },
    opts.oversightDebounceMs,
  );
```

- `snapshotFor` passes the overseer state:

```ts
  function snapshotFor(project: Project) {
    return projectSnapshot(
      project,
      { plugins: pluginStore.list(project.id), enabled: pluginStore.enabled },
      repo && { defaultBranch: repo.defaultBranch },
      { enabled: overseer.isEnabled(project.id), latest: overseer.latest(project.id) },
    );
  }
```

- The `peek` no-project fallback literal gains `oversight: { enabled: false, latest: null },` (after `pluginsEnabled`).

- Overseer notify hooks. Add near `INTERESTING`:

```ts
const OVERSEER_EVENTS = new Set([
  "user_message",
  "permission_request",
  "agent_error",
  "intent_update",
]);
```

In `getOrCreateSession`, extend the existing subscription and notify on creation:

```ts
      session.subscribe((event) => {
        if (INTERESTING.has(event.type)) schedulePush(project);
        if (OVERSEER_EVENTS.has(event.type)) overseer.notify(project.id);
      });
      overseer.notify(project.id); // session created (spec §3 lifecycle)
```

Also set `pendingOversight: false` in the `newEntry` literal (after `pendingSuggests: new Map(),`).

- `set_oversight` handler — insert after the `watch_project` handler, before `create_session` (pre-join command):

```ts
      if (msg.type === "set_oversight") {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) {
          return sendError("set_oversight requires a valid projectId");
        }
        if (typeof msg.enabled !== "boolean") {
          return sendError("set_oversight requires enabled: true|false");
        }
        if (!projects.has(projectId)) {
          return sendError(`unknown project: ${projectId}`);
        }
        // Anyone may toggle (spec §2) — team infrastructure, not a driver capability.
        overseer.setEnabled(projectId, msg.enabled);
        return;
      }
```

- `pull_oversight` handler — insert after the `stop_task` handler (post-join command):

```ts
      if (msg.type === "pull_oversight") {
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can pull team updates — take the wheel first");
        }
        if (!overseer.isEnabled(ctx.project.id)) {
          return sendError("team oversight is disabled");
        }
        const latest = overseer.latest(ctx.project.id);
        if (!latest) return sendError("no team summary yet");
        ctx.entry.pendingOversight = true;
        ctx.entry.session.append({
          type: "oversight_pull",
          userId: ctx.userId,
          summarySeq: latest.seq,
        });
        return;
      }
```

- Prompt injection: in the `prompt` handler, replace

```ts
        const digest = digestFor(ctx.project, ctx.entry.session.id);
        ctx.entry.driver.sendPrompt(
          ctx.userId,
          msg.text,
          digest || undefined,
        );
```

with:

```ts
        const digest = digestFor(ctx.project, ctx.entry.session.id);
        let contextBlock = digest || undefined;
        if (ctx.entry.pendingOversight) {
          // One-shot (spec §5): consumed by this prompt whether or not a
          // summary still exists.
          ctx.entry.pendingOversight = false;
          const latest = overseer.latest(ctx.project.id);
          if (latest) {
            const block = `<oversight>\n${latest.text}\n</oversight>`;
            contextBlock = contextBlock ? `${contextBlock}\n\n${block}` : block;
          }
        }
        ctx.entry.driver.sendPrompt(ctx.userId, msg.text, contextBlock);
```

- `close()`: add `overseer.dispose();` as the first line inside the returned close promise executor (beside the pushTimers cleanup).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/server.test.ts && npx tsc --noEmit`
Expected: PASS (oversight wire: 8 tests; whole file green), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 185 passing (177 + 8).

```bash
git add poc/server/src/events.ts poc/server/src/project.ts poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat(server): oversight wire — snapshot field, set_oversight/pull_oversight, one-shot prompt injection"
```

---

### Task 4: team_update tool on the awareness MCP server

**Files:**
- Modify: `poc/server/src/agentDriver.ts` (DriverHooks, awareness tools array, constructor param, hooks wiring)
- Modify: `poc/server/src/server.ts` (pass `getOversight` when constructing `AgentDriver`)
- Test: `poc/server/test/agentDriver.test.ts` (one new test)

**Interfaces:**
- Consumes: Task 2 `oversightToolText`, Task 3 overseer instance in server scope.
- Produces: `DriverHooks.getOversight?: () => string`; `AgentDriver` constructor gains a 7th param `getOversight?: () => string`; awareness MCP tool `team_update` (NOT in `allowedTools` — rides the permission gate).

- [ ] **Step 1: Write the failing test**

In `poc/server/test/agentDriver.test.ts`, find the existing test that constructs an `AgentDriver` with a fake `RunQuery` capturing hooks (the `fakeRun` helper receives `(prompts, hooks)`), and append this test to the same describe block, adapting the fake-run capture idiom the file already uses:

```ts
  it("passes getOversight through to the run hooks", async () => {
    let captured: import("../src/agentDriver.js").DriverHooks | undefined;
    const capturingRun: RunQuery = (prompts, hooks) => {
      captured = hooks;
      return (async function* () {})() as ReturnType<RunQuery>;
    };
    const session = new Session("s1");
    new AgentDriver(session, capturingRun, undefined, [], undefined, undefined, () => "the summary");
    expect(captured?.getOversight?.()).toBe("the summary");
  });
```

(If the file's fake-run return shape differs — e.g. it wraps the generator with extra methods — copy the file's existing fake construction exactly; the only new thing under test is the hook passthrough.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts`
Expected: FAIL — constructor takes 6 params / `getOversight` not on `DriverHooks`.

- [ ] **Step 3: Implement**

1. `poc/server/src/agentDriver.ts` — `DriverHooks` gains (after `pluginPaths`):

```ts
  /** Latest team oversight summary text, or the spec §6 fallback strings.
   *  Absent on drivers constructed without oversight wiring. */
  getOversight?: () => string;
```

2. `runAgentQuery` — add a second tool to the awareness server's `tools` array, after `set_intent`:

```ts
      tool(
        "team_update",
        "Get the latest team oversight summary: what other sessions in this project are working on right now. Only call this when the driver asks you to bring in team context.",
        {},
        async () => {
          const text = hooks.getOversight?.() ?? "team oversight is disabled";
          return { content: [{ type: "text", text }] };
        },
      ),
```

Do NOT add `mcp__awareness__team_update` to `allowedTools` — it must route through `canUseTool` (driver approval gate) per spec §5.

3. `AgentDriver` constructor — add a 7th parameter after `progressThrottleMs`:

```ts
    getOversight?: () => string,
```

and in the hooks object literal passed to `run(this.prompts, { ... })`, add alongside `pluginPaths`:

```ts
      getOversight,
```

4. `poc/server/src/server.ts` — in `getOrCreateSession`, the `new AgentDriver(...)` call gains two trailing args (explicit `undefined` for the throttle default, then the closure):

```ts
        driver: new AgentDriver(
          session,
          runQuery,
          workdir,
          pluginStore.paths(project.id),
          (liveSkills) => {
            newEntry.skills = liveSkills;
            schedulePush(project);
          },
          undefined,
          () => oversightToolText(overseer.isEnabled(project.id), overseer.latest(project.id)),
        ),
```

Also add `oversightToolText` to the existing `./overseer.js` import in `server.ts` (Task 3 deliberately left it out to keep its typecheck clean).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/agentDriver.test.ts && npx tsc --noEmit`
Expected: PASS (+1 test), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 186 passing (185 + 1).

Note for the reviewer: the `team_update` tool handler itself executes only inside the real SDK (`runAgentQuery`), same as `set_intent` — its string selection is covered by the `oversightToolText` unit tests (Task 2) and the hook-passthrough test above; the live tool call is demo-judged (recorded testing stance).

```bash
git add poc/server/src/agentDriver.ts poc/server/src/server.ts poc/server/test/agentDriver.test.ts
git commit -m "feat(server): team_update awareness tool — gated agent pull of the oversight summary"
```

---

### Task 5: client data layer — OversightState, socket carry, pure view helpers

**Files:**
- Modify: `poc/client/src/types.ts` (add `OversightState`, `summarySeq` on `LoggedEvent`)
- Modify: `poc/client/src/useSessionSocket.ts` (carry `oversight` from project messages)
- Create: `poc/client/src/oversightView.ts`
- Test: `poc/client/src/oversightView.test.ts` (new file)

**Interfaces:**
- Consumes: `project` message `oversight` field (Task 3 shape).
- Produces (Task 6 relies on these):

```ts
// types.ts
export type OversightState = {
  enabled: boolean;
  latest: { text: string; ts: string; seq: number } | null;
};
// useSessionSocket return gains: oversight: OversightState
// oversightView.ts
export function oversightFresh(oversight: OversightState, seenSeq: number): boolean;
export function updatedAtLabel(ts: string | null): string;
```

- [ ] **Step 1: Write the failing tests**

Create `poc/client/src/oversightView.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { oversightFresh, updatedAtLabel } from "./oversightView";
import type { OversightState } from "./types";

const withLatest = (seq: number): OversightState => ({
  enabled: true,
  latest: { text: "t", ts: "2026-07-26T12:00:00Z", seq },
});

describe("oversightFresh", () => {
  it("is fresh only when enabled with an unseen seq", () => {
    expect(oversightFresh(withLatest(3), 2)).toBe(true);
    expect(oversightFresh(withLatest(3), 3)).toBe(false);
  });

  it("is never fresh when disabled or empty", () => {
    expect(oversightFresh({ enabled: false, latest: { text: "t", ts: "x", seq: 9 } }, 0)).toBe(false);
    expect(oversightFresh({ enabled: true, latest: null }, 0)).toBe(false);
  });
});

describe("updatedAtLabel", () => {
  it("labels a valid timestamp", () => {
    expect(updatedAtLabel("2026-07-26T12:00:00Z")).toMatch(/^updated /);
  });

  it("falls back for null or garbage", () => {
    expect(updatedAtLabel(null)).toBe("no summary yet");
    expect(updatedAtLabel("not-a-date")).toBe("no summary yet");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npx vitest run src/oversightView.test.ts`
Expected: FAIL — `./oversightView` unresolvable.

- [ ] **Step 3: Implement**

1. `poc/client/src/types.ts` — add `summarySeq?: number;` to `LoggedEvent` (after `lastTool`), and append after `RepoInfo`:

```ts
export type OversightState = {
  enabled: boolean;
  latest: { text: string; ts: string; seq: number } | null;
};
```

2. Create `poc/client/src/oversightView.ts`:

```ts
import type { OversightState } from "./types";

/** Pure helpers for the OVERSIGHT screen (no component-test infra — recorded
 *  pattern). */

export function oversightFresh(oversight: OversightState, seenSeq: number): boolean {
  return oversight.enabled && oversight.latest !== null && oversight.latest.seq > seenSeq;
}

export function updatedAtLabel(ts: string | null): string {
  if (!ts) return "no summary yet";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "no summary yet";
  return `updated ${d.toLocaleTimeString()}`;
}
```

3. `poc/client/src/useSessionSocket.ts`:

- Import the type: add `OversightState` to the type-only import from `./types`.
- Add to the hook's return type object: `oversight: OversightState;`
- Add state below `pluginsEnabled`:

```ts
  const [oversight, setOversight] = useState<OversightState>({ enabled: false, latest: null });
```

- In the `msg.type === "project"` branch, after `setPluginsEnabled(...)`:

```ts
          setOversight(msg.oversight ?? { enabled: false, latest: null });
```

- Add `oversight` to the returned object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/client && npx vitest run src/oversightView.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full client suite and commit**

Run: `cd poc/client && npm test && npm run build`
Expected: 76 passing (72 + 4), build clean.

```bash
git add poc/client/src/types.ts poc/client/src/useSessionSocket.ts poc/client/src/oversightView.ts poc/client/src/oversightView.test.ts
git commit -m "feat(client): oversight state carry + pure view helpers"
```

---

### Task 6: OVERSIGHT screen — panel, App wiring, header badge, transcript line, CSS

**Files:**
- Create: `poc/client/src/components/OversightPanel.tsx`
- Modify: `poc/client/src/App.tsx` (hotkey effect, screen branch, seen-seq state, Header props)
- Modify: `poc/client/src/components/Header.tsx` (props + OVERSIGHT button after WORKFLOWS)
- Modify: `poc/client/src/components/Transcript.tsx` (`oversight_pull` case after `plugin_change`)
- Modify: `poc/client/src/terminal.css` (append rules at end)
- Test: none new (no component-test infra — recorded pattern; logic underneath is Task 5's tested module). Verification = clean build + suite green.

**Interfaces:**
- Consumes: `OversightState`, `oversightFresh`, `updatedAtLabel` (Task 5); `send` for `set_oversight` / `pull_oversight` (Task 3); the file's existing `screen`/`onScreenChange` plumbing and `isDriver`.
- Produces: `<OversightPanel />`; screen key `"oversight"`; hotkey `O`.

- [ ] **Step 1: Create `poc/client/src/components/OversightPanel.tsx`**

```tsx
import type { OversightState } from "../types";
import { updatedAtLabel } from "../oversightView";

/** Server-wide team summary screen (spec §4). Read-only view of the overseer's
 *  latest summary; toggle is open to everyone, PULL is driver-only. */
export function OversightPanel(props: {
  oversight: OversightState;
  isDriver: boolean;
  onToggle: (enabled: boolean) => void;
  onPull: () => void;
  onBack: () => void;
}) {
  const { oversight } = props;
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={props.onBack}>◂ BACK</button>
        <span className="pix lg">OVERSIGHT</span>
        <span className="rule" />
        <span className={`pix ovstate ${oversight.enabled ? "on" : ""}`}>
          {oversight.enabled ? "● WATCHING" : "○ OFF"}
        </span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          <div className="ovhead">
            <span className="line dim">{updatedAtLabel(oversight.latest?.ts ?? null)}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => props.onToggle(!oversight.enabled)}>
              {oversight.enabled ? "DISABLE" : "ENABLE"}
            </button>
            {oversight.enabled && (
              <button
                className="btn"
                disabled={!props.isDriver || !oversight.latest}
                title={
                  !props.isDriver
                    ? "only the driver can pull team updates — take the wheel first"
                    : !oversight.latest
                      ? "no team summary yet"
                      : "inject the latest team summary into this agent's next turn"
                }
                onClick={props.onPull}
              >
                PULL INTO SESSION ▸
              </button>
            )}
          </div>
          {oversight.latest ? (
            <div className="ovtext">{oversight.latest.text}</div>
          ) : (
            <div className="line dim">
              {oversight.enabled
                ? "watching — the first summary lands after the next team activity."
                : "enable oversight for a rolling summary of what the whole team is doing."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire App.tsx**

1. Imports: `import { OversightPanel } from "./components/OversightPanel";` and `import { oversightFresh } from "./oversightView";`
2. Destructure `oversight` from the `useSessionSocket(...)` result (alongside `plugins, pluginsEnabled`).
3. Add seen-seq state + effect near the other `useState` calls in `SessionView`:

```tsx
  const [seenOversightSeq, setSeenOversightSeq] = useState(0);
  useEffect(() => {
    if (props.screen === "oversight" && oversight.latest) {
      setSeenOversightSeq(oversight.latest.seq);
    }
  }, [props.screen, oversight.latest]);
```

4. Extend the S/W hotkey effect (the one at App.tsx:170-189): add an `O` branch and include `"oversight"` in the Esc check:

```tsx
      if ((e.key === "o" || e.key === "O") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "oversight" ? null : "oversight");
      }
      if (e.key === "Escape" && (props.screen === "skills" || props.screen === "workflows" || props.screen === "oversight")) {
        props.onScreenChange(null);
      }
```

(Replace the existing Esc `if` rather than adding a second one.)

5. Add the screen branch after the `workflows` branch, before `status`:

```tsx
  if (props.screen === "oversight") {
    return (
      <OversightPanel
        oversight={oversight}
        isDriver={isDriver}
        onToggle={(enabled) => send({ type: "set_oversight", projectId, enabled })}
        onPull={() => send({ type: "pull_oversight" })}
        onBack={() => props.onScreenChange(null)}
      />
    );
  }
```

6. Header call site gains:

```tsx
        onOpenOversight={() => props.onScreenChange("oversight")}
        oversightFresh={oversightFresh(oversight, seenOversightSeq)}
```

- [ ] **Step 3: Header button**

`poc/client/src/components/Header.tsx` — props gain `onOpenOversight: () => void; oversightFresh: boolean;` and after the WORKFLOWS button add:

```tsx
        <button
          className={props.oversightFresh ? "planmode on" : "planmode"}
          onClick={props.onOpenOversight}
          title="team oversight (O)"
        >
          {props.oversightFresh ? "▸ OVERSIGHT ●" : "▢ OVERSIGHT"}
        </button>
```

- [ ] **Step 4: Transcript line**

`poc/client/src/components/Transcript.tsx` — add a case after `plugin_change`:

```tsx
      case "oversight_pull":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} pulled team update #{ev.summarySeq} into the session
          </div>
        );
```

- [ ] **Step 5: CSS**

Append to `poc/client/src/terminal.css`:

```css
/* ================================================================ oversight
   Team summary screen. Same idiom as the workflows screen. */
.ovstate.on { color: var(--green); }
.ovhead { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.ovhead .spacer { flex: 1; }
.ovtext { margin-top: var(--sp-2); white-space: pre-wrap; overflow-wrap: anywhere; }
```

(If `.spacer` already has a global `flex: 1` rule in this file, drop the `.ovhead .spacer` line — match the file's idiom.)

- [ ] **Step 6: Verify build + suite, then commit**

Run: `cd poc/client && npm run build && npm test`
Expected: build clean, 76 passing (no count change).

```bash
git add poc/client/src/components/OversightPanel.tsx poc/client/src/App.tsx poc/client/src/components/Header.tsx poc/client/src/components/Transcript.tsx poc/client/src/terminal.css
git commit -m "feat(client): OVERSIGHT screen — team summary, toggle, driver-only pull, header fresh-dot"
```

---

### Task 7: final verification sweep

**Files:** none created; read-only against the spec + full runs.

- [ ] **Step 1: Full suites + builds**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: **186 passing** (161 baseline + 5 digest + 11 overseer + 8 wire + 1 driver), tsc clean. If the count differs, find out why and record the arithmetic in Deviations.

Run: `cd poc/client && npm test && npm run build`
Expected: **76 passing** (72 + 4), build clean.

- [ ] **Step 2: Spec re-read**

Re-read `docs/superpowers/specs/2026-07-26-oversight-agent-design.md` §2–§8 against `git diff main --stat` and the shipped code. Every locked requirement (digests-only input with no transcript prose; off-by-default + zero cost while disabled; debounce/coalesce/failure semantics; snapshot-shaped `oversight` field with immediate pushes; anyone-toggles / driver-only pull with attributed `oversight_pull { userId, summarySeq }`; one-shot `<oversight>` injection; gated `team_update` tool with exact fallback strings; OVERSIGHT screen with hotkey O, fresh-dot, disabled/dimmed states; exact §6 error strings; out-of-scope items still out) maps to shipped code with file:line, or gets a recorded deviation below.

- [ ] **Step 3: Commit any fixes and stop**

Stop for the user's demo checkpoint: `mpai` (or the dev stack) with two sessions active → open OVERSIGHT (O) → ENABLE → prompt in one session → summary appears after the debounce and the header dot lights in the other session → PULL INTO SESSION as driver → next prompt shows the agent using team context → non-driver sees PULL dimmed → ask the agent to call `team_update` → gate fires. Do not merge; PR on user go.

---

## Deviations (recorded during execution)

**Task 2:** plan's dispose() listing had a re-arm race (in-flight refresh with pending follow-up could schedule a timer and call onUpdate after dispose) — fixed with a disposed flag guarding notify/refresh and the post-await write-back; +1 test = 178 server baseline entering Task 3.

**Task 7:** final server count is **187**, not the plan's expected 186 — the Task 2 fix round added one test (dispose re-arm race regression test) after the 186 arithmetic was written. Full arithmetic: 161 baseline + 5 digest (T1) + 11 overseer + 1 fix-round (T2) + 8 wire (T3) + 1 driver (T4) = 187. Client 76 as planned (72 + 4). Both builds and tsc clean.
