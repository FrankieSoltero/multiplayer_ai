import { describe, expect, test } from "vitest";
import { sessionStateLabel, sessionStateClass } from "./sessionState";

const base = { presence: "online" as const, lifecycle: "open" as const, ended: false };

describe("sessionStateLabel", () => {
  test("a healthy live session has no label", () => {
    expect(sessionStateLabel(base)).toBeNull();
  });

  test("a dead agent on a reachable machine says so", () => {
    expect(sessionStateLabel({ ...base, ended: true })).toBe("agent stopped");
  });

  test("an unreachable machine outranks the agent state, which we cannot know", () => {
    // The last `ended` we heard is stale the moment the machine goes away —
    // reporting it as fact would be a claim we cannot support.
    expect(sessionStateLabel({ ...base, presence: "offline", ended: false })).toBe("offline");
    expect(sessionStateLabel({ ...base, presence: "offline", ended: true })).toBe("offline");
  });

  test("a deliberate close outranks everything", () => {
    expect(sessionStateLabel({ presence: "offline", lifecycle: "closed", ended: true })).toBe("closed");
  });

  test("treats a snapshot from an older server as online and open", () => {
    expect(sessionStateLabel({ ended: false })).toBeNull();
    expect(sessionStateLabel({ ended: true })).toBe("agent stopped");
  });
});

describe("sessionStateClass", () => {
  test("returns an empty string for a healthy session so no class is added", () => {
    expect(sessionStateClass(base)).toBe("");
  });

  test("names each degraded state distinctly", () => {
    expect(sessionStateClass({ ...base, ended: true })).toBe("ended");
    expect(sessionStateClass({ ...base, presence: "offline" })).toBe("offline");
    expect(sessionStateClass({ ...base, lifecycle: "closed" })).toBe("closed");
  });
});
