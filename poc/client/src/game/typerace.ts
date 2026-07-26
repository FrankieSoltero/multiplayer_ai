import { LANE_WIDTH, lcg, type GameEngine } from "./engine";

export const TYPE_ROWS = 3;

/** All ≤ 40 chars (LANE_WIDTH) so the phrase row never truncates. */
export const PHRASES = [
  "append only logs never lie",
  "take the wheel and ship it",
  "derive the state replay the log",
  "cartridge inserted press start",
  "one more turn then we merge",
  "the party best belongs to the bold",
] as const;

export interface TypeState {
  phrase: string;
  pos: number;
  misses: number;
  elapsed: number; // seconds since the first correct key
  done: boolean;
}

export function stateFor(phrase: string): TypeState {
  return { phrase, pos: 0, misses: 0, elapsed: 0, done: false };
}

export function initialState(seed = 1): TypeState {
  return stateFor(PHRASES[lcg(seed >>> 0 || 1) % PHRASES.length]);
}

export function tick(s: TypeState, dt: number): TypeState {
  if (s.done || s.pos === 0) return s; // clock starts on the first hit
  return { ...s, elapsed: s.elapsed + dt };
}

export function press(s: TypeState, key: string): TypeState {
  if (s.done || key.length !== 1) return s; // printable keys only
  if (key === s.phrase[s.pos]) {
    const pos = s.pos + 1;
    return { ...s, pos, done: pos === s.phrase.length };
  }
  return { ...s, misses: s.misses + 1 };
}

export function wpmScore(s: TypeState): number {
  if (s.pos === 0) return 0;
  const minutes = Math.max(s.elapsed, 1) / 60; // floor 1s: no Infinity WPM
  const raw = Math.round(s.pos / 5 / minutes) - 2 * s.misses;
  return s.done ? Math.max(1, raw) : Math.max(0, raw);
}

const padRow = (t: string) => t.slice(0, LANE_WIDTH).padEnd(LANE_WIDTH, " ");

export function renderRows(s: TypeState): string[] {
  const status = s.done
    ? `DONE · WPM SCORE ${wpmScore(s)}`
    : `TYPED ${s.pos}/${s.phrase.length} · MISS ${s.misses}`;
  return [
    padRow(s.phrase),
    padRow(s.phrase.slice(0, s.pos) + (s.done ? "" : "▌")),
    padRow(status),
  ];
}

export const typeRaceEngine: GameEngine<TypeState> = {
  key: "typerace",
  label: "TYPE RACE",
  rows: TYPE_ROWS,
  capturesText: true,
  init: initialState,
  tick,
  input: press,
  render: renderRows,
  score: wpmScore,
  over: (s) => s.done,
  hint: (_s, playing) =>
    playing ? "just type the phrase — misses cost 2" : "SPACE to start · then type the phrase",
};
