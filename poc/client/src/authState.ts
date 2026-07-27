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

/** Same-origin and relative, like every other /auth/* URL in the client.
 *
 *  This is a browser NAVIGATION, not a fetch, so it must land on the origin
 *  the session cookie will be set for — the vite `/auth` proxy in dev, the
 *  server itself in a built bundle. Prefixing an API origin here would put the
 *  state cookie on one origin and read it back on another. There is no
 *  API_BASE for auth for exactly this reason (see types.ts). */
export function loginUrl(next: string): string {
  return `/auth/login?next=${encodeURIComponent(next)}`;
}
