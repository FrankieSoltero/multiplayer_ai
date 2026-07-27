export type SessionPresence = "online" | "offline";
export type SessionLifecycle = "open" | "closed";

/** The three orthogonal facts of spec §3.4. `presence` and `lifecycle` are
 *  optional so a snapshot from an older server degrades to today's behaviour
 *  rather than rendering blank — same posture as `pendingGate`. */
export interface SessionStateFacts {
  presence?: SessionPresence;
  lifecycle?: SessionLifecycle;
  ended: boolean;
}

/** Precedence is load-bearing, not cosmetic.
 *
 *  `closed` wins because it is a deliberate human act — it stays true whatever
 *  the machine is doing. `offline` then outranks `ended` because once the
 *  owning machine is unreachable, the last `ended` we heard is stale: showing
 *  it would state as fact something we can no longer observe. Today all three
 *  render as "ended", which is exactly the conflation v7a removes. */
export function sessionStateLabel(s: SessionStateFacts): string | null {
  if (s.lifecycle === "closed") return "closed";
  if (s.presence === "offline") return "offline";
  if (s.ended) return "agent stopped";
  return null;
}

/** CSS modifier for the party row. Empty string means "add no class". */
export function sessionStateClass(s: SessionStateFacts): string {
  if (s.lifecycle === "closed") return "closed";
  if (s.presence === "offline") return "offline";
  if (s.ended) return "ended";
  return "";
}
