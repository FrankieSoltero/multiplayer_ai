import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Collision, CollisionInput } from "multiplayer-ai-server/collisions";
import { contestedCountFor, projectCollisions, sharedWith } from "./collisionView";
import type { ProjectSessionInfo } from "./types";

/** The adapter's contract is "map the snapshot row, then DELEGATE" — so the
 *  suite has to see the argument that crossed the boundary, not just the
 *  result. `collisionsFrom` ignores `lifecycle` entirely, so no assertion on
 *  the OUTPUT can pin `lifecycle ?? "open"`; only the captured input can.
 *  The spy calls the real implementation through, so every other assertion in
 *  this file still runs against genuine `collisionsFrom` behaviour. */
const { inputCalls } = vi.hoisted(() => ({ inputCalls: [] as CollisionInput[][] }));

vi.mock("multiplayer-ai-server/collisions", async (importOriginal) => {
  const mod = await importOriginal<typeof import("multiplayer-ai-server/collisions")>();
  return {
    ...mod,
    collisionsFrom: (sessions: CollisionInput[]): Collision[] => {
      inputCalls.push(sessions);
      return mod.collisionsFrom(sessions);
    },
  };
});

/** The unmocked module, for the delegation deep-equal: the adapter's output is
 *  compared against what a direct `collisionsFrom` call on the mapped inputs
 *  returns, so any reimplementation of the intersection shows up as a diff. */
const real = await vi.importActual<typeof import("multiplayer-ai-server/collisions")>(
  "multiplayer-ai-server/collisions",
);

/** The client's snapshot row is FLAT (`poc/client/src/types.ts`) — no `facts`
 *  wrapper — so fixtures are built from the row type the sockets actually
 *  deliver. */
const row = (over: Partial<ProjectSessionInfo> & { id: string }): ProjectSessionInfo => ({
  participants: [],
  driverName: null,
  intent: null,
  lastActivityTs: null,
  ended: false,
  ...over,
});

beforeEach(() => {
  inputCalls.length = 0;
});

describe("projectCollisions", () => {
  it("maps snapshot rows and delegates to collisionsFrom", () => {
    const sessions = [
      row({ id: "s1", repoKey: "acme/api", touched: ["src/a.ts", "src/b.ts"] }),
      row({ id: "s2", repoKey: "acme/api", lifecycle: "closed", touched: ["src/b.ts"] }),
      row({ id: "s3", repoKey: "acme/web", touched: ["src/b.ts"] }),
    ];

    const result = projectCollisions(sessions);

    // Non-empty, or the deep-equal below would pass on `[] === []`.
    expect(result).toHaveLength(1);
    expect(result).toEqual(
      real.collisionsFrom([
        { sessionId: "s1", repoKey: "acme/api", lifecycle: "open", touched: ["src/a.ts", "src/b.ts"] },
        { sessionId: "s2", repoKey: "acme/api", lifecycle: "closed", touched: ["src/b.ts"] },
        { sessionId: "s3", repoKey: "acme/web", lifecycle: "open", touched: ["src/b.ts"] },
      ]),
    );
    // Delegated exactly once — not reimplemented, not called per session.
    expect(inputCalls).toHaveLength(1);
  });

  it("pins the CollisionInput[] handed to collisionsFrom", () => {
    projectCollisions([
      row({ id: "s1", repoKey: "r", lifecycle: "closed", touched: ["a.ts"] }),
      row({ id: "s2", repoKey: "r", touched: ["a.ts"] }),
      row({ id: "s3", repoKey: "r" }),
    ]);

    expect(inputCalls).toHaveLength(1);
    expect(inputCalls[0]).toStrictEqual([
      { sessionId: "s1", repoKey: "r", lifecycle: "closed", touched: ["a.ts"] },
      { sessionId: "s2", repoKey: "r", lifecycle: "open", touched: ["a.ts"] },
      { sessionId: "s3", repoKey: "r", lifecycle: "open", touched: null },
    ]);
  });

  it("maps an absent repoKey to null", () => {
    projectCollisions([row({ id: "s1", touched: ["a.ts"] }), row({ id: "s2", repoKey: null })]);

    expect(inputCalls[0]).toStrictEqual([
      { sessionId: "s1", repoKey: null, lifecycle: "open", touched: ["a.ts"] },
      { sessionId: "s2", repoKey: null, lifecycle: "open", touched: null },
    ]);
  });

  it("tolerates a row from an older peer that carries no touched", () => {
    const sessions = [
      row({ id: "s1", repoKey: "r", touched: ["a.ts"] }),
      row({ id: "s2", repoKey: "r" }),
    ];

    expect(() => projectCollisions(sessions)).not.toThrow();
    // A session with no `touched` contributes nothing, so `a.ts` is uncontested.
    expect(projectCollisions(sessions)).toEqual([]);
    expect(inputCalls[1]?.[1]).toStrictEqual({
      sessionId: "s2",
      repoKey: "r",
      lifecycle: "open",
      touched: null,
    });
  });

  it("returns [] when live rows share no path", () => {
    // Discriminating: rows ARE present and DO carry touched — they simply sit
    // in different repos, so nothing collides.
    expect(
      projectCollisions([
        row({ id: "s1", repoKey: "acme/api", touched: ["src/a.ts"] }),
        row({ id: "s2", repoKey: "acme/web", touched: ["src/a.ts"] }),
      ]),
    ).toEqual([]);
  });
});

/** Deliberately NOT in `collisionsFrom` order (`c.ts` precedes `a.ts`) so the
 *  ascending guarantee in `sharedWith` is asserted, not inherited. */
const collisions: Collision[] = [
  { repoKey: "r", path: "src/b.ts", sessionIds: ["s1", "s3"] },
  { repoKey: "r", path: "src/c.ts", sessionIds: ["s1", "s2"] },
  { repoKey: "r", path: "src/a.ts", sessionIds: ["s1", "s2"] },
  { repoKey: "r", path: "src/d.ts", sessionIds: ["s2", "s3"] },
];

describe("contestedCountFor", () => {
  it("counts the distinct paths involving that session", () => {
    expect(contestedCountFor("s1", collisions)).toBe(3);
    expect(contestedCountFor("s2", collisions)).toBe(3);
    expect(contestedCountFor("s3", collisions)).toBe(2);
  });

  it("is 0 for a session in none of them", () => {
    expect(contestedCountFor("s4", collisions)).toBe(0);
    expect(contestedCountFor("s1", [])).toBe(0);
  });
});

describe("sharedWith", () => {
  it("returns every path both sessions touch, ascending", () => {
    expect(sharedWith("s1", "s2", collisions)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(sharedWith("s2", "s1", collisions)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(sharedWith("s2", "s3", collisions)).toEqual(["src/d.ts"]);
  });

  it("returns [] for an unrelated pair", () => {
    expect(sharedWith("s1", "s4", collisions)).toEqual([]);
    expect(sharedWith("s1", "s2", [])).toEqual([]);
  });
});
