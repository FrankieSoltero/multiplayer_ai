import { describe, it, expect } from "vitest";
import { oversightFresh, updatedAtLabel } from "./oversightView";
import type { OversightState } from "./types";

const withLatest = (seq: number): OversightState => ({
  enabled: true,
  latest: { text: "t", ts: "2026-07-26T12:00:00Z", seq },
});

describe("oversightFresh", () => {
  it("is fresh only when enabled with an unseen seq", () => {
    expect(oversightFresh(withLatest(3), 2)).toBe(true);
    expect(oversightFresh(withLatest(3), 3)).toBe(false);
  });

  it("is never fresh when disabled or empty", () => {
    expect(oversightFresh({ enabled: false, latest: { text: "t", ts: "x", seq: 9 } }, 0)).toBe(false);
    expect(oversightFresh({ enabled: true, latest: null }, 0)).toBe(false);
  });
});

describe("updatedAtLabel", () => {
  it("labels a valid timestamp", () => {
    expect(updatedAtLabel("2026-07-26T12:00:00Z")).toMatch(/^updated /);
  });

  it("falls back for null or garbage", () => {
    expect(updatedAtLabel(null)).toBe("no summary yet");
    expect(updatedAtLabel("not-a-date")).toBe("no summary yet");
  });
});
