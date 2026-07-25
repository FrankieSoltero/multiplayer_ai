export const MODEL_LABELS: Record<string, string> = {
  opus: "opus 4.8", sonnet: "sonnet 5", haiku: "haiku 4.5",
};

/**
 * Everything in `hud` and `quest` is optional and renders an em dash when
 * absent — the HUD strip is a design surface first, so it must not wait on new
 * server events to look right. `turn` and `toolsUsed` are already derivable
 * client-side from the event log (count turn_end / tool_call in derive.ts).
 */
export interface HudData {
  turn?: number;
  elapsed?: string;
  contextUsed?: number;
  contextMax?: number;
  toolsUsed?: number;
  gated?: number;
  partyXp?: number;
}

const dash = (v: unknown) => (v === undefined || v === null ? "—" : String(v));
const k = (n?: number) => (n === undefined ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function Header(props: {
  projectId: string; sessionId: string; model: string; connected: boolean;
  objective: string | null; canSetModel: boolean; onSetModel: (key: string) => void;
  hud?: HudData;
  questStep?: { done: number; total: number };
}) {
  const hud = props.hud ?? {};
  const pct =
    hud.contextUsed !== undefined && hud.contextMax
      ? Math.min(100, Math.round((hud.contextUsed / hud.contextMax) * 100))
      : 0;

  return (
    <>
      <div className="term-header term-frame">
        <span className="crumb">
          multiplayer_ai <span className="sep">▸</span> <b>{props.projectId}</b>{" "}
          <span className="sep">▸</span> session <b>{props.sessionId}</b>
        </span>
        <span className="rule" />
        <label className="pix">
          AGENT{" "}
          <select
            value={props.model}
            disabled={!props.canSetModel}
            onChange={(e) => props.onSetModel(e.target.value)}
            title={props.canSetModel ? "switch model (applies next turn)" : "only the driver can switch, between turns"}
          >
            {Object.entries(MODEL_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <span className={props.connected ? "conn" : "conn off"}>
          {props.connected ? "● ONLINE" : "○ OFFLINE"}
        </span>
      </div>

      <div className="hud">
        <div className="hud-cell panel">
          <div className="hud-label pix sm"><span>TURN</span></div>
          <div className="hud-val">
            {dash(hud.turn)} <span className="sub">· {hud.elapsed ?? "—"}</span>
          </div>
        </div>
        <div className="hud-cell wide panel">
          <div className="hud-label pix sm">
            <span>CONTEXT</span>
            <span style={{ color: "var(--green)" }}>
              {k(hud.contextUsed)} / {k(hud.contextMax)}
            </span>
          </div>
          <div className="seg">
            <div className="seg-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="hud-cell panel">
          <div className="hud-label pix sm"><span>TOOLS USED</span></div>
          <div className="hud-val">
            {dash(hud.toolsUsed)}{" "}
            <span className="sub">· {hud.gated ?? 0} gated</span>
          </div>
        </div>
        <div className="hud-cell panel">
          <div className="hud-label pix sm"><span>PARTY XP</span></div>
          <div className="hud-val" style={{ color: "var(--gold)" }}>
            {hud.partyXp === undefined ? "—" : `+${hud.partyXp}`} <span className="sub">today</span>
          </div>
        </div>
      </div>

      {props.objective && (
        <div className="quest">
          <span className="label pix">✦ QUEST</span>
          <span>{props.objective}</span>
          <span className="spacer" />
          {props.questStep && (
            <>
              <span className="of">step {props.questStep.done}/{props.questStep.total}</span>
              <span className="steps">
                {Array.from({ length: props.questStep.total }, (_, i) => (
                  <i key={i} className={i < props.questStep!.done ? "on" : ""} />
                ))}
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
