import { type JSX } from "react";

export interface GateBarProps {
  /** The NEWEST undecided permission gate, derived in App from `derived.events`:
   *  the newest `permission_request` whose requestId is not in
   *  `derived.permissionDecisions` (the exact rule the a/d hotkeys already use).
   *  `subLabel` joins on the gate's `parentToolUseId` via the existing
   *  `deriveSubSessions` label map (undefined -> no sub-label). `null` -> the
   *  bar renders nothing at all: sessions without a pending gate keep today's
   *  layout, byte for byte (regression floor). */
  gate: { requestId: string; toolName: string; subLabel?: string } | null;
  isDriver: boolean;
  driverName?: string;
  driverGlyph?: string;
  onDecide: (requestId: string, decision: "allow" | "deny") => void;
  onTakeWheel: () => void;
  /** Jump to the gate card in the transcript. The scroll target lands in Task 9;
   *  this task wires the callback so the bar body is already a jump affordance. */
  onJump: (requestId: string) => void;
}

/**
 * The pinned gate bar above the prompt (spec §2.4, proposal 1 of 3). A
 * base-theme surface present in BOTH themes (its `.gatebar` rules live outside
 * the Clean fence): when a permission gate is pending it pins the decision to
 * the bottom of the transcript so the driver never has to scroll for it, and
 * tells a non-driver who to ask (or lets them take the wheel). It reuses the
 * existing permission-gate vocabulary — the `--amber` frame, the `⚒` sub-label
 * prefix (`.perm-sub`), and the `btn green`/`btn red`/`btn gold` controls — so
 * it reads as the same gate, pinned. Clicking the bar body (not a button) jumps
 * to the full gate card; the decide/wheel buttons stop that propagation so a
 * decision never doubles as a jump. Keyboard parity with Transcript's
 * `.subagent-row` compact row (identical click-to-navigate pattern): the bar
 * body exposes button semantics (`role="button"`, `tabIndex={0}`) and jumps on
 * Enter and Space through the SAME handler as onClick.
 */
export function GateBar(props: GateBarProps): JSX.Element | null {
  const { gate } = props;
  if (!gate) return null;

  // Non-driver frame recedes to the muted amber — the gate is visible, but the
  // "you can act here" wash and the decide controls belong to the driver.
  const cls = props.isDriver ? "gatebar" : "gatebar nondriver";
  const jump = () => props.onJump(gate.requestId);

  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      onClick={jump}
      onKeyDown={(e) => {
        // Space's default is page-scroll on a button role, so suppress it.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          jump();
        }
      }}
    >
      <div className="gatebar-info">
        {props.isDriver ? (
          <span className="gatebar-lead">
            🔐 <span className="gatebar-tool">{gate.toolName}</span>
          </span>
        ) : (
          <span className="gatebar-lead">
            🔐 waiting on {props.driverGlyph ? `${props.driverGlyph} ` : ""}
            {props.driverName ?? "the driver"}
          </span>
        )}
        {gate.subLabel ? <span className="perm-sub">⚒ {gate.subLabel}</span> : null}
      </div>

      <div className="gatebar-actions">
        {props.isDriver ? (
          <>
            <button
              className="btn green"
              onClick={(e) => {
                e?.stopPropagation?.();
                props.onDecide(gate.requestId, "allow");
              }}
            >
              [A]PPROVE
            </button>
            <button
              className="btn red"
              onClick={(e) => {
                e?.stopPropagation?.();
                props.onDecide(gate.requestId, "deny");
              }}
            >
              [D]ENY
            </button>
          </>
        ) : (
          <button
            className="btn gold"
            onClick={(e) => {
              e?.stopPropagation?.();
              props.onTakeWheel();
            }}
          >
            🛞 TAKE THE WHEEL
          </button>
        )}
      </div>
    </div>
  );
}
