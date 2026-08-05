import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OversightPanel } from "./OversightPanel";
import type { OversightState } from "../types";

/** OversightPanel is a pure, hookless component (spec §4): same house testing
 *  posture as `GateBar.test.tsx` — a REAL render through `react-dom/server`
 *  for text (this repo adds no DOM env, docs/tech-debt.md), plus a direct
 *  tree-walk of the returned element tree to inspect props (`disabled`) and
 *  fire wired onClick handlers (static markup drops both). Because
 *  OversightPanel uses no hooks, calling it directly needs no hooks
 *  dispatcher.
 *
 *  hub-oversight plan Task 4: the snapshot oversight shape gains additive
 *  `available?: boolean`. `available: false` (hub has no ANTHROPIC_API_KEY)
 *  disables the toggle and renders the exact capability string; `true` or
 *  ABSENT (old server / solo project) renders byte-identically to before
 *  this task. PULL is untouched either way (spec §5). */

type OversightPanelProps = Parameters<typeof OversightPanel>[0];

type HostNode = { type: unknown; props: Record<string, unknown> };

/** Every host node in OversightPanel's returned tree, in document order. */
const hostNodes = (props: OversightPanelProps): HostNode[] => {
  const rendered = OversightPanel(props);
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
};

const hasClass = (n: HostNode, cls: string): boolean =>
  typeof n.props.className === "string" && (n.props.className as string).split(" ").includes(cls);

const oversight = (over: Partial<OversightState> = {}): OversightState => ({
  enabled: false,
  latest: null,
  ...over,
});

const baseProps = (over: Partial<OversightPanelProps> = {}): OversightPanelProps => ({
  oversight: oversight(),
  isDriver: true,
  onToggle: () => {},
  onPull: () => {},
  onBack: () => {},
  ...over,
});

const markupOf = (over: Partial<OversightPanelProps> = {}): string =>
  renderToStaticMarkup(<OversightPanel {...baseProps(over)} />);

const REASON = "oversight is unavailable on this hub — no ANTHROPIC_API_KEY configured";

describe("OversightPanel — available:false (hub-oversight plan Task 4)", () => {
  it("disables the toggle control and renders the exact capability string", () => {
    const nodes = hostNodes(baseProps({ oversight: oversight({ available: false }) }));
    const toggle = nodes.find(
      (n) => n.type === "button" && (n.props.children === "ENABLE" || n.props.children === "DISABLE"),
    );
    expect(toggle).toBeDefined();
    expect(toggle!.props.disabled).toBe(true);

    expect(markupOf({ oversight: oversight({ available: false }) })).toContain(REASON);
  });

  it("still fires onToggle if invoked directly (disabled is a DOM-level attribute, not a handler removal)", () => {
    const onToggle = vi.fn();
    const nodes = hostNodes(baseProps({ oversight: oversight({ available: false }), onToggle }));
    const toggle = nodes.find((n) => n.type === "button" && n.props.children === "ENABLE");
    (toggle!.props.onClick as () => void)();
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("PULL is untouched: unaffected by `available` — still gated on isDriver/latest exactly as before", () => {
    // enabled + a summary + driver: PULL renders, enabled, same as if
    // `available` were absent — availability plays no part in its gating.
    const withPull = markupOf({
      oversight: oversight({ available: false, enabled: true, latest: { text: "t", ts: "2026-08-04T00:00:00Z", seq: 1 } }),
      isDriver: true,
    });
    expect(withPull).toContain("PULL INTO SESSION");
    const pullNodes = hostNodes(
      baseProps({
        oversight: oversight({ available: false, enabled: true, latest: { text: "t", ts: "2026-08-04T00:00:00Z", seq: 1 } }),
        isDriver: true,
      }),
    );
    const pull = pullNodes.find((n) => n.type === "button" && n.props.children === "PULL INTO SESSION ▸");
    expect(pull).toBeDefined();
    expect(pull!.props.disabled).toBe(false);

    // Not the driver: PULL still disabled by isDriver, exactly as today —
    // `available: false` adds nothing extra here.
    const nonDriverNodes = hostNodes(
      baseProps({
        oversight: oversight({ available: false, enabled: true, latest: { text: "t", ts: "2026-08-04T00:00:00Z", seq: 1 } }),
        isDriver: false,
      }),
    );
    const nonDriverPull = nonDriverNodes.find((n) => n.type === "button" && n.props.children === "PULL INTO SESSION ▸");
    expect(nonDriverPull!.props.disabled).toBe(true);

    // oversight off: no PULL button at all, same as today.
    expect(markupOf({ oversight: oversight({ available: false, enabled: false }) })).not.toContain("PULL");
  });
});

describe("OversightPanel — available:true / absent renders byte-identically to today", () => {
  it("an absent `available` and an explicit `true` render identical markup", () => {
    const absent = markupOf({ oversight: oversight() });
    const explicitTrue = markupOf({ oversight: oversight({ available: true }) });
    expect(explicitTrue).toBe(absent);
  });

  it("the toggle carries no disabled attribute and no reason line appears", () => {
    for (const avail of [undefined, true] as const) {
      const markup = markupOf({ oversight: oversight(avail === undefined ? {} : { available: avail }) });
      expect(markup).not.toContain("disabled");
      expect(markup).not.toContain(REASON);

      const nodes = hostNodes(baseProps({ oversight: oversight(avail === undefined ? {} : { available: avail }) }));
      const toggle = nodes.find((n) => n.type === "button" && n.props.children === "ENABLE");
      expect(toggle!.props.disabled).toBeFalsy();
    }
  });

  it("full watching-state markup (enabled, latest, PULL) is identical whether `available` is absent or true", () => {
    const state = { enabled: true, latest: { text: "team is refactoring auth", ts: "2026-08-04T00:00:00Z", seq: 5 } };
    const absent = markupOf({ oversight: oversight(state) });
    const explicitTrue = markupOf({ oversight: oversight({ ...state, available: true }) });
    expect(explicitTrue).toBe(absent);
    expect(absent).toContain("team is refactoring auth");
    expect(absent).toContain("PULL INTO SESSION");
  });
});

describe("OversightPanel — theme parity (T14): the reason line is theme-token only", () => {
  it("reuses the existing `.line.dim` token class — no new color or inline style", () => {
    const nodes = hostNodes(baseProps({ oversight: oversight({ available: false }) }));
    const reason = nodes.find(
      (n) => typeof n.props.children === "string" && (n.props.children as string) === REASON,
    );
    expect(reason).toBeDefined();
    expect(hasClass(reason!, "dim")).toBe(true);
    expect(reason!.props.style).toBeUndefined();
  });
});
