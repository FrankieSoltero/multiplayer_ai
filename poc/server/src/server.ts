import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { AgentDriver, runAgentQuery, type RunQuery } from "./agentDriver.js";
import { buildTeammateDigest, summarizeSession } from "./digest.js";
import { isModelKey } from "./models.js";
import {
  Project,
  projectSnapshot,
  SLUG,
  type ProjectSessionEntry,
} from "./project.js";
import { Session } from "./session.js";
import { PluginStore } from "./pluginStore.js";
import { ARCADE_GAMES } from "./events.js";
import { slugify, type WorkspaceLike } from "./workspace.js";

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

export async function startServer(opts: {
  port: number;
  runQuery?: RunQuery;
  plugins?: PluginStore;
  workspace?: WorkspaceLike;
}) {
  const runQuery = opts.runQuery ?? runAgentQuery;
  const pluginStore = opts.plugins ?? new PluginStore(process.env.AGENT_PLUGINS_ROOT);
  // Cached once at startup: the default branch changing mid-run is rare and
  // harmless (it only seeds the create form's base-ref field).
  const repo = opts.workspace
    ? { workspace: opts.workspace, defaultBranch: opts.workspace.defaultBranch() }
    : null;
  const projects = new Map<string, Project>();
  const lastPush = new Map<Project, number>();
  const pushTimers = new Map<Project, NodeJS.Timeout>();

  function snapshotFor(project: Project) {
    return projectSnapshot(
      project,
      { plugins: pluginStore.list(project.id), enabled: pluginStore.enabled },
      repo && { defaultBranch: repo.defaultBranch },
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
        ),
        skills,
        pendingSuggests: new Map(),
      };
      entry = newEntry;
      project.sessions.set(sessionId, entry);
      session.subscribe((event) => {
        if (INTERESTING.has(event.type)) schedulePush(project);
      });
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

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    let ctx: ClientContext | null = null;
    let watching: Project | null = null;

    const sendError = (message: string) =>
      ws.send(JSON.stringify({ type: "error", message }));

    // Without a listener, an "error" event on this socket would be an
    // unhandled EventEmitter error and crash the whole process. Cleanup
    // (unsubscribe/leave) is handled by the "close" handler, which always
    // follows an "error" event on a ws socket.
    ws.on("error", (err: NodeJS.ErrnoException) => {
      void err?.code;
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError("invalid JSON");
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
        const project = getOrCreateProject(projectId);
        const entry = getOrCreateSession(project, msg.sessionId);
        if ("error" in entry) return sendError(entry.error);
        // Replay first, then subscribe, then join — single-threaded, so no gap.
        const from =
          Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0 ? msg.lastSeq : 0;
        for (const event of entry.session.eventsFrom(from)) {
          ws.send(JSON.stringify({ type: "event", event }));
        }
        const unsubscribe = entry.session.subscribe((event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "event", event }));
          }
        });
        ctx = { project, entry, userId: msg.userId, unsubscribe };
        project.watchers.add(ws);
        const glyph =
          typeof msg.glyph === "string" && ALLOWED_GLYPHS.has(msg.glyph)
            ? msg.glyph
            : undefined;
        const color =
          typeof msg.color === "string" && COLOR_RE.test(msg.color)
            ? msg.color.toLowerCase()
            : undefined;
        entry.session.join(msg.userId, msg.name.slice(0, 40), { glyph, color });
        // Immediate personal snapshot so the sidebar isn't blank until the
        // next throttled push.
        ws.send(JSON.stringify(snapshotFor(project)));
        return;
      }

      if (msg.type === "peek") {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) {
          return sendError("peek requires a valid projectId");
        }
        const project = projects.get(projectId);
        ws.send(
          JSON.stringify(
            project
              ? snapshotFor(project)
              : { type: "project", sessions: [], plugins: [], pluginsEnabled: pluginStore.enabled, repo: repo && { defaultBranch: repo.defaultBranch } },
          ),
        );
        return;
      }

      if (msg.type === "watch_project") {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) {
          return sendError("watch_project requires a valid projectId");
        }
        const project = getOrCreateProject(projectId);
        if (watching) watching.watchers.delete(ws);
        project.watchers.add(ws);
        watching = project;
        ws.send(JSON.stringify(snapshotFor(project)));
        return;
      }

      if (msg.type === "create_session") {
        const projectId =
          typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId)) {
          return sendError("create_session requires a valid projectId");
        }
        if (typeof msg.name !== "string") {
          return sendError("create_session requires name");
        }
        const slug = slugify(msg.name);
        if (!slug) return sendError("create_session requires a usable name");
        const project = getOrCreateProject(projectId);
        if (project.sessions.has(slug)) {
          // Matches provision idempotence (spec §3): existing session acks.
          ws.send(JSON.stringify({ type: "session_created", sessionId: slug }));
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
        ws.send(JSON.stringify({ type: "session_created", sessionId: slug }));
        // Deliberate user action, not a hot stream — immediate push (same
        // rationale as add_plugin).
        pushProject(project);
        return;
      }

      if (!ctx) return sendError("join a session first");

      if (msg.type === "prompt") {
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
        ctx.entry.driver.sendPrompt(
          ctx.userId,
          msg.text,
          digest || undefined,
        );
        return;
      }

      if (msg.type === "take_wheel") {
        ctx.entry.session.takeWheel(ctx.userId);
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
          return sendError("game_score requires game: dino|snake|typerace");
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
    });

    ws.on("close", () => {
      if (watching) {
        watching.watchers.delete(ws);
        watching = null;
      }
      if (ctx) {
        ctx.unsubscribe();
        ctx.project.watchers.delete(ws);
        ctx.entry.session.leave(ctx.userId);
        ctx = null;
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of pushTimers.values()) clearTimeout(timer);
        pushTimers.clear();
        for (const client of wss.clients) client.terminate();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
