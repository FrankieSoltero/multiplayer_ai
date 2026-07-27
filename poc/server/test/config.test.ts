import { describe, it, expect } from "vitest";
import { validateProductionConfig } from "../src/config.js";

const always = () => true;
const never = () => false;

describe("validateProductionConfig", () => {
  it("is a no-op in development, where CLIENT_DIST is unset", () => {
    // No key, no dist — dev must keep starting exactly as it does today.
    expect(validateProductionConfig({}, never)).toEqual({ ok: true, staticDir: undefined });
  });

  it("accepts a production config with a built client and a key", () => {
    const result = validateProductionConfig(
      { CLIENT_DIST: "/opt/app/dist", ANTHROPIC_API_KEY: "sk-test" },
      always,
    );
    expect(result).toEqual({ ok: true, staticDir: "/opt/app/dist" });
  });

  it("rejects a CLIENT_DIST with no index.html", () => {
    const result = validateProductionConfig(
      { CLIENT_DIST: "/opt/app/dist", ANTHROPIC_API_KEY: "sk-test" },
      never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("index.html");
  });

  it("rejects production with no API key", () => {
    const result = validateProductionConfig({ CLIENT_DIST: "/opt/app/dist" }, always);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  it("treats an empty API key as missing", () => {
    const result = validateProductionConfig(
      { CLIENT_DIST: "/opt/app/dist", ANTHROPIC_API_KEY: "" },
      always,
    );
    expect(result.ok).toBe(false);
  });
});
