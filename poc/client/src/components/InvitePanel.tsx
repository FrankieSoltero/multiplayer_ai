import type { InviteView } from "../types";
import { expiryLabel, inviteLinkFor, seatsLabel } from "../inviteLink";

/** The project screen's INVITE section (plan 2026-08-01-project-invites §1.8)
 *  — the in-session invite screen is gone; invites are project-scoped now.
 *  SessionPicker renders this only for members and drives it from its own
 *  socket: mint/list/revoke are member-gated on the wire, and the server
 *  re-answers the requesting socket with a fresh `invite_list` after every
 *  mutation, so the callbacks below are plain sends with no follow-up.
 *
 *  Props-only on purpose — same no-DOM seam as `SessionGroups`: the picker's
 *  socket fills `invites` in an effect, and effects never run under this
 *  repo's static render tests, so the section takes its data (and `origin`)
 *  as props to stay assertable. */
export function InvitePanel(props: {
  projectId: string;
  /** Display name for the copy line; the picker falls back to the id while
   *  the project list is still loading. */
  projectName: string;
  invites: InviteView[];
  /** window.location.origin, passed in so the no-DOM tests need no window. */
  origin: string;
  onCreate: () => void;
  onRevoke: (id: string) => void;
}) {
  const now = Date.now();
  return (
    <div className="panel">
      <div className="line dim">anyone with this link can join {props.projectName}</div>
      <div className="line">
        <button className="btn" onClick={props.onCreate}>[ CREATE INVITE ]</button>
      </div>
      {props.invites.length === 0 ? (
        <div className="line dim">NO ACTIVE INVITES</div>
      ) : (
        props.invites.map((inv) => (
          <div key={inv.id} className="invrow">
            <div className="line">
              <span className="dim">{inv.id}</span> · from {inv.createdByName}
            </div>
            <input className="invlink" readOnly value={inviteLinkFor(inv.token, props.origin, props.projectId)} />
            <div className="line dim">
              {seatsLabel(inv)} · {expiryLabel(inv.expiresAt, now)}
            </div>
            <button className="btn" onClick={() => props.onRevoke(inv.id)}>[ REVOKE ]</button>
          </div>
        ))
      )}
    </div>
  );
}
