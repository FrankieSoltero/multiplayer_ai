import { useEffect, useMemo, useRef, useState } from "react";
import { SERVER_URL } from "../types";
import type { MachineInfo, ProjectSessionInfo, ProjectSummary, RepoInfo } from "../types";
import { slugPreview, sortSessions } from "../sessionRow";
import { sessionBadgeLabel, sessionStateClass } from "../sessionState";
import { groupByRepo } from "../repoGroups";
import { canAct, refusalText } from "../projectAccess";
import { freeSessionName } from "../sessionNames";
import { entranceUrl } from "../pickerUrl";

/** The project screen (spec §4.2): every session across every repo, each
 *  labelled with its repo and machine. Spectators see everything and can act
 *  on nothing — action controls are ABSENT, not disabled, because a disabled
 *  button is a promise you cannot keep (spec §4.4). */
export function SessionPicker(props: { projectId: string; userId: string; name: string }) {
  const [sessions, setSessions] = useState<ProjectSessionInfo[]>([]);
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [repoKey, setRepoKey] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "identify", userId: props.userId, name: props.name }));
      ws.send(JSON.stringify({ type: "watch_project", projectId: props.projectId }));
      ws.send(JSON.stringify({ type: "list_projects" }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "project") {
          setSessions(msg.sessions ?? []);
          setMachines(msg.machines ?? []);
          setRepo(msg.repo ?? null);
        }
        if (msg.type === "projects") setProjects(msg.projects ?? []);
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
  }, [props.projectId, props.userId, props.name]);

  const project = useMemo(
    () => projects.find((p) => p.id === props.projectId) ?? null,
    [projects, props.projectId],
  );
  // `projects` is empty until the reply lands; treat that as "still loading"
  // rather than as an unknown project, or the screen flashes a refusal.
  const refusal = projects.length === 0 ? null : canAct(project, props.userId);
  const online = machines.filter((m) => m.online);
  const chosenRepo = repoKey ?? online[0]?.repoKey ?? null;
  const groups = groupByRepo(sortSessions(sessions));
  const showRepoHeads = groups.length > 1;

  const baseValue = baseRef ?? repo?.defaultBranch ?? "";
  const desired = slugPreview(name);
  const finalName = desired ? freeSessionName(sessions.map((s) => s.id), desired) : "";
  const canCreate = refusal === null && chosenRepo !== null && finalName.length > 0 && !pending;

  const create = () => {
    if (!canCreate) return;
    setError(null);
    setPending(true);
    wsRef.current?.send(
      JSON.stringify({
        type: "create_session",
        projectId: props.projectId,
        name: finalName,
        repoKey: chosenRepo,
        ...(baseValue.trim() ? { baseRef: baseValue.trim() } : {}),
      }),
    );
  };

  const join = () => {
    wsRef.current?.send(JSON.stringify({ type: "join_project", projectId: props.projectId }));
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={() => { window.location.search = entranceUrl(); }}>
          ◂ HUB
        </button>
        <span className="pix lg">{project?.name ?? props.projectId}</span>
        <span className="rule" />
        <span className="pix">{online.length} MACHINES</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {refusal === "not-a-member" && (
          <div className="panel">
            <div className="line dim">{refusalText(refusal)}</div>
            <button className="btn" onClick={join}>JOIN PROJECT ▸</button>
          </div>
        )}
        <div className="panel">
          {sessions.length === 0 && (
            <div className="line dim">no sessions yet.</div>
          )}
          {groups.map((group) => (
            <div key={group.repoKey || "unknown"}>
              {showRepoHeads && (
                <div className="line pix sm dim">{group.repoKey || "unknown repo"}</div>
              )}
              {group.sessions.map((s) => (
                <div className="sprow" key={s.id}>
                  <div className="spbody">
                    <div className="spname">
                      {s.id}
                      <span className={`spstate pix sm ${sessionStateClass({ ...s, participantCount: s.participants.length }) || "live"}`}>
                        {sessionBadgeLabel({ ...s, participantCount: s.participants.length })}
                      </span>
                    </div>
                    {s.intent && <div className="spintent dim">{s.intent}</div>}
                    <div className="spwho pix sm">
                      {[
                        s.repoKey ?? "unknown repo",
                        s.machineId ?? "unknown machine",
                        s.participants.length > 0 ? s.participants.join(" · ") : "empty",
                      ].join("  ·  ")}
                    </div>
                  </div>
                  <button className="btn" onClick={() => joinSession(s.id, props.projectId)}>
                    {refusal === null ? "JOIN ▸" : "WATCH ▸"}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
        {refusal === null && (
          <>
            <div className="panel pix top">NEW SESSION</div>
            <div className="panel">
              <div className="spform">
                <input
                  className="spinput"
                  placeholder="session name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") create(); }}
                />
                <span className="spinput" style={{ padding: 0 }}>
                  <select
                    aria-label="repo"
                    value={chosenRepo ?? ""}
                    onChange={(e) => setRepoKey(e.target.value)}
                  >
                    {online.map((m) => (
                      <option key={m.machineId} value={m.repoKey}>
                        {m.repoKey}
                      </option>
                    ))}
                  </select>
                </span>
                <input
                  className="spinput"
                  placeholder="base ref"
                  value={baseValue}
                  onChange={(e) => setBaseRef(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") create(); }}
                />
                <button className="btn" disabled={!canCreate} onClick={create}>
                  CREATE ▸
                </button>
              </div>
              {finalName.length > 0 && finalName !== name && (
                <div className="line dim">will create as: {finalName}</div>
              )}
              {error && <div className="line red">{error}</div>}
            </div>
          </>
        )}
        {refusal !== null && refusal !== "not-a-member" && (
          <div className="panel">
            <div className="line dim">{refusalText(refusal)}</div>
          </div>
        )}
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
