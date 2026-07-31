import { GATE_REASON_CAP } from "./collisions.js";
import type { LoggedEvent } from "./events.js";

/** A permission request nobody has answered yet. `sinceTs` is when the agent
 *  asked — the client compares it against its own threshold, because the
 *  server has no opinion about when waiting becomes worth interrupting
 *  someone over. */
export interface PendingGate {
  toolName: string;
  sinceTs: string;
  /** Why this gate is worth someone's attention — e.g. `contested with session
   *  alpha` — or null for an ordinary gate, which is every gate today. Read off
   *  the `permission_request` EVENT rather than computed here: the event is the
   *  copy the client replays and renders, so deriving the field from it keeps
   *  ONE source behind both surfaces with no second writer to keep in sync.
   *
   *  ADDITIVE on the wire, which is why `RELAY_PROTOCOL_VERSION` is NOT bumped:
   *  the relay validator normalizes an absent field to null, so a peer built
   *  before it keeps validating and keeps rendering the gate. */
  reason: string | null;
}

/** `GATE_REASON_CAP` (declared in `collisions.ts`, beside the path cap it
 *  deliberately matches) is applied here on the PRODUCING side as a clamp, not a
 *  rejection, for the same reason `clampRepoDecl` exists: this one choke point
 *  must never emit a gate the relay's own parser would reject on the far end. */

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
      return {
        toolName: ev.toolName,
        sinceTs: ev.ts,
        reason: ev.reason === undefined ? null : ev.reason.slice(0, GATE_REASON_CAP),
      };
    }
  }
  return null;
}
