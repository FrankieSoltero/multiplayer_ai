import { describe, expect, it } from "vitest";
import { sortProjects, projectSummaryLine } from "./projectList";
import type { ProjectSummary } from "./types";

const p = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "acme", name: "Acme", lifecycle: "active", members: [],
  sessionCount: 0, liveSessionCount: 0, machines: [], ...over,
});

describe("sortProjects", () => {
  it("puts projects with live sessions first, then by name", () => {
    const out = sortProjects([
      p({ id: "quiet", name: "Quiet" }),
      p({ id: "busy", name: "Busy", liveSessionCount: 2 }),
      p({ id: "aardvark", name: "Aardvark" }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["busy", "aardvark", "quiet"]);
  });

  it("drops archived projects", () => {
    const out = sortProjects([p({ id: "old", lifecycle: "archived" }), p({ id: "live" })]);
    expect(out.map((x) => x.id)).toEqual(["live"]);
  });

  it("keeps archived projects on the includeArchived arm — sorted in, not appended", () => {
    // The toggle's ON state is the SAME list with the filter off, so an
    // archived project takes its ordinary sort seat (live count, then name) —
    // not a tail position, which would read as a second-class list.
    const out = sortProjects(
      [
        p({ id: "quiet", name: "Quiet" }),
        p({ id: "old", name: "Aardvark", lifecycle: "archived", liveSessionCount: 1 }),
        p({ id: "busy", name: "Busy", liveSessionCount: 2 }),
      ],
      { includeArchived: true },
    );
    expect(out.map((x) => x.id)).toEqual(["busy", "old", "quiet"]);
  });

  it("keeps closed projects — they are readable, just not workable", () => {
    // Mixed in with an archived project so an implementation that filters
    // nothing at all (identity) is caught too, not just one that conflates
    // "closed" with "archived".
    const out = sortProjects([
      p({ id: "shut", lifecycle: "closed" }),
      p({ id: "old", lifecycle: "archived" }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["shut"]);
  });
});

describe("projectSummaryLine", () => {
  it("reads empty when nothing has happened", () => {
    expect(projectSummaryLine(p())).toBe("no sessions yet");
  });

  it("counts live sessions and online machines", () => {
    expect(projectSummaryLine(p({
      sessionCount: 3, liveSessionCount: 2,
      machines: [
        { machineId: "a", name: "franks-mbp", repos: [], online: true },
        { machineId: "b", name: "build-box", repos: [], online: false },
      ],
    }))).toBe("2 of 3 sessions live · 1 of 2 machines online");
  });
});
