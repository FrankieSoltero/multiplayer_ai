import { useCallback, useEffect, useRef, useState } from "react";
import type { ArcadeRecord, LoggedEvent, OversightState, PluginInfo, ProjectSessionInfo } from "./types";
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
  /** The server's `joined` success ack has arrived (PRD §10.4b). False until
   *  then, and reset to false on socket close/rejoin. An OLD server never sends
   *  the message, so this simply stays false there — the UI treats it as the
   *  still-connecting state and renders exactly as it did before. */
  joined: boolean;
  projectSessions: ProjectSessionInfo[];
  arcade: ArcadeRecord[];
  plugins: PluginInfo[];
  pluginsEnabled: boolean;
  oversight: OversightState;
  send: (msg: object) => void;
} {
  const { sessionId, projectId, userId, profile } = opts;
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [projectSessions, setProjectSessions] = useState<ProjectSessionInfo[]>(
    [],
  );
  const [arcade, setArcade] = useState<ArcadeRecord[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginsEnabled, setPluginsEnabled] = useState(false);
  const [oversight, setOversight] = useState<OversightState>({ enabled: false, latest: null });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      // Reset on every (re)open: this socket is not joined until its own
      // `joined` ack arrives, so a rejoin never inherits the prior socket's
      // success state.
      setJoined(false);
      // No `invite` field (plan 2026-08-01-project-invites §1.4): invites are
      // project-scoped and redeem at join_project; the server ignores unknown
      // fields, but there is nothing left for one to mean here.
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
        if (msg.type === "event") {
          setEvents((prev) => [...prev, msg.event]);
        }
        // Join success ack (PRD §10.4b): flips `joined` true. An old server
        // never sends it, so `joined` stays false there — no behavior change.
        if (msg.type === "joined") setJoined(true);
        if (msg.type === "error") setErrors((prev) => [...prev, msg.message]);
        if (msg.type === "project") {
          setProjectSessions(msg.sessions);
          setArcade(msg.arcade ?? []);
          setPlugins(msg.plugins ?? []);
          setPluginsEnabled(msg.pluginsEnabled ?? false);
          setOversight(msg.oversight ?? { enabled: false, latest: null });
        }
      } catch {
        return;
      }
    };
    ws.onclose = () => {
      setConnected(false);
      setJoined(false);
    };
    return () => ws.close();
  }, [projectId, sessionId, userId, profile.name, profile.glyph, profile.color]);

  // Stable identity across renders: it only ever reads wsRef (a ref, not
  // state), so an empty dep array is correct — there is nothing in this
  // closure that goes stale. A re-created `send` on every render is what once
  // drove a list-on-open effect (the retired INVITE screen's) into a tight
  // loop, since `send` was in that effect's dep array.
  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    // WebSocket.send() throws InvalidStateError while CONNECTING (the header
    // EXIT control is clickable before `connected` flips true). CLOSING/
    // CLOSED are left alone — send() only discards silently there, which is
    // the correct degrade-to-disconnect behaviour.
    if (!ws || ws.readyState === WebSocket.CONNECTING) return;
    ws.send(JSON.stringify(msg));
  }, []);

  return { events, errors, connected, joined, projectSessions, arcade, plugins, pluginsEnabled, oversight, send };
}
