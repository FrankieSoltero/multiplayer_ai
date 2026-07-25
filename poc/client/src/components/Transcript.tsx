import { useEffect, useRef, useState } from "react";
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

  // the "fresh" wheelbanner (< 5s old) otherwise only re-evaluates on the next
  // render; schedule one at the freshness boundary so it demotes on time.
  const [, setFreshnessTick] = useState(0);
  useEffect(() => {
    const latest = [...props.events].reverse().find((e) => e.type === "control_change");
    if (!latest) return;
    const remaining = 5000 - (Date.now() - new Date(latest.ts).getTime());
    if (remaining <= 0) return;
    const t = setTimeout(() => setFreshnessTick((n) => n + 1), remaining);
    return () => clearTimeout(t);
  }, [props.events]);
  const { participants, permissionDecisions, lastIntentSeq, suggestDecisions, planDecisions } = props.derived;
  const nameOf = (id?: string) => (id && participants.get(id)?.name) ?? id ?? "?";
  const colorOf = (id?: string) => (id && participants.get(id)?.color) ?? "var(--fg)";
  const watchers = [...participants.entries()].filter(([id]) => id !== props.selfId);

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
              ▸ {nameOf(ev.userId)}:
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
              <div className="cast">⚡ SPELL CAST</div>
              <div>
                <span className="skillname">/{typeof input?.skill === "string" ? input.skill : "skill"}</span>
                {typeof input?.args === "string" && input.args && (
                  <span className="dim"> {input.args.slice(0, 300)}</span>
                )}
              </div>
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
          <div key={ev.seq} className={isFresh(ev) ? "wheelbanner" : "line wheel-old"}>
            {isFresh(ev) ? (
              <>
                <div className="title">!! {nameOf(ev.userId).toUpperCase()} HAS TAKEN THE WHEEL !!</div>
                <div className="sub">🛞 the turn keeps streaming — nothing restarts</div>
              </>
            ) : (
              <>🛞 {nameOf(ev.userId)} took the wheel</>
            )}
          </div>
        );
      case "agent_error":
        return <div key={ev.seq} className="line red">⚠ {ev.message}</div>;
      case "intent_update":
        return (
          <div key={ev.seq} className={ev.seq === lastIntentSeq ? "line gold" : "line gold done"}>
            ✦ {ev.seq === lastIntentSeq ? "QUEST ACCEPTED — " : "objective: "}{ev.text}
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
            <div className="perm-head">
              <span className="perm-title">🔐 PERMISSION CHECK</span>
              <span className="rule" />
              <span className="perm-timer">{decided ? "DECIDED" : "WAITING"}</span>
            </div>
            <div className="perm-what">
              the agent wants to use <b>{ev.toolName}</b> — not on the auto-approve list
            </div>
            <code className="perm-input">{preview?.slice(0, 300)}</code>
            {decided ? (
              <div className="perm-outcome">
                {decided.decision === "allow" ? "✅ approved" : "⛔ denied"} by {nameOf(decided.userId)}
              </div>
            ) : props.isDriver && ev.requestId ? (
              <div className="perm-actions">
                <button className="btn green" onClick={() => props.onPermission(ev.requestId!, "allow")}>
                  [A]PPROVE
                </button>
                <button className="btn red" onClick={() => props.onPermission(ev.requestId!, "deny")}>
                  [D]ENY
                </button>
                {watchers.length > 0 && (
                  <span className="perm-watchers" title={watchers.map(([, p]) => p.name).join(", ")}>
                    {watchers.slice(0, 5).map(([id, p]) => (
                      <span key={id} style={{ color: p.color }}>{p.glyph}</span>
                    ))}
                    {watchers.length > 5 && <span style={{ color: "var(--dim)" }}>+{watchers.length - 5}</span>}
                  </span>
                )}
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
            <div className="perm-head">
              <span className="perm-title">⚡ SKILL SUGGESTED</span>
              <span className="rule" />
              <span className="perm-timer">{decided ? "DECIDED" : "WAITING"}</span>
            </div>
            <div className="perm-what">
              {nameOf(ev.userId)} suggests <b>/{ev.skill}</b>
            </div>
            {ev.args && <code className="perm-input">{ev.args.slice(0, 300)}</code>}
            {decided ? (
              <div className="perm-outcome">
                {decided.decision === "run" ? "⚡ run" : "✕ dismissed"} by {nameOf(decided.userId)}
              </div>
            ) : props.isDriver && ev.suggestId ? (
              <div className="perm-actions">
                <button className="btn green" onClick={() => props.onDecideSkill(ev.suggestId!, "run")}>
                  RUN
                </button>
                <button className="btn red" onClick={() => props.onDecideSkill(ev.suggestId!, "dismiss")}>
                  DISMISS
                </button>
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
            <div className="perm-head">
              <span className="perm-title">📜 PLAN PROPOSED</span>
              <span className="rule" />
              <span className="perm-timer">{decided ? "DECIDED" : "WAITING"}</span>
            </div>
            <pre className="plan-body">{ev.plan}</pre>
            {decided ? (
              <div className="perm-outcome">
                {decided.decision === "approve" ? "✅ approved" : "↩ revisions requested"} by {nameOf(decided.userId)}
              </div>
            ) : props.isDriver && ev.requestId ? (
              <div className="perm-actions">
                <button className="btn green" onClick={() => props.onDecidePlan(ev.requestId!, "approve")}>
                  APPROVE
                </button>
                <button className="btn red" onClick={() => props.onDecidePlan(ev.requestId!, "reject")}>
                  REQUEST REVISION
                </button>
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
    <main className="transcript panel">
      <div className="transcript-body">
        {deriveTranscriptGroups(props.events).map((group, gi) =>
          group.kind === "main" ? (
            group.events.map(renderEvent)
          ) : (
            <details key={`sub-${gi}-${group.parentId}`} className="subagent">
              <summary>
                <span className={group.status === "done" ? "lamp done" : "lamp"} />
                <span className="pix sm">⚒ SUB-QUEST</span>
                <span>
                  {group.label} · {group.status === "done" ? "done" : "running…"} · {group.events.length} rows
                </span>
              </summary>
              <div className="subagent-body">{group.events.map(renderEvent)}</div>
            </details>
          ),
        )}
        <div ref={bottomRef} />
      </div>
    </main>
  );
}
