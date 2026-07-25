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
