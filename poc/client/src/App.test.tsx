/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import React from "react";
import type { LoggedEvent } from "./types";
import { Transcript } from "./components/Transcript";
import { SubSessionRail } from "./components/SubSessionRail";
import { PromptBar } from "./components/PromptBar";
import { Crt } from "./components/Crt";
import { THEME_KEY } from "./theme";

/** App wiring for the sub-session rail (Task 4). This repo has no DOM test env
 *  (docs/tech-debt.md); SessionView is a hook-heavy component, so we mount it
 *  through a minimal but STATEFUL hooks runtime installed on React's internals
 *  (same H_KEY seam as Transcript.test.tsx) and mock `useSessionSocket` so the
 *  event log is controllable. `useEffect` is a no-op — matching the static
 *  render semantics the rest of the suite relies on — so nothing here touches
 *  window/document; the one render-path global (`localStorage` in a useState
 *  initializer) is stubbed below. */

const socket = vi.hoisted(() => ({
  current: null as unknown as ReturnType<
    typeof import("./useSessionSocket").useSessionSocket
  >,
}));
vi.mock("./useSessionSocket", () => ({ useSessionSocket: () => socket.current }));

// Task 2: mounting the OUTER `App` needs its routing under test control — auth
// is seeded null (its only setter lives in an effect, inert in this harness), so
// the real `screenFor` would pin every mount to "checking". `screenOverride`
// lets a test force the "session" route to reach the wired header/CRT; unset it
// falls through to the real precedence.
const screenOverride = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("./authRoute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./authRoute")>();
  return {
    ...actual,
    screenFor: (input: Parameters<typeof actual.screenFor>[0]) =>
      screenOverride.value ?? actual.screenFor(input),
  };
});

// `theme` reads live off localStorage in a useState initializer; `lsGet` lets a
// test seed the stored theme without disturbing other keys (which stay null).
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
// `App` (unlike `SessionView`) resolves identity from sessionStorage on render.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};
// `App`'s render reads window.location.search (URL routing). Overwritten per test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = { location: { search: "" } };

// Imported AFTER the mock so SessionView binds to the mocked socket hook.
const { SessionView, default: App } = await import("./App");

const H_KEY = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
type El = { type: unknown; props: Record<string, unknown> };

/** Mount a function component through a stateful hooks runtime. `useState`
 *  setters trigger a synchronous re-render (so clicking a chip actually swaps
 *  the projected view), `useEffect` is inert, `useMemo` recomputes. Returns a
 *  live accessor over the current element tree. */
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

const textOf = (node: unknown): string => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as El;
  return n.props ? textOf(n.props.children) : "";
};

const railOf = (nodes: El[]) => nodes.find((n) => n.type === SubSessionRail);
const transcriptOf = (nodes: El[]) => nodes.find((n) => n.type === Transcript);
const promptBarOf = (nodes: El[]) => nodes.find((n) => n.type === PromptBar);
const headerOf = (nodes: El[]) =>
  nodes.find((n) => typeof n.props.className === "string" && n.props.className === "subsession-header");
const stopBtn = (nodes: El[]) =>
  nodes.find((n) => n.type === "button" && textOf(n).includes("■ STOP"));

const ts = "2026-07-30T10:00:00Z";
const evt = (o: Partial<LoggedEvent>, seq: number): LoggedEvent =>
  ({ ts, seq, ...o }) as LoggedEvent;

/** A driver ("frank") with one running sub-session "A" joined to task "t1",
 *  which carries status/summary/tokens enrichment. */
const driverEvents = (over: { taskId?: boolean; taskStatus?: string } = {}): LoggedEvent[] => {
  const withTask = over.taskId ?? true;
  const list: LoggedEvent[] = [
    evt({ type: "presence_join", userId: "frank", name: "Frank" }, 1),
    evt({ type: "control_change", userId: "frank" }, 2),
    evt({ type: "tool_call", toolName: "Agent", toolUseId: "A", input: { description: "scan tests" } }, 3),
  ];
  if (withTask) {
    list.push(evt({ type: "task_event", subtype: "started", toolUseId: "A", taskId: "t1" }, 4));
    list.push(
      evt(
        {
          type: "task_event",
          taskId: "t1",
          status: over.taskStatus ?? "running",
          summary: "did the scan",
          tokens: 4200,
        },
        5,
      ),
    );
  }
  return list;
};

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
    invites: [],
    send,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const baseProps = (over: Partial<{ userId: string; screen: string | null }> = {}) => ({
  userId: over.userId ?? "frank",
  sessionId: "s1",
  projectId: "default",
  profile: { name: "Frank", glyph: "▲", color: "#fff" },
  screen: over.screen ?? null,
  onScreenChange: () => {},
  signedInAs: null,
});

let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  send = vi.fn();
  screenOverride.value = null;
  lsGet = () => null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window.location.search = "";
});

const nodeOfType = (nodes: El[], t: unknown) => nodes.find((n) => n.type === t);

describe("App — sub-session rail wiring", () => {
  it("T4-App-state routes rail selection and MAIN compact-row clicks through the same setter, and the view starts at MAIN", () => {
    socket.current = baseSocket(driverEvents(), send);
    const app = mount(SessionView as (p: unknown) => unknown, baseProps());
    let nodes = app.nodes();

    // Rail and Transcript are driven by the SAME setter — a chip click and a
    // MAIN compact-row click (onOpenSubSession) open the same view.
    const rail = railOf(nodes)!;
    const transcript = transcriptOf(nodes)!;
    expect(rail.props.onSelect).toBe(transcript.props.onOpenSubSession);
    // Initial state is MAIN (null): Transcript is handed view=null.
    expect(transcript.props.view).toBeNull();

    // Clicking a chip swaps the projected view; Transcript follows.
    (rail.props.onSelect as (k: string | null) => void)("A");
    nodes = app.nodes();
    expect(transcriptOf(nodes)!.props.view).toBe("A");
  });

  it("T4-view-reset defaults the projected view to MAIN (null) on mount — a fresh remount lands on MAIN", () => {
    socket.current = baseSocket(driverEvents(), send);
    const app = mount(SessionView as (p: unknown) => unknown, baseProps());
    const transcript = transcriptOf(app.nodes())!;
    // View state is component-local, so a session switch (URL-change remount)
    // resets it for free; the assertable half is that initial state is null.
    expect(transcript.props.view).toBeNull();
    expect(railOf(app.nodes())!.props.view).toBeNull();
  });

  it("T4-STOP-visible shows ■ STOP for a driver over a running joined task and sends stop_task on click", () => {
    socket.current = baseSocket(driverEvents(), send);
    const app = mount(SessionView as (p: unknown) => unknown, baseProps());
    (railOf(app.nodes())!.props.onSelect as (k: string | null) => void)("A");
    const nodes = app.nodes();
    const btn = stopBtn(nodes);
    expect(btn).toBeDefined();
    (btn!.props.onClick as () => void)();
    expect(send).toHaveBeenCalledWith({ type: "stop_task", taskId: "t1" });
  });

  it("T4-STOP-hidden hides ■ STOP for a non-driver, an unjoined sub-session, or a non-running task", () => {
    // (a) non-driver viewer
    socket.current = baseSocket(driverEvents(), send);
    let app = mount(SessionView as (p: unknown) => unknown, baseProps({ userId: "watcher" }));
    (railOf(app.nodes())!.props.onSelect as (k: string | null) => void)("A");
    expect(headerOf(app.nodes())).toBeDefined(); // header still shows…
    expect(stopBtn(app.nodes())).toBeUndefined(); // …but no STOP for a watcher

    // (b) no taskId join
    socket.current = baseSocket(driverEvents({ taskId: false }), send);
    app = mount(SessionView as (p: unknown) => unknown, baseProps());
    (railOf(app.nodes())!.props.onSelect as (k: string | null) => void)("A");
    expect(stopBtn(app.nodes())).toBeUndefined();

    // (c) task not running
    socket.current = baseSocket(driverEvents({ taskStatus: "completed" }), send);
    app = mount(SessionView as (p: unknown) => unknown, baseProps());
    (railOf(app.nodes())!.props.onSelect as (k: string | null) => void)("A");
    expect(stopBtn(app.nodes())).toBeUndefined();
  });

  it("T4-view-header-enrichment shows the joined task's status, summary and token count", () => {
    socket.current = baseSocket(driverEvents(), send);
    const app = mount(SessionView as (p: unknown) => unknown, baseProps());
    (railOf(app.nodes())!.props.onSelect as (k: string | null) => void)("A");
    const header = headerOf(app.nodes())!;
    const text = textOf(header);
    expect(text).toContain("⚒ scan tests");
    expect(text).toContain("running"); // derived.tasks.get(taskId).status
    expect(text).toContain("did the scan"); // .summary
    expect(text).toContain("4200 tok"); // .tokens
  });

  it("T4-prompt-bar-invariant keeps the prompt bar addressing the main agent in any view", () => {
    socket.current = baseSocket(driverEvents(), send);
    const app = mount(SessionView as (p: unknown) => unknown, baseProps());
    // Switch into a sub-session view, then prompt.
    (railOf(app.nodes())!.props.onSelect as (k: string | null) => void)("A");
    const nodes = app.nodes();
    const bar = promptBarOf(nodes)!;
    // The prompt bar carries no sub-session/view prop — it is unaware of the view.
    expect("view" in bar.props).toBe(false);
    // Prompting still targets the main agent (a plain prompt frame, unscoped).
    (bar.props.onPrompt as (t: string) => void)("hello main");
    expect(send).toHaveBeenCalledWith({ type: "prompt", text: "hello main" });
  });

  it("T4-screens-coexist renders the rail only on the default transcript surface, not on other screens", () => {
    // Default surface: rail present.
    socket.current = baseSocket(driverEvents(), send);
    const dflt = mount(SessionView as (p: unknown) => unknown, baseProps());
    expect(railOf(dflt.nodes())).toBeDefined();

    // Other screens return before the transcript surface — no rail, no header.
    for (const screen of ["workflows", "skills", "oversight", "invite"]) {
      socket.current = baseSocket(driverEvents(), send);
      const app = mount(SessionView as (p: unknown) => unknown, baseProps({ screen }));
      expect(railOf(app.nodes())).toBeUndefined();
      expect(headerOf(app.nodes())).toBeUndefined();
    }
  });

  it("T2-crt-coupling maps the stored theme to CRT intensity at the App mount", () => {
    // Clean → the CRT overlays are stripped (intensity="off").
    lsGet = (k) => (k === THEME_KEY ? "clean" : null);
    let app = mount(App as (p: unknown) => unknown, {});
    expect(nodeOfType(app.nodes(), Crt)!.props.intensity).toBe("off");

    // Absent / arcade → the full arcade CRT (intensity="full").
    lsGet = () => null;
    app = mount(App as (p: unknown) => unknown, {});
    expect(nodeOfType(app.nodes(), Crt)!.props.intensity).toBe("full");
  });

  it("T2-toggle flips the theme through useTheme and re-couples the CRT and header", () => {
    // Reach the wired session surface so App threads theme + onThemeToggle down.
    screenOverride.value = "session";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window.location.search = "?session=s1&project=default&name=Frank";
    lsGet = () => null; // no stored theme → starts arcade
    socket.current = baseSocket(driverEvents(), send);

    const app = mount(App as (p: unknown) => unknown, {});
    let nodes = app.nodes();

    // Initial: arcade → CRT full, and the value is handed to SessionView.
    expect(nodeOfType(nodes, Crt)!.props.intensity).toBe("full");
    const sv = nodeOfType(nodes, SessionView)!;
    expect(sv.props.theme).toBe("arcade");
    expect(typeof sv.props.onThemeToggle).toBe("function");

    // Toggle (the same callback the header button fires) flips to clean.
    (sv.props.onThemeToggle as () => void)();
    nodes = app.nodes();
    expect(nodeOfType(nodes, Crt)!.props.intensity).toBe("off");
    expect(nodeOfType(nodes, SessionView)!.props.theme).toBe("clean");

    // …and back again — the toggle is a true flip, not a one-way set.
    (nodeOfType(nodes, SessionView)!.props.onThemeToggle as () => void)();
    nodes = app.nodes();
    expect(nodeOfType(nodes, Crt)!.props.intensity).toBe("full");
    expect(nodeOfType(nodes, SessionView)!.props.theme).toBe("arcade");
  });

  it("T3-glass-is-the-page mounts Crt as the App root — no Cabinet chrome wraps it", () => {
    lsGet = () => null;
    const app = mount(App as (p: unknown) => unknown, {});
    const nodes = app.nodes();
    // The outermost node the App renders is the CRT glass itself.
    expect(nodes[0].type).toBe(Crt);
    // Cabinet's chrome surfaces are gone from the tree entirely.
    const className = (n: El) =>
      typeof n.props.className === "string" ? n.props.className : "";
    for (const chrome of ["cabinet", "cabinet-inner", "crt-chrome-top", "marquee"]) {
      expect(nodes.some((n) => className(n).split(" ").includes(chrome))).toBe(false);
    }
    // And the CRT wraps the routed screen body directly as its children.
    expect(nodeOfType(nodes, Crt)!.props.children).toBeDefined();
  });

  it("T4-project-level-untouched: the branch diff touches no project-level component", () => {
    const changed = execFileSync("git", ["diff", "--name-only", "main"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const forbidden = /(ProjectPicker|SessionPicker|MachinePanel|RecordPanel)/;
    expect(changed.filter((f) => forbidden.test(f))).toEqual([]);
  });
});
