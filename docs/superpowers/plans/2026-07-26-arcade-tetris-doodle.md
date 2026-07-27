# Arcade — Tetris and Doodle Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Type Race cartridge with Tetris and fill the empty fourth arcade slot with Doodle Jump, so all four roster slots carry a real engine.

**Architecture:** Two new pure text-game modules in `poc/client/src/game/`, each implementing the existing `GameEngine` contract from `engine.ts` with no change to that contract and no change to the `ThinkingStrip` host. Both declare `rows: 20` — the host already renders whatever `rows` an engine declares, so a taller lane needs no host work. Then two hand-maintained registries (client roster, server allowlist) are swapped over and the Type Race module is deleted.

**Tech Stack:** TypeScript, React 18 (host only — engines are React-free), Vitest, Vite.

**Spec:** `docs/superpowers/specs/2026-07-26-arcade-tetris-doodle-design.md`

## Global Constraints

- Engines are **pure text modules**: no canvas, no DOM, no React, no imports beyond `./engine`.
- `render(s)` MUST return **exactly `rows` strings, each exactly `LANE_WIDTH` (40) characters**. This is asserted in every engine's test suite and is the single most common way these modules break.
- `tick(s, dt)` must tolerate `dt` up to **0.05s** (the host clamps there, `ThinkingStrip.tsx:130`) and must not assume a fixed frame rate.
- Unknown keys passed to `input` MUST be a no-op returning the same state.
- A dead state must be **inert**: `tick` on a state where `over(s)` is true returns that same state.
- **Neither engine sets `capturesText`.** Both are arrow-driven, so `G` (swap cartridge) keeps working mid-run, matching dino and snake.
- **Shift+Tab must never be captured** (v6a accessibility ruling, `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md:12`). Neither engine binds it.
- Score returned to the host must never exceed **99999** (`MAX_GAME_SCORE` in `poc/server/src/server.ts`) — the server rejects a larger `game_score` outright, which would turn a personal best into an error toast.
- These two engines deliberately use `Math.random()` and are **not** seed-deterministic (spec §3.4). Do NOT add seed-determinism assertions to their suites, and do NOT change the other engines.
- Tests are co-located next to the module (`poc/client/src/game/*.test.ts`), following `dino.test.ts` and `snake.test.ts`.
- Commit only the exact paths listed in each step. Never `git add -A` — the repo root holds untracked user files (`market-research.md`, `poc/demo-plugins/`, `tour-skill-suggest.png`) that must never enter history.

---

### Task 1: Tetris engine

**Files:**
- Create: `poc/client/src/game/tetris.ts`
- Test: `poc/client/src/game/tetris.test.ts`

**Interfaces:**
- Consumes: `LANE_WIDTH` (40) and the `GameEngine<S>` interface from `poc/client/src/game/engine.ts`.
- Produces: `tetrisEngine: GameEngine<TetrisState>` (key `"tetris"`, label `"TETRIS"`, `rows` 20), consumed by Task 3's roster. Also exports, for tests: `TetrisState`, `ActivePiece`, `Piece`, `WELL_W` (10), `WELL_H` (18), `TETRIS_ROWS` (20), `SHAPES`, `normalize`, `rotate`, `spawn`, `collides`, `lockPiece`, `stepDown`, `initialState`, `tick`, `input`, `renderWell`, `level`.

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/game/tetris.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LANE_WIDTH } from "./engine";
import {
  tetrisEngine, initialState, tick, input, stepDown, spawn, rotate,
  normalize, collides, SHAPES, WELL_W, WELL_H, TETRIS_ROWS,
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

  it("rotates, but rejects a rotation that would leave the well", () => {
    const free = st({ active: { ...spawn("T"), x: 4, y: 5 } });
    expect(input(free, "ArrowUp").active!.cells).toEqual(rotate(free.active!.cells));
    // a flat I-piece resting on the floor has no room to stand up
    const iCells = normalize(SHAPES.I);
    const onFloor = st({ active: { kind: "I", cells: iCells, x: 3, y: WELL_H - 1 } });
    expect(input(onFloor, "ArrowUp").active!.cells).toEqual(iCells); // unchanged
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd poc/client && npx vitest run src/game/tetris.test.ts`
Expected: FAIL — `Failed to resolve import "./tetris"`.

- [ ] **Step 3: Write the implementation**

Create `poc/client/src/game/tetris.ts`:

```ts
import { LANE_WIDTH, type GameEngine } from "./engine";

export const WELL_W = 10;
export const WELL_H = 18;
/** 1 top border + playfield + 1 bottom border */
export const TETRIS_ROWS = WELL_H + 2;

/** Terminal cells are ~2× taller than wide (snake.ts compensates in time via
 *  V_ASPECT; Tetris compensates in space): one well cell renders 2 chars wide. */
const CELL = 2;
const HUD_W = LANE_WIDTH - (WELL_W * CELL + 2);
const MAX_SCORE = 99999; // server MAX_GAME_SCORE — a larger score is rejected outright
const BASE_DROP = 0.8; // seconds per gravity step at level 0
const DROP_PER_LEVEL = 0.07;
const MIN_DROP = 0.08;
const LINE_SCORES = [0, 40, 100, 300, 1200] as const;

export type Piece = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

/** Spawn rotation of each tetromino as cells in a 4×4 box. Rotations are
 *  computed, not tabulated — see `rotate`. */
export const SHAPES: Record<Piece, [number, number][]> = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]],
  O: [[1, 0], [2, 0], [1, 1], [2, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
};

export interface ActivePiece {
  kind: Piece;
  /** cells relative to the piece origin, normalized to min x = min y = 0 */
  cells: [number, number][];
  x: number;
  y: number;
}

export interface TetrisState {
  /** [row][col]; null is empty. Row 0 is the top of the well. */
  well: (Piece | null)[][];
  active: ActivePiece | null;
  bag: Piece[];
  next: Piece;
  dropAcc: number;
  lines: number;
  score: number;
  alive: boolean;
}

export function normalize(cells: [number, number][]): [number, number][] {
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]) => [x - minX, y - minY] as [number, number]);
}

/** Clockwise quarter turn inside the piece's own bounding box. No wall kicks:
 *  a rotation that would not fit is simply rejected by `input`. */
export function rotate(cells: [number, number][]): [number, number][] {
  const maxY = Math.max(...cells.map((c) => c[1]));
  return normalize(cells.map(([x, y]) => [maxY - y, x] as [number, number]));
}

const ALL: Piece[] = ["I", "O", "T", "S", "Z", "J", "L"];

/** 7-bag: shuffle all seven, deal until empty, refill. Guarantees no long
 *  droughts without tracking history. Uses Math.random by design — these two
 *  engines are deliberately not seed-deterministic (spec §3.4). */
export function refill(): Piece[] {
  const bag = [...ALL];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

function draw(bag: Piece[]): { kind: Piece; bag: Piece[] } {
  const b = bag.length ? bag : refill();
  return { kind: b[0], bag: b.slice(1) };
}

export function spawn(kind: Piece): ActivePiece {
  const cells = normalize(SHAPES[kind]);
  const w = Math.max(...cells.map((c) => c[0])) + 1;
  return { kind, cells, x: Math.floor((WELL_W - w) / 2), y: 0 };
}

export function collides(
  well: (Piece | null)[][],
  p: ActivePiece,
  dx = 0,
  dy = 0,
  cells: [number, number][] = p.cells,
): boolean {
  return cells.some(([cx, cy]) => {
    const x = p.x + dx + cx;
    const y = p.y + dy + cy;
    if (x < 0 || x >= WELL_W || y >= WELL_H) return true;
    if (y < 0) return false; // above the well is free space
    return well[y][x] !== null;
  });
}

export const level = (s: TetrisState): number => Math.floor(s.lines / 10);

/** Freeze the active piece into the well, clear full rows, and spawn the next
 *  piece. A spawn that collides ends the run. */
export function lockPiece(s: TetrisState): TetrisState {
  if (!s.active) return s;
  const well = s.well.map((r) => [...r]);
  for (const [cx, cy] of s.active.cells) {
    const x = s.active.x + cx;
    const y = s.active.y + cy;
    if (y >= 0 && y < WELL_H && x >= 0 && x < WELL_W) well[y][x] = s.active.kind;
  }
  const kept = well.filter((r) => r.some((c) => c === null));
  const cleared = WELL_H - kept.length;
  while (kept.length < WELL_H) kept.unshift(Array<Piece | null>(WELL_W).fill(null));

  const gained = LINE_SCORES[cleared] * (level(s) + 1);
  const active = spawn(s.next);
  const { kind, bag } = draw(s.bag);
  const alive = !collides(kept, active);

  return {
    well: kept,
    active: alive ? active : null,
    bag,
    next: kind,
    dropAcc: 0,
    lines: s.lines + cleared,
    score: Math.min(MAX_SCORE, s.score + gained),
    alive,
  };
}

export function stepDown(s: TetrisState): TetrisState {
  if (!s.alive || !s.active) return s;
  if (!collides(s.well, s.active, 0, 1)) {
    return { ...s, active: { ...s.active, y: s.active.y + 1 } };
  }
  return lockPiece(s); // immediate lock, no lock delay
}

export function tick(s: TetrisState, dt: number): TetrisState {
  if (!s.alive || !s.active) return s;
  const interval = Math.max(MIN_DROP, BASE_DROP - DROP_PER_LEVEL * level(s));
  let cur = s;
  let acc = s.dropAcc + dt;
  while (acc >= interval && cur.alive && cur.active) {
    acc -= interval;
    cur = stepDown(cur);
  }
  return { ...cur, dropAcc: acc };
}

export function input(s: TetrisState, key: string): TetrisState {
  if (!s.alive || !s.active) return s;
  const a = s.active;
  if (key === "ArrowLeft") {
    return collides(s.well, a, -1, 0) ? s : { ...s, active: { ...a, x: a.x - 1 } };
  }
  if (key === "ArrowRight") {
    return collides(s.well, a, 1, 0) ? s : { ...s, active: { ...a, x: a.x + 1 } };
  }
  if (key === "ArrowDown") return stepDown({ ...s, dropAcc: 0 });
  if (key === "ArrowUp" || key === "click") {
    const cells = rotate(a.cells);
    return collides(s.well, a, 0, 0, cells) ? s : { ...s, active: { ...a, cells } };
  }
  if (key === " ") {
    let cur = s;
    while (cur.active && !collides(cur.well, cur.active, 0, 1)) {
      cur = { ...cur, active: { ...cur.active, y: cur.active.y + 1 } };
    }
    return lockPiece({ ...cur, dropAcc: 0 });
  }
  return s;
}

export function initialState(_seed = 1): TetrisState {
  const first = draw(refill());
  const second = draw(first.bag);
  return {
    well: Array.from({ length: WELL_H }, () => Array<Piece | null>(WELL_W).fill(null)),
    active: spawn(first.kind),
    bag: second.bag,
    next: second.kind,
    dropAcc: 0,
    lines: 0,
    score: 0,
    alive: true,
  };
}

const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);

/** WELL_H lines of right-margin HUD, each exactly HUD_W chars. */
export function hudLines(s: TetrisState): string[] {
  const preview = normalize(SHAPES[s.next]);
  const ph = Math.max(...preview.map((c) => c[1])) + 1;
  const lines = Array<string>(WELL_H).fill("");
  lines[0] = "  NEXT";
  for (let y = 0; y < ph; y++) {
    let row = "   ";
    for (let x = 0; x < 4; x++) {
      row += preview.some(([px, py]) => px === x && py === y) ? "██" : "  ";
    }
    lines[1 + y] = row;
  }
  lines[ph + 2] = `  LINES ${String(s.lines).padStart(3, " ")}`;
  lines[ph + 3] = `  LEVEL ${String(level(s)).padStart(3, " ")}`;
  return lines.map((l) => pad(l, HUD_W));
}

export function renderWell(s: TetrisState): string[] {
  const active = new Set<string>();
  if (s.active) {
    for (const [cx, cy] of s.active.cells) {
      active.add(`${s.active.x + cx},${s.active.y + cy}`);
    }
  }
  const hud = hudLines(s);
  const bar = "─".repeat(WELL_W * CELL);
  const out: string[] = [pad("┌" + bar + "┐", LANE_WIDTH)];
  for (let y = 0; y < WELL_H; y++) {
    let row = "│";
    for (let x = 0; x < WELL_W; x++) {
      row += active.has(`${x},${y}`) ? "▓▓" : s.well[y][x] ? "██" : "  ";
    }
    out.push(pad(row + "│" + hud[y], LANE_WIDTH));
  }
  out.push(pad("└" + bar + "┘", LANE_WIDTH));
  return out;
}

export const tetrisEngine: GameEngine<TetrisState> = {
  key: "tetris",
  label: "TETRIS",
  rows: TETRIS_ROWS,
  init: initialState,
  tick,
  input,
  render: renderWell,
  score: (s) => Math.min(MAX_SCORE, s.score),
  over: (s) => !s.alive,
  hint: (_s, playing) =>
    playing
      ? "← → MOVE · ↑ ROTATE · ↓ SOFT · SPACE DROP"
      : "SPACE to play · ← → move · ↑ rotate",
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/client && npx vitest run src/game/tetris.test.ts`
Expected: PASS, 9 tests.

If the render-shape test fails on row length, the cause is almost always a
box-drawing character being counted wrong or the HUD exceeding `HUD_W` — `pad`
truncates to exactly `LANE_WIDTH`, so a too-long row means a row was built
longer than 40 before padding and lost its right border.

- [ ] **Step 5: Typecheck**

Run: `cd poc/client && npx tsc --noEmit`
Expected: clean. (`_seed` is intentionally unused — it exists for contract conformance.)

- [ ] **Step 6: Commit**

```bash
git add poc/client/src/game/tetris.ts poc/client/src/game/tetris.test.ts
git commit -m "feat(client): Tetris engine — 10-wide well in the 40-char lane"
```

---

### Task 2: Doodle Jump engine

**Files:**
- Create: `poc/client/src/game/doodle.ts`
- Test: `poc/client/src/game/doodle.test.ts`

**Interfaces:**
- Consumes: `LANE_WIDTH` (40) and `GameEngine<S>` from `poc/client/src/game/engine.ts`. Independent of Task 1 — no shared code beyond `engine.ts`.
- Produces: `doodleEngine: GameEngine<DoodleState>` (key `"doodlejump"`, label `"DOODLE JUMP"`, `rows` 20), consumed by Task 3's roster. Also exports, for tests: `DoodleState`, `Platform`, `DOODLE_ROWS` (20), `PLAT_W` (5), `initialState`, `tick`, `input`, `renderView`.

**Coordinate system (read this before writing the test):** world `y` is an altitude in rows that **increases upward**. `cam` is the altitude at the **bottom** of the visible band, so the visible range is `[cam, cam + DOODLE_ROWS)` and screen row `= DOODLE_ROWS - 1 - round(y - cam)`. The player dies once `y` falls below `cam - 1`.

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/game/doodle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LANE_WIDTH } from "./engine";
import {
  doodleEngine, initialState, tick, input, renderView,
  DOODLE_ROWS, PLAT_W, type DoodleState,
} from "./doodle";

/** A fully-specified state, so no test depends on a random platform draw. */
const st = (over: Partial<DoodleState> = {}): DoodleState => ({
  x: 10, y: 5, vy: 0, dir: 0, cam: 0,
  platforms: [{ x: 8, y: 3 }],
  best: 5, alive: true,
  ...over,
});

const shape = (s: DoodleState) => {
  const rows = doodleEngine.render(s);
  expect(rows).toHaveLength(DOODLE_ROWS);
  for (const r of rows) expect(r).toHaveLength(LANE_WIDTH);
};

describe("doodle jump", () => {
  it("renders exactly `rows` rows of LANE_WIDTH chars — fresh, mid-run, and dead", () => {
    shape(initialState());
    shape(st({ y: 140, cam: 128, best: 140 }));
    shape(st({ alive: false, y: -3 }));
  });

  it("falls under gravity", () => {
    let s = st({ platforms: [] });
    for (let i = 0; i < 10; i++) s = tick(s, 0.05);
    expect(s.y).toBeLessThan(5);
    expect(s.vy).toBeLessThan(0);
  });

  it("bounces when descending onto a platform", () => {
    // above platform {x:8,y:3}, falling fast enough to cross it in one step
    let s = st({ y: 3.4, vy: -12, x: 9 });
    s = tick(s, 0.05);
    expect(s.vy).toBeGreaterThan(0);
  });

  it("passes through a platform while rising", () => {
    let s = st({ y: 2.6, vy: 12, x: 9 }); // below the platform, going up
    s = tick(s, 0.05);
    expect(s.vy).toBeLessThan(12); // gravity only — no bounce impulse
    expect(s.vy).toBeGreaterThan(0);
  });

  it("does not bounce when horizontally clear of the platform", () => {
    let s = st({ y: 3.4, vy: -12, x: 30 }); // platform spans x 8..12
    s = tick(s, 0.05);
    expect(s.vy).toBeLessThan(0);
  });

  it("steers left and right and wraps at both edges", () => {
    expect(input(st(), "ArrowLeft").dir).toBe(-1);
    expect(input(st(), "ArrowRight").dir).toBe(1);
    expect(input(st({ dir: 1 }), "ArrowDown").dir).toBe(0);
    const left = tick(st({ x: 0.2, dir: -1, platforms: [] }), 0.05);
    expect(left.x).toBeGreaterThan(LANE_WIDTH - 2); // wrapped
    const right = tick(st({ x: LANE_WIDTH - 0.2, dir: 1, platforms: [] }), 0.05);
    expect(right.x).toBeLessThan(2); // wrapped
  });

  it("ignores unknown keys and leaves a dead state inert", () => {
    const s = st();
    expect(input(s, "q")).toBe(s);
    const dead = st({ alive: false });
    expect(tick(dead, 0.05)).toBe(dead);
  });

  it("scores the high-water altitude and never decreases it", () => {
    let s = st({ y: 40, best: 40, cam: 28, vy: -5, platforms: [] });
    const before = doodleEngine.score(s);
    for (let i = 0; i < 10; i++) s = tick(s, 0.05);
    expect(s.y).toBeLessThan(40);
    expect(doodleEngine.score(s)).toBe(before); // falling never lowers the score
  });

  it("ends the run once the player drops below the view", () => {
    let s = st({ y: 1, vy: -20, cam: 0, platforms: [] });
    for (let i = 0; i < 20; i++) s = tick(s, 0.05);
    expect(s.alive).toBe(false);
    expect(doodleEngine.over(s)).toBe(true);
  });

  it("scrolls the camera up and keeps generating reachable platforms", () => {
    let s = initialState();
    for (let i = 0; i < 400; i++) s = tick(s, 0.05);
    expect(s.platforms.length).toBeGreaterThan(3);
    expect(s.platforms.every((p) => p.x >= 0 && p.x + PLAT_W <= LANE_WIDTH)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd poc/client && npx vitest run src/game/doodle.test.ts`
Expected: FAIL — `Failed to resolve import "./doodle"`.

- [ ] **Step 3: Write the implementation**

Create `poc/client/src/game/doodle.ts`:

```ts
import { LANE_WIDTH, type GameEngine } from "./engine";

export const DOODLE_ROWS = 20;
export const PLAT_W = 5;

const GRAVITY = 34; // rows / s²
const BOUNCE_V = 17; // rows / s — upward impulse on contact
/** Terminal cells are ~2× taller than wide, so horizontal travel needs roughly
 *  double the rate to feel isotropic (snake.ts makes the same correction). */
const MOVE_SPEED = 26; // cols / s
/** Player rises above this line from the view bottom → the camera follows. */
const SCROLL_LINE = DOODLE_ROWS - DOODLE_ROWS / 3;
const GAP_MIN = 2.2;
/** Must stay below the bounce apex (BOUNCE_V² / 2·GRAVITY ≈ 4.25 rows) or a
 *  generated platform becomes unreachable and the run is unwinnable. */
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
}

const platX = () => Math.floor(Math.random() * (LANE_WIDTH - PLAT_W + 1));
const gap = () => GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);

/** Extend `platforms` upward until the topmost one is above `ceiling`. `floor`
 *  is where generation starts when the list is empty or entirely below it —
 *  callers pass the TOP of the visible band so a platform can never pop into
 *  view underneath the player. */
function generate(platforms: Platform[], floor: number, ceiling: number): Platform[] {
  const out = [...platforms];
  let top = out.reduce((m, p) => Math.max(m, p.y), floor);
  while (top < ceiling) {
    top += gap();
    out.push({ x: platX(), y: top });
  }
  return out;
}

export function initialState(_seed = 1): DoodleState {
  const platforms = generate([{ x: 8, y: 1 }], 1, DOODLE_ROWS * 2);
  return { x: 10, y: 2, vy: 0, dir: 0, cam: 0, platforms, best: 2, alive: true };
}

export function tick(s: DoodleState, dt: number): DoodleState {
  if (!s.alive) return s;

  let vy = s.vy - GRAVITY * dt;
  let y = s.y + vy * dt;

  let x = s.x + s.dir * MOVE_SPEED * dt;
  if (x < 0) x += LANE_WIDTH;
  if (x >= LANE_WIDTH) x -= LANE_WIDTH;

  // Bounce only while descending across a platform's top edge — a rising
  // player passes straight through, which is what makes the game work.
  if (vy < 0) {
    const col = Math.floor(x);
    for (const p of s.platforms) {
      if (s.y >= p.y && y <= p.y && col >= p.x && col < p.x + PLAT_W) {
        y = p.y;
        vy = BOUNCE_V;
        break;
      }
    }
  }

  let cam = s.cam;
  if (y - cam > SCROLL_LINE) cam = y - SCROLL_LINE;

  const platforms = generate(
    s.platforms.filter((p) => p.y >= cam - 1),
    cam + DOODLE_ROWS, // never generate inside the visible band
    cam + DOODLE_ROWS * 2,
  );

  return {
    ...s,
    x, y, vy, cam, platforms,
    best: Math.max(s.best, y),
    alive: y >= cam - 1,
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
```

**Note for the implementer — one refinement over the spec.** The host forwards
keydown only; there is no keyup. Horizontal movement therefore has to be
**steer-style** (like `snake.ts`): a press sets a persistent direction rather
than moving while held. `ArrowDown` is bound to "stop" so there is a way back
to standing still. Record this in the Deviations section at the bottom of this
plan.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/client && npx vitest run src/game/doodle.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck**

Run: `cd poc/client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add poc/client/src/game/doodle.ts poc/client/src/game/doodle.test.ts
git commit -m "feat(client): Doodle Jump engine — auto-bounce vertical climb"
```

---

### Task 3: Swap the registries and retire Type Race

**Files:**
- Modify: `poc/client/src/components/ThinkingStrip.tsx:5` (import) and `:17-22` (roster)
- Modify: `poc/server/src/events.ts:11` (`ARCADE_GAMES`)
- Modify: `poc/server/src/server.ts:716` (hardcoded error string)
- Delete: `poc/client/src/game/typerace.ts`, `poc/client/src/game/typerace.test.ts`

**Interfaces:**
- Consumes: `tetrisEngine` from Task 1, `doodleEngine` from Task 2.
- Produces: a four-slot roster where every slot has an engine, and a server allowlist that matches it.

**Why both registries:** they are hand-maintained and **neither is derived from the other** — the client roster decides what you can play, the server allowlist decides what `game_score` it will accept. Edit one without the other and scores silently fail validation.

- [ ] **Step 1: Update the client roster**

In `poc/client/src/components/ThinkingStrip.tsx`, replace the Type Race import on line 5:

```ts
import { tetrisEngine } from "../game/tetris";
import { doodleEngine } from "../game/doodle";
```

and replace the `ROSTER` literal at lines 17-22:

```ts
const ROSTER: { key: string; label: string; engine?: GameEngine<any> }[] = [
  { key: "dino", label: "DINO RUN", engine: dinoEngine },
  { key: "snake", label: "SNAKE", engine: snakeEngine },
  { key: "tetris", label: "TETRIS", engine: tetrisEngine },
  { key: "doodlejump", label: "DOODLE JUMP", engine: doodleEngine },
];
```

Leave the `engine?` optional and the "cartridge not inserted" fallback at
`:231-235` **in place** — nothing reaches it now, but `engine?` is the
documented way to add a slot before its engine exists, and deleting the
fallback removes that affordance. Leave the `"dino"` defaults at `:48,52,69,70`
alone; dino is still slot 0.

- [ ] **Step 2: Update the server allowlist and un-hardcode its error string**

In `poc/server/src/events.ts` line 11:

```ts
export const ARCADE_GAMES = ["dino", "snake", "tetris", "doodlejump"] as const;
```

In `poc/server/src/server.ts` line 716, replace the hardcoded list — this is the
staleness bug the arcade map flagged, and this task is exactly the change that
would have made it lie:

```ts
          return sendError(`game_score requires game: ${ARCADE_GAMES.join("|")}`);
```

Confirm `ARCADE_GAMES` is already imported in `server.ts` (the validation on
line 714 uses it); if it is only imported as a type, add the value import.

- [ ] **Step 3: Delete Type Race**

```bash
git rm poc/client/src/game/typerace.ts poc/client/src/game/typerace.test.ts
```

- [ ] **Step 4: Run both suites and both builds**

```bash
cd poc/client && npx tsc --noEmit && npm test && npm run build
cd ../server && npx tsc --noEmit && npx vitest run
```

Expected: client typecheck clean, client tests pass with the typerace suite gone
and the two new suites present, client build clean; server typecheck clean and
server tests pass.

Baseline before this change was **client 84 / server 215**. Expect client to
land at **84 − (typerace suite count) + 19**. If a server test fails, check
whether it asserts on the literal error string from line 716 or uses
`game: "typerace"` in a `game_score` payload — retarget it to `"dino"`.

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/components/ThinkingStrip.tsx poc/server/src/events.ts poc/server/src/server.ts
git commit -m "feat(arcade): four-slot roster — Tetris and Doodle Jump in, Type Race out"
```

Then verify the commit touched only the intended files:

```bash
git diff-tree --no-commit-id --name-status -r HEAD
```

Expected: exactly the two modified sources, the ThinkingStrip, and the two
deletions. **If any root-level untracked file appears, stop and reset** — see
Global Constraints.

---

### Task 4: Drive the real UI (required acceptance gate)

**Files:** none — this task changes no code unless it finds a defect.

**Why this task exists and cannot be skipped:** `ThinkingStrip.tsx` has zero test
coverage — roster, cartridge swap, keyboard handling, the capture flag, the RAF
loop, and localStorage are all untested. That exact gap produced the recorded
swap crash in `docs/mistakes-and-fixes.md:9-14`, whose lesson is that passing
pure tests plus a clean build **cannot** catch it. This change makes the risky
path far larger: swapping from a 2-row cartridge to a 20-row one re-initializes
state in the same render pass (`ThinkingStrip.tsx:59-68`), and that is precisely
the code path that crashed before.

- [ ] **Step 1: Build the client and start a stack**

```bash
cd poc/client && npm run build
cd ../server && npx tsx src/main.ts
```

Check `lsof -ti:3001` is empty first. Never switch branches while a stack is
attached — tsx watch hot-reload kills live turns.

- [ ] **Step 2: Open the arcade and swap through all four cartridges**

Open the client, press `A` to open the idle arcade, then press `G` four times
to cycle DINO RUN → SNAKE → TETRIS → DOODLE JUMP → DINO RUN. Watch for a crash
or a blank lane on each transition, especially the 2-row ↔ 20-row ones.

Expected: every swap renders, the strip grows and shrinks cleanly, no console
errors.

- [ ] **Step 3: Play Tetris**

SPACE to start. Move with ← →, rotate with ↑, soft drop with ↓, hard drop with
SPACE. Complete at least one line.

Expected: pieces fall and lock, the NEXT preview updates, LINES and LEVEL
increment, a completed row clears, SCORE in the strip header rises, and the
lane stays exactly 40 columns wide with no ragged right edge.

- [ ] **Step 4: Play Doodle Jump**

SPACE to start. Steer with ← →, stop with ↓.

Expected: automatic bouncing off platforms, the camera scrolls once you climb,
platforms keep generating above, wrapping works at both edges, and falling off
the bottom ends the run.

- [ ] **Step 5: Confirm scoring and hotkey capture**

Finish a run of each with a nonzero score and confirm YOUR BEST updates in the
strip header (localStorage per game). While a run is live, confirm `S`, `W`,
`O`, `I` do **not** open their screens (the capture flag), and confirm `G` still
swaps the cartridge mid-run (neither engine sets `capturesText`). Confirm
Shift+Tab is not captured.

- [ ] **Step 6: Kill the stack**

Stop the server. Confirm `lsof -ti:3001` is empty.

- [ ] **Step 7: Record the result**

If anything failed, fix it on this branch with a normal test-first cycle and
re-run this task from Step 1. If everything passed, note it in the PR body —
"drove the real UI, all four cartridges swapped and both new games played" — so
the reviewer knows the untestable path was actually exercised.

---

## Self-Review

**Spec coverage:** §3.1 tall lane → Tasks 1 and 2 (`rows: 20`, no host change). §3.2 four-slot roster → Task 3 Step 1. §3.3 typerace removed → Task 3 Step 3. §3.4 relaxed determinism → Global Constraints plus the `refill()` and `platX()` comments; no seed assertions in either suite. §3.5 StrictMode tripwire → spec only; nothing to implement. §4 contract → Global Constraints. §5 Tetris → Task 1. §6 Doodle Jump → Task 2. §7 registries and the un-hardcoded error string → Task 3 Steps 1-2. §8 testing and the drive-the-UI gate → Tasks 1, 2, 4. §9 out of scope → nothing to implement.

**Type consistency:** `TetrisState`/`ActivePiece`/`Piece` are used identically in Task 1's test and implementation; `DoodleState`/`Platform` likewise in Task 2. `tetrisEngine` and `doodleEngine` are the exact names Task 3 imports. `WELL_W`, `WELL_H`, `TETRIS_ROWS`, `DOODLE_ROWS`, `PLAT_W` are exported from the modules the tests import them from.

## Deviations

*(Fill in during execution — record anything that departs from this plan or the spec, with the reason.)*

- **Task 4 result (live gate PASSED, 2026-07-26).** Drove the real UI on a vite
  dev stack. Confirmed: all four cartridges cycle with `G` — SNAKE(5 rows) →
  TETRIS(20) → DOODLE JUMP(20) → DINO RUN(2) → SNAKE(5) — with no crash and no
  console errors across the 2-row ↔ 20-row transitions, which is the swap path
  that crashed in `docs/mistakes-and-fixes.md:9-14`. Tetris: spawn, gravity,
  left/right with correct wall clamping, rotate, hard drop, lock, game over,
  and a 20×40 lane on every frame. Doodle Jump: auto-bounce, steering, camera
  scroll, rising score, death on falling out. Score submission round-tripped
  through the **new** server allowlist — a doodlejump run returned
  `PARTY BEST 0005 ★ tester` from the project snapshot, and the server log
  recorded no validation errors. Hotkey capture verified: S/W/O/I are
  suppressed during a live run while `G` still swaps the cartridge (correct,
  since neither engine sets `capturesText`).
- **Not observed live: a Tetris line clear.** Piece order is random and the
  crude column-sweep used to drive the browser left holes, so no row ever
  completed in a live run. Line clearing, the score table, and the level
  multiplier are covered deterministically by `tetris.test.ts` instead. Worth
  hitting by hand the next time this code is touched.
- **Task 2, keydown-only steering.** The spec describes ← → horizontal movement without saying how it terminates. The host forwards keydown only (`ThinkingStrip.tsx:186`), so movement is steer-style — a press sets a persistent direction — and `ArrowDown` is bound to "stop". Noted here rather than amending the spec because it refines an unspecified detail rather than contradicting one.
