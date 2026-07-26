import { describe, it, expect } from "vitest";
import {
  initialState, stateFor, tick, press, wpmScore, renderRows,
  typeRaceEngine, PHRASES, TYPE_ROWS,
} from "./typerace";
import { LANE_WIDTH } from "./engine";

describe("typerace", () => {
  it("picks a phrase deterministically from the seed, all phrases fit the lane", () => {
    expect(initialState(7).phrase).toBe(initialState(7).phrase);
    expect(PHRASES).toContain(initialState(7).phrase);
    for (const p of PHRASES) expect(p.length).toBeLessThanOrEqual(LANE_WIDTH);
  });

  it("advances on correct keys, counts misses, completes", () => {
    let s = stateFor("ab c");
    s = press(s, "a");
    expect(s.pos).toBe(1);
    s = press(s, "x");
    expect(s).toMatchObject({ pos: 1, misses: 1 });
    s = press(press(press(s, "b"), " "), "c");
    expect(s.done).toBe(true);
    expect(typeRaceEngine.over(s)).toBe(true);
  });

  it("ignores non-printable keys and input after completion", () => {
    let s = stateFor("a");
    expect(press(s, "ArrowLeft")).toEqual(s);
    s = press(s, "a");
    expect(press(s, "a")).toEqual(s);
  });

  it("clock starts on the first hit; score follows the spec formula", () => {
    let s = stateFor("hello world again ok"); // 20 chars
    s = tick(s, 5);
    expect(s.elapsed).toBe(0); // no keys yet — clock not started
    for (const ch of "hello world again ok") s = press(tick(s, 1.5), ch);
    expect(s.done).toBe(true);
    expect(s.elapsed).toBeCloseTo(28.5); // 19 ticks of 1.5s after the first hit
    // WPM = (20/5) / (28.5/60) = 8.42 → round 8; no misses → max(1, 8) = 8
    expect(wpmScore(s)).toBe(8);
    expect(wpmScore({ ...s, misses: 3 })).toBe(2); // 8 − 6
    expect(wpmScore({ ...s, misses: 10 })).toBe(1); // floor at 1 when done
  });

  it("renders TYPE_ROWS fixed-width rows with a caret while typing", () => {
    const rows = renderRows(stateFor("abc"));
    expect(rows).toHaveLength(TYPE_ROWS);
    for (const r of rows) expect(r).toHaveLength(LANE_WIDTH);
    expect(rows[1][0]).toBe("▌");
  });
});
