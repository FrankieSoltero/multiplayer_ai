import type { AgentDriver } from "./agentDriver.js";
import { summarizeSession } from "./digest.js";
import { pendingGateOf, type PendingGate } from "./pendingGate.js";
import type { Session } from "./session.js";
import type { LoggedEvent, SkillInfo } from "./events.js";
import type { PluginInfo } from "./pluginStore.js";
import type { OversightSummary } from "./overseer.js";
import { lifecycleOf, type Lifecycle } from "./lifecycle.js";
import type { RepoDecl, SessionFacts } from "./relayProtocol.js";

export const SLUG = /^[a-z0-9-]{1,40}$/;

export interface ProjectSessionEntry {
  session: Session;
  driver: AgentDriver;
  skills: SkillInfo[];
  pendingSuggests: Map<string, { skill: string; args: string }>;
  /** One-shot flag: the driver pulled the team summary; inject <oversight>
   *  into the next prompt only (spec §5). */
  pendingOversight: boolean;
  /** Which repo this session's worktree lives in (spec §6). Bound once, at
   *  creation, on EVERY creation path — a session's worktree cannot move, so
   *  neither can its key. Required rather than optional precisely because a
   *  path that forgot to bind it would otherwise compile and then report the
   *  wrong repo for the rest of the session's life; `null` is the one honest
   *  answer (no repo was attached when it was created) and has to be written
   *  down deliberately. */
  repoKey: string | null;
  /** This session's worktree on disk (spec §3.1) — the directory
   *  `touchedFiles(workdir, baseRef)` runs git in. `undefined` when no repo was
   *  attached and nothing was provisioned; bound at creation on EVERY path,
   *  beside `repoKey`, because a session's worktree cannot move either. */
  workdir: string | undefined;
  /** What this session's worktree was branched FROM (spec §3.1/§3.2) —
   *  EXACTLY the string this session's creation path handed
   *  `workspace.provision(...)`, so the divergence recompute measures against
   *  the ref git actually used. Never re-derived here: a base re-read from the
   *  repo later (default branch, a `"main"` fallback) would silently measure a
   *  session against a branch it was never cut from. `null` when nothing was
   *  provisioned (no repo). */
  baseRef: string | null;
  /** Repo-relative paths this session's worktree has changed (spec §3.3) — the
   *  last value `touchedFiles(workdir, baseRef)` returned. `null` means NEVER
   *  MEASURED, which is not the same claim as `[]` ("measured, changed
   *  nothing"): the project screen distinguishes the two, so a fresh entry
   *  starts null rather than empty. Kept rather than recomputed on read because
   *  the producer shells out to git synchronously; a failed recompute keeps the
   *  previous value (stale beats absent, spec §3.1), which only a stored field
   *  can express. */
  touched: string[] | null;
  /** The last hub `contested` frame for this session, stored VERBATIM (spec
   *  §6a) — `null` until one arrives, which is not the same claim as an empty
   *  frame ("the hub says nothing is contested any more"); `contested.ts` reads
   *  the two states identically today, and the distinction is kept because only
   *  the entry can express it.
   *
   *  Stored rather than derived because a laptop cannot see another machine's
   *  sessions: this frame is the only place a peer on another laptop is named.
   *  Its counterpart — collisions between sessions on THIS machine — is
   *  derived on read instead (`contested.ts`), so it cannot go stale.
   *
   *  Structural, not an imported frame type: this is laptop state that happens
   *  to arrive on the wire, and `relayProtocol.ts` owns the wire shape. It is
   *  deliberately NOT copied into `sessionFactsOf` — nothing here goes back out
   *  to the browsers watching this project. */
  contestedFrame: {
    paths: string[];
    collisions: { path: string; sessionIds: string[] }[];
  } | null;
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
    // Copied, never aliased: these facts cross the wire, the project snapshot
    // and the collision engine, and a consumer that sorted or truncated the
    // array it was handed would otherwise rewrite the session's stored state.
    touched: entry.touched === null ? null : [...entry.touched],
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
    /** Repo-relative paths this session has changed (spec §3.3), or null when it
     *  has never been measured. Enumerated here rather than inherited: this row
     *  type does not extend `SessionFacts`, so a field added only there would
     *  never reach the snapshot the browser reads.
     *
     *  EXPOSURE (spec §8a ruling 5 — accepted): the FULL list, to every member
     *  of this project. See the note on `SessionFacts.touched`. */
    touched: string[] | null;
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
  oversight: { enabled: boolean; latest: OversightSummary | null };
  /** Which machines are in this project, and which repos each one offers
   *  (spec §8.3, D10). A hub reports every machine that has attached; a
   *  standalone server reports exactly one — itself (solo-mode fix, spec:
   *  entrance stays reachable in solo). The single `repo` field this replaced
   *  is DELETED (D10): a machine can offer several repos, so there is no
   *  longer one repo for the snapshot to hold at the top level — each
   *  session's own `repoKey` says which repo it lives in, and `machines[].repos`
   *  says what each machine offers. Omitted (not an empty array) only when the
   *  standalone server was launched with no workspace, which the field being
   *  optional accommodates. */
  machines?: { machineId: string; name: string; repos: RepoDecl[]; online: boolean }[];
}

export function projectSnapshot(
  project: Project,
  pluginState?: { plugins: PluginInfo[]; enabled: boolean },
  machine?: { machineId: string; name: string; repos: RepoDecl[] } | null,
  oversight?: { enabled: boolean; latest: OversightSummary | null },
): ProjectMessage {
  const sessions = [...project.sessions.entries()].map(([id, entry]) => ({
    // Each entry carries its OWN repoKey, bound at creation (spec §6) — never
    // a machine-wide global. A hub-attached project can hold sessions from
    // several repos on several machines at once; feeding every row the same
    // key here would silently relabel every session but the first.
    ...sessionFactsOf(id, entry, entry.repoKey),
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
    oversight: oversight ?? { enabled: false, latest: null },
    // The solo-mode fix (spec: entrance stays reachable in solo). A standalone
    // server has exactly one machine — itself — so it reports that machine
    // honestly rather than omitting `machines` and leaving the project screen
    // to read `0 MACHINES` and grey out its repo <select>. With no workspace
    // there is no machine identity to report, so the field stays undefined
    // exactly as it always has.
    machines: machine
      ? [{ machineId: machine.machineId, name: machine.name, repos: machine.repos, online: true }]
      : undefined,
  };
}

export interface MachineSummary {
  machineId: string;
  name: string;
  repos: RepoDecl[];
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
 *  above: exactly one machine, this one, carrying its own name and repo list
 *  (D10) — a standalone server has no separate machine identity to report —
 *  omitted (empty array) when the server has no workspace (a test-only path;
 *  the CLI always requires a repo to launch). */
export function projectSummaryOf(
  project: Project,
  memberUserId: string | null,
  machine: { machineId: string; name: string; repos: RepoDecl[] } | null,
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
    machines: machine
      ? [{ machineId: machine.machineId, name: machine.name, repos: machine.repos, online: true }]
      : [],
  };
}
