import { describe, it, expect } from "vitest";
import { deriveState, deriveTranscriptGroups, deriveSubSessions, subSessionEvents } from "./derive";
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

  it("keeps agentBusy true through a contained mid-turn agent_error (tool_call/agent_text_delta re-raise it), clearing only on turn_end", () => {
    const base = [
      ev({ type: "user_message", userId: "u1", text: "go" }, 0),
      ev({ type: "agent_error", message: "transient hiccup" }, 1),
      ev({ type: "tool_call", toolName: "Read", input: {} }, 2),
    ];
    expect(deriveState(base).agentBusy).toBe(true);
    expect(
      deriveState([...base, ev({ type: "turn_end" }, 3)]).agentBusy,
    ).toBe(false);
  });

  it("tracks auto permission mode and auto-marked decisions", () => {
    const s = deriveState([
      ev({ type: "permission_mode_change", mode: "auto", userId: "u1" }, 0),
      ev({ type: "permission_request", requestId: "r9", toolName: "Bash", input: {} }, 1),
      ev({ type: "permission_decision", requestId: "r9", decision: "allow", userId: "u1", auto: true }, 2),
    ]);
    expect(s.permissionMode).toBe("auto");
    expect(s.permissionDecisions.get("r9")).toEqual({ decision: "allow", userId: "u1", auto: true });
  });
});

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

  it("filters (removed) junk entries out of the skill roster", () => {
    const s = deriveState([
      ev({ type: "skill_roster", skills: [
        { name: "review", description: "review a PR" },
        { name: "agents", description: "(removed)…" },
      ] }, 0),
    ]);
    expect(s.skills).toEqual([{ name: "review", description: "review a PR" }]);
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

  it("splits consecutive runs into main and labeled subagent groups when the spawning call is named Agent (live SDK)", () => {
    const agentEvents = [
      ev({ type: "user_message", userId: "u1", text: "audit" }, 0),
      ev({ type: "tool_call", toolName: "Agent", input: { description: "audit deps" }, toolUseId: "task-1" }, 1),
      ev({ type: "agent_text_delta", text: "scanning", parentToolUseId: "task-1" }, 2),
      ev({ type: "tool_call", toolName: "Read", input: {}, toolUseId: "t-sub", parentToolUseId: "task-1" }, 3),
      ev({ type: "agent_text_delta", text: "meanwhile, main agent" }, 4),
      ev({ type: "tool_result", toolName: "Read", output: "ok", toolUseId: "t-sub", parentToolUseId: "task-1" }, 5),
      ev({ type: "tool_result", toolName: "Agent", output: "audit done", toolUseId: "task-1" }, 6),
    ];
    const groups = deriveTranscriptGroups(agentEvents);
    expect(groups.map((g) => g.kind)).toEqual(["main", "subagent", "main", "subagent", "main"]);
    const sub = groups[1] as Extract<ReturnType<typeof deriveTranscriptGroups>[number], { kind: "subagent" }>;
    expect(sub.parentId).toBe("task-1");
    expect(sub.label).toBe("audit deps");
    expect(sub.status).toBe("done"); // parent Agent tool_result exists in the log
    expect(sub.events.map((e) => e.seq)).toEqual([2, 3]);
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

  it("T3xT1-attributed gate stays inline in MAIN — never swept into the subagent group (spec §2.3)", () => {
    // A Task-1 × Task-3 interaction: Task 1 stamps parentToolUseId onto the
    // gate events. They must NOT be swept into the collapsed subagent group
    // (which renders bodiless in MAIN) — they stay ungrouped/inline so the
    // driver still sees the gate card. Streaming events still group as before.
    const log = [
      ev({ type: "tool_call", toolName: "Agent", input: { description: "scan" }, toolUseId: "A" }, 0),
      ev({ type: "agent_text_delta", text: "streaming", parentToolUseId: "A" }, 1),
      ev({ type: "permission_request", requestId: "rg", toolName: "Bash", input: {}, parentToolUseId: "A" }, 2),
      ev({ type: "permission_decision", requestId: "rg", decision: "allow", userId: "u1", parentToolUseId: "A" }, 3),
    ];
    const groups = deriveTranscriptGroups(log);
    const subSeqs = groups
      .filter((g) => g.kind === "subagent")
      .flatMap((g) => g.events.map((e) => e.seq));
    // streaming delta still groups…
    expect(subSeqs).toContain(1);
    // …but neither gate event is swept into any subagent group
    expect(subSeqs).not.toContain(2);
    expect(subSeqs).not.toContain(3);
    // the gate events remain inline (in a main group)
    const mainSeqs = groups
      .filter((g) => g.kind === "main")
      .flatMap((g) => g.events.map((e) => e.seq));
    expect(mainSeqs).toContain(2);
    expect(mainSeqs).toContain(3);
    // regression guard on the UNCHANGED filter: the attributed gate events are
    // still projected into the sub-session view.
    expect(subSessionEvents(log, "A").map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

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

describe("deriveSubSessions", () => {
  it("T2-discovery + order: two top-level Task/Agent calls list in spawn order", () => {
    const subs = deriveSubSessions([
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "tool_call", toolName: "Agent", toolUseId: "B", input: {} }, 1),
    ]);
    expect(subs.map((s) => s.key)).toEqual(["A", "B"]);
  });

  it("T2-label precedence: input.description wins, else joined subagentType, else key", () => {
    const subs = deriveSubSessions([
      // description present
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: { description: "scan tests" } }, 0),
      // description absent -> subagentType from joined task_event started
      ev({ type: "tool_call", toolName: "Agent", toolUseId: "B", input: {} }, 1),
      ev({ type: "task_event", subtype: "started", toolUseId: "B", taskId: "t2", subagentType: "security-auditor" }, 2),
      // both absent -> key itself
      ev({ type: "tool_call", toolName: "Task", toolUseId: "C", input: {} }, 3),
    ]);
    const byKey = new Map(subs.map((s) => [s.key, s.label]));
    expect(byKey.get("A")).toBe("scan tests");
    expect(byKey.get("B")).toBe("security-auditor");
    expect(byKey.get("C")).toBe("C");
  });

  it("T2-status: done when top-level tool_result present, else running", () => {
    const subs = deriveSubSessions([
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "tool_call", toolName: "Agent", toolUseId: "B", input: {} }, 1),
      ev({ type: "tool_result", toolUseId: "A", output: "ok" }, 2),
    ]);
    const byKey = new Map(subs.map((s) => [s.key, s.status]));
    expect(byKey.get("A")).toBe("done");
    expect(byKey.get("B")).toBe("running");
  });

  it("T2-heartbeat-only chip: parentToolUseId with no spawning call still listed, running", () => {
    const subs = deriveSubSessions([
      ev({ type: "agent_text_delta", parentToolUseId: "C", text: "..." }, 0),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ key: "C", label: "C", status: "running" });
  });

  it("T2-gatePending true: undecided permission_request attributed to key", () => {
    const subs = deriveSubSessions([
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "permission_request", requestId: "r1", parentToolUseId: "A", toolName: "Bash", input: {} }, 1),
    ]);
    expect(subs.find((s) => s.key === "A")!.gatePending).toBe(true);
  });

  it("T2-gatePending false: a matching decision exists (any decider, incl. auto)", () => {
    const subs = deriveSubSessions([
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "permission_request", requestId: "r1", parentToolUseId: "A", toolName: "Bash", input: {} }, 1),
      ev({ type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1", auto: true }, 2),
    ]);
    expect(subs.find((s) => s.key === "A")!.gatePending).toBe(false);
  });

  it("T2-task join: task_event started toolUseId A + taskId t1 sets A.taskId", () => {
    const subs = deriveSubSessions([
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "task_event", subtype: "started", toolUseId: "A", taskId: "t1" }, 1),
    ]);
    expect(subs.find((s) => s.key === "A")!.taskId).toBe("t1");
  });

  it("T2-no sub-sessions (the \"old-event fixture\"): TODAY's shapes derive to [] and leave existing derive unchanged", () => {
    // A log captured from today's event shapes: no parentToolUseId on gates,
    // no toolUseId on task_events, no subagent markers.
    const oldLog: LoggedEvent[] = [
      ev({ type: "presence_join", userId: "u1", name: "ana" }, 0),
      ev({ type: "user_message", userId: "u1", text: "go" }, 1),
      ev({ type: "tool_call", toolName: "Read", input: { file: "x" } }, 2),
      ev({ type: "permission_request", requestId: "r1", toolName: "Bash", input: {} }, 3),
      ev({ type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1" }, 4),
      ev({ type: "task_event", taskId: "T1", subtype: "started", description: "audit" }, 5),
      ev({ type: "task_event", taskId: "T1", subtype: "done", status: "completed" }, 6),
      ev({ type: "turn_end" }, 7),
    ];
    expect(deriveSubSessions(oldLog)).toEqual([]);
    // Existing derive outputs are unaffected by the new code paths.
    expect(deriveState(oldLog).tasks.get("T1")).toMatchObject({ status: "completed", description: "audit" });
    expect(deriveTranscriptGroups(oldLog).every((g) => g.kind === "main")).toBe(true);
  });
});

describe("subSessionEvents", () => {
  it("T2-projection: nested: every event with parentToolUseId === A, in log order", () => {
    const events: LoggedEvent[] = [
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "agent_text_delta", parentToolUseId: "A", text: "one" }, 1),
      ev({ type: "permission_request", requestId: "r1", parentToolUseId: "A", toolName: "Bash", input: {} }, 2),
      ev({ type: "agent_text_delta", parentToolUseId: "A", text: "two" }, 3),
    ];
    const proj = subSessionEvents(events, "A");
    expect(proj.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("T2-projection: task rows: joined taskId pulls in its task_event/task_stop rows, merged in seq order", () => {
    const events: LoggedEvent[] = [
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "task_event", subtype: "started", toolUseId: "A", taskId: "t1" }, 1),
      ev({ type: "agent_text_delta", parentToolUseId: "A", text: "one" }, 2),
      ev({ type: "task_event", taskId: "t1", subtype: "progress", tokens: 10 }, 3),
      ev({ type: "task_stop", taskId: "t1", userId: "u2" }, 4),
    ];
    const proj = subSessionEvents(events, "A");
    expect(proj.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("T2-projection: exclusion: main-agent events, other sub-sessions, and unattributed gates never included", () => {
    const events: LoggedEvent[] = [
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: {} }, 0),
      ev({ type: "task_event", subtype: "started", toolUseId: "A", taskId: "t1" }, 1),
      ev({ type: "agent_text_delta", parentToolUseId: "A", text: "mine" }, 2),
      // main-agent event
      ev({ type: "agent_text_delta", text: "main" }, 3),
      // other sub-session's event
      ev({ type: "agent_text_delta", parentToolUseId: "B", text: "other" }, 4),
      // unattributed gate
      ev({ type: "permission_request", requestId: "r9", toolName: "Bash", input: {} }, 5),
      // another sub-session's task rows
      ev({ type: "task_event", taskId: "t2", subtype: "progress" }, 6),
    ];
    const proj = subSessionEvents(events, "A");
    expect(proj.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("T2-note-1: both functions are pure filters exposing nothing not already in the log", () => {
    const events: LoggedEvent[] = [
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: { description: "d" } }, 0),
      ev({ type: "task_event", subtype: "started", toolUseId: "A", taskId: "t1" }, 1),
      ev({ type: "agent_text_delta", parentToolUseId: "A", text: "x" }, 2),
    ];
    // Every projected event is one of the input events (same reference) — a
    // filter, never a synthesized/fabricated event.
    const proj = subSessionEvents(events, "A");
    expect(proj.length).toBeGreaterThan(0);
    for (const e of proj) {
      expect(events).toContain(e);
    }
    // deriveSubSessions is a pure function of the log — same input, same output,
    // and no mutation of the input array.
    const before = [...events];
    expect(deriveSubSessions(events)).toEqual(deriveSubSessions(events));
    expect(events).toEqual(before);
  });

  it("T2-note-2: a nested sub-agent's events carry the OUTER parent's key and render flat under it", () => {
    // The SDK stamps the top-level spawning call's id, so a nested sub-agent's
    // events carry the OUTER key A (not a distinct inner key). They render flat
    // inside A's view, and no separate inner sub-session is created (§4).
    const events: LoggedEvent[] = [
      ev({ type: "tool_call", toolName: "Task", toolUseId: "A", input: { description: "outer" } }, 0),
      ev({ type: "agent_text_delta", parentToolUseId: "A", text: "outer work" }, 1),
      // a nested Agent spawn + its work, all stamped with outer key A
      ev({ type: "tool_call", toolName: "Agent", toolUseId: "INNER", parentToolUseId: "A", input: { description: "inner" } }, 2),
      ev({ type: "agent_text_delta", parentToolUseId: "A", text: "inner work" }, 3),
    ];
    // Only one sub-session (A); the inner spawn does not become its own chip.
    expect(deriveSubSessions(events).map((s) => s.key)).toEqual(["A"]);
    // The nested events render flat inside A's view.
    expect(subSessionEvents(events, "A").map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
