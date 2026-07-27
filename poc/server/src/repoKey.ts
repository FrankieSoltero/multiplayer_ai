import { createHash } from "node:crypto";

/** Normalize a git remote URL into a key that is byte-identical across
 *  machines and protocols, so two engineers who cloned the same repo group
 *  together with zero configuration (spec §3.3).
 *
 *      git@github.com:acme/api.git      ─┐
 *      https://github.com/acme/api       ─┼──→  github.com/acme/api
 *      https://github.com/acme/api.git   ─┘
 *
 *  Returns null for anything not recognisably a remote URL — callers fall back
 *  to a machine-local key rather than guessing, because a wrong match is worse
 *  than no match. */
export function normalizeRemote(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0) return null;

  let host: string;
  let rest: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme) {
    // Scheme form: https://, ssh://, git://. Must be checked BEFORE the
    // scp-like branch, whose pattern would otherwise read "https" as a host.
    let after = url.slice(scheme[0].length);
    const at = after.lastIndexOf("@"); // strip user:password@
    if (at !== -1) after = after.slice(at + 1);
    const slash = after.indexOf("/");
    if (slash === -1) return null; // a host with no path is not a repo
    host = after.slice(0, slash);
    rest = after.slice(slash + 1);
  } else {
    // scp-like form: [user@]host:path — git's default for SSH remotes.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (!scp) return null;
    host = scp[1];
    rest = scp[2];
  }

  host = host.replace(/:\d+$/, "").toLowerCase(); // drop port; hosts are case-insensitive
  // Paths are NOT lowercased: on a case-sensitive host, acme/API and acme/api
  // are genuinely different repos and merging them would be a false match.
  rest = rest
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");

  if (host.length === 0 || rest.length === 0) return null;
  return `${host}/${rest}`;
}

/** A key for a repo with no usable remote. Deliberately bound to the machine
 *  so it can NEVER collide with another laptop's copy — silence beats a wrong
 *  match (spec §3.3). The path is hashed rather than embedded so the key does
 *  not leak a user's directory layout onto a shared surface. */
export function localRepoKey(hostname: string, repoRoot: string): string {
  const digest = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  return `local:${hostname.toLowerCase()}:${digest}`;
}

/** The repo key for a session: the normalized remote when there is one,
 *  otherwise a machine-local key. */
export function repoKeyFor(
  remoteUrl: string | null,
  ctx: { hostname: string; repoRoot: string },
): string {
  const normalized = remoteUrl === null ? null : normalizeRemote(remoteUrl);
  return normalized ?? localRepoKey(ctx.hostname, ctx.repoRoot);
}
