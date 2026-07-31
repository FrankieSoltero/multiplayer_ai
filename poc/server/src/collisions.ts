/** Awareness collisions (spec §4): which files two live sessions in the SAME
 *  repo are both touching.
 *
 *  This module is ISOMORPHIC on purpose — the browser bundles it verbatim at
 *  runtime, so it must stay pure ESM with no `node:` imports and no value
 *  import of anything. Its one import is type-only and therefore erased at
 *  build. That constraint is also why the three shared wire constants are
 *  DECLARED here rather than imported from `touched.ts`: `touched.ts` is
 *  node-only, and importing it would drag the filesystem into the client
 *  bundle. `touched.ts` re-exports them from here instead. */
import type { SessionFacts } from "./relayProtocol.js";

/** Minification-stable anchor for the bundle check, carried in the input
 *  guard's message so it survives into the shipped bundle. */
export const COLLISIONS_MODULE_ID = "collisionsFrom/v1";

/** Max paths one session puts on the wire. */
export const TOUCH_CAP = 500;

/** Stands in for "…and more" once TOUCH_CAP is hit. Never a real path, and so
 *  never a collision. Single U+2026 char. */
export const TOUCH_SENTINEL = "…";

/** Per-path wire cap in chars — the producer's drop threshold and the
 *  validator's bound. */
export const PATH_WIRE_CAP = 512;

/** The longest gate reason a producer may emit and the validator will accept.
 *  A SEPARATE bound from `PATH_WIRE_CAP` that deliberately carries the same
 *  number — the two describe different things (one path vs one human-read line)
 *  and are free to diverge, which is why they are two constants and not one.
 *  Homed here, beside its twin, because both of its consumers (`pendingGate.ts`
 *  clamping producers, `relayProtocol.ts` validating the wire) already import
 *  from this module and neither may import the other. */
export const GATE_REASON_CAP = 512;

/** One session's contribution. `lifecycle` is carried because a closed session
 *  still collides (spec §2.6) — the field exists so callers cannot quietly
 *  filter on a shape that does not travel. */
export interface CollisionInput {
  sessionId: string;
  repoKey: string | null;
  lifecycle: SessionFacts["lifecycle"];
  touched: string[] | null;
}

/** One contended path. `sessionIds` always holds at least two ids (spec §4). */
export interface Collision {
  repoKey: string;
  path: string;
  sessionIds: string[];
}

/** Code-unit order — locale-independent, so the hub and every browser agree.
 *  EXPORTED and shared (`touched.ts`, `contested.ts`, the client's
 *  `collisionView.ts`): every list these modules sort has to order the same way
 *  as `collisionsFrom`'s own output, and a second copy of this two-line function
 *  is a second thing that can drift. Isomorphic-safe, like the rest of this
 *  module — it closes over nothing and touches no `node:` API. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A string this module is willing to call a path: a non-empty string that is
 *  not the "…and more" sentinel.
 *
 *  Shared with `contested.ts`, which reads it at the boundary the digest and the
 *  gate render from. `TOUCH_SENTINEL` is the producer's over-cap marker, not a
 *  file, and the frame validator bounds path length from above but not from
 *  below, so `""` reaches these consumers too — both would otherwise surface as
 *  a line about a file nobody can open. */
export function isRealPath(p: unknown): p is string {
  return typeof p === "string" && p !== "" && p !== TOUCH_SENTINEL;
}

/** Per-repo intersection of touched sets. Pure: inputs are read, never
 *  mutated, and the output is fully sorted (repoKey, then path, then
 *  sessionIds) so two callers on the same facts render the same list. */
export function collisionsFrom(sessions: CollisionInput[]): Collision[] {
  if (!Array.isArray(sessions)) {
    throw new TypeError(`${COLLISIONS_MODULE_ID}: sessions must be an array`);
  }

  // repoKey -> path -> sessionIds (a Set: one session listing a path twice, or
  // appearing twice in the input, must not fake a collision with itself).
  const byRepo = new Map<string, Map<string, Set<string>>>();

  for (const s of sessions) {
    const repoKey = s?.repoKey;
    const touched = s?.touched;
    if (typeof repoKey !== "string" || !Array.isArray(touched)) continue;

    let paths = byRepo.get(repoKey);
    if (paths === undefined) {
      paths = new Map<string, Set<string>>();
      byRepo.set(repoKey, paths);
    }

    for (const path of touched) {
      if (!isRealPath(path)) continue;
      let ids = paths.get(path);
      if (ids === undefined) {
        ids = new Set<string>();
        paths.set(path, ids);
      }
      ids.add(s.sessionId);
    }
  }

  const out: Collision[] = [];
  for (const [repoKey, paths] of byRepo) {
    for (const [path, ids] of paths) {
      if (ids.size < 2) continue;
      out.push({ repoKey, path, sessionIds: [...ids].sort(cmp) });
    }
  }
  return out.sort((a, b) => cmp(a.repoKey, b.repoKey) || cmp(a.path, b.path));
}
