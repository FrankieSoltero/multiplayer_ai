import { useEffect, useMemo, useRef, useState } from "react";
import "./terminal.css";
import { deriveState, deriveTranscriptGroups } from "./derive";
import { nextMode } from "./modes";
import { hashIdentity, loadOrCreateUserId, loadProfile, saveProfile } from "./identity";
import type { Profile } from "./identity";
import { useSessionSocket } from "./useSessionSocket";
import { Header, MODEL_LABELS } from "./components/Header";
import { PromptBar } from "./components/PromptBar";
import { Transcript } from "./components/Transcript";
import { PartyPane } from "./components/PartyPane";
import { TodoPanel } from "./components/TodoPanel";
import { ThinkingStrip } from "./components/ThinkingStrip";
import type { PartyBest } from "./components/ThinkingStrip";
import { Lobby } from "./components/Lobby";
import { SessionPicker } from "./components/SessionPicker";
import { useArrowNav } from "./useArrowNav";
import { Cabinet, Crt } from "./components/Crt";
import { SkillsPanel } from "./components/SkillsPanel";
import { WorkflowsPanel } from "./components/WorkflowsPanel";
import { OversightPanel } from "./components/OversightPanel";
import { InvitePanel } from "./components/InvitePanel";
import { AgentStatus } from "./components/AgentStatus";
import { oversightFresh } from "./oversightView";
import { InviteLanding } from "./components/InviteLanding";
import { inviteTokenFrom } from "./inviteLink";
import { Landing } from "./components/Landing";
import { InviteSignIn } from "./components/InviteSignIn";
import { Denied } from "./components/Denied";
import { authStateFrom, type AuthState } from "./authState";
import { ExitConfirm } from "./components/ExitConfirm";
import { pickerUrlFrom } from "./pickerUrl";
import { pullsFrom, thresholdFromStorage, PULL_STORAGE_KEY } from "./pulls";
import { screenFor, selfIdFor } from "./authRoute";

const LEGEND = ["PALETTE + GLYPHS FROM terminal.css", "?SCREEN=STATUS IS DESIGN-ONLY"];

export default function App() {
  // The per-tab anonymous id. With auth on it is NOT the identity the wire
  // uses — see selfId below.
  const [localUserId] = useState(loadOrCreateUserId);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  // No param → session picker (spec §4). Deep links keep exact old behavior.
  const sessionId = params.get("session");
  const projectId = params.get("project") ?? "default";
  // v6a: screen is state seeded by ?screen= — deep links keep working, but
  // SKILLS is reachable in-app without a reload. ?screen=status stays a
  // URL-only design surface (no nav points at it).
  const [screen, setScreen] = useState<string | null>(() => params.get("screen"));

  // An invite link carries only the token; the landing screen resolves it to a
  // project/session and hands them back here (spec §5).
  const inviteToken = useMemo(() => inviteTokenFrom(window.location.search), []);
  const [inviteTarget, setInviteTarget] = useState<{ projectId: string; sessionId: string } | null>(null);

  // null = probe in flight. Anything unexpected degrades to anonymous, so a
  // failed probe never locks the app out (authState.ts).
  const [auth, setAuth] = useState<AuthState | null>(null);
  useEffect(() => {
    let live = true;
    // Bounded: `auth === null` gates EVERY screen, including the anonymous
    // one, so a request that hangs (a wedged proxy, a half-open socket) would
    // otherwise park the app on "CHECKING SESSION…" forever with no way out.
    // A timeout lands in the same .catch as any other failure and degrades to
    // anonymous, which is the pre-auth behaviour.
    fetch("/auth/me", { credentials: "include", signal: AbortSignal.timeout(5000) })
      .then(async (res) => authStateFrom(res.status, await res.json().catch(() => null)))
      .catch(() => ({ status: "anonymous" }) as AuthState)
      .then((state) => { if (live) setAuth(state); });
    return () => { live = false; };
  }, []);

  // The identity this client is known by on the wire. With auth on the server
  // replaces the asserted userId with the verified GitHub login, so every
  // comparison against a server-authored event (isDriver, "YOU" in the party
  // pane, self-filtering in the watcher list) must use the login too.
  const selfId = selfIdFor(auth, localUserId);

  // Profile precedence: `?name=` URL param auto-derives a profile (glyph/color
  // hashed from userId) and skips the lobby entirely — demo scripts depend on
  // this. Otherwise fall back to a previously saved profile. If neither is
  // present, profile stays null and the gate below renders the Lobby so the
  // user can pick a name/glyph/color before the session socket connects.
  const [profile, setProfile] = useState<Profile | null>(() => {
    const nameParam = params.get("name");
    if (nameParam) {
      return { name: nameParam.slice(0, 40), ...hashIdentity(loadOrCreateUserId()) };
    }
    return loadProfile();
  });

  // A verified login always wins over a previously saved profile name. The
  // correction is PERSISTED: without saveProfile it re-ran on every load, and
  // since profile.name sits in useSessionSocket's dep array that cost one
  // aborted WebSocket connection per load.
  useEffect(() => {
    if (auth?.status !== "signed-in") return;
    if (!profile || profile.name === auth.login) return;
    const corrected = { ...profile, name: auth.login };
    saveProfile(corrected);
    setProfile(corrected);
  }, [auth, profile]);

  const activeSessionId = inviteTarget?.sessionId ?? sessionId;
  const activeProjectId = inviteTarget?.projectId ?? projectId;

  // The precedence itself lives in authRoute.ts so it can be tested (spec
  // §3.5); this switch only maps the decision onto a component.
  const route = screenFor({ auth, inviteToken, inviteTarget, activeSessionId, profile });

  function screenBody() {
    switch (route) {
      case "checking":
        return <div className="authscreen"><div className="authsub">CHECKING SESSION…</div></div>;
      case "invite-signin":
        return <InviteSignIn token={inviteToken!} />;
      case "landing":
        return <Landing />;
      case "denied":
        // The ternary is narrowing, not a fallback: screenFor returns "denied"
        // only for a denied AuthState, so the empty branch is unreachable.
        return <Denied login={auth?.status === "denied" ? auth.login : ""} />;
      case "invite-landing":
        return <InviteLanding token={inviteToken!} onAccept={setInviteTarget} />;
      case "picker":
        return <SessionPicker projectId={activeProjectId} />;
      case "lobby":
        // `!`: screenFor only returns lobby/session once a session id exists.
        return (
          <Lobby
            projectId={activeProjectId}
            sessionId={activeSessionId!}
            defaultName={auth?.status === "signed-in" ? auth.login : `user-${localUserId.slice(0, 4)}`}
            lockedName={auth?.status === "signed-in" ? auth.login : undefined}
            onEnter={(p) => {
              saveProfile(p);
              setProfile(p);
            }}
          />
        );
      case "session":
        return (
          <SessionView
            userId={selfId}
            sessionId={activeSessionId!}
            projectId={activeProjectId}
            profile={profile!}
            screen={screen}
            onScreenChange={setScreen}
            invite={inviteToken ?? undefined}
            signedInAs={auth?.status === "signed-in" ? auth.login : null}
          />
        );
    }
  }

  return (
    <Cabinet legend={LEGEND}>
      <Crt>{screenBody()}</Crt>
    </Cabinet>
  );
}

function SessionView(props: {
  userId: string;
  sessionId: string;
  projectId: string;
  profile: Profile;
  screen: string | null;
  onScreenChange: (screen: string | null) => void;
  invite?: string;
  /** Verified GitHub login, or null when auth is off. Passed explicitly rather
   *  than derived from `userId`: with auth off `userId` is the anonymous
   *  per-tab UUID, which must never be offered as something to sign out of. */
  signedInAs: string | null;
}) {
  const { userId, sessionId, projectId, profile } = props;

  const { events, errors, connected, projectSessions, arcade, plugins, pluginsEnabled, oversight, invites, send } = useSessionSocket({
    sessionId,
    projectId,
    userId,
    profile,
    invite: props.invite,
  });

  const derived = useMemo(() => deriveState(events), [events]);

  const [pullThresholdMs, setPullThresholdMs] = useState<number | null>(() =>
    thresholdFromStorage(localStorage.getItem(PULL_STORAGE_KEY)),
  );

  // Crossing the threshold is an event only this clock can see: while a gate
  // sits pending no events fire, so no fresh snapshot arrives and nothing
  // re-renders. Without this tick a pull would surface only by coincidence,
  // when unrelated activity happened to push a new snapshot.
  const [pullTick, setPullTick] = useState(0);
  useEffect(() => {
    if (pullThresholdMs === null) return;
    const id = setInterval(() => setPullTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [pullThresholdMs]);

  const pulls = useMemo(
    () =>
      pullsFrom(projectSessions, {
        thresholdMs: pullThresholdMs,
        currentSessionId: sessionId,
        now: Date.now(),
      }),
    // pullTick is a deliberate dependency: it is the only thing that changes
    // when time passes and nothing else does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectSessions, pullThresholdMs, sessionId, pullTick],
  );

  const setPullThreshold = (ms: number | null) => {
    setPullThresholdMs(ms);
    if (ms === null) localStorage.removeItem(PULL_STORAGE_KEY);
    else localStorage.setItem(PULL_STORAGE_KEY, String(ms));
  };

  // HUD numbers that need no server change: counted off the event log (spec §1).
  const hud = useMemo(
    () => ({
      turn: events.filter((e) => e.type === "turn_end").length + 1,
      toolsUsed: events.filter((e) => e.type === "tool_call").length,
      gated: events.filter((e) => e.type === "permission_request").length,
    }),
    [events],
  );

  const gatesPending = useMemo(
    () =>
      events.filter(
        (e) => e.type === "permission_request" && e.requestId && !derived.permissionDecisions.has(e.requestId),
      ).length,
    [events, derived.permissionDecisions],
  );

  const runningTasks = useMemo(
    () => [...derived.tasks.values()].filter((t) => t.status === "running").length,
    [derived.tasks],
  );

  const isDriver = derived.driverId === userId;
  const canSetModel = isDriver && !derived.agentBusy;
  const permissionMode = derived.permissionMode;
  // v6a: driver can cycle anytime, including mid-turn (rescues gate-stuck turns)
  const canCycleMode = isDriver;

  const watcherNames = [...derived.participants.entries()]
    .filter(([id]) => id !== derived.driverId && id !== userId)
    .map(([, p]) => p.name);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const [arcadeOpen, setArcadeOpen] = useState(false);
  // v5b final-review: whether a live arcade run currently has the keyboard
  // captured (game letters overlap a/d permission hotkeys).
  const [arcadeCapturing, setArcadeCapturing] = useState(false);

  const [exitReason, setExitReason] = useState<string | null>(null);

  // Arrows move focus around the whole terminal whenever the prompt is empty;
  // a live arcade run steers with arrows, so it takes them back for itself.
  useArrowNav(!arcadeCapturing);

  const [seenOversightSeq, setSeenOversightSeq] = useState(0);
  useEffect(() => {
    if (props.screen === "oversight" && oversight.latest) {
      setSeenOversightSeq(oversight.latest.seq);
    }
  }, [props.screen, oversight.latest]);

  // "A" opens the idle arcade; while busy the strip is already mounted and
  // letters belong to the games, so the hotkey only fires when closed + idle.
  // Also require no pending permission gates, so "a" never both opens the
  // arcade and answers a (possibly dead) permission request.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (
        (e.key === "a" || e.key === "A") &&
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        !arcadeOpen && !derived.agentBusy && gatesPending === 0 && props.screen === null
      ) {
        e.preventDefault();
        setArcadeOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [arcadeOpen, derived.agentBusy, gatesPending, props.screen]);

  // "M" cycles the permission mode (driver only, works even while the agent
  // is busy — that's the point: flipping to AUTO rescues a gate-stuck turn).
  // Same keyboard etiquette as "A": never while typing, never while an
  // arcade run has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "m" || e.key === "M") && isDriver && !arcadeCapturing && props.screen === null) {
        e.preventDefault();
        send({ type: "set_permission_mode", mode: nextMode(permissionMode) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDriver, arcadeCapturing, permissionMode, send, props.screen]);

  // "S" toggles the skills screen; "W" toggles the workflows screen; "O" toggles the oversight screen;
  // "I" toggles the invite screen; Esc always returns to the session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "s" || e.key === "S") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "skills" ? null : "skills");
      }
      if ((e.key === "w" || e.key === "W") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "workflows" ? null : "workflows");
      }
      if ((e.key === "o" || e.key === "O") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "oversight" ? null : "oversight");
      }
      if ((e.key === "i" || e.key === "I") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "invite" ? null : "invite");
      }
      if (
        e.key === "Escape" &&
        (props.screen === "skills" || props.screen === "workflows" || props.screen === "oversight" || props.screen === "invite")
      ) {
        props.onScreenChange(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.screen, props.onScreenChange, arcadeCapturing]);

  // the invite panel needs a fresh list as soon as it opens.
  useEffect(() => {
    if (props.screen === "invite") send({ type: "list_invites" });
  }, [props.screen, send]);

  // per-game party records; glyph/color fall back to hashIdentity like derive.ts
  const partyBests = useMemo(() => {
    const out: Record<string, PartyBest> = {};
    for (const r of arcade) {
      const fallback = hashIdentity(r.userId);
      out[r.game] = {
        name: r.name,
        glyph: r.glyph ?? fallback.glyph,
        color: r.color ?? fallback.color,
        score: r.score,
        game: r.game,
      };
    }
    return out;
  }, [arcade]);

  function onPrompt(text: string) {
    send({ type: "prompt", text });
  }

  /** Leaving strands something only in two cases: the agent is mid-run, or a
   *  gate is waiting and you are the one who can answer it. Everything else
   *  leaves silently — nothing is destroyed by leaving and you can rejoin. */
  function exitWouldStrand(): string | null {
    if (derived.agentBusy) return "the agent is still working";
    if (gatesPending > 0 && isDriver) return "a permission gate is waiting on you";
    return null;
  }

  function leaveNow() {
    // Send BEFORE navigating: the reload closes the socket and any unsent
    // frame is lost. This message is what tells the server the departure was
    // deliberate, which is what lets it auto-close a session the last person
    // left — a socket close deliberately never does that.
    send({ type: "leave_session" });
    window.location.search = pickerUrlFrom(window.location.search);
  }

  function onExit() {
    const reason = exitWouldStrand();
    if (reason) {
      setExitReason(reason);
      return;
    }
    leaveNow();
  }

  function onTakeWheel() {
    send({ type: "take_wheel" });
  }

  function onSetModel(key: string) {
    send({ type: "set_model", model: key });
  }

  function sendPermission(requestId: string, decision: "allow" | "deny") {
    send({ type: "permission", requestId, decision });
  }

  function onSuggestSkill(skill: string, args: string) {
    send({ type: "suggest_skill", skill, args });
  }

  function onDecideSkill(suggestId: string, decision: "run" | "dismiss") {
    send({ type: "decide_skill", suggestId, decision });
  }

  function onCycleMode() {
    send({ type: "set_permission_mode", mode: nextMode(permissionMode) });
  }

  function onDecidePlan(requestId: string, decision: "approve" | "reject") {
    send({ type: "decide_plan", requestId, decision });
  }

  // last tool_call of the in-flight turn — derivable, no server change
  let currentTool: string | undefined;
  if (derived.agentBusy) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "turn_end") break;
      if (e.type === "tool_call") { currentTool = e.toolName; break; }
    }
  }

  if (props.screen === "skills") {
    const subruns = deriveTranscriptGroups(events)
      .filter((g) => g.kind === "subagent")
      .map((g) => ({ label: g.label, status: g.status, rows: g.events.length }));
    return (
      <SkillsPanel
        sessions={projectSessions}
        sessionId={sessionId}
        roster={derived.skills}
        subruns={subruns}
        plugins={plugins}
        pluginsEnabled={pluginsEnabled}
        errors={errors}
        onAddPlugin={(url) => send({ type: "add_plugin", url })}
        onRemovePlugin={(name) => send({ type: "remove_plugin", name })}
        onBack={() => props.onScreenChange(null)}
      />
    );
  }
  if (props.screen === "workflows") {
    return (
      <WorkflowsPanel
        tasks={derived.tasks}
        participants={derived.participants}
        isDriver={isDriver}
        onStopTask={(taskId) => send({ type: "stop_task", taskId })}
        onBack={() => props.onScreenChange(null)}
      />
    );
  }
  if (props.screen === "oversight") {
    return (
      <OversightPanel
        oversight={oversight}
        isDriver={isDriver}
        onToggle={(enabled) => send({ type: "set_oversight", projectId, enabled })}
        onPull={() => send({ type: "pull_oversight" })}
        onBack={() => props.onScreenChange(null)}
      />
    );
  }
  if (props.screen === "invite") {
    return (
      <InvitePanel
        invites={invites}
        onCreate={() => send({ type: "create_invite" })}
        onRevoke={(id) => send({ type: "revoke_invite", inviteId: id })}
        onBack={() => props.onScreenChange(null)}
      />
    );
  }
  if (props.screen === "status") {
    return <AgentStatus model={derived.model} canSetModel={canSetModel} onSetModel={onSetModel} rosterCount={derived.skills.length} />;
  }

  return (
    <div className="term">
      <Header
        signedInAs={props.signedInAs}
        pulls={pulls.length}
        projectId={projectId}
        sessionId={sessionId}
        model={derived.model}
        connected={connected}
        objective={derived.objective}
        canSetModel={canSetModel}
        onSetModel={onSetModel}
        permissionMode={permissionMode}
        canCycleMode={canCycleMode}
        onCycleMode={onCycleMode}
        arcadeOpen={arcadeOpen}
        canToggleArcade={!derived.agentBusy}
        onToggleArcade={() => setArcadeOpen((v) => !v)}
        onOpenSkills={() => props.onScreenChange("skills")}
        onOpenWorkflows={() => props.onScreenChange("workflows")}
        onOpenOversight={() => props.onScreenChange("oversight")}
        oversightFresh={oversightFresh(oversight, seenOversightSeq)}
        onOpenInvite={() => props.onScreenChange("invite")}
        onExit={onExit}
        runningTasks={runningTasks}
        hud={hud}
      />

      <div className="row">
        <Transcript
          events={events}
          derived={derived}
          isDriver={isDriver}
          selfId={userId}
          onPermission={sendPermission}
          onDecideSkill={onDecideSkill}
          onDecidePlan={onDecidePlan}
          hotkeysMuted={arcadeCapturing}
        />

        <PartyPane
          projectId={projectId}
          sessionId={sessionId}
          sessions={projectSessions}
          participants={derived.participants}
          driverId={derived.driverId}
          selfId={userId}
          pulls={pulls}
          pullThresholdMs={pullThresholdMs}
          onPullThresholdChange={setPullThreshold}
        />
        <TodoPanel todos={derived.todos} />
      </div>

      <ThinkingStrip
        busy={derived.agentBusy}
        open={arcadeOpen}
        onClose={() => setArcadeOpen(false)}
        modelLabel={MODEL_LABELS[derived.model] ?? derived.model}
        currentTool={currentTool}
        partyBests={partyBests}
        onScore={(game, score) => send({ type: "game_score", game, score })}
        onPlayingChange={setArcadeCapturing}
      />

      {errors.length > 0 && <div className="line red">⚠ {errors.at(-1)}</div>}

      {exitReason && (
        <ExitConfirm
          reason={exitReason}
          onConfirm={leaveNow}
          onCancel={() => setExitReason(null)}
        />
      )}

      <PromptBar
        isDriver={isDriver}
        agentBusy={derived.agentBusy}
        watcherNames={watcherNames}
        skills={derived.skills}
        gatesPending={gatesPending}
        onPrompt={onPrompt}
        onTakeWheel={onTakeWheel}
        onSuggestSkill={onSuggestSkill}
        onClientCommand={(command) => {
          if (command.type === "exit") onExit();
        }}
        inputRef={inputRef}
      />
    </div>
  );
}
