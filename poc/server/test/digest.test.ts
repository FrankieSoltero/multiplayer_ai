import { describe, it, expect } from "vitest";
import { buildTeammateDigest, summarizeSession, oversightSessionDigest } from "../src/digest.js";
import { Session } from "../src/session.js";
import type { LoggedEvent, SessionEvent } from "../src/events.js";

let seq = 0;
const le = (ev: SessionEvent): LoggedEvent => ({
  ...ev,
  seq: ++seq,
  ts: `2026-07-26T12:00:${String(seq).padStart(2, "0")}Z`,
});

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
