import { useEffect, useRef } from "react";
import type { DerivedState } from "../derive";
import type { LoggedEvent } from "../types";

const isFresh = (ev: LoggedEvent) => Date.now() - new Date(ev.ts).getTime() < 5000;

/**
 * Logic is v4's, untouched: same event switch, same a/d shortcuts, same folding
 * of permission_decision into its request block. Only the markup moved to the
 * chunky 90s classes, plus two additions that need no new data —
 *   1. watcher sprites on an open permission card (from derived.participants)
 *   2. a pixel headline on the take-the-wheel banner.
 */
export function Transcript(props: {
  events: LoggedEvent[]; derived: DerivedState; isDriver: boolean;
  selfId: string;
  onPermission: (requestId: string, decision: "allow" | "deny") => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.events]);

  const { participants, permissionDecisions, lastIntentSeq } = props.derived;
  const nameOf = (id?: string) => (id && participants.get(id)?.name) ?? id ?? "?";
  const colorOf = (id?: string) => (id && participants.get(id)?.color) ?? "var(--fg)";

  const watchers = [...participants.entries()].filter(([id]) => id !== props.selfId);

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

  return (
    <main className="transcript panel">
      <div className="transcript-body">
        {props.events.map((ev) => {
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
            case "tool_call":
              return (
                <div key={ev.seq} className="line dim">
                  ⏺ {ev.toolName}({JSON.stringify(ev.input)?.slice(0, 200)})
                </div>
              );
            case "tool_result":
              return (
                <div key={ev.seq} className="line dim">
                  {"  ⎿ "}{ev.output?.slice(0, 300)}
                </div>
              );
            case "control_change":
              return (
                <div key={ev.seq} className={isFresh(ev) ? "wheelbanner" : "line wheel"}>
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
              const open = !decided && props.isDriver && ev.requestId;
              return (
                <div key={ev.seq} className="perm">
                  <div className="perm-head">
                    <span className="perm-title">🔐 PERMISSION CHECK</span>
                    <span className="rule" />
                    <span className="perm-timer">
                      {decided ? "DECIDED" : `WAITING ${Math.max(0, Math.floor((Date.now() - new Date(ev.ts).getTime()) / 1000))}S`}
                    </span>
                  </div>
                  <div className="perm-what">
                    the agent wants to use <b>{ev.toolName}</b> — not on the auto-approve list
                  </div>
                  <code className="perm-input">{preview?.slice(0, 300)}</code>
                  {open ? (
                    <>
                      <div className="perm-why">
                        <span>only the driver decides · taking the wheel also takes this</span>
                      </div>
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
                    </>
                  ) : decided ? (
                    <div className="perm-outcome">
                      {decided.decision === "allow" ? "✅ approved" : "⛔ denied"} by {nameOf(decided.userId)}
                    </div>
                  ) : (
                    <div className="perm-outcome">⏳ driver deciding…</div>
                  )}
                </div>
              );
            }
            case "permission_decision":
              return null; // folded into the request block via permissionDecisions
            default:
              return null; // presence_join/leave, turn_end: no transcript line
          }
        })}
        <div ref={bottomRef} />
      </div>
    </main>
  );
}
