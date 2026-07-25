import { useMemo, useRef, useState } from "react";
import "./terminal.css";
import { deriveState } from "./derive";
import { hashIdentity, loadOrCreateUserId, loadProfile, saveProfile } from "./identity";
import type { Profile } from "./identity";
import { useSessionSocket } from "./useSessionSocket";
import { Header, MODEL_LABELS } from "./components/Header";
import { PromptBar } from "./components/PromptBar";
import { Transcript } from "./components/Transcript";
import { PartyPane } from "./components/PartyPane";
import { TodoPanel } from "./components/TodoPanel";
import { ThinkingStrip } from "./components/ThinkingStrip";
import { Lobby } from "./components/Lobby";
import { Cabinet, Crt } from "./components/Crt";

const LEGEND = ["PALETTE + GLYPHS FROM terminal.css", "?SCREEN=STATUS IS DESIGN-ONLY"];

export default function App() {
  const [userId] = useState(loadOrCreateUserId);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("session") ?? "demo";
  const projectId = params.get("project") ?? "default";

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

  return (
    <Cabinet legend={LEGEND}>
      <Crt>
        {profile === null ? (
          <Lobby
            projectId={projectId}
            sessionId={sessionId}
            defaultName={`user-${userId.slice(0, 4)}`}
            onEnter={(p) => {
              saveProfile(p);
              setProfile(p);
            }}
          />
        ) : (
          <SessionView userId={userId} sessionId={sessionId} projectId={projectId} profile={profile} />
        )}
      </Crt>
    </Cabinet>
  );
}

function SessionView(props: {
  userId: string;
  sessionId: string;
  projectId: string;
  profile: Profile;
}) {
  const { userId, sessionId, projectId, profile } = props;

  const { events, errors, connected, projectSessions, send } = useSessionSocket({
    sessionId,
    projectId,
    userId,
    profile,
  });

  const derived = useMemo(() => deriveState(events), [events]);

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

  const isDriver = derived.driverId === userId;
  const canSetModel = isDriver && !derived.agentBusy;
  const planMode = derived.permissionMode === "plan";
  const canTogglePlan = isDriver && !derived.agentBusy;

  const watcherNames = [...derived.participants.entries()]
    .filter(([id]) => id !== derived.driverId && id !== userId)
    .map(([, p]) => p.name);

  const inputRef = useRef<HTMLInputElement | null>(null);

  function onPrompt(text: string) {
    send({ type: "prompt", text });
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

  function onTogglePlan() {
    send({ type: "set_permission_mode", mode: planMode ? "default" : "plan" });
  }

  function onDecidePlan(requestId: string, decision: "approve" | "reject") {
    send({ type: "decide_plan", requestId, decision });
  }

  return (
    <div className="term">
      <Header
        projectId={projectId}
        sessionId={sessionId}
        model={derived.model}
        connected={connected}
        objective={derived.objective}
        canSetModel={canSetModel}
        onSetModel={onSetModel}
        planMode={planMode}
        canTogglePlan={canTogglePlan}
        onTogglePlan={onTogglePlan}
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
        />

        <PartyPane
          projectId={projectId}
          sessionId={sessionId}
          sessions={projectSessions}
          participants={derived.participants}
          driverId={derived.driverId}
          selfId={userId}
        />
        <TodoPanel todos={derived.todos} />
      </div>

      <ThinkingStrip busy={derived.agentBusy} modelLabel={MODEL_LABELS[derived.model] ?? derived.model} />

      {errors.length > 0 && <div className="line red">⚠ {errors.at(-1)}</div>}

      <PromptBar
        isDriver={isDriver}
        agentBusy={derived.agentBusy}
        watcherNames={watcherNames}
        skills={derived.skills}
        gatesPending={gatesPending}
        onPrompt={onPrompt}
        onTakeWheel={onTakeWheel}
        onSuggestSkill={onSuggestSkill}
        inputRef={inputRef}
      />
    </div>
  );
}
