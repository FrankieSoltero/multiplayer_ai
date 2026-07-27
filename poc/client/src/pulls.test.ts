import { describe, expect, test } from "vitest";
import { pullsFrom, thresholdFromStorage, waitedLabel, THRESHOLD_OPTIONS } from "./pulls";
import type { ProjectSessionInfo } from "./types";

const T0 = Date.parse("2026-07-27T10:00:00.000Z");

function session(over: Partial<ProjectSessionInfo> = {}): ProjectSessionInfo {
  return {
    id: "ana",
    participants: ["ana"],
    driverName: "ana",
    intent: null,
    lastActivityTs: null,
    ended: false,
    pendingGate: { toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z" },
    ...over,
  };
}

describe("pullsFrom", () => {
  test("returns nothing when the feature is off", () => {
    const pulls = pullsFrom([session()], {
      thresholdMs: null, currentSessionId: "mine", now: T0 + 60_000,
    });

    expect(pulls).toEqual([]);
  });

  test("returns nothing before the threshold has elapsed", () => {
    const pulls = pullsFrom([session()], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 59_000,
    });

    expect(pulls).toEqual([]);
  });

  test("pulls exactly at the threshold", () => {
    const pulls = pullsFrom([session()], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 60_000,
    });

    expect(pulls).toEqual([
      { sessionId: "ana", toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", driverName: "ana" },
    ]);
  });

  test("never pulls for the session you are already in", () => {
    const pulls = pullsFrom([session({ id: "mine" })], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 300_000,
    });

    expect(pulls).toEqual([]);
  });

  test("ignores an ended session", () => {
    const pulls = pullsFrom([session({ ended: true })], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 300_000,
    });

    expect(pulls).toEqual([]);
  });

  test("ignores a session with no pending gate", () => {
    const pulls = pullsFrom([session({ pendingGate: null })], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 300_000,
    });

    expect(pulls).toEqual([]);
  });

  test("still pulls a closed session with an unanswered gate (pinned, not a bug)", () => {
    // `permission` stays answerable after close (server.ts) so an in-flight
    // gate can be resolved; a pull is how a teammate notices it needs
    // resolving. Only `ended` (the agent process is gone) suppresses a pull —
    // `closed` and `offline` deliberately do not.
    const pulls = pullsFrom([session({ lifecycle: "closed" })], {
      thresholdMs: 60_000, currentSessionId: "mine", now: T0 + 300_000,
    });

    expect(pulls).toEqual([
      { sessionId: "ana", toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", driverName: "ana" },
    ]);
  });
});

describe("waitedLabel", () => {
  // The party pane's ago() appends "ago", which reads wrong after "waiting" —
  // the browser pass showed "waiting 2m ago — approval to run Bash". This is
  // the duration on its own.
  test("reads as a duration, not a point in time", () => {
    expect(waitedLabel(T0, T0 + 120_000)).toBe("2m");
  });

  test("collapses anything under a minute rather than showing 0m", () => {
    expect(waitedLabel(T0, T0 + 30_000)).toBe("under a minute");
  });

  test("floors to whole minutes", () => {
    expect(waitedLabel(T0, T0 + 119_000)).toBe("1m");
  });
});

describe("thresholdFromStorage", () => {
  test("an absent key means the feature is off", () => {
    expect(thresholdFromStorage(null)).toBeNull();
  });

  test("garbage means off rather than a crash or a surprise interval", () => {
    expect(thresholdFromStorage("banana")).toBeNull();
  });

  test("reads back a value this module could have written", () => {
    expect(thresholdFromStorage("60000")).toBe(60_000);
  });

  test("every offered option round-trips through storage", () => {
    for (const opt of THRESHOLD_OPTIONS) {
      expect(thresholdFromStorage(opt.ms === null ? null : String(opt.ms))).toBe(opt.ms);
    }
  });
});
