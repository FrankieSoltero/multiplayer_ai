import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Header } from "./Header";
import { projectCollisions } from "../collisionView";
import type { ProjectSessionInfo } from "../types";

/** The session header's CONTESTED badge (spec §5): `⚠ CONTESTED ▸ N` beside the
 *  `🔐 PULLS ▸ N` badge, where N is how many contested paths involve THIS
 *  session.
 *
 *  Same house pattern as `ProjectPicker.test.tsx` / `RecordPanel.test.tsx` /
 *  `SessionPicker.test.tsx`: a REAL React render through `react-dom/server`,
 *  with the rendered DOM text pulled back out of the markup — this repo has no
 *  DOM test environment and deliberately adds none (`docs/tech-debt.md`: no
 *  jsdom, no happy-dom, no testing-library). `Header` opens no socket and runs
 *  no effect, so it renders here exactly as it renders in the app.
 *
 *  The `contested` prop is never hand-written below. Every fixture is genuine
 *  `collisionsFrom` output, produced by Task 9a's `projectCollisions` over
 *  snapshot rows — a badge that agreed with a hand-made array but disagreed
 *  with the shared derivation would still be a lie on screen. */

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
 *  (`poc/client/src/types.ts`). */
const row = (over: Partial<ProjectSessionInfo> & { id: string }): ProjectSessionInfo => ({
  participants: ["frank"],
  driverName: null,
  intent: null,
  lastActivityTs: null,
  ended: false,
  ...over,
});

/** Three sessions in one repo. `src/a.ts` and `src/b.ts` are contested by
 *  me+peer, `src/c.ts` by peer+other — so every count in sight differs:
 *  3 contested paths in the project, 2 of them involving ME, 3 sessions
 *  involved, 6 touched entries. A badge that counted the project's collisions,
 *  the sessions, or the touch entries cannot pass by coincidence. */
const SNAPSHOT: ProjectSessionInfo[] = [
  row({ id: "me", repoKey: "r1", touched: ["src/a.ts", "src/b.ts"] }),
  row({ id: "peer", repoKey: "r1", touched: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
  row({ id: "other", repoKey: "r1", touched: ["src/c.ts"] }),
];

const COLLISIONS = projectCollisions(SNAPSHOT);

type HeaderProps = Parameters<typeof Header>[0];

/** Everything `Header` requires, with the noisy neighbours quiet: no sign-in
 *  chip, no running workflows. `pulls` is set where a test needs the PULLS
 *  badge to exist. */
const baseProps = (over: Partial<HeaderProps> = {}): HeaderProps => ({
  projectId: "p1",
  sessionId: "me",
  model: "opus",
  connected: true,
  objective: null,
  canSetModel: true,
  onSetModel: () => {},
  permissionMode: "default",
  canCycleMode: true,
  onCycleMode: () => {},
  arcadeOpen: false,
  canToggleArcade: true,
  onToggleArcade: () => {},
  onOpenSkills: () => {},
  onOpenWorkflows: () => {},
  runningTasks: 0,
  onOpenOversight: () => {},
  oversightFresh: false,
  onExit: () => {},
  theme: "arcade",
  onThemeToggle: () => {},
  ...over,
});

const render = (over: Partial<HeaderProps> = {}): string =>
  renderToStaticMarkup(<Header {...baseProps(over)} />);

/** Hooks-shim tree walk (Transcript.test.tsx pattern): `Header` uses no hooks,
 *  so calling it under the inert runtime yields its full host-node tree — the
 *  only way to reach an `onClick` handler that static markup drops. */
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
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const n = node as HostNode;
      if (n.props) { out.push(n); visit(n.props.children); }
    };
    visit(rendered);
    return out;
  } finally {
    internals.H = prev;
  }
};
const textOf = (node: unknown): string => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as HostNode;
  return n.props ? textOf(n.props.children) : "";
};
const themeButton = (over: Partial<HeaderProps> = {}): HostNode | undefined =>
  renderTree(<Header {...baseProps(over)} />).find(
    (n) => n.type === "button" && textOf(n).includes("THEME ▸"),
  );

describe("Header — CONTESTED badge (spec §5)", () => {
  it("reads exactly `⚠ CONTESTED ▸ N` for the CURRENT session's contested paths", () => {
    const lines = textLines(render({ contested: COLLISIONS }));
    expect(lines).toContain("⚠ CONTESTED ▸ 2");
    // Not the project's 3 collisions, not the 3 sessions, not the 6 touches.
    expect(lines).not.toContain("⚠ CONTESTED ▸ 3");
    expect(lines).not.toContain("⚠ CONTESTED ▸ 6");
  });

  it("counts from the CURRENT session, not the project", () => {
    // `other` shares exactly one path (src/c.ts) out of the same 3 collisions.
    const lines = textLines(render({ sessionId: "other", contested: COLLISIONS }));
    expect(lines).toContain("⚠ CONTESTED ▸ 1");
  });

  it("names a COUNT, never a path list", () => {
    const markup = render({ contested: COLLISIONS });
    expect(markup).not.toContain("src/a.ts");
    expect(markup).not.toContain("src/b.ts");
    expect(markup).not.toContain("src/c.ts");
  });

  it("sits beside the PULLS badge, not inside it", () => {
    const markup = render({ pulls: 4, contested: COLLISIONS });
    // Immediate next sibling of the pulls badge.
    expect(markup).toMatch(/pull-badge[\s\S]*?<\/span><span class="conn contested-calm"/);
    // And it does not depend on there being pulls at all.
    expect(textLines(render({ contested: COLLISIONS }))).toContain("⚠ CONTESTED ▸ 2");
  });
});

describe("Header — CONTESTED badge is hidden at zero", () => {
  it("renders NO badge node when the current session is in no collision", () => {
    // Discriminating: the project HAS collisions, this session is in none of
    // them — a badge gated on `contested.length` would render `▸ 0` here.
    const markup = render({ sessionId: "solo", contested: COLLISIONS });
    expect(markup).not.toContain("CONTESTED");
    expect(markup).not.toContain("contested-calm");
    // Not vacuous: the header really did render.
    expect(textLines(markup)).toContain("● ONLINE");
  });

  it("renders no empty badge node either", () => {
    const markup = render({ sessionId: "solo", contested: COLLISIONS });
    expect(markup).not.toMatch(/<span class="conn contested-calm"[^>]*><\/span>/);
    expect(markup).toBe(render({ sessionId: "solo", contested: [] }));
  });
});

describe("Header — the badge is calm, never the permission-gate amber", () => {
  it("carries `contested-calm` and never the amber pull-badge class", () => {
    const markup = render({ pulls: 4, contested: COLLISIONS });
    expect(markup).toMatch(/class="[^"]*contested-calm[^"]*"[^>]*>⚠ CONTESTED ▸ 2</);
    // `.pull-badge` IS `--amber` (terminal.css) — the one class this badge must
    // not borrow. The rule bodies cannot be asserted from here (vitest stubs
    // CSS imports to ""), so the class NAMES are what get pinned; the
    // `.contested-calm` declaration is pinned by Task 9b's greps.
    expect(markup).not.toMatch(/contested-calm[^"]*pull-badge|pull-badge[^"]*contested-calm/);
    expect(markup.match(/contested-calm/g)).toHaveLength(1);
  });
});

describe("Header — THEME toggle (Task 2, spec §2.1)", () => {
  it("T2-button-label reads THEME ▸ ARCADE / THEME ▸ CLEAN per theme, in BOTH themes, class planmode", () => {
    // Present and correctly labelled in arcade…
    const arcade = textLines(render({ theme: "arcade" }));
    expect(arcade).toContain("THEME ▸ ARCADE");
    expect(arcade).not.toContain("THEME ▸ CLEAN");
    // …and in clean — the control exists in both themes (parity, constraint 2).
    const clean = textLines(render({ theme: "clean" }));
    expect(clean).toContain("THEME ▸ CLEAN");
    expect(clean).not.toContain("THEME ▸ ARCADE");
    // It is a `planmode` header button, exactly like ARCADE/MODE beside it.
    expect(themeButton({ theme: "arcade" })!.props.className).toBe("planmode");
    expect(themeButton({ theme: "clean" })!.props.className).toBe("planmode");
  });

  it("T2-button-placement sits in the .term-header control run beside ARCADE", () => {
    const markup = render({ theme: "arcade" });
    // Immediately after the ARCADE button, inside the header control run.
    expect(markup).toMatch(/▢ ARCADE<\/button><button class="planmode"[^>]*>THEME ▸ ARCADE<\/button>/);
  });

  it("T2-toggle click invokes onThemeToggle", () => {
    const onThemeToggle = vi.fn();
    const btn = themeButton({ theme: "arcade", onThemeToggle });
    expect(btn).toBeDefined();
    (btn!.props.onClick as () => void)();
    expect(onThemeToggle).toHaveBeenCalledTimes(1);
  });
});

/** The one PULLS badge node, found by its EXACT text so a container that also
 *  contains the phrase (the whole header) can never be mistaken for it. Returns
 *  a real host node (button or span) so its `type` and `onClick` are assertable. */
const pullsBadge = (over: Partial<HeaderProps> = {}, pulls = 3): HostNode | undefined =>
  renderTree(<Header {...baseProps({ pulls, ...over })} />).find(
    (n) => textOf(n) === `🔐 PULLS ▸ ${pulls}`,
  );

describe("Header — §8.5 PULLS click-through (Task 11)", () => {
  it("T11-pulls-badge-button renders the PULLS badge as a keyboard-operable <button> invoking onPullsClick, text unchanged", () => {
    const onPullsClick = vi.fn();
    const badge = pullsBadge({ onPullsClick });
    expect(badge).toBeDefined();
    // A real <button> — keyboard-operable by construction, unlike the span.
    expect(badge!.type).toBe("button");
    // className is `conn pull-badge`, same as the span variant — this is the
    // exact selector terminal.css's `button.pull-badge` rule depends on to
    // neutralize the UA button chrome (border/background/padding) so the
    // button renders like its plain-span sibling, not a framed control.
    expect(badge!.props.className).toBe("conn pull-badge");
    // The exact badge text is unchanged.
    expect(textOf(badge!)).toBe("🔐 PULLS ▸ 3");
    // Clicking it fires the handler.
    (badge!.props.onClick as () => void)();
    expect(onPullsClick).toHaveBeenCalledTimes(1);
  });

  it("T11-prop-absent renders the badge exactly as today — a non-interactive <span>, no handler — when onPullsClick is absent", () => {
    const badge = pullsBadge();
    expect(badge).toBeDefined();
    expect(badge!.type).toBe("span"); // not a button
    expect(badge!.props.onClick).toBeUndefined(); // nothing to click
    // Byte-identical to today's render: an absent prop is not a different screen.
    expect(render({ pulls: 3 })).toBe(render({ pulls: 3, onPullsClick: undefined }));
    // And the static markup still carries the badge span text.
    expect(textLines(render({ pulls: 3 }))).toContain("🔐 PULLS ▸ 3");
  });

  it("T11-pulls-regression renders NO badge at pulls=0, exactly as today (Header.tsx pulls>0 gate)", () => {
    const markup = render({ pulls: 0 });
    expect(markup).not.toContain("PULLS");
    expect(markup).not.toContain("pull-badge");
    // Even with a handler present: zero pulls means there is nothing to jump to.
    expect(render({ pulls: 0, onPullsClick: () => {} })).not.toContain("PULLS");
    // Not vacuous — the header really did render.
    expect(textLines(markup)).toContain("● ONLINE");
  });
});

describe("Header — the `contested` prop is optional", () => {
  it("renders exactly as today when no caller passes it", () => {
    const today = render({ pulls: 4 });
    expect(today).not.toContain("CONTESTED");
    expect(today).not.toContain("contested-calm");
    // Byte-identical to an empty collision set: the badge is the ONLY DOM this
    // task adds, and an absent prop is not a different screen.
    expect(today).toBe(render({ pulls: 4, contested: [] }));
    // Not vacuous: every pre-existing header surface still rendered.
    const lines = textLines(today);
    expect(lines).toContain("● ONLINE");
    expect(lines).toContain("🔐 PULLS ▸ 4");
    expect(lines).toContain("▢ EXIT");
  });
});
