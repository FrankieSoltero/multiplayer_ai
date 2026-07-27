import type { AgentDriver } from "./agentDriver.js";
import { summarizeSession } from "./digest.js";
import { pendingGateOf, type PendingGate } from "./pendingGate.js";
import type { Session } from "./session.js";
import type { SkillInfo } from "./events.js";
import type { PluginInfo } from "./pluginStore.js";
import type { OversightSummary } from "./overseer.js";

export const SLUG = /^[a-z0-9-]{1,40}$/;

export interface ProjectSessionEntry {
  session: Session;
  driver: AgentDriver;
  skills: SkillInfo[];
  pendingSuggests: Map<string, { skill: string; args: string }>;
  /** One-shot flag: the driver pulled the team summary; inject <oversight>
   *  into the next prompt only (spec §5). */
  pendingOversight: boolean;
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
 *  a record survives its holder leaving. Ties break chronologically (earliest
 *  timestamp wins), regardless of session iteration order.
 *  Cost: O(total project events) per throttled push — fine for an in-memory
 *  POC; an incremental best-map is the upgrade path if event counts grow. */
function arcadeRecords(project: Project): ArcadeRecord[] {
  const identities = new Map<string, { name: string; glyph?: string; color?: string }>();
  const best = new Map<string, { userId: string; score: number; ts: string }>();
  for (const entry of project.sessions.values()) {
    for (const ev of entry.session.eventsFrom(0)) {
      if (ev.type === "presence_join" && ev.userId && ev.name) {
        identities.set(ev.userId, { name: ev.name, glyph: ev.glyph, color: ev.color });
      }
      if (ev.type === "game_score") {
        if (!Number.isInteger(ev.score) || ev.score <= 0) continue; // degrade, don't crash
        const cur = best.get(ev.game);
        if (!cur || ev.score > cur.score || (ev.score === cur.score && ev.ts < cur.ts)) {
          best.set(ev.game, { userId: ev.userId, score: ev.score, ts: ev.ts });
        }
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
    /** The oldest permission request nobody has answered, or null. Recipients
     *  compare `sinceTs` against their own threshold — the server publishes
     *  when the waiting started and holds no opinion about when it matters. */
    pendingGate: PendingGate | null;
    skills: SkillInfo[];
  }[];
  arcade: ArcadeRecord[];
  plugins: PluginInfo[];
  pluginsEnabled: boolean;
  repo: { defaultBranch: string } | null;
  oversight: { enabled: boolean; latest: OversightSummary | null };
}

export function projectSnapshot(
  project: Project,
  pluginState?: { plugins: PluginInfo[]; enabled: boolean },
  repo?: { defaultBranch: string } | null,
  oversight?: { enabled: boolean; latest: OversightSummary | null },
): ProjectMessage {
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
      pendingGate: pendingGateOf(events),
      skills: entry.skills,
    };
  });
  return {
    type: "project",
    sessions,
    arcade: arcadeRecords(project),
    plugins: pluginState?.plugins ?? [],
    pluginsEnabled: pluginState?.enabled ?? false,
    repo: repo ?? null,
    oversight: oversight ?? { enabled: false, latest: null },
  };
}
