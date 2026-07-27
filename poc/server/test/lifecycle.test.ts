import { describe, expect, test } from "vitest";
import { lifecycleOf } from "../src/lifecycle.js";
import type { LoggedEvent } from "../src/events.js";

const ev = (e: Partial<LoggedEvent> & { type: string }, seq = 0): LoggedEvent =>
  ({ seq, ts: "2026-07-27T00:00:00.000Z", ...e }) as LoggedEvent;

describe("lifecycleOf", () => {
  test("an empty log is open", () => {
    expect(lifecycleOf([])).toBe("open");
  });

  test("ordinary activity leaves it open", () => {
    expect(lifecycleOf([ev({ type: "user_message", userId: "u1", text: "hi" })])).toBe("open");
  });

  test("a session_closed event closes it", () => {
    expect(lifecycleOf([ev({ type: "session_closed", userId: "u1" })])).toBe("closed");
  });

  test("closing is one-way — later events do not reopen it", () => {
    expect(
      lifecycleOf([
        ev({ type: "session_closed", userId: "u1" }, 0),
        ev({ type: "user_message", userId: "u2", text: "still here" }, 1),
      ]),
    ).toBe("closed");
  });
});
