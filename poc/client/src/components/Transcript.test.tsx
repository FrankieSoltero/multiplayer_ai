import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveState } from "../derive";
import type { LoggedEvent } from "../types";
import { Transcript } from "./Transcript";

/** The permission gate's WHY line (spec §6b, "The gate's UI line names why").
 *
 *  Same house pattern as `ProjectPicker.test.tsx` / `RecordPanel.test.tsx`: a
 *  REAL React render through `react-dom/server`, with the rendered DOM text
 *  pulled back out of the markup — this repo has no DOM test environment and
 *  deliberately adds none (`docs/tech-debt.md`: no jsdom, no happy-dom, no
 *  testing-library). Static rendering never runs `useEffect`, so the
 *  scroll-into-view and the a/d keydown listener never fire here.
 *
 *  The reason string is composed SERVER-side (Task 8b) and rendered verbatim,
 *  so the literal `contested with session alpha` is asserted as a literal: it
 *  is the same string end to end, and a client that reformats it fails here. */

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

const JOIN: LoggedEvent = {
  seq: 1,
  ts: "2026-07-30T10:00:00Z",
  type: "presence_join",
  userId: "frank",
  name: "Frank",
};

const gate = (over: Partial<LoggedEvent> = {}): LoggedEvent => ({
  seq: 2,
  ts: "2026-07-30T10:00:01Z",
  type: "permission_request",
  requestId: "r1",
  toolName: "Write",
  input: { file_path: "/repo/src/a.ts" },
  ...over,
});

const DECISION: LoggedEvent = {
  seq: 3,
  ts: "2026-07-30T10:00:02Z",
  type: "permission_decision",
  requestId: "r1",
  decision: "allow",
  userId: "frank",
};

/** A real Transcript render over `events`, as a non-driver watcher (the gate
 *  buttons are irrelevant to the reason line and would only add noise). */
const markupOf = (events: LoggedEvent[]): string =>
  renderToStaticMarkup(
    <Transcript
      events={events}
      derived={deriveState(events)}
      isDriver={false}
      selfId="frank"
      onPermission={() => {}}
      onDecideSkill={() => {}}
      onDecidePlan={() => {}}
    />,
  );

const REASON = "contested with session alpha";
const EXISTING_LINE = "the agent wants to use";

describe("Transcript — the permission gate names why", () => {
  it("renders the server's reason VERBATIM", () => {
    const text = textLines(markupOf([JOIN, gate({ reason: REASON })]));
    expect(text).toContain(REASON);
  });

  it("adds the reason BESIDE the existing gate line, not instead of it", () => {
    const text = textLines(markupOf([JOIN, gate({ reason: REASON })]));
    const joined = text.join("\n");
    // The pre-existing line survives, whole.
    expect(joined).toContain(EXISTING_LINE);
    expect(joined).toContain("not on the auto-approve list");
    expect(joined).toContain("Write");
    // …and the reason is an ADDITIONAL line, after it.
    const existingAt = text.findIndex((l) => l.includes(EXISTING_LINE));
    const reasonAt = text.indexOf(REASON);
    expect(existingAt).toBeGreaterThanOrEqual(0);
    expect(reasonAt).toBeGreaterThan(existingAt);
  });

  it("renders NOTHING extra when the gate has no reason", () => {
    // Every gate opened by today's non-contested code paths. The claim is
    // byte-identity with the pre-task render, so it is checked by subtraction:
    // the with-reason markup minus its reason node must be the no-reason markup
    // exactly. An implementation that always renders the node (empty when there
    // is no reason) fails this, and so does one that renders it in a wrapper.
    const withReason = markupOf([JOIN, gate({ reason: REASON })]);
    const without = markupOf([JOIN, gate()]);
    expect(without).not.toContain("perm-why");
    // Byte-identity, by subtraction. This also rules out an ALWAYS-rendered
    // node: `<div>{ev.reason}</div>` would leave `<div></div>` behind here and
    // the subtraction would not close the gap. (The `<div></div>` further down
    // the markup is the transcript's own scroll sentinel, present either way.)
    expect(withReason.replace(`<div class="perm-why">${REASON}</div>`, "")).toBe(without);
  });

  it("treats an empty-string or null reason as absent", () => {
    const baseline = markupOf([JOIN, gate()]);
    expect(markupOf([JOIN, gate({ reason: "" })])).toBe(baseline);
    expect(markupOf([JOIN, gate({ reason: null })])).toBe(baseline);
  });

  it("keeps the reason beside a DECIDED gate — the transcript is a log", () => {
    const text = textLines(markupOf([JOIN, gate({ reason: REASON }), DECISION]));
    const joined = text.join("\n");
    expect(joined).toContain("DECIDED");
    expect(joined).toContain("approved");
    expect(text).toContain(REASON);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — sub-session compact rows, view projection, attributed gate prefix.
// ---------------------------------------------------------------------------

/** Static markup drops event handlers, and this repo adds no DOM/renderer
 *  (docs/tech-debt.md). To exercise the compact-row and gate-decide onClick
 *  WIRING as an action (not just display), we install a minimal hooks
 *  dispatcher and call the component directly, then walk the returned React
 *  element tree for host nodes. `useEffect` is a no-op here — matching the
 *  static-render semantics the display tests above rely on (no scroll, no
 *  keydown listener). Transcript returns a pure tree of host elements
 *  (div/span/button), so one call yields every node. */
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

const ts = "2026-07-30T10:00:00Z";

/** Spawning top-level Agent call for sub-session key "A" (a MAIN event: it
 *  carries no parentToolUseId). Its input.description is the label. */
const SPAWN_A: LoggedEvent = {
  seq: 10,
  ts,
  type: "tool_call",
  toolName: "Agent",
  toolUseId: "A",
  input: { description: "scan tests" },
};

/** Seven streamed rows attributed to key "A". */
const BODY_A: LoggedEvent[] = Array.from({ length: 7 }, (_, i) => ({
  seq: 20 + i,
  ts,
  type: "agent_text_delta",
  text: `sub row ${i}`,
  parentToolUseId: "A",
}));

/** Top-level tool_result for key "A" — flips the sub-session to done. */
const DONE_A: LoggedEvent = { seq: 100, ts, type: "tool_result", toolUseId: "A", output: "sub finished" };

interface Over {
  events: LoggedEvent[];
  view?: string | null;
  isDriver?: boolean;
  onPermission?: (requestId: string, decision: "allow" | "deny") => void;
  onOpenSubSession?: (key: string) => void;
  onTakeWheel?: () => void;
}

const element = (over: Over): React.ReactElement => (
  <Transcript
    events={over.events}
    derived={deriveState(over.events)}
    isDriver={over.isDriver ?? false}
    selfId="frank"
    onPermission={over.onPermission ?? (() => {})}
    onDecideSkill={() => {}}
    onDecidePlan={() => {}}
    view={over.view}
    onOpenSubSession={over.onOpenSubSession}
    onTakeWheel={over.onTakeWheel}
  />
);

const markupOfEl = (over: Over): string => renderToStaticMarkup(element(over));

describe("Transcript — Task 3 sub-session views", () => {
  it("T3-MAIN compact row renders one clickable row for a running sub-session", () => {
    const events = [JOIN, SPAWN_A, ...BODY_A];
    const text = textLines(markupOfEl({ events })).join("\n");
    expect(text).toContain("⚒ SUB-QUEST");
    expect(text).toContain("scan tests");
    expect(text).toContain("running…");
    expect(text).toContain("7 rows");
    expect(text).toContain("open ▸");
    // ONE row, no expanded body: none of the seven streamed rows render.
    expect(text).not.toContain("sub row 0");

    const onOpenSubSession = vi.fn();
    const row = renderTree(element({ events, onOpenSubSession })).find((n) => hasClass(n, "subagent-row"));
    expect(row).toBeDefined();
    (row!.props.onClick as () => void)();
    expect(onOpenSubSession).toHaveBeenCalledWith("A");
  });

  it("T3-MAIN done row shows done and stays clickable", () => {
    const events = [JOIN, SPAWN_A, ...BODY_A, DONE_A];
    const markup = markupOfEl({ events });
    const text = textLines(markup).join("\n");
    expect(text).toContain("done");
    expect(text).not.toContain("running…");
    expect(markup).toContain('class="lamp done"');

    const onOpenSubSession = vi.fn();
    const row = renderTree(element({ events, onOpenSubSession })).find((n) => hasClass(n, "subagent-row"));
    expect(row).toBeDefined();
    (row!.props.onClick as () => void)();
    expect(onOpenSubSession).toHaveBeenCalledWith("A");
  });

  it("T3-no handler renders the row and click is a harmless no-op", () => {
    const events = [JOIN, SPAWN_A, ...BODY_A];
    expect(markupOfEl({ events })).toContain("subagent-row");
    const row = renderTree(element({ events })).find((n) => hasClass(n, "subagent-row"));
    expect(row).toBeDefined();
    // onOpenSubSession undefined (pre-Task-4 App): clicking throws nothing.
    expect(() => (row!.props.onClick as () => void)()).not.toThrow();
  });

  it("T3-sub-session view renders the projected events flat", () => {
    const MAIN_MSG: LoggedEvent = { seq: 5, ts, type: "user_message", userId: "frank", text: "MAIN ONLY MSG" };
    const events = [JOIN, MAIN_MSG, SPAWN_A, ...BODY_A];
    const text = textLines(markupOfEl({ events, view: "A" })).join("\n");
    // The sub-session's own rows render, flat…
    expect(text).toContain("sub row 0");
    expect(text).toContain("sub row 6");
    // …and NOTHING else: no main event, no compact row, no nesting.
    expect(text).not.toContain("MAIN ONLY MSG");
    expect(text).not.toContain("⚒ SUB-QUEST");
    expect(markupOfEl({ events, view: "A" })).not.toContain("subagent-row");
  });

  it("T3-view of unknown key renders an empty body without crashing", () => {
    const events = [JOIN, SPAWN_A, ...BODY_A];
    const markup = markupOfEl({ events, view: "does-not-exist" });
    expect(markup).toContain("transcript-body");
    const text = textLines(markup).join("\n");
    expect(text).not.toContain("sub row 0");
    expect(text).not.toContain("⚒ SUB-QUEST");
  });

  it("T3-gate prefix prefixes an attributed gate card with its sub-session label", () => {
    const attributedGate: LoggedEvent = {
      seq: 30,
      ts,
      type: "permission_request",
      requestId: "rg",
      toolName: "Write",
      input: { command: "rm -rf tmp" },
      parentToolUseId: "A",
    };
    const events = [JOIN, SPAWN_A, attributedGate];
    const text = textLines(markupOfEl({ events, view: "A" }));
    const prefixAt = text.indexOf("⚒ scan tests");
    const gateAt = text.findIndex((l) => l.includes(EXISTING_LINE));
    expect(prefixAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(prefixAt); // prefix comes BEFORE the existing gate text
  });

  it("T3-unattributed gate renders byte-identical to today", () => {
    // A gate with no parentToolUseId must render exactly as before. Checked by
    // subtraction (same technique as the perm-why byte-identity test above):
    // the attributed card minus its prefix node equals the unattributed card,
    // both isolated to the same wrappers.
    const base: Partial<LoggedEvent> = {
      seq: 30,
      ts,
      type: "permission_request",
      requestId: "rg",
      toolName: "Write",
      input: { command: "rm -rf tmp" },
    };
    const attributed = markupOfEl({ events: [SPAWN_A, { ...base, parentToolUseId: "A" } as LoggedEvent], view: "A" });
    const unattributed = markupOfEl({ events: [{ ...base } as LoggedEvent] });
    expect(unattributed).not.toContain("perm-sub");
    expect(attributed.replace('<div class="perm-sub">⚒ scan tests</div>', "")).toBe(unattributed);
  });

  it("T3-gate decidable in view invokes the decision callback from a sub-session view", () => {
    const attributedGate: LoggedEvent = {
      seq: 30,
      ts,
      type: "permission_request",
      requestId: "rg",
      toolName: "Write",
      input: { command: "rm -rf tmp" },
      parentToolUseId: "A",
    };
    const events = [JOIN, SPAWN_A, attributedGate];
    const onPermission = vi.fn();
    const nodes = renderTree(element({ events, view: "A", isDriver: true, onPermission }));
    const approve = nodes.find((n) => hasClass(n, "btn") && hasClass(n, "green"));
    const deny = nodes.find((n) => hasClass(n, "btn") && hasClass(n, "red"));
    expect(approve).toBeDefined();
    expect(deny).toBeDefined();
    (approve!.props.onClick as () => void)();
    expect(onPermission).toHaveBeenCalledWith("rg", "allow");
    (deny!.props.onClick as () => void)();
    expect(onPermission).toHaveBeenCalledWith("rg", "deny");
  });

  it("T3xT1-MAIN attributed pending gate renders inline as a full decidable card with the ⚒ prefix", () => {
    // The reviewer's Task-1 × Task-3 interaction: a concurrent sub-session
    // shows its compact row, AND an attributed gate must still render inline in
    // MAIN as a full card (tool name, body, ⚒ prefix, decide controls) — not be
    // swept into the bodiless subagent group (spec §2.3: gates render in the
    // gate surface regardless of which view is active).
    const attributedGate: LoggedEvent = {
      seq: 30,
      ts,
      type: "permission_request",
      requestId: "rg",
      toolName: "Write",
      input: { command: "rm -rf tmp" },
      parentToolUseId: "A",
    };
    const events = [JOIN, SPAWN_A, ...BODY_A, attributedGate];
    const markup = markupOfEl({ events, isDriver: true }); // view null = MAIN
    const text = textLines(markup).join("\n");
    // the concurrent sub-session still collapses to its compact row…
    expect(text).toContain("⚒ SUB-QUEST");
    // …and the attributed gate renders inline as a full card in MAIN:
    expect(text).toContain("⚒ scan tests"); // attribution prefix (spec §2.3)
    expect(text).toContain(EXISTING_LINE); // gate body
    expect(text).toContain("Write"); // tool name
    expect(markup).toContain("perm-sub");
    // decide controls present for the driver sitting on MAIN
    const nodes = renderTree(element({ events, view: null, isDriver: true }));
    const approve = nodes.find((n) => hasClass(n, "btn") && hasClass(n, "green"));
    const deny = nodes.find((n) => hasClass(n, "btn") && hasClass(n, "red"));
    expect(approve).toBeDefined();
    expect(deny).toBeDefined();
  });

  it("T3-existing rendering regression leaves a main-only log unchanged", () => {
    const MSG: LoggedEvent = { seq: 5, ts, type: "user_message", userId: "frank", text: "hi there" };
    const DELTA: LoggedEvent = { seq: 6, ts, type: "agent_text_delta", text: "working on it" };
    const events = [JOIN, MSG, DELTA];
    const markup = markupOfEl({ events });
    // Main events render flat, exactly as today — no sub-session artifacts.
    expect(markup).not.toContain("subagent-row");
    expect(markup).not.toContain("SUB-QUEST");
    expect(markup).not.toContain("perm-sub");
    const text = textLines(markup);
    expect(text).toEqual(["▸ Frank:", "hi there", "⏺ working on it"]);
  });
});

// ---------------------------------------------------------------------------
// Task 5 — PR-#32 rider: the MAIN compact sub-session row is keyboard-operable.
// The row was mouse-only (onClick) from PR #32; it must expose button semantics
// (`role="button"`, `tabIndex={0}`) and open on Enter and Space through the SAME
// handler as click, with its PR-#32 text and click behavior byte-unchanged.
// ---------------------------------------------------------------------------

/** A keydown-ish event object for the tree-walked handler. `renderTree` never
 *  runs the DOM, so we hand the onKeyDown its `.key` and a no-op preventDefault
 *  (the handler suppresses Space's page-scroll default). */
const keyEvent = (key: string) => ({ key, preventDefault: () => {} });

describe("Transcript — Task 5 compact-row keyboard a11y", () => {
  it("T5-row keyboard access exposes button semantics and opens on Enter and Space", () => {
    const events = [JOIN, SPAWN_A, ...BODY_A];

    // Button semantics on the compact row.
    const onOpenSubSession = vi.fn();
    const row = renderTree(element({ events, onOpenSubSession })).find((n) => hasClass(n, "subagent-row"));
    expect(row).toBeDefined();
    expect(row!.props.role).toBe("button");
    expect(row!.props.tabIndex).toBe(0);

    // Enter opens the sub-session — same handler, same key as click.
    (row!.props.onKeyDown as (e: unknown) => void)(keyEvent("Enter"));
    expect(onOpenSubSession).toHaveBeenNthCalledWith(1, "A");

    // Space (" ") opens it too.
    (row!.props.onKeyDown as (e: unknown) => void)(keyEvent(" "));
    expect(onOpenSubSession).toHaveBeenNthCalledWith(2, "A");
    expect(onOpenSubSession).toHaveBeenCalledTimes(2);

    // An unrelated key does nothing.
    (row!.props.onKeyDown as (e: unknown) => void)(keyEvent("x"));
    expect(onOpenSubSession).toHaveBeenCalledTimes(2);

    // No handler wired (pre-Task-4 App): keyboard activation is a harmless no-op.
    const bare = renderTree(element({ events })).find((n) => hasClass(n, "subagent-row"));
    expect(() => (bare!.props.onKeyDown as (e: unknown) => void)(keyEvent("Enter"))).not.toThrow();
  });

  it("T5-row semantics regression keeps the PR-#32 row text and click behavior byte-identical", () => {
    const events = [JOIN, SPAWN_A, ...BODY_A];

    // The PR-#32 text pieces are all still present, in order.
    const text = textLines(markupOfEl({ events })).join("\n");
    expect(text).toContain("⚒ SUB-QUEST");
    expect(text).toContain("scan tests"); // label
    expect(text).toContain("running…"); // status
    expect(text).toContain("7 rows");
    expect(text).toContain("open ▸");

    // Click still invokes the open handler unchanged (regression row).
    const onOpenSubSession = vi.fn();
    const row = renderTree(element({ events, onOpenSubSession })).find((n) => hasClass(n, "subagent-row"));
    expect(row).toBeDefined();
    (row!.props.onClick as () => void)();
    expect(onOpenSubSession).toHaveBeenCalledWith("A");
  });
});

// ---------------------------------------------------------------------------
// Task 9 — §8.5 jump-to-card: each gate card's root element carries an
// id="perm-<requestId>" so the pinned GateBar's onJump can scroll it into view
// (App owns the scroll; here we assert the anchor the scroll targets exists).
// The permission_request card root (className="perm") is the ONLY node with the
// exact `perm` class — perm-head/perm-title/etc. do not match hasClass(_,"perm").
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Task 10 — §8.5 wheel-on-card: a NON-DRIVER's undecided gate card gains a
// `🛞 TAKE THE WHEEL` button (`btn gold`) in its `.perm-outcome` area, invoking
// Transcript's optional `onTakeWheel`. The card does NOT auto-decide after the
// transfer — the driver decides on the card as normal. Absent for a decided
// gate or an already-driver viewer, and absent entirely when the prop is not
// passed (optional-prop regression floor).
// ---------------------------------------------------------------------------
const takeWheelBtn = (nodes: HostNode[]): HostNode | undefined =>
  nodes.find((n) => n.type === "button" && hasClass(n, "btn") && hasClass(n, "gold"));

describe("Transcript — Task 10 wheel-on-card", () => {
  it("T10-wheel-on-card offers TAKE THE WHEEL on a non-driver undecided gate", () => {
    const onTakeWheel = vi.fn();
    const events = [JOIN, gate({ requestId: "r1" })];
    const markup = markupOfEl({ events, onTakeWheel });
    const text = textLines(markup).join("\n");

    // The button carries the exact label, the `btn gold` class, and lives in
    // the `.perm-outcome` area (never the driver's `.perm-actions`).
    expect(text).toContain("🛞 TAKE THE WHEEL");
    expect(markup).toContain("perm-outcome");
    expect(markup).not.toContain("perm-actions");

    const btn = takeWheelBtn(renderTree(element({ events, onTakeWheel })));
    expect(btn).toBeDefined();
    (btn!.props.onClick as () => void)();
    expect(onTakeWheel).toHaveBeenCalledTimes(1);

    // The card does NOT auto-decide: it still reads as an undecided gate.
    expect(text).not.toContain("DECIDED");
    expect(text).not.toContain("approved");
    expect(text).not.toContain("denied");
  });

  it("T10-wheel-on-card absent on a DECIDED gate", () => {
    const onTakeWheel = vi.fn();
    const events = [JOIN, gate({ requestId: "r1" }), DECISION];
    expect(takeWheelBtn(renderTree(element({ events, onTakeWheel })))).toBeUndefined();
    expect(markupOfEl({ events, onTakeWheel })).not.toContain("TAKE THE WHEEL");
  });

  it("T10-wheel-on-card absent when already the driver — the driver keeps [A]/[D]", () => {
    const onTakeWheel = vi.fn();
    const events = [JOIN, gate({ requestId: "r1" })];
    const nodes = renderTree(element({ events, isDriver: true, onTakeWheel }));
    expect(takeWheelBtn(nodes)).toBeUndefined();
    // the existing driver decide controls are the ones present
    expect(nodes.find((n) => hasClass(n, "btn") && hasClass(n, "green"))).toBeDefined();
    expect(nodes.find((n) => hasClass(n, "btn") && hasClass(n, "red"))).toBeDefined();
  });

  it("T10-prop absent renders no button and is byte-identical to today", () => {
    const events = [JOIN, gate({ requestId: "r1" })];
    // With no `onTakeWheel` prop the non-driver card renders exactly as before.
    const without = markupOfEl({ events });
    expect(without).not.toContain("TAKE THE WHEEL");
    expect(without).toContain("⏳ driver deciding…");
    // Byte-identity by subtraction (same technique as the perm-why test): the
    // only difference the prop introduces is the added button node.
    const withProp = markupOfEl({ events, onTakeWheel: () => {} });
    expect(withProp.replace('<button class="btn gold">🛞 TAKE THE WHEEL</button>', "")).toBe(without);
  });
});

describe("Transcript — Task 9 jump-to-card ids", () => {
  it("T9-card-id gives each gate card root id=perm-<requestId>", () => {
    const card = renderTree(element({ events: [JOIN, gate({ requestId: "r1" })] })).find((n) =>
      hasClass(n, "perm"),
    );
    expect(card).toBeDefined();
    expect(card!.props.id).toBe("perm-r1");

    // The prefix is fixed and the id tracks the requestId verbatim.
    const other = renderTree(element({ events: [JOIN, gate({ requestId: "rg" })] })).find((n) =>
      hasClass(n, "perm"),
    );
    expect(other!.props.id).toBe("perm-rg");
  });
});
