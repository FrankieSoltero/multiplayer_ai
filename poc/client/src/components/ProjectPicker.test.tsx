import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectPicker } from "./ProjectPicker";

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
