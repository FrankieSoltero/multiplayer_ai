import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionGroups } from "./SessionPicker";
import type { MachineInfo, ProjectSessionInfo } from "../types";

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
