export const MODEL_LABELS: Record<string, string> = {
  opus: "opus 4.8", sonnet: "sonnet 5", haiku: "haiku 4.5",
};

/** Every hud field is optional and renders an em dash when absent — the HUD is
 *  a design surface first; CONTEXT and PARTY XP stay "—" until server events
 *  exist (spec §1). turn/toolsUsed/gated are derived client-side in App. */
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
  permissionMode: string; canCycleMode: boolean; onCycleMode: () => void;
  arcadeOpen: boolean; canToggleArcade: boolean; onToggleArcade: () => void;
  onOpenSkills: () => void;
  onOpenWorkflows: () => void; runningTasks: number;
  hud?: HudData;
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
        <button
          className={
            props.permissionMode === "auto"
              ? "planmode auto on"
              : props.permissionMode === "plan"
                ? "planmode on"
                : "planmode"
          }
          disabled={!props.canCycleMode}
          onClick={props.onCycleMode}
          title={
            props.canCycleMode
              ? props.permissionMode === "auto"
                ? "AUTO: permission gates self-approve — every decision still lands on the wire. Click or press M to cycle."
                : props.permissionMode === "plan"
                  ? "PLAN: the agent must present a plan for approval before acting. Click or press M to cycle."
                  : "DEFAULT: gates ask the driver. Click or press M to cycle."
              : "only the driver can change the permission mode — take the wheel first"
          }
        >
          {props.permissionMode === "auto"
            ? "⚡ MODE: AUTO"
            : props.permissionMode === "plan"
              ? "◉ MODE: PLAN"
              : "▢ MODE: DEFAULT"}
        </button>
        <button
          className={props.arcadeOpen ? "planmode on" : "planmode"}
          disabled={!props.canToggleArcade}
          onClick={props.onToggleArcade}
          title={
            props.canToggleArcade
              ? "open the arcade while you wait (A)"
              : "the agent is thinking — the arcade is already on screen"
          }
        >
          {props.arcadeOpen ? "◉ ARCADE" : "▢ ARCADE"}
        </button>
        <button
          className="planmode"
          onClick={props.onOpenSkills}
          title="skills & workflows (S)"
        >
          ▢ SKILLS
        </button>
        <button
          className={props.runningTasks > 0 ? "planmode on" : "planmode"}
          onClick={props.onOpenWorkflows}
          title="live subagent workflows (W)"
        >
          {props.runningTasks > 0 ? `▸ WORKFLOWS ▸ ${props.runningTasks}` : "▢ WORKFLOWS"}
        </button>
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
        </div>
      )}
    </>
  );
}
