import type { ProjectSummary } from "./types";

export type ActRefusal = "unknown-project" | "not-a-member" | "not-active" | "no-machine";

/** Why this user cannot act in this project, or null if they can.
 *
 *  Visibility is hub-wide and participation is membership-scoped (spec P2), so
 *  this gates ACTION only — never what is displayed. Order matters: a
 *  non-member is told they are a spectator, not that the team is offline,
 *  which would be a different and misleading problem. */
export function canAct(project: ProjectSummary | null, userId: string): ActRefusal | null {
  if (!project) return "unknown-project";
  if (!project.members.includes(userId)) return "not-a-member";
  if (project.lifecycle !== "active") return "not-active";
  if (!project.machines.some((m) => m.online)) return "no-machine";
  return null;
}

export function refusalText(
  refusal: ActRefusal,
  ctx?: { hubUrl?: string; projectId?: string },
): string {
  switch (refusal) {
    case "unknown-project": return "this project no longer exists";
    case "not-a-member": return "you are spectating — join this project to work in it";
    case "not-active": return "this project is closed";
    case "no-machine":
      return `no machine is online — run: mpai --hub ${ctx?.hubUrl ?? "<url>"} --project ${ctx?.projectId ?? "<id>"}`;
  }
}
