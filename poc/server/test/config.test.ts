import { describe, it, expect } from "vitest";
import {
  installShutdownHandlers,
  noUsableModelMessage,
  resolveBaseUrl,
  validateProductionConfig,
} from "../src/config.js";

const always = () => true;
const never = () => false;

// Boot capabilities (Task 4): main.ts computes these from the registry; the
// gate boots when EITHER is true. Anthropic creds power the built-ins direct;
// a routed model is served through the managed proxy.
const CAP_CREDS = { hasAnthropicCreds: true, hasRoutedModels: false };
const CAP_ROUTED = { hasAnthropicCreds: false, hasRoutedModels: true };
const CAP_NONE = { hasAnthropicCreds: false, hasRoutedModels: false };

describe("validateProductionConfig", () => {
  it("is a no-op in development, where CLIENT_DIST is unset", () => {
    // No key, no dist — dev must keep starting exactly as it does today.
    expect(validateProductionConfig({}, never, CAP_NONE)).toEqual({
      ok: true,
      staticDir: undefined,
    });
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
      CAP_CREDS,
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
      CAP_CREDS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("index.html");
  });
});

describe("usable-model boot gate (Task 4)", () => {
  const PROD_AUTH = {
    CLIENT_DIST: "/opt/app/dist",
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "csecret",
    SESSION_SECRET: "ssecret",
    GITHUB_ALLOWLIST: "ana",
  };

  it("prod, key only: boots when Anthropic creds are present and no routed models", () => {
    const result = validateProductionConfig(
      { ...PROD_AUTH, ANTHROPIC_API_KEY: "sk-test" },
      always,
      CAP_CREDS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.staticDir).toBe("/opt/app/dist");
  });

  it("prod, local only: boots with no creds when at least one routed model exists (old hard key gate removed)", () => {
    // No ANTHROPIC_API_KEY, no CLI creds — a routed (local) model is enough.
    const result = validateProductionConfig(PROD_AUTH, always, CAP_ROUTED);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.staticDir).toBe("/opt/app/dist");
  });

  it("prod, neither: refuses with the exact usable-model message (MPAI_HOME resolved)", () => {
    const env = { ...PROD_AUTH, MPAI_HOME: "/home/x/.mpai" };
    const result = validateProductionConfig(env, always, CAP_NONE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "no usable model: set ANTHROPIC_API_KEY or add a model to /home/x/.mpai/models.json",
      );
    }
  });

  it("the prod refusal reuses the shared noUsableModelMessage helper", () => {
    const env = { ...PROD_AUTH, MPAI_HOME: "/srv/mpai" };
    const result = validateProductionConfig(env, always, CAP_NONE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(noUsableModelMessage(env));
  });
});

describe("noUsableModelMessage (Task 4)", () => {
  it("resolves $MPAI_HOME to the models.json path when MPAI_HOME is set", () => {
    expect(noUsableModelMessage({ MPAI_HOME: "/home/x/.mpai" })).toBe(
      "no usable model: set ANTHROPIC_API_KEY or add a model to /home/x/.mpai/models.json",
    );
  });

  it("the development [boot] warning is this message with a [boot] prefix", () => {
    // main.ts emits `[boot] ${noUsableModelMessage(process.env)}` when dev has
    // neither creds nor routed models — assert the composed shape here.
    const env = { MPAI_HOME: "/home/x/.mpai" };
    expect(`[boot] ${noUsableModelMessage(env)}`).toBe(
      "[boot] no usable model: set ANTHROPIC_API_KEY or add a model to /home/x/.mpai/models.json",
    );
  });
});

describe("resolveBaseUrl (Task 4)", () => {
  it("proxy active: returns the proxy URL over the operator's value", () => {
    expect(resolveBaseUrl("https://op.example", "http://127.0.0.1:4010")).toBe(
      "http://127.0.0.1:4010",
    );
  });

  it("proxy absent: returns the operator's value unchanged", () => {
    expect(resolveBaseUrl("https://op.example", undefined)).toBe("https://op.example");
  });

  it("neither: returns undefined so the env var is left unset", () => {
    expect(resolveBaseUrl(undefined, undefined)).toBeUndefined();
  });
});

describe("installShutdownHandlers (Task 4)", () => {
  function fakeProc() {
    const handlers = new Map<string, () => void>();
    const calls: string[] = [];
    return {
      handlers,
      calls,
      on(ev: string, fn: () => void) {
        handlers.set(ev, fn);
      },
      exit(code: number) {
        calls.push(`exit(${code})`);
      },
    };
  }

  it("registers both SIGTERM and SIGINT handlers", () => {
    const proc = fakeProc();
    installShutdownHandlers(proc, { stop: () => {} });
    expect(proc.handlers.has("SIGTERM")).toBe(true);
    expect(proc.handlers.has("SIGINT")).toBe(true);
  });

  it("a simulated SIGTERM stops the proxy then exits with code 0, in that order", () => {
    const proc = fakeProc();
    const proxyManager = { stop: () => proc.calls.push("stop") };
    installShutdownHandlers(proc, proxyManager);
    proc.handlers.get("SIGTERM")!();
    expect(proc.calls).toEqual(["stop", "exit(0)"]);
  });

  it("a simulated SIGINT also stops then exits(0)", () => {
    const proc = fakeProc();
    const proxyManager = { stop: () => proc.calls.push("stop") };
    installShutdownHandlers(proc, proxyManager);
    proc.handlers.get("SIGINT")!();
    expect(proc.calls).toEqual(["stop", "exit(0)"]);
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
  it("production with no auth vars at all is rejected, not silently anonymous", () => {
    // The §4.4 headline case: CLIENT_DIST set, zero GITHUB_* vars — this must
    // never boot. Regression check: this fails if the staticDir branch of the
    // gate (config.ts) is ever dropped, e.g. `if (staticDir || authIntended)`
    // narrowed to `if (authIntended)`.
    const result = validateProductionConfig(OK_DIST, yes, CAP_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("GITHUB_CLIENT_ID");
  });

  it("production requires every auth variable", () => {
    for (const missing of Object.keys(OK_AUTH)) {
      const env: Record<string, string> = { ...OK_DIST, ...OK_AUTH };
      delete env[missing];
      const result = validateProductionConfig(env, yes, CAP_CREDS);
      expect(result.ok, `expected failure when ${missing} is absent`).toBe(false);
      if (!result.ok) expect(result.error).toContain(missing);
    }
  });

  it("production rejects a blank allowlist", () => {
    const result = validateProductionConfig(
      { ...OK_DIST, ...OK_AUTH, GITHUB_ALLOWLIST: "  " },
      yes,
      CAP_CREDS,
    );
    expect(result.ok).toBe(false);
  });

  it("production passes and builds an AuthConfig when all are present", () => {
    const result = validateProductionConfig({ ...OK_DIST, ...OK_AUTH }, yes, CAP_CREDS);
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
    const result = validateProductionConfig({}, yes, CAP_NONE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth).toBeUndefined();
  });

  it("development with a partial auth config is rejected", () => {
    const result = validateProductionConfig({ GITHUB_CLIENT_ID: "cid" }, yes, CAP_NONE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("GITHUB_CLIENT_SECRET");
  });

  it("development with a complete auth config enables auth", () => {
    const result = validateProductionConfig({ ...OK_AUTH }, yes, CAP_NONE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth?.clientId).toBe("cid");
  });

  it("dev SESSION_SECRET alone, with no GITHUB_CLIENT_ID, stays anonymous", () => {
    // Auth intent is signalled by GITHUB_CLIENT_ID specifically (spec §4.5),
    // not by any of the four auth vars. SESSION_SECRET is a generic name
    // that could plausibly already be set in someone's dev shell for
    // unrelated reasons and must not by itself force auth configuration.
    const result = validateProductionConfig({ SESSION_SECRET: "ssecret" }, yes, CAP_NONE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth).toBeUndefined();
  });
});
