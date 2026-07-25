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
import { ThinkingStrip } from "./components/ThinkingStrip";
import { Lobby } from "./components/Lobby";
import { Cabinet, Crt } from "./components/Crt";
import { AgentStatus } from "./components/AgentStatus";
import { SkillsPanel } from "./components/SkillsPanel";

/**
 * REFERENCE FILE — merge by hand into App.tsx.
 *
 * Only three things changed from v4:
 *   1. everything is wrapped in <Cabinet><Crt> (the marquee + the glass).
 *   2. `?screen=skills|status` routes to the two design-only screens, so they
 *      are reachable in the live demo without adding nav that implies they work.
 *   3. the Header HUD gets turn/tool counts derived from the event log here —
 *      no server change, no derive.ts change.
 *
 * The lobby gate, profile precedence and socket wiring are untouched.
 */
export default function App() {
  const [userId] = useState(loadOrCreateUserId);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("session") ?? "demo";
  const projectId = params.get("project") ?? "default";
  const screen = params.get("screen");

  const [profile, setProfile] = useState<Profile | null>(() => {
    const nameParam = params.get("name");
    if (nameParam) {
      return { name: nameParam.slice(0, 40), ...hashIdentity(loadOrCreateUserId()) };
    }
    return loadProfile();
  });

  const legend = ["PALETTE + GLYPHS FROM terminal.css", "SKILLS/STATUS SCREENS ARE DESIGN-ONLY"];

  if (screen === "skills" || screen === "status") {
    return (
      <Cabinet legend={legend}>
        <Crt>{screen === "skills" ? <SkillsPanel /> : <AgentStatus />}</Crt>
      </Cabinet>
    );
  }

  if (profile === null) {
    return (
      <Cabinet legend={legend}>
        <Crt>
          <Lobby
            projectId={projectId}
            sessionId={sessionId}
            defaultName={`user-${userId.slice(0, 4)}`}
            onEnter={(p) => {
              saveProfile(p);
              setProfile(p);
            }}
          />
        </Crt>
      </Cabinet>
    );
  }

  return (
    <Cabinet legend={legend}>
      <Crt>
        <SessionView userId={userId} sessionId={sessionId} projectId={projectId} profile={profile} />
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
  const isDriver = derived.driverId === userId;
  const canSetModel = isDriver && !derived.agentBusy;

  // HUD numbers that need no server change: count them off the log.
  const hud = useMemo(() => {
    const turn = events.filter((e) => e.type === "turn_end").length + 1;
    const toolsUsed = events.filter((e) => e.type === "tool_call").length;
    const gated = events.filter((e) => e.type === "permission_request").length;
    return { turn, toolsUsed, gated };
  }, [events]);

  const gatesPending = useMemo(
    () =>
      events.filter(
        (e) => e.type === "permission_request" && e.requestId && !derived.permissionDecisions.has(e.requestId),
      ).length,
    [events, derived.permissionDecisions],
  );

  const watcherNames = [...derived.participants.entries()]
    .filter(([id]) => id !== derived.driverId && id !== userId)
    .map(([, p]) => p.name);

  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="term">
      <Header
        projectId={projectId}
        sessionId={sessionId}
        model={derived.model}
        connected={connected}
        objective={derived.objective}
        canSetModel={canSetModel}
        onSetModel={(key) => send({ type: "set_model", model: key })}
        hud={hud}
      />

      <div className="row">
        <Transcript
          events={events}
          derived={derived}
          isDriver={isDriver}
          selfId={userId}
          onPermission={(requestId, decision) => send({ type: "permission", requestId, decision })}
        />

        <PartyPane
          projectId={projectId}
          sessionId={sessionId}
          sessions={projectSessions}
          participants={derived.participants}
          driverId={derived.driverId}
          selfId={userId}
        />
      </div>

      <ThinkingStrip
        busy={derived.agentBusy}
        modelLabel={MODEL_LABELS[derived.model] ?? derived.model}
      />

      {errors.length > 0 && <div className="line red">⚠ {errors.at(-1)}</div>}

      <PromptBar
        isDriver={isDriver}
        agentBusy={derived.agentBusy}
        watcherNames={watcherNames}
        onPrompt={(text) => send({ type: "prompt", text })}
        onTakeWheel={() => send({ type: "take_wheel" })}
        inputRef={inputRef}
        gatesPending={gatesPending}
      />
    </div>
  );
}
