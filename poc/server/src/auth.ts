import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const SESSION_COOKIE = "mpai_session";
export const STATE_COOKIE = "mpai_oauth_state";
/** Carries the post-login destination across the OAuth round trip.
 *
 *  The `next` value used to ride on `redirect_uri`, which only exists when
 *  OAUTH_CALLBACK_URL is configured — so with it unset (spec §4.5 calls the
 *  variable optional) every invitee landed on "/" with their invite token
 *  silently dropped. A cookie makes the round trip work either way. */
export const NEXT_COOKIE = "mpai_oauth_next";

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
 *  browser to another host after login is replaced with "/".
 *
 *  Validated positively rather than by prefix-blacklist: control characters
 *  (e.g. a literal TAB, which the WHATWG URL parser strips before browsers
 *  see it — turning "/\t/evil.example" into a protocol-relative
 *  "//evil.example") are rejected outright, and the remainder must
 *  round-trip through the URL parser to exactly the same pathname+search —
 *  which rules out backslash tricks and anything else the parser would
 *  reinterpret as leaving this origin. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || /[\x00-\x20\x7f]/.test(raw)) return "/";
  const u = new URL(raw, "http://x");
  return u.pathname + u.search === raw ? raw : "/";
}

/** Undoes the encodeURIComponent applied when the next cookie was written.
 *  A malformed escape sequence throws in decodeURIComponent, so it degrades
 *  to null and safeNext turns that into "/". */
function decodeNext(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
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

/** Whether the cookies this response sets must carry `Secure`.
 *
 *  Header-only detection fails open: a proxy that does not set
 *  `x-forwarded-proto`, or a direct hit on the Node port, would ship the
 *  session cookie in the clear. So the deployment's own configuration is
 *  authoritative — an https `callbackUrl` means this is a TLS deployment
 *  regardless of what the hop in front of us chose to advertise. Behind
 *  Caddy the socket itself is plain HTTP, hence the header as a third
 *  signal rather than the only one. */
function isSecure(req: IncomingMessage, cfg: AuthConfig): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (cfg.callbackUrl?.startsWith("https://")) return true;
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

export type AuthCheck =
  | { ok: true; login: string | null }
  | { ok: false; error: string };

/** The one place a WebSocket message is checked against the session cookie.
 *
 *  With `cfg` undefined (auth off) every request is admitted and `login` is
 *  null, so callers keep the client-asserted identity exactly as before.
 *  With auth on, only a verified AND allowlisted login gets through — the
 *  same two rejections, in the same order, the join gate has always used
 *  (spec §4.3). Shared so that every privileged message type enforces one
 *  policy rather than each re-deriving it. */
export function requireAuth(
  cookieHeader: string | undefined,
  cfg: AuthConfig | undefined,
): AuthCheck {
  if (!cfg) return { ok: true, login: null };
  const user = verifySession(parseCookies(cookieHeader)[SESSION_COOKIE], cfg.sessionSecret);
  if (!user) return { ok: false, error: "authentication required" };
  if (!isAllowlisted(user.login, cfg.allowlist)) {
    return { ok: false, error: "not on the allowlist" };
  }
  return { ok: true, login: user.login };
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
      // This response is per-cookie and must never be reused for another
      // visitor — a shared cache without these headers could hand one user's
      // login to the next.
      const privateJson = (status: number, body: unknown) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          vary: "Cookie",
        });
        res.end(JSON.stringify(body));
      };
      const user = verifySession(cookies[SESSION_COOKIE], cfg.sessionSecret);
      if (!user) {
        privateJson(401, { enabled: true });
        return true;
      }
      privateJson(200, {
        enabled: true,
        login: user.login,
        allowlisted: isAllowlisted(user.login, cfg.allowlist),
      });
      return true;
    }

    if (path === "/auth/logout") {
      // POST only: a GET would let any third-party <img src="/auth/logout">
      // sign the user out.
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST", "content-type": "text/plain; charset=utf-8" });
        res.end("use POST to sign out");
        return true;
      }
      res.writeHead(204, {
        "set-cookie": cookie(SESSION_COOKIE, "", 0, isSecure(req, cfg)),
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
      const secure = isSecure(req, cfg);
      res.writeHead(302, {
        location: authorize.toString(),
        // 10 minutes: long enough to sign in, short enough not to linger.
        "set-cookie": [
          cookie(STATE_COOKIE, state, 600, secure),
          // Percent-encoded so a ";" or "," in the path can never split the
          // cookie header. Read back through safeNext regardless.
          cookie(NEXT_COOKIE, encodeURIComponent(next), 600, secure),
        ],
      });
      res.end();
      return true;
    }

    if (path === "/auth/callback") {
      const secure = isSecure(req, cfg);
      // Every exit from this route is terminal for this attempt, so the
      // one-shot cookies are cleared on the failure branches too — otherwise
      // a mismatched state or a failed exchange left a replayable state
      // cookie alive for its full 600s.
      const clearOneShot = [cookie(STATE_COOKIE, "", 0, secure), cookie(NEXT_COOKIE, "", 0, secure)];
      const state = url.searchParams.get("state") ?? "";
      const expected = cookies[STATE_COOKIE] ?? "";
      if (!state || !expected || state !== expected) {
        res.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
          "set-cookie": clearOneShot,
        });
        res.end("oauth state mismatch — start again from /auth/login");
        return true;
      }
      const code = url.searchParams.get("code") ?? "";
      // Query param first (it is what redirect_uri carries when
      // OAUTH_CALLBACK_URL is configured), cookie otherwise. Both are
      // attacker-reachable, so both go through safeNext.
      const next = safeNext(url.searchParams.get("next") ?? decodeNext(cookies[NEXT_COOKIE]));
      void exchange(code, cfg)
        .then(
          (result) => {
            if ("error" in result) {
              res.writeHead(401, {
                "content-type": "text/plain; charset=utf-8",
                "set-cookie": clearOneShot,
              });
              res.end(`sign-in failed: ${result.error}`);
              return;
            }
            res.writeHead(302, {
              location: next,
              "set-cookie": [
                cookie(
                  SESSION_COOKIE,
                  signSession(result.login, cfg.sessionSecret),
                  Math.floor(SESSION_MAX_AGE_MS / 1000),
                  secure,
                ),
                ...clearOneShot,
              ],
            });
            res.end();
          },
          () => {
            res.writeHead(502, {
              "content-type": "text/plain; charset=utf-8",
              "set-cookie": clearOneShot,
            });
            res.end("sign-in failed: could not reach GitHub");
          },
        )
        // A throw inside the fulfilled handler above (e.g. res.writeHead
        // rejecting a malformed header value) would otherwise escape as an
        // unhandled rejection and crash the process, leaving the request
        // hanging with no response. Guard it the same way a rejected
        // exchange is guarded.
        .catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            res.end("sign-in failed: internal error");
          } else {
            res.end();
          }
        });
      return true;
    }

    json(404, { error: "unknown auth route" });
    return true;
  };
}
