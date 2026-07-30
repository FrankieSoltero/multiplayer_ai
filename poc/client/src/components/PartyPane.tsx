import { useMemo, useState } from "react";
import { hashIdentity } from "../identity";
import { projectCollisions, sharedWith } from "../collisionView";
import type { ProjectSessionInfo } from "../types";
import type { Participant } from "../derive";
import { THRESHOLD_OPTIONS, waitedLabel, type Pull } from "../pulls";
import { sessionStateLabel, sessionStateClass } from "../sessionState";

const ago = (ts: string | null) => {
  if (!ts) return "";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
};

/** The people in THIS session first, other sessions below (patch design).
 *  Below 900px the pane collapses to a sprite summary strip with a toggle. */
export function PartyPane(props: {
  projectId: string; sessionId: string; sessions: ProjectSessionInfo[];
  participants: Map<string, Participant>;
  driverId: string | null;
  selfId: string;
  pulls?: Pull[];
  pullThresholdMs?: number | null;
  onPullThresholdChange?: (ms: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const here = [...props.participants.entries()];
  const others = props.sessions.filter((s) => s.id !== props.sessionId);
  const pullBySession = new Map((props.pulls ?? []).map((p) => [p.sessionId, p]));
  // Derived here, not threaded in: the pane already receives the whole project
  // snapshot, so an extra prop would only be a second copy of a value this
  // component can compute — and memoising on `props.sessions` keeps the
  // intersection off every unrelated re-render.
  const collisions = useMemo(() => projectCollisions(props.sessions), [props.sessions]);

  return (
    <aside className={"party panel" + (open ? " open" : "")}>
      <button className="pane-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="pix sm">PARTY</span>
        {here.map(([id, p]) => (
          <span key={id} style={{ color: p.color }}>{p.glyph}</span>
        ))}
        <span>{open ? "▾" : "▸"}</span>
      </button>

      <div className="party-title pix">
        <span>PARTY · {here.length || props.sessions.length}</span>
      </div>

      {here.map(([id, p]) => {
        const isDriver = id === props.driverId;
        const isYou = id === props.selfId;
        return (
          <div key={id} className={isYou ? "member you" : "member"}>
            <div className="member-head">
              <span style={{ color: p.color }}>{p.glyph}</span> {p.name}
              {isDriver && <span className="role"> 🛞 DRIVING</span>}
              {isYou && <span className="here"> · you</span>}
            </div>
            {!isDriver && !isYou && <div className="member-meta">watching</div>}
          </div>
        );
      })}

      <div className="party-title pix" style={{ marginTop: 6 }}>
        <span>OTHER PARTIES</span>
        {props.onPullThresholdChange && (
          // A <label> must never wrap this <select>: a wrapping label forwards a
          // second synthesized click, so the native dropdown opens and instantly
          // closes and the control looks dead with no error anywhere.
          <span className="pull-setting">
            <span id="pull-after-label">PULL AFTER</span>
            <select
              aria-labelledby="pull-after-label"
              value={
                props.pullThresholdMs === null || props.pullThresholdMs === undefined
                  ? ""
                  : String(props.pullThresholdMs)
              }
              onChange={(e) =>
                props.onPullThresholdChange!(e.target.value === "" ? null : Number(e.target.value))
              }
            >
              {THRESHOLD_OPTIONS.map((o) => (
                <option key={o.label} value={o.ms === null ? "" : String(o.ms)}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>

      {others.map((s) => {
        const id = hashIdentity(s.id);
        const pull = pullBySession.get(s.id);
        const facts = { ...s, participantCount: s.participants.length };
        const stateClass = sessionStateClass(facts);
        const stateLabel = sessionStateLabel(facts);
        const shared = sharedWith(props.sessionId, s.id, collisions);
        return (
          <a
            key={s.id}
            className={["member", stateClass, pull ? "pull" : ""].filter(Boolean).join(" ")}
            href={`?project=${props.projectId}&session=${s.id}`}
          >
            <div className="member-head">
              <span style={{ color: id.color }}>{id.glyph}</span> {s.id}
              {stateLabel && <span className="here"> · {stateLabel}</span>}
            </div>
            {pull && (
              <div className="member-pull">
                🔐 waiting {waitedLabel(Date.parse(pull.sinceTs), Date.now())} — approval to run{" "}
                {pull.toolName}
              </div>
            )}
            <div className={s.intent ? "member-quest" : "member-quest none"}>
              ✦ {s.intent ?? "no quest declared"}
            </div>
            <div className="member-meta">
              {s.participants.join(", ") || "empty"}
              {s.driverName ? ` · 🛞 ${s.driverName}` : ""}
              {s.lastActivityTs ? ` · ${ago(s.lastActivityTs)}` : ""}
            </div>
            {/* The peer-overlap line, last in the row: reuses `member-meta` for
                layout and adds `contested-calm` for the tone — awareness, not
                an alarm. Rendered only when the intersection is non-empty, so a
                peer you share nothing with is byte-identical to before. */}
            {shared.length > 0 && (
              <div className="member-meta contested-calm">
                {`⚠ shares: ${shared.slice(0, 3).join(", ")}${
                  shared.length > 3 ? ` +${shared.length - 3} more` : ""
                }`}
              </div>
            )}
          </a>
        );
      })}

      {props.sessions.length === 0 && <div className="member-meta">no sessions yet</div>}

      <div className="party-foot">
        <span>{others.length} other session{others.length === 1 ? "" : "s"}</span>
      </div>
    </aside>
  );
}
