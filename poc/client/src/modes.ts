/** Canonical permission-mode cycle (v6a spec §1): DEFAULT → AUTO → PLAN.
 *  Pure so the M hotkey and the header button share one tested source of
 *  truth. An unknown mode restarts the cycle at "default" (indexOf -1 + 1
 *  lands on index 0) rather than throwing on a malformed wire value. */
export const MODE_ORDER = ["default", "auto", "plan"] as const;
export type PermissionMode = (typeof MODE_ORDER)[number];

export function nextMode(mode: string): PermissionMode {
  const i = MODE_ORDER.indexOf(mode as PermissionMode);
  return MODE_ORDER[(i + 1) % MODE_ORDER.length];
}
