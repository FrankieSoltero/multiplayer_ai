import path from "node:path";
import type { AuthConfig } from "./auth.js";
import { mpaiHome } from "./machineIdentity.js";

export type ConfigResult =
  | { ok: true; staticDir: string | undefined; auth: AuthConfig | undefined }
  | { ok: false; error: string };

/** What boot knows about whether ANY model can run (local-models §2.4).
 *  `hasAnthropicCreds` powers the Claude built-ins direct; `hasRoutedModels`
 *  means at least one model is served through the managed proxy. main.ts
 *  computes both from the registry and injects them (like `hasIndexHtml`) so
 *  this stays a pure function. */
export interface BootCapabilities {
  hasAnthropicCreds: boolean;
  hasRoutedModels: boolean;
}

/** The boot-time "no usable model" message, with `$MPAI_HOME` resolved to the
 *  runtime `models.json` path. Shared by the production boot refusal (below)
 *  and the development advisory warning (main.ts, prefixed `[boot] `), so the
 *  two can never drift. */
export function noUsableModelMessage(env: Record<string, string | undefined>): string {
  return `no usable model: set ANTHROPIC_API_KEY or add a model to ${path.join(mpaiHome(env), "models.json")}`;
}

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
  capabilities: BootCapabilities,
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
  // Usable-model gate (local-models §2.4): the old hard ANTHROPIC_API_KEY
  // requirement is REMOVED. Production boots when EITHER Anthropic credentials
  // are present (the built-ins route direct) OR at least one routed model is
  // registered (served through the managed proxy). Only a box with neither is
  // refused — a local-only, key-less deployment is now first-class.
  if (!capabilities.hasAnthropicCreds && !capabilities.hasRoutedModels) {
    return { ok: false, error: noUsableModelMessage(env) };
  }
  return { ok: true, staticDir, auth };
}

/** Pure: which base URL the AgentDriver should route through (local-models
 *  §2.2). An active proxy's URL wins; otherwise the operator's own
 *  `ANTHROPIC_BASE_URL` passes through unchanged. `undefined` when neither is
 *  set, so main.ts leaves the env var untouched. */
export function resolveBaseUrl(
  operatorBaseUrl: string | undefined,
  proxyBaseUrl: string | undefined,
): string | undefined {
  return proxyBaseUrl !== undefined ? proxyBaseUrl : operatorBaseUrl;
}

/** Register graceful-shutdown handlers (local-models §2.2). SIGTERM and SIGINT
 *  both stop the managed proxy child, then exit 0. Extracted from main.ts and
 *  process-injected so the wiring is unit-testable without real signals. */
export function installShutdownHandlers(
  proc: { on(ev: string, fn: () => void): void; exit(code: number): void },
  proxyManager: { stop(): void },
): void {
  const shutdown = (): void => {
    proxyManager.stop();
    proc.exit(0);
  };
  proc.on("SIGTERM", shutdown);
  proc.on("SIGINT", shutdown);
}
