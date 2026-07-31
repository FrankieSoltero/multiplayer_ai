import http from "node:http";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, type AuthConfig } from "multiplayer-ai-server/auth";
import type { DeviceStore } from "../src/hubDb.js";
import {
  pairingRoutes,
  hashToken,
  PAIRING_CODE_TTL_MS,
  MAX_PENDING_PAIRINGS,
} from "../src/pairing.js";

const AUTH: AuthConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  sessionSecret: "test-secret",
  allowlist: "alice",
};

/** A DeviceStore fake that records calls and lets a test choose what
 *  `deviceRevoked` returns. */
class FakeDevices implements DeviceStore {
  approvedCalls: Array<{
    machineId: string;
    name: string;
    tokenHash: string;
    approvedBy: string;
    approvedAt: string;
  }> = [];
  revokedCalls: string[] = [];
  revokedReturn = true;
  deviceApproved(d: {
    machineId: string;
    name: string;
    tokenHash: string;
    approvedBy: string;
    approvedAt: string;
  }): void {
    this.approvedCalls.push(d);
  }
  deviceByTokenHash(): { machineId: string; name: string } | null {
    return null;
  }
  deviceRevoked(machineId: string): boolean {
    this.revokedCalls.push(machineId);
    return this.revokedReturn;
  }
}

type Deps = Parameters<typeof pairingRoutes>[0];

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** Mounts the handler on a real http server, so tests exercise the exact
 *  IncomingMessage/ServerResponse path production uses. A non-consumed request
 *  (handler returned false) gets a recognisable passthrough answer. */
function serve(deps: Deps): Promise<{ base: string }> {
  const handler = pairingRoutes(deps);
  const server = http.createServer((req, res) => {
    const consumed = handler(req, res);
    if (!consumed) {
      res.writeHead(418, { "content-type": "text/plain" });
      res.end("passthrough");
    }
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}` });
    });
  });
}

function post(
  base: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const cookieFor = (login: string) => `${SESSION_COOKIE}=${signSession(login, AUTH.sessionSecret)}`;

describe("pairing constants", () => {
  it("exports the exact TTL and pending cap the spec fixes", () => {
    expect(PAIRING_CODE_TTL_MS).toBe(600_000);
    expect(MAX_PENDING_PAIRINGS).toBe(100);
  });

  it("hashToken is sha256 hex of the token", () => {
    const token = "some-token";
    const expected = crypto.createHash("sha256").update(token).digest("hex");
    expect(hashToken(token)).toBe(expected);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pairing routes — gating", () => {
  it("passes non-/pair paths through (handler returns false)", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("passthrough");
  });

  it("404s any /pair/* with a JSON error when auth is off", async () => {
    const { base } = await serve({ auth: undefined, devices: new FakeDevices(), onRevoked: () => {} });
    const res = await post(base, "/pair/request", { machineId: "m1", name: "laptop" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "auth is not configured" });
  });

  it("503s when auth is on but there is no device store", async () => {
    const { base } = await serve({ auth: AUTH, devices: null, onRevoked: () => {} });
    const res = await post(base, "/pair/request", { machineId: "m1", name: "laptop" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "pairing requires a persistent hub record — set HUB_DB",
    });
  });
});

describe("pairing routes — request", () => {
  it("issues an 8-char code from the unambiguous alphabet", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const res = await post(base, "/pair/request", { machineId: "m1", name: "laptop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
  });

  it("400s a missing or malformed machineId or name", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    for (const body of [
      {},
      { machineId: "m1" },
      { name: "laptop" },
      { machineId: "bad id with spaces", name: "laptop" },
      { machineId: "m1", name: "" },
      { machineId: "m1", name: "x".repeat(41) },
      "not json at all",
    ]) {
      const res = await post(base, "/pair/request", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "pair request requires machineId and name",
      });
    }
  });

  it("429s once MAX_PENDING_PAIRINGS codes are outstanding", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    for (let i = 0; i < MAX_PENDING_PAIRINGS; i += 1) {
      const res = await post(base, "/pair/request", { machineId: `m${i}`, name: "laptop" });
      expect(res.status).toBe(200);
    }
    const overflow = await post(base, "/pair/request", { machineId: "extra", name: "laptop" });
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toEqual({ error: "too many pending pairings" });
  });

  it("413s a request body over 4096 bytes", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const huge = JSON.stringify({ machineId: "m1", name: "x", pad: "z".repeat(5000) });
    const res = await post(base, "/pair/request", huge);
    expect(res.status).toBe(413);
  });
});

describe("pairing routes — approve", () => {
  async function requestCode(base: string): Promise<string> {
    const res = await post(base, "/pair/request", { machineId: "m1", name: "Alice laptop" });
    return ((await res.json()) as { code: string }).code;
  }

  it("mints a token, records it hashed under the approver, returns the device", async () => {
    const devices = new FakeDevices();
    const { base } = await serve({ auth: AUTH, devices, onRevoked: () => {} });
    const code = await requestCode(base);

    const res = await post(base, "/pair/approve", { code }, cookieFor("alice"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machineId: "m1", name: "Alice laptop" });

    expect(devices.approvedCalls).toHaveLength(1);
    const call = devices.approvedCalls[0];
    expect(call.machineId).toBe("m1");
    expect(call.name).toBe("Alice laptop");
    expect(call.approvedBy).toBe("alice");
    expect(call.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts a lowercased, dash-grouped code (normalised before compare)", async () => {
    const devices = new FakeDevices();
    const { base } = await serve({ auth: AUTH, devices, onRevoked: () => {} });
    const code = await requestCode(base);
    const grouped = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    const res = await post(base, "/pair/approve", { code: grouped }, cookieFor("alice"));
    expect(res.status).toBe(200);
  });

  it("401s an anonymous approve", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const code = await requestCode(base);
    const res = await post(base, "/pair/approve", { code });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "authentication required" });
  });

  it("403s an authenticated but non-allowlisted approve", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const code = await requestCode(base);
    const res = await post(base, "/pair/approve", { code }, cookieFor("mallory"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not on the allowlist" });
  });

  it("404s an unknown code", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const res = await post(base, "/pair/approve", { code: "ZZZZZZZZ" }, cookieFor("alice"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown or expired code" });
  });

  it("404s an expired code (lazy TTL via the now seam)", async () => {
    let clock = 1_000_000;
    const { base } = await serve({
      auth: AUTH,
      devices: new FakeDevices(),
      onRevoked: () => {},
      now: () => clock,
    });
    const code = await requestCode(base);
    clock += PAIRING_CODE_TTL_MS + 1;
    const res = await post(base, "/pair/approve", { code }, cookieFor("alice"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown or expired code" });
  });
});

describe("pairing routes — poll", () => {
  async function requestCode(base: string): Promise<string> {
    const res = await post(base, "/pair/request", { machineId: "m1", name: "laptop" });
    return ((await res.json()) as { code: string }).code;
  }

  it("reports pending before approval", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const code = await requestCode(base);
    const res = await post(base, "/pair/poll", { code });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("hands the token to the first poll then 404s the second (single-use)", async () => {
    const devices = new FakeDevices();
    const { base } = await serve({ auth: AUTH, devices, onRevoked: () => {} });
    const code = await requestCode(base);
    await post(base, "/pair/approve", { code }, cookieFor("alice"));

    const first = await post(base, "/pair/poll", { code });
    expect(first.status).toBe(200);
    const token = ((await first.json()) as { token: string }).token;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    // The plaintext token is never stored; only its hash reached the store.
    expect(devices.approvedCalls[0].tokenHash).toBe(hashToken(token));

    const second = await post(base, "/pair/poll", { code });
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "unknown or expired code" });
  });

  it("404s a poll for an unknown code", async () => {
    const { base } = await serve({ auth: AUTH, devices: new FakeDevices(), onRevoked: () => {} });
    const res = await post(base, "/pair/poll", { code: "ZZZZZZZZ" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown or expired code" });
  });
});

describe("pairing routes — revoke", () => {
  it("revokes, fires onRevoked, and reports revoked:true", async () => {
    const devices = new FakeDevices();
    let revokedArg: string | null = null;
    const { base } = await serve({
      auth: AUTH,
      devices,
      onRevoked: (id) => {
        revokedArg = id;
      },
    });
    const res = await post(base, "/pair/revoke", { machineId: "m1" }, cookieFor("alice"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(devices.revokedCalls).toEqual(["m1"]);
    expect(revokedArg).toBe("m1");
  });

  it("404s and does NOT fire onRevoked when nothing was revoked", async () => {
    const devices = new FakeDevices();
    devices.revokedReturn = false;
    let fired = false;
    const { base } = await serve({
      auth: AUTH,
      devices,
      onRevoked: () => {
        fired = true;
      },
    });
    const res = await post(base, "/pair/revoke", { machineId: "ghost" }, cookieFor("alice"));
    expect(res.status).toBe(404);
    expect(fired).toBe(false);
  });

  it("401s an anonymous revoke and 403s a non-allowlisted one", async () => {
    const devices = new FakeDevices();
    const { base } = await serve({ auth: AUTH, devices, onRevoked: () => {} });
    const anon = await post(base, "/pair/revoke", { machineId: "m1" });
    expect(anon.status).toBe(401);
    const denied = await post(base, "/pair/revoke", { machineId: "m1" }, cookieFor("mallory"));
    expect(denied.status).toBe(403);
    // Neither refusal reached the store.
    expect(devices.revokedCalls).toEqual([]);
  });
});
