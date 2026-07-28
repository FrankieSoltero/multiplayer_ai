import { useEffect, useMemo, useRef, useState } from "react";
import { SERVER_URL } from "../types";
import type { MachineInfo, ProjectSessionInfo, ProjectSummary, RepoInfo } from "../types";
import { slugPreview, sortSessions } from "../sessionRow";
import { sessionBadgeLabel, sessionStateClass } from "../sessionState";
import { groupByRepo } from "../repoGroups";
import { canAct, refusalText } from "../projectAccess";
import { freeSessionName } from "../sessionNames";
import { entranceUrl, sessionUrlFrom } from "../pickerUrl";

/** How long to wait for a routed `create_session` to be answered before giving
 *  the button back. Generous on purpose: provisioning a worktree is real work
 *  on a real laptop, and a false "no reply" on a slow-but-alive machine is
 *  worse than a few extra seconds of waiting. */
const CREATE_TIMEOUT_MS = 30_000;

/** Names the real cause. "Something went wrong" would send the user looking at
 *  their own input; the machine not answering is the thing they can act on. */
const CREATE_TIMEOUT_TEXT =
  "no reply from the machine — it may have gone offline. check it is still running and try again.";

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
  const createTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCreateTimer = () => {
    if (createTimer.current === null) return;
    clearTimeout(createTimer.current);
    createTimer.current = null;
  };

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
        if (msg.type === "session_created") {
          clearCreateTimer();
          joinSession(msg.sessionId, props.projectId);
        }
        if (msg.type === "error") {
          clearCreateTimer();
          setError(msg.message);
          setPending(false);
        }
      } catch {
        return;
      }
    };
    return () => {
      ws.close();
      clearCreateTimer();
    };
  }, [props.projectId, props.userId, props.name]);

  const project = useMemo(
    () => projects.find((p) => p.id === props.projectId) ?? null,
    [projects, props.projectId],
  );
  // `projects` is empty until the reply lands; treat that as "still loading"
  // rather than as an unknown project, or the screen flashes a refusal.
  const refusal = projects.length === 0 ? null : canAct(project, props.userId);
  const online = machines.filter((m) => m.online);
  // Fallback order matters: an explicit choice always wins, then a hub
  // machine offering a repo, and only then the standalone server's own repo
  // (`repo.key`) — the one field a standalone server DOES send, and which
  // the hub-shaped `machines`/`online` path can never populate for it. Without
  // this last fallback, a standalone deployment (no `machines` message ever
  // arrives) has `online` permanently empty and could never create a session.
  const chosenRepo = repoKey ?? online[0]?.repoKey ?? repo?.key ?? null;
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
    // `create_session` is ROUTED: the hub picks an online machine and forwards
    // it, answering itself only when it refuses. That adds a hop the
    // pre-hub code never had — if the machine dies between being picked
    // (hub.ts's `machinesIn().find(m => m.online)`) and its reply, nothing
    // arrives at all. `pending` was cleared only by an incoming `error`, so
    // CREATE stayed disabled forever with no message and no way out but a
    // reload. Armed BEFORE the send so a send that throws on a closed socket
    // recovers the same way. Cleared by a reply, by an error, and on unmount.
    clearCreateTimer();
    createTimer.current = setTimeout(() => {
      createTimer.current = null;
      setPending(false);
      setError(CREATE_TIMEOUT_TEXT);
    }, CREATE_TIMEOUT_MS);
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
  window.location.search = sessionUrlFrom(window.location.search, sessionId, projectId);
}
