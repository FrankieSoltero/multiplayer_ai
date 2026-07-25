import { hashIdentity } from "../identity";
import type { ProjectSessionInfo } from "../types";

const ago = (ts: string | null) => {
  if (!ts) return "";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
};

export function PartyPane(props: {
  projectId: string; sessionId: string; sessions: ProjectSessionInfo[];
}) {
  return (
    <aside className="party term-frame">
      <div className="party-title">PARTY · {props.projectId}</div>
      {props.sessions.map((s) => {
        const id = hashIdentity(s.id);
        const here = s.id === props.sessionId;
        return (
          <a
            key={s.id}
            className={s.ended ? "member ended" : "member"}
            href={here ? undefined : `?project=${props.projectId}&session=${s.id}`}
          >
            <div className="member-head">
              <span style={{ color: id.color }}>{id.glyph}</span> {s.id}
              {here && <span className="here"> · you are here</span>}
              {s.ended && " (ended)"}
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
    </aside>
  );
}
