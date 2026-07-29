import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { AgentDriver, runAgentQuery, type RunQuery } from "./agentDriver.js";
import { buildTeammateDigest, oversightSessionDigest, summarizeSession } from "./digest.js";
import { isModelKey } from "./models.js";
import {
  Project,
  projectSnapshot,
  projectSummaryOf,
  sessionFactsOf,
  SLUG,
  type ProjectSessionEntry,
  type ProjectWatcher,
} from "./project.js";
import { Relay, type ConnectFn } from "./relay.js";
import { Session } from "./session.js";
import { PluginStore } from "./pluginStore.js";
import { ARCADE_GAMES } from "./events.js";
import { lifecycleOf } from "./lifecycle.js";
import { slugify, type WorkspaceLike } from "./workspace.js";
import { staticHandler } from "./staticFiles.js";
import { Overseer, oversightToolText, runOversightSummarize, type Summarize } from "./overseer.js";
import { InviteStore } from "./invites.js";
import { authRoutes, requireAuth, type AuthConfig } from "./auth.js";

const MAX_PROMPT_LENGTH = 4000;
const MAX_URL_LENGTH = 2048;
const MAX_GAME_SCORE = 99999;
const PROJECT_PUSH_INTERVAL_MS = 1000;
const ALLOWED_GLYPHS = new Set(["■", "▲", "●", "✦", "◆", "♠"]);
const COLOR_RE = /^#[0-9a-f]{6}$/i;

interface ClientContext {
  project: Project;
  entry: ProjectSessionEntry;
  userId: string;
  unsubscribe: () => void;
}

/** The transport seam between a message handler and whatever is carrying it.
 *
 *  A DISCRIMINATED UNION, not a bag of optional fields, and deliberately so.
 *  Every question the handler asks about its transport — do I replay? do I
 *  subscribe? whose cookie do I check? whose identity do I trust? — now has
 *  exactly one discriminator, `mode`. When identity was keyed on an optional
 *  `stampedIdentity` while replay was keyed on `mode`, the two could disagree:
 *  a `{ mode: "relay" }` with no stamp fell through to `requireAuth(undefined)`
 *  and, with auth disabled, kept the payload's claimed `userId` — fail-open on
 *  the exact trust inversion this seam exists to enforce. The union makes that
 *  connection unrepresentable rather than merely unlikely. */
export type ConnectionIO = DirectIO | RelayIO;

/** A browser on a WebSocket straight to this process. It replays the log,
 *  subscribes per socket, and registers as a project watcher, exactly as it
 *  always has. */
export interface DirectIO {
  mode: "direct";
  /** Narrowcast reply to the one client that sent the command. Best-effort:
   *  implementations drop the message if their transport has gone away. */
  send(msg: unknown): void;
  /** Receives throttled project snapshots. Optional: a direct connection
   *  without one is a legitimate degenerate case (it simply gets no snapshot
   *  pushes), and unlike a missing stamp it cannot fail open on anything. */
  watcher?: ProjectWatcher;
  /** This process verifies the cookie itself. Optional because
   *  `IncomingMessage.headers.cookie` is itself `string | undefined` — absent
   *  means "no cookie presented", which `requireAuth` already rejects. */
  cookieHeader?: string;
}

/** A browser attached to the hub, tunnelled here (spec §3.2). The hub owns
 *  replay and fan-out, so this connection does none of it: doing it here would
 *  push one copy of every event per attached browser up a single uplink.
 *  Identity arrives pre-verified from the hub (spec §3.5 rule 1) — and identity
 *  is the ONLY thing trusted from upstream. Shape, length and charset
 *  validation is untouched and still runs on every field (spec §10.4). */
export interface RelayIO {
  mode: "relay";
  /** Narrowcast reply to the one client that sent the command. Best-effort:
   *  implementations drop the message if their transport has gone away. */
  send(msg: unknown): void;
  /** REQUIRED. The hub verified this browser and stamped it; without a stamp
   *  there is no verifier on either side of the uplink, so the type forbids
   *  constructing the connection at all. */
  stampedIdentity: { userId: string; name: string };
}

const INTERESTING = new Set([
  "intent_update",
  "presence_join",
  "presence_leave",
  "user_message",
  "agent_error",
  "control_change",
  "permission_request",
  "permission_decision",
  "skill_suggest",
  "skill_decision",
  "plan_request",
  "plan_decision",
  "permission_mode_change",
  "game_score",
  "plugin_change",
]);

const OVERSEER_EVENTS = new Set([
  "user_message",
  "permission_request",
  "agent_error",
  "intent_update",
]);

export async function startServer(opts: {
  port: number;
  host?: string;
  runQuery?: RunQuery;
  plugins?: PluginStore;
  workspace?: WorkspaceLike;
  staticDir?: string;
  summarize?: Summarize;
  oversightDebounceMs?: number;
  requireInvite?: boolean;
  inviteTtlMs?: number;
  inviteMaxUses?: number;
  auth?: AuthConfig;
  /** When set, this process also dials the hub and relays its sessions
   *  (spec §3.1). Absent, `mpai` behaves exactly as it always has — the hub
   *  is strictly additive (spec §6). */
  hub?: {
    url: string;
    projectId: string;
    uplinkId?: string;
    connect?: ConnectFn;
  };
}) {
  const runQuery = opts.runQuery ?? runAgentQuery;
  const pluginStore = opts.plugins ?? new PluginStore(process.env.AGENT_PLUGINS_ROOT);
  // Cached once at startup: the default branch changing mid-run is rare and
  // harmless (it only seeds the create form's base-ref field).
  const repo = opts.workspace
    ? {
        workspace: opts.workspace,
        defaultBranch: opts.workspace.defaultBranch(),
        // Cached at startup like defaultBranch: a repo's origin changing
        // mid-run is not a case worth re-reading git for on every push.
        key: opts.workspace.repoKey(),
      }
    : null;
  const projects = new Map<string, Project>();
  const lastPush = new Map<Project, number>();
  const pushTimers = new Map<Project, NodeJS.Timeout>();
  const invites = new InviteStore({
    ttlMs: opts.inviteTtlMs,
    maxUses: opts.inviteMaxUses,
  });

  const overseer = new Overseer(
    opts.summarize ?? runOversightSummarize,
    (projectId) => {
      const project = projects.get(projectId);
      if (!project) return [];
      return [...project.sessions.entries()].map(([id, entry]) => {
        const participants = entry.session.participantList;
        const driverId = entry.session.driverId;
        return oversightSessionDigest(
          id,
          entry.session.eventsFrom(0),
          entry.driver.isDead,
          participants.find((p) => p.userId === driverId)?.name ?? null,
          participants.map((p) => p.name),
        );
      });
    },
    (projectId) => {
      const project = projects.get(projectId);
      if (project) pushProject(project); // deliberate action / fresh summary — immediate push
    },
    opts.oversightDebounceMs,
  );

  function snapshotFor(project: Project) {
    return projectSnapshot(
      project,
      { plugins: pluginStore.list(project.id), enabled: pluginStore.enabled },
      repo && { defaultBranch: repo.defaultBranch, key: repo.key },
      { enabled: overseer.isEnabled(project.id), latest: overseer.latest(project.id) },
    );
  }

  function pushProject(project: Project): void {
    const timer = pushTimers.get(project);
    if (timer) {
      clearTimeout(timer);
      pushTimers.delete(project);
    }
    const payload = JSON.stringify(snapshotFor(project));
    for (const watcher of project.watchers) {
      if (watcher.readyState === WebSocket.OPEN) watcher.send(payload);
    }
    // Facts ride the snapshot's existing 1-second throttle rather than a
    // second timer: a fact change is by definition accompanied by a push.
    if (relay) {
      for (const [id, entry] of project.sessions) {
        relay.publishFacts(id, sessionFactsOf(id, entry, repo?.key ?? null));
      }
    }
    lastPush.set(project, Date.now());
  }

  function schedulePush(project: Project): void {
    if (pushTimers.has(project)) return; // trailing push already queued
    const elapsed = Date.now() - (lastPush.get(project) ?? 0);
    if (elapsed >= PROJECT_PUSH_INTERVAL_MS) {
      pushProject(project);
      return;
    }
    const timer = setTimeout(() => {
      pushTimers.delete(project);
      pushProject(project);
    }, PROJECT_PUSH_INTERVAL_MS - elapsed);
    pushTimers.set(project, timer);
  }

  function getOrCreateProject(projectId: string): Project {
    let project = projects.get(projectId);
    if (!project) {
      project = new Project(projectId);
      projects.set(projectId, project);
    }
    return project;
  }

  function getOrCreateSession(
    project: Project,
    sessionId: string,
    workdirOverride?: string,
  ): ProjectSessionEntry | { error: string } {
    let entry = project.sessions.get(sessionId);
    if (!entry) {
      let workdir: string | undefined = workdirOverride;
      if (workdir === undefined) {
        if (repo) {
          // Deep-link join to a not-yet-provisioned session: same core as
          // create_session, branched off the default branch (spec §3).
          const result = repo.workspace.provision(sessionId, repo.defaultBranch);
          if (!result.ok) return { error: result.error };
          workdir = result.workdir;
        } else {
          const root = process.env.AGENT_WORKDIR_ROOT;
          workdir = root ? path.join(root, sessionId) : undefined;
        }
      }
      const session = new Session(sessionId);
      // v6c: roster seeds from the plugin registry scan (instant, accurate
      // for plugin skills); the driver replaces it with the SDK's live list
      // — built-ins included — once the stream is up. Appended (not
      // side-channeled) so late joiners replay it like everything else.
      const skills = pluginStore.skillsFor(project.id);
      session.append({ type: "skill_roster", skills });
      const newEntry: ProjectSessionEntry = {
        session,
        driver: new AgentDriver(
          session,
          runQuery,
          workdir,
          pluginStore.paths(project.id),
          (liveSkills) => {
            newEntry.skills = liveSkills;
            schedulePush(project);
          },
          undefined,
          () => oversightToolText(overseer.isEnabled(project.id), overseer.latest(project.id)),
        ),
        skills,
        pendingSuggests: new Map(),
        pendingOversight: false,
      };
      entry = newEntry;
      project.sessions.set(sessionId, entry);
      session.subscribe((event) => {
        if (INTERESTING.has(event.type)) schedulePush(project);
        if (OVERSEER_EVENTS.has(event.type)) overseer.notify(project.id);
        relay?.publishEvent(sessionId, event);
      });
      overseer.notify(project.id); // session created (spec §3 lifecycle)
      // LAST, deliberately. `skill_roster` is appended above, before the
      // subscribe exists, so it is never published live. Registering here
      // means `trackSession` sees a session that already holds its backlog
      // and publishes it — which is the only path that reaches the hub for a
      // session created while the uplink is ALREADY up (no second `welcome`
      // is coming). Every later event arrives through the subscribe, and the
      // two cannot double-publish because `trackSession` returns early for a
      // session it already tracks.
      relay?.trackSession(sessionId, session);
    }
    return entry;
  }

  function digestFor(project: Project, sessionId: string): string {
    const others = [...project.sessions.entries()]
      .filter(([id]) => id !== sessionId)
      .map(([id, entry]) =>
        summarizeSession(id, entry.session.eventsFrom(0), entry.driver.isDead),
      );
    return buildTeammateDigest(others);
  }

  // Single seam for the closed-session guard shared by prompt / suggest_skill
  // / decide_skill / close_session. `permission` and `decide_plan` deliberately
  // do NOT call this — they resolve requests already in flight, and guarding
  // them would strand a live agent on a promise nobody can resolve.
  //
  // Performance note (not fixed here): `eventsFrom(0)` is `this.log.slice(0)`,
  // so every call still copies the full event log before scanning it — same
  // cost as before extraction, just paid in one place instead of four. This
  // is the seam to change if that cost is ever worth removing (e.g. caching
  // lifecycle state on the entry when `session_closed` is appended).
  function isClosed(entry: ProjectSessionEntry): boolean {
    return lifecycleOf(entry.session.eventsFrom(0)) === "closed";
  }

  // Registered unconditionally so /auth/me can report {enabled:false} rather
  // than falling through to the SPA fallback (spec §4.2).
  const handleAuth = authRoutes(opts.auth);
  const serveStatic = opts.staticDir ? staticHandler(opts.staticDir) : null;
  const httpServer = createServer((req, res) => {
    let pathname: string;
    try {
      // Decoded (and guarded) the same way staticFiles.ts:31-38 does, so a
      // percent-encoded or trailing-slash spelling of /healthz still matches
      // the equality check below instead of falling through to the SPA
      // fallback, which would return index.html with a 200.
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Registered unconditionally and BEFORE the static handler. That handler's
    // SPA fallback (staticFiles.ts:51-53) serves index.html for any
    // extensionless path, so wiring /healthz after it would return HTML with a
    // 200 — a probe that passes forever while the app is broken (spec §3.4).
    // Body carries no internal state: it is publicly reachable via the domain.
    // A single optional trailing slash is treated as the same route.
    if (pathname === "/healthz" || pathname === "/healthz/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      return;
    }
    // Between healthz and static, for the same ordering reason: the SPA
    // fallback would otherwise swallow every /auth/* path.
    if (handleAuth(req, res)) return;
    if (serveStatic) {
      serveStatic(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  const wss = new WebSocketServer({ server: httpServer });

  /** The whole per-connection protocol, independent of what is carrying it.
   *  Closes over everything `startServer` already has in scope, so both the
   *  direct WebSocket adapter below and the relay uplink share one handler. */
  function createConnection(io: ConnectionIO): {
    handleMessage: (msg: any) => void;
    close: () => void;
  } {
    let ctx: ClientContext | null = null;
    let watching: Project | null = null;
    // Set by `identify`, read by `list_projects` / `create_project` — the
    // solo-mode entrance protocol (spec: standalone server answers these
    // instead of erroring). Deliberately separate from `ctx.userId`: `join`
    // still establishes its own identity for a session exactly as before;
    // this is only the per-connection claim the project/entrance screens make
    // before any session exists, mirroring the hub's `channel.identity`
    // (hub.ts's per-connection identity comment explains why `join`-time and
    // pre-join identity cannot share one field).
    let identity: { userId: string; name: string } | null = null;

    // Derived once from the single discriminator: only a direct socket can be
    // a project watcher, and the union makes that structural rather than a
    // convention every call site has to remember.
    const watcher = io.mode === "direct" ? io.watcher : undefined;

    const sendError = (message: string) => io.send({ type: "error", message });

    // The token rides this reply and nothing else — never the session log,
    // which is replayed to every late joiner and cannot be un-replayed.
    const sendInviteList = (c: ClientContext) =>
      io.send({
        type: "invite_list",
        invites: invites.listFor(c.project.id, c.entry.session.id),
      });

    const handleMessage = (msg: any): void => {
      // Guard for the message types that are reachable BEFORE `ctx` exists
      // and therefore sit above the "join a session first" choke point.
      // Without it, one cookie-less frame from anyone on the internet could
      // provision a git worktree and spawn an agent subprocess
      // (create_session), read the roster of real GitHub logins and the
      // oversight summary of the team's work (peek / watch_project), or
      // mutate project state (set_oversight).
      //
      // `peek_invite` is deliberately NOT guarded (spec §4.3): the invite
      // sign-in screen calls it while signed out, and it is already gated by
      // an unguessable token that it never spends.
      //
      // With auth off requireAuth admits everything, so this is a no-op.
      const denyUnauthed = (): boolean => {
        // Relay: the hub already verified this browser before stamping it
        // (spec §3.5 rule 1), so there is no cookie to check on this side.
        if (io.mode === "relay") return false;
        const check = requireAuth(io.cookieHeader, opts.auth);
        if (check.ok) return false;
        sendError(check.error);
        return true;
      };

      // The three messages the entrance (ProjectPicker) and the project
      // screen (SessionPicker) send before any session exists, mirrored from
      // the hub (hub.ts's `identify` / `list_projects` / `create_project`) so
      // the hub rejects precisely what this server rejects, and vice versa.
      // `identify` alone stays unguarded, like `peek_invite`: it sets
      // per-connection state and echoes it back, provisioning and disclosing
      // nothing. `list_projects` (reads the project roster) and
      // `create_project` (grows `projects`) sit behind `denyUnauthed` like
      // every other pre-join read/write — without it, one cookie-less
      // connection could loop identify + create_project and grow the Map
      // unbounded. Hub parity is not at stake: `denyUnauthed` is this
      // laptop's transport gate (relay-mode traffic skips it because the hub
      // verified the browser), already applied to four handlers the hub has
      // no equivalent of.
      if (msg.type === "identify") {
        // Mirrors `join`'s "already joined" guard (hub.ts:360 has the same
        // one, for the same reason): a joined connection's identity is
        // locked, so a later `identify` cannot silently rebind who `ctx`
        // attributes future actions to.
        if (ctx) return sendError("already joined");
        if (typeof msg.userId !== "string" || typeof msg.name !== "string") {
          return sendError("identify requires userId, name");
        }
        const userId = msg.userId.slice(0, 64);
        const name = msg.name.slice(0, 40);
        if (!userId) return sendError("identify requires userId");
        identity = { userId, name };
        io.send({ type: "identified", userId, name });
        return;
      }

      if (msg.type === "list_projects") {
        if (denyUnauthed()) return;
        // Non-creating READ, deliberately: `projects.values()` never calls
        // `getOrCreateProject`. A creating read here would let unauthenticated
        // input grow `projects` without bound — the hub's `readSessionsOf` vs
        // `sessionsOf` split (hubStore.ts) guards the identical failure and
        // this mirrors it.
        io.send({
          type: "projects",
          projects: [...projects.values()].map((p) =>
            projectSummaryOf(p, identity?.userId ?? null, repo?.key ?? null),
          ),
        });
        return;
      }

      if (msg.type === "create_project") {
        if (denyUnauthed()) return;
        if (!identity) return sendError("identify first");
        if (typeof msg.name !== "string") return sendError("create_project requires name");
        const projectId = slugify(msg.name.slice(0, 200));
        if (!SLUG.test(projectId)) return sendError("create_project requires a usable name");
        if (projects.has(projectId)) {
          return sendError(`project "${projectId}" already exists`);
        }
        // Creating here IS the point — unlike list_projects, this is a
        // deliberate write gated by `identify first` above, not an
        // unauthenticated read.
        getOrCreateProject(projectId);
        io.send({ type: "project_created", projectId });
        return;
      }

      if (msg.type === "join") {
        if (ctx) {
          return sendError("already joined");
        }
        if (
          typeof msg.sessionId !== "string" ||
          typeof msg.userId !== "string" ||
          typeof msg.name !== "string"
        ) {
          return sendError("join requires sessionId, userId, name");
        }
        const projectId =
          typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId) || !SLUG.test(msg.sessionId)) {
          return sendError(
            "projectId and sessionId must be 1-40 chars of a-z, 0-9, -",
          );
        }
        // Auth gate (spec §4.3). Before the invite gate and therefore before
        // any provisioning: a rejected join must never create a worktree.
        // On success userId is REPLACED by the verified GitHub login — the
        // client's claim is discarded, which is the whole point of A2a
        // (spec §2). The display name is locked to the same login (spec
        // §3.4): it is the string humans actually read, so leaving it
        // client-chosen would relocate the impersonation rather than remove
        // it. Enforced here, not in the client Lobby — a hand-rolled
        // WebSocket client bypasses any browser UI.
        if (io.mode === "relay") {
          // Relay: the hub already verified this browser and stamped it
          // (spec §3.5 rule 1). Same overwrite, different verifier — and the
          // union guarantees the stamp is present, so there is no arm here
          // that can fall through to the client's claim.
          msg.userId = io.stampedIdentity.userId;
          msg.name = io.stampedIdentity.name;
        } else {
          const joinAuth = requireAuth(io.cookieHeader, opts.auth);
          if (!joinAuth.ok) return sendError(joinAuth.error);
          if (joinAuth.login !== null) {
            msg.userId = joinAuth.login;
            msg.name = joinAuth.login;
          }
        }
        // Invite gate (spec §4). Sits before getOrCreateProject/Session so a
        // rejected join never provisions a git worktree.
        let redeemedId: string | null = null;
        if (typeof msg.invite === "string" && msg.invite) {
          const token = msg.invite.slice(0, 64);
          const result = invites.redeem(token, msg.userId, msg.sessionId, projectId);
          if (!result.ok) return sendError(result.error);
          redeemedId = result.invite.id;
        } else if (opts.requireInvite) {
          // The founder slot stays open: an empty room can be opened by
          // whoever arrives first (spec §7 states this bound explicitly).
          // A previously-admitted participant (including the founder) is
          // also exempt: presence_leave drops them from participantList on
          // disconnect, but the admitted set survives so a reconnect isn't
          // mistaken for a stranger (spec §4).
          const occupied = projects.get(projectId)?.sessions.get(msg.sessionId);
          if (
            occupied &&
            occupied.session.participantList.length > 0 &&
            !occupied.session.hasBeenAdmitted(msg.userId)
          ) {
            return sendError("this session requires an invite");
          }
        }
        const project = getOrCreateProject(projectId);
        const entry = getOrCreateSession(project, msg.sessionId);
        if ("error" in entry) return sendError(entry.error);
        // Replay first, then subscribe, then join — single-threaded, so no gap.
        const from =
          Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0 ? msg.lastSeq : 0;
        if (io.mode === "direct") {
          for (const event of entry.session.eventsFrom(from)) {
            io.send({ type: "event", event });
          }
        }
        // Direct sockets get their own subscription; relayed clients receive
        // events through the hub's fan-out instead (spec §3.2), so subscribing
        // here would send N copies up one uplink for N watchers.
        const unsubscribe =
          io.mode === "direct"
            ? entry.session.subscribe((event) => io.send({ type: "event", event }))
            : () => {};
        ctx = { project, entry, userId: msg.userId, unsubscribe };
        if (watcher) project.watchers.add(watcher);
        const glyph =
          typeof msg.glyph === "string" && ALLOWED_GLYPHS.has(msg.glyph)
            ? msg.glyph
            : undefined;
        const color =
          typeof msg.color === "string" && COLOR_RE.test(msg.color)
            ? msg.color.toLowerCase()
            : undefined;
        entry.session.join(msg.userId, msg.name.slice(0, 40), { glyph, color });
        if (redeemedId) {
          entry.session.append({
            type: "invite_redeemed",
            userId: msg.userId,
            inviteId: redeemedId,
          });
        }
        // Immediate personal snapshot so the sidebar isn't blank until the
        // next throttled push.
        if (io.mode === "direct") io.send(snapshotFor(project));
        return;
      }

      // Unreachable on the RELAY arm: `HUB_HANDLED` (`poc/hub/src/hub.ts:18`)
      // answers `peek` from the hub's own store and never tunnels it, because
      // only the hub sees every laptop. Removing this id from that set — in a
      // different package — silently re-routes `peek` here, where it would
      // answer with one machine's view of a multi-machine project.
      if (msg.type === "peek") {
        if (denyUnauthed()) return;
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) {
          return sendError("peek requires a valid projectId");
        }
        const project = projects.get(projectId);
        io.send(
          project
            ? snapshotFor(project)
            : { type: "project", sessions: [], plugins: [], pluginsEnabled: pluginStore.enabled, repo: repo && { defaultBranch: repo.defaultBranch, key: repo.key }, oversight: { enabled: false, latest: null } },
        );
        return;
      }

      if (msg.type === "peek_invite") {
        if (typeof msg.token !== "string" || !msg.token) {
          return sendError("peek_invite requires a token");
        }
        const result = invites.peek(msg.token);
        if (!result.ok) return sendError(result.error);
        io.send({
          type: "invite_info",
          projectId: result.invite.projectId,
          sessionId: result.invite.sessionId,
          inviterName: result.invite.createdByName,
          expiresAt: result.invite.expiresAt,
          remaining: result.invite.maxUses - result.invite.redeemedBy.size,
        });
        return;
      }

      // Unreachable on the RELAY arm, for the same reason as `peek` above:
      // `HUB_HANDLED` at `poc/hub/src/hub.ts:18`. If it ever did arrive here
      // the `watcher` below is undefined on a relay connection, so the
      // subscription would silently never happen.
      if (msg.type === "watch_project") {
        if (denyUnauthed()) return;
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) {
          return sendError("watch_project requires a valid projectId");
        }
        const project = getOrCreateProject(projectId);
        if (watcher) {
          if (watching) watching.watchers.delete(watcher);
          project.watchers.add(watcher);
        }
        watching = project;
        io.send(snapshotFor(project));
        return;
      }

      if (msg.type === "set_oversight") {
        if (denyUnauthed()) return;
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) {
          return sendError("set_oversight requires a valid projectId");
        }
        if (typeof msg.enabled !== "boolean") {
          return sendError("set_oversight requires enabled: true|false");
        }
        if (!projects.has(projectId)) {
          return sendError(`unknown project: ${projectId}`);
        }
        // Anyone may toggle (spec §2) — team infrastructure, not a driver capability.
        overseer.setEnabled(projectId, msg.enabled);
        return;
      }

      if (msg.type === "create_session") {
        if (denyUnauthed()) return;
        const projectId =
          typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId)) {
          return sendError("create_session requires a valid projectId");
        }
        if (typeof msg.name !== "string") {
          return sendError("create_session requires name");
        }
        const slug = slugify(String(msg.name ?? "").slice(0, 200));
        if (!slug) return sendError("create_session requires a usable name");
        const project = getOrCreateProject(projectId);
        if (project.sessions.has(slug)) {
          // Matches provision idempotence (spec §3): existing session acks.
          io.send({ type: "session_created", sessionId: slug });
          return;
        }
        if (!repo) return sendError("server not launched in a repo");
        const baseRef =
          typeof msg.baseRef === "string" && msg.baseRef.length > 0
            ? msg.baseRef.slice(0, 100)
            : repo.defaultBranch;
        const result = repo.workspace.provision(slug, baseRef);
        if (!result.ok) return sendError(result.error);
        const entry = getOrCreateSession(project, slug, result.workdir);
        if ("error" in entry) return sendError(entry.error);
        io.send({ type: "session_created", sessionId: slug });
        // Deliberate user action, not a hot stream — immediate push (same
        // rationale as add_plugin).
        pushProject(project);
        return;
      }

      if (!ctx) return sendError("join a session first");

      if (msg.type === "prompt") {
        if (isClosed(ctx.entry)) {
          return sendError("this session has been closed");
        }
        if (typeof msg.text !== "string" || msg.text.length === 0) {
          return sendError("prompt requires text");
        }
        if (msg.text.length > MAX_PROMPT_LENGTH) {
          return sendError(`prompt too long (max ${MAX_PROMPT_LENGTH})`);
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("you are not driving — take the wheel first");
        }
        const digest = digestFor(ctx.project, ctx.entry.session.id);
        let contextBlock = digest || undefined;
        if (ctx.entry.pendingOversight) {
          // One-shot (spec §5): consumed by this prompt whether or not a
          // summary still exists.
          ctx.entry.pendingOversight = false;
          const latest = overseer.latest(ctx.project.id);
          if (latest) {
            const block = `<oversight>\n${latest.text}\n</oversight>`;
            contextBlock = contextBlock ? `${contextBlock}\n\n${block}` : block;
          }
        }
        ctx.entry.driver.sendPrompt(ctx.userId, msg.text, contextBlock);
        return;
      }

      if (msg.type === "take_wheel") {
        // leave_session deliberately leaves ctx live (nulling it would skip
        // ctx.unsubscribe() / ctx.project.watchers.delete(...) and leak both),
        // so a departed user can still be connected here — e.g. a second tab
        // of the same signed-in user, since auth replaces userId with the
        // verified login. Without this guard they could drive while absent
        // from the roster, with every surface showing no driver named.
        if (!ctx.entry.session.nameOf(ctx.userId)) {
          return sendError("you have left this session");
        }
        ctx.entry.session.takeWheel(ctx.userId);
        return;
      }

      if (msg.type === "close_session") {
        // Any participant may close, attributed on the wire — session scope,
        // matching the standing no-owner-role precedent and the task_stop /
        // oversight_pull posture of attributing rather than restricting
        // (spec §3.4). Hub-wide close by the host is v7b.
        if (isClosed(ctx.entry)) {
          return sendError("session already closed");
        }
        ctx.entry.session.append({ type: "session_closed", userId: ctx.userId });
        // Deliberate user action, not a hot stream — immediate push (same
        // rationale as add_plugin / create_session).
        pushProject(ctx.project);
        return;
      }

      if (msg.type === "leave_session") {
        // Deliberate departure. Deliberately NOT lifecycle-guarded: someone
        // sitting in an already-closed session still needs a way out.
        const departed = ctx.entry.session.leave(ctx.userId);
        // Auto-close only on a DELIBERATE last departure. A socket close runs
        // `session.leave` too (see the "close" handler) but never reaches
        // here — that asymmetry IS the feature: v7a made closing one-way, so
        // a dropped connection must not be able to end a session forever
        // (spec §2, §3.1). `leave()` is idempotent, so a repeat leave_session
        // from someone who already left (e.g. after their socket already
        // dropped) must not auto-close on their behalf — `departed` guards
        // against blaming a stale call for a departure it didn't cause.
        if (departed && ctx.entry.session.participantList.length === 0 && !isClosed(ctx.entry)) {
          ctx.entry.session.append({ type: "session_closed", userId: ctx.userId });
        }
        // Deliberate user action, not a hot stream — immediate push.
        // `presence_leave` IS in the INTERESTING set, so it would reach
        // watchers on its own via `schedulePush`, but only after up to
        // PROJECT_PUSH_INTERVAL_MS of throttling; `session_closed` is not
        // INTERESTING at all, so without this push watchers could see a
        // stale roster for up to a second, or never see the lifecycle flip.
        pushProject(ctx.project);
        return;
      }

      if (msg.type === "permission") {
        if (
          typeof msg.requestId !== "string" ||
          (msg.decision !== "allow" && msg.decision !== "deny")
        ) {
          return sendError("permission requires requestId and decision allow|deny");
        }
        // Validated at DECISION time, not request time: wheel handoffs mid-
        // request are a feature (a teammate can drop in just to approve).
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can decide permissions — take the wheel first");
        }
        if (!ctx.entry.driver.resolvePermission(msg.requestId, msg.decision, ctx.userId)) {
          return sendError("unknown or already-decided permission request");
        }
        return;
      }

      if (msg.type === "set_model") {
        if (!isModelKey(msg.model)) {
          return sendError("set_model requires model: opus|sonnet|haiku");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can switch models — take the wheel first");
        }
        const result = ctx.entry.driver.setModel(msg.model, ctx.userId);
        if (!result.ok) return sendError(result.error);
        return;
      }

      if (msg.type === "suggest_skill") {
        if (isClosed(ctx.entry)) {
          return sendError("this session has been closed");
        }
        if (typeof msg.skill !== "string") {
          return sendError("suggest_skill requires skill");
        }
        const args = typeof msg.args === "string" ? msg.args.slice(0, 500) : "";
        if (!ctx.entry.skills.some((s) => s.name === msg.skill)) {
          return sendError("unknown skill — not in this session's roster");
        }
        const suggestId = randomUUID();
        ctx.entry.session.append({
          type: "skill_suggest",
          suggestId,
          userId: ctx.userId,
          skill: msg.skill,
          args,
        });
        if (ctx.entry.session.canPrompt(ctx.userId)) {
          // Driver suggesting = driver approving: emit the decision pair so
          // the transcript record is uniform with the passenger flow.
          ctx.entry.session.append({
            type: "skill_decision",
            suggestId,
            decision: "run",
            userId: ctx.userId,
          });
          ctx.entry.driver.runSkill(msg.skill, args);
        } else {
          ctx.entry.pendingSuggests.set(suggestId, { skill: msg.skill, args });
        }
        return;
      }

      if (msg.type === "decide_skill") {
        if (isClosed(ctx.entry)) {
          return sendError("this session has been closed");
        }
        if (
          typeof msg.suggestId !== "string" ||
          (msg.decision !== "run" && msg.decision !== "dismiss")
        ) {
          return sendError("decide_skill requires suggestId and decision run|dismiss");
        }
        // Validated at DECISION time — wheel handoffs mid-suggestion are a
        // feature, same as the permission gate above.
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can decide suggestions — take the wheel first");
        }
        const pending = ctx.entry.pendingSuggests.get(msg.suggestId);
        if (!pending) {
          return sendError("unknown or already-decided suggestion");
        }
        ctx.entry.pendingSuggests.delete(msg.suggestId);
        ctx.entry.session.append({
          type: "skill_decision",
          suggestId: msg.suggestId,
          decision: msg.decision,
          userId: ctx.userId,
        });
        if (msg.decision === "run") {
          ctx.entry.driver.runSkill(pending.skill, pending.args);
        }
        return;
      }

      if (msg.type === "set_permission_mode") {
        if (msg.mode !== "plan" && msg.mode !== "default" && msg.mode !== "auto") {
          return sendError("set_permission_mode requires mode: plan|default|auto");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can change the permission mode — take the wheel first");
        }
        const result = ctx.entry.driver.setPermissionMode(msg.mode, ctx.userId);
        if (!result.ok) return sendError(result.error);
        return;
      }

      if (msg.type === "stop_task") {
        if (typeof msg.taskId !== "string" || msg.taskId.length === 0) {
          return sendError("stop_task requires taskId");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can stop tasks — take the wheel first");
        }
        const result = ctx.entry.driver.stopTask(msg.taskId, ctx.userId);
        if (!result.ok) return sendError(result.error);
        return;
      }

      if (msg.type === "pull_oversight") {
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can pull team updates — take the wheel first");
        }
        if (!overseer.isEnabled(ctx.project.id)) {
          return sendError("team oversight is disabled");
        }
        const latest = overseer.latest(ctx.project.id);
        if (!latest) return sendError("no team summary yet");
        ctx.entry.pendingOversight = true;
        ctx.entry.session.append({
          type: "oversight_pull",
          userId: ctx.userId,
          summarySeq: latest.seq,
        });
        return;
      }

      // Inviting is team infrastructure, not a driver capability (spec §9.3):
      // any participant may mint, list, or revoke. Every action is attributed.
      if (msg.type === "create_invite") {
        const invite = invites.mint({
          projectId: ctx.project.id,
          sessionId: ctx.entry.session.id,
          createdBy: ctx.userId,
          createdByName: ctx.entry.session.nameOf(ctx.userId) ?? ctx.userId,
        });
        ctx.entry.session.append({
          type: "invite_created",
          userId: ctx.userId,
          inviteId: invite.id,
          expiresAt: invite.expiresAt,
          maxUses: invite.maxUses,
        });
        sendInviteList(ctx);
        return;
      }

      if (msg.type === "list_invites") {
        sendInviteList(ctx);
        return;
      }

      if (msg.type === "revoke_invite") {
        if (typeof msg.inviteId !== "string" || !msg.inviteId) {
          return sendError("revoke_invite requires an inviteId");
        }
        const id = msg.inviteId.slice(0, 40);
        if (!invites.revoke(id, ctx.project.id, ctx.entry.session.id)) {
          return sendError(`unknown invite: ${id}`);
        }
        ctx.entry.session.append({
          type: "invite_revoked",
          userId: ctx.userId,
          inviteId: id,
        });
        sendInviteList(ctx);
        return;
      }

      if (msg.type === "add_plugin") {
        if (typeof msg.url !== "string") {
          return sendError("add_plugin requires url");
        }
        const url = msg.url.trim();
        if (url.length === 0) {
          return sendError("add_plugin requires url");
        }
        if (url.length > MAX_URL_LENGTH) {
          return sendError(`url too long (max ${MAX_URL_LENGTH})`);
        }
        const { project, entry, userId } = ctx;
        // Anyone in the project may register a plugin (spec §1) — no driver
        // gate. Accountability is the attributed plugin_change on the wire.
        void pluginStore.add(project.id, url, userId).then((result) => {
          if (!result.ok) return sendError(result.error);
          entry.session.append({
            type: "plugin_change",
            action: "add",
            name: result.plugin.name,
            skillCount: result.plugin.skills.length,
            userId,
          });
          // Registry changes are rare, deliberate user actions (not a hot
          // event stream) — push the updated registry immediately rather
          // than riding the 1s throttle, same rationale as join's immediate
          // personal snapshot.
          pushProject(project);
        });
        return;
      }

      if (msg.type === "remove_plugin") {
        if (typeof msg.name !== "string" || msg.name.length === 0) {
          return sendError("remove_plugin requires name");
        }
        const removed = pluginStore.remove(ctx.project.id, msg.name);
        if (!removed.ok) return sendError(removed.error);
        ctx.entry.session.append({
          type: "plugin_change",
          action: "remove",
          name: msg.name,
          skillCount: 0,
          userId: ctx.userId,
        });
        // Immediate push — see add_plugin above.
        pushProject(ctx.project);
        return;
      }

      if (msg.type === "decide_plan") {
        if (
          typeof msg.requestId !== "string" ||
          (msg.decision !== "approve" && msg.decision !== "reject")
        ) {
          return sendError("decide_plan requires requestId and decision approve|reject");
        }
        if (!ctx.entry.session.canPrompt(ctx.userId)) {
          return sendError("only the current driver can decide plans — take the wheel first");
        }
        if (!ctx.entry.driver.resolvePlan(msg.requestId, msg.decision, ctx.userId)) {
          return sendError("unknown or already-decided plan request");
        }
        return;
      }

      if (msg.type === "game_score") {
        if (
          typeof msg.game !== "string" ||
          !(ARCADE_GAMES as readonly string[]).includes(msg.game)
        ) {
          return sendError(`game_score requires game: ${ARCADE_GAMES.join("|")}`);
        }
        if (!Number.isInteger(msg.score) || msg.score <= 0 || msg.score > MAX_GAME_SCORE) {
          return sendError(`game_score requires an integer score 1-${MAX_GAME_SCORE}`);
        }
        // No driver check: passengers play too. Identity comes from the
        // connection context — a client cannot claim someone else's record.
        ctx.entry.session.append({
          type: "game_score",
          userId: ctx.userId,
          game: msg.game as (typeof ARCADE_GAMES)[number],
          score: msg.score,
        });
        return;
      }

      sendError(`unknown message type: ${String(msg.type)}`);
    };

    const close = (): void => {
      if (watching) {
        if (watcher) watching.watchers.delete(watcher);
        watching = null;
      }
      if (ctx) {
        ctx.unsubscribe();
        if (watcher) ctx.project.watchers.delete(watcher);
        ctx.entry.session.leave(ctx.userId);
        ctx = null;
      }
    };

    return { handleMessage, close };
  }

  // Null unless `--hub` was asked for, and every `relay?.` call site above is
  // then a no-op: the hub is strictly additive (spec §6). Declared after
  // `createConnection` because it takes it, and read only from inside handlers
  // that cannot run before `listen` resolves.
  const relay = opts.hub
    ? new Relay(
        {
          hubUrl: opts.hub.url,
          projectId: opts.hub.projectId,
          repoKey: repo?.key ?? "",
          uplinkId: opts.hub.uplinkId ?? randomUUID(),
          connect: opts.hub.connect,
        },
        { createConnection },
      )
    : null;

  wss.on("connection", (ws: WebSocket, upgradeReq: IncomingMessage) => {
    const conn = createConnection({
      mode: "direct",
      // Guarded here rather than at every call site: a socket can close
      // between an append and its fan-out, and a send on a closed socket
      // throws.
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      watcher: ws,
      // Captured once: the cookie cannot change for the life of this socket.
      cookieHeader: upgradeReq.headers.cookie,
    });

    // Without a listener, an "error" event on this socket would be an
    // unhandled EventEmitter error and crash the whole process. Cleanup
    // (unsubscribe/leave) is handled by "close", which always follows an
    // "error" event on a ws socket.
    ws.on("error", (err: NodeJS.ErrnoException) => {
      void err?.code;
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
        return;
      }
      conn.handleMessage(msg);
    });

    ws.on("close", () => conn.close());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    wss.once("error", onError);
    httpServer.once("listening", () => {
      httpServer.removeListener("error", onError);
      wss.removeListener("error", onError);
      resolve();
    });
    httpServer.listen(opts.port, opts.host);
  });
  relay?.start();
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    // The transport seam: the direct WebSocket adapter above is one caller,
    // the hub uplink is the other.
    createConnection,
    close: () =>
      new Promise<void>((resolve, reject) => {
        relay?.stop();
        overseer.dispose();
        for (const timer of pushTimers.values()) clearTimeout(timer);
        pushTimers.clear();
        for (const client of wss.clients) client.terminate();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
