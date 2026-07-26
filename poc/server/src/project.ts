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

export interface ArcadeRecord {
  game: string;
  score: number;
  userId: string;
  name: string;
  glyph?: string;
  color?: string;
}

/** Best score per game across every session in the project. Holder identity
 *  is resolved from presence_join events (NOT the live participants map) so
 *  a record survives its holder leaving. Ties keep the earlier holder. */
function arcadeRecords(project: Project): ArcadeRecord[] {
  const identities = new Map<string, { name: string; glyph?: string; color?: string }>();
  const best = new Map<string, { userId: string; score: number }>();
  for (const entry of project.sessions.values()) {
    for (const ev of entry.session.eventsFrom(0)) {
      if (ev.type === "presence_join" && ev.userId && ev.name) {
        identities.set(ev.userId, { name: ev.name, glyph: ev.glyph, color: ev.color });
      }
      if (ev.type === "game_score") {
        if (!Number.isInteger(ev.score) || ev.score <= 0) continue; // degrade, don't crash
        const cur = best.get(ev.game);
        if (!cur || ev.score > cur.score) best.set(ev.game, { userId: ev.userId, score: ev.score });
      }
    }
  }
  const out: ArcadeRecord[] = [];
  for (const [game, rec] of best) {
    const id = identities.get(rec.userId);
    out.push({
      game,
      score: rec.score,
      userId: rec.userId,
      name: id?.name ?? "unknown",
      glyph: id?.glyph,
      color: id?.color,
    });
  }
  return out.sort((a, b) => a.game.localeCompare(b.game));
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
    skills: SkillInfo[];
  }[];
  arcade: ArcadeRecord[];
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
      skills: entry.skills,
    };
  });
  return { type: "project", sessions, arcade: arcadeRecords(project) };
}
