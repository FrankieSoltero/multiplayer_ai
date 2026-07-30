import { describe, expect, it } from "vitest";
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
