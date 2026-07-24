import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { AgentDriver, runAgentQuery, type RunQuery } from "./agentDriver.js";
import { buildTeammateDigest, summarizeSession } from "./digest.js";
import {
  Project,
  projectSnapshot,
  SLUG,
  type ProjectSessionEntry,
} from "./project.js";
import { Session } from "./session.js";

const MAX_PROMPT_LENGTH = 4000;
const PROJECT_PUSH_INTERVAL_MS = 1000;

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
]);

export async function startServer(opts: { port: number; runQuery?: RunQuery }) {
  const runQuery = opts.runQuery ?? runAgentQuery;
  const projects = new Map<string, Project>();
  const lastPush = new Map<Project, number>();
  const pushTimers = new Map<Project, NodeJS.Timeout>();

  function pushProject(project: Project): void {
    const payload = JSON.stringify(projectSnapshot(project));
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
  ): ProjectSessionEntry {
    let entry = project.sessions.get(sessionId);
    if (!entry) {
      const session = new Session(sessionId);
      const root = process.env.AGENT_WORKDIR_ROOT;
      const workdir = root ? path.join(root, sessionId) : undefined;
      entry = { session, driver: new AgentDriver(session, runQuery, workdir) };
      project.sessions.set(sessionId, entry);
      // Project-level awareness: any interesting event on any member session
      // schedules a throttled snapshot push to the whole project.
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
        entry.session.join(msg.userId, msg.name.slice(0, 40));
        // Immediate personal snapshot so the sidebar isn't blank until the
        // next throttled push.
        ws.send(JSON.stringify(projectSnapshot(project)));
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

      sendError(`unknown message type: ${String(msg.type)}`);
    });

    ws.on("close", () => {
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
