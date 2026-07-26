import type { OversightState } from "../types";
import { updatedAtLabel } from "../oversightView";

/** Server-wide team summary screen (spec §4). Read-only view of the overseer's
 *  latest summary; toggle is open to everyone, PULL is driver-only. */
export function OversightPanel(props: {
  oversight: OversightState;
  isDriver: boolean;
  onToggle: (enabled: boolean) => void;
  onPull: () => void;
  onBack: () => void;
}) {
  const { oversight } = props;
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={props.onBack}>◂ BACK</button>
        <span className="pix lg">OVERSIGHT</span>
        <span className="rule" />
        <span className={`pix ovstate ${oversight.enabled ? "on" : ""}`}>
          {oversight.enabled ? "● WATCHING" : "○ OFF"}
        </span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          <div className="ovhead">
            <span className="line dim">{updatedAtLabel(oversight.latest?.ts ?? null)}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => props.onToggle(!oversight.enabled)}>
              {oversight.enabled ? "DISABLE" : "ENABLE"}
            </button>
            {oversight.enabled && (
              <button
                className="btn"
                disabled={!props.isDriver || !oversight.latest}
                title={
                  !props.isDriver
                    ? "only the driver can pull team updates — take the wheel first"
                    : !oversight.latest
                      ? "no team summary yet"
                      : "inject the latest team summary into this agent's next turn"
                }
                onClick={props.onPull}
              >
                PULL INTO SESSION ▸
              </button>
            )}
          </div>
          {oversight.latest ? (
            <div className="ovtext">{oversight.latest.text}</div>
          ) : (
            <div className="line dim">
              {oversight.enabled
                ? "watching — the first summary lands after the next team activity."
                : "enable oversight for a rolling summary of what the whole team is doing."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
