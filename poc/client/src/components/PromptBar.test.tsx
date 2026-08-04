import { describe, expect, it, vi } from "vitest";
import React from "react";
import { PromptBar } from "./PromptBar";

/** PromptBar's keyboard contract, exercised through the stateful hooks-shim
 *  mount (verbatim from App.test.tsx — setters re-render synchronously,
 *  useEffect inert). The repo has no DOM test env (docs/tech-debt.md), so the
 *  input is found by tree walk and its onKeyDown is called with a fake event;
 *  `blur` is a spy on the fake currentTarget. */

const H_KEY = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
type El = { type: unknown; props: Record<string, unknown> };

function mount(Comp: (p: unknown) => unknown, props: unknown) {
  const internals = (React as unknown as Record<string, { H: unknown }>)[H_KEY];
  const prevH = internals.H;
  const hooks: unknown[] = [];
  let i = 0;
  let tree: unknown;
  const runtime = {
    useRef: (v: unknown) => {
      const k = i++;
      if (hooks[k] === undefined) hooks[k] = { current: v };
      return hooks[k];
    },
    useState: (init: unknown) => {
      const k = i++;
      if (!(k in hooks)) hooks[k] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (nv: unknown) => {
        hooks[k] = typeof nv === "function" ? (nv as (p: unknown) => unknown)(hooks[k]) : nv;
        render();
      };
      return [hooks[k], set];
    },
    useEffect: () => {},
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useContext: () => undefined,
    useReducer: (_r: unknown, init: unknown) => [init, () => {}],
  };
  function render() {
    i = 0;
    internals.H = runtime;
    try {
      tree = Comp(props);
    } finally {
      internals.H = prevH;
    }
  }
  render();
  const collect = (node: unknown, out: El[] = []): El[] => {
    if (node == null || typeof node !== "object") return out;
    if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out; }
    const n = node as El;
    if (n.props) { out.push(n); collect(n.props.children, out); }
    return out;
  };
  return { nodes: () => collect(tree) };
}

const baseProps = () => ({
  isDriver: true,
  agentBusy: false,
  watcherNames: [],
  skills: [{ name: "exit", description: "leave" }],
  gatesPending: 0,
  onPrompt: () => {},
  onTakeWheel: () => {},
  onSuggestSkill: () => {},
  onClientCommand: () => {},
  inputRef: { current: null },
});

const inputOf = (nodes: El[]): El =>
  nodes.find((n) => n.type === "input" && n.props.role === "combobox")!;

const escEvent = (blur: () => void) =>
  ({ key: "Escape", currentTarget: { blur }, preventDefault: () => {} });

describe("PromptBar — Escape is the way out of the prompt", () => {
  it("blurs the input when the slash menu is NOT open, returning focus to nav", () => {
    // With text in the box the caret owns the arrows (yieldsArrows) — this
    // blur is the only keyboard path back to session navigation.
    const app = mount(PromptBar as (p: unknown) => unknown, baseProps());
    const input = inputOf(app.nodes());
    // Type something: arrows now belong to the caret, Esc must still get out.
    (input.props.onChange as (e: unknown) => void)({ target: { value: "refactor auth" } });
    const blur = vi.fn();
    (inputOf(app.nodes()).props.onKeyDown as (e: unknown) => void)(escEvent(blur));
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("does NOT blur when the slash menu is open — the first Esc only dismisses the menu", () => {
    const app = mount(PromptBar as (p: unknown) => unknown, baseProps());
    const input = inputOf(app.nodes());
    (input.props.onChange as (e: unknown) => void)({ target: { value: "/e" } });
    expect(app.nodes().some((n) => n.props.role === "listbox")).toBe(true);
    const blur = vi.fn();
    (inputOf(app.nodes()).props.onKeyDown as (e: unknown) => void)(escEvent(blur));
    expect(blur).not.toHaveBeenCalled();
    expect(app.nodes().some((n) => n.props.role === "listbox")).toBe(false);
    // …and the second Esc, menu now closed, does blur.
    (inputOf(app.nodes()).props.onKeyDown as (e: unknown) => void)(escEvent(blur));
    expect(blur).toHaveBeenCalledTimes(1);
  });
});
