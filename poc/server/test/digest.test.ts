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
