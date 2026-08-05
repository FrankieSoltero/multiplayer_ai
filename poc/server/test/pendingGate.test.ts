import { describe, expect, test } from "vitest";
import { pendingGateOf } from "../src/pendingGate.js";
import type { LoggedEvent } from "../src/events.js";

/** Events carry seq and ts in real logs; these helpers keep the tests readable.
 *  `reason` is OMITTED unless a test passes one, so the default helper builds the
 *  byte-identical ordinary request today's code paths append — no `reason` key. */
function req(requestId: string, toolName: string, ts: string, seq = 0, reason?: string): LoggedEvent {
  return {
    type: "permission_request", requestId, toolName, input: {},
    ...(reason === undefined ? {} : { reason }), seq, ts,
  } as LoggedEvent;
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

    expect(pendingGateOf(events)).toEqual({
      toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", reason: null,
    });
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

    expect(pendingGateOf(events)).toEqual({
      toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", reason: null,
    });
  });

  test("skips a resolved gate and reports the one still waiting", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0),
      dec("r1", "2026-07-27T10:00:05.000Z", 1),
      req("r2", "Write", "2026-07-27T10:00:30.000Z", 2),
    ];

    expect(pendingGateOf(events)).toEqual({
      toolName: "Write", sinceTs: "2026-07-27T10:00:30.000Z", reason: null,
    });
  });
});

/** The gate reason (spec §6b, server half). CARRIER ONLY on this commit: the
 *  field and its one source exist, and nothing in the server sets a non-null
 *  reason until Task 8b supplies the first writer. */
describe("pendingGateOf — the gate reason", () => {
  test("an ordinary gate opened by today's code paths has a null reason", () => {
    const ordinary = req("r1", "Bash", "2026-07-27T10:00:00.000Z");
    // The event itself is byte-identical to today's: no `reason` key at all.
    expect(JSON.stringify(ordinary)).not.toContain("reason");

    expect(pendingGateOf([ordinary])?.reason).toBeNull();
  });

  test("derives the reason from the permission_request EVENT, character for character", () => {
    // Discriminating: an implementation that adds `reason` to PendingGate
    // without reading it off the event fails this row. The event is the ONE
    // source — the same copy the client replays and Task 8c renders.
    const events = [req("r1", "Write", "2026-07-27T10:00:00.000Z", 0, "contested with session alpha")];

    expect(pendingGateOf(events)).toEqual({
      toolName: "Write",
      sinceTs: "2026-07-27T10:00:00.000Z",
      reason: "contested with session alpha",
    });
  });

  test("reads the reason off the OLDEST undecided request, not any other one", () => {
    const events = [
      req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0, "contested with session alpha"),
      req("r2", "Write", "2026-07-27T10:00:30.000Z", 1, "contested with session beta"),
    ];

    expect(pendingGateOf(events)?.reason).toBe("contested with session alpha");
  });

  test("clamps an over-long reason to the 512-char gate-reason cap", () => {
    // The producer never emits a gate the relay validator would reject on the
    // far end (same argument as `clampRepoDecl`): 512 is the gate-reason cap,
    // a bound separate from PATH_WIRE_CAP that deliberately shares its number.
    const events = [req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0, "x".repeat(600))];

    expect(pendingGateOf(events)?.reason).toBe("x".repeat(512));
  });

  test("a reason exactly at the cap rides through unchanged", () => {
    const atCap = "y".repeat(512);
    const events = [req("r1", "Bash", "2026-07-27T10:00:00.000Z", 0, atCap)];

    expect(pendingGateOf(events)?.reason).toBe(atCap);
  });
});

/** The §8.6 gate display fields (title/description/ruleSuggestion) — same
 *  carrier discipline as `reason`: read off the permission_request EVENT,
 *  conditional so an ordinary gate stays byte-identical. */
describe("pendingGateOf — the §8.6 display fields", () => {
  test("carries title/description/ruleSuggestion off the event", () => {
    const event = {
      type: "permission_request", requestId: "r1", toolName: "Bash", input: {},
      title: "Claude wants to run npm test",
      description: "Claude will run the test suite",
      ruleSuggestion: "Bash(npm test:*)",
      seq: 0, ts: "2026-08-03T10:00:00.000Z",
    } as LoggedEvent;

    expect(pendingGateOf([event])).toEqual({
      toolName: "Bash",
      sinceTs: "2026-08-03T10:00:00.000Z",
      reason: null,
      title: "Claude wants to run npm test",
      description: "Claude will run the test suite",
      ruleSuggestion: "Bash(npm test:*)",
    });
  });

  test("an ordinary gate gains no new keys", () => {
    const gate = pendingGateOf([req("r1", "Bash", "2026-08-03T10:00:00.000Z")]);
    expect(gate).toEqual({ toolName: "Bash", sinceTs: "2026-08-03T10:00:00.000Z", reason: null });
  });

  test("clamps an over-long title to the 512-char cap", () => {
    const event = {
      type: "permission_request", requestId: "r1", toolName: "Bash", input: {},
      title: "t".repeat(600), seq: 0, ts: "2026-08-03T10:00:00.000Z",
    } as LoggedEvent;

    expect(pendingGateOf([event])?.title).toBe("t".repeat(512));
  });
});
