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
  // Additive `available` (hub-oversight plan Task 4): absent or `true` means
  // capable — same posture as every other optional snapshot field, so an old
  // server or a solo project renders exactly as before this task. Only an
  // explicit `false` (hub has no ANTHROPIC_API_KEY) disables the toggle and
  // shows the truthful reason. PULL's own gating (isDriver / latest) is
  // untouched either way (spec §5) — with oversight unavailable it never gets
  // enabled in the first place, so PULL is unreachable, not disabled.
  const unavailable = oversight.available === false;
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
            <button className="btn" disabled={unavailable} onClick={() => props.onToggle(!oversight.enabled)}>
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
          {unavailable && (
            <div className="line dim">
              oversight is unavailable on this hub — no ANTHROPIC_API_KEY configured
            </div>
          )}
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
