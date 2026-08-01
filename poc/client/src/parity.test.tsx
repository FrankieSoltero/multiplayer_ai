import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import type { LoggedEvent } from "./types";
import { Header } from "./components/Header";
import { ThinkingStrip } from "./components/ThinkingStrip";
import { GateBar } from "./components/GateBar";
import { SubSessionRail } from "./components/SubSessionRail";
import { ProjectPicker } from "./components/ProjectPicker";
import { Crt } from "./components/Crt";
import { THEME_KEY, type Theme } from "./theme";

/** Task 14 — cross-theme control-set parity (plan §3, constraint 2: "absolute
 *  functional parity — a theme changes how something reads, never whether it
 *  is there"). Clean is a CSS-only override layer, so the ONE permitted
 *  behavioral divergence is spec §2.2's opt-in rule: Arcade auto-opens the
 *  arcade strip's game LANE while the agent is busy, Clean keeps the thinking
 *  strip's STATUS LINE without the lane (manual open identical in both).
 *
 *  This file pins that invariant whole-surface: the SAME fixture is rendered
 *  under `theme="arcade"` and `theme="clean"` through the hooks-shim mount of
 *  `App.test.tsx` (this repo has no DOM test env — docs/tech-debt.md), the set
 *  of interactive affordances (control text + handler PRESENCE, never handler
 *  identity — handlers are fresh closures per mount) is extracted by tree
 *  walk, and the two sets are asserted IDENTICAL. The opt-in exception row
 *  then asserts the lane auto-open as the ONLY difference on a busy surface,
 *  with the status line present in both themes' busy state. */

const socket = vi.hoisted(() => ({
  current: null as unknown as ReturnType<
    typeof import("./useSessionSocket").useSessionSocket
  >,
}));
vi.mock("./useSessionSocket", () => ({ useSessionSocket: () => socket.current }));

// Same routing seam as App.test.tsx: mounting the OUTER `App` for the picker
// row needs its routing under test control (auth is seeded null → the real
// `screenFor` would pin every mount to "checking").
const screenOverride = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("./authRoute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./authRoute")>();
  return {
    ...actual,
    screenFor: (input: Parameters<typeof actual.screenFor>[0]) =>
      screenOverride.value ?? actual.screenFor(input),
  };
});

// `useTheme` reads localStorage in a useState initializer; `lsGet` seeds the
// stored theme per mount without disturbing other keys (which stay null).
let lsGet: (key: string) => string | null = () => null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => lsGet(k),
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};
// `App`'s render reads window.location.search (URL routing).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = { location: { search: "" } };

// Imported AFTER the mock so SessionView binds to the mocked socket hook.
const { SessionView, default: App } = await import("./App");

const H_KEY = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
type El = { type: unknown; props: Record<string, unknown> };

/** The stateful hooks-shim mount, verbatim from App.test.tsx: `useState`
 *  setters re-render synchronously, `useEffect` is inert. Returns a live
 *  accessor over the current element tree. */
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
  return { nodes: () => collect(tree) };
}

function collect(tree: unknown): El[] {
  const out: El[] = [];
  const visit = (node: unknown) => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const n = node as El;
    if (n.props) {
      out.push(n);
      visit(n.props.children);
    }
  };
  visit(tree);
  return out;
}

/** The one-shot `renderTree` of Transcript.test.tsx: executes a nested
 *  component element (e.g. the ThinkingStrip / ProjectPicker lifted out of a
 *  mounted tree) under the inert runtime and walks its host-node tree. */
const renderTree = (element: React.ReactElement): El[] => {
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
    return collect(rendered);
  } finally {
    internals.H = prev;
  }
};

const textOf = (node: unknown): string => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as El;
  return n.props ? textOf(n.props.children) : "";
};

const hasClass = (n: El, cls: string): boolean =>
  typeof n.props.className === "string" && (n.props.className as string).split(" ").includes(cls);

const nodeOfType = (nodes: El[], t: unknown) => nodes.find((n) => n.type === t);

const typeName = (t: unknown): string =>
  typeof t === "string"
    ? t
    : typeof t === "function"
      ? ((t as { name?: string }).name ?? "anonymous")
      : String(t);

/** The interactive-affordance set of a rendered tree: one descriptor per
 *  control — a host <button>, a role="button" node, or any node carrying a
 *  handler prop — as `type | label | handlers`. Handler PRESENCE only (never
 *  identity): handlers are fresh closures per mount, so cross-theme equality
 *  can only be about WHICH controls exist and WHICH handlers they carry.
 *  Non-handler props (theme, open, intensity, …) are deliberately EXCLUDED —
 *  those are the decoration layer; this set is the control layer. */
const controlSet = (nodes: El[]): string[] => {
  const out: string[] = [];
  for (const n of nodes) {
    const handlers = Object.keys(n.props)
      .filter((k) => /^on[A-Z]/.test(k) && typeof n.props[k] === "function")
      .sort();
    if (n.type !== "button" && n.props.role !== "button" && handlers.length === 0) continue;
    const label = typeof n.type === "string" ? textOf(n).trim() : typeName(n.type);
    out.push(`${typeName(n.type)}|${label}|${handlers.join(",")}`);
  }
  return out.sort();
};

/** Prop-object diff comparing handlers by PRESENCE (fresh closures per mount)
 *  and everything else by value. Used to assert the opt-in divergence is the
 *  ONLY difference between the two themes' ThinkingStrip props. */
const propDiff = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((k) => {
      const va = a[k];
      const vb = b[k];
      if (typeof va === "function" || typeof vb === "function") return typeof va !== typeof vb;
      return JSON.stringify(va) !== JSON.stringify(vb);
    });

const ts = "2026-07-30T10:00:00Z";
const evt = (o: Partial<LoggedEvent>, seq: number): LoggedEvent =>
  ({ ts, seq, ...o }) as LoggedEvent;

/** The session-surface fixture: driver frank, TWO sub-sessions (A/B), the
 *  agent busy on a bare tool_call, and one PENDING gate (r1, undecided). */
const surfaceEvents = (): LoggedEvent[] => [
  evt({ type: "presence_join", userId: "frank", name: "Frank", glyph: "▲" }, 1),
  evt({ type: "control_change", userId: "frank" }, 2),
  evt({ type: "tool_call", toolName: "Agent", toolUseId: "A", input: { description: "scan tests" } }, 3),
  evt({ type: "tool_call", toolName: "Agent", toolUseId: "B", input: { description: "write docs" } }, 4),
  evt({ type: "tool_call", toolName: "Bash", input: { command: "ls" } }, 5),
  evt({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "ls" } }, 6),
];

/** The busy fixture: a bare tool_call with no turn_end → agentBusy === true. */
const busyEvents = (): LoggedEvent[] => [
  evt({ type: "presence_join", userId: "frank", name: "Frank" }, 1),
  evt({ type: "control_change", userId: "frank" }, 2),
  evt({ type: "tool_call", toolName: "Bash", input: { command: "ls" } }, 3),
];

const baseSocket = (events: LoggedEvent[], send: unknown) =>
  ({
    events,
    errors: [] as string[],
    connected: false,
    projectSessions: [],
    arcade: [],
    plugins: [],
    pluginsEnabled: false,
    oversight: { enabled: false, latest: null },
    send,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const baseProps = (over: { theme: Theme }) => ({
  userId: "frank",
  sessionId: "s1",
  projectId: "default",
  profile: { name: "Frank", glyph: "▲", color: "#fff" },
  screen: null,
  onScreenChange: () => {},
  signedInAs: null,
  theme: over.theme,
  onThemeToggle: () => {},
});

let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  send = vi.fn();
  screenOverride.value = null;
  lsGet = () => null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window.location.search = "";
});

describe("T14 — cross-theme control-set parity", () => {
  it("T14-control-set-parity: the session surface (pending gate + 2 sub-sessions + arcade open) exposes an IDENTICAL control set under arcade and clean", () => {
    // Arcade OPEN — via the header's own toggle, the same manual path in both
    // themes (Task 7: manual open works identically), so `open` is true on
    // both strips and no lane difference leaks into this row.
    const mountSurface = (theme: Theme) => {
      socket.current = baseSocket(surfaceEvents(), send);
      const app = mount(SessionView as (p: unknown) => unknown, baseProps({ theme }));
      (nodeOfType(app.nodes(), Header)!.props.onToggleArcade as () => void)();
      return app.nodes();
    };
    const arcade = mountSurface("arcade");
    const clean = mountSurface("clean");

    // The fixture really is the required surface, in BOTH themes — a pending
    // gate pinned in the bar, 2 sub-sessions in the rail, the arcade open.
    for (const nodes of [arcade, clean]) {
      expect(nodeOfType(nodes, GateBar)!.props.gate).not.toBeNull();
      expect(nodeOfType(nodes, SubSessionRail)!.props.subSessions).toHaveLength(2);
      expect(nodeOfType(nodes, ThinkingStrip)!.props.open).toBe(true);
    }
    // …and the two renders really are under DIFFERENT themes (non-vacuous).
    expect(nodeOfType(arcade, Header)!.props.theme).toBe("arcade");
    expect(nodeOfType(clean, Header)!.props.theme).toBe("clean");

    // The extracted control sets are IDENTICAL.
    const arcadeControls = controlSet(arcade);
    const cleanControls = controlSet(clean);
    expect(arcadeControls.length).toBeGreaterThan(0);
    expect(arcadeControls).toEqual(cleanControls);
  });

  it("T14-opt-in-exception: the busy surface's ONLY cross-theme difference is the game-lane auto-open — and the status line renders in BOTH themes' busy state", () => {
    const mountBusy = (theme: Theme) => {
      socket.current = baseSocket(busyEvents(), send);
      return mount(SessionView as (p: unknown) => unknown, baseProps({ theme }));
    };
    const arcade = mountBusy("arcade");
    const clean = mountBusy("clean");
    const arcadeStrip = nodeOfType(arcade.nodes(), ThinkingStrip)!;
    const cleanStrip = nodeOfType(clean.nodes(), ThinkingStrip)!;

    // The ONE permitted divergence (constraint 2, spec §2.2): arcade
    // auto-opens the game LANE on busy, clean does not…
    expect(arcadeStrip.props.open).toBe(true);
    expect(cleanStrip.props.open).toBe(false);
    // …and it is explicitly the ONLY difference between the two strips'
    // props: same keys, same values, same handler presence — only `open`.
    expect(propDiff(arcadeStrip.props, cleanStrip.props)).toEqual(["open"]);

    // The thinking strip's STATUS LINE is present in BOTH themes' busy state:
    // busy=true mounts the strip in both, and executing the strip element
    // renders the "IS THINKING" line in both — while the game lane (`.lane`)
    // renders only where it auto-opened.
    expect(arcadeStrip.props.busy).toBe(true);
    expect(cleanStrip.props.busy).toBe(true);
    const arcadeTree = renderTree(arcadeStrip as unknown as React.ReactElement);
    const cleanTree = renderTree(cleanStrip as unknown as React.ReactElement);
    expect(arcadeTree.map(textOf).join("")).toContain("IS THINKING");
    expect(cleanTree.map(textOf).join("")).toContain("IS THINKING");
    expect(arcadeTree.some((n) => hasClass(n, "lane"))).toBe(true);
    expect(cleanTree.some((n) => hasClass(n, "lane"))).toBe(false);

    // Everything ELSE on the busy surface is identical across themes.
    expect(controlSet(arcade.nodes())).toEqual(controlSet(clean.nodes()));
  });

  it("T14-picker-parity: the project screen exposes an IDENTICAL control set under arcade and clean", () => {
    // The hub entrance (ProjectPicker) routed through App, with the stored
    // theme seeded per mount so `useTheme` resolves each side for real.
    screenOverride.value = "entrance";
    const mountPicker = (stored: string) => {
      lsGet = (k) => (k === THEME_KEY ? stored : null);
      return mount(App as (p: unknown) => unknown, {}).nodes();
    };
    const arcade = mountPicker("arcade");
    const clean = mountPicker("clean");

    // The two mounts really resolved DIFFERENT themes — the CRT couples to
    // the stored value (decoration; not part of the control set).
    expect(nodeOfType(arcade, Crt)!.props.intensity).toBe("full");
    expect(nodeOfType(clean, Crt)!.props.intensity).toBe("off");
    // The routed surface is the project picker in both.
    const arcadePicker = nodeOfType(arcade, ProjectPicker)!;
    const cleanPicker = nodeOfType(clean, ProjectPicker)!;
    expect(arcadePicker).toBeDefined();
    expect(cleanPicker).toBeDefined();

    // App's own wiring adds no theme-gated control…
    expect(controlSet(arcade)).toEqual(controlSet(clean));
    // …and the picker's own control set is IDENTICAL across themes.
    const arcadeControls = controlSet(renderTree(arcadePicker as unknown as React.ReactElement));
    const cleanControls = controlSet(renderTree(cleanPicker as unknown as React.ReactElement));
    expect(arcadeControls.length).toBeGreaterThan(0);
    expect(arcadeControls).toEqual(cleanControls);
  });
});
