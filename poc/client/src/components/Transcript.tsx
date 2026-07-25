import { useEffect, useRef } from "react";
import { deriveTranscriptGroups, type DerivedState } from "../derive";
import type { LoggedEvent } from "../types";

const isFresh = (ev: LoggedEvent) => Date.now() - new Date(ev.ts).getTime() < 5000;

export function Transcript(props: {
  events: LoggedEvent[]; derived: DerivedState; isDriver: boolean;
  selfId: string;
  onPermission: (requestId: string, decision: "allow" | "deny") => void;
  onDecideSkill: (suggestId: string, decision: "run" | "dismiss") => void;
  onDecidePlan: (requestId: string, decision: "approve" | "reject") => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.events]);
  const { participants, permissionDecisions, lastIntentSeq, suggestDecisions, planDecisions } = props.derived;
  const nameOf = (id?: string) => (id && participants.get(id)?.name) ?? id ?? "?";
  const colorOf = (id?: string) => (id && participants.get(id)?.color) ?? "var(--fg)";

  // a/d keyboard shortcuts for the newest undecided permission (driver only)
  const pending = props.events.filter(
    (e) => e.type === "permission_request" && e.requestId && !permissionDecisions.has(e.requestId),
  );
  const newest = pending.at(-1);
  useEffect(() => {
    if (!props.isDriver || !newest?.requestId) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "a") props.onPermission(newest.requestId!, "allow");
      if (e.key === "d") props.onPermission(newest.requestId!, "deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, newest?.requestId]);

  const renderEvent = (ev: LoggedEvent) => {
    switch (ev.type) {
      case "user_message":
        return (
          <div key={ev.seq} className="line">
            <span className="who" style={{ color: colorOf(ev.userId) }}>
              &gt; {nameOf(ev.userId)}:
            </span>{" "}
            {ev.text}
          </div>
        );
      case "agent_text_delta":
        return <div key={ev.seq} className="line">⏺ {ev.text}</div>;
      case "tool_call": {
        const input = ev.input as { skill?: unknown; args?: unknown } | undefined;
        if (ev.toolName === "Skill") {
          return (
            <div key={ev.seq} className="skillcard">
              <span className="skillname">⚡ {typeof input?.skill === "string" ? input.skill : "skill"}</span>
              {typeof input?.args === "string" && input.args && <span className="dim"> {input.args.slice(0, 120)}</span>}
            </div>
          );
        }
        return (
          <div key={ev.seq} className="line dim">
            ⏺ {ev.toolName}({JSON.stringify(ev.input)?.slice(0, 200)})
          </div>
        );
      }
      case "tool_result":
        return (
          <div key={ev.seq} className="line dim">
            {"  ⎿ "}{ev.output?.slice(0, 300)}
          </div>
        );
      case "control_change":
        return (
          <div key={ev.seq} className={isFresh(ev) ? "line wheel fresh" : "line wheel"}>
            🛞 {nameOf(ev.userId)} took the wheel
          </div>
        );
      case "agent_error":
        return <div key={ev.seq} className="line red">⚠ {ev.message}</div>;
      case "intent_update":
        return (
          <div key={ev.seq} className={ev.seq === lastIntentSeq ? "line gold" : "line gold done"}>
            ✦ objective: {ev.text}
          </div>
        );
      case "model_change":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} switched the agent to {ev.model}
          </div>
        );
      case "permission_request": {
        const decided = ev.requestId ? permissionDecisions.get(ev.requestId) : undefined;
        const cmd = (ev.input as { command?: unknown } | undefined)?.command;
        const preview = typeof cmd === "string" ? cmd : JSON.stringify(ev.input);
        return (
          <div key={ev.seq} className="perm">
            <div className="perm-title">🔐 agent wants to run <b>{ev.toolName}</b></div>
            <code className="perm-input">{preview?.slice(0, 300)}</code>
            {decided ? (
              <div className="perm-outcome">
                {decided.decision === "allow" ? "✅ approved" : "⛔ denied"} by {nameOf(decided.userId)}
              </div>
            ) : props.isDriver && ev.requestId ? (
              <div className="perm-actions">
                <button onClick={() => props.onPermission(ev.requestId!, "allow")}>[a]pprove</button>
                <button className="deny" onClick={() => props.onPermission(ev.requestId!, "deny")}>[d]eny</button>
              </div>
            ) : (
              <div className="perm-outcome">⏳ driver deciding…</div>
            )}
          </div>
        );
      }
      case "permission_decision":
        return null; // folded into the request block via permissionDecisions
      case "skill_suggest": {
        const decided = ev.suggestId ? suggestDecisions.get(ev.suggestId) : undefined;
        return (
          <div key={ev.seq} className="perm suggest">
            <div className="perm-title">
              ⚡ {nameOf(ev.userId)} suggests <b>/{ev.skill}</b>
              {ev.args && <span className="dim"> {ev.args.slice(0, 120)}</span>}
            </div>
            {decided ? (
              <div className="perm-outcome">
                {decided.decision === "run" ? "⚡ run" : "✕ dismissed"} by {nameOf(decided.userId)}
              </div>
            ) : props.isDriver && ev.suggestId ? (
              <div className="perm-actions">
                <button onClick={() => props.onDecideSkill(ev.suggestId!, "run")}>run</button>
                <button className="deny" onClick={() => props.onDecideSkill(ev.suggestId!, "dismiss")}>dismiss</button>
              </div>
            ) : (
              <div className="perm-outcome">⏳ driver deciding…</div>
            )}
          </div>
        );
      }
      case "skill_decision":
        return null; // folded into the suggest chip via suggestDecisions
      case "plan_request": {
        const decided = ev.requestId ? planDecisions.get(ev.requestId) : undefined;
        return (
          <div key={ev.seq} className="perm plancard">
            <div className="perm-title">📋 agent proposes a plan</div>
            <pre className="plan-body">{ev.plan}</pre>
            {decided ? (
              <div className="perm-outcome">
                {decided.decision === "approve" ? "✅ approved" : "↩ revisions requested"} by {nameOf(decided.userId)}
              </div>
            ) : props.isDriver && ev.requestId ? (
              <div className="perm-actions">
                <button onClick={() => props.onDecidePlan(ev.requestId!, "approve")}>approve</button>
                <button className="deny" onClick={() => props.onDecidePlan(ev.requestId!, "reject")}>request revision</button>
              </div>
            ) : (
              <div className="perm-outcome">⏳ driver deciding…</div>
            )}
          </div>
        );
      }
      case "plan_decision":
        return null; // folded into the plan card via planDecisions
      case "permission_mode_change":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} switched plan mode {ev.mode === "plan" ? "on" : "off"}
          </div>
        );
      default:
        return null; // presence_join/leave, turn_end: no transcript line
    }
  };

  return (
    <main className="transcript term-frame">
      {deriveTranscriptGroups(props.events).map((group, gi) =>
        group.kind === "main" ? (
          group.events.map(renderEvent)
        ) : (
          <details key={`sub-${gi}-${group.parentId}`} className="subagent">
            <summary>
              ⚒ subagent: {group.label} · {group.status === "done" ? "done" : "running…"} · {group.events.length} rows
            </summary>
            {group.events.map(renderEvent)}
          </details>
        ),
      )}
      <div ref={bottomRef} />
    </main>
  );
}
