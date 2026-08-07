import { useEffect, useMemo, useRef, useState } from "react";
import { SERVER_URL, isProjectMember } from "../types";
import type {
  InviteView,
  MachineInfo,
  ManagedModelEntry,
  ProjectLifecycle,
  ProjectSessionInfo,
  ProjectSummary,
} from "../types";
import { slugPreview, sortSessions } from "../sessionRow";
import { sessionBadgeLabel, sessionStateClass } from "../sessionState";
import { groupByRepo } from "../repoGroups";
import { choiceValue, chooseRepo, parseChoiceValue, repoChoices, repoLabels } from "../repoChoices";
import { canAct, refusalText } from "../projectAccess";
import { projectCollisions } from "../collisionView";
import { freeSessionName } from "../sessionNames";
import { entranceUrl, sessionUrlFrom } from "../pickerUrl";
import { linkOrigin } from "../inviteLink";
import { MachinesPanel } from "./MachinesPanel";
import { InvitePanel } from "./InvitePanel";
import { RECORD_CLOSED, RecordPanel, recordStep } from "./RecordPanel";
import type { RecordEvent, RecordState } from "./RecordPanel";

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

/** The redacted-entrance join flow (spec A5). A `watch_project` on a project
 *  you don't belong to is refused with `{type:"error", code:"not_a_member"}`
 *  rather than a `project` push — the hub never streams a non-member the
 *  session detail. `notMember` remembers that refusal so the screen offers
 *  JOIN instead of an error toast; `joining` remembers that JOIN was pressed so
 *  a later `projects` push showing membership can re-`watch_project` and load
 *  the now-unredacted project. */
export type MembershipState = { notMember: boolean; joining: boolean };

/** The lifecycle gate's non-member refusal, verbatim from the hub
 *  (`set_project_lifecycle`, hub.ts). Unlike `watch_project`'s refusal it is a
 *  PLAIN error with no `code: "not_a_member"` — but it means the same thing,
 *  so the handler below normalizes it into the membership flow: a member raced
 *  by a roster change sees the section disappear, never a red line. Kept as a
 *  named constant because the string is the protocol — the standalone server
 *  answers with the same one (plan §2.1). */
export const LIFECYCLE_MEMBER_REFUSAL = "join this project before changing it";

/** The standalone models handlers' non-member refusal, verbatim from the server
 *  (list/add/remove_model, plan §2.1 Task 5). Like `set_project_lifecycle`'s
 *  refusal it is a PLAIN error with no `code: "not_a_member"`, so the handler
 *  normalizes this string into the membership flow too: a spectator's on-mount
 *  `list_models` degrades quietly (the panel simply never appears), never as a
 *  red toast. Named because the string is the protocol. */
export const MODELS_MEMBER_REFUSAL = "join this project before managing models";

export const MEMBERSHIP_IDLE: MembershipState = { notMember: false, joining: false };

export type MembershipEvent =
  | { kind: "error"; code?: string }
  | { kind: "join" }
  | { kind: "projects"; projects: ProjectSummary[]; projectId: string; userId: string };

/** Pure transition for the join flow, tested in `SessionPicker.test.tsx`
 *  (effects never run under this repo's static render, so the socket handler's
 *  decisions live here where they can be asserted). `watch` tells the caller to
 *  re-send `watch_project`. The error toast itself stays a one-line inline
 *  guard in the handler, so the picker keeps its single, prominent `setError`
 *  path (asserted by `RecordPanel.test.tsx`); this reducer only records that
 *  the refusal happened, so the JOIN affordance can render. */
export function membershipStep(
  state: MembershipState,
  event: MembershipEvent,
): { state: MembershipState; watch: boolean } {
  switch (event.kind) {
    case "error":
      // The membership refusal raises the JOIN affordance; every other error
      // (and a codeless one from an old server) leaves membership untouched and
      // is toasted by the handler's own guard.
      if (event.code === "not_a_member") {
        return { state: { ...state, notMember: true }, watch: false };
      }
      return { state, watch: false };
    case "join":
      return { state: { ...state, joining: true }, watch: false };
    case "projects": {
      const project = event.projects.find((p) => p.id === event.projectId) ?? null;
      const member = project !== null && isProjectMember(project, event.userId);
      // Re-watch ONLY after a JOIN we sent: an unsolicited membership push must
      // not trigger a watch the user never asked for.
      if (state.joining && member) {
        return { state: { notMember: false, joining: false }, watch: true };
      }
      return { state, watch: false };
    }
  }
}

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
  const [recordState, setRecordState] = useState<RecordState>(RECORD_CLOSED);
  const [membership, setMembership] = useState<MembershipState>(MEMBERSHIP_IDLE);
  // The INVITE section's list. Filled by `invite_list`, which only ever
  // answers the requesting socket (it carries secret tokens — plan §2.2).
  const [invites, setInvites] = useState<InviteView[]>([]);
  // The MODELS section's roster. `null` until a `models_list` reply lands, which
  // is the whole gate for the panel: an old server never sends one (the message
  // is new — plan §2.1 wire back-compat), so the panel simply never renders
  // there. Filled fresh from every reply, so an add/remove repaints the list.
  const [models, setModels] = useState<ManagedModelEntry[] | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const createTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `recordState` for the socket handler, which is installed once per
  // effect run and would otherwise close over the state of the render that
  // installed it. Read through the ref, never through the closure.
  const recordRef = useRef<RecordState>(RECORD_CLOSED);
  // Same mirror discipline as `recordRef`: the socket handler is installed once
  // per effect run and would otherwise close over stale membership state. Every
  // transition writes the ref AND the state; the handler reads the ref.
  const membershipRef = useRef<MembershipState>(MEMBERSHIP_IDLE);

  const applyMembership = (step: { state: MembershipState }) => {
    membershipRef.current = step.state;
    setMembership(step.state);
  };

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

  // The RECORD panel's single seam (spec §5): every decision about opening,
  // fetching and refreshing lives in `recordStep` (tested there); this performs
  // what it returns.
  //
  // The readyState guard is not decoration: `send` on a still-CONNECTING socket
  // THROWS, and a click landing in the first frames after mount would take the
  // fetch down from inside an event handler. Skipping the send instead leaves
  // the panel open on its loading line, and the next `project` push — which by
  // definition arrives on a live socket, and refetches while open — heals it.
  const stepRecord = (event: RecordEvent) => {
    const step = recordStep(recordRef.current, event, props.projectId);
    recordRef.current = step.state;
    setRecordState(step.state);
    const socket = wsRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    for (const out of step.send) socket.send(JSON.stringify(out));
  };

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "identify", userId: props.userId, name: props.name }));
      ws.send(JSON.stringify({ type: "watch_project", projectId: props.projectId }));
      ws.send(JSON.stringify({ type: "list_projects" }));
      // Ask for the invite list up front. For a spectator this draws the same
      // not_a_member refusal watch_project does — which the membership flow
      // below turns into the JOIN affordance, so the INVITE section degrades
      // by disappearing, never by showing a red error (plan §1.8).
      ws.send(JSON.stringify({ type: "list_invites", projectId: props.projectId }));
      // Ask for the managed-model roster up front. A spectator's request draws
      // the plain member refusal, which the membership flow below normalizes
      // like the lifecycle gate's — so the MODELS section degrades by never
      // appearing, never by a red error (plan §2.1).
      ws.send(JSON.stringify({ type: "list_models", projectId: props.projectId }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "project") {
          setSessions(msg.sessions ?? []);
          setMachines(msg.machines ?? []);
        }
        if (msg.type === "projects") {
          const list: ProjectSummary[] = msg.projects ?? [];
          setProjects(list);
          // A JOIN we sent lands here as membership: re-watch so the hub streams
          // the project detail it redacted while we were a spectator (spec A5).
          const step = membershipStep(membershipRef.current, {
            kind: "projects",
            projects: list,
            projectId: props.projectId,
            userId: props.userId,
          });
          applyMembership(step);
          if (step.watch) {
            ws.send(JSON.stringify({ type: "watch_project", projectId: props.projectId }));
            // A fresh member's first list was refused above; ask again now
            // that membership (and with it the INVITE and MODELS sections) exists.
            ws.send(JSON.stringify({ type: "list_invites", projectId: props.projectId }));
            ws.send(JSON.stringify({ type: "list_models", projectId: props.projectId }));
          }
        }
        if (msg.type === "invite_list") {
          setInvites(msg.invites ?? []);
        }
        // The reply is also the panel's render gate: the first one flips the
        // section on, and every later one (after an add/remove) repaints it.
        if (msg.type === "models_list") {
          setModels(msg.models ?? []);
        }
        if (msg.type === "session_created") {
          clearCreateTimer();
          joinSession(msg.sessionId, props.projectId);
        }
        if (msg.type === "repo_attached" || msg.type === "repo_detached") {
          clearCreateTimer();
          setPending(false);
        }
        if (msg.type === "error") {
          // Normalize the lifecycle gate's UNCODED member refusal into the
          // coded one, so it degrades through the same quiet membership flow.
          const code: string | undefined =
            msg.code ??
            (msg.message === LIFECYCLE_MEMBER_REFUSAL ? "not_a_member" : undefined) ??
            (msg.message === MODELS_MEMBER_REFUSAL ? "not_a_member" : undefined);
          if (code !== "not_a_member") setError(msg.message);
          // A membership refusal shows the JOIN affordance below, NOT a toast
          // (spec A5); every other error surfaces on the one red line above.
          clearCreateTimer();
          setPending(false);
          applyMembership(membershipStep(membershipRef.current, { kind: "error", code }));
        }
        // Last, and unconditionally: the RECORD panel reacts to `record` and
        // `project` and ignores everything else, so it sees every message
        // without the handlers above having to know it exists.
        stepRecord({ kind: "message", msg });
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
  // The JOIN affordance shows for BOTH paths to non-membership: the entrance
  // list classifying us out (`refusal`), and a bare `watch_project` refusal
  // that arrived before/without that list (`membership.notMember`, spec A5).
  // The action panels below stay hidden in either case — a spectator acts on
  // nothing (spec §4.4), so an in-flight refusal must not flash CREATE.
  const spectating = refusal === "not-a-member" || membership.notMember;
  const actable = refusal === null && !membership.notMember;
  // The lifecycle section is member-gated, NOT `actable`-gated: on a closed or
  // archived project `canAct` answers "not-active" (work stops), and the
  // members who can no longer work are exactly the ones allowed to REOPEN or
  // UNARCHIVE. Gating on `actable` would strand a closed project forever.
  // Carries the project itself (null when not manageable) so the section below
  // renders narrowed, and stays hidden while the first projects frame loads.
  const manageable =
    project !== null && isProjectMember(project, props.userId) && !membership.notMember
      ? project
      : null;
  const online = machines.filter((m) => m.online);
  // Every reachable destination, standalone included: a solo server reports
  // itself as one real machine with a real repo list, so the old `repo.key`
  // special case it used to need is gone (spec §8).
  const choices = repoChoices(machines);
  const chosen = chooseRepo(choices, picked);

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
    // Remember the JOIN so the projects push that follows re-watches (spec A5).
    applyMembership(membershipStep(membershipRef.current, { kind: "join" }));
  };

  // The server re-answers the requesting socket with a fresh `invite_list`
  // after every mutation (plan §1.3), so neither sends a follow-up list.
  const createInvite = () => {
    wsRef.current?.send(JSON.stringify({ type: "create_invite", projectId: props.projectId }));
  };

  const revokeInvite = (inviteId: string) => {
    wsRef.current?.send(
      JSON.stringify({ type: "revoke_invite", projectId: props.projectId, inviteId }),
    );
  };

  // ADD/REMOVE from the MODELS panel. The server re-answers the requesting
  // socket with a fresh `models_list` on success (plan §2.1), so neither sends
  // a follow-up list — the reply repaints the roster. A refusal (a validation
  // skip string, or "cannot remove a built-in model") lands on the shared error
  // line the panel renders. Clearing `error` first drops any stale refusal.
  const addModel = (entry: AddModelEntry) => {
    setError(null);
    wsRef.current?.send(JSON.stringify({ type: "add_model", projectId: props.projectId, entry }));
  };

  const removeModel = (key: string) => {
    setError(null);
    wsRef.current?.send(JSON.stringify({ type: "remove_model", projectId: props.projectId, key }));
  };

  // Lifecycle transitions are answered by a fresh projects push that repaints
  // every screen (hub `pushProjects`), so the send needs no follow-up and no
  // pending state — and this screen's section re-reads the new lifecycle from
  // the same frame that fills the entrance list.
  const setLifecycle = (lifecycle: ProjectLifecycle) => {
    wsRef.current?.send(
      JSON.stringify({ type: "set_project_lifecycle", projectId: props.projectId, lifecycle }),
    );
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
        {spectating && (
          <div className="panel">
            <div className="line dim">{refusalText("not-a-member")}</div>
            <button className="btn" onClick={join}>JOIN PROJECT ▸</button>
          </div>
        )}
        <div className="panel">
          {sessions.length === 0 && (
            <div className="line dim">no sessions yet.</div>
          )}
          <SessionGroups
            sessions={sessions}
            machines={machines}
            canJoin={actable}
            projectId={props.projectId}
          />
        </div>
        {/* INVITE (plan §1.8) — the session-level invite screen is gone;
         *  invites are project-scoped and live here, on the project screen.
         *  Members only (`actable`): mint/list/revoke are member-gated on the
         *  wire, and a spectator's refusal lands in the membership flow above,
         *  which hides this section quietly. */}
        {actable && (
          <>
            <div className="panel pix top">INVITE</div>
            <InvitePanel
              projectId={props.projectId}
              projectName={project?.name ?? props.projectId}
              invites={invites}
              origin={linkOrigin()}
              onCreate={createInvite}
              onRevoke={revokeInvite}
            />
          </>
        )}
        {/* PROJECT (plan 2026-08-01-project-lifecycle-controls §1.1–§1.2) —
         *  close/reopen/archive live here, member-only. `key` remounts the
         *  panel on every lifecycle change so an armed SURE? never survives
         *  the transition it was armed for. A raced non-member refusal flows
         *  through the membership flow above, which nulls `manageable` — the
         *  section degrades by disappearing, never by showing a red error. */}
        {manageable !== null && (
          <>
            <div className="panel pix top">PROJECT</div>
            <LifecyclePanel
              key={manageable.lifecycle}
              lifecycle={manageable.lifecycle}
              onSet={setLifecycle}
            />
          </>
        )}
        {/* MODELS (model-agnostic plan §2.1, Task 7) — the per-machine model
         *  registry: add a local/openai-compatible backend, remove a non-builtin.
         *  Member-gated (`manageable`, same as PROJECT) AND reply-gated
         *  (`models !== null`): the panel renders only once a `models_list`
         *  arrives, so an old server that never sends one shows nothing, and a
         *  spectator — whose `list_models` was refused into the membership flow —
         *  sees no section either. Refusals surface on the picker's shared error
         *  line, which the panel renders. */}
        {manageable !== null && models !== null && (
          <>
            <div className="panel pix top">MODELS</div>
            <ModelsPanel models={models} error={error} onAdd={addModel} onRemove={removeModel} />
          </>
        )}
        {/* RECORD (spec §5) — collapsed by default: the record is a read a
         *  user asks for, not a wall of history the screen opens with. Outside
         *  the refusal gates on purpose: `get_record` requires identity, NOT
         *  membership (spec §4.3 / §8a.1), so a spectator reads the record on
         *  the same screen where they can act on nothing. The ▾/▸ glyph is
         *  text, and `aria-expanded` carries the same state programmatically —
         *  nothing here is announced by decoration alone. */}
        <div className="pix top">
          <button
            className="btn wide"
            aria-expanded={recordState.open}
            onClick={() => stepRecord({ kind: "toggle" })}
          >
            RECORD {recordState.open ? "▾" : "▸"}
          </button>
        </div>
        {recordState.open && (
          <RecordPanel record={recordState.record} machines={machines} />
        )}
        {actable && (
          <MachinesPanel
            machines={machines}
            onAttach={attach}
            onDetach={detach}
            pending={pending}
            error={error}
          />
        )}
        {actable && (
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
            <div className="line dim">
              {refusalText(refusal, {
                // The /uplink path is load-bearing: the hub routes uplinks by
                // URL path, and a bare origin lands on the browser arm where a
                // hello registers nothing — silently (proved live, 2026-07-31).
                hubUrl: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/uplink`,
                projectId: props.projectId,
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The §1.1 transition table — the WHOLE of it. From active: CLOSE, ARCHIVE.
 *  From closed: REOPEN, ARCHIVE. From archived: UNARCHIVE. Delete does not
 *  exist (spec :242), and there are no others to add: the hub takes free
 *  transitions, so the destructiveness flag below is a UI concern only —
 *  `arm` marks the two that take work away (CLOSE, ARCHIVE) for the two-step
 *  confirm; the restorative two send immediately. */
export type LifecycleTransition = { label: string; to: ProjectLifecycle; arm: boolean };

export const LIFECYCLE_TRANSITIONS: Record<ProjectLifecycle, LifecycleTransition[]> = {
  active: [
    { label: "CLOSE PROJECT", to: "closed", arm: true },
    { label: "ARCHIVE PROJECT", to: "archived", arm: true },
  ],
  closed: [
    { label: "REOPEN", to: "active", arm: false },
    { label: "ARCHIVE PROJECT", to: "archived", arm: true },
  ],
  archived: [{ label: "UNARCHIVE", to: "active", arm: false }],
};

/** The project screen's lifecycle section (plan §1.1–§1.2): the current state
 *  and the transitions out of it.
 *
 *  Props-only except for the one piece of state that is genuinely local —
 *  which destructive button is ARMED. Same no-DOM seam as `SessionGroups`: the
 *  picker sources `lifecycle` from its socket-fed projects frame and effects
 *  never run under this repo's static render, so the panel takes it as a prop
 *  and reports through `onSet`, leaving the wire send (and the refusal
 *  degrade) to the picker. `arm-and-confirm`: the first click on CLOSE/ARCHIVE
 *  only renames the button to SURE?; the second sends. Arming another button
 *  disarms the first — one armed slot, not one per button — and the picker
 *  remounts the panel (`key={lifecycle}`) on every transition so an armed
 *  SURE? never outlives the state it was armed in. */
export function LifecyclePanel(props: {
  lifecycle: ProjectLifecycle;
  onSet: (lifecycle: ProjectLifecycle) => void;
}) {
  const [armed, setArmed] = useState<ProjectLifecycle | null>(null);
  const click = (t: LifecycleTransition) => {
    if (!t.arm || armed === t.to) {
      // Immediate sends (REOPEN/UNARCHIVE restore, they don't destroy) and the
      // second click of an armed pair both land here — and both clear the slot,
      // so a sent transition never leaves a stale SURE? behind.
      setArmed(null);
      props.onSet(t.to);
      return;
    }
    setArmed(t.to);
  };
  return (
    <div className="panel">
      <div className="line">
        state:
        {/* Badge idiom of the entrance rows: CLOSED wears the red `closed`
         *  class because it interrupts work; ACTIVE and ARCHIVED stay neutral. */}
        <span className={`spstate pix sm${props.lifecycle === "closed" ? " closed" : ""}`}>
          {props.lifecycle.toUpperCase()}
        </span>
      </div>
      <div className="line dim">
        closing stops new sessions and new members; archiving hides the project from the
        entrance list. nothing is deleted — every transition can be walked back.
      </div>
      <div className="line">
        {LIFECYCLE_TRANSITIONS[props.lifecycle].map((t) => (
          <button key={t.to} className="btn" onClick={() => click(t)}>
            {armed === t.to ? "SURE?" : t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The add_model wire payload's `entry` (a server `ModelEntry` subset — the
 *  server derives the registry key from `id`, so no `key` here). Only the two
 *  routed providers are ever added from the UI; the four Claude built-ins are
 *  fixed and unremovable. `apiKeyEnv` is an env var NAME, never a secret
 *  (plan Global Constraints), and only openai-compatible carries one. */
export type AddModelEntry = {
  id: string;
  label: string;
  contextWindow: number;
  provider: "ollama" | "openai-compatible";
  baseUrl: string;
  providerModel: string;
  apiKeyEnv?: string;
};

/** Derive the registry id from a provider model string: lowercased, every `:`
 *  turned to `-` (e.g. `qwen3.6:27b` → `qwen3.6-27b`). The exact rule the server
 *  applies, mirrored so the id field can preview it before the round-trip and
 *  the client never guesses wrong about what will be registered. */
export const deriveModelId = (providerModel: string): string =>
  providerModel.toLowerCase().replace(/:/g, "-");

/** The project screen's MODELS section (model-agnostic plan §2.1 MANAGE view).
 *  Same seam as `LifecyclePanel`: props-only except for the genuinely local
 *  form + armed-remove state, so the picker owns the wire send (and the refusal
 *  degrade) while this owns the form. The ADD form validates client-side —
 *  base URL is required for BOTH routed providers, mirroring the server rule so
 *  an obviously-incomplete entry never costs a round-trip — and the id field
 *  previews the derived id until the user types over it. REMOVE is arm-and-
 *  confirm (SURE?), the `LifecyclePanel` idiom, and only non-builtin rows carry
 *  it: the four Claude defaults are marked `built-in` and cannot be removed. */
export function ModelsPanel(props: {
  models: ManagedModelEntry[];
  error: string | null;
  onAdd: (entry: AddModelEntry) => void;
  onRemove: (key: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<"ollama" | "openai-compatible">("ollama");
  const [baseUrl, setBaseUrl] = useState("");
  const [providerModel, setProviderModel] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  // `null` = the id field tracks the derivation; any string = a hand-typed
  // override that a later provider-model edit must NOT clobber.
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // One armed slot across the whole list (the LifecyclePanel discipline): the
  // key mid-confirm, or null. Arming a different row disarms the first.
  const [armed, setArmed] = useState<string | null>(null);

  const idValue = idOverride ?? deriveModelId(providerModel);

  const submit = () => {
    const cw = Number(contextWindow);
    if (!label.trim()) return setFormError("label is required");
    if (!providerModel.trim()) return setFormError("provider model is required");
    // Mirrors the server's routed-provider rule (both providers need a base
    // URL); the message names the selected provider so it reads true either way.
    if (!baseUrl.trim()) return setFormError(`base URL is required for ${provider}`);
    if (!Number.isInteger(cw) || cw <= 0) {
      return setFormError("context window must be a whole number greater than 0");
    }
    setFormError(null);
    props.onAdd({
      id: idValue.trim(),
      label: label.trim(),
      contextWindow: cw,
      provider,
      baseUrl: baseUrl.trim(),
      providerModel: providerModel.trim(),
      ...(provider === "openai-compatible" && apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
    });
  };

  const clickRemove = (key: string) => {
    if (armed === key) {
      setArmed(null);
      props.onRemove(key);
      return;
    }
    setArmed(key);
  };

  return (
    <div className="panel">
      {props.models.map((m) => (
        <div className="sprow" key={m.key}>
          <div className="spbody">
            <div className="spname">
              {m.label}
              {m.builtin && <span className="spstate pix sm">built-in</span>}
            </div>
            <div className="spwho pix sm">
              {[m.provider ?? "anthropic", m.providerModel ?? m.id, `${m.contextWindow} ctx`].join(
                "  ·  ",
              )}
            </div>
          </div>
          {/* Built-ins are fixed (plan §2.3) — no REMOVE, so the arm-and-confirm
           *  can only ever fire on a member-added routed entry. */}
          {!m.builtin && (
            <button className="btn" onClick={() => clickRemove(m.key)}>
              {armed === m.key ? "SURE?" : "REMOVE"}
            </button>
          )}
        </div>
      ))}
      <div className="spform">
        <input
          className="spinput"
          aria-label="label"
          placeholder="label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <span className="spinput" style={{ padding: 0 }}>
          <select
            aria-label="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as "ollama" | "openai-compatible")}
          >
            <option value="ollama">ollama</option>
            <option value="openai-compatible">openai-compatible</option>
          </select>
        </span>
        <input
          className="spinput"
          aria-label="provider model"
          placeholder="provider model"
          value={providerModel}
          onChange={(e) => setProviderModel(e.target.value)}
        />
        <input
          className="spinput"
          aria-label="model id"
          placeholder="id"
          value={idValue}
          onChange={(e) => setIdOverride(e.target.value)}
        />
        <input
          className="spinput"
          aria-label="base URL"
          placeholder="base URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <input
          className="spinput"
          aria-label="context window"
          type="number"
          placeholder="context window"
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
        />
        {provider === "openai-compatible" && (
          <input
            className="spinput"
            aria-label="api key env"
            placeholder="API key env name"
            value={apiKeyEnv}
            onChange={(e) => setApiKeyEnv(e.target.value)}
          />
        )}
        <button className="btn" onClick={submit}>ADD</button>
      </div>
      {/* Client-side validation (inline, no round-trip) and the server's own
       *  refusal share the panel's red line — one place a member looks after
       *  pressing ADD or REMOVE. */}
      {formError && <div className="line red">{formError}</div>}
      {props.error && <div className="line red">{props.error}</div>}
    </div>
  );
}

/** The session list itself: every session grouped under its repo.
 *
 *  Exported and props-only on purpose. `SessionPicker` fills `sessions` from a
 *  socket in `useEffect`, and this repo's render tests are STATIC
 *  (`react-dom/server`, no DOM environment — `docs/tech-debt.md`), so effects
 *  never run and the picker itself can only ever be rendered with an empty
 *  list in a test. Taking the snapshot as a prop is the seam that lets
 *  `SessionPicker.test.tsx` assert these rows against real fixtures. It is a
 *  seam, not a fake: the collisions below are still derived here, from the
 *  same snapshot the rows are drawn from, so no caller passes them in and
 *  `App.tsx` is untouched. */
export function SessionGroups(props: {
  sessions: ProjectSessionInfo[];
  machines: MachineInfo[];
  canJoin: boolean;
  projectId: string;
}) {
  // repoKey/machineId are stable identity, not something to show a human
  // (walk finding W4): every render site below looks a UUID up in one of
  // these two maps first. Built off `machines` (spec §8), so a repo's label
  // survives its own detach and a machine's name survives it going offline.
  const labels = repoLabels(props.machines);
  const machineNames = new Map(props.machines.map((m) => [m.machineId, m.name]));
  const groups = groupByRepo(sortSessions(props.sessions));
  const showRepoHeads = groups.length > 1;
  // Spec §5's two contested surfaces, both derived from THIS snapshot through
  // the one shared implementation (Task 9a) — the hub, the laptop and every
  // browser must name the same contested set, so nothing is recomputed here.
  const collisions = useMemo(() => projectCollisions(props.sessions), [props.sessions]);
  // Both surfaces' lookups, built in ONE pass over that list: the group chip's
  // per-repo path set (previously a `filter` per group) and the per-session
  // marker's count (previously a `contestedCountFor` rescan per ROW). The
  // derivations in `collisionView.ts` are untouched — this is the same answer
  // computed once per snapshot rather than once per group and once per row.
  const { pathsByRepo, countBySession } = useMemo(() => {
    const byRepo = new Map<string, Set<string>>();
    const bySession = new Map<string, number>();
    for (const collision of collisions) {
      let paths = byRepo.get(collision.repoKey);
      if (paths === undefined) {
        paths = new Set<string>();
        byRepo.set(collision.repoKey, paths);
      }
      paths.add(collision.path);
      // `collisionsFrom` emits one entry per (repo, path) and a session appears
      // at most once in an entry's `sessionIds`, so counting entries counts
      // DISTINCT paths — the claim `contestedCountFor`'s Set makes.
      for (const id of collision.sessionIds) {
        bySession.set(id, (bySession.get(id) ?? 0) + 1);
      }
    }
    return { pathsByRepo: byRepo, countBySession: bySession };
  }, [collisions]);

  return (
    <>
      {groups.map((group) => {
        // A COUNT of contended paths, never the paths themselves: the group
        // head is one line, and a repo with forty shared files would push the
        // list off the screen. `collisionsFrom` already emits one Collision per
        // (repo, path), so the Set behind this number is belt-and-braces — it
        // states the claim the number makes rather than trusting the upstream
        // shape to keep making it true.
        const contestedCount = pathsByRepo.get(group.repoKey)?.size ?? 0;
        return (
          <div key={group.repoKey || "unknown"}>
            {showRepoHeads && (
              <div className="line pix sm dim">
                {/* `group.repoKey` is a plain `string` (never null/undefined) that
                 *  `groupByRepo` sets to "" for a session with no repo key at all —
                 *  a distinct case from "a real key no machine currently offers"
                 *  (spec §8's raw-key fallback). A bare `labels.get(...) ?? group.repoKey
                 *  ?? "unknown repo"` would print blank, not "unknown repo", for the ""
                 *  case, since `??` does not treat "" as nullish. `||` on the terminal
                 *  fallback keeps that case reading "unknown repo" as it always has. */}
                {labels.get(group.repoKey) ?? (group.repoKey || "unknown repo")}
                {contestedCount > 0 && (
                  <span className="contested-calm">{`⚠ ${contestedCount} contested`}</span>
                )}
              </div>
            )}
            {group.sessions.map((s) => (
              <div className="sprow" key={s.id}>
                <div className="spbody">
                  <div className="spname">
                    {s.id}
                    <span className={`spstate pix sm ${sessionStateClass({ ...s, participantCount: s.participants.length }) || "live"}`}>
                      {sessionBadgeLabel({ ...s, participantCount: s.participants.length })}
                    </span>
                    {/* Beside the state badge and AFTER it, so a closed session
                     *  reads `CLOSED contested` — closing a session does not
                     *  release the files it changed (spec §2.6), and the marker
                     *  has to outlive the lifecycle badge to say so. The bare
                     *  word, with no count and no glyph: the ⚠ and the number
                     *  belong to the group chip above, which is where a reader
                     *  goes to ask how much. */}
                    {(countBySession.get(s.id) ?? 0) > 0 && (
                      <span className="contested-calm">contested</span>
                    )}
                  </div>
                  {s.intent && <div className="spintent dim">{s.intent}</div>}
                  <div className="spwho pix sm">
                    {[
                      labels.get(s.repoKey ?? "") ?? s.repoKey ?? "unknown repo",
                      machineNames.get(s.machineId ?? "") ?? s.machineId ?? "unknown machine",
                      s.participants.length > 0 ? s.participants.join(" · ") : "empty",
                    ].join("  ·  ")}
                  </div>
                </div>
                <button className="btn" onClick={() => joinSession(s.id, props.projectId)}>
                  {props.canJoin ? "JOIN ▸" : "WATCH ▸"}
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

function joinSession(sessionId: string, projectId: string): void {
  window.location.search = sessionUrlFrom(window.location.search, sessionId, projectId);
}