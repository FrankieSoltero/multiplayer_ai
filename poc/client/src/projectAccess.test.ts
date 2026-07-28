import { describe, expect, it } from "vitest";
import { canAct } from "./projectAccess";
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
