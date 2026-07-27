# A2a — GitHub OAuth, Allowlist, Verified Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the client-asserted `userId` with a GitHub-verified identity, gated by a username allowlist, so every decision on the wire carries a name that cannot be forged.

**Architecture:** A new `auth.ts` server module owns the OAuth authorization-code flow and a signed, httpOnly session cookie. Its four routes are composed into the existing HTTP handler between `/healthz` and the static handler. The WS `join` handler reads the cookie off the upgrade request and overwrites `userId` with the verified GitHub login. Auth activates only when `GITHUB_CLIENT_ID` is set; production mode refuses to boot without it.

**Tech Stack:** TypeScript, Node `node:crypto` (HMAC), `ws`, React, vitest. No new dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-27-a2a-github-oauth-design.md`. Section refs below point there.
- **No new npm dependencies.** HMAC comes from `node:crypto`, the token exchange from `fetch`.
- **Auth is off unless `GITHUB_CLIENT_ID` is set.** Every existing test, demo recipe, and `?name=alice` deep link must keep passing untouched (spec §5).
- **Baselines to hold green:** server 227 tests, client 120 tests, both `tsc --noEmit` clean, client build clean. Each task ends green.
- **Server tests live in `poc/server/test/*.test.ts`** (not `src/`); client tests are co-located in `poc/client/src/`.
- **No component-test infrastructure on the client.** Extract pure functions and test those; UI is verified by driving a real browser.
- **Handler ordering is load-bearing.** The static handler's SPA fallback (`staticFiles.ts:51-53`) serves `index.html` for any extensionless path. Any route registered after it returns HTML with a 200. Assert response **bodies**, not just statuses.
- **Never commit** `market-research.md`, `poc/demo-plugins/`, or `tour-skill-suggest.png`. Use explicit `git add <paths>` in every commit.
- **Cookie name:** `mpai_session`. **State cookie:** `mpai_oauth_state`.
- **OAuth scope:** `read:user` and nothing more (least privilege).

---

## File Structure

**Create:**
- `poc/server/src/auth.ts` — cookie signing/verification, allowlist matching, the four `/auth/*` routes
- `poc/server/test/auth.test.ts` — tests for the above
- `poc/client/src/authState.ts` — pure client-side auth-state derivation and URL building
- `poc/client/src/authState.test.ts`
- `poc/client/src/components/Landing.tsx` — signed-out root screen
- `poc/client/src/components/InviteSignIn.tsx` — signed-out with an invite token
- `poc/client/src/components/Denied.tsx` — authenticated but not allowlisted

**Modify:**
- `poc/server/src/config.ts` — production requires the auth vars; returns a built `AuthConfig`
- `poc/server/src/server.ts` — `auth` option, route composition, `req` on the WS connection, join gate
- `poc/server/src/main.ts` — pass `config.auth` through
- `poc/server/test/config.test.ts`, `test/httpSurface.test.ts`, `test/server.test.ts`
- `poc/client/src/types.ts` — `API_BASE`
- `poc/client/src/App.tsx` — routing precedence
- `poc/client/src/components/Lobby.tsx` — name locked to the GitHub login
- `poc/client/src/terminal.css` — styles for the three new screens

---

### Task 1: Auth primitives — cookie signing, verification, allowlist

Pure functions, no I/O. This is the security core; everything else depends on it.

**Files:**
- Create: `poc/server/src/auth.ts`
- Test: `poc/server/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SESSION_COOKIE: "mpai_session"`, `STATE_COOKIE: "mpai_oauth_state"`
  - `parseCookies(header: string | undefined): Record<string, string>`
  - `signSession(login: string, secret: string, now?: number): string`
  - `verifySession(value: string | undefined, secret: string, now?: number): { login: string } | null`
  - `isAllowlisted(login: string, allowlist: string): boolean`
  - `SESSION_MAX_AGE_MS: number`

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseCookies,
  signSession,
  verifySession,
  isAllowlisted,
  SESSION_MAX_AGE_MS,
} from "../src/auth.js";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd poc/server && npx vitest run test/auth.test.ts`
Expected: FAIL — cannot resolve `../src/auth.js`.

- [ ] **Step 3: Write the implementation**

Create `poc/server/src/auth.ts`:

```ts
import crypto from "node:crypto";

export const SESSION_COOKIE = "mpai_session";
export const STATE_COOKIE = "mpai_oauth_state";

/** Seven days. Long enough that a friends-beta session never expires
 *  mid-demo, short enough that a leaked cookie is not permanent. There is
 *  no revocation list (spec §7). */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Tolerant cookie-header parse: a malformed segment is skipped rather than
 *  throwing, because this runs on attacker-controlled input. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function hmac(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(login: string, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ login, iat: now })).toString("base64url");
  return `${payload}.${hmac(payload, secret)}`;
}

/** Returns the session user, or null for anything that is not a currently
 *  valid cookie this server signed. Never throws. */
export function verifySession(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): { login: string } | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  const expected = hmac(payload, secret);
  // Compare via timingSafeEqual on equal-length buffers; a length mismatch
  // is itself a rejection, so short-circuiting on it leaks nothing useful.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded?.login !== "string" || typeof decoded?.iat !== "number") return null;
    if (now - decoded.iat > SESSION_MAX_AGE_MS) return null;
    if (now < decoded.iat - 60_000) return null; // clock-skew guard
    return { login: decoded.login };
  } catch {
    return null;
  }
}

/** GitHub logins are case-insensitive. An empty list admits nobody — the
 *  fail-closed direction. */
export function isAllowlisted(login: string, allowlist: string): boolean {
  const wanted = login.trim().toLowerCase();
  if (!wanted) return false;
  return allowlist
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/server && npx vitest run test/auth.test.ts && npx tsc --noEmit`
Expected: all auth tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/auth.ts poc/server/test/auth.test.ts
git commit -m "feat(auth): signed session cookie and allowlist primitives"
```

---

### Task 2: OAuth routes

The four `/auth/*` routes. The GitHub token exchange is **injected** so the routes are testable without network — the same pattern `config.ts:12` uses for its filesystem probe.

**Files:**
- Modify: `poc/server/src/auth.ts`
- Test: `poc/server/test/auth.test.ts`

**Interfaces:**
- Consumes: Task 1's `signSession`, `verifySession`, `isAllowlisted`, `parseCookies`, `SESSION_COOKIE`, `STATE_COOKIE`
- Produces:
  - `type AuthConfig = { clientId, clientSecret, sessionSecret, allowlist, callbackUrl?, exchangeCode? }`
  - `type ExchangeCode = (code: string, cfg: AuthConfig) => Promise<{ login: string } | { error: string }>`
  - `authRoutes(cfg: AuthConfig | undefined): (req: IncomingMessage, res: ServerResponse) => boolean` — returns `true` when it handled the request
  - `safeNext(raw: string | null): string`

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/auth.test.ts`:

```ts
import { authRoutes, safeNext, type AuthConfig } from "../src/auth.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
    await withRoutes(testConfig(), async (base) => {
      const res = await fetch(`${base}/auth/callback?code=x&state=wrong`, {
        headers: { cookie: "mpai_oauth_state=right" },
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("state");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd poc/server && npx vitest run test/auth.test.ts`
Expected: FAIL — `authRoutes` and `safeNext` are not exported.

- [ ] **Step 3: Write the implementation**

Add this import at the **top** of `poc/server/src/auth.ts`, beside the existing `node:crypto` import (ES module imports must be top-level):

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
```

Then append to the same file:

```ts
export type ExchangeCode = (
  code: string,
  cfg: AuthConfig,
) => Promise<{ login: string } | { error: string }>;

export type AuthConfig = {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  allowlist: string;
  /** Absolute callback URL. Omitted in dev — GitHub then uses the app's
   *  registered default. */
  callbackUrl?: string;
  /** Injected in tests so the routes never touch the network. */
  exchangeCode?: ExchangeCode;
};

/** Only same-origin absolute paths survive. Anything that could send the
 *  browser to another host after login is replaced with "/". */
export function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

function cookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  const bits = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

/** Behind Caddy the socket is plain HTTP, so trust the proxy's header. */
function isSecure(req: IncomingMessage): boolean {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

const githubExchange: ExchangeCode = async (code, cfg) => {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      ...(cfg.callbackUrl ? { redirect_uri: cfg.callbackUrl } : {}),
    }),
  });
  if (!tokenRes.ok) return { error: `token exchange failed (${tokenRes.status})` };
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) return { error: token.error ?? "no access token" };

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "multiplayer-ai",
    },
  });
  if (!userRes.ok) return { error: `user lookup failed (${userRes.status})` };
  const user = (await userRes.json()) as { login?: string };
  if (!user.login) return { error: "no login on user" };
  return { login: user.login };
};

/** Returns a handler that reports whether it consumed the request.
 *
 *  Registered even when `cfg` is undefined, so /auth/me can answer
 *  `{enabled:false}` instead of falling through to the static handler's SPA
 *  fallback — which would return index.html with a 200 and leave the client
 *  unable to tell "auth is off" from "auth is broken" (spec §4.2). */
export function authRoutes(
  cfg: AuthConfig | undefined,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const exchange = cfg?.exchangeCode ?? githubExchange;

  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://x");
    } catch {
      return false;
    }
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (!path.startsWith("/auth/")) return false;

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (!cfg) {
      if (path === "/auth/me") {
        json(200, { enabled: false });
        return true;
      }
      json(404, { error: "auth is not configured" });
      return true;
    }

    const cookies = parseCookies(req.headers.cookie);

    if (path === "/auth/me") {
      const user = verifySession(cookies[SESSION_COOKIE], cfg.sessionSecret);
      if (!user) {
        json(401, { enabled: true });
        return true;
      }
      json(200, {
        enabled: true,
        login: user.login,
        allowlisted: isAllowlisted(user.login, cfg.allowlist),
      });
      return true;
    }

    if (path === "/auth/logout") {
      res.writeHead(204, {
        "set-cookie": cookie(SESSION_COOKIE, "", 0, isSecure(req)),
      });
      res.end();
      return true;
    }

    if (path === "/auth/login") {
      const state = crypto.randomBytes(16).toString("hex");
      const next = safeNext(url.searchParams.get("next"));
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", cfg.clientId);
      authorize.searchParams.set("scope", "read:user");
      authorize.searchParams.set("state", state);
      if (cfg.callbackUrl) {
        const cb = new URL(cfg.callbackUrl);
        cb.searchParams.set("next", next);
        authorize.searchParams.set("redirect_uri", cb.toString());
      }
      res.writeHead(302, {
        location: authorize.toString(),
        // 10 minutes: long enough to sign in, short enough not to linger.
        "set-cookie": cookie(STATE_COOKIE, state, 600, isSecure(req)),
      });
      res.end();
      return true;
    }

    if (path === "/auth/callback") {
      const state = url.searchParams.get("state") ?? "";
      const expected = cookies[STATE_COOKIE] ?? "";
      if (!state || !expected || state !== expected) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("oauth state mismatch — start again from /auth/login");
        return true;
      }
      const code = url.searchParams.get("code") ?? "";
      const next = safeNext(url.searchParams.get("next"));
      void exchange(code, cfg).then(
        (result) => {
          if ("error" in result) {
            res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
            res.end(`sign-in failed: ${result.error}`);
            return;
          }
          const secure = isSecure(req);
          res.writeHead(302, {
            location: next,
            "set-cookie": [
              cookie(
                SESSION_COOKIE,
                signSession(result.login, cfg.sessionSecret),
                Math.floor(SESSION_MAX_AGE_MS / 1000),
                secure,
              ),
              cookie(STATE_COOKIE, "", 0, secure),
            ],
          });
          res.end();
        },
        () => {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end("sign-in failed: could not reach GitHub");
        },
      );
      return true;
    }

    json(404, { error: "unknown auth route" });
    return true;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/server && npx vitest run test/auth.test.ts && npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/auth.ts poc/server/test/auth.test.ts
git commit -m "feat(auth): GitHub OAuth routes with injected token exchange"
```

---

### Task 3: Compose auth routes into the server

**Files:**
- Modify: `poc/server/src/server.ts:70` (options), `:224-258` (handler composition)
- Test: `poc/server/test/httpSurface.test.ts`

**Interfaces:**
- Consumes: `authRoutes`, `AuthConfig` from Task 2
- Produces: `startServer({ auth?: AuthConfig })`

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/httpSurface.test.ts`:

```ts
describe("/auth routes", () => {
  it("/auth/me returns JSON, not the SPA fallback HTML", async () => {
    // staticDir IS configured — the exact case the ordering bug hides in.
    const srv = await startServer({ port: 0, staticDir: fakeDist() });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/auth/me`);

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("reports enabled and 401 when auth is configured but signed out", async () => {
    const srv = await startServer({
      port: 0,
      staticDir: fakeDist(),
      auth: {
        clientId: "cid",
        clientSecret: "csecret",
        sessionSecret: "s",
        allowlist: "ana",
      },
    });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/auth/me`);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("still serves the SPA for non-auth paths", async () => {
    const srv = await startServer({ port: 0, staticDir: fakeDist() });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/some/app/route`);

    expect(await res.text()).toContain("SPA FALLBACK");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd poc/server && npx vitest run test/httpSurface.test.ts`
Expected: FAIL — `/auth/me` returns the SPA HTML; `auth` is not a valid option.

- [ ] **Step 3: Write the implementation**

In `poc/server/src/server.ts`, add the import near the other local imports:

```ts
import { authRoutes, type AuthConfig } from "./auth.js";
```

Add to the `startServer` options object (after `inviteMaxUses?: number;`):

```ts
  auth?: AuthConfig;
```

Immediately before `const serveStatic = ...`, add:

```ts
  // Registered unconditionally so /auth/me can report {enabled:false} rather
  // than falling through to the SPA fallback (spec §4.2).
  const handleAuth = authRoutes(opts.auth);
```

Then inside `createServer`, **after** the `/healthz` block and **before** `if (serveStatic)`, add:

```ts
    // Between healthz and static, for the same ordering reason: the SPA
    // fallback would otherwise swallow every /auth/* path.
    if (handleAuth(req, res)) return;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: full suite PASS (227 existing + new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/server.ts poc/server/test/httpSurface.test.ts
git commit -m "feat(auth): compose auth routes between healthz and static"
```

---

### Task 4: WS join gate — verified identity on the wire

The load-bearing task. After this, a client-supplied `userId` is discarded.

**Files:**
- Modify: `poc/server/src/server.ts:262` (connection handler), `:295-312` (join branch)
- Test: `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `verifySession`, `parseCookies`, `isAllowlisted`, `SESSION_COOKIE` (Task 1); `opts.auth` (Task 3)
- Produces: no new exports — behaviour change only

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/server.test.ts`. Add these imports at the top of the file:

```ts
import { signSession, SESSION_COOKIE } from "../src/auth.js";
```

Add this helper next to `connect`:

```ts
function connectWithCookie(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { cookie } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
```

Then append:

```ts
describe("auth gate on join", () => {
  const AUTH = {
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: "sekrit",
    allowlist: "ana",
  };

  it("rejects a join with no session cookie", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(50);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    ws.close();
  });

  it("rejects a verified user who is not on the allowlist", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("mallory", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "M" }));
    await wait(50);

    expect(seen.some((m) => m.type === "error" && /allowlist/.test(m.message))).toBe(true);
    ws.close();
  });

  // THE load-bearing assertion: the client's claim is discarded.
  it("overwrites a spoofed userId with the verified GitHub login", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(
      JSON.stringify({
        type: "join",
        sessionId: "s1",
        userId: "totally-not-ana",
        name: "Ana",
      }),
    );
    await wait(80);

    const join = seen.find((m) => m.type === "event" && m.event.type === "presence_join");
    expect(join).toBeTruthy();
    expect(join.event.userId).toBe("ana");
    expect(JSON.stringify(seen)).not.toContain("totally-not-ana");
    ws.close();
  });

  it("leaves the anonymous path untouched when auth is not configured", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(80);

    const join = seen.find((m) => m.type === "event" && m.event.type === "presence_join");
    expect(join.event.userId).toBe("u1");
    ws.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts -t "auth gate"`
Expected: FAIL — joins succeed with no cookie; `userId` stays `totally-not-ana`.

- [ ] **Step 3: Write the implementation**

In `poc/server/src/server.ts`, extend the auth import added in Task 3:

```ts
import {
  authRoutes,
  parseCookies,
  verifySession,
  isAllowlisted,
  SESSION_COOKIE,
  type AuthConfig,
} from "./auth.js";
```

Change the connection handler signature at `server.ts:262` from:

```ts
  wss.on("connection", (ws: WebSocket) => {
```

to:

```ts
  wss.on("connection", (ws: WebSocket, upgradeReq: IncomingMessage) => {
    // Captured once: the cookie cannot change for the life of this socket.
    const cookieHeader = upgradeReq.headers.cookie;
```

(`IncomingMessage` is already imported by `staticFiles.ts`; add `import type { IncomingMessage } from "node:http";` to `server.ts` if it is not already present.)

In the `join` branch, insert this **immediately after** the `SLUG.test` validation block and **before** the invite gate comment:

```ts
        // Auth gate (spec §4.3). Before the invite gate and therefore before
        // any provisioning: a rejected join must never create a worktree.
        // On success userId is REPLACED by the verified GitHub login — the
        // client's claim is discarded, which is the whole point of A2a
        // (spec §2).
        if (opts.auth) {
          const user = verifySession(
            parseCookies(cookieHeader)[SESSION_COOKIE],
            opts.auth.sessionSecret,
          );
          if (!user) return sendError("authentication required");
          if (!isAllowlisted(user.login, opts.auth.allowlist)) {
            return sendError("not on the allowlist");
          }
          msg.userId = user.login;
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: full suite PASS, tsc clean. The pre-existing anonymous tests must still pass — if any fail, the gate is firing when `opts.auth` is undefined.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat(auth): derive userId from the verified session cookie on join"
```

---

### Task 5: Fail-fast config and process wiring

**Files:**
- Modify: `poc/server/src/config.ts`, `poc/server/src/main.ts`
- Test: `poc/server/test/config.test.ts`

**Interfaces:**
- Consumes: `AuthConfig` (Task 2)
- Produces: `ConfigResult` gains `auth: AuthConfig | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd poc/server && npx vitest run test/config.test.ts`
Expected: FAIL — `result.auth` does not exist; missing vars do not fail.

- [ ] **Step 3: Write the implementation**

Replace `poc/server/src/config.ts` in full:

```ts
import type { AuthConfig } from "./auth.js";

export type ConfigResult =
  | { ok: true; staticDir: string | undefined; auth: AuthConfig | undefined }
  | { ok: false; error: string };

const AUTH_VARS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "GITHUB_ALLOWLIST",
] as const;

/** Validates the deployed process's configuration at boot.
 *
 *  Production mode is signalled by CLIENT_DIST being set — only the deployed
 *  box sets it, so local development behaviour is untouched (A1a spec §3.2).
 *
 *  Auth is signalled by GITHUB_CLIENT_ID (A2a spec §5). Production requires
 *  it; development may omit it entirely, but may not configure it halfway —
 *  a partial config would silently run anonymous and look like a bug.
 *
 *  The filesystem probe is injected rather than called directly so this stays
 *  a pure function, testable without a temp dir or process.exit. */
export function validateProductionConfig(
  env: Record<string, string | undefined>,
  hasIndexHtml: (dir: string) => boolean,
): ConfigResult {
  const staticDir = env.CLIENT_DIST;
  const anyAuthVar = AUTH_VARS.some((name) => (env[name] ?? "").trim());

  // Production must have auth; development must have all of it or none.
  if (staticDir || anyAuthVar) {
    for (const name of AUTH_VARS) {
      if (!(env[name] ?? "").trim()) {
        return {
          ok: false,
          error: staticDir
            ? `${name} is required when CLIENT_DIST is set (production mode)`
            : `${name} is required once GITHUB_CLIENT_ID is set — configure auth fully or not at all`,
        };
      }
    }
  }

  const auth: AuthConfig | undefined = anyAuthVar || staticDir
    ? {
        clientId: env.GITHUB_CLIENT_ID!,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
        sessionSecret: env.SESSION_SECRET!,
        allowlist: env.GITHUB_ALLOWLIST!,
        callbackUrl: env.OAUTH_CALLBACK_URL,
      }
    : undefined;

  if (!staticDir) return { ok: true, staticDir: undefined, auth };

  if (!hasIndexHtml(staticDir)) {
    return {
      ok: false,
      error: `CLIENT_DIST=${staticDir} has no index.html — build the client first (cd poc/client && npm run build)`,
    };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY is required when CLIENT_DIST is set (production mode)",
    };
  }
  return { ok: true, staticDir, auth };
}
```

In `poc/server/src/main.ts`, add `auth: config.auth,` to the `startServer({...})` call, and append a startup log line after the `requireInvite` line:

```ts
if (config.auth) {
  console.log(`GitHub auth ON — allowlist: ${config.auth.allowlist}`);
} else {
  console.log("GitHub auth OFF — anonymous identities (development)");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: full suite PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/config.ts poc/server/src/main.ts poc/server/test/config.test.ts
git commit -m "feat(auth): refuse to start production without auth configured"
```

---

### Task 6: Client auth state

Pure derivation, testable without a DOM.

**Files:**
- Create: `poc/client/src/authState.ts`, `poc/client/src/authState.test.ts`
- Modify: `poc/client/src/types.ts`

**Interfaces:**
- Consumes: the `/auth/me` response shapes from Task 2
- Produces:
  - `type AuthState = { status: "anonymous" } | { status: "signed-out" } | { status: "denied"; login: string } | { status: "signed-in"; login: string }`
  - `authStateFrom(status: number, body: unknown): AuthState`
  - `loginUrl(next: string): string`
  - `API_BASE` (in `types.ts`)

- [ ] **Step 1: Write the failing tests**

Create `poc/client/src/authState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { authStateFrom, loginUrl } from "./authState";

describe("authStateFrom", () => {
  it("is anonymous when the server reports auth disabled", () => {
    expect(authStateFrom(200, { enabled: false })).toEqual({ status: "anonymous" });
  });

  it("is signed-out on a 401", () => {
    expect(authStateFrom(401, { enabled: true })).toEqual({ status: "signed-out" });
  });

  it("is signed-in for an allowlisted login", () => {
    expect(authStateFrom(200, { enabled: true, login: "ana", allowlisted: true })).toEqual({
      status: "signed-in",
      login: "ana",
    });
  });

  it("is denied for a verified login that is not allowlisted", () => {
    expect(authStateFrom(200, { enabled: true, login: "ana", allowlisted: false })).toEqual({
      status: "denied",
      login: "ana",
    });
  });

  it("falls back to anonymous for junk, so a broken probe never locks the app", () => {
    expect(authStateFrom(200, null)).toEqual({ status: "anonymous" });
    expect(authStateFrom(200, "<html>")).toEqual({ status: "anonymous" });
    expect(authStateFrom(500, {})).toEqual({ status: "anonymous" });
  });
});

describe("loginUrl", () => {
  it("encodes the return path", () => {
    expect(loginUrl("/?invite=abc")).toBe("/auth/login?next=%2F%3Finvite%3Dabc");
  });

  it("defaults to the root", () => {
    expect(loginUrl("/")).toBe("/auth/login?next=%2F");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd poc/client && npx vitest run src/authState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `poc/client/src/authState.ts`:

```ts
export type AuthState =
  | { status: "anonymous" }
  | { status: "signed-out" }
  | { status: "denied"; login: string }
  | { status: "signed-in"; login: string };

/** Derives auth state from a /auth/me response.
 *
 *  Anything unexpected degrades to "anonymous" rather than throwing: in vite
 *  dev the probe hits the vite server, which answers with index.html, and a
 *  hard failure there would make the app unusable in development. */
export function authStateFrom(status: number, body: unknown): AuthState {
  if (typeof body !== "object" || body === null) return { status: "anonymous" };
  const b = body as { enabled?: unknown; login?: unknown; allowlisted?: unknown };
  if (b.enabled !== true) return { status: "anonymous" };
  if (status === 401) return { status: "signed-out" };
  if (status !== 200 || typeof b.login !== "string") return { status: "anonymous" };
  return b.allowlisted === true
    ? { status: "signed-in", login: b.login }
    : { status: "denied", login: b.login };
}

export function loginUrl(next: string): string {
  return `/auth/login?next=${encodeURIComponent(next)}`;
}
```

In `poc/client/src/types.ts`, add below the `SERVER_URL` export:

```ts
/** HTTP origin for /auth/* calls. Mirrors SERVER_URL: in vite dev the server
 *  is separate; in a built bundle the page is served BY the server. */
export const API_BASE = import.meta.env.DEV ? "http://localhost:3001" : "";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/client && npx vitest run && npx tsc --noEmit`
Expected: PASS (120 existing + 8 new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/authState.ts poc/client/src/authState.test.ts poc/client/src/types.ts
git commit -m "feat(auth): client auth-state derivation"
```

---

### Task 7: Client screens, routing, and the locked name

**Files:**
- Create: `poc/client/src/components/Landing.tsx`, `InviteSignIn.tsx`, `Denied.tsx`
- Modify: `poc/client/src/App.tsx:29-90`, `poc/client/src/components/Lobby.tsx`, `poc/client/src/terminal.css`

**Interfaces:**
- Consumes: `authStateFrom`, `loginUrl` (Task 6); `API_BASE` (Task 6); `inviteTokenFrom` (existing)
- Produces: no exports consumed by later tasks

- [ ] **Step 1: Create the three screens**

`poc/client/src/components/Landing.tsx`:

```tsx
import { loginUrl } from "../authState";

export function Landing() {
  return (
    <div className="authscreen">
      <div className="authhero">MULTIPLAYER AI</div>
      <div className="authsub">
        ONE AGENT. YOUR WHOLE TEAM. EVERY DECISION SIGNED BY THE HUMAN WHO MADE IT.
      </div>
      <a className="authbtn" href={loginUrl(window.location.pathname + window.location.search)}>
        SIGN IN WITH GITHUB
      </a>
    </div>
  );
}
```

`poc/client/src/components/InviteSignIn.tsx`:

```tsx
import { useEffect, useState } from "react";
import { SERVER_URL } from "../types";
import { loginUrl } from "../authState";

/** Signed-out landing for an invite link. Resolves the invite via peek_invite
 *  — which never spends the token — so the invitee sees WHAT they were invited
 *  to before being asked to sign in (spec §3.2). */
export function InviteSignIn(props: { token: string }) {
  const [target, setTarget] = useState<{ sessionId: string; invitedBy?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "peek_invite", token: props.token }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "invite_peek") setTarget(m);
        else if (m.type === "error") setError(m.message);
      } catch { /* ignore */ }
    };
    ws.onerror = () => setError("could not reach the server");
    return () => ws.close();
  }, [props.token]);

  const next = window.location.pathname + window.location.search;

  return (
    <div className="authscreen">
      <div className="authhero">YOU'RE INVITED</div>
      {error ? (
        <div className="authsub">THIS INVITE IS NO LONGER VALID — {error.toUpperCase()}</div>
      ) : target ? (
        <div className="authsub">
          {(target.invitedBy ?? "SOMEONE").toUpperCase()} INVITED YOU TO SESSION{" "}
          {target.sessionId.toUpperCase()}
        </div>
      ) : (
        <div className="authsub">RESOLVING INVITE…</div>
      )}
      <a className="authbtn" href={loginUrl(next)}>
        SIGN IN WITH GITHUB TO JOIN
      </a>
    </div>
  );
}
```

`poc/client/src/components/Denied.tsx`:

```tsx
export function Denied(props: { login: string }) {
  return (
    <div className="authscreen">
      <div className="authhero">NOT ON THE LIST</div>
      <div className="authsub">
        YOU ARE SIGNED IN AS <b>{props.login}</b> — ASK THE OPERATOR TO ADD THAT USERNAME.
      </div>
      <form method="post" action="/auth/logout">
        <button className="authbtn" type="submit">SIGN OUT</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Wire routing into App.tsx**

Add imports:

```tsx
import { Landing } from "./components/Landing";
import { InviteSignIn } from "./components/InviteSignIn";
import { Denied } from "./components/Denied";
import { authStateFrom, type AuthState } from "./authState";
import { API_BASE } from "./types";
```

Inside `App()`, after the `inviteToken` line, add:

```tsx
  // null = probe in flight. Anything unexpected degrades to anonymous, so a
  // failed probe never locks the app out (authState.ts).
  const [auth, setAuth] = useState<AuthState | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/auth/me`, { credentials: "include" })
      .then(async (res) => authStateFrom(res.status, await res.json().catch(() => null)))
      .catch(() => ({ status: "anonymous" }) as AuthState)
      .then((state) => { if (live) setAuth(state); });
    return () => { live = false; };
  }, []);
```

Replace the `<Crt>` children with this precedence (spec §3.5):

```tsx
        {auth === null ? (
          <div className="authscreen"><div className="authsub">CHECKING SESSION…</div></div>
        ) : auth.status === "signed-out" ? (
          inviteToken ? <InviteSignIn token={inviteToken} /> : <Landing />
        ) : auth.status === "denied" ? (
          <Denied login={auth.login} />
        ) : inviteToken && !inviteTarget ? (
          <InviteLanding token={inviteToken} onAccept={setInviteTarget} />
        ) : activeSessionId === null ? (
          <SessionPicker projectId={activeProjectId} />
        ) : profile === null ? (
          <Lobby
            projectId={activeProjectId}
            sessionId={activeSessionId}
            defaultName={auth.status === "signed-in" ? auth.login : `user-${userId.slice(0, 4)}`}
            lockedName={auth.status === "signed-in" ? auth.login : undefined}
            onEnter={(p) => { saveProfile(p); setProfile(p); }}
          />
        ) : (
          <SessionView
            userId={userId}
            sessionId={activeSessionId}
            projectId={activeProjectId}
            profile={profile}
            screen={screen}
            onScreenChange={setScreen}
            invite={inviteToken ?? undefined}
          />
        )}
```

The `profile` initialiser itself needs no change — a saved profile may still carry a stale name, so add this effect immediately after the auth effect to let the verified login win:

```tsx
  // A verified login always wins over a previously saved profile name.
  useEffect(() => {
    if (auth?.status !== "signed-in") return;
    setProfile((p) => (p && p.name !== auth.login ? { ...p, name: auth.login } : p));
  }, [auth]);
```

- [ ] **Step 3: Lock the name in Lobby.tsx**

Add `lockedName?: string;` to the props type. Change the `name` state initialiser to `useState(props.lockedName ?? props.defaultName)` and replace the `<input>` in the NAME row with:

```tsx
            {props.lockedName ? (
              <span className="lobby-locked" title="verified GitHub identity">
                {props.lockedName}
              </span>
            ) : (
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && enter()}
                maxLength={40}
              />
            )}
```

Change `const enter = () => {` to use the locked value when present:

```tsx
  const enter = () => {
    const n = (props.lockedName ?? name).trim().slice(0, 40);
    if (n) props.onEnter({ name: n, glyph, color });
  };
```

**Note:** the `<label className="lobby-row">` wrapping this control must become a `<div>` with a `<span className="lbl">` — a `<label>` wrapping a form control forwards a second synthesized click and broke the model picker once already (see `Header.tsx:46-53` and the mistakes log).

- [ ] **Step 4: Add styles**

Append to `poc/client/src/terminal.css`:

```css
.authscreen { display:flex; flex-direction:column; align-items:center; justify-content:center;
  height:100%; gap:18px; text-align:center; padding:24px; }
.authhero { font-size:28px; letter-spacing:3px; }
.authsub { opacity:.75; max-width:52ch; line-height:1.6; }
.authbtn { display:inline-block; padding:10px 22px; border:1px solid currentColor;
  text-decoration:none; letter-spacing:2px; cursor:pointer; background:none;
  color:inherit; font:inherit; }
.authbtn:hover { filter:brightness(1.3); }
.lobby-locked { opacity:.9; letter-spacing:1px; }
```

- [ ] **Step 5: Verify build and tests**

Run: `cd poc/client && npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean, all tests PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add poc/client/src/App.tsx poc/client/src/components/Landing.tsx \
  poc/client/src/components/InviteSignIn.tsx poc/client/src/components/Denied.tsx \
  poc/client/src/components/Lobby.tsx poc/client/src/terminal.css
git commit -m "feat(auth): landing, invite sign-in, denied screens; lock name to GitHub login"
```

---

### Task 8: Live browser verification and runbook update

Unit tests cannot see the `SameSite` cookie behaviour across the OAuth redirect, and that is the most likely failure point (spec §10). This task is not optional.

**Files:**
- Modify: `deploy/RUNBOOK.md`, `deploy/env.example`

**Interfaces:**
- Consumes: everything above
- Produces: documented operator steps

- [ ] **Step 1: Register the OAuth app** *(user action — cannot be automated)*

At `https://github.com/settings/developers` → **New OAuth App**. Homepage `http://localhost:3001`, callback `http://localhost:3001/auth/callback`. Record the client ID and generate a client secret.

- [ ] **Step 2: Run the single-port build with auth on**

Auth is exercised only through the single-port path — vite dev on :5173 is cross-origin from :3001 and its cookies would need CORS, which A2a deliberately does not add.

```bash
cd poc/client && npm run build && cd ../server && npm run build
CLIENT_DIST=$(cd ../client/dist && pwd) HOST=127.0.0.1 PORT=3001 \
  ANTHROPIC_API_KEY=placeholder-not-a-real-key \
  GITHUB_CLIENT_ID=<id> GITHUB_CLIENT_SECRET=<secret> \
  SESSION_SECRET=$(openssl rand -hex 32) GITHUB_ALLOWLIST=<your-login> \
  node dist/main.js
```

- [ ] **Step 3: Walk the four paths in a real browser**

Confirm each, and record the result in the plan's Deviations section:

1. `http://127.0.0.1:3001/` signed out → landing page, **Sign in with GitHub** completes the round trip and returns you to `/`.
2. `http://127.0.0.1:3001/?session=check` while signed in → lobby with the **name field locked** to your GitHub login; glyph and colour still selectable.
3. Session view → the roster and any permission decision show your **GitHub login**, not a UUID.
4. Restart the server with `GITHUB_ALLOWLIST=someone-else` → the denied screen appears showing **your own** login.

- [ ] **Step 4: Verify the invite return path**

The riskiest flow (spec §10). Mint an invite from a signed-in session, open the link in a **private window**, confirm: the invite sign-in screen names the session, signing in returns you to the invite (not to `/`), and you land inside the session.

- [ ] **Step 5: Confirm auth-off still works**

```bash
kill $(lsof -ti:3001)
cd poc/server && npx tsx src/main.ts
```

Open `http://localhost:5173/?session=check&name=alice` with the client dev server running. Expected: no landing page, straight into the session as `alice`. This proves the demo recipes are intact.

- [ ] **Step 6: Update the ops docs**

Add the four auth variables to `deploy/env.example` with comments, and a section to `deploy/RUNBOOK.md` covering: registering the production OAuth app (callback `https://<domain>/auth/callback`), generating `SESSION_SECRET` with `openssl rand -hex 32`, and the fact that a missing auth variable now stops the process at boot with a `config error:` line.

- [ ] **Step 7: Full green check and commit**

```bash
cd poc/server && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc --noEmit && npm test && npm run build
```

```bash
git add deploy/RUNBOOK.md deploy/env.example
git commit -m "docs(deploy): OAuth setup and auth env vars in the runbook"
```

- [ ] **Step 8: Remove stray screenshots**

`browser_take_screenshot` writes into the **repo root**, not `.playwright-mcp/`. Run `git status` and delete any stray `.png` before finishing. Never `git add -A`.

---

## Deviations

*(Implementers: record here any place the plan was wrong or a decision had to be made mid-run, with the reason. This section is why the plan is trustworthy next time.)*

- **Addition beyond spec §4.4:** the config validator also rejects a *partially* configured auth setup in development (`GITHUB_CLIENT_ID` set but not the rest). The spec only required the production check. Rationale: a half-configured dev server would run anonymous while appearing to have auth, which is a confusing failure mode. Recorded here rather than silently added.

### Recorded during subagent-driven execution (session #9)

All of the below were ruled under the project's standing precedence rule: **the spec is the authority when the plan and the spec disagree.** Each diverges from this plan's literal code and each is deliberate.

- **Task 2 — `safeNext` rewritten (Critical, security).** The plan's `safeNext` rejected only a literal `//` or `/\` prefix, so `next=%2F%09%2Fevil.example` (a TAB) passed straight into `Location:`. Node emits TAB in a header value; the WHATWG URL parser strips TAB/LF/CR before parsing, yielding `//evil.example` — a protocol-relative redirect to an attacker host, fired immediately after sign-in. Confirmed by execution, not inspection. Replaced with positive validation: reject any `[\x00-\x20\x7f]`, then require an exact round-trip through the URL parser. The plan's tests mirrored the implementation's shape rather than attacking the threat; new tests attack the property.
- **Task 2 — terminal `.catch` on the callback handler (Important).** `void exchange(...).then(a, b)` discarded the promise `.then` returns, so a throw inside the success handler (e.g. `res.writeHead` on a `Location` containing LF) escaped as an unhandled rejection — fatal on Node >=15 — and hung the request.
- **Task 4 — the display-name lock moved from the client to the server.** The plan placed it in the Lobby (Task 7). Spec §3.4 states it as a security property ("choosing your own display name would reintroduce exactly the impersonation this spec removes"), and a client-side lock is not an enforcement boundary — this task's own test file ships a hand-crafted WebSocket client that bypasses any browser UI. `msg.name = user.login` now sits beside `msg.userId = user.login` in the auth gate. The Lobby lock remains as UX, now cosmetic reinforcement.
- **Task 5 — auth intent gated on `GITHUB_CLIENT_ID` alone.** The plan's verbatim code used `anyAuthVar` (any of the four), so a stray `SESSION_SECRET` in a dev shell profile exited 1, and the error named `GITHUB_CLIENT_ID` as set when it never was. Design §4.5 line 202 says `GITHUB_CLIENT_ID` presence enables auth; the plan's own doc comment said so too while the code below it did not.
- **Task 5 — four pre-existing A1a config tests were re-fixtured.** They set `CLIENT_DIST` without GitHub vars, which the new check now rejects. Each still asserts its original A1a property with its original error string; the review verified this case by case. The edit removed the suite's only `CLIENT_DIST`-with-no-auth-vars case, so a replacement test for the §4.4 headline property was added and confirmed to fail under the mutation `if (staticDir || authIntended)` → `if (authIntended)`.
- **Task 7 — the brief's invite protocol was wrong.** It listened for `invite_peek`/`invitedBy`; the server replies `invite_info`/`inviterName` (`server.ts:430-447`). Verbatim would have hung the screen on "RESOLVING INVITE…" forever.
- **Task 7 — `/auth/logout` returns 204, and browsers do not navigate on 204.** The plan's plain form POST would have cleared the cookie while leaving the Denied screen visually identical — a dead-looking button. The form is kept as a no-JS fallback with an `onSubmit` fetch + reload layered on.
- **Task 7 — routing precedence extracted to a pure `screenFor`.** The plan specified an inline 7-arm JSX ternary, which the plan's own global constraint ("extract logic worth testing as a pure function") forbids. It is the highest-risk decision in the task: arm 3 vs arm 4 backwards silently shows a denied invitee the wrong screen. Now `poc/client/src/authRoute.ts` with tests that were mutation-checked, not merely run.

### Found only by the whole-branch review (not visible to any single task)

- **CRITICAL — the client never learned its own verified identity.** `App.tsx` still held the sessionStorage UUID and compared it to `derived.driverId`, which is now the GitHub login, so with auth on `isDriver` was **always false for everyone**: prompts degraded to suggestions and the approve/deny controls were hidden entirely, making the permission gate — the product's headline interaction — unanswerable from the UI. Fixed with a pure `selfIdFor(auth, localId)`. **Carry-forward caveat:** `selfIdFor` is well tested, but nothing pins the *wiring*; reverting the single line `userId={selfId}` reintroduces the bug with the client suite fully green. First thing to test if component/hook test infrastructure ever lands.
- **CRITICAL — `create_session` provisioned a worktree and spawned an agent for an unauthenticated stranger.** It sits above the `if (!ctx)` choke point, reaches a real `git worktree add` plus branch, and constructs an `AgentDriver` whose constructor eagerly spawns the SDK subprocess bound to the box API key. One WebSocket frame, no cookie, from anyone on the internet — repeatable in a loop. `peek`/`watch_project` additionally disclosed the roster of real GitHub logins and the LLM-generated oversight prose. **Spec §4.3's rationale for join-level-only gating is stale** against the client this branch shipped: `Landing.tsx` opens no socket and `InviteSignIn.tsx` sends only `peek_invite`, so `peek_invite` is the only type that must stay open. `create_session`, `peek`, `watch_project` and `set_oversight` are now gated by a shared `requireAuth`, active only when `opts.auth` is set.
- **`next` was silently dropped when `OAUTH_CALLBACK_URL` was unset**, so spec §3.2's "the invite token survives the OAuth round trip" was quietly false for any operator who left the optional-looking variable unset. `next` now rides its own short-lived cookie, re-validated through `safeNext` on read-back.
- **`API_BASE` deleted rather than folded into `loginUrl`.** `loginUrl` is a browser navigation that must set and read the OAuth `state` cookie on one origin, so prefixing an API origin would guarantee a mismatch; with `/auth/me` also needing same-origin (a vite `/auth` proxy was added), the constant had no valid remaining use. Keeping a must-never-use constant is the worse trap.

### Task 8 — live browser results (session #10, 2026-07-27)

Steps 1, 2 and 6 were already complete before this session: the OAuth app is registered, both
packages were built, and the ops docs landed in `251abbc`. Task 8 ran against **vite dev on :5173
with the server on :3001 behind the `/auth` proxy**, not the single-port build — the registered
callback is `http://localhost:5173/auth/callback`, and the `state` cookie must be set and read on
one origin. The plan's Step 1/2 text naming :3001 predates that proxy.

**Confirmed by the user in a real browser, signed in with a real GitHub account:**

- **Path 1 — sign-in round trip.** Landing screen at `/` while signed out, `SIGN IN WITH GITHUB`
  → GitHub → returned signed in. `SameSite` across the redirect — spec §10's named most-likely
  failure point — **works**. The `/auth/login` 302 sets `mpai_oauth_state` and `mpai_oauth_next`,
  both `HttpOnly; SameSite=Lax; Max-Age=600`.
- **Path 4 — denied screen.** With the allowlist overridden to two other logins and the user's
  cookie still valid, reloading landed on the denied screen naming **their own login**. Denial is
  identity-aware, not a generic signed-out bounce. (The override was passed in the shell rather than
  edited into `.env`: Node's `--env-file` yields to an already-set variable, which makes this test
  non-destructive and one restart to undo.)
- **Authenticated `create_session` provisions for real** — the session created during the walk
  produced `.mpai/worktrees/hi` on branch `mpai/hi`, off `a358a9c`.

**Confirmed by driving the browser against a throwaway auth config** (server run with
`SESSION_SECRET=testsecret GITHUB_ALLOWLIST=testuser` and a cookie minted via `signSession`, so the
real secret and the user's GitHub login were never handled). This exercises everything downstream of
the GitHub token exchange:

- **Path 2 — the lobby name is locked.** NAME renders as static text (accessible name "verified
  GitHub identity"), not an editable field; SPRITE and COLOR remain selectable.
- **Path 3 — driver controls are live, and whole-branch Critical 1 is closed.** Roster reads
  `PARTY · 1 / ■ testuser 🛞 DRIVING · you`; the prompt input is enabled with placeholder
  "you're driving — prompt the agent, or /skill…"; `/[0-9a-f]{8}-[0-9a-f]{4}/` matches nowhere on
  the page, so no sessionStorage UUID leaks onto the wire. This is the exact regression that
  reverting `userId={selfId}` would reintroduce with the client suite green.
- **Path 5 — auth off is unchanged.** With the GitHub vars unset, `?session=check&name=alice` goes
  straight into the session, no landing screen, alice driving, prompt bar live. Demo recipes intact.

**Partially verified — the one gap, recorded honestly:**

- **The invite return path (Step 4).** The *mechanism* is confirmed: `/auth/login?next=…` stores the
  full destination in its own cookie — `mpai_oauth_next=%2F%3Fsession%3Dteam%26invite%3Dabc123`,
  `HttpOnly; SameSite=Lax; Max-Age=600` — which is exactly what whole-branch finding I4 fixed, and
  `safeNext` re-validates it on read-back. **Not walked end to end**: minting an invite from a
  signed-in session and completing the GitHub round trip in a private window was not performed. The
  cookie carry is the part that was broken and is now demonstrably correct; what remains unproven is
  only the full user journey around it.

**Green at merge:** server 297/297 (15 files), client 144/144 (19 files), both `tsc --noEmit` clean,
client build clean.
