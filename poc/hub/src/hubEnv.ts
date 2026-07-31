import type { AuthConfig } from "multiplayer-ai-server/auth";

/** The four vars that configure GitHub auth on the hub, mirroring the server's
 *  `config.ts` AUTH_VARS. Order matters: it is the order missing vars are
 *  reported in. */
const AUTH_VARS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "GITHUB_ALLOWLIST",
] as const;

export type HubAuthResult =
  | { ok: true; auth: AuthConfig | undefined }
  | { ok: false; error: string };

/** Derives the hub's auth configuration from its environment, with the same
 *  semantics `validateProductionConfig` uses on the server (spec §4.5) minus
 *  the CLIENT_DIST/production-mode branch — the hub is always the deployed box.
 *
 *  Auth intent is signalled by GITHUB_CLIENT_ID ALONE, not by any of the four
 *  vars: SESSION_SECRET is a generic name that could plausibly be set in a dev
 *  shell for unrelated reasons, and that must not by itself force auth
 *  configuration or a boot failure. Once intent is signalled, the config is
 *  all-or-nothing — a half-configured auth would silently run anonymous and
 *  look like a bug.
 *
 *  `env` is a parameter, never read from `process.env` inside: the daemon
 *  passes its real environment, tests pass a literal, and neither leaks into
 *  the other. */
export function hubAuthFrom(env: NodeJS.ProcessEnv): HubAuthResult {
  const authIntended = Boolean((env.GITHUB_CLIENT_ID ?? "").trim());
  if (!authIntended) return { ok: true, auth: undefined };

  for (const name of AUTH_VARS) {
    if (!(env[name] ?? "").trim()) {
      return {
        ok: false,
        error: `${name} is required once GITHUB_CLIENT_ID is set — configure auth fully or not at all`,
      };
    }
  }

  // Trimmed on assignment, not just in the check above: `SECRET=$(cat file)`
  // in an env file leaves a trailing newline, which passed validation and then
  // failed opaquely at GitHub as an invalid client_secret. Same for the
  // callback URL, where stray whitespace produces an unparseable redirect_uri.
  const auth: AuthConfig = {
    clientId: env.GITHUB_CLIENT_ID!.trim(),
    clientSecret: env.GITHUB_CLIENT_SECRET!.trim(),
    sessionSecret: env.SESSION_SECRET!.trim(),
    allowlist: env.GITHUB_ALLOWLIST!.trim(),
    callbackUrl: env.OAUTH_CALLBACK_URL?.trim() || undefined,
  };
  return { ok: true, auth };
}
