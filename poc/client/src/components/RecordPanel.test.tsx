import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ProjectRecord,
  SessionRecord,
  TurnRecord,
  UserRollup,
} from "multiplayer-ai-server/record";
import type { MachineInfo } from "../types";
import { rollupLines, sessionBlocks } from "../recordView";
import { RECORD_CLOSED, RECORD_LOADING_LINE, RecordPanel, recordStep } from "./RecordPanel";
import { SessionPicker } from "./SessionPicker";
import pickerSource from "./SessionPicker.tsx?raw";

/** The RECORD panel and the picker's RECORD wiring.
 *
 *  This repo has NO DOM test environment and deliberately adds none (standing
 *  project constraint, `docs/tech-debt.md:215`: no jsdom, no happy-dom, no
 *  testing-library; the plan's new deps are `poc/hub` only). So:
 *
 *   - render rows are REAL React renders through `react-dom/server`, with the
 *     rendered DOM text extracted from the markup and compared line for line;
 *   - interactive rows go through `recordStep`, the pure reducer that BOTH the
 *     toggle's click and the ws message dispatch call — it returns the outbound
 *     sends instead of performing them, so "opening sends `get_record`" is a
 *     real assertion about the code that runs in the browser;
 *   - the two things neither can see — a real click reaching `recordStep`, and
 *     the single `ws.send` call site — are pinned by source assertions on
 *     `SessionPicker.tsx` (the house `?raw` pattern, `recordView.test.ts:4`)
 *     and by Task 13's live browser walk. */

const PROJECT = "p1";
const START = "2026-07-29T10:00:00Z";

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  turn: 1,
  driver: "frank",
  prompt: "fix the thing",
  startTs: START,
  endTs: "2026-07-29T10:05:00Z",
  inProgress: false,
  toolCounts: {},
  filesChanged: [],
  approvals: [],
  errors: 0,
  ...over,
});

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "s1",
  machineId: "m1",
  repoKey: "acme/api",
  lifecycle: "open",
  intent: null,
  closedBy: null,
  turns: [],
  ...over,
});

const rollup = (over: Partial<UserRollup> = {}): UserRollup => ({
  userId: "frank",
  turnsDriven: 0,
  approvalsGiven: 0,
  denialsGiven: 0,
  ...over,
});

const record = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  projectId: PROJECT,
  sessions: [session()],
  rollup: { perUser: [rollup()], totalTurns: 0, totalSessions: 1 },
  ...over,
});

const machines: MachineInfo[] = [
  { machineId: "m1", name: "franks-mbp", repos: [], online: true },
];

/** A record with every shape the view-model bends for: two users, two
 *  sessions, a closed one, a null machineId, a null driver, tools, files,
 *  approvals, errors, an in-progress turn, and HTML metacharacters in a prompt
 *  (React escapes them in the markup; the DOM TEXT must come back byte-equal,
 *  which is what "renders the lines unmodified" means). */
const fixture = record({
  sessions: [
    session({
      turns: [
        turn({
          turn: 1,
          prompt: "fix a<b & c",
          toolCounts: { Read: 3, Edit: 1 },
          filesChanged: ["src/a.ts", "src/b.ts"],
          approvals: [
            { kind: "permission", decision: "allow", userId: "frank", toolName: "Bash", auto: false },
          ],
          errors: 2,
        }),
        turn({ turn: 2, driver: null, prompt: null, inProgress: true }),
      ],
    }),
    session({
      sessionId: "s2",
      machineId: null,
      repoKey: null,
      lifecycle: "closed",
      closedBy: "amy",
      turns: [turn({ turn: 1, driver: "amy" })],
    }),
  ],
  rollup: {
    perUser: [
      rollup({ userId: "frank", turnsDriven: 2, approvalsGiven: 1, denialsGiven: 0 }),
      rollup({ userId: "amy", turnsDriven: 1, approvalsGiven: 0, denialsGiven: 3 }),
    ],
    totalTurns: 3,
    totalSessions: 2,
  },
});

/** Every line of DOM text the markup renders, in document order. React escapes
 *  `& < > " '` in text, so decoding those five is exactly the inverse. */
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

/** What the view-model says the panel must show for a record, in order. */
const expectedLines = (rec: ProjectRecord, ms: MachineInfo[]): string[] => [
  ...rollupLines(rec),
  ...sessionBlocks(rec, ms).flatMap((block) => [block.header, ...block.turnLines]),
];

const panelText = (rec: ProjectRecord | null, ms: MachineInfo[] = machines): string[] =>
  textLines(renderToStaticMarkup(<RecordPanel record={rec} machines={ms} />));

const pickerMarkup = (): string =>
  renderToStaticMarkup(<SessionPicker projectId={PROJECT} userId="frank" name="Frank" />);

const message = (msg: unknown) => ({ kind: "message" as const, msg });

describe("RECORD entry point", () => {
  it("offers a collapsed RECORD toggle on the project screen", () => {
    const markup = pickerMarkup();
    expect(textLines(markup)).toContain("RECORD ▸");
    expect(markup).toMatch(/aria-expanded="false"/);
    // Collapsed means the body is ABSENT, not merely empty.
    expect(markup).not.toContain(RECORD_LOADING_LINE);
  });

  it("opens the panel when the toggle is clicked", () => {
    // The click's effect on state, and the picker's one render gate for it.
    expect(recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT).state.open).toBe(true);
    expect(pickerSource).toMatch(/stepRecord\(\{\s*kind:\s*"toggle"\s*\}\)/);
    expect(pickerSource).toMatch(/recordState\.open\s*&&\s*\(?\s*<RecordPanel/);
  });

});

describe("RECORD fetch on open", () => {
  it("sends get_record for this project when the panel is opened", () => {
    const step = recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT);
    expect(step.send).toEqual([{ type: "get_record", projectId: PROJECT }]);
    // ...and the picker puts every returned send on the wire, unmodified.
    expect(pickerSource).toMatch(/step\.send[\s\S]{0,120}send\(JSON\.stringify\(/);
  });

  it("renders the record that arrives for this project", () => {
    // The picker feeds EVERY socket message to the reducer — without this call
    // site the rows below hold for a reducer nothing ever reaches.
    expect(pickerSource).toMatch(/stepRecord\(\{\s*kind:\s*"message",\s*msg\s*\}\)/);
    const open = recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT).state;
    const step = recordStep(open, message({ type: "record", projectId: PROJECT, record: fixture }), PROJECT);
    expect(step.state.record).toEqual(fixture);
    expect(step.send).toEqual([]);
    expect(panelText(step.state.record)).toEqual(expectedLines(fixture, machines));
  });

  it("ignores a record whose projectId is another project's", () => {
    const open = recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT).state;
    const step = recordStep(open, message({ type: "record", projectId: "other", record: fixture }), PROJECT);
    expect(step.state.record).toBeNull();
    expect(step.send).toEqual([]);
  });

  it("ignores a record message whose payload is not a record", () => {
    const open = recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT).state;
    for (const payload of [undefined, null, "nope", 7, {}, { sessions: [] }, { rollup: {} }]) {
      const step = recordStep(open, message({ type: "record", projectId: PROJECT, record: payload }), PROJECT);
      expect(step.state.record).toBeNull();
    }
  });

  it("ignores a malformed message rather than throwing", () => {
    for (const msg of [undefined, null, "record", 7, {}, { type: 42 }]) {
      const step = recordStep(RECORD_CLOSED, message(msg), PROJECT);
      expect(step).toEqual({ state: RECORD_CLOSED, send: [] });
    }
  });
});

describe("RECORD refresh", () => {
  it("re-sends get_record on a project push while the panel is open", () => {
    const open = recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT).state;
    const step = recordStep(open, message({ type: "project", sessions: [], machines: [] }), PROJECT);
    expect(step.send).toEqual([{ type: "get_record", projectId: PROJECT }]);
    expect(step.state.open).toBe(true);
  });

  it("sends nothing on a project push while the panel is closed", () => {
    const step = recordStep(RECORD_CLOSED, message({ type: "project", sessions: [] }), PROJECT);
    expect(step.send).toEqual([]);
  });

  it("sends nothing when the toggle is closed again, and keeps the record it fetched", () => {
    const open = recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT).state;
    const loaded = recordStep(
      open,
      message({ type: "record", projectId: PROJECT, record: fixture }),
      PROJECT,
    ).state;
    const closed = recordStep(loaded, { kind: "toggle" }, PROJECT);
    expect(closed.state).toEqual({ open: false, record: fixture });
    expect(closed.send).toEqual([]);
    // Re-opening refetches — and shows the last known record meanwhile rather
    // than flashing the loading line.
    const reopened = recordStep(closed.state, { kind: "toggle" }, PROJECT);
    expect(reopened.state).toEqual({ open: true, record: fixture });
    expect(reopened.send).toEqual([{ type: "get_record", projectId: PROJECT }]);
  });
});

describe("RECORD rendering", () => {
  it("renders exactly the view-model's lines, in order, unmodified", () => {
    expect(panelText(fixture)).toEqual(expectedLines(fixture, machines));
    // Not vacuous: the fixture really does carry content on every line.
    expect(expectedLines(fixture, machines).length).toBe(7);
    expect(panelText(fixture)).toContain("#1 frank · 2026-07-29T10:00:00Z · fix a<b & c · tools: Read×3 Edit×1 · files: src/a.ts, src/b.ts · approvals: allow Bash by frank · errors: 2");
  });

  it("resolves machine names through the machines it is given", () => {
    expect(panelText(fixture, [])).toEqual(expectedLines(fixture, []));
    expect(panelText(fixture).join("\n")).toContain("franks-mbp");
    expect(panelText(fixture, []).join("\n")).not.toContain("franks-mbp");
  });

  it("renders one line for a project with nothing recorded", () => {
    const empty = record({ sessions: [], rollup: { perUser: [], totalTurns: 0, totalSessions: 0 } });
    expect(panelText(empty)).toEqual(["nothing recorded yet"]);
  });

  it("renders a loading line until the record arrives, distinct from an empty record", () => {
    const empty = record({ sessions: [], rollup: { perUser: [], totalTurns: 0, totalSessions: 0 } });
    expect(panelText(null)).toEqual(["loading the record…"]);
    expect(RECORD_LOADING_LINE).toBe("loading the record…");
    // "not answered yet" must never read as "answered, and there is nothing":
    // one is a fetch in flight, the other is a claim about the project.
    expect(panelText(null)).not.toEqual(panelText(empty));
  });
});

describe("RECORD error", () => {
  it("leaves a get_record error to the picker's existing error line", () => {
    const open = recordStep(RECORD_CLOSED, { kind: "toggle" }, PROJECT).state;
    const step = recordStep(
      open,
      message({ type: "error", message: "get_record requires a valid projectId" }),
      PROJECT,
    );
    // The reducer neither swallows the error nor invents a second error
    // surface: the state is untouched and nothing is re-sent.
    expect(step).toEqual({ state: open, send: [] });
    // ...and the picker's one error path still routes every `error` message to
    // the one red line. The window is wider than it once was: the branch now
    // normalizes the lifecycle gate's UNCODED member refusal to a
    // `not_a_member` code first (plan 2026-08-01-project-lifecycle-controls),
    // and those lines sit between the branch opening and the setError guard.
    expect(pickerSource).toMatch(/msg\.type === "error"\)\s*\{\s*[\s\S]{0,480}setError\(msg\.message\)/);
    expect(pickerSource).toMatch(/\{error && <div className="line red">\{error\}<\/div>\}/);
  });
});
