import { describe, it, expect } from "vitest";
import {
  parseCookies,
  signSession,
  verifySession,
  isAllowlisted,
  SESSION_MAX_AGE_MS,
} from "../src/auth.js";
import { authRoutes, safeNext, type AuthConfig } from "../src/auth.js";
import { createServer, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const SECRET = "test-secret-do-not-use";

describe("parseCookies", () => {
  it("parses a normal header", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("returns empty for undefined or blank", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("keeps '=' inside a value", () => {
    expect(parseCookies("t=aa.bb==")).toEqual({ t: "aa.bb==" });
  });

  it("ignores malformed segments without throwing", () => {
    expect(parseCookies("novalue; a=1")).toEqual({ a: "1" });
  });
});

describe("signSession / verifySession", () => {
  it("round-trips a login", () => {
    const cookie = signSession("ana", SECRET);
    expect(verifySession(cookie, SECRET)).toEqual({ login: "ana" });
  });

  it("rejects a tampered payload", () => {
    const cookie = signSession("ana", SECRET);
    const [, sig] = cookie.split(".");
    const forged = Buffer.from(JSON.stringify({ login: "root", iat: Date.now() }))
      .toString("base64url");
    expect(verifySession(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const cookie = signSession("ana", SECRET);
    const [payload] = cookie.split(".");
    expect(verifySession(`${payload}.deadbeef`, SECRET)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = signSession("ana", "other-secret");
    expect(verifySession(cookie, SECRET)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const issued = 1_000_000;
    const cookie = signSession("ana", SECRET, issued);
    expect(verifySession(cookie, SECRET, issued + SESSION_MAX_AGE_MS + 1)).toBeNull();
    expect(verifySession(cookie, SECRET, issued + SESSION_MAX_AGE_MS - 1)).toEqual({
      login: "ana",
    });
  });

  it("returns null for undefined, empty, and malformed values", () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession("", SECRET)).toBeNull();
    expect(verifySession("no-dot", SECRET)).toBeNull();
    expect(verifySession("!!!.!!!", SECRET)).toBeNull();
  });
});

describe("isAllowlisted", () => {
  it("matches exactly", () => {
    expect(isAllowlisted("ana", "ana,ben")).toBe(true);
  });

  it("is case-insensitive (GitHub logins are)", () => {
    expect(isAllowlisted("Ana", "ana,ben")).toBe(true);
    expect(isAllowlisted("ana", "ANA")).toBe(true);
  });

  it("tolerates whitespace around entries", () => {
    expect(isAllowlisted("ben", " ana , ben ")).toBe(true);
  });

  it("rejects a login that is not listed", () => {
    expect(isAllowlisted("mallory", "ana,ben")).toBe(false);
  });

  it("rejects everyone when the list is empty or blank", () => {
    expect(isAllowlisted("ana", "")).toBe(false);
    expect(isAllowlisted("ana", "   ")).toBe(false);
    expect(isAllowlisted("ana", ",,")).toBe(false);
  });

  it("does not match on a substring", () => {
    expect(isAllowlisted("an", "ana")).toBe(false);
  });
});

function testConfig(over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: SECRET,
    allowlist: "ana,ben",
    exchangeCode: async () => ({ login: "ana" }),
    ...over,
  };
}

/** Runs authRoutes behind a real HTTP server so redirects, headers, and
 *  status codes are exercised the way the browser will see them. */
async function withRoutes(
  cfg: AuthConfig | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const handle = authRoutes(cfg);
  const srv = createServer((req, res) => {
    if (handle(req, res)) return;
    res.writeHead(404);
    res.end("fell through");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

describe("safeNext", () => {
  it("keeps a same-origin path", () => {
    expect(safeNext("/?invite=abc")).toBe("/?invite=abc");
  });

  it("rejects protocol-relative and absolute URLs (open redirect)", () => {
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("\\\\evil.example")).toBe("/");
  });

  it("falls back to / for null or non-path values", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("relative")).toBe("/");
  });

  // A literal control character in "next" is legal in an HTTP header value
  // to Node's writer, but the WHATWG URL parser every browser uses strips
  // TAB/LF/CR before parsing — turning "/\t/evil.example" into
  // "//evil.example" client-side. These attack the control, not the
  // implementation's prefix list.
  it("rejects a next containing a raw or percent-decoded control character", () => {
    expect(safeNext("/\t/evil.example")).toBe("/");
    expect(safeNext("/\r/evil.example")).toBe("/");
    expect(safeNext("/\n/evil.example")).toBe("/");
    expect(safeNext(decodeURIComponent("%2F%09%2Fevil.example"))).toBe("/");
    expect(safeNext(decodeURIComponent("%2F%0D%2Fevil.example"))).toBe("/");
    expect(safeNext(decodeURIComponent("%2F%0A%2Fevil.example"))).toBe("/");
  });

  it("rejects a backslash-based path that the URL parser would treat as a new authority", () => {
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/\\/evil.example")).toBe("/");
  });
});

describe("authRoutes", () => {
  it("does not handle unrelated paths", async () => {
    await withRoutes(testConfig(), async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(await res.text()).toBe("fell through");
    });
  });

  it("/auth/me reports disabled when auth is not configured", async () => {
    await withRoutes(undefined, async (base) => {
      const res = await fetch(`${base}/auth/me`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false });
    });
  });

  it("/auth/login redirects to GitHub and sets a state cookie", async () => {
    await withRoutes(testConfig(), async (base) => {
      const res = await fetch(`${base}/auth/login`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("https://github.com/login/oauth/authorize");
      expect(location).toContain("client_id=cid");
      expect(location).toContain("scope=read%3Auser");
      expect(res.headers.get("set-cookie")).toContain("mpai_oauth_state=");
      expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    });
  });

  it("/auth/callback rejects a mismatched state", async () => {
    let exchangeCalls = 0;
    const cfg = testConfig({
      exchangeCode: async () => {
        exchangeCalls++;
        return { login: "ana" };
      },
    });
    await withRoutes(cfg, async (base) => {
      const res = await fetch(`${base}/auth/callback?code=x&state=wrong`, {
        headers: { cookie: "mpai_oauth_state=right" },
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("state");
      // Proves the state check gates the exchange rather than merely
      // discarding its result — a refactor that fires exchange concurrently
      // with the state check would still 400 here but would fail this
      // assertion.
      expect(exchangeCalls).toBe(0);
    });
  });

  it("/auth/callback rejects a next carrying a control character end-to-end", async () => {
    await withRoutes(testConfig(), async (base) => {
      const res = await fetch(
        `${base}/auth/callback?code=x&state=s1&next=%2F%09%2Fevil.example`,
        { headers: { cookie: "mpai_oauth_state=s1" }, redirect: "manual" },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    });
  });

  it("/auth/callback sets a session cookie and honours next", async () => {
    await withRoutes(testConfig(), async (base) => {
      const res = await fetch(
        `${base}/auth/callback?code=x&state=s1&next=%2F%3Finvite%3Dabc`,
        { headers: { cookie: "mpai_oauth_state=s1" }, redirect: "manual" },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?invite=abc");
      const cookies = res.headers.getSetCookie().join("|");
      expect(cookies).toContain("mpai_session=");
      expect(cookies).toContain("HttpOnly");
      expect(cookies).toContain("SameSite=Lax");
    });
  });

  it("/auth/callback refuses an off-site next", async () => {
    await withRoutes(testConfig(), async (base) => {
      const res = await fetch(
        `${base}/auth/callback?code=x&state=s1&next=%2F%2Fevil.example`,
        { headers: { cookie: "mpai_oauth_state=s1" }, redirect: "manual" },
      );
      expect(res.headers.get("location")).toBe("/");
    });
  });

  it("/auth/callback surfaces an exchange failure", async () => {
    const cfg = testConfig({ exchangeCode: async () => ({ error: "bad code" }) });
    await withRoutes(cfg, async (base) => {
      const res = await fetch(`${base}/auth/callback?code=x&state=s1`, {
        headers: { cookie: "mpai_oauth_state=s1" },
        redirect: "manual",
      });
      expect(res.status).toBe(401);
    });
  });

  it("/auth/callback returns 5xx instead of a dead socket when the success handler throws", async () => {
    // Forces the redirect branch's res.writeHead to throw, independent of
    // any particular bad "next" value, to prove the route's failure
    // handling covers a throw inside the success path generally — not just
    // the specific safeNext bypass this suite also regression-tests.
    const originalWriteHead = ServerResponse.prototype.writeHead;
    let forced = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ServerResponse.prototype as any).writeHead = function (...args: unknown[]) {
      if (!forced && args[0] === 302) {
        forced = true;
        throw new Error("simulated failure writing the redirect response");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalWriteHead as any).apply(this, args);
    };
    try {
      await withRoutes(testConfig(), async (base) => {
        const res = await fetch(`${base}/auth/callback?code=x&state=s1`, {
          headers: { cookie: "mpai_oauth_state=s1" },
          redirect: "manual",
        });
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(res.status).toBeLessThan(600);
      });
    } finally {
      ServerResponse.prototype.writeHead = originalWriteHead;
    }
    expect(forced).toBe(true);
  });

  it("/auth/me is 401 signed out and 200 signed in", async () => {
    await withRoutes(testConfig(), async (base) => {
      const out = await fetch(`${base}/auth/me`);
      expect(out.status).toBe(401);
      expect(await out.json()).toEqual({ enabled: true });

      const cookie = `${"mpai_session"}=${signSession("ana", SECRET)}`;
      const inRes = await fetch(`${base}/auth/me`, { headers: { cookie } });
      expect(inRes.status).toBe(200);
      expect(await inRes.json()).toEqual({
        enabled: true,
        login: "ana",
        allowlisted: true,
      });
    });
  });

  it("/auth/me reports allowlisted:false for a verified but unlisted user", async () => {
    await withRoutes(testConfig({ allowlist: "ben" }), async (base) => {
      const cookie = `mpai_session=${signSession("ana", SECRET)}`;
      const res = await fetch(`${base}/auth/me`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        enabled: true,
        login: "ana",
        allowlisted: false,
      });
    });
  });

  it("/auth/logout clears the session cookie", async () => {
    await withRoutes(testConfig(), async (base) => {
      const res = await fetch(`${base}/auth/logout`, { method: "POST" });
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });
});
