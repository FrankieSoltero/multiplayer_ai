import type { LoggedEvent } from "./events.js";

/** A permission request nobody has answered yet. `sinceTs` is when the agent
 *  asked — the client compares it against its own threshold, because the
 *  server has no opinion about when waiting becomes worth interrupting
 *  someone over. */
export interface PendingGate {
  toolName: string;
  sinceTs: string;
}

/** The oldest unanswered permission request in this log, or null.
 *
 *  Auto-approved calls append a `permission_decision` with `auto: true`, which
 *  resolves the request like any other — so AUTO mode produces no pending gates
 *  without needing a special case. */
export function pendingGateOf(events: LoggedEvent[]): PendingGate | null {
  const decided = new Set<string>();
  for (const ev of events) {
    if (ev.type === "permission_decision") decided.add(ev.requestId);
  }
  // The log is append-only and ordered by seq, so the first undecided request
  // encountered is the oldest — no sorting needed.
  for (const ev of events) {
    if (ev.type === "permission_request" && !decided.has(ev.requestId)) {
      return { toolName: ev.toolName, sinceTs: ev.ts };
    }
  }
  return null;
}
