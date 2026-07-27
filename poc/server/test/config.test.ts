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
    // Production now also requires a complete auth config (A2a) — the
    // GitHub vars below are the same fixture used by the auth tests further
    // down this file.
    const result = validateProductionConfig(
      {
        CLIENT_DIST: "/opt/app/dist",
        ANTHROPIC_API_KEY: "sk-test",
        GITHUB_CLIENT_ID: "cid",
        GITHUB_CLIENT_SECRET: "csecret",
        SESSION_SECRET: "ssecret",
        GITHUB_ALLOWLIST: "ana",
      },
      always,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.staticDir).toBe("/opt/app/dist");
  });

  it("rejects a CLIENT_DIST with no index.html", () => {
    const result = validateProductionConfig(
      {
        CLIENT_DIST: "/opt/app/dist",
        ANTHROPIC_API_KEY: "sk-test",
        GITHUB_CLIENT_ID: "cid",
        GITHUB_CLIENT_SECRET: "csecret",
        SESSION_SECRET: "ssecret",
        GITHUB_ALLOWLIST: "ana",
      },
      never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("index.html");
  });

  it("rejects production with no API key", () => {
    const result = validateProductionConfig(
      {
        CLIENT_DIST: "/opt/app/dist",
        GITHUB_CLIENT_ID: "cid",
        GITHUB_CLIENT_SECRET: "csecret",
        SESSION_SECRET: "ssecret",
        GITHUB_ALLOWLIST: "ana",
      },
      always,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  it("treats an empty API key as missing", () => {
    const result = validateProductionConfig(
      {
        CLIENT_DIST: "/opt/app/dist",
        ANTHROPIC_API_KEY: "",
        GITHUB_CLIENT_ID: "cid",
        GITHUB_CLIENT_SECRET: "csecret",
        SESSION_SECRET: "ssecret",
        GITHUB_ALLOWLIST: "ana",
      },
      always,
    );
    expect(result.ok).toBe(false);
  });
});

const OK_DIST = { CLIENT_DIST: "/dist", ANTHROPIC_API_KEY: "k" };
const OK_AUTH = {
  GITHUB_CLIENT_ID: "cid",
  GITHUB_CLIENT_SECRET: "csecret",
  SESSION_SECRET: "ssecret",
  GITHUB_ALLOWLIST: "ana",
};
const yes = () => true;

describe("auth configuration", () => {
  it("production requires every auth variable", () => {
    for (const missing of Object.keys(OK_AUTH)) {
      const env: Record<string, string> = { ...OK_DIST, ...OK_AUTH };
      delete env[missing];
      const result = validateProductionConfig(env, yes);
      expect(result.ok, `expected failure when ${missing} is absent`).toBe(false);
      if (!result.ok) expect(result.error).toContain(missing);
    }
  });

  it("production rejects a blank allowlist", () => {
    const result = validateProductionConfig(
      { ...OK_DIST, ...OK_AUTH, GITHUB_ALLOWLIST: "  " },
      yes,
    );
    expect(result.ok).toBe(false);
  });

  it("production passes and builds an AuthConfig when all are present", () => {
    const result = validateProductionConfig({ ...OK_DIST, ...OK_AUTH }, yes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth).toEqual({
        clientId: "cid",
        clientSecret: "csecret",
        sessionSecret: "ssecret",
        allowlist: "ana",
        callbackUrl: undefined,
      });
    }
  });

  it("development with no auth vars stays anonymous", () => {
    const result = validateProductionConfig({}, yes);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth).toBeUndefined();
  });

  it("development with a partial auth config is rejected", () => {
    const result = validateProductionConfig({ GITHUB_CLIENT_ID: "cid" }, yes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("GITHUB_CLIENT_SECRET");
  });

  it("development with a complete auth config enables auth", () => {
    const result = validateProductionConfig({ ...OK_AUTH }, yes);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth?.clientId).toBe("cid");
  });
});
