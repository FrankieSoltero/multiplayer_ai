import { describe, it, expect } from "vitest";
import { initialState, tick, steer, renderGrid, snakeEngine, SNAKE_ROWS, type SnakeState } from "./snake";
import { LANE_WIDTH } from "./engine";

const run = (s: SnakeState, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) s = tick(s, 1 / 60);
  return s;
};
// keep the food out of the head's row so movement tests are seed-independent
const noFood = (s: SnakeState): SnakeState => ({ ...s, food: [0, 0] });

describe("snake", () => {
  it("is deterministic for a given seed", () => {
    expect(run(initialState(7), 1)).toEqual(run(initialState(7), 1));
  });

  it("advances right at ~8 cells/s from the start", () => {
    const s = run(noFood(initialState(1)), 1);
    expect(s.alive).toBe(true);
    expect(s.body[0][1]).toBe(2);
    expect(s.body[0][0]).toBeGreaterThanOrEqual(15); // started at x=8
    expect(s.body[0][0]).toBeLessThanOrEqual(17);
  });

  it("steers but never reverses into itself", () => {
    let s = noFood(initialState(1));
    s = steer(s, "ArrowUp");
    expect(s.pendingDir).toEqual([0, -1]);
    s = steer(s, "ArrowLeft"); // reverse of current dir [1,0] — ignored
    expect(s.pendingDir).toEqual([0, -1]);
  });

  it("eats food ahead, grows, and scores 10 per food", () => {
    let s: SnakeState = { ...initialState(1), food: [10, 2] }; // head starts [8,2] moving right
    const len = s.body.length;
    s = run(s, 0.5);
    expect(s.eaten).toBe(1);
    expect(snakeEngine.score(s)).toBe(10);
    expect(s.body.length).toBe(len + 1);
  });

  it("dies at the wall and the dead state is inert", () => {
    const s = run(noFood(initialState(1)), 6); // 8 cells/s from x=8 hits x=39 well inside 6s
    expect(s.alive).toBe(false);
    expect(snakeEngine.over(s)).toBe(true);
    expect(tick(s, 1 / 60)).toEqual(s);
  });

  it("dies on self collision", () => {
    let s: SnakeState = {
      ...noFood(initialState(1)),
      body: [[5, 2], [4, 2], [4, 3], [5, 3], [6, 3]],
    };
    s = steer(s, "ArrowDown"); // next cell [5,3] is body (and not the vacating tail)
    s = tick(s, 0.3); // one vertical step at base speed (stepTime 0.25s)
    expect(s.alive).toBe(false);
  });

  it("speeds up as it eats", () => {
    const base = run(noFood(initialState(1)), 0.5);
    const fed = run({ ...noFood(initialState(1)), eaten: 10 }, 0.5); // 13 cells/s
    expect(fed.body[0][0]).toBeGreaterThan(base.body[0][0]);
  });

  it("renders SNAKE_ROWS fixed-width rows with food and body glyphs", () => {
    const rows = renderGrid(initialState(1));
    expect(rows).toHaveLength(SNAKE_ROWS);
    for (const r of rows) expect(r).toHaveLength(LANE_WIDTH);
    expect(rows.join("")).toContain("●");
    expect(rows[2][8]).toBe("█"); // head start position
  });

  it("steps vertically at half the cell rate so on-screen speed matches horizontal", () => {
    // terminal cells are ~2× taller than wide; vertical steps take 2× as long
    let s = steer(noFood(initialState(1)), "ArrowUp"); // head [8,2], base 8 cells/s
    s = run(s, 0.45); // vertical stepTime 0.25s → exactly one step (y 2→1)
    expect(s.alive).toBe(true); // unscaled 8 c/s would take 3 steps and die at the top wall
    expect(s.body[0][1]).toBe(1);
  });

  it("applies the post-eat speed to later steps within the same tick", () => {
    let s: SnakeState = { ...initialState(1), food: [9, 2] }; // one step ahead of the head at [8,2]
    s = tick(s, 0.245); // step 1 eats at 0.125s; remaining 0.120s ≥ 1/8.5 ≈ 0.1176s only under the new speed
    expect(s.eaten).toBe(1);
    expect(s.body[0][0]).toBe(10); // stale-speed code would stop at 9
  });
});
