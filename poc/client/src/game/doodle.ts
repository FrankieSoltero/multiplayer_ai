import { LANE_WIDTH, lcg, type GameEngine } from "./engine";

export const DOODLE_ROWS = 20;
export const PLAT_W = 5;

const GRAVITY = 34; // rows / s²
const BOUNCE_V = 17; // rows / s — upward impulse on contact
/** Terminal cells are ~2× taller than wide, so horizontal travel needs roughly
 *  double the rate to feel isotropic (snake.ts makes the same correction). */
const MOVE_SPEED = 26; // cols / s

/** Physics advances in fixed sub-steps; tick() consumes real dt through an
 *  accumulator and carries the remainder in state. Tuning constants below are
 *  therefore properties of SIM_DT, not of the viewer's frame rate. */
const SIM_DT = 1 / 120;
/** Hard cap on one frame's dt (tab restore, debugger pause): ≤ 30 sub-steps. */
const MAX_FRAME_DT = 0.25;
/** Terminal fall speed. Also bounds per-sub-step travel to 0.25 rows, so one
 *  sub-step can never span two platforms (min gap 2.2). */
const MAX_FALL = 30; // rows / s

/** Player rises above this line from the view bottom → the camera follows. */
const SCROLL_LINE = DOODLE_ROWS - DOODLE_ROWS / 3;
const GAP_MIN = 2.2;
/** Must stay below the DISCRETE bounce apex at SIM_DT:
 *  BOUNCE_V²/(2·GRAVITY) − BOUNCE_V·SIM_DT/2 ≈ 4.25 − 0.07 ≈ 4.18 rows —
 *  machine-independent now that the sim is fixed-step. */
const GAP_MAX = 3.6;
const MAX_SCORE = 99999; // server MAX_GAME_SCORE

export interface Platform {
  x: number;
  /** world altitude, increasing upward */
  y: number;
}

export interface DoodleState {
  /** column, 0 ≤ x < LANE_WIDTH, wraps */
  x: number;
  /** world altitude, increasing upward */
  y: number;
  vy: number;
  /** steer direction; keydown-only input, so it persists until changed */
  dir: -1 | 0 | 1;
  /** world altitude at the BOTTOM of the visible band */
  cam: number;
  platforms: Platform[];
  /** high-water altitude — the score */
  best: number;
  alive: boolean;
  /** unconsumed sim time carried between frames (fixed-timestep remainder) */
  acc: number;
  /** seeded PRNG state — ALL generation randomness flows through this */
  rng: number;
}

/** Advance the PRNG once → [uniform in [0,1), next state]. */
const rand = (r: number): [number, number] => {
  const n = lcg(r);
  return [n / 0x1_0000_0000, n];
};

/** Extend `platforms` upward until the topmost one is above `ceiling`. `floor`
 *  is where generation starts when the list is empty or entirely below it —
 *  callers pass the TOP of the visible band so a platform can never pop into
 *  view underneath the player. Threads the PRNG state through. */
function generate(
  platforms: Platform[],
  floor: number,
  ceiling: number,
  rng: number,
): { platforms: Platform[]; rng: number } {
  const out = [...platforms];
  let top = out.reduce((m, p) => Math.max(m, p.y), floor);
  let u: number;
  while (top < ceiling) {
    [u, rng] = rand(rng);
    top += GAP_MIN + u * (GAP_MAX - GAP_MIN);
    [u, rng] = rand(rng);
    out.push({ x: Math.floor(u * (LANE_WIDTH - PLAT_W + 1)), y: top });
  }
  return { platforms: out, rng };
}

export function initialState(seed = 1): DoodleState {
  const g = generate([{ x: 8, y: 1 }], 1, DOODLE_ROWS * 2, lcg(seed >>> 0));
  return {
    x: 10, y: 2, vy: 0, dir: 0, cam: 0,
    platforms: g.platforms, best: 2, alive: true,
    acc: 0, rng: g.rng,
  };
}

/** One fixed-length physics sub-step. Pure; never touches acc/rng/generation. */
function step(s: DoodleState): DoodleState {
  let vy = Math.max(s.vy - GRAVITY * SIM_DT, -MAX_FALL);
  let y = s.y + vy * SIM_DT;
  const dx = s.dir * MOVE_SPEED * SIM_DT;
  let x = s.x + dx;

  // Bounce only while descending across a platform's top edge — a rising
  // player passes straight through, which is what makes the game work.
  if (vy < 0) {
    // Swept, ordered collision: of all platform tops crossed this sub-step,
    // resolve against the FIRST along the fall (highest y), and test the
    // player's column AT THE CROSSING INSTANT, not at the step endpoint.
    let hit: Platform | null = null;
    for (const p of s.platforms) {
      if (s.y >= p.y && y <= p.y && (hit === null || p.y > hit.y)) {
        const t = (s.y - p.y) / (s.y - y); // fraction of the step at crossing
        let cx = s.x + dx * t;
        cx = ((cx % LANE_WIDTH) + LANE_WIDTH) % LANE_WIDTH;
        const col = Math.floor(cx);
        if (col >= p.x && col < p.x + PLAT_W) hit = p;
      }
    }
    if (hit) {
      y = hit.y;
      vy = BOUNCE_V;
    }
  }

  if (x < 0) x += LANE_WIDTH;
  if (x >= LANE_WIDTH) x -= LANE_WIDTH;

  const cam = y - s.cam > SCROLL_LINE ? y - SCROLL_LINE : s.cam;
  return { ...s, x, y, vy, cam };
}

export function tick(s: DoodleState, dt: number): DoodleState {
  if (!s.alive) return s;

  // `?? 0` / `== null`: hydration for snapshots persisted before acc/rng
  // existed. Hosts syncing old sessions should seed rng from the session seed.
  let acc = (s.acc ?? 0) + Math.min(Math.max(dt, 0), MAX_FRAME_DT);
  let cur: DoodleState = s.rng == null ? { ...s, rng: lcg(1) } : s;

  while (acc >= SIM_DT) {
    cur = step(cur);
    acc -= SIM_DT;
  }

  const g = generate(
    cur.platforms.filter((p) => p.y >= cur.cam - 1),
    cur.cam + DOODLE_ROWS, // never generate inside the visible band
    cur.cam + DOODLE_ROWS * 2,
    cur.rng,
  );

  return {
    ...cur,
    // acc written AFTER the spread of `cur` (which still carries the stale
    // pre-frame value) — the classic accumulator-merge race, closed here.
    acc,
    platforms: g.platforms,
    rng: g.rng,
    best: Math.max(s.best, cur.y),
    alive: cur.y >= cur.cam - 1,
  };
}

export function input(s: DoodleState, key: string): DoodleState {
  if (!s.alive) return s;
  if (key === "ArrowLeft") return { ...s, dir: -1 };
  if (key === "ArrowRight") return { ...s, dir: 1 };
  if (key === "ArrowDown" || key === "ArrowUp") return { ...s, dir: 0 };
  return s;
}

export function renderView(s: DoodleState): string[] {
  const rows = Array.from({ length: DOODLE_ROWS }, () =>
    Array<string>(LANE_WIDTH).fill(" "),
  );
  const rowOf = (y: number) => DOODLE_ROWS - 1 - Math.round(y - s.cam);

  for (const p of s.platforms) {
    const r = rowOf(p.y);
    if (r < 0 || r >= DOODLE_ROWS) continue;
    for (let i = 0; i < PLAT_W; i++) {
      const c = p.x + i;
      if (c >= 0 && c < LANE_WIDTH) rows[r][c] = "▔";
    }
  }

  const pr = rowOf(s.y);
  const pc = Math.floor(s.x);
  if (pr >= 0 && pr < DOODLE_ROWS && pc >= 0 && pc < LANE_WIDTH) {
    rows[pr][pc] = s.alive ? "@" : "✖";
  }
  return rows.map((r) => r.join(""));
}

export const doodleEngine: GameEngine<DoodleState> = {
  key: "doodlejump",
  label: "DOODLE JUMP",
  rows: DOODLE_ROWS,
  init: initialState,
  tick,
  input,
  render: renderView,
  score: (s) => Math.min(MAX_SCORE, Math.floor(s.best)),
  over: (s) => !s.alive,
  hint: (_s, playing) =>
    playing
      ? "← → STEER · ↓ STOP · bouncing is automatic"
      : "SPACE to play · ← → steer, bouncing is automatic",
};
