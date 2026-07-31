import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, type AuthConfig } from "multiplayer-ai-server/auth";
import { startHub } from "../src/hub.js";

let close: (() => Promise<void>) | undefined;
const tmpDirs: string[] = [];
afterEach(async () => {
  await close?.();
  close = undefined;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A dist dir with a recognisable index.html, so the SPA fallback is active
 *  and any route mounted AFTER `serveStatic` would be swallowed by it. */
function staticDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubhttp-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>spa</title>");
  return dir;
}

const AUTH: AuthConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  sessionSecret: "test-secret",
  allowlist: "alice",
};

describe("hub HTTP surface", () => {
  it("serves /healthz as JSON, not the SPA page", async () => {
    // Same ordering trap A1a documented for the server: the static handler's
    // SPA fallback serves index.html for any extensionless path, so a health
    // route wired after it returns HTML with a 200 — a probe that passes
    // forever while the hub is broken. Assert the BODY, not the status.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ status: "ok" }));
  });

  it("rejects a non-GET /healthz with 405", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/healthz`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("404s an unknown path in plain text when no client is configured", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("reports the ephemeral port it actually bound, and serves on the host it was given", async () => {
    // Renamed from "binds the host it was given rather than every interface",
    // which asserted only `port > 0` — a name that promised an isolation
    // property nothing checked. What is checked: `port` is the port the OS
    // handed out (it must be reachable, not merely non-zero) and the hub
    // answers there on the requested host.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    expect(hub.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${hub.port}/healthz`);
    expect(res.status).toBe(200);

    // The negative half, stated with its own caveat: nothing may be listening
    // on that port at the IPv6 loopback. This cannot FALSELY fail — a host
    // with no IPv6 also refuses — so it can pass vacuously, and a stronger
    // claim would need a second interface this test cannot assume.
    await expect(
      new Promise((resolve, reject) => {
        const socket = createConnection({ host: "::1", port: hub.port });
        socket.setTimeout(2000, () => socket.destroy(new Error("timed out")));
        socket.on("connect", () => { socket.destroy(); resolve("connected"); });
        socket.on("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("mounts authRoutes ahead of the SPA fallback when auth is on", async () => {
    // The whole point of the ordering (after /healthz, before serveStatic):
    // with a real dist dir active, /auth/me must be answered by authRoutes as
    // JSON, never swallowed by the extensionless-path SPA fallback. No cookie,
    // so this is authRoutes' own refusal branch — 401 {enabled:true}.
    const hub = await startHub({ port: 0, host: "127.0.0.1", staticDir: staticDir(), auth: AUTH });
    close = hub.close;

    // Proof the SPA fallback is genuinely active: an extensionless path DOES
    // return index.html. If /auth/me were mounted after it, it would too.
    const spa = await fetch(`http://127.0.0.1:${hub.port}/some/spa/route`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const me = await fetch(`http://127.0.0.1:${hub.port}/auth/me`);
    expect(me.status).toBe(401);
    expect(me.headers.get("content-type")).toBe("application/json");
    expect(await me.json()).toEqual({ enabled: true });
  });

  it("passes a valid allowlisted session through /auth/me when auth is on", async () => {
    // The pass-through half: a cookie this hub's sessionSecret signed, for a
    // login on the allowlist, gets the authenticated answer.
    const hub = await startHub({ port: 0, host: "127.0.0.1", staticDir: staticDir(), auth: AUTH });
    close = hub.close;
    const cookie = `${SESSION_COOKIE}=${signSession("alice", AUTH.sessionSecret)}`;
    const res = await fetch(`http://127.0.0.1:${hub.port}/auth/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, login: "alice", allowlisted: true });
  });

  it("answers /auth/me with {enabled:false} when auth is off, not the SPA page", async () => {
    // authRoutes(undefined) is mounted anyway (spec §4.2): the client must be
    // able to tell "auth is off" from "auth is broken", which the SPA fallback
    // — index.html with a 200 — cannot express.
    const hub = await startHub({ port: 0, host: "127.0.0.1", staticDir: staticDir() });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/auth/me`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ enabled: false });
  });
});
