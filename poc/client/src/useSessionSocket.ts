import { useCallback, useEffect, useRef, useState } from "react";
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
        if (msg.type === "event") {
          setEvents((prev) => [...prev, msg.event]);
          // The mint/revoke/redeem events reach every participant, but only
          // the acting socket gets invite_list (it carries secret tokens —
          // spec: never broadcast). Re-request it on the narrowcast event
          // instead, so everyone's panel (if open) drops the stale entry
          // rather than showing a revoked link as still live.
          if (typeof msg.event?.type === "string" && msg.event.type.startsWith("invite_")) {
            ws.send(JSON.stringify({ type: "list_invites" }));
          }
        }
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

  // Stable identity across renders: it only ever reads wsRef (a ref, not
  // state), so an empty dep array is correct — there is nothing in this
  // closure that goes stale. A re-created `send` on every render is what
  // drove the INVITE screen's list_invites effect (App.tsx) into a tight
  // loop, since `send` was in that effect's dep array.
  const send = useCallback((msg: object) => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  return { events, errors, connected, projectSessions, arcade, plugins, pluginsEnabled, oversight, invites, send };
}
