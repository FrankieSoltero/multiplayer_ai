import { hashIdentity } from "../identity";
import type { ProjectSessionInfo } from "../types";
import type { Participant } from "../derive";

const ago = (ts: string | null) => {
  if (!ts) return "";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  return m < 1 ? "just now" : `${m}m ago`;
};

/**
 * v4 listed project sessions. v5 keeps that, and puts the people in THIS
 * session above it — with 7-person parties the roster is the thing you read
 * first and the other sessions are the map.
 *
 * `participants` / `driverId` / `selfId` are optional: without them the pane
 * degrades to exactly the v4 session list.
 */
export function PartyPane(props: {
  projectId: string; sessionId: string; sessions: ProjectSessionInfo[];
  participants?: Map<string, Participant>;
  driverId?: string | null;
  selfId?: string;
  level?: number;
}) {
  const here = [...(props.participants?.entries() ?? [])];
  const others = props.sessions.filter((s) => s.id !== props.sessionId);

  return (
    <aside className="party panel">
      <div className="party-title pix">
        <span>PARTY · {here.length || props.sessions.length}</span>
        {props.level !== undefined && <span className="lv pix sm">LV.{props.level}</span>}
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
            {isYou && (
              <div className="seg" style={{ height: 8 }}>
                <div className="seg-fill" style={{ width: "74%" }} />
              </div>
            )}
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
        <span style={{ color: "var(--green)" }}>no overlap</span>
      </div>
    </aside>
  );
}
