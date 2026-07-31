import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectPicker, ProjectRows } from "./ProjectPicker";
import type { ProjectSummary } from "../types";

/** The hub entrance's own copy.
 *
 *  Same house pattern as `RecordPanel.test.tsx`: a REAL React render through
 *  `react-dom/server`, with the rendered DOM text pulled back out of the markup
 *  (this repo has no DOM test environment and deliberately adds none). Static
 *  rendering never runs `useEffect`, so no socket is opened here.
 *
 *  Copy gets pinned as a literal on purpose. This line claimed for months that
 *  "nothing here survives a hub restart" long after the hub started persisting
 *  everything to SQLite — a screen that lies about durability teaches people not
 *  to trust the record. A literal is what makes the lie fail a test. */

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

const pickerText = (): string[] =>
  textLines(renderToStaticMarkup(<ProjectPicker userId="frank" name="Frank" />));

describe("ProjectPicker — NEW PROJECT hint", () => {
  it("says where projects live: the hub's store, not memory", () => {
    expect(pickerText()).toContain(
      "projects and their records persist in the hub's store (HUB_DB).",
    );
  });

  it("makes no claim that a hub restart loses anything", () => {
    // The old copy, and the shape of any regression back to it.
    const text = pickerText().join("\n");
    expect(text).not.toMatch(/survives? a hub restart/i);
    expect(text).not.toMatch(/held in memory|in-memory|kept in memory/i);
  });

  it("still renders the rest of the entrance around it", () => {
    // Not vacuous: the hint is one line of a screen that really did render.
    const text = pickerText();
    expect(text).toContain("PROJECTS");
    expect(text).toContain("NEW PROJECT");
    expect(text).toContain("no projects yet — create one below.");
  });
});

/** The picker fills `projects` from a socket in `useEffect`, and static
 *  rendering never runs effects (`SessionPicker.test.tsx` explains the same
 *  seam), so `ProjectPicker` itself can only ever draw an EMPTY list here.
 *  `ProjectRows` is that row block taken as a prop — the seam that lets these
 *  assertions run against real redaction-shaped fixtures. */
const project = (
  over: Partial<ProjectSummary> & { id: string; name: string },
): ProjectSummary => ({
  lifecycle: "active",
  members: [],
  sessionCount: 0,
  liveSessionCount: 0,
  machines: [],
  ...over,
});

const rowsText = (projects: ProjectSummary[], userId = "frank"): string =>
  textLines(
    renderToStaticMarkup(<ProjectRows projects={projects} userId={userId} />),
  ).join("\n");

describe("ProjectRows — redaction-safe member count (spec A5)", () => {
  it("prefers memberCount over the possibly-redacted roster length", () => {
    // A redacted project: not a member, roster blanked to [], true count 5.
    const p = project({ id: "p1", name: "Alpha", isMember: false, members: [], memberCount: 5 });
    const text = rowsText([p]);
    expect(text).toContain("5 members");
    expect(text).not.toContain("0 members");
  });

  it("falls back to members.length when memberCount is absent — old-server tolerance", () => {
    const p = project({ id: "p1", name: "Alpha", members: ["a", "b"] });
    expect(rowsText([p])).toContain("2 members");
  });

  it("pluralizes off the true count, not the roster length", () => {
    const p = project({ id: "p1", name: "Alpha", isMember: false, members: [], memberCount: 1 });
    const text = rowsText([p]);
    expect(text).toContain("1 member ");
    expect(text).not.toContain("1 members");
  });
});

describe("ProjectRows — SPECTATING badge from isMember (spec A5)", () => {
  it("shows SPECTATING from isMember:false even when the roster is redacted to empty", () => {
    const p = project({ id: "p1", name: "Alpha", isMember: false, members: [], memberCount: 5 });
    expect(rowsText([p], "frank")).toContain("SPECTATING");
  });

  it("hides SPECTATING from isMember:true even when userId is not in the roster", () => {
    // Proves the badge reads isMember, not members.includes(userId).
    const p = project({ id: "p1", name: "Alpha", isMember: true, members: ["someone-else"] });
    expect(rowsText([p], "frank")).not.toContain("SPECTATING");
  });

  it("falls back to members.includes when isMember is absent — old server", () => {
    const memberP = project({ id: "p1", name: "Alpha", members: ["frank"] });
    const specP = project({ id: "p2", name: "Beta", members: ["someone"] });
    expect(rowsText([memberP], "frank")).not.toContain("SPECTATING");
    expect(rowsText([specP], "frank")).toContain("SPECTATING");
  });
});
