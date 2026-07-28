export type SessionPresence = "online" | "offline";
export type SessionLifecycle = "open" | "closed";

/** The three orthogonal facts of spec §3.4. `presence` and `lifecycle` are
 *  optional so a snapshot from an older server degrades to today's behaviour
 *  rather than rendering blank — same posture as `pendingGate`. */
export interface SessionStateFacts {
  presence?: SessionPresence;
  lifecycle?: SessionLifecycle;
  ended: boolean;
  /** How many participants are in the session right now. Optional so a
   *  snapshot from an older server degrades to "not empty" rather than
   *  reporting every session as abandoned — same posture as `presence`. */
  participantCount?: number;
}

/** The four degraded states, ranked in precedence order (highest first). A
 *  healthy session is `null` — no state applies. */
type DegradedState = "closed" | "offline" | "ended" | "empty";

/** Precedence is load-bearing, not cosmetic.
 *
 *  `closed` wins because it is a deliberate human act — it stays true whatever
 *  the machine is doing. `offline` then outranks `ended` because once the
 *  owning machine is unreachable, the last `ended` we heard is stale: showing
 *  it would state as fact something we can no longer observe. Today all three
 *  render as "ended", which is exactly the conflation v7a removes.
 *
 *  `empty` ranks last because it is the weakest claim of the four: a dead
 *  agent or an unreachable machine is a fact about the session, while
 *  emptiness is only a fact about who happens to be looking at it. It still
 *  outranks healthy — a session nobody is in is not simply live.
 *
 *  This is the single source of truth for the ordering: `sessionStateLabel`
 *  and `sessionStateClass` are both thin lookups over its result, so there is
 *  no branch to keep in sync by hand when a state is added or reordered. */
function degradedState(s: SessionStateFacts): DegradedState | null {
  if (s.lifecycle === "closed") return "closed";
  if (s.presence === "offline") return "offline";
  if (s.ended) return "ended";
  if (s.participantCount === 0) return "empty";
  return null;
}

const LABEL_BY_STATE: Record<DegradedState, string> = {
  closed: "closed",
  offline: "offline",
  ended: "agent stopped",
  empty: "empty",
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
  empty: "empty",
};

export function sessionStateClass(s: SessionStateFacts): string {
  const state = degradedState(s);
  return state === null ? "" : CLASS_BY_STATE[state];
}

/** `SessionPicker`'s badge, unlike the party pane's suffix, is always
 *  present — there is no "render nothing" option for a list row. Reuses
 *  `sessionStateLabel`'s precedence and falls back to "LIVE" for the healthy
 *  case, so a healthy row still reads as a badge rather than going blank.
 *
 *  Upper-cased on the way out: `.pix` (terminal.css) deliberately applies no
 *  CSS text-transform — components own their own casing — and every other
 *  badge in the picker is sent in caps. */
export function sessionBadgeLabel(s: SessionStateFacts): string {
  const label = sessionStateLabel(s);
  return label === null ? "LIVE" : label.toUpperCase();
}
