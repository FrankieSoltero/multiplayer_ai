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

  // Windows-style paths use backslashes; no legitimate scp-like or scheme
  // remote URL ever contains one. A bare backslash anywhere is therefore a
  // reliable signal that this is a local filesystem path (e.g. a UNC share
  // "\\server\share\repo" or "C:\repos\api"), not a remote — reject rather
  // than let the scp-like pattern below misparse it into a false key that
  // also leaks the path unhashed.
  if (url.includes("\\")) return null;

  let host: string;
  let rest: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme) {
    // Scheme form: https://, ssh://, git://. Must be checked BEFORE the
    // scp-like branch, whose pattern would otherwise read "https" as a host.
    const after = url.slice(scheme[0].length);
    const slash = after.indexOf("/");
    if (slash === -1) return null; // a host with no path is not a repo
    // Userinfo stripping is bounded to the authority (everything before the
    // first "/"), NOT the whole remainder. A `lastIndexOf("@")` over the full
    // string would read past the authority into the path — e.g.
    // "https://github.com/acme/a@b/c.git" has no userinfo at all, but an
    // unbounded scan reads its LAST "@" from inside the path and fabricates
    // host "b", path "c" (a wrong match, not a fail-safe null). Bounding to
    // the authority still finds a real "user:password@" prefix (there is
    // never a "/" inside one), so credential stripping is unaffected.
    let authority = after.slice(0, slash);
    rest = after.slice(slash + 1);
    const at = authority.lastIndexOf("@"); // strip user:password@
    if (at !== -1) authority = authority.slice(at + 1);
    host = authority;
  } else {
    // scp-like form: [user@]host:path — git's default for SSH remotes.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (!scp) return null;
    host = scp[1];
    rest = scp[2];
    // A single-character host is a Windows drive letter (e.g. "C:/Users/...")
    // rather than a hostname. We deliberately do NOT require a dot in the
    // host to reject this — "git@myserver:api.git" and "git@localhost:api.git"
    // are legitimate bare-hostname remotes on a LAN, and a dot requirement
    // would silently degrade those real users to a local-only key. A
    // single-letter host has no such legitimate case, so it is safe to reject.
    if (host.length === 1) return null;
  }

  host = host.replace(/:\d+$/, "").toLowerCase(); // drop port; hosts are case-insensitive
  // A colon surviving the port-strip means the text before the path
  // separator was never a valid "host[:port]" pair to begin with — e.g.
  // "file://C:/Users/..." parses to host "C:" here, and no digits follow the
  // colon so the port regex above doesn't touch it. Reject rather than emit
  // a key built from a drive letter.
  if (host.includes(":")) return null;
  // Paths are NOT lowercased: on a case-sensitive host, acme/API and acme/api
  // are genuinely different repos and merging them would be a false match.
  rest = rest
    // Collapse internal duplicate slashes first: git clones
    // "github.com//acme//api.git" fine, but left uncollapsed it would key
    // differently from the same repo cloned with a normal single-slash
    // remote, silently failing the "same repo, one key" property.
    .replace(/\/{2,}/g, "/")
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
