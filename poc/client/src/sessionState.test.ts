import { describe, expect, test } from "vitest";
import { sessionStateLabel, sessionStateClass, type SessionStateFacts } from "./sessionState";

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

/** `sessionStateLabel` and `sessionStateClass` share one internal precedence
 *  (see `sessionState.ts`'s `degradedState`), but nothing else enforces that
 *  they stay in agreement — a future edit to one without the other would only
 *  be caught here. One shared fixture table drives both functions so a label
 *  and a class are always asserted together, from the same expected state. */
describe("sessionStateLabel and sessionStateClass agree", () => {
  const cases: { desc: string; facts: SessionStateFacts; label: string | null; cls: string }[] = [
    { desc: "healthy live session", facts: base, label: null, cls: "" },
    {
      desc: "dead agent, reachable machine",
      facts: { ...base, ended: true },
      label: "agent stopped",
      cls: "ended",
    },
    {
      desc: "unreachable machine, agent last seen alive",
      facts: { ...base, presence: "offline", ended: false },
      label: "offline",
      cls: "offline",
    },
    {
      desc: "unreachable machine, agent last seen dead",
      facts: { ...base, presence: "offline", ended: true },
      label: "offline",
      cls: "offline",
    },
    {
      desc: "deliberately closed, everything else degraded too",
      facts: { presence: "offline", lifecycle: "closed", ended: true },
      label: "closed",
      cls: "closed",
    },
    {
      desc: "older server, no presence/lifecycle, agent alive",
      facts: { ended: false },
      label: null,
      cls: "",
    },
    {
      desc: "older server, no presence/lifecycle, agent dead",
      facts: { ended: true },
      label: "agent stopped",
      cls: "ended",
    },
  ];

  test.each(cases)("$desc", ({ facts, label, cls }) => {
    expect(sessionStateLabel(facts)).toBe(label);
    expect(sessionStateClass(facts)).toBe(cls);
  });

  test("a non-null label always accompanies a non-empty class, and vice versa", () => {
    for (const { facts } of cases) {
      expect(sessionStateLabel(facts) !== null).toBe(sessionStateClass(facts) !== "");
    }
  });
});
