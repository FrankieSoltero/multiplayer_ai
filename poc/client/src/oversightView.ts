import type { OversightState } from "./types";

/** Pure helpers for the OVERSIGHT screen (no component-test infra — recorded
 *  pattern). */

export function oversightFresh(oversight: OversightState, seenSeq: number): boolean {
  return oversight.enabled && oversight.latest !== null && oversight.latest.seq > seenSeq;
}

export function updatedAtLabel(ts: string | null): string {
  if (!ts) return "no summary yet";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "no summary yet";
  return `updated ${d.toLocaleTimeString()}`;
}
