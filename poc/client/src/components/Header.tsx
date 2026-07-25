export const MODEL_LABELS: Record<string, string> = {
  opus: "opus 4.8", sonnet: "sonnet 5", haiku: "haiku 4.5",
};

export function Header(props: {
  projectId: string; sessionId: string; model: string; connected: boolean;
  objective: string | null; canSetModel: boolean; onSetModel: (key: string) => void;
  planMode: boolean; canTogglePlan: boolean; onTogglePlan: () => void;
}) {
  return (
    <>
      <div className="term-header term-frame">
        <span className="crumb">
          multiplayer_ai · <b>{props.projectId}</b> · session <b>{props.sessionId}</b>
        </span>
        <span className="rule" />
        <label>
          agent:{" "}
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
          className={props.planMode ? "planmode on" : "planmode"}
          disabled={!props.canTogglePlan}
          onClick={props.onTogglePlan}
          title={
            props.canTogglePlan
              ? "plan mode: the agent must present a plan for approval before acting"
              : "only the driver can toggle plan mode, between turns"
          }
        >
          {props.planMode ? "▣ plan mode" : "▢ plan mode"}
        </button>
        <span className={props.connected ? "conn" : "conn off"}>
          {props.connected ? "● connected" : "○ disconnected"}
        </span>
      </div>
      {props.objective && (
        <div className="objective">
          ✦ <span className="label">OBJECTIVE:</span> {props.objective}
        </div>
      )}
    </>
  );
}
