import type { LoggedEvent } from "multiplayer-ai-server/events";
import { arcadeRecordsFrom, type ProjectMessage } from "multiplayer-ai-server/project";
import type { SessionFacts } from "multiplayer-ai-server/relayProtocol";

export interface StoredEvent {
  /** The hub's own monotonic id, per session. Browsers resume from this, NOT
   *  from the laptop's `seq` — which restarts at 0 on every new run. */
  id: number;
  runId: string;
  event: LoggedEvent;
}

interface HubSession {
  uplinkId: string;
  facts: SessionFacts;
  events: StoredEvent[];
  /** Last (runId, seq) accepted, so a reconnecting laptop that resumes from a
   *  stale offset re-sends without duplicating the log for every watcher. */
  lastRunId: string | null;
  lastSeq: number;
}

interface Uplink {
  uplinkId: string;
  projectId: string;
  repoKey: string;
  online: boolean;
}

export type SetFactsResult = { ok: true } | { ok: false; error: string };

/** Everything the hub knows, with no sockets. Kept a plain class over pure
 *  data so the whole of Task 7's routing is testable without a network.
 *
 *  v7b1 holds this in memory, exactly like today's server (spec §2.11).
 *  Durability across hub restarts is v7c and must not be presented to users
 *  as durable before then (spec §8). */
export class HubStore {
  private uplinks = new Map<string, Uplink>();
  /** projectId → sessionId → session */
  private projects = new Map<string, Map<string, HubSession>>();

  attach(uplinkId: string, projectId: string, repoKey: string): void {
    this.uplinks.set(uplinkId, { uplinkId, projectId, repoKey, online: true });
  }

  /** The laptop is gone. Its sessions stay — that is the point of the hub —
   *  but they must read `offline`, because an offline laptop cannot be driven
   *  or approved and its agent is not running either (spec §8). */
  detach(uplinkId: string): void {
    const uplink = this.uplinks.get(uplinkId);
    if (uplink) uplink.online = false;
  }

  private sessionsOf(projectId: string): Map<string, HubSession> {
    let sessions = this.projects.get(projectId);
    if (!sessions) {
      sessions = new Map();
      this.projects.set(projectId, sessions);
    }
    return sessions;
  }

  /** What the hub already holds for this laptop's sessions, so the laptop can
   *  replay only the gap (spec §3.2 — "reconnect is nearly free"). */
  resumeOffsets(uplinkId: string): Record<string, { runId: string; lastSeq: number }> {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return {};
    const out: Record<string, { runId: string; lastSeq: number }> = {};
    for (const [sessionId, session] of this.sessionsOf(uplink.projectId)) {
      if (session.uplinkId !== uplinkId || session.lastRunId === null) continue;
      out[sessionId] = { runId: session.lastRunId, lastSeq: session.lastSeq };
    }
    return out;
  }

  setFacts(
    uplinkId: string,
    sessionId: string,
    runId: string,
    facts: SessionFacts,
  ): SetFactsResult {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return { ok: false, error: "unknown uplink" };
    const sessions = this.sessionsOf(uplink.projectId);
    const existing = sessions.get(sessionId);
    if (existing && existing.uplinkId !== uplinkId) {
      // Loud, not silent. Two laptops can each have a session named "auth";
      // merging their streams into one row would be worse than refusing.
      // Hub-scoped session ids are a v7c/v7e problem (spec §9 is its sibling).
      return {
        ok: false,
        error: `session "${sessionId}" in project "${uplink.projectId}" is already owned by another machine`,
      };
    }
    if (existing) {
      existing.facts = facts;
      return { ok: true };
    }
    // `runId` is deliberately NOT recorded here. resumeOffsets skips sessions
    // whose lastRunId is still null, so a facts-only session reports nothing
    // and the laptop replays from 0 — which is correct, because the hub holds
    // no events for it yet. Recording it here would make the hub claim an
    // offset it cannot back with stored events.
    sessions.set(sessionId, {
      uplinkId,
      facts,
      events: [],
      lastRunId: null,
      lastSeq: -1,
    });
    return { ok: true };
  }

  /** A laptop may publish only for sessions it owns (spec §3.5 rule 2). */
  publish(uplinkId: string, sessionId: string, runId: string, events: LoggedEvent[]): StoredEvent[] {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return [];
    const sessions = this.sessionsOf(uplink.projectId);
    let session = sessions.get(sessionId);
    if (!session) {
      session = { uplinkId, facts: emptyFacts(sessionId, uplink.repoKey), events: [], lastRunId: null, lastSeq: -1 };
      sessions.set(sessionId, session);
    }
    if (session.uplinkId !== uplinkId) return [];

    const accepted: StoredEvent[] = [];
    for (const event of events) {
      const seq = typeof event.seq === "number" ? event.seq : -1;
      // Same run, already-seen seq → a resume overshoot, not new history.
      if (runId === session.lastRunId && seq <= session.lastSeq) continue;
      const stored: StoredEvent = { id: session.events.length + 1, runId, event };
      session.events.push(stored);
      accepted.push(stored);
      session.lastRunId = runId;
      session.lastSeq = seq;
    }
    return accepted;
  }

  ownerOf(projectId: string, sessionId: string): string | null {
    return this.sessionsOf(projectId).get(sessionId)?.uplinkId ?? null;
  }

  eventsFor(projectId: string, sessionId: string, fromId: number): StoredEvent[] {
    const session = this.sessionsOf(projectId).get(sessionId);
    if (!session) return [];
    return session.events.filter((e) => e.id > fromId);
  }

  /** The team view. Only the hub sees every laptop, so only the hub can build
   *  it (spec §3.2). `presence` comes from the uplink and nothing else; every
   *  other field is exactly what the owning laptop declared, so a hub-attached
   *  session renders identically to a standalone one. */
  snapshot(projectId: string): ProjectMessage {
    const sessions = [...this.sessionsOf(projectId).values()];
    return {
      type: "project",
      sessions: sessions.map((session) => ({
        ...session.facts,
        presence: this.uplinks.get(session.uplinkId)?.online ? ("online" as const) : ("offline" as const),
      })),
      arcade: arcadeRecordsFrom(sessions.map((s) => s.events.map((e) => e.event))),
      // Plugins are laptop-local files the agent loads (spec §4) and the hub
      // does not aggregate them in v7b1. The panel reads empty when
      // hub-attached; surfacing per-laptop plugin rosters is v7b3.
      plugins: [],
      pluginsEnabled: false,
      // A hub spans repos, so there is no single `repo` for it to report. The
      // per-session `repoKey` is the honest answer and the client already
      // reads it (v7a).
      repo: null,
      // Oversight is host-configured and hub-side (spec §3.7) — v7b3.
      oversight: { enabled: false, latest: null },
    };
  }
}

function emptyFacts(sessionId: string, repoKey: string): SessionFacts {
  return {
    id: sessionId,
    participants: [],
    driverName: null,
    intent: null,
    lastActivityTs: null,
    ended: false,
    pendingGate: null,
    skills: [],
    repoKey,
    lifecycle: "open",
  };
}
