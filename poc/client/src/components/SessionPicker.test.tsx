import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LIFECYCLE_MEMBER_REFUSAL,
  LIFECYCLE_TRANSITIONS,
  LifecyclePanel,
  MEMBERSHIP_IDLE,
  MODELS_MEMBER_REFUSAL,
  ModelsPanel,
  SessionGroups,
  membershipStep,
} from "./SessionPicker";
import pickerSource from "./SessionPicker.tsx?raw";
import type {
  MachineInfo,
  ManagedModelEntry,
  ProjectLifecycle,
  ProjectSessionInfo,
  ProjectSummary,
} from "../types";

/** The session list's contested surfaces (spec §5): a per-repo chip on the
 *  group head and a per-session marker beside the state badge.
 *
 *  Same house pattern as `ProjectPicker.test.tsx` / `RecordPanel.test.tsx` /
 *  `Transcript.test.tsx`: a REAL React render through `react-dom/server`, with
 *  the rendered DOM text pulled back out of the markup — this repo has no DOM
 *  test environment and deliberately adds none (`docs/tech-debt.md`: no jsdom,
 *  no happy-dom, no testing-library).
 *
 *  That is why the rows are rendered through `SessionGroups` rather than
 *  `SessionPicker` itself: the picker fills its session list from a socket in
 *  `useEffect`, static rendering never runs effects, so the picker can only
 *  ever be rendered with an EMPTY list here. `SessionGroups` is the same JSX
 *  taking the snapshot as a prop — it still derives the collisions itself,
 *  through Task 9a's shared `projectCollisions`, so nothing about the data
 *  path is faked: these assertions run against genuine `collisionsFrom`
 *  output for the fixture rows below. */

/** Every line of DOM text the markup renders, in document order. */
const textLines = (markup: string): string[] =>
  markup
    .split(/<[^>]*>/)
    .map((chunk) =>
      chunk
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

/** A snapshot row as the socket delivers it — FLAT, no `facts` wrapper
 *  (`poc/client/src/types.ts`). One participant by default so the state badge
 *  reads `LIVE`: an empty participant list would render `EMPTY` and quietly
 *  change what the marker is being asserted next to. */
const row = (over: Partial<ProjectSessionInfo> & { id: string }): ProjectSessionInfo => ({
  participants: ["frank"],
  driverName: null,
  intent: null,
  lastActivityTs: null,
  ended: false,
  ...over,
});

/** Two repo groups, so the group heads render at all (`showRepoHeads` is
 *  `groups.length > 1` — a single-group view has no head today, and this task
 *  does not change that).
 *
 *  `r1` carries TWO contested paths across THREE sessions: `src/a.ts` is
 *  touched by alpha, beta and gamma (one Collision with three ids) and
 *  `src/b.ts` by alpha and beta. The counts therefore all differ — 2 distinct
 *  paths, 3 contested sessions, 5 touched entries — so a chip that counted the
 *  wrong thing cannot pass by coincidence.
 *
 *  `r2`'s two sessions touch disjoint files: a real group, really rendered,
 *  with nothing contested in it. */
const ALPHA = row({ id: "alpha", repoKey: "r1", touched: ["src/a.ts", "src/b.ts"] });
const BETA = row({ id: "beta", repoKey: "r1", touched: ["src/a.ts", "src/b.ts"] });
const GAMMA = row({ id: "gamma", repoKey: "r1", touched: ["src/a.ts"] });
const DELTA = row({ id: "delta", repoKey: "r2", touched: ["docs/x.md"] });
const EPSILON = row({ id: "epsilon", repoKey: "r2", touched: ["docs/y.md"] });

const CONTESTED = [ALPHA, BETA, GAMMA, DELTA, EPSILON];

const render = (sessions: ProjectSessionInfo[], machines: MachineInfo[] = []): string =>
  renderToStaticMarkup(
    <SessionGroups sessions={sessions} machines={machines} canJoin projectId="p1" />,
  );

/** The line that follows `id`'s row label, and the one after that: the badge
 *  and whatever is rendered beside it. */
const afterId = (lines: string[], id: string): string[] => {
  const at = lines.indexOf(id);
  expect(at).toBeGreaterThanOrEqual(0);
  return lines.slice(at + 1, at + 3);
};

describe("SessionGroups — repo-group contested chip (spec §5)", () => {
  it("counts DISTINCT contested paths, not sessions and not touch entries", () => {
    const lines = textLines(render(CONTESTED));
    // 2 paths are contested in r1, across 3 sessions and 5 touched entries.
    expect(lines).toContain("⚠ 2 contested");
    expect(lines).not.toContain("⚠ 3 contested");
    expect(lines).not.toContain("⚠ 5 contested");
  });

  it("renders the chip in the group head, right after the repo label", () => {
    const lines = textLines(render(CONTESTED));
    expect(afterId(lines, "r1")[0]).toBe("⚠ 2 contested");
  });

  it("names a COUNT, never a path list", () => {
    const markup = render(CONTESTED);
    // The contested paths themselves appear nowhere on this screen.
    expect(markup).not.toContain("src/a.ts");
    expect(markup).not.toContain("src/b.ts");
  });

  it("leaves a group with no collisions exactly as it is today", () => {
    const lines = textLines(render(CONTESTED));
    // r2's head is followed straight by its first row, with no chip between.
    expect(afterId(lines, "r2")[0]).toBe("delta");
    expect(lines.join("\n")).not.toContain("⚠ 0 contested");
  });
});

describe("SessionGroups — per-session contested marker (spec §5)", () => {
  it("marks a contested session beside its state badge", () => {
    const lines = textLines(render(CONTESTED));
    expect(afterId(lines, "alpha")).toEqual(["LIVE", "contested"]);
    expect(afterId(lines, "beta")).toEqual(["LIVE", "contested"]);
  });

  it("renders the bare literal — no count and no ⚠ glyph", () => {
    const markup = render(CONTESTED);
    expect(markup).toContain('<span class="contested-calm">contested</span>');
    expect(markup).not.toMatch(/⚠\s*contested/);
    expect(markup).not.toContain("1 contested</span>");
  });

  it("marks a CLOSED session too — closing a session does not release its files (spec §2.6)", () => {
    const closed = [ALPHA, BETA, row({ ...GAMMA, lifecycle: "closed" }), DELTA, EPSILON];
    const lines = textLines(render(closed));
    // The badge first, then the marker: the row reads CLOSED, then contested.
    expect(afterId(lines, "gamma")).toEqual(["CLOSED", "contested"]);
    // And a closed session still counts toward its repo's chip.
    expect(lines).toContain("⚠ 2 contested");
  });

  it("leaves an uncontested session unmarked", () => {
    const lines = textLines(render(CONTESTED));
    expect(afterId(lines, "delta")).toEqual(["LIVE", "r2  ·  unknown machine  ·  frank"]);
  });
});

describe("SessionGroups — no collisions renders zero new DOM", () => {
  it("adds nothing at all when nothing overlaps", () => {
    const quiet = [
      row({ id: "alpha", repoKey: "r1", touched: ["src/a.ts"] }),
      row({ id: "beta", repoKey: "r1", touched: ["src/b.ts"] }),
      DELTA,
      EPSILON,
    ];
    const markup = render(quiet);
    expect(markup).not.toContain("contested");
    expect(markup).not.toContain("⚠");
    // Not vacuous: the rows really did render.
    expect(textLines(markup)).toEqual(expect.arrayContaining(["alpha", "delta", "LIVE"]));
  });

  it("is byte-identical to the same snapshot with no touched sets at all", () => {
    const quiet = [
      row({ id: "alpha", repoKey: "r1", touched: ["src/a.ts"] }),
      row({ id: "beta", repoKey: "r1", touched: ["src/b.ts"] }),
    ];
    const unknown = quiet.map((s) => row({ ...s, touched: null }));
    expect(render(quiet)).toBe(render(unknown));
  });
});

/** A project summary as the entrance list delivers it. `members` is the real
 *  roster when you are a member, redacted to `[]` otherwise (spec A5). */
const proj = (over: Partial<ProjectSummary> & { id: string }): ProjectSummary => ({
  name: over.id,
  lifecycle: "active",
  members: [],
  sessionCount: 0,
  liveSessionCount: 0,
  machines: [],
  ...over,
});

describe("membershipStep — redacted-entrance join flow (spec A5)", () => {
  it("raises the JOIN affordance flag on a not_a_member refusal", () => {
    const step = membershipStep(MEMBERSHIP_IDLE, { kind: "error", code: "not_a_member" });
    expect(step.state.notMember).toBe(true);
    expect(step.watch).toBe(false);
  });

  it("leaves membership untouched on an ordinary error", () => {
    const other = membershipStep(MEMBERSHIP_IDLE, { kind: "error", code: "no_machine" });
    expect(other.state).toEqual(MEMBERSHIP_IDLE);
    expect(other.watch).toBe(false);
    // A codeless error (old server) is not mistaken for a membership refusal.
    const codeless = membershipStep(MEMBERSHIP_IDLE, { kind: "error" });
    expect(codeless.state.notMember).toBe(false);
  });

  it("marks a join in flight when JOIN is pressed, sending no watch yet", () => {
    const step = membershipStep(MEMBERSHIP_IDLE, { kind: "join" });
    expect(step.state.joining).toBe(true);
    expect(step.watch).toBe(false);
  });

  it("re-watches once a projects push shows membership after joining", () => {
    const step = membershipStep(
      { notMember: true, joining: true },
      {
        kind: "projects",
        projects: [proj({ id: "p1", isMember: true, members: ["frank"] })],
        projectId: "p1",
        userId: "frank",
      },
    );
    expect(step.watch).toBe(true);
    expect(step.state.notMember).toBe(false);
    expect(step.state.joining).toBe(false);
  });

  it("does not re-watch on a projects push before JOIN was pressed", () => {
    const step = membershipStep(
      { notMember: true, joining: false },
      {
        kind: "projects",
        projects: [proj({ id: "p1", isMember: true, members: ["frank"] })],
        projectId: "p1",
        userId: "frank",
      },
    );
    expect(step.watch).toBe(false);
  });

  it("keeps waiting while the push still shows non-membership", () => {
    const step = membershipStep(
      { notMember: true, joining: true },
      {
        kind: "projects",
        projects: [proj({ id: "p1", isMember: false, members: [], memberCount: 3 })],
        projectId: "p1",
        userId: "frank",
      },
    );
    expect(step.watch).toBe(false);
    expect(step.state.joining).toBe(true);
  });

  it("detects membership via the roster when isMember is absent — old server", () => {
    const step = membershipStep(
      { notMember: true, joining: true },
      {
        kind: "projects",
        projects: [proj({ id: "p1", members: ["frank"] })],
        projectId: "p1",
        userId: "frank",
      },
    );
    expect(step.watch).toBe(true);
  });

  it("does not re-watch when the joined project is absent from the push", () => {
    const step = membershipStep(
      { notMember: true, joining: true },
      { kind: "projects", projects: [], projectId: "p1", userId: "frank" },
    );
    expect(step.watch).toBe(false);
  });
});

/** The reducer decides the flags; the handler decides the toast. Static
 *  rendering never runs the picker's socket effect (see the SessionGroups note
 *  above), so the one-line wiring that keeps a membership refusal OFF the red
 *  line is pinned here from source — the house `?raw` pattern
 *  (`RecordPanel.test.tsx:13`). */
describe("SessionPicker — membership refusal wiring (spec A5)", () => {
  it("suppresses the error toast for a membership refusal only", () => {
    // `setError` runs for every error whose (possibly normalized) code is NOT
    // the membership refusal.
    expect(pickerSource).toMatch(/code !== "not_a_member"\)\s*setError\(msg\.message\)/);
  });

  it("normalizes the lifecycle gate's UNCODED refusal into the same flow", () => {
    // `set_project_lifecycle` refuses a non-member with a plain error — no
    // `code` field (hub.ts) — so the string is the only signal. It must land
    // in the membership flow (quiet degrade), not on the red line.
    expect(pickerSource).toMatch(/msg\.message === LIFECYCLE_MEMBER_REFUSAL \? "not_a_member"/);
    expect(LIFECYCLE_MEMBER_REFUSAL).toBe("join this project before changing it");
  });

  it("re-watches on the projects push when the reducer asks for it", () => {
    expect(pickerSource).toMatch(/step\.watch[\s\S]{0,160}"watch_project"/);
  });

  it("gates the JOIN affordance on the refusal, not on a disabled control", () => {
    // `spectating` OR-s the entrance-list refusal with the watch-refusal flag.
    expect(pickerSource).toMatch(/spectating\s*&&/);
    expect(pickerSource).toMatch(/membership\.notMember/);
  });
});

/** The INVITE section's socket wiring (plan 2026-08-01-project-invites §1.8).
 *  Static rendering never runs the picker's socket effect, and the section's
 *  own render is pinned in `InvitePanel.test.tsx` — so the three decisions
 *  that live in the picker (when to ask, what scope to send, who may see the
 *  section) are pinned here from source, the house `?raw` pattern. */
describe("SessionPicker — INVITE section wiring (plan §1.8)", () => {
  it("asks for the invite list project-scoped, on open and again after a JOIN lands", () => {
    const asks = pickerSource.match(/"list_invites", projectId: props\.projectId/g);
    // Once in onopen, once beside the post-join re-watch — a fresh member's
    // first ask was refused as not_a_member before the join.
    expect(asks).toHaveLength(2);
  });

  it("sends project-scoped create/revoke and no follow-up list (the server re-answers)", () => {
    expect(pickerSource).toMatch(/"create_invite", projectId: props\.projectId/);
    expect(pickerSource).toMatch(/"revoke_invite", projectId: props\.projectId, inviteId/);
  });

  it("gates the section on membership (`actable`) — hidden for a spectator, never a red error", () => {
    // The same gate the NEW SESSION form uses: a spectator acts on nothing
    // (spec §4.4), and a not_a_member refusal flows into `membership`, which
    // flips `actable` off — the section degrades by disappearing.
    expect(pickerSource).toMatch(/\{actable && \([\s\S]{0,200}<InvitePanel/);
  });
});

describe("SessionGroups — calm styling", () => {
  it("puts BOTH surfaces on the contested-calm class", () => {
    const markup = render(CONTESTED);
    // One chip (r1) + three markers (alpha, beta, gamma).
    expect(markup.match(/class="contested-calm"/g)).toHaveLength(4);
  });

  it("spends the class on the surfaces and on nothing else", () => {
    // Named, not coloured: the rule body itself (calm `--gold`, never the
    // permission gate's `--amber`) cannot be asserted from here — vitest stubs
    // every CSS import to "" by default (`css: false`), and this tsconfig
    // types only `vite/client`, so neither `?raw` nor `node:fs` reaches the
    // stylesheet. `.contested-calm`'s declaration in `terminal.css` is pinned
    // by the two count-anchored greps in the task's Verify instead.
    const markup = render(CONTESTED);
    expect(markup).not.toMatch(/class="[^"]*contested-calm[^"]*(spstate|sprow|spname)/);
    // Nothing else on this screen borrows it.
    expect(markup.match(/contested-calm/g)).toHaveLength(4);
  });
});


/** ── PROJECT lifecycle section (plan 2026-08-01-project-lifecycle-controls
 *  §1.1–§1.2). Two seams, both house-standard: the panel's RENDER is pinned
 *  through props-only static markup, and the arm-and-confirm SEQUENCE is
 *  exercised through the stateful hooks-shim mount (verbatim from
 *  App.test.tsx — the panel's only hook is the one armed slot). The wire send
 *  itself stays in the picker and is pinned from source. */

const panelMarkup = (lifecycle: ProjectLifecycle): string =>
  renderToStaticMarkup(<LifecyclePanel lifecycle={lifecycle} onSet={() => {}} />);

/** Button labels out of the markup, in render order — the exact control set. */
const buttonLabels = (markup: string): string[] =>
  [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("LifecyclePanel — the §1.1 button set per state", () => {
  it("from active: CLOSE PROJECT and ARCHIVE PROJECT, nothing else", () => {
    expect(buttonLabels(panelMarkup("active"))).toEqual(["CLOSE PROJECT", "ARCHIVE PROJECT"]);
  });

  it("from closed: REOPEN and ARCHIVE PROJECT — closing never strands the project", () => {
    expect(buttonLabels(panelMarkup("closed"))).toEqual(["REOPEN", "ARCHIVE PROJECT"]);
  });

  it("from archived: UNARCHIVE only", () => {
    expect(buttonLabels(panelMarkup("archived"))).toEqual(["UNARCHIVE"]);
  });

  it("covers exactly the three lifecycle states — no speculative transitions (§2.4)", () => {
    expect(Object.keys(LIFECYCLE_TRANSITIONS).sort()).toEqual(["active", "archived", "closed"]);
    // Delete does not exist (spec :242), and no transition leaves the union.
    for (const ts of Object.values(LIFECYCLE_TRANSITIONS)) {
      for (const t of ts) expect(["active", "closed", "archived"]).toContain(t.to);
    }
  });

  it("shows the current state beside the buttons, CLOSED in the red badge class", () => {
    expect(textLines(panelMarkup("active"))).toContain("ACTIVE");
    expect(panelMarkup("closed")).toContain('<span class="spstate pix sm closed">CLOSED</span>');
    expect(textLines(panelMarkup("archived"))).toContain("ARCHIVED");
  });
});

/* The stateful hooks-shim mount, verbatim from App.test.tsx: `useState`
 *  setters re-render synchronously (so an arming click actually relabels the
 *  button), `useEffect` is inert. Returns a live accessor over the current
 *  element tree. */
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

/** The panel mounted with a recording onSet, plus click/label accessors over
 *  its LIVE tree (labels re-read after every click — the armed relabel is the
 *  whole point). */
const mountPanel = (lifecycle: ProjectLifecycle) => {
  const onSet = vi.fn();
  const mounted = mount(LifecyclePanel as (p: unknown) => unknown, { lifecycle, onSet });
  const buttons = () => mounted.nodes().filter((n) => n.type === "button");
  const labels = () => buttons().map((n) => textOf(n));
  const click = (label: string) => {
    const b = buttons().find((n) => textOf(n) === label);
    expect(b, `a button labelled ${label}`).toBeDefined();
    (b!.props.onClick as () => void)();
  };
  return { onSet, labels, click };
};

describe("LifecyclePanel — arm-and-confirm (plan §1.2)", () => {
  it("the first click on CLOSE PROJECT arms only — it sends NOTHING", () => {
    const panel = mountPanel("active");
    panel.click("CLOSE PROJECT");
    expect(panel.onSet).not.toHaveBeenCalled();
    // …and the armed button says so, in place of its old label.
    expect(panel.labels()).toEqual(["SURE?", "ARCHIVE PROJECT"]);
  });

  it("the second click on the armed button sends the transition, once", () => {
    const panel = mountPanel("active");
    panel.click("CLOSE PROJECT");
    panel.click("SURE?");
    expect(panel.onSet).toHaveBeenCalledTimes(1);
    expect(panel.onSet).toHaveBeenCalledWith("closed");
    // The slot cleared on send: the label is back, not stuck on SURE?.
    expect(panel.labels()).toEqual(["CLOSE PROJECT", "ARCHIVE PROJECT"]);
  });

  it("arms ARCHIVE PROJECT the same way and sends archived on confirm", () => {
    const panel = mountPanel("closed");
    panel.click("ARCHIVE PROJECT");
    expect(panel.onSet).not.toHaveBeenCalled();
    panel.click("SURE?");
    expect(panel.onSet).toHaveBeenCalledTimes(1);
    expect(panel.onSet).toHaveBeenCalledWith("archived");
  });

  it("REOPEN sends immediately — it restores, it does not destroy", () => {
    const panel = mountPanel("closed");
    panel.click("REOPEN");
    expect(panel.onSet).toHaveBeenCalledTimes(1);
    expect(panel.onSet).toHaveBeenCalledWith("active");
  });

  it("UNARCHIVE sends immediately", () => {
    const panel = mountPanel("archived");
    panel.click("UNARCHIVE");
    expect(panel.onSet).toHaveBeenCalledTimes(1);
    expect(panel.onSet).toHaveBeenCalledWith("active");
  });

  it("moving to the other destructive button disarms the first — one armed slot", () => {
    const panel = mountPanel("active");
    panel.click("CLOSE PROJECT");
    panel.click("ARCHIVE PROJECT");
    // Still nothing sent, and CLOSE PROJECT has its label back: the arm moved.
    expect(panel.onSet).not.toHaveBeenCalled();
    expect(panel.labels()).toEqual(["CLOSE PROJECT", "SURE?"]);
  });
});

/** The picker-side wiring the panel cannot see: gate, send, and the remount
 *  that disarms on transition. Static rendering never runs the picker's
 *  socket effect, so these are pinned from source — the house `?raw` pattern
 *  (same as the INVITE section wiring above). */
describe("SessionPicker — PROJECT lifecycle section wiring (plan §1.1–§1.2)", () => {
  it("gates the section on MEMBERSHIP, not actable — a closed project's members must reach REOPEN", () => {
    // `canAct` answers "not-active" on a closed/archived project, so an
    // `actable` gate would strand every closed project. The gate is the
    // membership signal the INVITE section uses, lifecycle-independent.
    expect(pickerSource).toMatch(
      /const manageable =\s*project !== null && isProjectMember\(project, props\.userId\) && !membership\.notMember/,
    );
    expect(pickerSource).toMatch(/\{manageable !== null && \([\s\S]{0,240}<LifecyclePanel/);
  });

  it("sends the exact wire message — set_project_lifecycle with the picker's own projectId", () => {
    expect(pickerSource).toMatch(
      /JSON\.stringify\(\{ type: "set_project_lifecycle", projectId: props\.projectId, lifecycle \}\)/,
    );
  });

  it("remounts the panel on every lifecycle change so an armed SURE? dies with its state", () => {
    expect(pickerSource).toMatch(/key=\{manageable\.lifecycle\}/);
  });

  it("sources the current lifecycle from the projects frame the picker already receives", () => {
    // No new subscription: the section reads the same `projects` state the
    // entrance list fills, via the `project` memo.
    expect(pickerSource).toMatch(/lifecycle=\{manageable\.lifecycle\}/);
  });
});

/** ── MODELS section (model-agnostic plan §2.1 client MANAGE view, Task 7).
 *  Two seams, both house-standard: the panel's RENDER + form/arm interactions
 *  run through props-only static markup and the stateful hooks-shim mount
 *  (verbatim from the LifecyclePanel tests above), and the picker's socket
 *  wiring (list on mount, add/remove sends, member+reply gate, refusal
 *  degrade) is pinned from source — the house `?raw` pattern. */

/** A managed-model roster entry as `models_list` delivers it. `id` defaults to
 *  `key` (the extras invariant key === id) and a sane context window, so a
 *  fixture names only what a case is about. */
const mm = (over: Partial<ManagedModelEntry> & { key: string }): ManagedModelEntry => ({
  id: over.key,
  label: over.key,
  contextWindow: 200000,
  ...over,
});

const renderModels = (models: ManagedModelEntry[], error: string | null = null): string =>
  renderToStaticMarkup(
    <ModelsPanel models={models} error={error} onAdd={() => {}} onRemove={() => {}} />,
  );

/** The panel mounted through the stateful hooks-shim, with accessors over its
 *  LIVE tree: fields addressed by `aria-label`, buttons by label. Every setter
 *  re-renders synchronously (the whole point — id derivation and the armed
 *  relabel are re-read after each edit). */
const mountModels = (models: ManagedModelEntry[], error: string | null = null) => {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const mounted = mount(ModelsPanel as (p: unknown) => unknown, { models, error, onAdd, onRemove });
  const find = (aria: string): El | undefined =>
    mounted.nodes().find((n) => n.props["aria-label"] === aria);
  const setField = (aria: string, value: string) => {
    const node = find(aria);
    expect(node, `a field labelled ${aria}`).toBeDefined();
    (node!.props.onChange as (e: unknown) => void)({ target: { value } });
  };
  const buttons = () => mounted.nodes().filter((n) => n.type === "button");
  const labels = () => buttons().map((n) => textOf(n));
  const click = (label: string) => {
    const b = buttons().find((n) => textOf(n) === label);
    expect(b, `a button labelled ${label}`).toBeDefined();
    (b!.props.onClick as () => void)();
  };
  const texts = () => mounted.nodes().map((n) => textOf(n));
  return { onAdd, onRemove, find, setField, labels, click, texts };
};

/** A complete, valid ollama form except for the field a case wants to poke. */
const fillOllama = (m: ReturnType<typeof mountModels>) => {
  m.setField("label", "qwen");
  m.setField("provider", "ollama");
  m.setField("provider model", "qwen3.6:27b");
  m.setField("base URL", "http://127.0.0.1:11434");
  m.setField("context window", "40000");
};

describe("ModelsPanel — roster render (Task 7 behavior table)", () => {
  it("lists every entry; built-ins are marked and carry NO remove button", () => {
    const models = [
      mm({ key: "opus", label: "opus 5", contextWindow: 1000000, builtin: true }),
      mm({
        key: "qwen3.6-27b",
        label: "qwen",
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        providerModel: "qwen3.6:27b",
      }),
    ];
    const markup = renderModels(models);
    const lines = textLines(markup);
    expect(lines).toContain("opus 5");
    expect(lines).toContain("qwen");
    // The built-in is marked as such…
    expect(lines).toContain("built-in");
    // …and only the ONE non-builtin row offers REMOVE.
    expect(buttonLabels(markup).filter((l) => l === "REMOVE")).toHaveLength(1);
  });

  it("surfaces a server refusal on the panel's own red line", () => {
    const markup = renderModels(
      [mm({ key: "opus", label: "opus 5", builtin: true })],
      "cannot remove a built-in model",
    );
    expect(textLines(markup)).toContain("cannot remove a built-in model");
  });
});

describe("ModelsPanel — ADD form (Task 7 behavior table)", () => {
  it("adds a valid ollama entry with the derived id", () => {
    const m = mountModels([]);
    fillOllama(m);
    m.click("ADD");
    expect(m.onAdd).toHaveBeenCalledTimes(1);
    expect(m.onAdd).toHaveBeenCalledWith({
      id: "qwen3.6-27b",
      label: "qwen",
      contextWindow: 40000,
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      providerModel: "qwen3.6:27b",
    });
  });

  it("derives the id from the provider model (lowercase, `:`→`-`)", () => {
    const m = mountModels([]);
    m.setField("provider model", "qwen3.6:27b");
    expect(m.find("model id")!.props.value).toBe("qwen3.6-27b");
  });

  it("lets the id field override the derivation, and keeps the override sticky", () => {
    const m = mountModels([]);
    m.setField("provider model", "qwen3.6:27b");
    m.setField("model id", "my-qwen");
    expect(m.find("model id")!.props.value).toBe("my-qwen");
    // A later provider-model edit does NOT clobber a hand-typed id.
    m.setField("provider model", "llama3:8b");
    expect(m.find("model id")!.props.value).toBe("my-qwen");
    // …and the override is what gets sent.
    m.setField("label", "x");
    m.setField("base URL", "http://h");
    m.setField("context window", "10");
    m.click("ADD");
    expect(m.onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "my-qwen" }));
  });

  it("blocks submit with the exact ollama message when base URL is empty", () => {
    const m = mountModels([]);
    m.setField("label", "x");
    m.setField("provider", "ollama");
    m.setField("provider model", "q");
    m.setField("context window", "10");
    m.click("ADD");
    expect(m.onAdd).not.toHaveBeenCalled();
    expect(m.texts()).toContain("base URL is required for ollama");
  });

  it("substitutes the provider name in the validation message", () => {
    const m = mountModels([]);
    m.setField("label", "x");
    m.setField("provider", "openai-compatible");
    m.setField("provider model", "q");
    m.setField("context window", "10");
    m.click("ADD");
    expect(m.onAdd).not.toHaveBeenCalled();
    expect(m.texts()).toContain("base URL is required for openai-compatible");
  });

  it("exposes the API key env field only for openai-compatible and forwards it", () => {
    const m = mountModels([]);
    // Ollama has no key field.
    m.setField("provider", "ollama");
    expect(m.find("api key env")).toBeUndefined();
    // Switching to openai-compatible reveals it and its value rides the entry.
    m.setField("provider", "openai-compatible");
    m.setField("label", "gpt");
    m.setField("provider model", "gpt-4o");
    m.setField("base URL", "http://127.0.0.1:4000");
    m.setField("context window", "128000");
    m.setField("api key env", "MY_KEY");
    m.click("ADD");
    expect(m.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-compatible", apiKeyEnv: "MY_KEY" }),
    );
  });
});

describe("ModelsPanel — REMOVE arm-and-confirm (Task 7 behavior table)", () => {
  const extra = () => [
    mm({
      key: "qwen3.6-27b",
      label: "qwen",
      provider: "ollama",
      baseUrl: "http://h",
      providerModel: "q",
    }),
  ];

  it("the first REMOVE click only arms — it sends nothing", () => {
    const m = mountModels(extra());
    m.click("REMOVE");
    expect(m.onRemove).not.toHaveBeenCalled();
    expect(m.labels()).toContain("SURE?");
  });

  it("the second click confirms and sends remove_model with the entry key", () => {
    const m = mountModels(extra());
    m.click("REMOVE");
    m.click("SURE?");
    expect(m.onRemove).toHaveBeenCalledTimes(1);
    expect(m.onRemove).toHaveBeenCalledWith("qwen3.6-27b");
  });
});

/** The picker-side wiring the panel cannot see. Static rendering never runs the
 *  picker's socket effect, so these are pinned from source — the house `?raw`
 *  pattern (same as the INVITE and PROJECT section wiring above). */
describe("SessionPicker — MODELS section wiring (Task 7)", () => {
  it("asks for the models list project-scoped, on open and again after a JOIN lands", () => {
    const asks = pickerSource.match(/"list_models", projectId: props\.projectId/g);
    // Once in onopen, once beside the post-join re-watch — a fresh member's
    // first ask was refused as not_a_member before the join (mirrors invites).
    expect(asks).toHaveLength(2);
  });

  it("renders the panel ONLY for a member AND only after a models_list reply", () => {
    // `manageable` is the membership gate (non-member ⇒ no panel); `models !==
    // null` is the reply gate (old server never replies ⇒ no panel).
    expect(pickerSource).toMatch(
      /\{manageable !== null && models !== null && \([\s\S]{0,240}<ModelsPanel/,
    );
  });

  it("fills the roster from every models_list reply", () => {
    expect(pickerSource).toMatch(/msg\.type === "models_list"[\s\S]{0,80}setModels\(msg\.models/);
  });

  it("sends add_model / remove_model with the picker's own projectId", () => {
    expect(pickerSource).toMatch(/"add_model", projectId: props\.projectId, entry/);
    expect(pickerSource).toMatch(/"remove_model", projectId: props\.projectId, key/);
  });

  it("degrades the models member-refusal quietly, like the lifecycle gate", () => {
    // The standalone models handlers refuse a non-member with a plain (uncoded)
    // error; normalizing that string into `not_a_member` keeps it OFF the red
    // line and in the quiet membership flow.
    expect(pickerSource).toMatch(/msg\.message === MODELS_MEMBER_REFUSAL/);
    expect(MODELS_MEMBER_REFUSAL).toBe("join this project before managing models");
  });
});
