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

  /** Creating. Only a write path (`setFacts`, `publish`) may call this: an
   *  uplink is a semi-trusted, bounded peer. */
  private sessionsOf(projectId: string): Map<string, HubSession> {
    let sessions = this.projects.get(projectId);
    if (!sessions) {
      sessions = new Map();
      this.projects.set(projectId, sessions);
    }
    return sessions;
  }

  /** Non-creating, for every READ path. A browser can name an arbitrary
   *  projectId (`peek`, `watch_project`, `join`), and a creating read would let
   *  unauthenticated input grow `projects` without bound — permanently, since
   *  nothing reclaims a project when its socket closes. It also keeps `peek`
   *  parity with the standalone server, which reads with `projects.get` and
   *  answers an unknown project with a synthetic empty snapshot rather than
   *  creating one (server.ts's `peek` handler). */
  private readSessionsOf(projectId: string): Map<string, HubSession> | undefined {
    return this.projects.get(projectId);
  }

  /** What the hub already holds for this laptop's sessions, so the laptop can
   *  replay only the gap (spec §3.2 — "reconnect is nearly free"). */
  resumeOffsets(uplinkId: string): Record<string, { runId: string; lastSeq: number }> {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return {};
    const out: Record<string, { runId: string; lastSeq: number }> = {};
    for (const [sessionId, session] of this.readSessionsOf(uplink.projectId) ?? []) {
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

  /** A laptop may publish only for sessions it owns (spec §3.5 rule 2).
   *  Returns the same `StoredEvent` instances now held in `session.events` —
   *  read-only for the caller. Mutating a returned event (or its nested
   *  `.event` payload) corrupts stored history for every future reader,
   *  including browsers replaying from an earlier id. Deliberately NOT
   *  copied: this is the fan-out path that watcher count multiplies, and it
   *  stays allocation-free beyond the new `accepted` array shell. */
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
      // parseUpFrame validates `events` is an array but not each element's
      // shape (Task 1 ruling) — a frame can legally carry `null`, a string,
      // or a number here. Guard the element itself before reading `.seq` so
      // a malformed element degrades to "skipped", not a crash that kills
      // the hub process. This is a crash guard, not validation: a
      // malformed element is simply never stored.
      if (typeof event !== "object" || event === null) continue;
      // The `seq` must be a real log offset, because it becomes
      // `session.lastSeq` — the high-water mark every later event is compared
      // against and the value `resumeOffsets` hands back in `welcome`. A
      // single `seq: 9e99` (legal JSON, and `Number.isInteger(9e99)` is true,
      // so `parseDownFrame` waves it back through) would freeze this session's
      // history for the life of the hub AND make the resume protocol confirm
      // the corruption instead of repairing it: the laptop would replay from
      // 9e99, which is an empty slice. Non-integer, negative and non-numeric
      // `seq` were already skipped by the comparison below; this only makes
      // the range explicit and closes the out-of-range end of it.
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) continue;
      const seq = event.seq;
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
    return this.readSessionsOf(projectId)?.get(sessionId)?.uplinkId ?? null;
  }

  /** Returns the store's own `StoredEvent` instances — read-only for the
   *  caller; mutating them corrupts stored history for every future reader.
   *  See `publish`'s note: this is the fan-out path watcher count
   *  multiplies, so it stays allocation-free beyond the new `.filter()`
   *  array shell. */
  eventsFor(projectId: string, sessionId: string, fromId: number): StoredEvent[] {
    const session = this.readSessionsOf(projectId)?.get(sessionId);
    if (!session) return [];
    return session.events.filter((e) => e.id > fromId);
  }

  /** The team view. Only the hub sees every laptop, so only the hub can build
   *  it (spec §3.2). `presence` comes from the uplink and nothing else; every
   *  other field is exactly what the owning laptop declared, so a hub-attached
   *  session renders identically to a standalone one.
   *
   *  Unlike `publish`/`eventsFor`, this result IS deep-copied (the nested
   *  `participants`, `skills` and `pendingGate`) rather than documented
   *  read-only: this is the value that leaves the hub toward browsers, and
   *  the caller (Task 7) is expected to normalize it further before
   *  serializing — so nothing it mutates may reach back into stored state. */
  snapshot(projectId: string): ProjectMessage {
    const sessions = [...(this.readSessionsOf(projectId)?.values() ?? [])];
    return {
      type: "project",
      sessions: sessions.map((session) => ({
        ...session.facts,
        participants: [...session.facts.participants],
        skills: session.facts.skills.map((skill) => ({ ...skill })),
        pendingGate: session.facts.pendingGate ? { ...session.facts.pendingGate } : null,
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
