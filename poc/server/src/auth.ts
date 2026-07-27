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
