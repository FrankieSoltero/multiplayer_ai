import { useEffect, useRef, useState } from "react";
import { SERVER_URL } from "../types";
import type { ProjectSessionInfo, RepoInfo } from "../types";
import { agentStateLabel, slugPreview, sortSessions } from "../sessionRow";

/** Entry screen when no ?session= is present (spec §4): live list of the
 *  project's sessions plus a NEW SESSION form. Watches the project channel;
 *  never joins a session itself. Navigation is a full page move — the
 *  existing join/Lobby flow takes over from there. */
export function SessionPicker(props: { projectId: string }) {
  const [sessions, setSessions] = useState<ProjectSessionInfo[]>([]);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  // null = untouched: the field shows the server-reported default branch.
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "watch_project", projectId: props.projectId }));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "project") {
          setSessions(msg.sessions ?? []);
          setRepo(msg.repo ?? null);
        }
        if (msg.type === "session_created") joinSession(msg.sessionId, props.projectId);
        if (msg.type === "error") {
          setError(msg.message);
          setPending(false);
        }
      } catch {
        return;
      }
    };
    return () => ws.close();
  }, [props.projectId]);

  const baseValue = baseRef ?? repo?.defaultBranch ?? "";
  const slug = slugPreview(name);
  const canCreate = repo !== null && slug.length > 0 && !pending;

  const create = () => {
    if (!canCreate) return;
    setError(null);
    setPending(true);
    wsRef.current?.send(
      JSON.stringify({
        type: "create_session",
        projectId: props.projectId,
        name,
        ...(baseValue.trim() ? { baseRef: baseValue.trim() } : {}),
      }),
    );
  };

  const rows = sortSessions(sessions);

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix lg">SESSIONS</span>
        <span className="rule" />
        <span className="pix">{props.projectId}</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          {rows.length === 0 && (
            <div className="line dim">no sessions yet — create one below.</div>
          )}
          {rows.map((s) => (
            <div className="sprow" key={s.id}>
              <div className="spbody">
                <div className="spname">
                  {s.id}
                  <span className={`spstate pix sm ${s.ended ? "ended" : "live"}`}>
                    {agentStateLabel(s.ended)}
                  </span>
                </div>
                {s.intent && <div className="spintent dim">{s.intent}</div>}
                <div className="spwho pix sm">
                  {s.participants.length > 0 ? s.participants.join(" · ") : "empty"}
                </div>
              </div>
              <button className="btn" onClick={() => joinSession(s.id, props.projectId)}>
                JOIN ▸
              </button>
            </div>
          ))}
        </div>
        <div className="panel pix top">NEW SESSION</div>
        <div className="panel">
          {repo === null && (
            <div className="line dim">launch via the CLI (mpai) to create sessions.</div>
          )}
          <div className="spform">
            <input
              className="spinput"
              placeholder="session name"
              value={name}
              disabled={repo === null}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <input
              className="spinput"
              placeholder="base ref"
              value={baseValue}
              disabled={repo === null}
              onChange={(e) => setBaseRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button className="btn" disabled={!canCreate} onClick={create}>
              CREATE ▸
            </button>
          </div>
          {slug.length > 0 && slug !== name && (
            <div className="line dim">will create as: {slug}</div>
          )}
          {error && <div className="line red">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function joinSession(sessionId: string, projectId: string): void {
  const params = new URLSearchParams(window.location.search);
  params.set("session", sessionId);
  if (projectId !== "default") params.set("project", projectId);
  window.location.search = params.toString();
}
