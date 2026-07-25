import { useEffect, useState } from "react";
import { GLYPHS, IDENTITY_COLORS, type Profile } from "../identity";
import { SERVER_URL, type ProjectSessionInfo } from "../types";

export function Lobby(props: {
  projectId: string; sessionId: string; defaultName: string;
  onEnter: (p: Profile) => void;
}) {
  const [name, setName] = useState(props.defaultName);
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
    const n = name.trim().slice(0, 40);
    if (n) props.onEnter({ name: n, glyph, color });
  };

  return (
    <div className="lobby term-frame">
      <div className="lobby-title">JOIN SESSION {props.sessionId} · {props.projectId}</div>
      <label className="lobby-row">
        name <span className="caret">›</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && enter()} maxLength={40} />
      </label>
      <div className="lobby-row">
        glyph <span className="caret">›</span>
        {GLYPHS.map((g) => (
          <button key={g} className={g === glyph ? "pick on" : "pick"}
            style={{ color }} onClick={() => setGlyph(g)}>{g}</button>
        ))}
      </div>
      <div className="lobby-row">
        color <span className="caret">›</span>
        {IDENTITY_COLORS.map((c) => (
          <button key={c} className={c === color ? "pick on" : "pick"}
            style={{ color: c }} onClick={() => setColor(c)}>■</button>
        ))}
      </div>
      <div className="lobby-party">
        party:{" "}
        {party.length === 0
          ? "no one here yet"
          : party.map((s) => `${s.id} (${s.participants.join(", ") || "empty"})`).join(" · ")}
      </div>
      <button className="lobby-enter" onClick={enter} disabled={!name.trim()}>
        [ enter session ]
      </button>
    </div>
  );
}
