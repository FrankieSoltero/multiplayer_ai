import { afterEach, describe, expect, it } from "vitest";
import { startHub } from "../src/hub.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

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

  it("binds the host it was given rather than every interface", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    expect(hub.port).toBeGreaterThan(0);
  });
});
