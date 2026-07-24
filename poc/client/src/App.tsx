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
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const sessionId =
    new URLSearchParams(window.location.search).get("session") ?? "demo";

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(
        JSON.stringify({ type: "join", sessionId, userId, name, lastSeq: 0 }),
      );
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "event") setEvents((prev) => [...prev, msg.event]);
      if (msg.type === "error") setErrors((prev) => [...prev, msg.message]);
    };
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, [sessionId, userId, name]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const { driverId, participants } = useMemo(() => {
    let driverId: string | null = null;
    const participants = new Map<string, string>();
    for (const ev of events) {
      if (ev.type === "presence_join" && ev.userId && ev.name)
        participants.set(ev.userId, ev.name);
      if (ev.type === "presence_leave" && ev.userId)
        participants.delete(ev.userId);
      if (ev.type === "control_change" && ev.userId) driverId = ev.userId;
    }
    return { driverId, participants };
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

  return (
    <div className="app">
      <header>
        <h1>
          Multiplayer AI — session <code>{sessionId}</code>
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
                  🛞 {participants.get(ev.userId ?? "") ?? ev.userId} took the wheel
                </div>
              );
            case "agent_error":
              return (
                <div key={ev.seq} className="msg error">
                  ⚠ {ev.message}
                </div>
              );
            default:
              return null;
          }
        })}
        <div ref={bottomRef} />
      </main>

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
