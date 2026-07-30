import { describe, it, expect } from "vitest";
import {
  PROMPT_CAP,
  projectRecordFrom,
  type RecordSessionInput,
} from "../src/record.js";
import type { LoggedEvent, SessionEvent } from "../src/events.js";
import type { SessionFacts } from "../src/relayProtocol.js";

function ts(i: number): string {
  return `2026-07-29T00:00:${String(i).padStart(2, "0")}.000Z`;
}

/** Stamps seq/ts so a test only has to say what happened, in order. */
function log(...evs: SessionEvent[]): LoggedEvent[] {
  return evs.map((ev, i) => ({ ...ev, seq: i, ts: ts(i) }));
}

function facts(id: string, over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    id,
    participants: [],
    driverName: null,
    intent: null,
    lastActivityTs: null,
    ended: false,
    pendingGate: null,
    skills: [],
    repoKey: null,
    lifecycle: "open",
    ...over,
  };
}

function input(id: string, events: LoggedEvent[], over: Partial<RecordSessionInput> = {}): RecordSessionInput {
  return { facts: facts(id), machineId: null, events, ...over };
}

/** The single session's turns, for the many one-session cases below. */
function turnsOf(events: LoggedEvent[]) {
  return projectRecordFrom("proj", [input("s1", events)]).sessions[0].turns;
}

describe("turn segmentation", () => {
  it("splits one turn per turn_end, each closing on its own turn_end", () => {
    const events = log(
      { type: "user_message", userId: "u1", text: "one" },
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "turn_end" },
      { type: "user_message", userId: "u2", text: "two" },
      { type: "turn_end" },
    );
    const turns = turnsOf(events);
    expect(turns.map((t) => [t.turn, t.startTs, t.endTs, t.inProgress])).toEqual([
      [1, ts(0), ts(2), false],
      [2, ts(3), ts(4), false],
    ]);
  });

  it("reports events after the last turn_end as one in-progress turn", () => {
    const events = log(
      { type: "user_message", userId: "u1", text: "one" },
      { type: "turn_end" },
      { type: "user_message", userId: "u2", text: "two" },
      { type: "tool_call", toolName: "Read", input: {} },
    );
    const turns = turnsOf(events);
    expect(turns.map((t) => [t.turn, t.inProgress, t.startTs, t.endTs])).toEqual([
      [1, false, ts(0), ts(1)],
      [2, true, ts(2), ts(3)],
    ]);
  });

  it("reports a session with no turn_end at all as one in-progress turn", () => {
    const turns = turnsOf(log({ type: "user_message", userId: "u1", text: "hi" }));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn: 1, inProgress: true });
  });

  it("gives an empty session no turns", () => {
    const record = projectRecordFrom("proj", [input("s1", [])]);
    expect(record.sessions[0].turns).toEqual([]);
  });

  it("treats a turn_end immediately after a turn_end as a one-event turn", () => {
    const events = log(
      { type: "user_message", userId: "u1", text: "one" },
      { type: "turn_end" },
      { type: "turn_end" },
    );
    const turns = turnsOf(events);
    expect(turns.map((t) => [t.turn, t.startTs, t.endTs, t.inProgress, t.prompt])).toEqual([
      [1, ts(0), ts(1), false, "one"],
      [2, ts(2), ts(2), false, null],
    ]);
  });
});

describe("turn driver", () => {
  it("uses the userId of the turn's opening user_message", () => {
    const turns = turnsOf(
      log({ type: "user_message", userId: "u1", text: "hi" }, { type: "turn_end" }),
    );
    expect(turns[0].driver).toBe("u1");
  });

  it("uses the first user_message even when the turn opens on system events", () => {
    // Real logs open every turn with presence/skill bookkeeping; those events
    // never null the driver (spec §8a ruling 9).
    const events = log(
      { type: "presence_join", userId: "u1", name: "ana" },
      { type: "skill_roster", skills: [] },
      { type: "user_message", userId: "u1", text: "ship it" },
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].driver).toBe("u1");
  });

  it("prefers the turn's first user_message over the controller fallback", () => {
    // A turn containing a user_message is not a system turn, so the earlier
    // controller does not get credit for it (spec §8a ruling 9).
    const events = log(
      { type: "control_change", userId: "u5" },
      { type: "turn_end" },
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "user_message", userId: "u1", text: "mine" },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[1].driver).toBe("u1");
  });

  it("falls back to the most recent control_change before the turn started", () => {
    const events = log(
      { type: "control_change", userId: "u4" },
      { type: "turn_end" },
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[1].driver).toBe("u4");
  });

  it("ignores a control_change inside the turn for that turn's own driver", () => {
    // A control_change inside a turn feeds LATER turns' fallback only.
    const events = log(
      { type: "control_change", userId: "u5" },
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "turn_end" },
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "turn_end" },
    );
    const turns = turnsOf(events);
    expect(turns[0].driver).toBeNull();
    expect(turns[1].driver).toBe("u5");
  });

  it("leaves driver null with no user_message in the turn and no prior control_change", () => {
    const turns = turnsOf(
      log({ type: "tool_call", toolName: "Read", input: {} }, { type: "turn_end" }),
    );
    expect(turns[0].driver).toBeNull();
  });

  it("never lets a second user_message in the turn override the first", () => {
    const events = log(
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "user_message", userId: "u1", text: "hi" },
      { type: "user_message", userId: "u9", text: "interrupting" },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].driver).toBe("u1");
  });
});

describe("turn prompt", () => {
  it("slices the first user_message text to PROMPT_CAP", () => {
    const text = "x".repeat(500);
    const turns = turnsOf(log({ type: "user_message", userId: "u1", text }, { type: "turn_end" }));
    expect(PROMPT_CAP).toBe(200);
    expect(turns[0].prompt).toBe(text.slice(0, PROMPT_CAP));
    expect(turns[0].prompt).toHaveLength(200);
  });

  it("uses the FIRST user_message of the turn", () => {
    const events = log(
      { type: "user_message", userId: "u1", text: "first" },
      { type: "user_message", userId: "u2", text: "second" },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].prompt).toBe("first");
  });

  it("leaves prompt null when the turn has no user_message", () => {
    const turns = turnsOf(
      log({ type: "tool_call", toolName: "Read", input: {} }, { type: "turn_end" }),
    );
    expect(turns[0].prompt).toBeNull();
  });
});

describe("turn tool activity", () => {
  it("counts tool_calls by toolName", () => {
    const events = log(
      { type: "tool_call", toolName: "Edit", input: {} },
      { type: "tool_call", toolName: "Edit", input: {} },
      { type: "tool_call", toolName: "Bash", input: {} },
      { type: "tool_call", toolName: "Edit", input: {} },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].toolCounts).toEqual({ Edit: 3, Bash: 1 });
  });

  it("collects file_path from Edit/Write/NotebookEdit, deduped in first-occurrence order", () => {
    const events = log(
      { type: "tool_call", toolName: "Write", input: { file_path: "b.ts" } },
      { type: "tool_call", toolName: "Edit", input: { file_path: "a.ts" } },
      { type: "tool_call", toolName: "NotebookEdit", input: { file_path: "n.ipynb" } },
      { type: "tool_call", toolName: "Edit", input: { file_path: "b.ts" } },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].filesChanged).toEqual(["b.ts", "a.ts", "n.ipynb"]);
  });

  it("skips malformed inputs silently and never collects from other tools", () => {
    const events = log(
      { type: "tool_call", toolName: "Edit", input: null },
      { type: "tool_call", toolName: "Edit", input: "a.ts" },
      { type: "tool_call", toolName: "Edit", input: {} },
      { type: "tool_call", toolName: "Edit", input: { file_path: 7 } },
      { type: "tool_call", toolName: "Read", input: { file_path: "read.ts" } },
      { type: "tool_call", toolName: "Bash", input: { file_path: "bash.ts" } },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].filesChanged).toEqual([]);
  });

  it("counts agent_error events per turn", () => {
    const events = log(
      { type: "agent_error", message: "boom" },
      { type: "agent_error", message: "boom again" },
      { type: "turn_end" },
      { type: "tool_call", toolName: "Read", input: {} },
      { type: "turn_end" },
    );
    const turns = turnsOf(events);
    expect(turns[0].errors).toBe(2);
    expect(turns[1].errors).toBe(0);
  });
});

describe("turn approvals", () => {
  it("resolves toolName from the permission_request and lands on the decision's turn", () => {
    const events = log(
      { type: "permission_request", requestId: "r1", toolName: "Bash", input: {} },
      { type: "turn_end" },
      { type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1" },
      { type: "turn_end" },
    );
    const turns = turnsOf(events);
    expect(turns[0].approvals).toEqual([]);
    expect(turns[1].approvals).toEqual([
      { kind: "permission", decision: "allow", userId: "u1", toolName: "Bash", auto: false },
    ]);
  });

  it("includes a decision with no matching request, with a null toolName", () => {
    const events = log(
      { type: "permission_decision", requestId: "ghost", decision: "deny", userId: "u1" },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].approvals).toEqual([
      { kind: "permission", decision: "deny", userId: "u1", toolName: null, auto: false },
    ]);
  });

  it("marks an auto decision auto: true", () => {
    const events = log(
      { type: "permission_request", requestId: "r1", toolName: "Read", input: {} },
      { type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1", auto: true },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].approvals).toEqual([
      { kind: "permission", decision: "allow", userId: "u1", toolName: "Read", auto: true },
    ]);
  });

  it("records a plan_decision as a plan approval with no toolName", () => {
    const events = log(
      { type: "plan_request", requestId: "p1", plan: "do it" },
      { type: "plan_decision", requestId: "p1", decision: "approve", userId: "u2" },
      { type: "turn_end" },
    );
    expect(turnsOf(events)[0].approvals).toEqual([
      { kind: "plan", decision: "approve", userId: "u2", toolName: null, auto: false },
    ]);
  });
});

describe("session fields", () => {
  it("copies repoKey/lifecycle/intent from facts and machineId from the input", () => {
    const record = projectRecordFrom("proj", [
      {
        facts: facts("s1", { repoKey: "repo-a", lifecycle: "closed", intent: "ship the record" }),
        machineId: "m1",
        events: [],
      },
    ]);
    expect(record.sessions[0]).toMatchObject({
      sessionId: "s1",
      machineId: "m1",
      repoKey: "repo-a",
      lifecycle: "closed",
      intent: "ship the record",
    });
    expect(record.projectId).toBe("proj");
  });

  it("takes closedBy from the last session_closed, or null when there is none", () => {
    const closed = log(
      { type: "session_closed", userId: "u2" },
      { type: "session_closed", userId: "u3" },
    );
    const open = log({ type: "user_message", userId: "u1", text: "hi" });
    const record = projectRecordFrom("proj", [input("s1", closed), input("s2", open)]);
    expect(record.sessions.map((s) => s.closedBy)).toEqual(["u3", null]);
  });

  it("sorts sessions by sessionId ascending regardless of input order", () => {
    const record = projectRecordFrom("proj", [
      input("zeta", []),
      input("alpha", []),
      input("mid", []),
    ]);
    expect(record.sessions.map((s) => s.sessionId)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("rollup", () => {
  it("counts turns driven per user across sessions", () => {
    const a = log(
      { type: "user_message", userId: "u1", text: "a" },
      { type: "turn_end" },
      { type: "user_message", userId: "u1", text: "b" },
      { type: "turn_end" },
    );
    const b = log({ type: "user_message", userId: "u1", text: "c" }, { type: "turn_end" });
    const record = projectRecordFrom("proj", [input("s1", a), input("s2", b)]);
    expect(record.rollup.perUser).toEqual([
      { userId: "u1", turnsDriven: 3, approvalsGiven: 0, denialsGiven: 0 },
    ]);
  });

  it("tallies approvals and denials per user, excluding auto decisions", () => {
    const events = log(
      { type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1" },
      { type: "permission_decision", requestId: "r2", decision: "allow", userId: "u1" },
      { type: "permission_decision", requestId: "r3", decision: "deny", userId: "u1" },
      { type: "plan_decision", requestId: "p1", decision: "approve", userId: "u2" },
      { type: "permission_decision", requestId: "r4", decision: "allow", userId: "u3", auto: true },
      { type: "turn_end" },
    );
    const record = projectRecordFrom("proj", [input("s1", events)]);
    expect(record.rollup.perUser).toEqual([
      { userId: "u1", turnsDriven: 0, approvalsGiven: 2, denialsGiven: 1 },
      { userId: "u2", turnsDriven: 0, approvalsGiven: 1, denialsGiven: 0 },
    ]);
  });

  it("counts a plan reject as a denial", () => {
    const events = log(
      { type: "plan_decision", requestId: "p1", decision: "reject", userId: "u2" },
      { type: "turn_end" },
    );
    expect(projectRecordFrom("proj", [input("s1", events)]).rollup.perUser).toEqual([
      { userId: "u2", turnsDriven: 0, approvalsGiven: 0, denialsGiven: 1 },
    ]);
  });

  it("gives a user who only ever approved a row of their own", () => {
    const events = log(
      { type: "user_message", userId: "u1", text: "hi" },
      { type: "permission_decision", requestId: "r1", decision: "allow", userId: "u2" },
      { type: "turn_end" },
    );
    const perUser = projectRecordFrom("proj", [input("s1", events)]).rollup.perUser;
    expect(perUser).toContainEqual({
      userId: "u2",
      turnsDriven: 0,
      approvalsGiven: 1,
      denialsGiven: 0,
    });
  });

  it("sorts perUser by turnsDriven desc, then userId asc", () => {
    const events = log(
      { type: "user_message", userId: "b", text: "1" },
      { type: "turn_end" },
      { type: "user_message", userId: "b", text: "2" },
      { type: "turn_end" },
      { type: "user_message", userId: "c", text: "3" },
      { type: "turn_end" },
      { type: "user_message", userId: "a", text: "4" },
      { type: "turn_end" },
    );
    const perUser = projectRecordFrom("proj", [input("s1", events)]).rollup.perUser;
    expect(perUser.map((u) => [u.userId, u.turnsDriven])).toEqual([
      ["b", 2],
      ["a", 1],
      ["c", 1],
    ]);
  });

  it("totals turns and sessions across the project", () => {
    const a = log(
      { type: "user_message", userId: "u1", text: "a" },
      { type: "turn_end" },
      { type: "user_message", userId: "u1", text: "b" },
      { type: "turn_end" },
      { type: "user_message", userId: "u1", text: "c" },
      { type: "turn_end" },
    );
    const b = log(
      { type: "user_message", userId: "u2", text: "d" },
      { type: "turn_end" },
      { type: "user_message", userId: "u2", text: "e" },
    );
    const record = projectRecordFrom("proj", [input("s1", a), input("s2", b)]);
    expect(record.rollup.totalTurns).toBe(5);
    expect(record.rollup.totalSessions).toBe(2);
  });
});

describe("purity", () => {
  it("returns deep-equal records for the same input and mutates nothing", () => {
    const events = log(
      { type: "user_message", userId: "u1", text: "hi" },
      { type: "tool_call", toolName: "Edit", input: { file_path: "a.ts" } },
      { type: "permission_request", requestId: "r1", toolName: "Bash", input: {} },
      { type: "permission_decision", requestId: "r1", decision: "allow", userId: "u1" },
      { type: "turn_end" },
      { type: "control_change", userId: "u2" },
    );
    const sessions = [input("s1", events)];
    const before = structuredClone(sessions);
    const first = projectRecordFrom("proj", sessions);
    const second = projectRecordFrom("proj", sessions);
    expect(first).toEqual(second);
    expect(sessions).toEqual(before);
  });
});
