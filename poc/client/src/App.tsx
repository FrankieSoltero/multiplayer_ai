import { useMemo, useRef, useState } from "react";
import "./terminal.css";
import { deriveState } from "./derive";
import { hashIdentity, loadOrCreateUserId, loadProfile } from "./identity";
import type { Profile } from "./identity";
import { useSessionSocket } from "./useSessionSocket";
import { Header } from "./components/Header";
import { PromptBar } from "./components/PromptBar";
import { Transcript } from "./components/Transcript";

export default function App() {
  const [userId] = useState(loadOrCreateUserId);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("session") ?? "demo";
  const projectId = params.get("project") ?? "default";

  // Profile fallback for this task: existing saved profile, else `?name=`
  // param or an auto `user-xxxx` name with a hashIdentity-derived glyph and
  // color. The lobby that lets a user actually pick these arrives in Task 10.
  const [profile] = useState<Profile>(() => {
    const existing = loadProfile();
    if (existing) return existing;
    const fallback = hashIdentity(userId);
    return {
      name: params.get("name") ?? `user-${userId.slice(0, 4)}`,
      glyph: fallback.glyph,
      color: fallback.color,
    };
  });

  const { events, errors, connected, projectSessions, send } = useSessionSocket({
    sessionId,
    projectId,
    userId,
    profile,
  });

  const derived = useMemo(() => deriveState(events), [events]);
  const isDriver = derived.driverId === userId;
  const canSetModel = isDriver && !derived.agentBusy;

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
      />

      <div className="split">
        <Transcript
          events={events}
          derived={derived}
          isDriver={isDriver}
          selfId={userId}
          onPermission={sendPermission}
        />

        <aside className="party term-frame">
          <div className="line dim">project: {projectId}</div>
          {projectSessions
            .filter((s) => s.id !== sessionId)
            .map((s) => (
              <a key={s.id} className="line" href={`?project=${projectId}&session=${s.id}`}>
                <div>
                  {s.id} {s.ended ? "(ended)" : ""}
                </div>
                <div className="dim">{s.intent ?? "no declared intent yet"}</div>
                <div className="dim">
                  {s.participants.join(", ") || "empty"}
                  {s.driverName ? ` · 🛞 ${s.driverName}` : ""}
                  {s.lastActivityTs
                    ? ` · ${new Date(s.lastActivityTs).toLocaleTimeString()}`
                    : ""}
                </div>
              </a>
            ))}
          {projectSessions.filter((s) => s.id !== sessionId).length === 0 && (
            <div className="line dim">no other sessions yet</div>
          )}
        </aside>
      </div>

      {errors.length > 0 && <div className="line red">⚠ {errors.at(-1)}</div>}

      <PromptBar
        isDriver={isDriver}
        agentBusy={derived.agentBusy}
        watcherNames={watcherNames}
        onPrompt={onPrompt}
        onTakeWheel={onTakeWheel}
        inputRef={inputRef}
      />
    </div>
  );
}
