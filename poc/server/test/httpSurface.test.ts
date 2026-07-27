import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

let stop: (() => Promise<void>) | null = null;

afterEach(async () => {
  await stop?.();
  stop = null;
});

/** A dist dir whose index.html is unmistakable, so an SPA-fallback
 *  regression is visible in the assertion rather than inferred. */
function fakeDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-dist-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html>SPA FALLBACK</html>");
  return dir;
}

describe("/healthz", () => {
  it("returns JSON and not the SPA fallback HTML", async () => {
    // staticDir IS configured — this is the exact case the ordering bug hides in.
    const srv = await startServer({ port: 0, staticDir: fakeDist() });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("is registered even with no staticDir", async () => {
    const srv = await startServer({ port: 0 });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);

    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects non-GET methods", async () => {
    const srv = await startServer({ port: 0 });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { method: "POST" });

    expect(res.status).toBe(405);
  });

  it("404s an unknown path when no staticDir is configured", async () => {
    const srv = await startServer({ port: 0 });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/nope`);

    expect(res.status).toBe(404);
  });

  it("treats a single trailing slash as the same route", async () => {
    // staticDir IS configured — without the trailing-slash match this falls
    // through to the SPA fallback and returns HTML with a 200.
    const srv = await startServer({ port: 0, staticDir: fakeDist() });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("matches a percent-encoded spelling of the path", async () => {
    // /%68ealthz decodes to /healthz. Without decoding, this falls through
    // to the SPA fallback and returns HTML with a 200.
    const srv = await startServer({ port: 0, staticDir: fakeDist() });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/%68ealthz`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("host binding", () => {
  it("serves on the host it was given", async () => {
    const srv = await startServer({ port: 0, host: "127.0.0.1" });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);

    expect(res.status).toBe(200);
  });
});
