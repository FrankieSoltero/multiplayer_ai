import { describe, it, expect } from "vitest";
import { suiteFromSessions } from "./skillSuite";
import type { ProjectSessionInfo } from "./types";

const sess = (
  id: string,
  driverName: string | null,
  skills?: { name: string; description: string }[],
): ProjectSessionInfo => ({
  id, participants: [], driverName, intent: null, lastActivityTs: null, ended: false, skills,
});

describe("suiteFromSessions", () => {
  it("unions rosters across sessions, deduping by name with all sources, sorted", () => {
    const out = suiteFromSessions([
      sess("ana", "Ana", [{ name: "b-skill", description: "B" }, { name: "a-skill", description: "A" }]),
      sess("ben", "Ben", [{ name: "a-skill", description: "A" }]),
    ]);
    expect(out.map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
    expect(out[0].sources).toEqual([
      { sessionId: "ana", driverName: "Ana" },
      { sessionId: "ben", driverName: "Ben" },
    ]);
  });
  it("tolerates sessions with no skills field (older snapshots)", () => {
    expect(suiteFromSessions([sess("old", null)])).toEqual([]);
  });
  it("keeps the first non-empty description", () => {
    const out = suiteFromSessions([
      sess("ana", null, [{ name: "x", description: "" }]),
      sess("ben", null, [{ name: "x", description: "real" }]),
    ]);
    expect(out[0].description).toBe("real");
  });
  it("dedupes duplicate skill names within a single session to one source entry", () => {
    const out = suiteFromSessions([
      sess("ana", "Ana", [{ name: "x", description: "A" }, { name: "x", description: "A2" }]),
    ]);
    expect(out[0].sources).toEqual([{ sessionId: "ana", driverName: "Ana" }]);
  });
});
