import { useEffect, useRef, useState } from "react";
import { SERVER_URL } from "../types";
import type { ProjectSummary } from "../types";
import { sortProjects, projectSummaryLine } from "../projectList";

/** The hub entrance (spec §4.1): every project on the hub, not only yours.
 *  Visibility is hub-wide; membership only governs acting (spec P2), so this
 *  screen never filters by membership. */
export function ProjectPicker(props: { userId: string; name: string }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "identify", userId: props.userId, name: props.name }));
      ws.send(JSON.stringify({ type: "list_projects" }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "projects") setProjects(msg.projects ?? []);
        if (msg.type === "project_created") enterProject(msg.projectId);
        if (msg.type === "error") setError(msg.message);
      } catch {
        return;
      }
    };
    return () => ws.close();
  }, [props.userId, props.name]);

  const create = () => {
    if (!name.trim()) return;
    setError(null);
    wsRef.current?.send(JSON.stringify({ type: "create_project", name: name.trim() }));
  };

  const rows = sortProjects(projects);

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix lg">PROJECTS</span>
        <span className="rule" />
        <span className="pix">{props.name}</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          {rows.length === 0 && (
            <div className="line dim">no projects yet — create one below.</div>
          )}
          {rows.map((p) => (
            <div className="sprow" key={p.id}>
              <div className="spbody">
                <div className="spname">
                  {p.name}
                  {p.lifecycle === "closed" && (
                    <span className="spstate pix sm closed">CLOSED</span>
                  )}
                  {!p.members.includes(props.userId) && (
                    <span className="spstate pix sm">SPECTATING</span>
                  )}
                </div>
                <div className="spwho pix sm">
                  {p.members.length} {p.members.length === 1 ? "member" : "members"} ·{" "}
                  {projectSummaryLine(p)}
                </div>
              </div>
              <button className="btn" onClick={() => enterProject(p.id)}>
                ENTER ▸
              </button>
            </div>
          ))}
        </div>
        <div className="panel pix top">NEW PROJECT</div>
        <div className="panel">
          <div className="spform">
            <input
              className="spinput"
              placeholder="project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button className="btn" disabled={!name.trim()} onClick={create}>
              CREATE ▸
            </button>
          </div>
          <div className="line dim">
            nothing here survives a hub restart yet — projects are held in memory.
          </div>
          {error && <div className="line red">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function enterProject(projectId: string): void {
  const params = new URLSearchParams();
  params.set("project", projectId);
  window.location.search = params.toString();
}
