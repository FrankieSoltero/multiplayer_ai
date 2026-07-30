import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PartyPane } from "./PartyPane";
import type { ProjectSessionInfo } from "../types";
import type { Participant } from "../derive";

/** The OTHER PARTIES `⚠ shares: …` line (spec §5).
 *
 *  Same house pattern as `SessionPicker.test.tsx` / `Header.test.tsx`: a REAL
 *  React render through `react-dom/server`, with the rendered DOM text pulled
 *  back out of the markup — this repo has no DOM test environment and
 *  deliberately adds none (`docs/tech-debt.md`: no jsdom, no happy-dom, no
 *  testing-library).
 *
 *  `PartyPane` derives the collisions itself from the `sessions` prop it
 *  already receives, through Task 9a's shared `projectCollisions`, so nothing
 *  about the data path is faked: every assertion below runs against genuine
 *  `collisionsFrom` output for the fixture rows. */

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
  repoKey: "r1",
  ...over,
});

const ME: Participant = { name: "frank", glyph: "@", color: "#0f0" };

const render = (sessions: ProjectSessionInfo[]): string =>
  renderToStaticMarkup(
    <PartyPane
      projectId="p1"
      sessionId="mine"
      sessions={sessions}
      participants={new Map([["u1", ME]])}
      driverId="u1"
      selfId="u1"
    />,
  );

/** The OTHER PARTIES rows are `<a class="member …">` blocks whose children are
 *  all flat sibling `<div>`s — no nesting — so a non-greedy div match reads the
 *  row's children in document order without a DOM. */
const rowFor = (markup: string, id: string): string => {
  const rows = markup.match(/<a [^>]*class="member[^"]*"[\s\S]*?<\/a>/g) ?? [];
  const found = rows.find((r) => textLines(r).includes(id));
  expect(found, `no OTHER PARTIES row for ${id}`).toBeDefined();
  return found!;
};

const childDivs = (rowMarkup: string): { cls: string; text: string }[] =>
  [...rowMarkup.matchAll(/<div class="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => ({
    cls: m[1],
    text: textLines(m[2]).join(" "),
  }));

/** `mine` shares FIVE paths with `beta` (overflow), TWO with `gamma` (no
 *  overflow) and none with `delta`. Every `touched` list below is deliberately
 *  in DESCENDING order: the rendered line must be ascending, so a row that
 *  echoed input order instead of `sharedWith`'s sort cannot pass. */
const MINE = row({
  id: "mine",
  touched: ["src/e.ts", "src/d.ts", "src/c.ts", "src/b.ts", "src/a.ts", "src/z.ts"],
});
const BETA = row({
  id: "beta",
  touched: ["src/e.ts", "src/d.ts", "src/c.ts", "src/b.ts", "src/a.ts"],
});
const GAMMA = row({ id: "gamma", touched: ["src/b.ts", "src/a.ts"] });
const DELTA = row({ id: "delta", touched: ["docs/x.md"] });

const CONTESTED = [MINE, BETA, GAMMA, DELTA];

describe("PartyPane — OTHER PARTIES shares line (spec §5)", () => {
  it("names the shared paths ascending, separated by comma + single space", () => {
    const line = childDivs(rowFor(render(CONTESTED), "gamma")).at(-1)!;
    expect(line.text).toBe("⚠ shares: src/a.ts, src/b.ts");
  });

  it("caps the list at three paths and counts the rest as ` +N more`", () => {
    const line = childDivs(rowFor(render(CONTESTED), "beta")).at(-1)!;
    // 5 shared paths: the first three by name, then the remaining two counted.
    expect(line.text).toBe("⚠ shares: src/a.ts, src/b.ts, src/c.ts +2 more");
    // `src/z.ts` is mine alone — a shares list is the INTERSECTION, never my
    // own touched set, so it may not appear in the count or the names.
    expect(line.text).not.toContain("src/z.ts");
    expect(line.text).not.toContain("+3 more");
  });

  it("renders the line LAST in the row, after the existing member-meta", () => {
    const divs = childDivs(rowFor(render(CONTESTED), "beta"));
    expect(divs.at(-2)!.cls).toBe("member-meta");
    expect(divs.at(-1)!.cls).toBe("member-meta contested-calm");
  });

  it("carries the calm class — no alarm styling on a peer row", () => {
    const markup = render(CONTESTED);
    expect(markup).toContain('<div class="member-meta contested-calm">');
  });

  it("leaves a peer with no overlap exactly as it is today", () => {
    const divs = childDivs(rowFor(render(CONTESTED), "delta"));
    expect(divs.map((d) => d.cls)).toEqual(["member-head", "member-quest none", "member-meta"]);
    expect(divs.map((d) => d.text).join(" ")).not.toContain("shares");
  });

  it("renders rows BYTE-IDENTICALLY when nothing collides at all", () => {
    // Same sessions, same everything — only the touched sets differ, and they
    // are disjoint. The pane must render exactly what it renders with no
    // touched data at all.
    const disjoint = [
      row({ id: "mine", touched: ["src/a.ts"] }),
      row({ id: "beta", touched: ["src/b.ts"] }),
      row({ id: "gamma", touched: ["src/c.ts"] }),
    ];
    const untouched = disjoint.map((s) => row({ ...s, touched: undefined }));
    expect(render(disjoint)).toBe(render(untouched));
    expect(render(disjoint)).not.toContain("contested-calm");
  });

  it("shows a shares line for a CLOSED peer too — closing releases no files (spec §2.6)", () => {
    const closed = [MINE, row({ ...GAMMA, lifecycle: "closed" }), DELTA];
    const line = childDivs(rowFor(render(closed), "gamma")).at(-1)!;
    expect(line.text).toBe("⚠ shares: src/a.ts, src/b.ts");
  });
});
