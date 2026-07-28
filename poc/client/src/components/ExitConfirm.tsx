import { useEffect } from "react";

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
  // Spec §3.4: dismissing the bar is the same as STAY. The listener only
  // exists while this component is mounted (App.tsx renders it conditionally
  // on `exitReason`), so it can never swallow Escape for the rest of the app
  // when the bar isn't showing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onCancel]);

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
