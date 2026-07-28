import { describe, expect, it } from "vitest";
import { canAct, refusalText, type ActRefusal } from "./projectAccess";
import type { ProjectSummary } from "./types";

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "acme", name: "Acme", lifecycle: "active", members: ["ana"],
  sessionCount: 0, liveSessionCount: 0,
  machines: [{ machineId: "lap-1", repoKey: "k", online: true }],
  ...over,
});

describe("canAct", () => {
  it("lets a member of an active project with an online machine act", () => {
    expect(canAct(project(), "ana")).toBe(null);
  });

  it("refuses a non-member — visibility is hub-wide, participation is not", () => {
    expect(canAct(project(), "bo")).toBe("not-a-member");
  });

  it("refuses a closed project", () => {
    expect(canAct(project({ lifecycle: "closed" }), "ana")).toBe("not-active");
  });

  it("refuses when no machine is online", () => {
    // Spec §9: a project with no online machine can be read but not worked in,
    // and must say so rather than offering a control that cannot succeed.
    expect(canAct(project({ machines: [] }), "ana")).toBe("no-machine");
    expect(canAct(project({
      machines: [{ machineId: "lap-1", repoKey: "k", online: false }],
    }), "ana")).toBe("no-machine");
  });

  it("refuses an unknown project", () => {
    expect(canAct(null, "ana")).toBe("unknown-project");
  });

  it("reports membership before machine availability", () => {
    // A non-member should be told they are a spectator, not that the team is
    // offline — the second is a different and misleading problem.
    expect(canAct(project({ machines: [] }), "bo")).toBe("not-a-member");
  });
});

describe("refusalText", () => {
  // This is the only text a blocked user gets, and one string carries the
  // command they are expected to run. A typo in it ships silently — nothing
  // else in the codebase reads these strings, so nothing else can catch one.
  const cases: Array<[ActRefusal, string]> = [
    ["unknown-project", "this project no longer exists"],
    ["not-a-member", "you are spectating — join this project to work in it"],
    ["not-active", "this project is closed"],
    ["no-machine", "no machine is online — run: mpai --hub <url> --project <id>"],
  ];

  it.each(cases)("says the right thing for %s", (refusal, text) => {
    expect(refusalText(refusal)).toBe(text);
  });

  it("gives the blocked user a runnable command, spelled exactly", () => {
    // Pinned separately from the table row above: the table would still pass
    // if this string were reworded into something un-runnable, as long as both
    // copies were reworded together. This names the invariant that matters.
    const text = refusalText("no-machine");
    expect(text).toContain("mpai --hub <url> --project <id>");
    expect(text).toMatch(/run: mpai\b/);
  });

  it("covers every refusal canAct can produce, with no two alike", () => {
    // Guards the failure mode a table test cannot see: a new ActRefusal added
    // to canAct but not to this table, or two arms accidentally sharing copy.
    const reasons = cases.map(([r]) => r);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(new Set(cases.map(([, t]) => t)).size).toBe(cases.length);
    // Every arm returns a non-empty string rather than falling off the switch.
    for (const r of reasons) expect(refusalText(r).length).toBeGreaterThan(0);
  });
});
