import { describe, it, expect } from "vitest";
import { pluginLine } from "./pluginLine";

describe("pluginLine", () => {
  it("renders the add copy with skill count and timing note", () => {
    expect(pluginLine("add", "soltero-skills", 14)).toBe(
      "added plugin soltero-skills (14 skills) — applies to sessions started from now",
    );
  });
  it("renders the remove copy", () => {
    expect(pluginLine("remove", "soltero-skills", 0)).toBe(
      "removed plugin soltero-skills",
    );
  });
});
