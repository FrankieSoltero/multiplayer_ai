import { describe, it, expect } from "vitest";
import {
  COLLISIONS_MODULE_ID,
  PATH_WIRE_CAP,
  TOUCH_CAP,
  TOUCH_SENTINEL,
  collisionsFrom,
  type Collision,
  type CollisionInput,
} from "../src/collisions.js";
import type { SessionFacts } from "../src/relayProtocol.js";

/** One session's collision input — says only what the row under test cares about. */
function sess(
  sessionId: string,
  repoKey: string | null,
  touched: string[] | null,
  lifecycle: SessionFacts["lifecycle"] = "open",
): CollisionInput {
  return { sessionId, repoKey, lifecycle, touched };
}

/** Every input corpus this table exercises, so the `sessionIds.length >= 2`
 *  invariant can be asserted across ALL of them and not just its own row. */
const CORPUS: Record<string, CollisionInput[]> = {
  basic: [sess("s2", "repo-a", ["src/a.ts", "src/c.ts"]), sess("s1", "repo-a", ["src/a.ts"])],
  singleSessionPath: [sess("s1", "repo-a", ["src/a.ts"]), sess("s2", "repo-a", ["src/b.ts"])],
  threeWay: [
    sess("s3", "repo-a", ["src/x.ts"]),
    sess("s1", "repo-a", ["src/x.ts", "src/only-mine.ts"]),
    sess("s2", "repo-a", ["src/x.ts"]),
  ],
  grouping: [sess("s1", "repo-a", ["src/a.ts"]), sess("s2", "repo-b", ["src/a.ts"])],
  nullRepoKey: [
    sess("s1", null, ["src/a.ts"]),
    sess("s2", null, ["src/a.ts"]),
    sess("s3", "repo-a", ["src/a.ts"]),
  ],
  emptyTouched: [
    sess("s1", "repo-a", null),
    sess("s2", "repo-a", []),
    sess("s3", "repo-a", ["src/a.ts"]),
  ],
  closed: [
    sess("s1", "repo-a", ["src/a.ts"], "closed"),
    sess("s2", "repo-a", ["src/a.ts"], "open"),
  ],
  sentinel: [
    sess("s1", "repo-a", ["src/a.ts", TOUCH_SENTINEL]),
    sess("s2", "repo-a", ["src/a.ts", TOUCH_SENTINEL]),
  ],
  mixed: [
    sess("s3", "repo-b", ["z/1.ts", "a/2.ts"]),
    sess("s1", "repo-a", ["src/b.ts", "src/a.ts"]),
    sess("s2", "repo-a", ["src/a.ts", "src/b.ts"]),
    sess("s4", "repo-b", ["a/2.ts"]),
  ],
};

describe("shared constants (canonical declaration site)", () => {
  it("exports the exact wire constants later modules re-export", () => {
    expect(COLLISIONS_MODULE_ID).toBe("collisionsFrom/v1");
    expect(TOUCH_CAP).toBe(500);
    expect(TOUCH_SENTINEL).toBe("…");
    expect(TOUCH_SENTINEL).toHaveLength(1);
    expect(PATH_WIRE_CAP).toBe(512);
  });
});

describe("collisionsFrom", () => {
  it("emits one collision for a path two sessions in the same repo touched", () => {
    expect(collisionsFrom(CORPUS.basic)).toEqual<Collision[]>([
      { repoKey: "repo-a", path: "src/a.ts", sessionIds: ["s1", "s2"] },
    ]);
  });

  it("emits nothing for a path only one session touched", () => {
    expect(collisionsFrom(CORPUS.singleSessionPath)).toEqual([]);
  });

  it("never emits a Collision with fewer than 2 sessionIds, for any case in this table", () => {
    for (const [name, sessions] of Object.entries(CORPUS)) {
      for (const c of collisionsFrom(sessions)) {
        expect(
          c.sessionIds.length,
          `${name}: ${c.repoKey}/${c.path} has sessionIds ${JSON.stringify(c.sessionIds)}`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("collects all three sessions on a three-way collision", () => {
    expect(collisionsFrom(CORPUS.threeWay)).toEqual<Collision[]>([
      { repoKey: "repo-a", path: "src/x.ts", sessionIds: ["s1", "s2", "s3"] },
    ]);
  });

  it("does not collide the same path across DIFFERENT repoKeys (fork bound)", () => {
    expect(collisionsFrom(CORPUS.grouping)).toEqual([]);
  });

  it("excludes sessions with a null repoKey entirely", () => {
    expect(collisionsFrom(CORPUS.nullRepoKey)).toEqual([]);
  });

  it("treats null and empty touched as contributing nothing", () => {
    expect(collisionsFrom(CORPUS.emptyTouched)).toEqual([]);
  });

  it("counts closed sessions as colliding", () => {
    expect(collisionsFrom(CORPUS.closed)).toEqual<Collision[]>([
      { repoKey: "repo-a", path: "src/a.ts", sessionIds: ["s1", "s2"] },
    ]);
  });

  it("never emits the truncation sentinel as a collision path", () => {
    const out = collisionsFrom(CORPUS.sentinel);
    expect(out.map((c) => c.path)).not.toContain(TOUCH_SENTINEL);
    expect(out).toEqual<Collision[]>([
      { repoKey: "repo-a", path: "src/a.ts", sessionIds: ["s1", "s2"] },
    ]);
  });

  it("throws a TypeError tagged with the module id on a non-array argument", () => {
    expect(() => collisionsFrom(null as never)).toThrow(TypeError);
    expect(() => collisionsFrom(null as never)).toThrow(
      `${COLLISIONS_MODULE_ID}: sessions must be an array`,
    );
    try {
      collisionsFrom(null as never);
      expect.unreachable("expected a TypeError");
    } catch (err) {
      expect((err as Error).message.startsWith("collisionsFrom/v1:")).toBe(true);
    }
    expect(() => collisionsFrom("nope" as never)).toThrow(TypeError);
    expect(() => collisionsFrom({ length: 1 } as never)).toThrow(TypeError);
  });

  it("is deterministic under input reordering and sorts by repoKey, path, sessionIds", () => {
    const expected: Collision[] = [
      { repoKey: "repo-a", path: "src/a.ts", sessionIds: ["s1", "s2"] },
      { repoKey: "repo-a", path: "src/b.ts", sessionIds: ["s1", "s2"] },
      { repoKey: "repo-b", path: "a/2.ts", sessionIds: ["s3", "s4"] },
    ];
    expect(collisionsFrom(CORPUS.mixed)).toEqual(expected);
    expect(collisionsFrom([...CORPUS.mixed].reverse())).toEqual(expected);
    expect(collisionsFrom(CORPUS.mixed)).toEqual(collisionsFrom(CORPUS.mixed));
  });

  it("does not mutate its input", () => {
    const before = JSON.parse(JSON.stringify(CORPUS.mixed));
    collisionsFrom(CORPUS.mixed);
    expect(CORPUS.mixed).toEqual(before);
  });
});
