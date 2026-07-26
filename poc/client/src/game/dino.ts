import { LANE_WIDTH, type GameEngine } from "./engine";
export { LANE_WIDTH };
export const DINO_X = 4;
const SPEED = 14;       // columns / second
const GRAVITY = 30;     // rows / s²
const JUMP_V = 9;       // rows / s

export interface DinoState {
  t: number;
  y: number;
  vy: number;
  obstacles: number[];
  nextGap: number;
  rng: number;
  score: number;
  alive: boolean;
}

export function initialState(seed = 1): DinoState {
  return {
    t: 0, y: 0, vy: 0, obstacles: [], nextGap: 18,
    rng: seed >>> 0 || 1, score: 0, alive: true,
  };
}

const lcg = (r: number): number => (r * 1664525 + 1013904223) >>> 0;

export function jump(s: DinoState): DinoState {
  return s.alive && s.y === 0 ? { ...s, vy: JUMP_V } : s;
}

export function tick(s: DinoState, dt: number): DinoState {
  if (!s.alive) return s;
  const t = s.t + dt;
  let vy = s.vy - GRAVITY * dt;
  let y = s.y + vy * dt;
  if (y <= 0) { y = 0; vy = 0; }
  const dx = SPEED * dt;
  let obstacles = s.obstacles.map((x) => x - dx).filter((x) => x > -2);
  let { nextGap, rng } = s;
  nextGap -= dx;
  if (nextGap <= 0) {
    rng = lcg(rng);
    obstacles = [...obstacles, LANE_WIDTH + 2];
    nextGap = 12 + (rng % 14);
  }
  const hit = obstacles.some((x) => Math.abs(x - DINO_X) < 1 && y < 1);
  return {
    t, y, vy, obstacles, nextGap, rng,
    score: Math.floor(t * 10),
    alive: !hit,
  };
}

export function renderLane(s: DinoState): [string, string] {
  const air = Array<string>(LANE_WIDTH).fill(" ");
  const ground = Array<string>(LANE_WIDTH).fill(" ");
  for (const x of s.obstacles) {
    const c = Math.round(x);
    if (c >= 0 && c < LANE_WIDTH) ground[c] = "▲";
  }
  const sprite = s.alive ? "ᗢ" : "✖";
  if (s.y >= 1) air[DINO_X] = sprite;
  else ground[DINO_X] = sprite;
  return [air.join(""), ground.join("")];
}

export const dinoEngine: GameEngine<DinoState> = {
  key: "dino",
  label: "DINO RUN",
  rows: 2,
  init: (seed) => initialState(seed),
  tick,
  input: (s, key) => (key === " " || key === "click" ? jump(s) : s),
  render: (s) => {
    const [air, ground] = renderLane(s);
    return [air, ground];
  },
  score: (s) => s.score,
  over: (s) => !s.alive,
  hint: (_s, playing) =>
    playing
      ? "SPACE jump · click the prompt to type instead"
      : "SPACE (or click the lane) to play while you wait",
};
