import type { InviteView } from "../types";
import { expiryLabel, inviteLinkFor, seatsLabel } from "../inviteLink";

/** In-session invite screen (spec §5). Any participant may mint or revoke —
 *  inviting is team infrastructure, not a driver capability. */
export function InvitePanel(props: {
  invites: InviteView[];
  onCreate: () => void;
  onRevoke: (id: string) => void;
  onBack: () => void;
}) {
  const now = Date.now();
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={props.onBack}>◂ BACK</button>
        <span className="pix lg">INVITE</span>
        <span className="rule" />
        <button className="btn" onClick={props.onCreate}>[ CREATE INVITE ]</button>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          {props.invites.length === 0 ? (
            <div className="line dim">NO ACTIVE INVITES</div>
          ) : (
            props.invites.map((inv) => (
              <div key={inv.id} className="invrow">
                <div className="line">
                  <span className="dim">{inv.id}</span> · from {inv.createdByName}
                </div>
                <input className="invlink" readOnly value={inviteLinkFor(inv.token, window.location.origin)} />
                <div className="line dim">
                  {seatsLabel(inv)} · {expiryLabel(inv.expiresAt, now)}
                </div>
                <button className="btn" onClick={() => props.onRevoke(inv.id)}>[ REVOKE ]</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
