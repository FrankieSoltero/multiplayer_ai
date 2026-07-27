import { describe, it, expect } from "vitest";
import { rows, moveH, moveV, yieldsArrows, type NavRect } from "./arrowNav";

const R = (x: number, y: number, w = 80, h = 30): NavRect => ({ x, y, w, h });

describe("rows", () => {
  it("puts side-by-side items in one row", () => {
    // transcript button and party button, a few px apart vertically
    const rects = [R(0, 300), R(500, 305)];
    expect(rows(rects)).toEqual([[0, 1]]);
  });

  it("splits a wrapped header into two rows", () => {
    // four buttons on line 1, two that wrapped onto line 2
    const rects = [R(0, 100), R(100, 100), R(200, 100), R(300, 100), R(0, 150), R(100, 150)];
    expect(rows(rects)).toEqual([[0, 1, 2, 3], [4, 5]]);
  });

  it("orders every row left to right regardless of source order", () => {
    const rects = [R(300, 100), R(0, 100), R(150, 100)];
    expect(rows(rects)).toEqual([[1, 2, 0]]);
  });

  it("separates rows that merely touch without overlapping past half height", () => {
    const rects = [R(0, 100, 80, 30), R(0, 128, 80, 30)]; // 2px of overlap, well under 15
    expect(rows(rects)).toEqual([[0], [1]]);
  });

  it("returns an empty list for no items", () => {
    expect(rows([])).toEqual([]);
  });
});

describe("moveH", () => {
  const bands = [[0, 1, 2], [3, 4]];

  it("steps to the next and previous item within a row", () => {
    expect(moveH(bands, 1, 1)).toBe(2);
    expect(moveH(bands, 1, -1)).toBe(0);
  });

  it("wraps at both ends of the row", () => {
    expect(moveH(bands, 2, 1)).toBe(0);
    expect(moveH(bands, 0, -1)).toBe(2);
    expect(moveH(bands, 4, 1)).toBe(3);
  });

  it("leaves an unknown index alone", () => {
    expect(moveH(bands, 99, 1)).toBe(99);
  });
});

describe("moveV", () => {
  //  row 0:  [0]      [1]      [2]        row 1:  [3]        [4]
  const rects = [R(0, 100), R(200, 100), R(400, 100), R(180, 150), R(600, 150)];
  const bands = rows(rects);

  it("moves to the adjacent row, landing on the nearest item by horizontal centre", () => {
    expect(moveV(bands, rects, 1, 1)).toBe(3); // x=200 → nearest below is x=180
    expect(moveV(bands, rects, 2, 1)).toBe(4); // x=400 → nearest below is x=600
    expect(moveV(bands, rects, 3, -1)).toBe(1); // back up to x=200
  });

  it("clamps at the top and the bottom instead of wrapping", () => {
    expect(moveV(bands, rects, 0, -1)).toBe(0);
    expect(moveV(bands, rects, 4, 1)).toBe(4);
  });

  it("leaves an unknown index alone", () => {
    expect(moveV(bands, rects, 99, 1)).toBe(99);
  });
});

describe("yieldsArrows", () => {
  it("yields to an input holding text on both axes — the caret beats navigation", () => {
    const typing = { tagName: "INPUT", value: "refactor the invite store" };
    expect(yieldsArrows(typing, "h")).toBe(true);
    expect(yieldsArrows(typing, "v")).toBe(true);
  });

  it("yields to a textarea on both axes", () => {
    expect(yieldsArrows({ tagName: "TEXTAREA", value: "" }, "h")).toBe(true);
    expect(yieldsArrows({ tagName: "TEXTAREA", value: "" }, "v")).toBe(true);
  });

  it("gives a select the vertical axis but NOT the horizontal one", () => {
    // ↑/↓ natively change the value; ←/→ do nothing on a closed select, so they
    // stay available as the escape route. Yielding both would strand focus on
    // the AGENT picker forever — it is the first focusable on the page.
    const select = { tagName: "SELECT", value: "opus" };
    expect(yieldsArrows(select, "v")).toBe(true);
    expect(yieldsArrows(select, "h")).toBe(false);
  });

  it("does not yield to an empty input, so arrows navigate from an empty prompt", () => {
    expect(yieldsArrows({ tagName: "INPUT", value: "" }, "h")).toBe(false);
    expect(yieldsArrows({ tagName: "INPUT", value: "" }, "v")).toBe(false);
  });

  it("does not yield to a button, or to nothing focused", () => {
    expect(yieldsArrows({ tagName: "BUTTON" }, "h")).toBe(false);
    expect(yieldsArrows(null, "v")).toBe(false);
  });

  it("matches the tag case-insensitively", () => {
    expect(yieldsArrows({ tagName: "input", value: "x" }, "h")).toBe(true);
  });
});
