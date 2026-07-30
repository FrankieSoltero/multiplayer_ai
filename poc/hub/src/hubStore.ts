import type { LoggedEvent } from "multiplayer-ai-server/events";
import { arcadeRecordsFrom, type ProjectMessage } from "multiplayer-ai-server/project";
import type { RecordSessionInput } from "multiplayer-ai-server/record";
import type { RepoDecl, SessionFacts } from "multiplayer-ai-server/relayProtocol";

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
  /** As declared in `hello` — already bounded to 40 by `parseUpFrame`. */
  name: string;
  /** Everything this machine offers, attached and candidate alike. Only ever
   *  overwritten WHOLESALE, from `attach` or `setRepos`, because the machine's
   *  own list is the only authority on it (spec §5.2). */
  repos: RepoDecl[];
  online: boolean;
}

export type SetFactsResult = { ok: true } | { ok: false; error: string };

export type ProjectLifecycle = "active" | "closed" | "archived";

interface ProjectRecord {
  id: string;
  /** What the user typed. Equal to `id` for a project auto-created by a
   *  machine attaching, because nobody has named it yet. */
  name: string;
  /** null = auto-created by an attaching machine, not by a person. */
  createdBy: string | null;
  createdAt: string;
  members: Set<string>;
  lifecycle: ProjectLifecycle;
}

export interface MachineInfo {
  machineId: string;
  name: string;
  repos: RepoDecl[];
  online: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  lifecycle: ProjectLifecycle;
  members: string[];
  sessionCount: number;
  liveSessionCount: number;
  machines: MachineInfo[];
}

/** Where the hub's state goes to survive a restart (spec §3.3). Every method
 *  is a MUTATION the store has decided to make and has not applied yet: the
 *  store calls the persister FIRST and only then touches memory, so a
 *  persister that refuses (throws) leaves memory exactly as it was and the
 *  refusal reaches the caller. That ordering is the branch's core invariant —
 *  **durable before visible** — because the alternative lets a browser see an
 *  event a restarted hub has forgotten, while `resumeOffsets` tells the owning
 *  laptop not to re-send it: history lost with nothing left to notice.
 *
 *  Arguments are the store's own instances, not copies, and are read-only for
 *  the implementation (see `publish`'s note — `eventsAppended` is on the
 *  fan-out path). An implementation that keeps them must serialize, not
 *  retain. */
export interface HubPersister {
  projectSaved(p: { id: string; name: string; createdBy: string | null; createdAt: string; lifecycle: ProjectLifecycle }): void;
  memberAdded(projectId: string, userId: string): void;
  memberRemoved(projectId: string, userId: string): void;
  machineSaved(m: { uplinkId: string; projectId: string; name: string; repos: RepoDecl[] }): void;
  sessionSaved(s: { projectId: string; sessionId: string; uplinkId: string; facts: SessionFacts; lastRunId: string | null; lastSeq: number }): void;
  eventsAppended(
    projectId: string,
    sessionId: string,
    events: StoredEvent[],
    lastRunId: string,
    lastSeq: number,
    newSession?: { uplinkId: string; facts: SessionFacts },
  ): void;
  // `newSession` is set exactly when this publish frame implicitly created the
  // session — the persister must write the session row AND the events in ONE
  // transaction (spec §3.3, one transaction per frame).
}

/** Everything a restarting hub reads back out of the record (spec §3.4), in
 *  exactly the shape it goes in as: the rows a `HubPersister` was handed, with
 *  each project's members and each session's events gathered onto their owner.
 *
 *  **Order is meaningful.** `listProjects()`, `machinesIn()` and `snapshot()`
 *  all report in the store's own map-insertion order, and members report in
 *  Set-insertion order, so the arrays here must arrive in the order the record
 *  first learned each row — which is what a rowid-ordered SQL read gives. Sort
 *  them differently and the hydrated hub answers the same facts in a different
 *  order, which is a visible difference to a browser diffing a project view.
 *
 *  Runtime state is deliberately absent: no `online`, no sockets, no watchers.
 *  Every hydrated machine reads offline and every hydrated session reads
 *  `presence: "offline"` until its laptop re-attaches. */
export interface HubHydration {
  projects: { id: string; name: string; createdBy: string | null; createdAt: string; lifecycle: ProjectLifecycle; members: string[] }[];
  machines: { uplinkId: string; projectId: string; name: string; repos: RepoDecl[] }[];
  sessions: { projectId: string; sessionId: string; uplinkId: string; facts: SessionFacts; lastRunId: string | null; lastSeq: number; events: StoredEvent[] }[];
}

/** The default: the hub keeps no record at all, which is what every caller
 *  that does not ask for one gets. Module-private and stateless, so it costs a
 *  bare call — nothing allocated — on `publish`, the hottest write path. */
const noOpPersister: HubPersister = {
  projectSaved() {},
  memberAdded() {},
  memberRemoved() {},
  machineSaved() {},
  sessionSaved() {},
  eventsAppended() {},
};

/** Everything the hub knows, with no sockets. Kept a plain class over pure
 *  data so the whole of Task 7's routing is testable without a network.
 *
 *  Memory is the store's working set; the injected `HubPersister` is the
 *  record behind it (spec §3.3). With no persister injected the store is
 *  exactly the in-memory one it has always been. */
export class HubStore {
  private uplinks = new Map<string, Uplink>();
  /** projectId → sessionId → session */
  private projects = new Map<string, Map<string, HubSession>>();
  private projectMeta = new Map<string, ProjectRecord>();
  private persister: HubPersister;

  constructor(persister: HubPersister = noOpPersister, hydration?: HubHydration) {
    this.persister = persister;
    if (hydration) this.hydrate(hydration);
  }

  /** Boot (spec §3.4). Rebuilds memory straight from the record, WITHOUT going
   *  through the mutators — deliberately, for two reasons: the mutators would
   *  hand every row back to the persister and rewrite the whole record on every
   *  restart, and several of them would refuse or rewrite what they were given
   *  (`createProject` rejects an id it already holds, `attach` marks a machine
   *  online and re-`ensureProject`s, `setFacts` invents offsets). Hydration is
   *  not a replay of history; it is the state that history already produced.
   *
   *  Private and constructor-only: a store that could be re-hydrated mid-run
   *  would be a second write path into stored history with no persister call
   *  behind it — the exact inverse of "durable before visible". */
  private hydrate(h: HubHydration): void {
    for (const p of h.projects) {
      this.projectMeta.set(p.id, {
        id: p.id,
        name: p.name,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
        // Array order in, iteration order out: a `Set` preserves insertion
        // order, which is what `listProjects` reports.
        members: new Set(p.members),
        lifecycle: p.lifecycle,
      });
    }
    for (const m of h.machines) {
      this.uplinks.set(m.uplinkId, {
        uplinkId: m.uplinkId,
        projectId: m.projectId,
        name: m.name,
        // Copied like `attach` does, so the caller's hydration object cannot
        // stay a second handle on a machine's declared set.
        repos: [...m.repos],
        // The one fact the record does not hold: nothing is attached yet. The
        // laptop's next `hello` flips it (spec §3.3).
        online: false,
      });
    }
    for (const s of h.sessions) {
      this.sessionsOf(s.projectId).set(s.sessionId, {
        uplinkId: s.uplinkId,
        facts: s.facts,
        // The array is the store's own from here; its events are `StoredEvent`s
        // and read-only for everyone, exactly as after a `publish`.
        events: [...s.events],
        lastRunId: s.lastRunId,
        lastSeq: s.lastSeq,
      });
    }
  }

  createProject(
    id: string,
    name: string,
    createdBy: string,
    createdAt: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.projectMeta.has(id)) {
      return { ok: false, error: `project "${id}" already exists` };
    }
    const record: ProjectRecord = {
      id,
      name,
      createdBy,
      createdAt,
      members: new Set([createdBy]),
      lifecycle: "active",
    };
    // The row before its member, so the record never mentions a membership in
    // a project it does not hold.
    this.persister.projectSaved(projectRow(record));
    this.persister.memberAdded(id, createdBy);
    this.projectMeta.set(id, record);
    return { ok: true };
  }

  /** A machine may name a project that nobody has created — the launch-time
   *  seam of spec §9. It must appear rather than vanish, but it gains no
   *  members: attaching a laptop is not joining a project. Deliberately does
   *  NOT touch an existing record, so a re-attach cannot resurrect membership
   *  somebody deliberately left. */
  ensureProject(id: string, createdAt: string): void {
    if (this.projectMeta.has(id)) return;
    const record: ProjectRecord = {
      id,
      name: id,
      createdBy: null,
      createdAt,
      members: new Set(),
      lifecycle: "active",
    };
    this.persister.projectSaved(projectRow(record));
    this.projectMeta.set(id, record);
  }

  lifecycleOf(id: string): ProjectLifecycle | null {
    return this.projectMeta.get(id)?.lifecycle ?? null;
  }

  setLifecycle(
    id: string,
    lifecycle: ProjectLifecycle,
  ): { ok: true } | { ok: false; error: string } {
    const record = this.projectMeta.get(id);
    if (!record) return { ok: false, error: `no project "${id}"` };
    this.persister.projectSaved({ ...projectRow(record), lifecycle });
    record.lifecycle = lifecycle;
    return { ok: true };
  }

  /** Returns whether this call changed anything, so a caller can decide
   *  whether a push is warranted. */
  joinProject(id: string, userId: string): boolean {
    const record = this.projectMeta.get(id);
    if (!record || record.members.has(userId)) return false;
    this.persister.memberAdded(id, userId);
    record.members.add(userId);
    return true;
  }

  leaveProject(id: string, userId: string): boolean {
    const record = this.projectMeta.get(id);
    // Membership is checked here rather than read off `delete`'s return value,
    // because the record must only be told about a removal that is actually
    // happening — and only before it happens.
    if (!record || !record.members.has(userId)) return false;
    this.persister.memberRemoved(id, userId);
    record.members.delete(userId);
    return true;
  }

  isMember(id: string, userId: string): boolean {
    return this.projectMeta.get(id)?.members.has(userId) ?? false;
  }

  attach(
    uplinkId: string,
    projectId: string,
    name: string,
    repos: RepoDecl[],
    attachedAt: string,
  ): void {
    // Project row first (via ensureProject), so the record never holds a
    // machine pointing at a project it does not know.
    this.ensureProject(projectId, attachedAt);
    const uplink: Uplink = { uplinkId, projectId, name, repos: [...repos], online: true };
    // `online` is deliberately not persisted: it is runtime state (spec §3.3),
    // and a hydrated machine reads offline until it re-attaches.
    this.persister.machineSaved({ uplinkId, projectId, name, repos: uplink.repos });
    this.uplinks.set(uplinkId, uplink);
  }

  /** The machine re-declared its set (an attach or detach landed there). A
   *  wholesale REPLACEMENT, never a merge: the frame carries the machine's
   *  full authoritative list (spec §5.2), so merging would resurrect a repo it
   *  just dropped and leave the hub routing `create_session` somewhere the
   *  machine would only refuse — a failure the browser has no way to explain.
   *
   *  Silent for an unknown uplink. `hub.ts` only calls this after the "hello
   *  first" guard, so the sole way to reach it is a race with a detach, where
   *  there is no record to update and nothing to report. */
  setRepos(uplinkId: string, repos: RepoDecl[]): void {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return;
    const replacement = [...repos];
    this.persister.machineSaved({
      uplinkId,
      projectId: uplink.projectId,
      name: uplink.name,
      repos: replacement,
    });
    uplink.repos = replacement;
  }

  /** Every machine that has ever attached to this project this hub run,
   *  online or not. An offline machine is kept deliberately: its sessions are
   *  still listed and still readable, so hiding the machine would make them
   *  look ownerless.
   *
   *  Copied out, like `snapshot`'s session facts and unlike `publish`'s stored
   *  events: this value leaves the hub toward browsers (through `snapshot` and
   *  `listProjects`) and callers normalize it further before serializing, so
   *  nothing they mutate may reach back into a machine's record. Bounded by
   *  the 100-entry cap `parseUpFrame` enforces. */
  machinesIn(projectId: string): MachineInfo[] {
    const out: MachineInfo[] = [];
    for (const uplink of this.uplinks.values()) {
      if (uplink.projectId !== projectId) continue;
      out.push({
        machineId: uplink.uplinkId,
        name: uplink.name,
        repos: uplink.repos.map((repo) => ({ ...repo })),
        online: uplink.online,
      });
    }
    return out;
  }

  listProjects(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const record of this.projectMeta.values()) {
      const sessions = [...(this.readSessionsOf(record.id)?.values() ?? [])];
      out.push({
        id: record.id,
        name: record.name,
        lifecycle: record.lifecycle,
        members: [...record.members],
        sessionCount: sessions.length,
        liveSessionCount: sessions.filter((s) => s.facts.lifecycle === "open").length,
        machines: this.machinesIn(record.id),
      });
    }
    return out;
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
      this.persister.sessionSaved({
        projectId: uplink.projectId,
        sessionId,
        uplinkId,
        facts,
        lastRunId: existing.lastRunId,
        lastSeq: existing.lastSeq,
      });
      existing.facts = facts;
      return { ok: true };
    }
    // `runId` is deliberately NOT recorded here. resumeOffsets skips sessions
    // whose lastRunId is still null, so a facts-only session reports nothing
    // and the laptop replays from 0 — which is correct, because the hub holds
    // no events for it yet. Recording it here would make the hub claim an
    // offset it cannot back with stored events.
    this.persister.sessionSaved({
      projectId: uplink.projectId,
      sessionId,
      uplinkId,
      facts,
      lastRunId: null,
      lastSeq: -1,
    });
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
   *  stays allocation-free beyond the new `accepted` array shell.
   *
   *  **Durable before visible (spec §3.3).** The whole frame is computed
   *  against locals, handed to the persister, and only then applied to memory.
   *  So a persister that refuses throws out of here with the store exactly as
   *  it was: the caller never fans out, `eventsFor` shows none of the batch and
   *  `resumeOffsets` still asks the laptop to re-send it. The inverse order
   *  would lose history with nothing left to notice — browsers holding events a
   *  restarted hub forgot, and a resume protocol confirming the loss. */
  publish(uplinkId: string, sessionId: string, runId: string, events: LoggedEvent[]): StoredEvent[] {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return [];
    // A READ: a session this frame implicitly creates is created below, once
    // the frame is durable — never before.
    const existing = this.readSessionsOf(uplink.projectId)?.get(sessionId);
    if (existing && existing.uplinkId !== uplinkId) return [];

    // Staged against locals, mirroring what the loop used to do to `session`
    // directly: `nextId` is the id the next accepted event takes, and
    // `lastRunId`/`lastSeq` are the high-water mark each element is deduped
    // against as the batch walks forward.
    let nextId = (existing?.events.length ?? 0) + 1;
    let lastRunId = existing?.lastRunId ?? null;
    let lastSeq = existing?.lastSeq ?? -1;
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
      if (runId === lastRunId && seq <= lastSeq) continue;
      accepted.push({ id: nextId, runId, event });
      nextId += 1;
      lastRunId = runId;
      lastSeq = seq;
    }
    // Nothing accepted → nothing to write, in the record or in memory. A
    // session nobody has declared facts for therefore stays unknown: memory
    // must never hold a session the record does not, or a restart would drop a
    // session browsers had already been shown.
    if (accepted.length === 0) return accepted;

    const session: HubSession =
      existing ?? { uplinkId, facts: emptyFacts(sessionId), events: [], lastRunId: null, lastSeq: -1 };
    // ONE call, carrying the session row too when this frame created it: two
    // calls would be two transactions, and a crash between them would leave
    // events behind a session nothing mentions. The facts handed over are the
    // very instance memory is about to hold, so the record cannot drift from it.
    this.persister.eventsAppended(
      uplink.projectId,
      sessionId,
      accepted,
      runId,
      lastSeq,
      existing ? undefined : { uplinkId, facts: session.facts },
    );

    // Durable. Only now is any of it visible.
    for (const stored of accepted) session.events.push(stored);
    session.lastRunId = runId;
    session.lastSeq = lastSeq;
    if (!existing) this.sessionsOf(uplink.projectId).set(sessionId, session);
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
        machineId: session.uplinkId,
      })),
      // The store's own machine records, verbatim: `MachineInfo` and
      // `ProjectMessage.machines` are the same shape, because both are just
      // what a machine declared in `hello`. Nothing is synthesized here.
      machines: this.machinesIn(projectId),
      arcade: arcadeRecordsFrom(sessions.map((s) => s.events.map((e) => e.event))),
      // Plugins are laptop-local files the agent loads (spec §4) and the hub
      // does not aggregate them in v7b1. The panel reads empty when
      // hub-attached; surfacing per-laptop plugin rosters is v7b3.
      plugins: [],
      pluginsEnabled: false,
      // Oversight is host-configured and hub-side (spec §3.7) — v7b3.
      oversight: { enabled: false, latest: null },
    };
  }

  /** The raw material of one project's record (spec §4.2): every session's
   *  declared facts, the machine that OWNS it, and its whole log. The owner is
   *  per session and not per project, which is the fact a standalone server
   *  cannot report — one hub-attached project spans laptops — and the reason
   *  `get_record` is answered here rather than tunnelled to one of them.
   *
   *  Non-creating, like every other read path (`readSessionsOf`): a browser
   *  names the projectId, so a creating read would let it grow `projects`
   *  without bound by asking for records that do not exist. An unknown project
   *  is an empty list, which `projectRecordFrom` turns into an empty record.
   *
   *  `facts` are deep-copied exactly as `snapshot` copies them: this value
   *  leaves the hub toward a browser and the caller derives from it, so nothing
   *  downstream may reach back into a stored session row. The `events` are the
   *  store's own `LoggedEvent` instances, unwrapped from their `StoredEvent`
   *  envelopes and READ-ONLY for the caller — copying a whole project's log per
   *  request is what the read is meant to avoid, and `projectRecordFrom` is
   *  pure, so it never writes to them. */
  recordInputs(projectId: string): RecordSessionInput[] {
    const sessions = [...(this.readSessionsOf(projectId)?.values() ?? [])];
    return sessions.map((session) => ({
      facts: {
        ...session.facts,
        participants: [...session.facts.participants],
        skills: session.facts.skills.map((skill) => ({ ...skill })),
        pendingGate: session.facts.pendingGate ? { ...session.facts.pendingGate } : null,
      },
      machineId: session.uplinkId,
      events: session.events.map((stored) => stored.event),
    }));
  }
}

/** A project record as the persister sees it: the row itself, WITHOUT the
 *  membership set. Members travel as their own `memberAdded`/`memberRemoved`
 *  calls, so handing the live `Set` over here would give a persister a second,
 *  ambiguous source for the same fact — and a reference into stored state. */
function projectRow(record: ProjectRecord): {
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: string;
  lifecycle: ProjectLifecycle;
} {
  return {
    id: record.id,
    name: record.name,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    lifecycle: record.lifecycle,
  };
}

/** The stand-in for a session that published events before it declared facts.
 *
 *  `repoKey` is null, and that is the honest answer rather than a gap: the hub
 *  does not know which repo a session lives in until the owning laptop says so
 *  in a `facts` frame (spec §7). It used to borrow the uplink's single scalar
 *  key, which was only ever right because a machine had exactly one repo; a
 *  machine now offers several, so there is nothing left to borrow that would
 *  not be a confident guess on the project screen for the whole window before
 *  facts land. */
function emptyFacts(sessionId: string): SessionFacts {
  return {
    id: sessionId,
    participants: [],
    driverName: null,
    intent: null,
    lastActivityTs: null,
    ended: false,
    pendingGate: null,
    skills: [],
    repoKey: null,
    lifecycle: "open",
  };
}
