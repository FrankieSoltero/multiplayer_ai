import type { ProjectSessionInfo } from "./types";

/** A teammate's session that has been waiting on a permission decision longer
 *  than this viewer is willing to ignore. */
export interface Pull {
  sessionId: string;
  toolName: string;
  sinceTs: string;
  driverName: string | null;
}

export const PULL_STORAGE_KEY = "mpai-pull-after-ms";

/** null = off. Off is the default: a pull nobody asked for is just noise. */
export const THRESHOLD_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "OFF", ms: null },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "2m", ms: 120_000 },
  { label: "5m", ms: 300_000 },
];

/** Anything this module did not write is treated as off, so a stale or
 *  hand-edited localStorage value can never produce a surprise interval. */
export function thresholdFromStorage(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return THRESHOLD_OPTIONS.some((o) => o.ms === n) ? n : null;
}

/** How long a gate has been waiting, phrased as a duration.
 *
 *  Deliberately not the party pane's `ago()`: that appends "ago", which after
 *  the word "waiting" produces "waiting 2m ago". Caught in the browser pass —
 *  no unit test would have noticed, because both strings are individually
 *  correct. */
export function waitedLabel(sinceMs: number, nowMs: number): string {
  const m = Math.floor((nowMs - sinceMs) / 60_000);
  return m < 1 ? "under a minute" : `${m}m`;
}

/** Which sessions are pulling this viewer right now.
 *
 *  The threshold is compared client-side on purpose: the server publishes only
 *  when a gate started waiting, so two people watching the same gate can hold
 *  completely different opinions about when it becomes worth interrupting them,
 *  at zero server cost. */
export function pullsFrom(
  sessions: ProjectSessionInfo[],
  opts: { thresholdMs: number | null; currentSessionId: string | null; now: number },
): Pull[] {
  if (opts.thresholdMs === null) return [];
  const out: Pull[] = [];
  for (const s of sessions) {
    if (s.id === opts.currentSessionId) continue;
    if (s.ended) continue;
    const gate = s.pendingGate;
    if (!gate) continue;
    const waited = opts.now - Date.parse(gate.sinceTs);
    if (waited < opts.thresholdMs) continue;
    out.push({
      sessionId: s.id,
      toolName: gate.toolName,
      sinceTs: gate.sinceTs,
      driverName: s.driverName,
    });
  }
  return out;
}
