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

/** The operating knobs the hub reads at boot, all validated in one place so a
 *  typo REFUSES BOOT with a named error instead of silently defaulting (spec
 *  §3, B6). Fields beyond `port`/`host` are produced here now and consumed by
 *  later Branch-B tasks (retention prune, backups, origin check, headroom
 *  gate, proxy-trusted client IP). */
export interface HubOpsConfig {
  port: number;
  host: string;
  origin: string | null;
  /** Explicit number of days to keep event rows. `null` = keep forever — the
   *  record is the product (spec §8.7), so nothing prunes unless this is set. */
  retentionDays: number | null;
  backup: { dir: string; intervalMs: number; keep: number } | null;
  minFreeBytes: number;
  trustProxy: boolean;
}

export type HubConfigResult =
  | { ok: true; config: HubOpsConfig }
  | { ok: false; error: string };

const DEFAULT_PORT = 4000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MIN_FREE_BYTES = 104857600; // 100 MiB
const DEFAULT_BACKUP_INTERVAL_MS = 86400000; // 24h
const DEFAULT_BACKUP_KEEP = 7;
const MIN_BACKUP_INTERVAL_MS = 60000; // never hammer the disk more than once a minute

/** A HOST the deployed port can safely bind to with auth off: reachable only
 *  from the same box, so the loopback-only default (A1a) needs no credentials. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Strict base-10 integer parse: unlike `Number()`, `"41a2"` and `"3.5"` are
 *  rejected (return `null`) rather than coerced to `NaN`/a truncated float. */
function parseIntStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Derives the hub's operating configuration from its environment (spec §3,
 *  B6). Every var is validated: a malformed value returns `{ ok: false }` with
 *  a message that names the var, so nothing boots on a typo.
 *
 *  `auth` (from `hubAuthFrom`) is threaded in because HOST fail-closed depends
 *  on it: a non-loopback bind with no auth would expose the record to the LAN
 *  anonymously, so that combination refuses to boot.
 *
 *  `env` is a parameter, never read from `process.env` inside (house rule). */
export function hubConfigFrom(
  env: NodeJS.ProcessEnv,
  auth: AuthConfig | undefined,
): HubConfigResult {
  // PORT — strict integer in [1, 65535]. Closes the Number()→NaN→port-0 hole.
  let port = DEFAULT_PORT;
  const portRaw = (env.PORT ?? "").trim();
  if (portRaw) {
    const parsed = parseIntStrict(portRaw);
    if (parsed === null || parsed < 1 || parsed > 65535) {
      return {
        ok: false,
        error: `PORT must be an integer between 1 and 65535 (got "${env.PORT}")`,
      };
    }
    port = parsed;
  }

  // HOST — loopback by default; a non-loopback bind demands auth (fail-closed).
  const host = (env.HOST ?? "").trim() || DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(host) && !auth) {
    return {
      ok: false,
      error: `HOST=${host} is not loopback and auth is not configured — refusing to boot; set the GITHUB_* auth vars or keep HOST on 127.0.0.1`,
    };
  }

  // HUB_ORIGIN — a bare origin (scheme + host[:port], no path/query/fragment)
  // carried verbatim; anything else refuses so the origin check is unambiguous.
  let origin: string | null = null;
  const originRaw = (env.HUB_ORIGIN ?? "").trim();
  if (originRaw) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(originRaw);
    } catch {
      parsed = null;
    }
    const bare =
      parsed !== null &&
      (parsed.pathname === "" || parsed.pathname === "/") &&
      parsed.search === "" &&
      parsed.hash === "";
    if (!bare) {
      return {
        ok: false,
        error: `HUB_ORIGIN must be a bare origin like https://hub.example.com (got "${env.HUB_ORIGIN}")`,
      };
    }
    origin = originRaw;
  }

  // HUB_RETENTION_DAYS — unset/empty keeps forever (null); a set value must be
  // a positive integer (0/negative/fractional is a typo, not "keep forever").
  let retentionDays: number | null = null;
  const retentionRaw = (env.HUB_RETENTION_DAYS ?? "").trim();
  if (retentionRaw) {
    const parsed = parseIntStrict(retentionRaw);
    if (parsed === null || parsed < 1) {
      return {
        ok: false,
        error: `HUB_RETENTION_DAYS must be a positive integer number of days (got "${env.HUB_RETENTION_DAYS}")`,
      };
    }
    retentionDays = parsed;
  }

  // HUB_BACKUP_* — the dir is the switch; interval/keep only tune an enabled
  // backup, so setting them without a dir is a misconfiguration, not a default.
  const backupDir = (env.HUB_BACKUP_DIR ?? "").trim();
  const intervalRaw = (env.HUB_BACKUP_INTERVAL_MS ?? "").trim();
  const keepRaw = (env.HUB_BACKUP_KEEP ?? "").trim();
  let backup: HubOpsConfig["backup"] = null;
  if (backupDir) {
    let intervalMs = DEFAULT_BACKUP_INTERVAL_MS;
    if (intervalRaw) {
      const parsed = parseIntStrict(intervalRaw);
      if (parsed === null || parsed < MIN_BACKUP_INTERVAL_MS) {
        return {
          ok: false,
          error: `HUB_BACKUP_INTERVAL_MS must be an integer of at least ${MIN_BACKUP_INTERVAL_MS} ms (got "${env.HUB_BACKUP_INTERVAL_MS}")`,
        };
      }
      intervalMs = parsed;
    }
    let keep = DEFAULT_BACKUP_KEEP;
    if (keepRaw) {
      const parsed = parseIntStrict(keepRaw);
      if (parsed === null || parsed < 1) {
        return {
          ok: false,
          error: `HUB_BACKUP_KEEP must be an integer of at least 1 (got "${env.HUB_BACKUP_KEEP}")`,
        };
      }
      keep = parsed;
    }
    backup = { dir: backupDir, intervalMs, keep };
  } else if (intervalRaw || keepRaw) {
    return {
      ok: false,
      error: "HUB_BACKUP_INTERVAL_MS/HUB_BACKUP_KEEP require HUB_BACKUP_DIR",
    };
  }

  // HUB_MIN_FREE_BYTES — non-negative integer; default 100 MiB of headroom.
  let minFreeBytes = DEFAULT_MIN_FREE_BYTES;
  const minFreeRaw = (env.HUB_MIN_FREE_BYTES ?? "").trim();
  if (minFreeRaw) {
    const parsed = parseIntStrict(minFreeRaw);
    if (parsed === null || parsed < 0) {
      return {
        ok: false,
        error: `HUB_MIN_FREE_BYTES must be a non-negative integer (got "${env.HUB_MIN_FREE_BYTES}")`,
      };
    }
    minFreeBytes = parsed;
  }

  // HUB_TRUST_PROXY — opt-in exactly, "1" only; anything else stays off so the
  // client IP is only ever read from proxy headers when explicitly asked for.
  const trustProxy = (env.HUB_TRUST_PROXY ?? "").trim() === "1";

  return {
    ok: true,
    config: { port, host, origin, retentionDays, backup, minFreeBytes, trustProxy },
  };
}

/** The boot lines that announce which non-default operating controls are live,
 *  one per enabled/non-default control in a fixed order. Pure so `main.ts` can
 *  print it and a test can assert it without spawning the process. */
export function opsBootLines(config: HubOpsConfig): string[] {
  const lines: string[] = [];
  if (config.retentionDays !== null) lines.push(`retention: ${config.retentionDays}d`);
  if (config.backup) {
    lines.push(
      `backups: ${config.backup.dir} every ${config.backup.intervalMs}ms keep ${config.backup.keep}`,
    );
  }
  if (config.origin !== null) lines.push(`origin check: ${config.origin}`);
  if (config.minFreeBytes !== DEFAULT_MIN_FREE_BYTES) {
    lines.push(`min free bytes: ${config.minFreeBytes}`);
  }
  if (config.trustProxy) lines.push("trusting proxy headers for client ip");
  return lines;
}
