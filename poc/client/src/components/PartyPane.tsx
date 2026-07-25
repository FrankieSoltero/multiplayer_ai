import { useState } from "react";
import { hashIdentity } from "../identity";
import type { ProjectSessionInfo } from "../types";
import type { Participant } from "../derive";

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
}) {
  const [open, setOpen] = useState(false);
  const here = [...props.participants.entries()];
  const others = props.sessions.filter((s) => s.id !== props.sessionId);

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
      </div>

      {others.map((s) => {
        const id = hashIdentity(s.id);
        return (
          <a
            key={s.id}
            className={s.ended ? "member ended" : "member"}
            href={`?project=${props.projectId}&session=${s.id}`}
          >
            <div className="member-head">
              <span style={{ color: id.color }}>{id.glyph}</span> {s.id}
              {s.ended && <span className="here"> · ended</span>}
            </div>
            <div className={s.intent ? "member-quest" : "member-quest none"}>
              ✦ {s.intent ?? "no quest declared"}
            </div>
            <div className="member-meta">
              {s.participants.join(", ") || "empty"}
              {s.driverName ? ` · 🛞 ${s.driverName}` : ""}
              {s.lastActivityTs ? ` · ${ago(s.lastActivityTs)}` : ""}
            </div>
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
