/** Arrow-key navigation across the whole terminal.
 *
 *  The geometry and index arithmetic live here as pure functions so they can be
 *  tested without a DOM — `useArrowNav.ts` is a thin binding over them. Rows are
 *  derived from live bounding boxes rather than from markup, so the layout is
 *  the single source of truth: the header that wraps onto two lines becomes two
 *  rows automatically, with no attribute to keep in sync. */

export interface NavRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const centerX = (r: NavRect) => r.x + r.w / 2;

/** Two items share a row when their vertical spans overlap by more than half
 *  the shorter one's height. Side-by-side panes qualify; stacked rows do not. */
function sameRow(a: NavRect, b: NavRect): boolean {
  const shared = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return shared > Math.min(a.h, b.h) / 2;
}

/** Group item indices into visual rows, each ordered left to right. */
export function rows(rects: NavRect[]): number[][] {
  const byPosition = rects
    .map((_, i) => i)
    .sort((a, b) => rects[a].y - rects[b].y || rects[a].x - rects[b].x);

  const out: number[][] = [];
  for (const i of byPosition) {
    const row = out.find((band) => band.some((j) => sameRow(rects[j], rects[i])));
    if (row) row.push(i);
    else out.push([i]);
  }
  return out.map((band) => [...band].sort((a, b) => rects[a].x - rects[b].x));
}

/** Previous/next within the row, wrapping — same feel as the slash menu's
 *  `moveHighlight`. */
export function moveH(bands: number[][], cur: number, dir: 1 | -1): number {
  const band = bands.find((b) => b.includes(cur));
  if (!band) return cur;
  const at = band.indexOf(cur);
  return band[(at + dir + band.length) % band.length];
}

/** Nearest item in the row above/below, matched by horizontal centre. Clamps at
 *  the ends: wrapping from the prompt back up to the header is disorienting. */
export function moveV(
  bands: number[][],
  rects: NavRect[],
  cur: number,
  dir: 1 | -1,
): number {
  const bi = bands.findIndex((b) => b.includes(cur));
  if (bi < 0) return cur;
  const target = bands[bi + dir];
  if (!target || !target.length) return cur;

  const x = centerX(rects[cur]);
  return target.reduce(
    (best, i) =>
      Math.abs(centerX(rects[i]) - x) < Math.abs(centerX(rects[best]) - x) ? i : best,
    target[0],
  );
}

/** True when the focused element should keep this arrow key for itself.
 *
 *  - a textarea always wins, on both axes
 *  - an input wins only while it holds text; the caret beats navigation, which
 *    is also what keeps the slash menu working (it only opens on a leading "/")
 *  - a select wins the VERTICAL axis only. ↑/↓ natively change its value, but
 *    ←/→ do nothing on a closed select, so they stay available as the way out.
 *    Yielding both axes would strand focus on the AGENT picker permanently —
 *    it is the first focusable element on the page, so the very first arrow
 *    press landed there and nothing could move again (found by driving the
 *    real UI; the pure tests could not see it).
 *
 *  An EMPTY input is fair game: arrows do nothing there, so taking them costs
 *  the user nothing. */
export function yieldsArrows(
  el: { tagName: string; value?: string } | null,
  axis: "h" | "v",
): boolean {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return axis === "v";
  if (tag === "INPUT") return (el.value ?? "") !== "";
  return false;
}
