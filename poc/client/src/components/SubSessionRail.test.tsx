import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubSessionInfo } from "../derive";
import { SubSessionRail } from "./SubSessionRail";

/** House pattern (see Transcript.test.tsx): this repo has no DOM test env
 *  (docs/tech-debt.md). Display is asserted via `react-dom/server` markup;
 *  onClick WIRING is exercised through the internals hooks shim + a host-node
 *  walk, since static markup drops handlers. SubSessionRail uses no hooks, so
 *  the shim only needs to make the tree walk safe. */
const H_KEY = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";

type HostNode = { type: unknown; props: Record<string, unknown> };

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

/** The chip buttons only — the rail container's text also matches a label, so
 *  every chip lookup must be scoped to `<button>` host nodes. */
const chips = (nodes: HostNode[]): HostNode[] => nodes.filter((n) => n.type === "button");

const textOf = (node: unknown): string => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as HostNode;
  return n.props ? textOf(n.props.children) : "";
};

const sub = (over: Partial<SubSessionInfo>): SubSessionInfo => ({
  key: "A",
  label: "scan tests",
  status: "running",
  gatePending: false,
  ...over,
});

const railEl = (over: {
  subSessions: SubSessionInfo[];
  view?: string | null;
  onSelect?: (key: string | null) => void;
}): React.ReactElement => (
  <SubSessionRail
    subSessions={over.subSessions}
    view={over.view ?? null}
    onSelect={over.onSelect ?? (() => {})}
  />
);

const markupOf = (over: Parameters<typeof railEl>[0]): string =>
  renderToStaticMarkup(railEl(over));

describe("SubSessionRail", () => {
  it("T4-hidden-when-empty renders nothing when there are no sub-sessions", () => {
    expect(markupOf({ subSessions: [] })).toBe("");
    // The component itself returns null — today's layout is untouched.
    const rendered = (SubSessionRail as (p: unknown) => unknown)({
      subSessions: [],
      view: null,
      onSelect: () => {},
    });
    expect(rendered).toBeNull();
  });

  it("T4-chips renders a MAIN chip plus one ⚒ <label> chip per sub-session in spawn order, active marked", () => {
    const subs = [sub({ key: "A", label: "scan tests" }), sub({ key: "B", label: "write docs" })];
    const markup = markupOf({ subSessions: subs, view: "A" });
    const text = textOf(
      (SubSessionRail as (p: unknown) => React.ReactElement)({
        subSessions: subs,
        view: "A",
        onSelect: () => {},
      }),
    );
    // MAIN chip literal, then each label with the ⚒ marker, spawn order A before B.
    expect(text).toContain("MAIN");
    expect(text).toContain("⚒ scan tests");
    expect(text).toContain("⚒ write docs");
    expect(text.indexOf("scan tests")).toBeLessThan(text.indexOf("write docs"));

    // The active sub-session's chip carries the `active` class; MAIN does not.
    const nodes = renderTree(railEl({ subSessions: subs, view: "A" }));
    const chipA = chips(nodes).find((n) => textOf(n).includes("scan tests"));
    const chipMain = chips(nodes).find((n) => textOf(n) === "MAIN");
    expect(chipA && hasClass(chipA, "active")).toBe(true);
    expect(chipMain && hasClass(chipMain, "active")).toBe(false);
    expect(markup).toContain("active");
  });

  it("T4-chips marks the MAIN chip active when the view is MAIN (null)", () => {
    const subs = [sub({ key: "A" })];
    const nodes = renderTree(railEl({ subSessions: subs, view: null }));
    const chipMain = chips(nodes).find((n) => textOf(n) === "MAIN");
    const chipA = chips(nodes).find((n) => textOf(n).includes("scan tests"));
    expect(chipMain && hasClass(chipMain, "active")).toBe(true);
    expect(chipA && hasClass(chipA, "active")).toBe(false);
  });

  it("T4-swap invokes onSelect(key) for a chip and onSelect(null) for MAIN", () => {
    const subs = [sub({ key: "A", label: "scan tests" })];
    const onSelect = vi.fn();
    const nodes = renderTree(railEl({ subSessions: subs, view: null, onSelect }));
    const chipA = chips(nodes).find((n) => textOf(n).includes("scan tests"));
    const chipMain = chips(nodes).find((n) => textOf(n) === "MAIN");
    (chipA!.props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith("A");
    (chipMain!.props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("T4-gate-badge marks a gate-pending chip with class `gated` and text `!`", () => {
    const subs = [sub({ key: "A", gatePending: true })];
    const nodes = renderTree(railEl({ subSessions: subs, view: null }));
    const chipA = chips(nodes).find((n) => textOf(n).includes("scan tests"));
    expect(chipA && hasClass(chipA, "gated")).toBe(true);
    expect(textOf(chipA)).toContain("!");
  });

  it("T4-done-styling marks a done chip with class `done` and keeps it clickable", () => {
    const subs = [sub({ key: "A", status: "done" })];
    const onSelect = vi.fn();
    const nodes = renderTree(railEl({ subSessions: subs, view: null, onSelect }));
    const chipA = chips(nodes).find((n) => textOf(n).includes("scan tests"));
    expect(chipA && hasClass(chipA, "done")).toBe(true);
    // Still clickable — done-detection is display only, never access control.
    (chipA!.props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith("A");
  });

  it("T4-chip-overflow renders every chip (no cap) in a horizontally scrolling rail", () => {
    const subs = Array.from({ length: 12 }, (_, i) => sub({ key: `k${i}`, label: `sub ${i}` }));
    const nodes = renderTree(railEl({ subSessions: subs, view: null }));
    // Every one of the 12 labels renders — no cap.
    for (let i = 0; i < 12; i++) {
      expect(nodes.some((n) => textOf(n).includes(`sub ${i}`))).toBe(true);
    }
    // The rail container scrolls horizontally rather than wrapping (spec §2.5).
    // `overflow-x: auto` alone cannot achieve this — inline-block chips would
    // wrap and grow the container's height instead of overflowing. `white-space:
    // nowrap` keeps them on one line so horizontal overflow (and the scrollbar)
    // actually happens. Best proxy available with no layout env: assert BOTH
    // style props are present on the same container.
    const container = nodes.find((n) => {
      const s = n.props.style as { overflowX?: string; whiteSpace?: string } | undefined;
      return s?.overflowX === "auto";
    });
    expect(container).toBeDefined();
    expect((container!.props.style as { whiteSpace?: string }).whiteSpace).toBe("nowrap");
  });
});
