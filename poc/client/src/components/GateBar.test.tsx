import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GateBar, type GateBarProps } from "./GateBar";

/** GateBar is a pure, hookless component (spec §8.5): the pinned gate bar above
 *  the prompt. Same house testing posture as the rest of the client suite — a
 *  REAL render through `react-dom/server` for text (this repo adds no DOM env,
 *  docs/tech-debt.md), plus a direct tree-walk of the returned element tree to
 *  fire the wired onClick handlers (static markup drops event handlers). Because
 *  GateBar uses no hooks, calling it directly needs no hooks dispatcher. */

/** All rendered text with tags stripped and entities decoded, concatenated in
 *  document order — so `🔐 <span>Write</span>` reads back as `🔐 Write`. */
const plainText = (markup: string): string =>
  markup
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");

type HostNode = { type: unknown; props: Record<string, unknown> };

/** Every host node in GateBar's returned tree, in document order. */
const hostNodes = (props: GateBarProps): HostNode[] => {
  const rendered = GateBar(props);
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

/** A synthetic event for the tree-walked handlers: they stopPropagation so a
 *  decide/wheel click never also fires the bar-body jump. renderTree never runs
 *  the DOM, so we hand them a no-op stopPropagation. */
const clickEvent = () => ({ stopPropagation: () => {} });

const baseProps = (over: Partial<GateBarProps> = {}): GateBarProps => ({
  gate: { requestId: "r1", toolName: "Write" },
  isDriver: true,
  driverName: "Frank",
  driverGlyph: "▲",
  onDecide: () => {},
  onTakeWheel: () => {},
  onJump: () => {},
  ...over,
});

const markupOf = (over: Partial<GateBarProps> = {}): string =>
  renderToStaticMarkup(<GateBar {...baseProps(over)} />);

describe("GateBar — §8.5 pinned gate bar", () => {
  it("T8-hidden renders null when there is no gate (layout untouched)", () => {
    expect(GateBar(baseProps({ gate: null }))).toBeNull();
    expect(markupOf({ gate: null })).toBe("");
  });

  it("T8-driver-bar shows the gate and decide buttons that invoke onDecide", () => {
    const gate = { requestId: "r1", toolName: "Write", subLabel: "scan tests" };
    const text = plainText(markupOf({ gate, isDriver: true }));
    // Tool name behind the lock, and the sub-session label with its ⚒ prefix.
    expect(text).toContain("🔐 Write");
    expect(text).toContain("⚒ scan tests");
    // The bar carries the base-theme class.
    const nodes = hostNodes(baseProps({ gate, isDriver: true }));
    expect(nodes.some((n) => hasClass(n, "gatebar"))).toBe(true);

    // [A]PPROVE / [D]ENY reuse btn green / btn red and hit onDecide.
    const markup = markupOf({ gate, isDriver: true });
    expect(markup).toContain("[A]PPROVE");
    expect(markup).toContain("[D]ENY");

    const onDecide = vi.fn();
    const decideNodes = hostNodes(baseProps({ gate, isDriver: true, onDecide }));
    const approve = decideNodes.find((n) => hasClass(n, "btn") && hasClass(n, "green"));
    const deny = decideNodes.find((n) => hasClass(n, "btn") && hasClass(n, "red"));
    expect(approve).toBeDefined();
    expect(deny).toBeDefined();
    (approve!.props.onClick as (e: unknown) => void)(clickEvent());
    expect(onDecide).toHaveBeenCalledWith("r1", "allow");
    (deny!.props.onClick as (e: unknown) => void)(clickEvent());
    expect(onDecide).toHaveBeenCalledWith("r1", "deny");
  });

  it("T8-driver-bar omits the ⚒ sub-label when the gate has none", () => {
    const text = plainText(markupOf({ gate: { requestId: "r1", toolName: "Write" }, isDriver: true }));
    expect(text).toContain("🔐 Write");
    expect(text).not.toContain("⚒");
  });

  it("T8-non-driver-bar names the driver and offers TAKE THE WHEEL, no decide buttons", () => {
    const props = baseProps({ isDriver: false, driverName: "Frank", driverGlyph: "▲" });
    const text = plainText(renderToStaticMarkup(<GateBar {...props} />));
    expect(text).toContain("🔐 waiting on ▲ Frank");

    const onTakeWheel = vi.fn();
    const nodes = hostNodes({ ...props, onTakeWheel });
    // No decide buttons for a non-driver.
    expect(nodes.some((n) => hasClass(n, "btn") && hasClass(n, "green"))).toBe(false);
    expect(nodes.some((n) => hasClass(n, "btn") && hasClass(n, "red"))).toBe(false);
    // The wheel button (btn gold) is present and invokes onTakeWheel.
    const wheel = nodes.find((n) => n.type === "button" && hasClass(n, "gold"));
    expect(wheel).toBeDefined();
    expect(renderToStaticMarkup(<GateBar {...props} />)).toContain("🛞 TAKE THE WHEEL");
    (wheel!.props.onClick as (e: unknown) => void)(clickEvent());
    expect(onTakeWheel).toHaveBeenCalledTimes(1);
  });

  it("T8-jump-wiring fires onJump(requestId) when the bar body (not a button) is clicked", () => {
    const onJump = vi.fn();
    const onDecide = vi.fn();
    const gate = { requestId: "r1", toolName: "Write" };
    const nodes = hostNodes(baseProps({ gate, isDriver: true, onJump, onDecide }));
    const bar = nodes.find((n) => hasClass(n, "gatebar"));
    expect(bar).toBeDefined();
    (bar!.props.onClick as (e: unknown) => void)(clickEvent());
    expect(onJump).toHaveBeenCalledWith("r1");

    // A decide-button click stops propagation — it decides, it does not jump.
    onJump.mockClear();
    const approve = nodes.find((n) => hasClass(n, "btn") && hasClass(n, "green"));
    (approve!.props.onClick as (e: unknown) => void)(clickEvent());
    expect(onDecide).toHaveBeenCalledWith("r1", "allow");
  });
});
