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
