import { describe, expect, it } from "vitest";
import type { AuthConfig } from "multiplayer-ai-server/auth";
import { hubAuthFrom, hubConfigFrom, opsBootLines, type HubOpsConfig } from "../src/hubEnv.js";

/** A minimally-populated auth config: its presence, not its contents, is what
 *  unlocks a non-loopback HOST. */
const someAuth: AuthConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  sessionSecret: "ssecret",
  allowlist: "alice",
  callbackUrl: undefined,
};

/** The all-defaults config, so boot-line tests can vary one field at a time. */
const defaultConfig: HubOpsConfig = {
  port: 4000,
  host: "127.0.0.1",
  origin: null,
  retentionDays: null,
  backup: null,
  minFreeBytes: 104857600,
  trustProxy: false,
};

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

describe("hubConfigFrom", () => {
  it("returns all defaults when no ops vars are set (auth undefined)", () => {
    expect(hubConfigFrom({}, undefined)).toEqual({
      ok: true,
      config: {
        port: 4000,
        host: "127.0.0.1",
        origin: null,
        retentionDays: null,
        backup: null,
        minFreeBytes: 104857600,
        trustProxy: false,
      },
    });
  });

  it("refuses a non-integer PORT, closing the Number()→NaN→port-0 hole", () => {
    expect(hubConfigFrom({ PORT: "41a2" }, undefined)).toEqual({
      ok: false,
      error: 'PORT must be an integer between 1 and 65535 (got "41a2")',
    });
  });

  it("refuses an out-of-range PORT (0 and 70000)", () => {
    expect(hubConfigFrom({ PORT: "0" }, undefined)).toEqual({
      ok: false,
      error: 'PORT must be an integer between 1 and 65535 (got "0")',
    });
    expect(hubConfigFrom({ PORT: "70000" }, undefined)).toEqual({
      ok: false,
      error: 'PORT must be an integer between 1 and 65535 (got "70000")',
    });
  });

  it("accepts an in-range PORT", () => {
    const r = hubConfigFrom({ PORT: "8080" }, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.port).toBe(8080);
  });

  it("refuses a non-loopback HOST when auth is not configured (fail-closed)", () => {
    expect(hubConfigFrom({ HOST: "0.0.0.0" }, undefined)).toEqual({
      ok: false,
      error:
        "HOST=0.0.0.0 is not loopback and auth is not configured — refusing to boot; set the GITHUB_* auth vars or keep HOST on 127.0.0.1",
    });
  });

  it("allows a non-loopback HOST once auth is configured", () => {
    const r = hubConfigFrom({ HOST: "0.0.0.0" }, someAuth);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.host).toBe("0.0.0.0");
  });

  it("allows each loopback HOST with no auth — dev flow unchanged", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      const r = hubConfigFrom({ HOST: host }, undefined);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.host).toBe(host);
    }
  });

  it("carries a bare HUB_ORIGIN verbatim and rejects a non-bare one", () => {
    const ok = hubConfigFrom({ HUB_ORIGIN: "https://hub.example.com" }, undefined);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.origin).toBe("https://hub.example.com");

    expect(hubConfigFrom({ HUB_ORIGIN: "https://hub.example.com/app" }, undefined)).toEqual({
      ok: false,
      error: 'HUB_ORIGIN must be a bare origin like https://hub.example.com (got "https://hub.example.com/app")',
    });
    expect(hubConfigFrom({ HUB_ORIGIN: "not-a-url" }, undefined)).toEqual({
      ok: false,
      error: 'HUB_ORIGIN must be a bare origin like https://hub.example.com (got "not-a-url")',
    });
  });

  it("accepts a positive-integer retention and rejects 0/negative/non-integer", () => {
    const r = hubConfigFrom({ HUB_RETENTION_DAYS: "30" }, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.retentionDays).toBe(30);

    for (const bad of ["0", "-5", "3.5"]) {
      const res = hubConfigFrom({ HUB_RETENTION_DAYS: bad }, undefined);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("HUB_RETENTION_DAYS");
    }
  });

  it("keeps forever (null) when retention is unset or empty", () => {
    const unset = hubConfigFrom({}, undefined);
    if (unset.ok) expect(unset.config.retentionDays).toBeNull();
    const empty = hubConfigFrom({ HUB_RETENTION_DAYS: "  " }, undefined);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.config.retentionDays).toBeNull();
  });

  it("builds a default backup block from HUB_BACKUP_DIR alone", () => {
    const r = hubConfigFrom({ HUB_BACKUP_DIR: "/var/backups/mpai" }, undefined);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.config.backup).toEqual({ dir: "/var/backups/mpai", intervalMs: 86400000, keep: 7 });
  });

  it("honours HUB_BACKUP_INTERVAL_MS and HUB_BACKUP_KEEP overrides", () => {
    const r = hubConfigFrom(
      { HUB_BACKUP_DIR: "/d", HUB_BACKUP_INTERVAL_MS: "60000", HUB_BACKUP_KEEP: "3" },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.backup).toEqual({ dir: "/d", intervalMs: 60000, keep: 3 });
  });

  it("rejects a backup interval below the 60000ms floor and keep below 1", () => {
    const interval = hubConfigFrom(
      { HUB_BACKUP_DIR: "/d", HUB_BACKUP_INTERVAL_MS: "59999" },
      undefined,
    );
    expect(interval.ok).toBe(false);
    if (!interval.ok) expect(interval.error).toContain("HUB_BACKUP_INTERVAL_MS");

    const keep = hubConfigFrom({ HUB_BACKUP_DIR: "/d", HUB_BACKUP_KEEP: "0" }, undefined);
    expect(keep.ok).toBe(false);
    if (!keep.ok) expect(keep.error).toContain("HUB_BACKUP_KEEP");
  });

  it("refuses backup knobs set without HUB_BACKUP_DIR", () => {
    expect(hubConfigFrom({ HUB_BACKUP_INTERVAL_MS: "60000" }, undefined)).toEqual({
      ok: false,
      error: "HUB_BACKUP_INTERVAL_MS/HUB_BACKUP_KEEP require HUB_BACKUP_DIR",
    });
    expect(hubConfigFrom({ HUB_BACKUP_KEEP: "3" }, undefined)).toEqual({
      ok: false,
      error: "HUB_BACKUP_INTERVAL_MS/HUB_BACKUP_KEEP require HUB_BACKUP_DIR",
    });
  });

  it("accepts a non-negative HUB_MIN_FREE_BYTES and rejects negative/non-integer", () => {
    const r = hubConfigFrom({ HUB_MIN_FREE_BYTES: "52428800" }, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.minFreeBytes).toBe(52428800);

    for (const bad of ["-1", "1.5", "abc"]) {
      const res = hubConfigFrom({ HUB_MIN_FREE_BYTES: bad }, undefined);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("HUB_MIN_FREE_BYTES");
    }
  });

  it("sets trustProxy only for HUB_TRUST_PROXY=1", () => {
    const on = hubConfigFrom({ HUB_TRUST_PROXY: "1" }, undefined);
    if (on.ok) expect(on.config.trustProxy).toBe(true);
    for (const other of ["0", "true", "yes", ""]) {
      const r = hubConfigFrom({ HUB_TRUST_PROXY: other }, undefined);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.trustProxy).toBe(false);
    }
  });
});

describe("opsBootLines", () => {
  it("prints nothing when every control is default/disabled", () => {
    expect(opsBootLines(defaultConfig)).toEqual([]);
  });

  it("prints one exact line per enabled/non-default control, in order", () => {
    expect(opsBootLines({ ...defaultConfig, retentionDays: 30 })).toEqual(["retention: 30d"]);
    expect(
      opsBootLines({ ...defaultConfig, backup: { dir: "/d", intervalMs: 60000, keep: 3 } }),
    ).toEqual(["backups: /d every 60000ms keep 3"]);
    expect(opsBootLines({ ...defaultConfig, origin: "https://hub.example.com" })).toEqual([
      "origin check: https://hub.example.com",
    ]);
    expect(opsBootLines({ ...defaultConfig, minFreeBytes: 52428800 })).toEqual([
      "min free bytes: 52428800",
    ]);
    expect(opsBootLines({ ...defaultConfig, trustProxy: true })).toEqual([
      "trusting proxy headers for client ip",
    ]);
  });

  it("prints nothing for min free bytes at the default", () => {
    expect(opsBootLines({ ...defaultConfig, minFreeBytes: 104857600 })).toEqual([]);
  });

  it("emits all enabled controls in retention→backup→origin→headroom→proxy order", () => {
    expect(
      opsBootLines({
        port: 4000,
        host: "0.0.0.0",
        origin: "https://hub.example.com",
        retentionDays: 30,
        backup: { dir: "/d", intervalMs: 86400000, keep: 7 },
        minFreeBytes: 52428800,
        trustProxy: true,
      }),
    ).toEqual([
      "retention: 30d",
      "backups: /d every 86400000ms keep 7",
      "origin check: https://hub.example.com",
      "min free bytes: 52428800",
      "trusting proxy headers for client ip",
    ]);
  });
});
