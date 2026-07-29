import { describe, expect, it } from "vitest";
import { groupByRepo } from "./repoGroups";
import type { ProjectSessionInfo } from "./types";

const s = (id: string, repoKey?: string): ProjectSessionInfo => ({
  id, participants: [], driverName: null, intent: null, lastActivityTs: null,
  ended: false, repoKey,
} as ProjectSessionInfo);

describe("groupByRepo", () => {
  it("groups sessions under their repo", () => {
    const groups = groupByRepo([s("auth", "acme/api"), s("ui", "acme/web"), s("fix", "acme/api")]);
    expect(groups.map((g) => g.repoKey)).toEqual(["acme/api", "acme/web"]);
    expect(groups[0].sessions.map((x) => x.id)).toEqual(["auth", "fix"]);
  });

  it("returns one group when every session shares a repo", () => {
    // Grouping should appear because there is something to group — with one
    // repo the screen reads as a flat list, which is correct.
    const groups = groupByRepo([s("auth", "acme/api"), s("ui", "acme/api")]);
    expect(groups).toHaveLength(1);
  });

  it("collects sessions with no repo key under a single unknown group", () => {
    const groups = groupByRepo([s("auth"), s("ui", "acme/web")]);
    expect(groups.map((g) => g.repoKey)).toEqual(["", "acme/web"]);
  });

  it("returns nothing for no sessions", () => {
    expect(groupByRepo([])).toEqual([]);
  });
});
