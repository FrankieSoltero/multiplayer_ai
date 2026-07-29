import type { AgentDriver } from "./agentDriver.js";
import { summarizeSession } from "./digest.js";
import { pendingGateOf, type PendingGate } from "./pendingGate.js";
import type { Session } from "./session.js";
import type { LoggedEvent, SkillInfo } from "./events.js";
import type { PluginInfo } from "./pluginStore.js";
import type { OversightSummary } from "./overseer.js";
import { lifecycleOf, type Lifecycle } from "./lifecycle.js";
import type { SessionFacts } from "./relayProtocol.js";

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

/** Best score per game across a set of event logs. Holder identity is resolved
 *  from presence_join events (NOT a live participants map) so a record survives
 *  its holder leaving, and identities are collected across ALL logs before the
 *  scores are attributed — on the hub the join and the score routinely arrive
 *  on different sessions of the same project.
 *  Ties break chronologically (earliest timestamp wins), regardless of
 *  iteration order. */
export function arcadeRecordsFrom(logs: LoggedEvent[][]): ArcadeRecord[] {
  const identities = new Map<string, { name: string; glyph?: string; color?: string }>();
  const best = new Map<string, { userId: string; score: number; ts: string }>();
  for (const events of logs) {
    for (const ev of events) {
      if (ev.type === "presence_join" && ev.userId && ev.name) {
        identities.set(ev.userId, { name: ev.name, glyph: ev.glyph, color: ev.color });
      }
    }
  }
  for (const events of logs) {
    for (const ev of events) {
      if (ev.type !== "game_score") continue;
      if (!Number.isInteger(ev.score) || ev.score <= 0) continue; // degrade, don't crash
      const cur = best.get(ev.game);
      if (!cur || ev.score > cur.score || (ev.score === cur.score && ev.ts < cur.ts)) {
        best.set(ev.game, { userId: ev.userId, score: ev.score, ts: ev.ts });
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

/** Cost: O(total project events) per throttled push — fine for an in-memory
 *  POC; an incremental best-map is the upgrade path if event counts grow. */
function arcadeRecords(project: Project): ArcadeRecord[] {
  return arcadeRecordsFrom(
    [...project.sessions.values()].map((entry) => entry.session.eventsFrom(0)),
  );
}

/** The single producer of a session's snapshot row (spec §3.2). `presence` is
 *  deliberately NOT here: it is the one fact only the hub can know, so the
 *  standalone path adds a constant "online" and the hub adds the real value.
 *  Keeping every other field in one function is what stops a hub-attached
 *  session from rendering differently than a standalone one. */
export function sessionFactsOf(
  id: string,
  entry: ProjectSessionEntry,
  repoKey: string | null,
): SessionFacts {
  const events = entry.session.eventsFrom(0);
  const summary = summarizeSession(id, events, entry.driver.isDead);
  const participants = entry.session.participantList;
  const driverId = entry.session.driverId;
  return {
    id,
    participants: participants.map((p) => p.name),
    driverName: participants.find((p) => p.userId === driverId)?.name ?? null,
    intent: summary.intent,
    lastActivityTs: events.at(-1)?.ts ?? null,
    ended: summary.ended,
    pendingGate: pendingGateOf(events),
    skills: entry.skills,
    repoKey,
    lifecycle: lifecycleOf(events),
  };
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
    /** Stable cross-machine repo identity (spec §3.3). Null when the server
     *  was launched outside a repo. Every session on a standalone server
     *  carries the SAME key — it is per-session because v7b's hub holds
     *  sessions from many repos at once. */
    repoKey: string | null;
    /** Has someone deliberately ended this session (spec §3.4)? Orthogonal to
     *  `ended`, which is about the agent process. */
    lifecycle: Lifecycle;
    /** Is the machine that owns this session reachable (spec §3.4)? Always
     *  "online" on a standalone server, which owns every session it reports.
     *  v7b derives it from the hub uplink and it becomes a real signal — the
     *  field exists now so the client learns the shape before the hub does. */
    presence: "online" | "offline";
    /** Which machine owns this session. Only a hub can answer this — a
     *  standalone server has exactly one machine and omits the field, just
     *  like `machines` above. */
    machineId?: string;
  }[];
  arcade: ArcadeRecord[];
  plugins: PluginInfo[];
  pluginsEnabled: boolean;
  repo: { defaultBranch: string; key: string } | null;
  oversight: { enabled: boolean; latest: OversightSummary | null };
  /** Which machines are in this project, and which repo each offers. A hub
   *  reports every machine that has attached; a standalone server reports
   *  exactly one — itself (solo-mode fix, spec: entrance stays reachable in
   *  solo) — using its own `repoKey` for both `machineId` and `repoKey`, since
   *  it has no other machine identity to offer. Omitted (not an empty array)
   *  only when the standalone server was launched with no workspace, which
   *  the field being optional accommodates. */
  machines?: { machineId: string; repoKey: string; online: boolean }[];
}

export function projectSnapshot(
  project: Project,
  pluginState?: { plugins: PluginInfo[]; enabled: boolean },
  repo?: { defaultBranch: string; key: string } | null,
  oversight?: { enabled: boolean; latest: OversightSummary | null },
): ProjectMessage {
  const sessions = [...project.sessions.entries()].map(([id, entry]) => ({
    ...sessionFactsOf(id, entry, repo?.key ?? null),
    // A standalone server owns every session it reports, so its uplink is
    // trivially reachable (spec §3.4). The hub replaces this with the real
    // uplink state; the field exists on both paths so the client has one shape.
    presence: "online" as const,
  }));
  return {
    type: "project",
    sessions,
    arcade: arcadeRecords(project),
    plugins: pluginState?.plugins ?? [],
    pluginsEnabled: pluginState?.enabled ?? false,
    repo: repo ?? null,
    oversight: oversight ?? { enabled: false, latest: null },
    // The solo-mode fix (spec: entrance stays reachable in solo). A standalone
    // server has exactly one machine — itself — so it reports that machine
    // honestly rather than omitting `machines` and leaving the project screen
    // to read `0 MACHINES` and grey out its repo <select>. `repo` is the only
    // identity this machine has; with no workspace there is nothing truthful
    // to report, so the field stays undefined exactly as it always has.
    machines: repo ? [{ machineId: repo.key, repoKey: repo.key, online: true }] : undefined,
  };
}

export interface MachineSummary {
  machineId: string;
  repoKey: string;
  online: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  lifecycle: "active" | "closed" | "archived";
  members: string[];
  sessionCount: number;
  liveSessionCount: number;
  machines: MachineSummary[];
}

/** The entrance/project-screen row for one project on a STANDALONE server
 *  (solo-mode fix). A standalone server has no cross-machine project registry
 *  — that is the hub's `HubStore` — and no membership concept at all: anyone
 *  who can reach this server may already join any session in any project with
 *  no membership check (see `join` above). Reporting the requesting
 *  connection's own identity as this project's sole member is therefore not a
 *  fiction; it makes the server's existing security model explicit in the new
 *  wire shape, which is exactly what stops
 *  `poc/client/src/projectAccess.ts`'s `canAct` from telling a solo user
 *  "you are spectating" or "run: mpai --hub <url> --project <id>" — there is
 *  no hub to attach to in this mode.
 *
 *  `lifecycle` is always "active": closing a project is a hub-only concept
 *  (`set_project_lifecycle`) this server does not implement, so there is
 *  nothing else it could honestly report. `machines` mirrors `projectSnapshot`
 *  above: exactly one machine, this one, keyed by its own `repoKey` for both
 *  `machineId` and `repoKey` — a standalone server has no separate machine
 *  identity to report — omitted when the server has no workspace (a
 *  test-only path; the CLI always requires a repo to launch). */
export function projectSummaryOf(
  project: Project,
  memberUserId: string | null,
  repoKey: string | null,
): ProjectSummary {
  const sessions = [...project.sessions.values()];
  return {
    id: project.id,
    name: project.id,
    lifecycle: "active",
    members: memberUserId ? [memberUserId] : [],
    sessionCount: sessions.length,
    liveSessionCount: sessions.filter(
      (entry) => lifecycleOf(entry.session.eventsFrom(0)) === "open",
    ).length,
    machines: repoKey ? [{ machineId: repoKey, repoKey, online: true }] : [],
  };
}
