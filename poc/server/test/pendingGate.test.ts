import { describe, expect, test } from "vitest";
import { pendingGateOf } from "../src/pendingGate.js";
import type { LoggedEvent } from "../src/events.js";

/** Events carry seq and ts in real logs; these helpers keep the tests readable. */
function req(requestId: string, toolName: string, ts: string, seq = 0): LoggedEvent {
  return { type: "permission_request", requestId, toolName, input: {}, seq, ts } as LoggedEvent;
}
function dec(requestId: string, ts: string, seq = 0, auto?: true): LoggedEvent {
  return {
    type: "permission_decision", requestId, decision: "allow", userId: "ana",
    ...(auto ? { auto } : {}), seq, ts,
  } as LoggedEvent;
}

describe("pendingGateOf", () => {
  test("returns null when there are no permission events at all", () => {
    expect(pendingGateOf([])).toBeNull();
  });

  test("returns the request when nothing has decided it yet", () => {
    const events = [req("r1", "Bash", "2026-07-27T10:00:00.000Z")];

    expect(pendingGateOf(events)).toEqual({ toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z" });
  });

  test("returns null once a decision resolves the request", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      dec("r1", "2026-07-27T10:00:05.000Z", 1),
    ];

    expect(pendingGateOf(events)).toBeNull();
  });

  test("an auto decision resolves the request, so AUTO mode never pulls anyone", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      dec("r1", "2026-07-27T10:00:00.100Z", 1, true),
    ];

    expect(pendingGateOf(events)).toBeNull();
  });

  test("returns the oldest gate when several are pending at once", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      req("r2", "Write", "2026-07-27T10:00:30.000Z", 1),
    ];

    expect(pendingGateOf(events)).toEqual({ toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z" });
  });

  test("skips a resolved gate and reports the one still waiting", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      dec("r1", "2026-07-27T10:00:05.000Z", 1),
      req("r2", "Write", "2026-07-27T10:00:30.000Z", 2),
    ];

    expect(pendingGateOf(events)).toEqual({ toolName: "Write", sinceTs: "2026-07-27T10:00:30.000Z" });
  });
});
