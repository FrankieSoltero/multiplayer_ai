import { useEffect, useMemo, useRef, useState } from "react";
import { SERVER_URL } from "../types";
import type { MachineInfo, ProjectSessionInfo, ProjectSummary } from "../types";
import { slugPreview, sortSessions } from "../sessionRow";
import { sessionBadgeLabel, sessionStateClass } from "../sessionState";
import { groupByRepo } from "../repoGroups";
import { choiceValue, chooseRepo, parseChoiceValue, repoChoices } from "../repoChoices";
import { canAct, refusalText } from "../projectAccess";
import { freeSessionName } from "../sessionNames";
import { entranceUrl, sessionUrlFrom } from "../pickerUrl";
import { MachinesPanel } from "./MachinesPanel";

/** How long to wait for a routed command to be answered before giving the
 *  button back. Shared by `create_session`, `attach_repo`, and `detach_repo`
 *  (spec §12.1: one in-flight routed command per channel covers all three) —
 *  generous on purpose, since provisioning a worktree or computing a default
 *  branch is real work on a real laptop, and a false "no reply" on a
 *  slow-but-alive machine is worse than a few extra seconds of waiting. */
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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  // The unit of choice is the (machine, repo) PAIR: one repo key can be
  // attached on two machines at once, so a key alone names no destination.
  const [picked, setPicked] = useState<{ machineId: string; repoKey: string } | null>(null);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const createTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCreateTimer = () => {
    if (createTimer.current === null) return;
    clearTimeout(createTimer.current);
    createTimer.current = null;
  };

  // Shared by create/attach/detach: arm the one no-reply timeout slot before
  // sending, so a routed command that never gets answered gives the button
  // back with a named reason instead of leaving `pending` stuck forever.
  const armReplyTimer = () => {
    clearCreateTimer();
    createTimer.current = setTimeout(() => {
      createTimer.current = null;
      setPending(false);
      setError(CREATE_TIMEOUT_TEXT);
    }, CREATE_TIMEOUT_MS);
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
        }
        if (msg.type === "projects") setProjects(msg.projects ?? []);
        if (msg.type === "session_created") {
          clearCreateTimer();
          joinSession(msg.sessionId, props.projectId);
        }
        if (msg.type === "repo_attached" || msg.type === "repo_detached") {
          clearCreateTimer();
          setPending(false);
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
  // Every reachable destination, standalone included: a solo server reports
  // itself as one real machine with a real repo list, so the old `repo.key`
  // special case it used to need is gone (spec §8).
  const choices = repoChoices(machines);
  const chosen = chooseRepo(choices, picked);
  const groups = groupByRepo(sortSessions(sessions));
  const showRepoHeads = groups.length > 1;

  // Per-repo prefill (D9): the chosen repo's own default branch, until the
  // user types over it. Changing the repo clears `baseRef` so this re-prefills.
  const baseValue = baseRef ?? chosen?.defaultBranch ?? "";
  const desired = slugPreview(name);
  const finalName = desired ? freeSessionName(sessions.map((s) => s.id), desired) : "";
  const canCreate = refusal === null && chosen !== null && finalName.length > 0 && !pending;

  const create = () => {
    if (!canCreate || chosen === null) return;
    setError(null);
    setPending(true);
    // `create_session` is ROUTED: the hub forwards it to the machine named
    // here, answering itself only when it refuses. That adds a hop the
    // pre-hub code never had — if the machine dies between being picked and
    // its reply, nothing arrives at all. `pending` was cleared only by an incoming `error`, so
    // CREATE stayed disabled forever with no message and no way out but a
    // reload. Armed BEFORE the send so a send that throws on a closed socket
    // recovers the same way. Cleared by a reply, by an error, and on unmount.
    armReplyTimer();
    wsRef.current?.send(
      JSON.stringify({
        type: "create_session",
        projectId: props.projectId,
        name: finalName,
        repoKey: chosen.repoKey,
        machineId: chosen.machineId,
        ...(baseValue.trim() ? { baseRef: baseValue.trim() } : {}),
      }),
    );
  };

  const join = () => {
    wsRef.current?.send(JSON.stringify({ type: "join_project", projectId: props.projectId }));
  };

  // ATTACH/DETACH from the MACHINES panel: routed commands on the same
  // one-slot reply bound as `create_session` (spec §12.1), so they share
  // `pending`/`error` and the same no-reply timeout — an attach in flight
  // disables CREATE too, and vice versa, which is honest: the channel really
  // can only have one routed reply outstanding at a time.
  const attach = (machineId: string, repoKey: string) => {
    setError(null);
    setPending(true);
    armReplyTimer();
    wsRef.current?.send(
      JSON.stringify({ type: "attach_repo", projectId: props.projectId, machineId, repoKey }),
    );
  };

  const detach = (machineId: string, repoKey: string) => {
    setError(null);
    setPending(true);
    armReplyTimer();
    wsRef.current?.send(
      JSON.stringify({ type: "detach_repo", projectId: props.projectId, machineId, repoKey }),
    );
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
          <MachinesPanel
            machines={machines}
            onAttach={attach}
            onDetach={detach}
            pending={pending}
            error={error}
          />
        )}
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
                    value={chosen ? choiceValue(chosen) : ""}
                    onChange={(e) => {
                      setPicked(parseChoiceValue(e.target.value));
                      // D9: drop the typed/prefilled base ref so `baseValue`
                      // re-prefills from the newly chosen repo's default branch.
                      setBaseRef(null);
                    }}
                  >
                    {choices.map((c) => (
                      <option key={choiceValue(c)} value={choiceValue(c)}>
                        {c.label}
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
