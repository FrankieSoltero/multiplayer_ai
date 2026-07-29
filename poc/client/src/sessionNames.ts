const MAX_SLUG = 40;

/** Pick a session name nobody in this project is using.
 *
 *  Spec P6: this runs in the BROWSER, not the hub, so the message the hub
 *  forwards is already correct — the hub is contractually a router for that
 *  payload and must not rewrite it. */
export function freeSessionName(existing: string[], desired: string): string {
  const taken = new Set(existing);
  if (!taken.has(desired)) return desired;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const stem = desired.slice(0, MAX_SLUG - suffix.length);
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return desired;
}
