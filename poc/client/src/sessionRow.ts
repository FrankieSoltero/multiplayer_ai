import type { ProjectSessionInfo } from "./types";

/** Pure helpers for the session picker (no component-test infra in this
 *  repo — recorded pattern). */

export function sortSessions(sessions: ProjectSessionInfo[]): ProjectSessionInfo[] {
  return [...sessions].sort((a, b) =>
    (b.lastActivityTs ?? "").localeCompare(a.lastActivityTs ?? ""),
  );
}

export function agentStateLabel(ended: boolean): string {
  return ended ? "ENDED" : "LIVE";
}

/** Mirror of the server's slugify (poc/server/src/workspace.ts) so the form
 *  can preview the id a name will become — keep them in sync. */
export function slugPreview(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
