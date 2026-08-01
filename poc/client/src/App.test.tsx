/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import type { LoggedEvent, ProjectSessionInfo } from "./types";
import { Transcript } from "./components/Transcript";
import { SubSessionRail } from "./components/SubSessionRail";
import { PromptBar } from "./components/PromptBar";
import { Crt } from "./components/Crt";
import { Header } from "./components/Header";
import { ThinkingStrip } from "./components/ThinkingStrip";
import { GateBar } from "./components/GateBar";
import { THEME_KEY, type Theme } from "./theme";
import { PULL_STORAGE_KEY } from "./pulls";
import { sessionUrlFrom } from "./pickerUrl";

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

const baseProps = (over: Partial<{ userId: string; screen: string | null; theme: Theme }> = {}) => ({
  userId: over.userId ?? "frank",
  sessionId: "s1",
  projectId: "default",
  profile: { name: "Frank", glyph: "▲", color: "#fff" },
  screen: over.screen ?? null,
  onScreenChange: () => {},
  signedInAs: null,
  // Task 7: SessionView consumes `theme` to gate the arcade's busy auto-open.
  // Default arcade so the pre-Task-7 tests keep their as-shipped behavior.
  theme: over.theme ?? ("arcade" as Theme),
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
    // This harness only materializes App's OWN returned JSX — nested components
    // (Crt, Cabinet, …) are never executed (see the mount/collect seam above).
    // So we discriminate against what App itself renders, by COMPONENT IDENTITY,
    // not by the chrome classNames the old Cabinet emitted from inside its own
    // body: those never materialize here, so asserting their absence passes
    // vacuously and would stay green even if the cabinet were reinstated.
    //
    // The glass IS the page: the outermost element App returns is the CRT
    // itself. A revert that re-wraps `<Crt>` in a `<Cabinet>` makes nodes[0] the
    // Cabinet element and fails this line.
    expect(nodes[0].type).toBe(Crt);
    // And the retired Cabinet appears NOWHERE in App's render output — checked
    // by the component-function name, since the symbol no longer exists to
    // import. A reinstated `<Cabinet>` (top-level or nested) trips this.
    const isCabinet = (t: unknown): boolean =>
      typeof t === "function" && (t as { name?: string }).name === "Cabinet";
    expect(nodes.some((n) => isCabinet(n.type))).toBe(false);
    // And the CRT wraps the routed screen body directly as its children.
    expect(nodeOfType(nodes, Crt)!.props.children).toBeDefined();
  });
});

describe("App — games opt-in + clean busy status line (Task 7)", () => {
  const stripOf = (nodes: El[]) => nodes.find((n) => n.type === ThinkingStrip);
  const headerCompOf = (nodes: El[]) => nodes.find((n) => n.type === Header);

  // A busy agent: a bare `tool_call` with no `turn_end` leaves
  // `derived.agentBusy === true` (derive.ts). This is the state that, in Arcade,
  // auto-opens the arcade lane.
  const busyEvents = (): LoggedEvent[] => [
    evt({ type: "presence_join", userId: "frank", name: "Frank" }, 1),
    evt({ type: "control_change", userId: "frank" }, 2),
    evt({ type: "tool_call", toolName: "Bash", input: { command: "ls" } }, 3),
  ];
  // Idle: the same log closed by a `turn_end` → `derived.agentBusy === false`.
  const idleEvents = (): LoggedEvent[] => [...busyEvents(), evt({ type: "turn_end" }, 4)];
  // A pending permission gate (undecided) while the agent is busy.
  const gateEvents = (): LoggedEvent[] => [
    ...busyEvents(),
    evt({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "ls" } }, 4),
  ];

  it("T7-games-opt-in gates the busy auto-open of the game LANE to arcade; clean does not auto-open, but manual open still works", () => {
    // The ONE allowed behavioral difference (constraint 2): with the agent busy,
    // arcade auto-opens the game lane and clean does not.
    socket.current = baseSocket(busyEvents(), send);
    const arcadeBusy = stripOf(mount(SessionView as (p: unknown) => unknown, baseProps({ theme: "arcade" })).nodes())!;
    socket.current = baseSocket(busyEvents(), send);
    const cleanBusy = stripOf(mount(SessionView as (p: unknown) => unknown, baseProps({ theme: "clean" })).nodes())!;
    expect(arcadeBusy.props.open).toBe(true); // arcade auto-opens the lane
    expect(cleanBusy.props.open).toBe(false); // clean opts out — no auto-open
    expect(cleanBusy.props.busy).toBe(true); // …but the strip is still mounted

    // The ARCADE header button still opens the lane manually in Clean (idle).
    socket.current = baseSocket(idleEvents(), send);
    const cleanIdle = mount(SessionView as (p: unknown) => unknown, baseProps({ theme: "clean" }));
    (headerCompOf(cleanIdle.nodes())!.props.onToggleArcade as () => void)();
    expect(stripOf(cleanIdle.nodes())!.props.open).toBe(true); // manual open works identically
  });

  it("T7-arcade-unchanged auto-opens the game lane when the agent is busy in arcade, exactly as today", () => {
    socket.current = baseSocket(busyEvents(), send);
    const strip = stripOf(mount(SessionView as (p: unknown) => unknown, baseProps({ theme: "arcade" })).nodes())!;
    expect(strip.props.busy).toBe(true);
    expect(strip.props.open).toBe(true); // busy auto-opens the arcade lane
  });

  it("T7-busy-status-line renders the thinking strip's status line in clean-busy with the lane closed — the affordance exists in both themes", () => {
    // Clean-busy: the strip is mounted (busy=true → the "IS THINKING" status line
    // renders) while the game lane is NOT auto-opened (open=false) — spec §2.2.
    socket.current = baseSocket(busyEvents(), send);
    const cleanBusy = stripOf(mount(SessionView as (p: unknown) => unknown, baseProps({ theme: "clean" })).nodes())!;
    expect(cleanBusy).toBeDefined();
    expect(cleanBusy.props.busy).toBe(true); // status line renders…
    expect(cleanBusy.props.open).toBe(false); // …without the game lane auto-opening

    // The busy-thinking affordance exists in BOTH themes (arcade also mounts +
    // busy), while the lane auto-open is the sole difference.
    socket.current = baseSocket(busyEvents(), send);
    const arcadeBusy = stripOf(mount(SessionView as (p: unknown) => unknown, baseProps({ theme: "arcade" })).nodes())!;
    expect(arcadeBusy.props.busy).toBe(true);
    expect(arcadeBusy.props.open).toBe(true);
  });

  it("T7-decidability keeps gate cards, wheel controls and buttons functional in clean (parity — constraint 2)", () => {
    socket.current = baseSocket(gateEvents(), send);
    const nodes = mount(SessionView as (p: unknown) => unknown, baseProps({ theme: "clean" })).nodes();

    // Gate-card surface: the Transcript renders permission cards and carries the
    // decision callback, unchanged by the Clean theme.
    const transcript = transcriptOf(nodes)!;
    expect(transcript).toBeDefined();
    expect(typeof transcript.props.onPermission).toBe("function");

    // The pending gate is counted and handed to the prompt bar (decidability).
    const bar = promptBarOf(nodes)!;
    expect(bar.props.gatesPending).toBe(1);
    expect(typeof bar.props.onTakeWheel).toBe("function"); // wheel control present

    // Deciding the gate sends a permission frame — functional, not just present.
    (transcript.props.onPermission as (id: string, d: string) => void)("r1", "allow");
    expect(send).toHaveBeenCalledWith({ type: "permission", requestId: "r1", decision: "allow" });
  });
});

// ---------------------------------------------------------------------------
// Task 8 — §8.5 pinned gate bar: placement above the prompt + gate derivation.
// GateBar's own render/decide behavior lives in GateBar.test.tsx; these rows
// cover App's wiring — placement, the newest-undecided derivation, the sub-label
// join, and that the bar and the a/d hotkeys share one decision callback.
// ---------------------------------------------------------------------------
describe("App — §8.5 pinned gate bar placement + derivation (Task 8)", () => {
  const gateBarOf = (nodes: El[]) => nodes.find((n) => n.type === GateBar);

  const driverBase = (): LoggedEvent[] => [
    evt({ type: "presence_join", userId: "frank", name: "Frank", glyph: "▲" }, 1),
    evt({ type: "control_change", userId: "frank" }, 2),
    evt({ type: "tool_call", toolName: "Bash", input: { command: "ls" } }, 3),
  ];
  const onePendingGate = (): LoggedEvent[] => [
    ...driverBase(),
    evt({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "ls" } }, 4),
  ];

  it("T8-placement renders the gate bar directly above the prompt on the default surface, in both themes", () => {
    for (const theme of ["arcade", "clean"] as Theme[]) {
      socket.current = baseSocket(onePendingGate(), send);
      const nodes = mount(SessionView as (p: unknown) => unknown, baseProps({ theme })).nodes();
      const bar = gateBarOf(nodes);
      expect(bar, `gate bar present in ${theme}`).toBeDefined();
      expect(bar!.props.gate).not.toBeNull();

      // Directly above the prompt: in the `.term` container's children, the
      // GateBar element immediately precedes the PromptBar element.
      const term = nodes.find((n) => n.props.className === "term")!;
      const kids = (term.props.children as unknown[])
        .flat()
        .filter((c): c is El => !!c && typeof c === "object" && "type" in (c as El));
      const gi = kids.findIndex((c) => c.type === GateBar);
      const pi = kids.findIndex((c) => c.type === PromptBar);
      expect(gi).toBeGreaterThanOrEqual(0);
      expect(pi).toBe(gi + 1);
    }
  });

  it("T8-placement-scoped renders no gate bar on the workflows/skills/oversight/invite screens", () => {
    for (const screen of ["workflows", "skills", "oversight", "invite"]) {
      socket.current = baseSocket(onePendingGate(), send);
      const nodes = mount(SessionView as (p: unknown) => unknown, baseProps({ screen })).nodes();
      expect(gateBarOf(nodes), `no gate bar on ${screen}`).toBeUndefined();
    }
  });

  it("T8-hidden hands the bar a null gate when nothing is pending (bar renders nothing)", () => {
    // A decided gate is not pending — the bar has no gate to pin.
    const decided: LoggedEvent[] = [
      ...onePendingGate(),
      evt({ type: "permission_decision", requestId: "r1", decision: "allow", userId: "frank" }, 5),
    ];
    socket.current = baseSocket(decided, send);
    const nodes = mount(SessionView as (p: unknown) => unknown, baseProps()).nodes();
    expect(gateBarOf(nodes)!.props.gate).toBeNull();
  });

  it("T8-newest-first pins the NEWEST undecided gate (same target rule as the a/d hotkeys)", () => {
    const two: LoggedEvent[] = [
      ...driverBase(),
      evt({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "ls" } }, 4),
      evt({ type: "permission_request", requestId: "r2", toolName: "Write", input: { file_path: "/a" } }, 5),
    ];
    socket.current = baseSocket(two, send);
    const nodes = mount(SessionView as (p: unknown) => unknown, baseProps()).nodes();
    const gate = gateBarOf(nodes)!.props.gate as { requestId: string; toolName: string };
    expect(gate.requestId).toBe("r2");
    expect(gate.toolName).toBe("Write");
  });

  it("T8-sub-label joins the gate's parentToolUseId to its sub-session label via deriveSubSessions", () => {
    const attributed: LoggedEvent[] = [
      evt({ type: "presence_join", userId: "frank", name: "Frank", glyph: "▲" }, 1),
      evt({ type: "control_change", userId: "frank" }, 2),
      evt({ type: "tool_call", toolName: "Agent", toolUseId: "A", input: { description: "scan tests" } }, 3),
      evt({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "ls" }, parentToolUseId: "A" }, 4),
    ];
    socket.current = baseSocket(attributed, send);
    const nodes = mount(SessionView as (p: unknown) => unknown, baseProps()).nodes();
    const gate = gateBarOf(nodes)!.props.gate as { subLabel?: string };
    expect(gate.subLabel).toBe("scan tests");
  });

  it("T8-hotkeys-regression: the bar and the a/d hotkeys share one decision callback (sendPermission)", () => {
    socket.current = baseSocket(onePendingGate(), send);
    const nodes = mount(SessionView as (p: unknown) => unknown, baseProps()).nodes();
    const bar = gateBarOf(nodes)!;
    const transcript = transcriptOf(nodes)!;
    // The bar's decide callback is the SAME reference the Transcript hands its
    // a/d hotkeys — one path, sendPermission (App). Driver info + jump are wired.
    expect(bar.props.onDecide).toBe(transcript.props.onPermission);
    expect(bar.props.isDriver).toBe(true);
    expect(bar.props.driverName).toBe("Frank");
    expect(bar.props.driverGlyph).toBe("▲");
    expect(typeof bar.props.onTakeWheel).toBe("function");
    expect(typeof bar.props.onJump).toBe("function");
    // Deciding through the bar sends a permission frame — the identical wire
    // effect the a/d hotkeys produce.
    (bar.props.onDecide as (id: string, d: string) => void)("r1", "allow");
    expect(send).toHaveBeenCalledWith({ type: "permission", requestId: "r1", decision: "allow" });
  });

  it("T10-wheel-on-card App passes the SAME take-wheel handler to Transcript and the GateBar", () => {
    socket.current = baseSocket(onePendingGate(), send);
    const nodes = mount(SessionView as (p: unknown) => unknown, baseProps()).nodes();
    const bar = gateBarOf(nodes)!;
    const transcript = transcriptOf(nodes)!;
    // One take-wheel path (onTakeWheel in App): the Transcript's wheel-on-card
    // button and the bar's TAKE THE WHEEL fire the identical handler reference.
    expect(typeof transcript.props.onTakeWheel).toBe("function");
    expect(transcript.props.onTakeWheel).toBe(bar.props.onTakeWheel);
    // …and invoking it sends the take_wheel frame.
    (transcript.props.onTakeWheel as () => void)();
    expect(send).toHaveBeenCalledWith({ type: "take_wheel" });
  });
});

// ---------------------------------------------------------------------------
// Task 9 — §8.5 jump-to-card: App's onJump handler scrolls the matching
// `#perm-<requestId>` gate card into view. This repo has no DOM (docs/tech-debt.md),
// so `document.getElementById` is stubbed to return a `scrollIntoView` spy (or
// null) and the wired handler (GateBar's `onJump`) is invoked directly.
// ---------------------------------------------------------------------------
describe("App — §8.5 jump-to-card scroll (Task 9)", () => {
  const gateBarOf = (nodes: El[]) => nodes.find((n) => n.type === GateBar);

  const onePendingGate = (): LoggedEvent[] => [
    evt({ type: "presence_join", userId: "frank", name: "Frank", glyph: "▲" }, 1),
    evt({ type: "control_change", userId: "frank" }, 2),
    evt({ type: "tool_call", toolName: "Bash", input: { command: "ls" } }, 3),
    evt({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "ls" } }, 4),
  ];

  it("T9-jump scrolls the matching #perm-<requestId> card into view", () => {
    socket.current = baseSocket(onePendingGate(), send);
    const bar = gateBarOf(mount(SessionView as (p: unknown) => unknown, baseProps()).nodes())!;

    const scrollIntoView = vi.fn();
    const getElementById = vi.fn(() => ({ scrollIntoView }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prev = (globalThis as any).document;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document = { getElementById };
    try {
      (bar.props.onJump as (id: string) => void)("r1");
      expect(getElementById).toHaveBeenCalledWith("perm-r1");
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).document = prev;
    }
  });

  it("T9-no-target is a harmless no-op when the card is not mounted", () => {
    socket.current = baseSocket(onePendingGate(), send);
    const bar = gateBarOf(mount(SessionView as (p: unknown) => unknown, baseProps()).nodes())!;

    const getElementById = vi.fn(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prev = (globalThis as any).document;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document = { getElementById };
    try {
      expect(() => (bar.props.onJump as (id: string) => void)("does-not-exist")).not.toThrow();
      expect(getElementById).toHaveBeenCalledWith("perm-does-not-exist");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).document = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Task 11 — §8.5 pull click-through: the header PULLS badge's onPullsClick
// wiring — navigate to the OLDEST-waiting pull's session (minimum sinceTs),
// and no-op when the pull count has dropped to zero by click time. The
// badge's own render behavior (button vs span, text, the zero-pulls gate)
// lives in Header.test.tsx; these rows cover App's derivation + navigation.
// ---------------------------------------------------------------------------
describe("App — §8.5 pull badge click-through (Task 11)", () => {
  const headerOf = (nodes: El[]) => nodes.find((n) => n.type === Header);

  /** Two teammates' sessions, each with a pending gate, waiting different
   *  amounts of time — both far past any threshold option so a pull always
   *  surfaces regardless of wall-clock skew in CI. `peer-older`'s gate has
   *  been waiting since 2020, `peer-newer` since 2021 — the MINIMUM sinceTs
   *  (peer-older) is the one a click must jump to, not array order. */
  const twoPulls = (): ProjectSessionInfo[] => [
    {
      id: "peer-newer",
      participants: ["bo"],
      driverName: "Bo",
      intent: null,
      lastActivityTs: null,
      ended: false,
      pendingGate: { toolName: "Write", sinceTs: "2021-01-01T00:00:00.000Z" },
    },
    {
      id: "peer-older",
      participants: ["ana"],
      driverName: "Ana",
      intent: null,
      lastActivityTs: null,
      ended: false,
      pendingGate: { toolName: "Bash", sinceTs: "2020-01-01T00:00:00.000Z" },
    },
  ];

  it("T11-navigation navigates to the OLDEST-waiting pull's session (minimum sinceTs) via sessionUrlFrom", () => {
    // Threshold ON so pullsFrom surfaces both sessions above (pullThresholdMs
    // is a useState initializer reading localStorage on mount).
    lsGet = (k) => (k === PULL_STORAGE_KEY ? "30000" : null);
    socket.current = { ...baseSocket([], send), projectSessions: twoPulls() };
    const startSearch = "?session=s1&project=default";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window.location.search = startSearch;

    const app = mount(SessionView as (p: unknown) => unknown, baseProps());
    const header = headerOf(app.nodes())!;
    expect(typeof header.props.onPullsClick).toBe("function");
    // Not the newer pull, and not array order — the MINIMUM sinceTs.
    expect(header.props.pulls).toBe(2);

    (header.props.onPullsClick as () => void)();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).window.location.search).toBe(
      sessionUrlFrom(startSearch, "peer-older", "default"),
    );
  });

  it("T11-empty is a no-op when pulls is empty at click time — no navigation, no crash", () => {
    // Threshold OFF (stored value absent) → pullsFrom returns [] regardless
    // of any pendingGate data — simulating the count having dropped to zero
    // between render and click.
    lsGet = () => null;
    socket.current = { ...baseSocket([], send), projectSessions: twoPulls() };
    const startSearch = "?session=s1&project=default";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window.location.search = startSearch;

    const app = mount(SessionView as (p: unknown) => unknown, baseProps());
    const header = headerOf(app.nodes())!;
    expect(header.props.pulls).toBe(0);

    expect(() => (header.props.onPullsClick as () => void)()).not.toThrow();

    // No navigation: the URL is untouched (sessionUrlFrom never fired).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).window.location.search).toBe(startSearch);
  });
});
