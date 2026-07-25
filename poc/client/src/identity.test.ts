import { describe, it, expect } from "vitest";
import { GLYPHS, IDENTITY_COLORS, hashIdentity } from "./identity";

describe("hashIdentity", () => {
  it("is deterministic and draws from the fixed sets", () => {
    const a1 = hashIdentity("user-abc");
    const a2 = hashIdentity("user-abc");
    expect(a1).toEqual(a2);
    expect(GLYPHS).toContain(a1.glyph);
    expect(IDENTITY_COLORS).toContain(a1.color);
  });
  it("varies across users", () => {
    const seen = new Set(
      ["a", "b", "c", "d", "e", "f", "g"].map((u) => hashIdentity(u).color),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
