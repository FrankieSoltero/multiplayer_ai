export type ConfigResult =
  | { ok: true; staticDir: string | undefined }
  | { ok: false; error: string };

/** Validates the deployed process's configuration at boot.
 *
 *  Production mode is signalled by CLIENT_DIST being set — only the deployed
 *  box sets it, so local development behaviour is untouched (spec §3.2).
 *
 *  The filesystem probe is injected rather than called directly so this stays
 *  a pure function, testable without a temp dir or process.exit. */
export function validateProductionConfig(
  env: Record<string, string | undefined>,
  hasIndexHtml: (dir: string) => boolean,
): ConfigResult {
  const staticDir = env.CLIENT_DIST;
  if (!staticDir) return { ok: true, staticDir: undefined };

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
  return { ok: true, staticDir };
}
