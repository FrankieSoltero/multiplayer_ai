/** Which files a session is contesting, and with whom (spec §6a).
 *
 *  Two sources, unioned on every read:
 *
 *  (a) the last `contested` frame the hub sent for this session, stored
 *      verbatim on the entry (`ProjectSessionEntry.contestedFrame`). In hub
 *      mode a laptop cannot see another machine's sessions, so this frame is
 *      the ONLY way a peer on another laptop can be named at all.
 *  (b) local derivation over this laptop's OWN sessions, through
 *      `collisionsFrom`. Computed on read from live session state and never
 *      persisted, so it cannot go stale — and it is what makes a solo laptop
 *      (no hub at all, spec §6a) still see its own two sessions collide.
 *
 *  A LEAF module on purpose: it value-imports only `./collisions.js` and takes
 *  `Project` as a TYPE-ONLY import. It must NOT be homed in `server.ts` —
 *  server.ts already imports `digest.ts` and `permissions.ts`, so an accessor
 *  living there would force those consumers (Tasks 7b and 8b) into an import
 *  cycle back into the server module.
 *
 *  Thesis bound (§1.1): these functions emit repo-relative paths and session
 *  ids. Nothing else on the entry — prompts, transcript, file contents — is
 *  read by either of them. */
import {
  cmp,
  collisionsFrom,
  isRealPath,
  type Collision,
  type CollisionInput,
} from "./collisions.js";
import type { Project } from "./project.js";

/** `cmp` is the comparator `collisions.ts` itself sorts with, so a peer list
 *  assembled from the two sources orders exactly as one from either.
 *
 *  `isRealPath` is the shared "is this a file anyone could open" filter, applied
 *  here defensively on purpose. `TOUCH_SENTINEL` is the producer's "…and more"
 *  marker, not a file (Task 6b's over-cap frame ends its `paths` with it and
 *  this laptop stores that frame verbatim), and the frame validator bounds path
 *  LENGTH from above but not from below, so `""` reaches here too. Both would
 *  otherwise surface as a digest line about a file nobody can open (Task 7b) or
 *  a gate reason naming one (Task 8b) — this filter is the only thing standing
 *  between the wire and those two surfaces. */

/** `collisionsFrom` over this laptop's own sessions — the local half of both
 *  accessors. Recomputed per call from `entry.touched`, which is the point:
 *  nothing derived here is stored, so nothing here can be stale.
 *
 *  PER CALL means per call: a caller that asks `contestedFor` once and then
 *  `contestedSessionsFor` once per contested path pays `1 + P` full passes over
 *  every session on this laptop, not one. That cost is accepted rather than
 *  cached — see `server.ts`'s `contestedByPeer`, which spells it out and names
 *  the ledger entry it was deferred under. */
function localCollisions(project: Project): Collision[] {
  const inputs: CollisionInput[] = [];
  for (const [sessionId, entry] of project.sessions) {
    inputs.push({
      sessionId,
      repoKey: entry.repoKey,
      // `lifecycle` is CARRIED by CollisionInput and never read by
      // `collisionsFrom` — a closed session still collides (spec §2.6), which
      // is exactly why the engine does not filter on it. Deriving the real
      // value here would mean `lifecycleOf(entry.session.eventsFrom(0))`: a
      // full copy of every session's event log on every gate decision, plus a
      // second value import into a module pinned as a leaf. It is also the one
      // input field that reaches no output — `Collision` carries repoKey, path
      // and sessionIds only — so no caller can observe this constant.
      lifecycle: "open",
      // Copied, never aliased: `collisionsFrom` is pure, but handing it the
      // live array is one refactor away from a sort that reorders a session's
      // stored touched set.
      touched: entry.touched === null ? null : [...entry.touched],
    });
  }
  return collisionsFrom(inputs);
}

/** Every path this session is contesting: the hub frame's `paths` UNION the
 *  locally derived ones. Empty (never a throw) for a session this laptop does
 *  not hold — a caller asking about an id that raced a removal gets the same
 *  answer as one asking about a session with nothing contested. */
export function contestedFor(project: Project, sessionId: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const entry = project.sessions.get(sessionId);
  if (entry === undefined) return paths;

  // (a) The hub's list, read as its own list. Never derived from
  // `collisions[]`: the frame's two lists are bounded INDEPENDENTLY (see
  // relayProtocol's `contested` note — the over-cap frame's `paths` carries a
  // sentinel that appears in no collision entry), so treating either as
  // derivable from the other is a guess about a hub this laptop does not run.
  for (const path of entry.contestedFrame?.paths ?? []) {
    if (isRealPath(path)) paths.add(path);
  }

  // (b) The local half: only collisions this session is actually part of.
  for (const collision of localCollisions(project)) {
    if (!collision.sessionIds.includes(sessionId)) continue;
    // `collisionsFrom` already drops the sentinel and the empty string; the
    // check is repeated rather than assumed, because this is the boundary the
    // digest and the gate read.
    if (isRealPath(collision.path)) paths.add(collision.path);
  }

  return paths;
}

/** The OTHER sessions contesting `path` with `sessionId` — ascending, each id
 *  once, deduped across both sources. `[]` when nothing is contesting that path,
 *  when the session is unknown, and when `path` is not a path this module will
 *  answer about (the sentinel, the empty string).
 *
 *  Peers come from the frame's `collisions[]` and from local derivation — the
 *  two lists again read independently, so a path the hub listed with no
 *  collision entry answers `[]` here rather than inventing a peer, and a
 *  collision entry answers even if `paths` was truncated before reaching it. */
export function contestedSessionsFor(
  project: Project,
  sessionId: string,
  path: string,
): string[] {
  if (!isRealPath(path)) return [];
  const entry = project.sessions.get(sessionId);
  if (entry === undefined) return [];

  const ids = new Set<string>();
  for (const collision of entry.contestedFrame?.collisions ?? []) {
    if (collision?.path !== path) continue;
    for (const id of collision.sessionIds ?? []) {
      // The frame's `sessionIds` excludes nothing, so the recipient's own id is
      // in there (relayProtocol §6a) — and this function answers with the
      // OTHERS. A session is never contesting a file with itself.
      if (typeof id === "string" && id !== "" && id !== sessionId) ids.add(id);
    }
  }
  for (const collision of localCollisions(project)) {
    if (collision.path !== path || !collision.sessionIds.includes(sessionId)) continue;
    for (const id of collision.sessionIds) {
      if (id !== sessionId) ids.add(id);
    }
  }
  return [...ids].sort(cmp);
}
