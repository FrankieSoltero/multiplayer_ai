import { describe, expect, it } from "vitest";
import { hubAuthFrom } from "../src/hubEnv.js";

/** The four vars that, together, configure auth. Intent is signalled by
 *  GITHUB_CLIENT_ID alone (mirrors config.ts / spec §4.5): all-or-nothing. */
describe("hubAuthFrom", () => {
  it("returns no auth when none of the four vars is set", () => {
    // A generic name like SESSION_SECRET could be set in a dev shell for an
    // unrelated reason; on its own it must not force auth or a boot failure.
    expect(hubAuthFrom({})).toEqual({ ok: true, auth: undefined });
    expect(hubAuthFrom({ SESSION_SECRET: "x" })).toEqual({ ok: true, auth: undefined });
  });

  it("builds a fully-trimmed AuthConfig when all four vars are set", () => {
    const result = hubAuthFrom({
      GITHUB_CLIENT_ID: "  cid  ",
      GITHUB_CLIENT_SECRET: "  csecret\n",
      SESSION_SECRET: "\tssecret ",
      GITHUB_ALLOWLIST: " alice, bob ",
      OAUTH_CALLBACK_URL: "  https://hub.example/auth/callback  ",
    });
    expect(result).toEqual({
      ok: true,
      auth: {
        clientId: "cid",
        clientSecret: "csecret",
        sessionSecret: "ssecret",
        allowlist: "alice, bob",
        callbackUrl: "https://hub.example/auth/callback",
      },
    });
  });

  it("omits callbackUrl when OAUTH_CALLBACK_URL is unset or empty", () => {
    const noVar = hubAuthFrom({
      GITHUB_CLIENT_ID: "cid",
      GITHUB_CLIENT_SECRET: "csecret",
      SESSION_SECRET: "ssecret",
      GITHUB_ALLOWLIST: "alice",
    });
    expect(noVar).toEqual({
      ok: true,
      auth: {
        clientId: "cid",
        clientSecret: "csecret",
        sessionSecret: "ssecret",
        allowlist: "alice",
        callbackUrl: undefined,
      },
    });
    const emptyVar = hubAuthFrom({
      GITHUB_CLIENT_ID: "cid",
      GITHUB_CLIENT_SECRET: "csecret",
      SESSION_SECRET: "ssecret",
      GITHUB_ALLOWLIST: "alice",
      OAUTH_CALLBACK_URL: "   ",
    });
    expect(emptyVar.ok).toBe(true);
    if (emptyVar.ok) expect(emptyVar.auth?.callbackUrl).toBeUndefined();
  });

  it("refuses a partial config, naming the missing var (config.ts:44 wording)", () => {
    const result = hubAuthFrom({
      GITHUB_CLIENT_ID: "cid",
      GITHUB_CLIENT_SECRET: "csecret",
      // SESSION_SECRET missing
      GITHUB_ALLOWLIST: "alice",
    });
    expect(result).toEqual({
      ok: false,
      error:
        "SESSION_SECRET is required once GITHUB_CLIENT_ID is set — configure auth fully or not at all",
    });
  });

  it("treats a whitespace-only required var as missing", () => {
    const result = hubAuthFrom({
      GITHUB_CLIENT_ID: "cid",
      GITHUB_CLIENT_SECRET: "csecret",
      SESSION_SECRET: "ssecret",
      GITHUB_ALLOWLIST: "   ",
    });
    expect(result).toEqual({
      ok: false,
      error:
        "GITHUB_ALLOWLIST is required once GITHUB_CLIENT_ID is set — configure auth fully or not at all",
    });
  });
});
