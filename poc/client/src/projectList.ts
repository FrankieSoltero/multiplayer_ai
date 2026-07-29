import type { ProjectSummary } from "./types";

/** Archived projects are behind a toggle, not on the default list (spec §4.1).
 *  Closed ones stay: they are readable, just not workable. */
export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return projects
    .filter((p) => p.lifecycle !== "archived")
    .sort((a, b) => b.liveSessionCount - a.liveSessionCount || a.name.localeCompare(b.name));
}

export function projectSummaryLine(project: ProjectSummary): string {
  if (project.sessionCount === 0 && project.machines.length === 0) return "no sessions yet";
  const online = project.machines.filter((m) => m.online).length;
  return (
    `${project.liveSessionCount} of ${project.sessionCount} sessions live · ` +
    `${online} of ${project.machines.length} machines online`
  );
}
