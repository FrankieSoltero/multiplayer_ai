import { useEffect, useRef, useState } from "react";
import type { ArcadeRecord, InviteView, LoggedEvent, OversightState, PluginInfo, ProjectSessionInfo } from "./types";
import { SERVER_URL } from "./types";
import type { Profile } from "./identity";

export function useSessionSocket(opts: {
  sessionId: string;
  projectId: string;
  userId: string;
  profile: Profile;
  invite?: string;
}): {
  events: LoggedEvent[];
  errors: string[];
  connected: boolean;
  projectSessions: ProjectSessionInfo[];
  arcade: ArcadeRecord[];
  plugins: PluginInfo[];
  pluginsEnabled: boolean;
  oversight: OversightState;
  invites: InviteView[];
  send: (msg: object) => void;
} {
  const { sessionId, projectId, userId, profile, invite } = opts;
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [projectSessions, setProjectSessions] = useState<ProjectSessionInfo[]>(
    [],
  );
  const [arcade, setArcade] = useState<ArcadeRecord[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginsEnabled, setPluginsEnabled] = useState(false);
  const [oversight, setOversight] = useState<OversightState>({ enabled: false, latest: null });
  const [invites, setInvites] = useState<InviteView[]>([]);
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
          ...(invite ? { invite } : {}),
        }),
      );
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "event") setEvents((prev) => [...prev, msg.event]);
        if (msg.type === "error") setErrors((prev) => [...prev, msg.message]);
        if (msg.type === "project") {
          setProjectSessions(msg.sessions);
          setArcade(msg.arcade ?? []);
          setPlugins(msg.plugins ?? []);
          setPluginsEnabled(msg.pluginsEnabled ?? false);
          setOversight(msg.oversight ?? { enabled: false, latest: null });
        }
        if (msg.type === "invite_list") setInvites(msg.invites ?? []);
      } catch {
        return;
      }
    };
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, [projectId, sessionId, userId, profile.name, profile.glyph, profile.color, invite]);

  const send = (msg: object) => {
    wsRef.current?.send(JSON.stringify(msg));
  };

  return { events, errors, connected, projectSessions, arcade, plugins, pluginsEnabled, oversight, invites, send };
}
