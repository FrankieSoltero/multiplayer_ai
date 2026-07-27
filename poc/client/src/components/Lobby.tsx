import { useEffect, useState } from "react";
import { GLYPHS, IDENTITY_COLORS, type Profile } from "../identity";
import { SERVER_URL, type ProjectSessionInfo } from "../types";

/** Optional — a card of your own numbers on the select screen. Nothing on the
 *  server produces these yet; omit the prop and the block disappears. */
export interface PlayerStats {
  sessions?: number;
  wheelTime?: string;
  gatesDecided?: number;
  gatesDenied?: number;
  arcadeBest?: number;
}

export function Lobby(props: {
  projectId: string; sessionId: string; defaultName: string;
  /** Verified GitHub login — shown instead of the name input when auth is on.
   *  Cosmetic reinforcement only: the server overwrites the joining name with
   *  the verified login regardless of what the client sends. */
  lockedName?: string;
  onEnter: (p: Profile) => void;
  stats?: PlayerStats;
}) {
  const [name, setName] = useState(props.lockedName ?? props.defaultName);
  const [glyph, setGlyph] = useState<string>(GLYPHS[0]);
  const [color, setColor] = useState<string>(IDENTITY_COLORS[0]);
  const [party, setParty] = useState<ProjectSessionInfo[]>([]);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "peek", projectId: props.projectId }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "project") setParty(m.sessions);
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, [props.projectId]);

  const enter = () => {
    const n = (props.lockedName ?? name).trim().slice(0, 40);
    if (n) props.onEnter({ name: n, glyph, color });
  };

  const inside = party.reduce((n, s) => n + s.participants.length, 0);
  const s = props.stats;

  return (
    <div className="lobby">
      <div className="lobby-hero">SELECT YOUR PLAYER</div>
      <div className="lobby-sub">
        PROJECT {props.projectId.toUpperCase()} ▸ SESSION {props.sessionId.toUpperCase()} ▸{" "}
        {inside} ALREADY INSIDE
      </div>

      <div className="lobby-cols">
        <div className="lobby-card panel">
          {/* Not a <label>: wrapping a control forwards a second synthesized
              click, which broke the model picker once already (Header.tsx). */}
          <div className="lobby-row">
            <span className="lbl">NAME</span>
            <span className="caret">▸</span>
            {props.lockedName ? (
              <span className="lobby-locked" title="verified GitHub identity">
                {props.lockedName}
              </span>
            ) : (
              <input
                autoFocus
                aria-label="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && enter()}
                maxLength={40}
              />
            )}
          </div>

          <div className="lobby-row">
            <span className="lbl">SPRITE</span>
            <span className="caret">▸</span>
            <span className="picks">
              {GLYPHS.map((g) => (
                <button
                  key={g}
                  className={g === glyph ? "pick on" : "pick"}
                  style={{ color }}
                  onClick={() => setGlyph(g)}
                >
                  {g}
                </button>
              ))}
            </span>
          </div>

          <div className="lobby-row">
            <span className="lbl">COLOR</span>
            <span className="caret">▸</span>
            <span className="picks">
              {IDENTITY_COLORS.map((c) => (
                <button
                  key={c}
                  className={c === color ? "pick swatch on" : "pick swatch"}
                  style={{ background: c, borderColor: c === color ? "var(--accent)" : "var(--frame)" }}
                  onClick={() => setColor(c)}
                  aria-label={c}
                />
              ))}
            </span>
          </div>

          {s && (
            <div className="stats">
              <div><div className="k">SESSIONS</div><div>{s.sessions ?? "—"}</div></div>
              <div><div className="k">TIME ON THE WHEEL</div><div>{s.wheelTime ?? "—"}</div></div>
              <div>
                <div className="k">GATES DECIDED</div>
                <div>{s.gatesDecided ?? "—"} <span style={{ color: "var(--dim)" }}>· {s.gatesDenied ?? 0} denied</span></div>
              </div>
              <div>
                <div className="k">ARCADE BEST</div>
                <div style={{ color: "var(--gold)" }}>{String(s.arcadeBest ?? 0).padStart(4, "0")}</div>
              </div>
            </div>
          )}

          <button className="lobby-enter" onClick={enter} disabled={!name.trim()}>
            ▸ PRESS START
          </button>
        </div>

        <div className="panel" style={{ width: 340, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="pix" style={{ color: "var(--dim)" }}>ALREADY IN THE PROJECT</div>
          {party.length === 0 && <div className="member-meta">no one here yet</div>}
          {party.map((sess) => (
            <div key={sess.id} className="member" style={{ cursor: "default" }}>
              <div className="member-head">{sess.id}</div>
              <div className={sess.intent ? "member-quest" : "member-quest none"}>
                ✦ {sess.intent ?? "no quest declared"}
              </div>
              <div className="member-meta">
                {sess.participants.join(", ") || "empty"}
                {sess.driverName ? ` · 🛞 ${sess.driverName}` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="lobby-foot">NAME &amp; SPRITE ARE EDITABLE LATER · ?name= IN THE URL SKIPS THIS SCREEN</div>
    </div>
  );
}
