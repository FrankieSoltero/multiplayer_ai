import { useEffect, useRef, useState } from "react";
import type { LoggedEvent, ProjectSessionInfo } from "./types";
import { SERVER_URL } from "./types";
import type { Profile } from "./identity";

export function useSessionSocket(opts: {
  sessionId: string;
  projectId: string;
  userId: string;
  profile: Profile;
}): {
  events: LoggedEvent[];
  errors: string[];
  connected: boolean;
  projectSessions: ProjectSessionInfo[];
  send: (msg: object) => void;
} {
  const { sessionId, projectId, userId, profile } = opts;
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [projectSessions, setProjectSessions] = useState<ProjectSessionInfo[]>(
    [],
  );
  const wsRef = useRef<WebSocket | null>(null);

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
          name: profile.name,
          glyph: profile.glyph,
          color: profile.color,
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
  }, [projectId, sessionId, userId, profile.name, profile.glyph, profile.color]);

  const send = (msg: object) => {
    wsRef.current?.send(JSON.stringify(msg));
  };

  return { events, errors, connected, projectSessions, send };
}
