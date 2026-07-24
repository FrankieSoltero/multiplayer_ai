import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type LoggedEvent = {
  seq: number;
  ts: string;
  type: string;
  userId?: string;
  name?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
  message?: string;
  requestId?: string;
  decision?: string;
};

type ProjectSessionInfo = {
  id: string;
  participants: string[];
  driverName: string | null;
  intent: string | null;
  lastActivityTs: string | null;
  ended: boolean;
};

const SERVER_URL = "ws://localhost:3001";

function getIdentity(): { id: string; name: string } {
  let id = sessionStorage.getItem("mpai-userId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mpai-userId", id);
  }
  let name = sessionStorage.getItem("mpai-userName");
  if (!name) {
    name = `user-${id.slice(0, 4)}`;
    sessionStorage.setItem("mpai-userName", name);
  }
  return { id, name };
}

export default function App() {
  const [{ id: userId, name }] = useState(getIdentity);
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [projectSessions, setProjectSessions] = useState<ProjectSessionInfo[]>(
    [],
  );
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session") ?? "demo";
  const projectId = params.get("project") ?? "default";

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(
        JSON.stringify({
          type: "join",
          sessionId,
          projectId,
          userId,
          name,
          lastSeq: 0,
        }),
      );
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "event") setEvents((prev) => [...prev, msg.event]);
        if (msg.type === "error") setErrors((prev) => [...prev, msg.message]);
        if (msg.type === "project") setProjectSessions(msg.sessions);
      } catch {
        return;
      }
    };
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, [projectId, sessionId, userId, name]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const { driverId, participants, myIntent, permissionDecisions } = useMemo(() => {
    let driverId: string | null = null;
    const participants = new Map<string, string>();
    let myIntent: string | null = null;
    const permissionDecisions = new Map<string, string>();
    for (const ev of events) {
      if (ev.type === "presence_join" && ev.userId && ev.name)
        participants.set(ev.userId, ev.name);
      if (ev.type === "presence_leave" && ev.userId)
        participants.delete(ev.userId);
      if (ev.type === "control_change" && ev.userId) driverId = ev.userId;
      if (ev.type === "intent_update") myIntent = ev.text ?? null;
      if (ev.type === "permission_decision" && ev.requestId && ev.decision)
        permissionDecisions.set(ev.requestId, ev.decision);
    }
    return { driverId, participants, myIntent, permissionDecisions };
  }, [events]);

  const isDriver = driverId === userId;

  function sendPrompt() {
    const text = input.trim();
    if (!text || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "prompt", text }));
    setInput("");
  }

  function takeWheel() {
    wsRef.current?.send(JSON.stringify({ type: "take_wheel" }));
  }

  function sendPermission(requestId: string, decision: "allow" | "deny") {
    wsRef.current?.send(JSON.stringify({ type: "permission", requestId, decision }));
  }

  return (
    <div className="app">
      <header>
        <h1>
          Multiplayer AI — session <code>{sessionId}</code> · project{" "}
          <code>{projectId}</code>
        </h1>
        <div className="status">
          <span className={connected ? "dot on" : "dot off"} />
          {connected ? "connected" : "disconnected"}
        </div>
      </header>

      <div className="participants">
        {[...participants.entries()].map(([id, pname]) => (
          <span key={id} className={id === driverId ? "avatar driving" : "avatar"}>
            {pname}
            {id === driverId ? " 🛞" : ""}
            {id === userId ? " (you)" : ""}
          </span>
        ))}
      </div>

      {myIntent && <div className="my-intent">🎯 {myIntent}</div>}

      <div className="workspace">
        <main className="transcript">
          {events.map((ev) => {
            switch (ev.type) {
              case "user_message":
                return (
                  <div key={ev.seq} className="msg user">
                    <b>{participants.get(ev.userId ?? "") ?? ev.userId}:</b>{" "}
                    {ev.text}
                  </div>
                );
              case "agent_text_delta":
                return (
                  <div key={ev.seq} className="msg agent">
                    {ev.text}
                  </div>
                );
              case "tool_call":
                return (
                  <div key={ev.seq} className="msg tool">
                    ⚙ {ev.toolName}({JSON.stringify(ev.input)})
                  </div>
                );
              case "tool_result":
                return (
                  <div key={ev.seq} className="msg tool">
                    ↳ {ev.output?.slice(0, 300)}
                  </div>
                );
              case "control_change":
                return (
                  <div key={ev.seq} className="msg system">
                    🛞 {participants.get(ev.userId ?? "") ?? ev.userId} took the
                    wheel
                  </div>
                );
              case "agent_error":
                return (
                  <div key={ev.seq} className="msg error">
                    ⚠ {ev.message}
                  </div>
                );
              case "intent_update":
                return (
                  <div key={ev.seq} className="msg system">
                    🎯 agent intent: {ev.text}
                  </div>
                );
              case "permission_request": {
                const decided = ev.requestId
                  ? permissionDecisions.get(ev.requestId)
                  : undefined;
                const cmd = (ev.input as { command?: unknown } | undefined)?.command;
                const preview =
                  typeof cmd === "string" ? cmd : JSON.stringify(ev.input);
                return (
                  <div key={ev.seq} className="msg permission">
                    <div className="permission-title">
                      🔐 agent wants to run <b>{ev.toolName}</b>
                    </div>
                    <code className="permission-input">
                      {preview?.slice(0, 300)}
                    </code>
                    {decided ? (
                      <div className="permission-outcome">
                        {decided === "allow" ? "✅ approved" : "⛔ denied"}
                      </div>
                    ) : isDriver && ev.requestId ? (
                      <div className="permission-actions">
                        <button onClick={() => sendPermission(ev.requestId!, "allow")}>
                          Approve
                        </button>
                        <button
                          className="deny"
                          onClick={() => sendPermission(ev.requestId!, "deny")}
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <div className="permission-outcome">
                        ⏳ waiting for the driver to decide…
                      </div>
                    )}
                  </div>
                );
              }
              case "permission_decision":
                return (
                  <div key={ev.seq} className="msg system">
                    {ev.decision === "allow" ? "✅" : "⛔"}{" "}
                    {participants.get(ev.userId ?? "") ?? ev.userId}{" "}
                    {ev.decision === "allow" ? "approved" : "denied"} a tool
                    request
                  </div>
                );
              default:
                return null;
            }
          })}
          <div ref={bottomRef} />
        </main>
        <aside className="teammates">
          <h2>Project: {projectId}</h2>
          {projectSessions
            .filter((s) => s.id !== sessionId)
            .map((s) => (
              <a
                key={s.id}
                className={s.ended ? "teammate ended" : "teammate"}
                href={`?project=${projectId}&session=${s.id}`}
              >
                <div className="teammate-id">
                  {s.id} {s.ended ? "(ended)" : ""}
                </div>
                <div className="teammate-intent">
                  {s.intent ?? "no declared intent yet"}
                </div>
                <div className="teammate-meta">
                  {s.participants.join(", ") || "empty"}
                  {s.driverName ? ` · 🛞 ${s.driverName}` : ""}
                  {s.lastActivityTs
                    ? ` · ${new Date(s.lastActivityTs).toLocaleTimeString()}`
                    : ""}
                </div>
              </a>
            ))}
          {projectSessions.filter((s) => s.id !== sessionId).length === 0 && (
            <div className="teammate-empty">No other sessions yet</div>
          )}
        </aside>
      </div>

      {errors.length > 0 && (
        <div className="msg error">⚠ {errors.at(-1)}</div>
      )}

      <footer>
        {isDriver ? (
          <>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendPrompt()}
              placeholder="You're driving — prompt the agent…"
              maxLength={4000}
            />
            <button onClick={sendPrompt}>Send</button>
          </>
        ) : (
          <button className="wheel" onClick={takeWheel}>
            Take the wheel 🛞
          </button>
        )}
      </footer>
    </div>
  );
}
