import { describe, it, expect } from "vitest";
import { nextMode, MODE_ORDER } from "./modes";

describe("nextMode", () => {
  it("cycles default → auto → plan → default", () => {
    expect(nextMode("default")).toBe("auto");
    expect(nextMode("auto")).toBe("plan");
    expect(nextMode("plan")).toBe("default");
  });

  it("recovers from an unknown mode by restarting the cycle at default", () => {
    expect(nextMode("yolo")).toBe("default");
  });

  it("exposes the canonical order for UI labels", () => {
    expect(MODE_ORDER).toEqual(["default", "auto", "plan"]);
  });
});
