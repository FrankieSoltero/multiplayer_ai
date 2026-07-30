import { collisionsFrom, COLLISIONS_MODULE_ID } from "multiplayer-ai-server/collisions";
import type { Collision, CollisionInput } from "multiplayer-ai-server/collisions";
import type { ProjectSessionInfo } from "./types";

/** The client's view-model over the shared, isomorphic `collisionsFrom` (spec
 *  §4/§5): snapshot rows in, contended paths out.
 *
 *  Two things this module deliberately does NOT do. It does not reimplement the
 *  intersection — the hub, the laptop and every browser must agree on the same
 *  contested set, so there is exactly one implementation and this is an adapter
 *  over it. And it holds no React: the surfaces (session list, header badge,
 *  OTHER PARTIES rows) render these values unmodified, so the derivations are
 *  asserted in a plain unit suite — the house pattern.
 *
 *  The import above is the client's first RUNTIME (non-type) import of the
 *  server package, which is why `collisions.ts` is pure ESM with no `node:`
 *  dependencies. */

/** Code-unit order — locale-independent, so every browser sorts a shares list
 *  the same way `collisionsFrom` sorted its output. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One snapshot row → one `CollisionInput`.
 *
 *  Every optional row field is normalised here rather than left to the
 *  derivation: `touched` becomes `null` (an absent set is "unknown", which is
 *  not the same claim as `[]`, "changed nothing"), `repoKey` becomes `null`
 *  (ungrouped, so it cannot collide), and `lifecycle` defaults to `"open"` —
 *  a row from an older server carries neither field, and a closed session
 *  still collides (spec §2 banked decision 6), so the default may never be
 *  used to filter a session out. */
function inputFrom(session: ProjectSessionInfo): CollisionInput {
  return {
    sessionId: session.id,
    repoKey: session.repoKey ?? null,
    lifecycle: session.lifecycle ?? "open",
    touched: session.touched ?? null,
  };
}

/** Contended paths across a project snapshot, sorted by `collisionsFrom`. */
export function projectCollisions(sessions: ProjectSessionInfo[]): Collision[] {
  // Same guard, and the same message, as the module it delegates to: the
  // snapshot arrives over a socket, and `${COLLISIONS_MODULE_ID}` names the
  // contract that was broken. Keeping the id runtime-reachable here is also
  // what makes it survive minification into the client bundle.
  if (!Array.isArray(sessions)) {
    throw new TypeError(`${COLLISIONS_MODULE_ID}: sessions must be an array`);
  }
  return collisionsFrom(sessions.map(inputFrom));
}

/** How many distinct contested paths involve this session — the N behind the
 *  header's `⚠ CONTESTED ▸ N` badge (spec §5). */
export function contestedCountFor(sessionId: string, collisions: Collision[]): number {
  const paths = new Set<string>();
  for (const collision of collisions) {
    if (collision.sessionIds.includes(sessionId)) paths.add(collision.path);
  }
  return paths.size;
}

/** The paths two sessions are both changing, ascending — the OTHER PARTIES
 *  `⚠ shares: …` line (spec §5). Empty for an unrelated pair. */
export function sharedWith(
  sessionId: string,
  otherSessionId: string,
  collisions: Collision[],
): string[] {
  const paths = new Set<string>();
  for (const collision of collisions) {
    if (
      collision.sessionIds.includes(sessionId) &&
      collision.sessionIds.includes(otherSessionId)
    ) {
      paths.add(collision.path);
    }
  }
  return [...paths].sort(cmp);
}
