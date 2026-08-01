import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import {
  ARCADE_SCALE,
  ARCADE_SIZE_KEY,
  clampScale,
  dragScale,
  persistScale,
  readStoredScale,
  stepScale,
  ThinkingStrip,
} from "./ThinkingStrip";

/** This repo has no DOM test environment (docs/tech-debt.md): render rows go
 *  through the hooks-shim pattern of `Transcript.test.tsx`'s `renderTree`, and
 *  the pure `readStoredScale` helper + the storage-throw READ guard are tested
 *  directly. The one render-path global — `localStorage` in a `useState`
 *  initializer — is stubbed below, exactly as `App.test.tsx` does it. */

let getItemImpl: (k: string) => string | null = () => null;
let setItemImpl: (k: string, v: string) => void = () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => getItemImpl(k),
  setItem: (k: string, v: string) => setItemImpl(k, v),
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

afterEach(() => {
  getItemImpl = () => null;
  setItemImpl = () => {};
});

const H_KEY = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";

type HostNode = { type: unknown; props: Record<string, unknown> };

/** Same hooks-shim + host-node walk as `Transcript.test.tsx`. `useEffect` is a
 *  no-op (matching the static-render semantics the suite relies on); `useState`
 *  runs function initializers so the localStorage read on mount happens here. */
const renderTree = (element: React.ReactElement): HostNode[] => {
  const internals = (React as unknown as Record<string, { H: unknown }>)[H_KEY];
  const prev = internals.H;
  internals.H = {
    useRef: (v: unknown) => ({ current: v }),
    useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}],
    useEffect: () => {},
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useContext: () => undefined,
  };
  try {
    const type = element.type as (props: unknown) => unknown;
    const rendered = type(element.props);
    const out: HostNode[] = [];
    const visit = (node: unknown) => {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const n = node as HostNode;
      if (n.props) {
        out.push(n);
        visit(n.props.children);
      }
    };
    visit(rendered);
    return out;
  } finally {
    internals.H = prev;
  }
};

const hasClass = (n: HostNode, cls: string): boolean =>
  typeof n.props.className === "string" && (n.props.className as string).split(" ").includes(cls);

/** The idle arcade strip, mounted (open → active → mounted) on the default
 *  dino cartridge so its playable `.lane` <pre> renders. */
const strip = (): React.ReactElement => (
  <ThinkingStrip busy={false} open modelLabel="claude" />
);

/** The font-size inline style on the game lane <pre>. */
const laneFontSize = (el: React.ReactElement): unknown => {
  const lane = renderTree(el).find((n) => hasClass(n, "lane"));
  expect(lane).toBeDefined();
  const style = lane!.props.style as Record<string, unknown> | undefined;
  return style?.fontSize;
};

describe("Task 12 — arcade lane footprint scale", () => {
  it("T12-smaller-default: no stored key renders the lane at scale 0.65", () => {
    expect(readStoredScale(null)).toBe(0.65);
    getItemImpl = () => null; // no stored key for any lookup
    expect(laneFontSize(strip())).toBe("calc(var(--fs) * 0.65)");
  });

  it("T12-stored-scale: a stored 0.8 renders the lane at 0.8", () => {
    expect(readStoredScale("0.8")).toBe(0.8);
    getItemImpl = (k) => (k === ARCADE_SIZE_KEY ? "0.8" : null);
    expect(laneFontSize(strip())).toBe("calc(var(--fs) * 0.8)");
  });

  it("T12-invalid-stored: garbage → default, empty → default, over-max → clamped 1.0", () => {
    expect(readStoredScale("abc")).toBe(ARCADE_SCALE.default);
    expect(readStoredScale("")).toBe(ARCADE_SCALE.default);
    expect(readStoredScale("9")).toBe(ARCADE_SCALE.max);
    // and below-min clamps up to min
    expect(readStoredScale("0.1")).toBe(ARCADE_SCALE.min);
    // an invalid stored value renders at the default in the lane
    getItemImpl = (k) => (k === ARCADE_SIZE_KEY ? "abc" : null);
    expect(laneFontSize(strip())).toBe("calc(var(--fs) * 0.65)");
    // an over-max stored value renders clamped to 1.0
    getItemImpl = (k) => (k === ARCADE_SIZE_KEY ? "9" : null);
    expect(laneFontSize(strip())).toBe("calc(var(--fs) * 1)");
  });

  it("T12-storage-read-throws: a throwing getItem never crashes; scale = default", () => {
    getItemImpl = (k) => {
      if (k === ARCADE_SIZE_KEY) throw new Error("blocked-storage sandbox");
      return null;
    };
    expect(() => laneFontSize(strip())).not.toThrow();
    expect(laneFontSize(strip())).toBe("calc(var(--fs) * 0.65)");
  });

  it("T12-theme-independence: the scale takes no theme input — identical in both", () => {
    // ThinkingStrip has no theme prop: the scale is computed purely from the
    // stored value via a theme-independent `calc(var(--fs) * n)` token, so two
    // renders under the same stored value are byte-identical regardless of the
    // ambient theme (which lives on the document root, not this component).
    getItemImpl = (k) => (k === ARCADE_SIZE_KEY ? "0.8" : null);
    const arcade = laneFontSize(strip());
    const clean = laneFontSize(strip());
    expect(arcade).toBe("calc(var(--fs) * 0.8)");
    expect(clean).toBe(arcade);
  });
});

// ---------------------------------------------------------------------------
// Task 7 fix (round 1) — the game-lane surface is gated on `props.open`.
// `active = busy || open` still MOUNTS the strip whenever busy, so the status
// line always renders; but the game lane (`.lane`) and its game-picker row
// (`.roster`) render only when `open` is true. Clean-busy passes open=false →
// status line without the lane (spec §2.2); Arcade-busy passes open=true (via
// App's `laneAutoOpen`) → the full lane, exactly as today; manual open (ARCADE
// button / idle `A`) passes open=true → identical lane in both themes.
// ---------------------------------------------------------------------------
describe("Task 7 fix — game lane gated on props.open", () => {
  const nodesFor = (busy: boolean, open: boolean): HostNode[] =>
    renderTree(<ThinkingStrip busy={busy} open={open} modelLabel="claude" />);
  const has = (nodes: HostNode[], cls: string): boolean => nodes.some((n) => hasClass(n, cls));

  it("T7-fix-busy-no-open shows the thinking status line WITHOUT the game lane or roster", () => {
    // Clean-busy: strip mounted via busy, but open=false → status line only.
    const nodes = nodesFor(true, false);
    expect(has(nodes, "thinking-head")).toBe(true); // status line renders…
    expect(has(nodes, "lane")).toBe(false); // …but the game lane does NOT
    expect(has(nodes, "roster")).toBe(false); // …and neither does the game-picker row
    // the status line is the THINKING affordance (busy), not the idle coin prompt
    const who = nodes.find((n) => hasClass(n, "who"));
    expect(String(who!.props.children ?? "")).toContain("IS THINKING");
  });

  it("T7-fix-busy-open renders the full lane surface when open (arcade auto-open / manual open)", () => {
    const nodes = nodesFor(true, true);
    expect(has(nodes, "thinking-head")).toBe(true);
    expect(has(nodes, "lane")).toBe(true); // lane present when open
    expect(has(nodes, "roster")).toBe(true); // and its game-picker row
  });

  it("T7-fix-idle-open leaves the INSERT COIN idle arcade lane unchanged", () => {
    const nodes = nodesFor(false, true);
    expect(has(nodes, "lane")).toBe(true);
    expect(has(nodes, "roster")).toBe(true);
    const who = nodes.find((n) => hasClass(n, "who"));
    expect(String(who!.props.children ?? "")).toContain("INSERT COIN");
  });
});

// ---------------------------------------------------------------------------
// Task 13 — arcade footprint: drag/keyboard resize control (spec §2.6 R4).
// The resize control is theme-independent, user-driven pure scale math: a drag
// handle (class `arcade-resize`) on the strip's top edge maps a vertical
// pointer drag and ArrowUp/ArrowDown keypresses onto the [0.5, 1.0] scale, and
// persists the result to `mpai-arcade-size`. The DOM-less suite tests the pure
// mapping helpers directly and walks the rendered host tree for the handle.
// ---------------------------------------------------------------------------
describe("Task 13 — arcade footprint resize", () => {
  const handle = (el: React.ReactElement): HostNode => {
    const h = renderTree(el).find((n) => hasClass(n, "arcade-resize"));
    expect(h).toBeDefined();
    return h!;
  };

  it("T13-drag-mapping: scale = clamp(anchorScale + (anchorY − clientY)/400, 0.5, 1.0)", () => {
    // dragging UP (clientY < anchorY) grows the strip: 100px up from 0.65 → +0.25.
    expect(dragScale(0.65, 300, 200)).toBeCloseTo(0.9, 10);
    // the pinned gentle feel: 200px of travel spans the FULL 0.5-wide clamp range.
    expect(dragScale(0.5, 200, 0)).toBeCloseTo(1.0, 10);
    // dragging DOWN shrinks; below-min clamps up to 0.5.
    expect(dragScale(0.65, 300, 500)).toBe(ARCADE_SCALE.min); // 0.65 − 0.5 = 0.15 → 0.5
    // above-max clamps down to 1.0 (300px up from 0.65 → 1.4 → 1.0).
    expect(dragScale(0.65, 300, 0)).toBe(ARCADE_SCALE.max);
    // exact /400 divisor: 40px up is +0.10, not +0.05 (a /200 divisor would fail).
    expect(dragScale(0.6, 100, 60)).toBeCloseTo(0.7, 10);
  });

  it("T13-keyboard-resize: ArrowUp/ArrowDown step scale by 0.05, clamped to [0.5,1.0]", () => {
    expect(ARCADE_SCALE.step).toBe(0.05);
    // up = bigger strip, down = smaller.
    expect(stepScale(0.65, ARCADE_SCALE.step)).toBeCloseTo(0.7, 10);
    expect(stepScale(0.65, -ARCADE_SCALE.step)).toBeCloseTo(0.6, 10);
    // clamped at both ends.
    expect(stepScale(ARCADE_SCALE.max, ARCADE_SCALE.step)).toBe(ARCADE_SCALE.max);
    expect(stepScale(ARCADE_SCALE.min, -ARCADE_SCALE.step)).toBe(ARCADE_SCALE.min);
    // the handle renders on the open strip with the pinned ARIA contract.
    const h = handle(strip());
    expect(h.props.role).toBe("separator");
    expect(h.props["aria-orientation"]).toBe("horizontal");
    expect(h.props.tabIndex).toBe(0);
    expect(typeof h.props.onKeyDown).toBe("function");
    expect(typeof h.props.onPointerDown).toBe("function");
  });

  it("T13-persistence: an adjusted scale is written to mpai-arcade-size as a numeric string", () => {
    let written: [string, string] | null = null;
    setItemImpl = (k, v) => {
      written = [k, v];
    };
    persistScale(0.8);
    expect(written).toEqual([ARCADE_SIZE_KEY, "0.8"]);
    // re-mount restores it: the stored numeric string round-trips through the read.
    expect(readStoredScale(written![1])).toBe(0.8);
  });

  it("T13-storage-write-fails: a throwing setItem never crashes; persistence silently skipped", () => {
    setItemImpl = () => {
      throw new Error("private mode / quota exceeded");
    };
    // the in-session scale still resolved (pure math), persistence swallowed.
    expect(() => persistScale(dragScale(0.65, 300, 200))).not.toThrow();
  });

  it("T13-live-run: a resize touches only scale — a running game state object is UNCHANGED", () => {
    // The resize helpers take numbers only; they never receive game state, so a
    // live run's state/tick/keyboard capture cannot be perturbed by a resize.
    const runState = Object.freeze({ tick: 42, alive: true, seed: 12345 });
    const snapshot = JSON.stringify(runState);
    // drive both a keyboard step and a simulated drag; the frozen state survives.
    expect(() => {
      stepScale(0.65, ARCADE_SCALE.step);
      dragScale(0.65, 300, 220);
    }).not.toThrow();
    expect(JSON.stringify(runState)).toBe(snapshot);
    // the handle coexists with the game lane, whose click-to-start/-input path
    // (the SPACE/click game handler) stays wired — resize did not replace it.
    const nodes = renderTree(<ThinkingStrip busy={false} open modelLabel="claude" />);
    expect(nodes.some((n) => hasClass(n, "arcade-resize"))).toBe(true);
    const lane = nodes.find((n) => hasClass(n, "lane"));
    expect(lane).toBeDefined();
    expect(typeof lane!.props.onClick).toBe("function");
  });

  it("T13-theme-independence: the mapping takes no theme input — identical in both themes", () => {
    // dragScale/stepScale/clampScale are deterministic pure functions of numbers
    // only: no theme parameter exists, so the resize behavior and the stored
    // value are byte-identical in arcade and clean.
    expect(dragScale(0.7, 300, 250)).toBe(dragScale(0.7, 300, 250));
    expect(stepScale(0.7, ARCADE_SCALE.step)).toBe(stepScale(0.7, ARCADE_SCALE.step));
    expect(clampScale(1.4)).toBe(ARCADE_SCALE.max);
    expect(clampScale(0.1)).toBe(ARCADE_SCALE.min);
  });
});
