import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import type { RunQuery } from "../src/agentDriver.js";

const idleRun: RunQuery = async function* () {};

describe("static client serving", () => {
  let dist: string;
  let close: (() => Promise<void>) | undefined;
  let port = 0;

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-dist-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>mpai</title>");
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log(1)");
    const server = await startServer({ port: 0, runQuery: idleRun, staticDir: dist });
    close = server.close;
    port = server.port;
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("mpai");
  });

  it("serves assets with content types", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("falls back to index.html for extensionless paths (SPA deep links)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/anything?session=x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mpai");
  });

  it("404s missing assets", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/nope.js`);
    expect(res.status).toBe(404);
  });

  it("rejects path traversal", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
  });
});

describe("listen errors", () => {
  it("rejects startup when the port is in use", async () => {
    const first = await startServer({ port: 0, runQuery: idleRun });
    try {
      await expect(
        startServer({ port: first.port, runQuery: idleRun }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
