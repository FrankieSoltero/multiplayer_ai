import { LANE_WIDTH, lcg, type GameEngine } from "./engine";

export const SNAKE_ROWS = 5;
const BASE_SPEED = 8; // cells / second
const SPEED_PER_FOOD = 0.5; // cells / second per food eaten
const MAX_SPEED = 16;

type Cell = [number, number];

export interface SnakeState {
  body: Cell[]; // head first
  dir: Cell; // direction of the last applied step
  pendingDir: Cell; // direction for the next step
  food: Cell;
  moveAcc: number; // seconds accumulated toward the next step
  eaten: number;
  rng: number;
  alive: boolean;
  grow: number; // segments still to add after eating
}

const eq = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1];

function placeFood(rng: number, body: Cell[]): { food: Cell; rng: number } {
  let r = rng;
  for (;;) {
    r = lcg(r);
    const food: Cell = [r % LANE_WIDTH, (r >>> 8) % SNAKE_ROWS];
    if (!body.some((c) => eq(c, food))) return { food, rng: r };
  }
}

export function initialState(seed = 1): SnakeState {
  const body: Cell[] = [[8, 2], [7, 2], [6, 2]];
  const { food, rng } = placeFood(seed >>> 0 || 1, body);
  return {
    body, dir: [1, 0], pendingDir: [1, 0], food,
    moveAcc: 0, eaten: 0, rng, alive: true, grow: 0,
  };
}

const DIRS: Record<string, Cell> = {
  ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
  ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
  ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
};

export function steer(s: SnakeState, key: string): SnakeState {
  const d = DIRS[key];
  if (!d || !s.alive) return s;
  if (d[0] === -s.dir[0] && d[1] === -s.dir[1]) return s; // no reversing
  return { ...s, pendingDir: d };
}

function step(s: SnakeState): SnakeState {
  const head: Cell = [s.body[0][0] + s.pendingDir[0], s.body[0][1] + s.pendingDir[1]];
  if (head[0] < 0 || head[0] >= LANE_WIDTH || head[1] < 0 || head[1] >= SNAKE_ROWS) {
    return { ...s, dir: s.pendingDir, alive: false };
  }
  // the tail cell vacates this step unless we're growing into it
  const occupied = s.grow > 0 ? s.body : s.body.slice(0, -1);
  if (occupied.some((c) => eq(c, head))) {
    return { ...s, dir: s.pendingDir, alive: false };
  }
  let { food, rng, eaten, grow } = s;
  let body = [head, ...s.body];
  if (eq(head, s.food)) {
    eaten += 1;
    grow += 1;
    ({ food, rng } = placeFood(rng, body));
  }
  if (grow > 0) grow -= 1;
  else body = body.slice(0, -1);
  return { ...s, body, dir: s.pendingDir, food, rng, eaten, grow };
}

export function tick(s: SnakeState, dt: number): SnakeState {
  if (!s.alive) return s;
  let acc = s.moveAcc + dt;
  let cur = s;
  for (;;) {
    const speed = Math.min(MAX_SPEED, BASE_SPEED + SPEED_PER_FOOD * cur.eaten);
    const stepTime = 1 / speed;
    if (acc < stepTime || !cur.alive) break;
    acc -= stepTime;
    cur = step(cur);
  }
  return { ...cur, moveAcc: acc };
}

export function renderGrid(s: SnakeState): string[] {
  const rows = Array.from({ length: SNAKE_ROWS }, () => Array<string>(LANE_WIDTH).fill(" "));
  rows[s.food[1]][s.food[0]] = "●";
  for (const [x, y] of s.body) {
    if (x >= 0 && x < LANE_WIDTH && y >= 0 && y < SNAKE_ROWS) rows[y][x] = "█";
  }
  if (!s.alive) {
    const [hx, hy] = s.body[0];
    if (hx >= 0 && hx < LANE_WIDTH && hy >= 0 && hy < SNAKE_ROWS) rows[hy][hx] = "✖";
  }
  return rows.map((r) => r.join(""));
}

export const snakeEngine: GameEngine<SnakeState> = {
  key: "snake",
  label: "SNAKE",
  rows: SNAKE_ROWS,
  init: initialState,
  tick,
  input: steer,
  render: renderGrid,
  score: (s) => s.eaten * 10,
  over: (s) => !s.alive,
  hint: (_s, playing) =>
    playing ? "ARROWS/WASD steer" : "SPACE to start · ARROWS/WASD steer",
};
