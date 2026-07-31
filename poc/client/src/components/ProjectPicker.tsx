import { useEffect, useRef, useState } from "react";
import { SERVER_URL, isProjectMember, projectMemberCount } from "../types";
import type { ProjectSummary } from "../types";
import { sortProjects, projectSummaryLine } from "../projectList";

/** Whether this screen's socket is up. `connecting` is the brief pre-open
 *  state and shows nothing — a failed connect lands in `down` via onerror. */
type LinkState = "connecting" | "live" | "down";

const DISCONNECTED_TEXT =
  "lost the hub — it may have restarted. this list is stale; reload to reconnect.";

/** The hub entrance (spec §4.1): every project on the hub, not only yours.
 *  Visibility is hub-wide; membership only governs acting (spec P2), so this
 *  screen never filters by membership. */
export function ProjectPicker(props: { userId: string; name: string }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");
  const [name, setName] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let mounted = true;
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      if (!mounted) return;
      setLink("live");
      setError(null);
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
    // A dev hub gets restarted often, so losing the socket is the EXPECTED
    // case, not an exotic one — what a restart no longer costs is the projects
    // themselves, only this tab's connection to them.
    // Without these handlers the list went silently stale and `send()` threw
    // InvalidStateError inside the click handler — CREATE did nothing, with no
    // feedback. `mounted` guards the close our own cleanup causes.
    const drop = () => { if (mounted) setLink("down"); };
    ws.onclose = drop;
    ws.onerror = drop;
    return () => {
      mounted = false;
      ws.close();
    };
  }, [props.userId, props.name]);

  const create = () => {
    if (!name.trim()) return;
    const ws = wsRef.current;
    // readyState, not null: a socket that has closed is still a non-null
    // object, and sending on it throws rather than failing quietly. No
    // reconnect loop — this screen's whole state is one `list_projects` reply,
    // so a reload is a cheaper and more honest recovery than a retry ladder.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setLink("down");
      setError(DISCONNECTED_TEXT);
      return;
    }
    setError(null);
    ws.send(JSON.stringify({ type: "create_project", name: name.trim() }));
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix lg">PROJECTS</span>
        <span className="rule" />
        <span className="pix">{props.name}</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {link === "down" && (
          <div className="panel">
            <div className="line red">{DISCONNECTED_TEXT}</div>
          </div>
        )}
        <div className="panel">
          <ProjectRows projects={projects} userId={props.userId} />
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
            <button className="btn" disabled={!name.trim() || link === "down"} onClick={create}>
              CREATE ▸
            </button>
          </div>
          <div className="line dim">
            projects and their records persist in the hub's store (HUB_DB).
          </div>
          {error && <div className="line red">{error}</div>}
        </div>
      </div>
    </div>
  );
}

/** The entrance's project list, taken as a prop.
 *
 *  Exported and props-only for the same reason as `SessionGroups`: the picker
 *  fills `projects` from a socket in `useEffect`, static rendering never runs
 *  effects, so the picker itself can only ever draw an EMPTY list in a test.
 *  This seam is what lets `ProjectPicker.test.tsx` assert the redaction-safe
 *  count and the isMember-driven SPECTATING badge against real fixtures.
 *
 *  Both read through the `types.ts` helpers, never off `members` directly: a
 *  redacted non-member sees `members: []` but a true `memberCount`, and its
 *  membership is `isMember: false` — so the count stays honest and the badge
 *  no longer flips on an empty roster (spec A5). */
export function ProjectRows(props: { projects: ProjectSummary[]; userId: string }) {
  const rows = sortProjects(props.projects);
  return (
    <>
      {rows.length === 0 && (
        <div className="line dim">no projects yet — create one below.</div>
      )}
      {rows.map((p) => {
        const count = projectMemberCount(p);
        return (
          <div className="sprow" key={p.id}>
            <div className="spbody">
              <div className="spname">
                {p.name}
                {p.lifecycle === "closed" && (
                  <span className="spstate pix sm closed">CLOSED</span>
                )}
                {!isProjectMember(p, props.userId) && (
                  <span className="spstate pix sm">SPECTATING</span>
                )}
              </div>
              <div className="spwho pix sm">
                {count} {count === 1 ? "member" : "members"} ·{" "}
                {projectSummaryLine(p)}
              </div>
            </div>
            <button className="btn" onClick={() => enterProject(p.id)}>
              ENTER ▸
            </button>
          </div>
        );
      })}
    </>
  );
}

function enterProject(projectId: string): void {
  const params = new URLSearchParams();
  params.set("project", projectId);
  window.location.search = params.toString();
}
