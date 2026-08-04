import { describe, it, expect } from "vitest";
import { LANE_WIDTH } from "./engine";
import {
  tetrisEngine, initialState, tick, input, stepDown, spawn, rotate,
  collides, WELL_W, WELL_H, TETRIS_ROWS,
  type TetrisState, type Piece,
} from "./tetris";

const emptyWell = (): (Piece | null)[][] =>
  Array.from({ length: WELL_H }, () => Array<Piece | null>(WELL_W).fill(null));

/** A fully-specified state, so no test depends on a random draw. */
const st = (over: Partial<TetrisState> = {}): TetrisState => ({
  well: emptyWell(),
  active: spawn("O"),
  bag: ["I"],
  next: "T",
  dropAcc: 0,
  lines: 0,
  score: 0,
  alive: true,
  ...over,
});

const shape = (s: TetrisState) => {
  const rows = tetrisEngine.render(s);
  expect(rows).toHaveLength(TETRIS_ROWS);
  for (const r of rows) expect(r).toHaveLength(LANE_WIDTH);
};

/** absolute occupied cells of the active piece, sorted for stable compares */
const abs = (s: TetrisState) =>
  s.active!.cells
    .map(([cx, cy]) => [s.active!.x + cx, s.active!.y + cy])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe("tetris", () => {
  it("renders exactly `rows` rows of LANE_WIDTH chars — fresh, mid-run, and dead", () => {
    shape(initialState());
    shape(st({ lines: 27, score: 4200 }));
    shape(st({ alive: false, active: null }));
  });

  it("moves left and right but clamps at the walls", () => {
    const s = st({ active: { ...spawn("O"), x: 0 } });
    expect(input(s, "ArrowLeft").active!.x).toBe(0); // clamped
    expect(input(s, "ArrowRight").active!.x).toBe(1);
    const right = st({ active: { ...spawn("O"), x: WELL_W - 2 } });
    expect(input(right, "ArrowRight").active!.x).toBe(WELL_W - 2); // clamped
  });

  it("ignores unknown keys and leaves a dead state inert", () => {
    const s = st();
    expect(input(s, "q")).toBe(s);
    const dead = st({ alive: false, active: null });
    expect(tick(dead, 0.05)).toBe(dead);
  });

  it("rotates in place, but rejects a rotation that cannot fit even kicked", () => {
    const free = st({ active: { ...spawn("T"), x: 4, y: 5 } });
    expect(input(free, "ArrowUp").active!.cells).toEqual(rotate(free.active!.cells, 3));
    // a flat I resting on the floor has no room to stand up — kicks are lateral
    const onFloor = st({ active: { ...spawn("I"), y: WELL_H - 2 } });
    expect(input(onFloor, "ArrowUp").active!.cells).toEqual(spawn("I").cells); // unchanged
  });

  it("rotation pivots in place — no sideways or upward jump (bug 1)", () => {
    // S spawns on cols 3-5; SRS keeps its first rotation on cols 4-5, same rows+1
    const s = st({ active: { ...spawn("S"), x: 3, y: 5 } });
    expect(abs(input(s, "ArrowUp"))).toEqual([[4, 5], [4, 6], [5, 6], [5, 7]]);
    // vertical I stands up through the column of its own box — x never drifts
    const i = st({ active: { ...spawn("I"), y: 3 } });
    expect(abs(input(i, "ArrowUp"))).toEqual([[5, 3], [5, 4], [5, 5], [5, 6]]);
    // four quarter turns are the identity
    let cur = st({ active: { ...spawn("T"), x: 4, y: 5 } });
    const before = cur.active!.cells;
    for (let k = 0; k < 4; k++) cur = input(cur, "ArrowUp");
    expect(cur.active!.cells).toEqual(before);
  });

  it("kicks off the wall instead of refusing to rotate (bug 2)", () => {
    let s = st({ active: { ...spawn("I"), y: 3 } });
    s = input(s, "ArrowUp"); // vertical, box column 2
    s = { ...s, active: { ...s.active!, x: WELL_W - 3 } }; // hugging the right wall (col 9)
    const r = input(s, "ArrowUp"); // plain rotation would need cols 7-10
    expect(r.active!.x).toBe(WELL_W - 4); // kicked one cell left
    expect(abs(r)).toEqual([[6, 5], [7, 5], [8, 5], [9, 5]]);
  });

  it("locking partly above the well is a lock-out, not a silent erasure (bug 3)", () => {
    const well = emptyWell();
    well[3][5] = "I"; // stack right under the spawn column
    let s = st({ well, active: spawn("I") });
    s = input(s, "ArrowUp"); // vertical I: col 5, rows -1..2
    const after = stepDown(s); // cannot fall — locks with a cell above the well
    expect(after.alive).toBe(false);
    expect(tetrisEngine.over(after)).toBe(true);
    expect([0, 1, 2].every((y) => after.well[y][5] === "I")).toBe(true); // in-well part shown
  });

  it("a lag spike locks at most one piece; the fresh piece keeps its full interval (bug 4)", () => {
    const s = st({ active: { ...spawn("O"), y: WELL_H - 2 } }); // resting on the floor
    const after = tick(s, 5); // ~6 gravity intervals of lag in one frame
    expect(after.active!.kind).toBe("T"); // exactly one lock happened
    expect(after.active!.y).toBe(0); // fresh piece has not been stepped…
    expect(after.dropAcc).toBe(0); // …and starts with a full gravity interval
  });

  it("locks on failed gravity and clears a completed row with the level multiplier", () => {
    const well = emptyWell();
    // bottom row full except the two columns the O-piece will fill
    for (let x = 0; x < WELL_W; x++) if (x !== 4 && x !== 5) well[WELL_H - 1][x] = "I";
    const s = st({ well, active: { ...spawn("O"), x: 4, y: WELL_H - 2 }, lines: 0 });
    const after = stepDown(s);
    expect(after.lines).toBe(1);
    expect(after.score).toBe(40); // 40 × (level 0 + 1)
    expect(after.well[WELL_H - 1].every((c) => c === null)).toBe(false); // O's upper half fell in
    expect(after.active!.kind).toBe("T"); // `next` became active
  });

  it("clamps the score at the server's 99999 ceiling", () => {
    const well = emptyWell();
    for (let x = 0; x < WELL_W; x++) if (x !== 4 && x !== 5) well[WELL_H - 1][x] = "I";
    const s = st({ well, active: { ...spawn("O"), x: 4, y: WELL_H - 2 }, score: 99990 });
    expect(tetrisEngine.score(stepDown(s))).toBe(99999);
  });

  it("hard-drops to the floor and locks", () => {
    const s = st({ active: { ...spawn("O"), x: 3, y: 0 } });
    const after = input(s, " ");
    expect(after.well[WELL_H - 1][3]).not.toBeNull();
    expect(after.well[WELL_H - 2][3]).not.toBeNull();
  });

  it("ends the run when a fresh piece cannot spawn", () => {
    const well = emptyWell();
    // cover the spawn columns on the top two rows without filling either row
    for (let x = 0; x < WELL_W - 1; x++) { well[0][x] = "I"; well[1][x] = "I"; }
    const s = st({ well, active: { ...spawn("O"), x: 0, y: WELL_H - 2 } });
    const after = stepDown(s);
    expect(after.alive).toBe(false);
    expect(tetrisEngine.over(after)).toBe(true);
  });

  it("gravity steps the piece down over time without locking mid-well", () => {
    const s = st({ active: { ...spawn("O"), x: 4, y: 0 } });
    let cur = s;
    for (let i = 0; i < 60; i++) cur = tick(cur, 0.05); // 3 seconds
    expect(cur.active!.y).toBeGreaterThan(0);
    expect(cur.alive).toBe(true);
  });

  it("never lets a piece overlap the stack", () => {
    const well = emptyWell();
    well[WELL_H - 1][4] = "I";
    const p = { ...spawn("O"), x: 4, y: WELL_H - 4 };
    expect(collides(well, p, 0, 1)).toBe(false);
    expect(collides(well, p, 0, 2)).toBe(true);
  });
});
