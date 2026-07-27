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

/** The three degraded states, ranked in precedence order (highest first). A
 *  healthy session is `null` — no state applies. */
type DegradedState = "closed" | "offline" | "ended";

/** Precedence is load-bearing, not cosmetic.
 *
 *  `closed` wins because it is a deliberate human act — it stays true whatever
 *  the machine is doing. `offline` then outranks `ended` because once the
 *  owning machine is unreachable, the last `ended` we heard is stale: showing
 *  it would state as fact something we can no longer observe. Today all three
 *  render as "ended", which is exactly the conflation v7a removes.
 *
 *  This is the single source of truth for the ordering: `sessionStateLabel`
 *  and `sessionStateClass` are both thin lookups over its result, so there is
 *  no branch to keep in sync by hand when a state is added or reordered. */
function degradedState(s: SessionStateFacts): DegradedState | null {
  if (s.lifecycle === "closed") return "closed";
  if (s.presence === "offline") return "offline";
  if (s.ended) return "ended";
  return null;
}

const LABEL_BY_STATE: Record<DegradedState, string> = {
  closed: "closed",
  offline: "offline",
  ended: "agent stopped",
};

export function sessionStateLabel(s: SessionStateFacts): string | null {
  const state = degradedState(s);
  return state === null ? null : LABEL_BY_STATE[state];
}

/** CSS modifier for the party row. Empty string means "add no class". */
const CLASS_BY_STATE: Record<DegradedState, string> = {
  closed: "closed",
  offline: "offline",
  ended: "ended",
};

export function sessionStateClass(s: SessionStateFacts): string {
  const state = degradedState(s);
  return state === null ? "" : CLASS_BY_STATE[state];
}
