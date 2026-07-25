import { describe, it, expect } from "vitest";
import { deriveState, deriveTranscriptGroups } from "./derive";
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
});
