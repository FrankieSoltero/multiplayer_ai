import type { AgentDriver } from "./agentDriver.js";
import { summarizeSession } from "./digest.js";
import type { Session } from "./session.js";
import type { SkillInfo } from "./events.js";

export const SLUG = /^[a-z0-9-]{1,40}$/;

export interface ProjectSessionEntry {
  session: Session;
  driver: AgentDriver;
  skills: SkillInfo[];
  pendingSuggests: Map<string, { skill: string; args: string }>;
}

/** Minimal structural type so tests don't need real sockets. */
export interface ProjectWatcher {
  send(data: string): void;
  readyState: number;
}

export class Project {
  readonly id: string;
  readonly sessions = new Map<string, ProjectSessionEntry>();
  readonly watchers = new Set<ProjectWatcher>();

  constructor(id: string) {
    this.id = id;
  }
}

export interface ProjectMessage {
  type: "project";
  sessions: {
    id: string;
    participants: string[];
    driverName: string | null;
    intent: string | null;
    lastActivityTs: string | null;
    ended: boolean;
  }[];
}

export function projectSnapshot(project: Project): ProjectMessage {
  const sessions = [...project.sessions.entries()].map(([id, entry]) => {
    const events = entry.session.eventsFrom(0);
    const summary = summarizeSession(id, events, entry.driver.isDead);
    const participants = entry.session.participantList;
    const driverId = entry.session.driverId;
    return {
      id,
      participants: participants.map((p) => p.name),
      driverName:
        participants.find((p) => p.userId === driverId)?.name ?? null,
      intent: summary.intent,
      lastActivityTs: events.at(-1)?.ts ?? null,
      ended: summary.ended,
    };
  });
  return { type: "project", sessions };
}
