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
  // Auth intent is signalled by GITHUB_CLIENT_ID alone (spec §4.5), not by
  // any of the four vars — SESSION_SECRET is a generic name that could
  // plausibly be set in a dev shell for unrelated reasons, and that must not
  // by itself force auth configuration or a boot failure.
  const authIntended = Boolean((env.GITHUB_CLIENT_ID ?? "").trim());

  // Production must have auth; development must have all of it or none.
  if (staticDir || authIntended) {
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

  // Trimmed on assignment, not just in the check above: `SECRET=$(cat file)`
  // in an env file leaves a trailing newline, which passed validation and
  // then failed opaquely at GitHub as an invalid client_secret. Same for the
  // callback URL, where stray whitespace produces an unparseable redirect_uri.
  const auth: AuthConfig | undefined = authIntended || staticDir
    ? {
        clientId: env.GITHUB_CLIENT_ID!.trim(),
        clientSecret: env.GITHUB_CLIENT_SECRET!.trim(),
        sessionSecret: env.SESSION_SECRET!.trim(),
        allowlist: env.GITHUB_ALLOWLIST!.trim(),
        callbackUrl: env.OAUTH_CALLBACK_URL?.trim() || undefined,
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
