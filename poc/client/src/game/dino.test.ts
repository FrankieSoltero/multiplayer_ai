import { describe, it, expect } from "vitest";
import { initialState, jump, tick, renderLane, DINO_X, LANE_WIDTH } from "./dino";

const run = (s: ReturnType<typeof initialState>, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) s = tick(s, 1 / 60);
  return s;
};

describe("dino", () => {
  it("is deterministic for a given seed", () => {
    expect(run(initialState(7), 3)).toEqual(run(initialState(7), 3));
  });

  it("jump arcs up and returns to ground", () => {
    let s = jump(initialState());
    let peaked = 0;
    for (let i = 0; i < 120; i++) {
      s = tick(s, 1 / 60);
      peaked = Math.max(peaked, s.y);
    }
    expect(peaked).toBeGreaterThan(0.5);
    expect(s.y).toBe(0);
  });

  it("dies when an obstacle reaches the dino column on the ground", () => {
    let s = { ...initialState(), obstacles: [DINO_X + 3], nextGap: 999 };
    s = run(s, 1);
    expect(s.alive).toBe(false);
    const frozen = tick(s, 1 / 60);
    expect(frozen).toEqual(s); // dead state is inert
  });

  it("survives the same obstacle when jumping over it", () => {
    let s = { ...initialState(), obstacles: [DINO_X + 4], nextGap: 999 };
    s = jump(s);
    s = run(s, 1);
    expect(s.alive).toBe(true);
  });

  it("score rises with time; renderLane emits two fixed-width rows", () => {
    const s = run(initialState(), 2);
    expect(s.score).toBeGreaterThan(0);
    const [air, ground] = renderLane(s);
    expect(air).toHaveLength(LANE_WIDTH);
    expect(ground).toHaveLength(LANE_WIDTH);
    expect(ground[DINO_X] === "ᗢ" || air[DINO_X] === "ᗢ").toBe(true);
  });
});
