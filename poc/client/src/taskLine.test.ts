import { describe, it, expect } from "vitest";
import { statusGlyph, usageLine, fmtTokens, fmtDuration } from "./taskLine";

describe("statusGlyph", () => {
  it("maps the lifecycle statuses", () => {
    expect(statusGlyph("running")).toBe("▶");
    expect(statusGlyph("completed")).toBe("✓");
    expect(statusGlyph("failed")).toBe("✗");
    expect(statusGlyph("stopped")).toBe("⛔");
  });

  it("falls back to a neutral glyph for unknown statuses", () => {
    expect(statusGlyph("paused")).toBe("◌");
  });
});

describe("fmtTokens / fmtDuration", () => {
  it("abbreviates thousands and dashes absent values", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(12345)).toBe("12.3k");
    expect(fmtTokens(undefined)).toBe("—");
  });

  it("formats durations as s / m s", () => {
    expect(fmtDuration(4000)).toBe("4s");
    expect(fmtDuration(65000)).toBe("1m 05s");
    expect(fmtDuration(undefined)).toBe("—");
  });
});

describe("usageLine", () => {
  it("joins tokens · tools · elapsed · last tool", () => {
    expect(usageLine({ tokens: 12345, toolUses: 7, durationMs: 65000, lastTool: "Grep" }))
      .toBe("12.3k tok · 7 tools · 1m 05s · Grep");
  });

  it("omits the last tool when absent", () => {
    expect(usageLine({ tokens: 100, toolUses: 1, durationMs: 4000 }))
      .toBe("100 tok · 1 tools · 4s");
  });
});
