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

describe("randomId — insecure-context fallback (home-lab kink #5)", () => {
  // crypto.randomUUID exists ONLY in secure contexts (https/localhost). A hub
  // served over plain http on a LAN IP (deploy/multi-machine-test.md topology)
  // has crypto WITHOUT randomUUID — the first real-box run black-screened on it.
  it("falls back to a well-formed v4 uuid when crypto.randomUUID is absent", async () => {
    const { randomId } = await import("./identity");
    const original = crypto.randomUUID;
    // Simulate the insecure context: the property is simply not there.
    (crypto as { randomUUID?: unknown }).randomUUID = undefined;
    try {
      const id = randomId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(randomId()).not.toBe(id);
    } finally {
      (crypto as { randomUUID?: unknown }).randomUUID = original;
    }
  });
  it("uses the native randomUUID when present", async () => {
    const { randomId } = await import("./identity");
    expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
