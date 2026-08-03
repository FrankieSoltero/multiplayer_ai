import { useEffect, useRef, useState } from "react";
import {
  deriveSubSessions,
  deriveTranscriptGroups,
  subSessionEvents,
  type DerivedState,
} from "../derive";
import type { LoggedEvent } from "../types";
import { pluginLine } from "../pluginLine";

const isFresh = (ev: LoggedEvent) => Date.now() - new Date(ev.ts).getTime() < 5000;

/** 12.4k-style token counts for the compaction marker (same shape as the HUD's). */
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The SDK's resetsAt is an epoch number with unspecified units (sdk.d.ts:4222)
 *  — read it as ms when it's clearly ms, else as seconds; unparseable → null. */
const resetClock = (resetsAt: number): string | null => {
  const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function Transcript(props: {
  events: LoggedEvent[]; derived: DerivedState; isDriver: boolean;
  selfId: string;
  onPermission: (requestId: string, decision: "allow" | "deny") => void;
  onDecideSkill: (suggestId: string, decision: "run" | "dismiss") => void;
  onDecidePlan: (requestId: string, decision: "approve" | "reject") => void;
  /** v5b final-review: true while an arcade run has the keyboard captured
   *  (game letters overlap a/d) — mutes the a/d permission hotkeys so
   *  steering never silently allows/denies a tool call. */
  hotkeysMuted?: boolean;
  /** Which sub-session is projected. null/undefined = the MAIN view, where a
   *  sub-session collapses to one compact row (spec §2.3). Otherwise a
   *  sub-session key: the body is the projection `subSessionEvents(events,key)`.
   *  Client-local component state (constraint 5) — App owns it (Task 4). */
  view?: string | null;
  /** Open a sub-session's projected view from its MAIN compact row. Optional so
   *  App compiles unchanged before Task 4 wires it — an undefined handler makes
   *  the row a harmless no-op, never an error (attribution is display metadata,
   *  never load-bearing — constraint 2). */
  onOpenSubSession?: (key: string) => void;
  /** §8.5 wheel-on-card: on a non-driver's undecided permission gate, the
   *  `.perm-outcome` area offers `🛞 TAKE THE WHEEL` — the SAME take-wheel path
   *  App wires to the pinned GateBar (Task 8). Optional so the card renders
   *  byte-identically when a caller does not pass it (regression floor). Taking
   *  the wheel does NOT auto-decide the gate — the new driver decides on the
   *  card as normal. */
  onTakeWheel?: () => void;
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
  // Sub-session label index (spec §2.3): the SAME derivation the compact rows
  // and the view projection read, so the gate prefix `⚒ <label>` names the
  // sub-session identically end to end. A gate whose parentToolUseId is absent
  // here degrades to today's unprefixed card — attribution is display metadata,
  // never load-bearing (constraint 2).
  const subLabel = new Map(deriveSubSessions(props.events).map((s) => [s.key, s.label]));
  const nameOf = (id?: string) => (id && participants.get(id)?.name) ?? id ?? "?";
  const colorOf = (id?: string) => (id && participants.get(id)?.color) ?? "var(--fg)";
  const watchers = [...participants.entries()].filter(([id]) => id !== props.selfId);

  // One truthful rendering per turn outcome (agent-surface §2/§3): the server
  // appends agent_error BEFORE an error turn_end and emits turn_stop before an
  // interrupted one, so the line belongs to the FIRST of the pair and the
  // turn_end itself stays silent (claimed). A turn_end whose partner never
  // arrived — an old log, a solo server mid-upgrade — renders its own line, so
  // the outcome is never invisible. refusal_fallback gets the same once-per-turn
  // treatment: the SDK can repeat the notice, the transcript must not.
  const claimedTurnEnds = new Set<number>();
  const refusalFallbackSeqs = new Set<number>();
  {
    let sawStop = false;
    let sawError = false;
    let refusalPending = false;
    for (const ev of props.events) {
      switch (ev.type) {
        case "turn_stop":
          sawStop = true;
          break;
        case "agent_error":
          sawError = true;
          break;
        case "agent_status":
          if (ev.status === "refusal_fallback" && !refusalPending) {
            refusalFallbackSeqs.add(ev.seq);
            refusalPending = true;
          }
          break;
        case "turn_end":
          if ((ev.outcome === "interrupted" && sawStop) || (ev.outcome === "error" && sawError)) {
            claimedTurnEnds.add(ev.seq);
          }
          sawStop = false;
          sawError = false;
          refusalPending = false;
          break;
      }
    }
  }

  // a/d keyboard shortcuts for the newest undecided permission (driver only)
  const pending = props.events.filter(
    (e) => e.type === "permission_request" && e.requestId && !permissionDecisions.has(e.requestId),
  );
  const newest = pending.at(-1);
  useEffect(() => {
    if (!props.isDriver || !newest?.requestId) return;
    const onKey = (e: KeyboardEvent) => {
      if (props.hotkeysMuted) return;
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
        // `supersedes` flags a refusal-fallback frame: it replaced content the
        // first model refused — rendered retracted (dim + line-through, the
        // `.retracted` token pair) so the transcript doesn't pass superseded
        // text off as settled. Absent flag = the ordinary line, byte-identical.
        return ev.supersedes ? (
          <div key={ev.seq} className="line retracted">⏺ {ev.text}</div>
        ) : (
          <div key={ev.seq} className="line">⏺ {ev.text}</div>
        );
      case "turn_stop":
        // The attributed half of an interrupted turn (§2): this line carries
        // the story, and the following interrupted turn_end stays silent
        // (claimedTurnEnds above) — one truthful rendering, not two.
        return (
          <div key={ev.seq} className="line stopline">
            ■ turn stopped by {nameOf(ev.userId)}
          </div>
        );
      case "turn_end": {
        if (claimedTurnEnds.has(ev.seq)) return null;
        if (ev.outcome === "interrupted")
          // No turn_stop ever arrived (old log / mid-upgrade server) — the
          // turn_end itself names the outcome, unattributed.
          return (
            <div key={ev.seq} className="line stopline">■ turn interrupted</div>
          );
        if (ev.outcome === "error") {
          // No agent_error arrived to carry it — compose from the payload the
          // same shape the server's agent_error uses (events.ts).
          const why = ev.errorSubtype
            ? `turn failed (${ev.errorSubtype})${ev.errorReason ? `: ${ev.errorReason}` : ""}`
            : (ev.errorReason ?? "turn failed");
          return <div key={ev.seq} className="line red">⚠ {why}</div>;
        }
        return null; // clean/absent outcome: no transcript line, exactly as before
      }
      case "compaction": {
        let line = "✦ context compacted";
        if (ev.preTokens !== undefined) line += ` — ${tok(ev.preTokens)}`;
        if (ev.postTokens !== undefined) line += ` → ${tok(ev.postTokens)}`;
        if (ev.preTokens !== undefined || ev.postTokens !== undefined) line += " tokens";
        return (
          <div key={ev.seq} className="line gold">{line}</div>
        );
      }
      case "rate_limit": {
        // A quiet signal, never the error red — throttled server-side already.
        let line = `✦ rate limit: ${ev.status ?? "unknown"}`;
        if (ev.utilization !== undefined) line += ` · ${ev.utilization}%`;
        const clock = ev.resetsAt !== undefined ? resetClock(ev.resetsAt) : null;
        if (clock) line += ` · resets ${clock}`;
        return (
          <div key={ev.seq} className="line dim">{line}</div>
        );
      }
      case "agent_status":
        // Only refusal_fallback speaks in the transcript, once per turn
        // (refusalFallbackSeqs above); compacting/retrying live on the
        // thinking strip instead (App → ThinkingStrip statusLine).
        if (ev.status === "refusal_fallback" && refusalFallbackSeqs.has(ev.seq)) {
          return (
            <div key={ev.seq} className="line dim">
              ✦ {ev.detail ?? "model refused — falling back"}
            </div>
          );
        }
        return null;
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
        // Attribution prefix (spec §2.3): when this gate belongs to a
        // sub-session, name it `⚒ <label>` before the existing gate text.
        // Rendered ONLY when attributed, so an unattributed gate stays
        // byte-identical to today (constraint 1) — same posture as `reason`.
        const subOf = ev.parentToolUseId ? subLabel.get(ev.parentToolUseId) : undefined;
        return (
          <div key={ev.seq} className="perm" id={ev.requestId ? `perm-${ev.requestId}` : undefined}>
            {subOf ? <div className="perm-sub">⚒ {subOf}</div> : null}
            <div className="perm-head">
              <span className="perm-title">🔐 PERMISSION CHECK</span>
              <span className="rule" />
              <span className="perm-timer">{decided ? "DECIDED" : "WAITING"}</span>
            </div>
            <div className="perm-what">
              the agent wants to use <b>{ev.toolName}</b> — not on the auto-approve list
            </div>
            {/* Why the gate opened, when the server named a reason (spec §6b).
                Composed server-side and rendered VERBATIM — the client neither
                composes nor reformats it, so the string is the same end to end.
                Absent on every gate an older server (or a non-contested path)
                opens, and then nothing extra renders at all. */}
            {ev.reason ? <div className="perm-why">{ev.reason}</div> : null}
            <code className="perm-input">{preview?.slice(0, 300)}</code>
            {decided ? (
              <div className="perm-outcome">
                {decided.auto ? (
                  <span style={{ color: "var(--amber)" }}>
                    ⚡ auto-approved · AUTO set by {nameOf(decided.userId)}
                  </span>
                ) : (
                  <>
                    {decided.decision === "allow" ? "✅ approved" : "⛔ denied"} by {nameOf(decided.userId)}
                  </>
                )}
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
              <div className="perm-outcome">
                ⏳ driver deciding…
                {props.onTakeWheel ? (
                  <button className="btn gold" onClick={() => props.onTakeWheel!()}>
                    🛞 TAKE THE WHEEL
                  </button>
                ) : null}
              </div>
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
          <div
            key={ev.seq}
            className="line gold"
            style={ev.mode === "auto" ? { color: "var(--amber)" } : undefined}
          >
            ✦ {nameOf(ev.userId)} set permission mode to {(ev.mode ?? "default").toUpperCase()}
            {ev.mode === "auto" && " — gates self-approve until it's switched off"}
          </div>
        );
      case "plugin_change":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} {pluginLine(ev.action, ev.name, ev.skillCount)}
          </div>
        );
      case "oversight_pull":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} pulled team update #{ev.summarySeq} into the session
          </div>
        );
      case "invite_created":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} created invite {ev.inviteId}
          </div>
        );
      case "invite_revoked":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} revoked invite {ev.inviteId}
          </div>
        );
      case "invite_redeemed":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} joined via invite {ev.inviteId}
          </div>
        );
      default:
        return null; // presence_join/leave and friends: no transcript line
    }
  };

  const view = props.view ?? null;
  return (
    <main className="transcript panel">
      <div className="transcript-body">
        {view === null
          ? // MAIN view: main events flat, each sub-session as ONE compact row
            // (spec §2.3) — the collapsed form of what its view would show. The
            // `⚒ SUB-QUEST` marker and the `lamp`/`lamp done` class carry over
            // from today's collapsible rendering unchanged.
            deriveTranscriptGroups(props.events).map((group, gi) =>
              group.kind === "main" ? (
                group.events.map(renderEvent)
              ) : (
                <div
                  key={`sub-${gi}-${group.parentId}`}
                  className="subagent-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => props.onOpenSubSession?.(group.parentId)}
                  onKeyDown={(e) => {
                    // Keyboard parity with the mouse: Enter and Space open the
                    // sub-session through the SAME handler as onClick. Space's
                    // default is page-scroll on a button role, so suppress it.
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      props.onOpenSubSession?.(group.parentId);
                    }
                  }}
                >
                  <span className={group.status === "done" ? "lamp done" : "lamp"} />
                  <span className="pix sm">⚒ SUB-QUEST</span>
                  <span>
                    {group.label} · {group.status === "done" ? "done" : "running…"} ·{" "}
                    {group.events.length} rows · open ▸
                  </span>
                </div>
              ),
            )
          : // Sub-session view: the projection `subSessionEvents(events, view)`,
            // rendered flat through the SAME `renderEvent` (no nesting). An
            // unknown key projects to `[]` — an empty body, never a crash.
            subSessionEvents(props.events, view).map(renderEvent)}
        <div ref={bottomRef} />
      </div>
    </main>
  );
}
