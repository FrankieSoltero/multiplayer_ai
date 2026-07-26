import { describe, it, expect } from "vitest";
import { agentStateLabel, slugPreview, sortSessions } from "./sessionRow";
import type { ProjectSessionInfo } from "./types";

const row = (id: string, ts: string | null): ProjectSessionInfo => ({
  id,
  participants: [],
  driverName: null,
  intent: null,
  lastActivityTs: ts,
  ended: false,
});

describe("sortSessions", () => {
  it("sorts by lastActivityTs desc with nulls last", () => {
    const sorted = sortSessions([
      row("old", "2026-07-26T10:00:00Z"),
      row("idle", null),
      row("fresh", "2026-07-26T12:00:00Z"),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["fresh", "old", "idle"]);
  });

  it("does not mutate the input", () => {
    const input = [row("a", "2026-07-26T10:00:00Z"), row("b", "2026-07-26T12:00:00Z")];
    sortSessions(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("agentStateLabel", () => {
  it("maps ended to labels", () => {
    expect(agentStateLabel(false)).toBe("LIVE");
    expect(agentStateLabel(true)).toBe("ENDED");
  });
});

describe("slugPreview", () => {
  it("slugifies names with spaces and punctuation", () => {
    expect(slugPreview("Fix Auth!!")).toBe("fix-auth");
    expect(slugPreview("  a  b--c  ")).toBe("a-b-c");
  });

  it("returns empty for unusable names", () => {
    expect(slugPreview("###")).toBe("");
  });

  it("trims to 40 chars", () => {
    expect(slugPreview("x".repeat(60))).toBe("x".repeat(40));
  });
});
