import { describe, expect, it } from "vitest";
import { freeSessionName } from "./sessionNames";

describe("freeSessionName", () => {
  it("returns the desired name when it is free", () => {
    expect(freeSessionName(["billing"], "auth")).toBe("auth");
  });

  it("appends a counter when the name is taken", () => {
    // Spec P6: the BROWSER disambiguates, so the hub forwards the payload
    // untouched. Two engineers may both want a session called "auth".
    expect(freeSessionName(["auth"], "auth")).toBe("auth-2");
    expect(freeSessionName(["auth", "auth-2"], "auth")).toBe("auth-3");
  });

  it("skips a gap rather than reusing a freed name", () => {
    expect(freeSessionName(["auth", "auth-3"], "auth")).toBe("auth-2");
  });

  it("keeps the result inside the 40-char slug limit", () => {
    const long = "a".repeat(40);
    const out = freeSessionName([long], long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).not.toBe(long);
  });

  it("returns the desired name unchanged when nothing exists", () => {
    expect(freeSessionName([], "auth")).toBe("auth");
  });
});
