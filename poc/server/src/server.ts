import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { AgentDriver, runAgentQuery, type RunQuery } from "./agentDriver.js";
import { Session } from "./session.js";

const MAX_PROMPT_LENGTH = 4000;

interface SessionEntry {
  session: Session;
  driver: AgentDriver;
}

interface ClientContext {
  entry: SessionEntry;
  userId: string;
  unsubscribe: () => void;
}

export async function startServer(opts: { port: number; runQuery?: RunQuery }) {
  const runQuery = opts.runQuery ?? runAgentQuery;
  const sessions = new Map<string, SessionEntry>();

  function getOrCreate(id: string): SessionEntry {
    let entry = sessions.get(id);
    if (!entry) {
      const session = new Session(id);
      entry = { session, driver: new AgentDriver(session, runQuery) };
      sessions.set(id, entry);
    }
    return entry;
  }

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    let ctx: ClientContext | null = null;

    const sendError = (message: string) =>
      ws.send(JSON.stringify({ type: "error", message }));

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError("invalid JSON");
      }

      if (msg.type === "join") {
        if (
          typeof msg.sessionId !== "string" ||
          typeof msg.userId !== "string" ||
          typeof msg.name !== "string"
        ) {
          return sendError("join requires sessionId, userId, name");
        }
        const entry = getOrCreate(msg.sessionId);
        // Replay first, then subscribe, then join — single-threaded, so no gap.
        const from = typeof msg.lastSeq === "number" ? msg.lastSeq : 0;
        for (const event of entry.session.eventsFrom(from)) {
          ws.send(JSON.stringify({ type: "event", event }));
        }
        const unsubscribe = entry.session.subscribe((event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "event", event }));
          }
        });
        ctx = { entry, userId: msg.userId, unsubscribe };
        entry.session.join(msg.userId, msg.name.slice(0, 40));
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
        ctx.entry.driver.sendPrompt(ctx.userId, msg.text);
        return;
      }

      if (msg.type === "take_wheel") {
        ctx.entry.session.takeWheel(ctx.userId);
        return;
      }

      sendError(`unknown message type: ${String(msg.type)}`);
    });

    ws.on("close", () => {
      if (ctx) {
        ctx.unsubscribe();
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
        for (const client of wss.clients) client.terminate();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
