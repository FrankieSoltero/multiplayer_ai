import type { ProjectSessionInfo } from "./types";

export type RepoGroup = { repoKey: string; sessions: ProjectSessionInfo[] };

/** Group sessions under the repo they belong to, preserving first-seen repo
 *  order and the caller's session order within each group.
 *
 *  Sessions with no repo key collect under "" rather than being dropped: a
 *  snapshot from a standalone server carries no key, and a session that
 *  vanished from the list would be worse than one grouped as unknown. */
export function groupByRepo(sessions: ProjectSessionInfo[]): RepoGroup[] {
  const groups = new Map<string, ProjectSessionInfo[]>();
  for (const session of sessions) {
    const key = session.repoKey ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(session);
    else groups.set(key, [session]);
  }
  return [...groups.entries()].map(([repoKey, list]) => ({ repoKey, sessions: list }));
}
