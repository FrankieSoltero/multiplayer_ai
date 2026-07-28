/** Inline confirm, not a modal. The permission gate and plan-approval cards
 *  (Transcript.tsx) already answer "a decision is waiting on you" this way, so
 *  this reuses that idiom rather than introducing a modal system the codebase
 *  does not have.
 *
 *  Shown only when leaving would strand something — see `exitWouldStrand` in
 *  App.tsx. Purely local state: whether you hesitated is nobody else's
 *  business and nothing about it belongs on the wire. */
export function ExitConfirm(props: {
  reason: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="exitconfirm" role="alertdialog" aria-label="confirm leaving" aria-describedby="exit-why">
      <span id="exit-why" className="exitwhy">{props.reason}</span>
      <button className="btn red" onClick={props.onConfirm}>
        LEAVE ANYWAY
      </button>
      <button className="btn" onClick={props.onCancel} autoFocus>
        STAY
      </button>
    </div>
  );
}
