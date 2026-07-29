import { describe, it, expect } from "vitest";
import { initialState, tick, type DoodleState } from "./doodle";

// Mirrors of doodle.ts tuning (not exported): BOUNCE_V=17, GAP_MAX=3.6, MAX_FALL=30.
const BOUNCE_V = 17;
const GAP_MAX = 3.6;

const st = (over: Partial<DoodleState> = {}): DoodleState =>
  ({
    x: 10, y: 5, vy: 0, dir: 0, cam: 0,
    platforms: [{ x: 8, y: 3 }],
    best: 5, alive: true,
    acc: 0, rng: 42,
    ...over,
  }) as DoodleState;

/** 144 / 60 / 30 fps, plus 0.1 s — a hitchy machine at the host's dt clamp. */
const CADENCES = [1 / 144, 1 / 60, 1 / 30, 0.1];

const apexAt = (dt: number): number => {
  let s = st({ y: 0, vy: BOUNCE_V, platforms: [], best: 0 });
  let apex = 0;
  for (let t = 0; t < 1.5; t += dt) {
    s = tick(s, dt);
    apex = Math.max(apex, s.y);
  }
  return apex;
};

describe("regressions: frame-rate-dependent physics", () => {
  // KILLS: variable-dt Euler in tick() — on old code apex(0.1) ≈ 3.40 < GAP_MAX.
  it("the max generated gap is reachable at every frame cadence", () => {
    for (const dt of CADENCES) {
      expect(apexAt(dt)).toBeGreaterThan(GAP_MAX + 0.2);
    }
  });

  // KILLS: same line — old apexes range 4.19 → 3.40 across cadences.
  it("jump apex is cadence-independent (±0.1 row)", () => {
    const apexes = CADENCES.map(apexAt);
    expect(Math.max(...apexes) - Math.min(...apexes)).toBeLessThan(0.1);
  });

  // KILLS: unclamped `vy = s.vy - GRAVITY*dt` — old code has no terminal velocity.
  it("fall speed is clamped to a terminal velocity", () => {
    let s = st({ y: 500, platforms: [] });
    for (let i = 0; i < 120; i++) s = tick(s, 1 / 60);
    expect(s.vy).toBeGreaterThanOrEqual(-30);
  });

  // Guard for the accumulator: many sub-SIM_DT frames must still integrate.
  it("carries the sub-step remainder across tiny-dt frames", () => {
    let s = st({ y: 50, platforms: [] });
    for (let i = 0; i < 250; i++) s = tick(s, 0.002); // 0.5 s total
    expect(s.y).toBeLessThan(47); // ~½·g·t² ≈ 4.25 rows fallen
  });
});

describe("regressions: swept collision", () => {
  // KILLS: `for (const p of s.platforms) … break` first-in-array resolution.
  // generate() appends bottom-up, so the LOWER platform sits first in the array.
  it("lands on the first platform along the fall, not the first in the array", () => {
    let s = st({ y: 6.5, vy: -80, x: 9, platforms: [{ x: 8, y: 3 }, { x: 8, y: 6 }] });
    s = tick(s, 0.05);
    expect(s.vy).toBeGreaterThan(0); // it bounced…
    expect(s.y).toBeGreaterThan(4.5); // …off y=6, not the platform 3 rows below
  });

  // KILLS: `const col = Math.floor(x)` endpoint sampling. The top edge is crossed
  // while over cols 8..12, but the frame ENDS past the right edge (col 13).
  it("does not skim through a platform edge at full horizontal speed", () => {
    let s = st({ x: 12.5, y: 3.02, vy: -2, dir: 1, platforms: [{ x: 8, y: 3 }] });
    s = tick(s, 0.05);
    expect(s.vy).toBeGreaterThan(0);
  });
});

describe("regressions: engine purity (seeded generation)", () => {
  // KILLS: Math.random in platX()/gap() — old initialState ignores its seed.
  it("initialState is deterministic for a given seed", () => {
    expect(JSON.stringify(initialState(7).platforms)).toBe(
      JSON.stringify(initialState(7).platforms),
    );
    expect(
      JSON.stringify(initialState(7).platforms) ===
        JSON.stringify(initialState(8).platforms),
    ).toBe(false);
  });

  // KILLS: Math.random inside tick()'s generate() call.
  it("a full run is reproducible: same seed + same inputs ⇒ same states", () => {
    const run = () => {
      let s = initialState(123);
      for (let i = 0; i < 300; i++) s = tick(s, 1 / 60);
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
});
