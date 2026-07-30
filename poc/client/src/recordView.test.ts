import { describe, expect, it } from "vitest";
import type { ProjectRecord, SessionRecord, TurnRecord, UserRollup } from "multiplayer-ai-server/record";
import { rollupLines, sessionBlocks } from "./recordView";
import source from "./recordView.ts?raw";
import type { MachineInfo } from "./types";

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

/** Non-empty by default: `sessions: []` is itself the empty-record case, so a
 *  rollup or header fixture must carry a session or it renders that instead. */
const record = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  projectId: "p1",
  sessions: [session()],
  rollup: { perUser: [], totalTurns: 0, totalSessions: 1 },
  ...over,
});

const machine = (machineId: string, name: string): MachineInfo => ({
  machineId,
  name,
  repos: [],
  online: true,
});

const firstTurnLine = (t: TurnRecord): string =>
  sessionBlocks(record({ sessions: [session({ turns: [t] })] }), [])[0].turnLines[0];

describe("rollupLines", () => {
  it("renders one line per user, in the record's order, with the ids as provided", () => {
    const lines = rollupLines(
      record({
        rollup: {
          perUser: [
            rollup({ userId: "frank", turnsDriven: 7, approvalsGiven: 3, denialsGiven: 1 }),
            rollup({ userId: "amy", turnsDriven: 0, approvalsGiven: 0, denialsGiven: 0 }),
          ],
          totalTurns: 7,
          totalSessions: 1,
        },
      }),
    );
    expect(lines).toEqual([
      "frank — 7 driven · 3 approved · 1 denied",
      "amy — 0 driven · 0 approved · 0 denied",
    ]);
  });

  it("renders exactly one line for a record with no sessions", () => {
    const empty = record({ sessions: [], rollup: { perUser: [], totalTurns: 0, totalSessions: 0 } });
    expect(rollupLines(empty)).toEqual(["nothing recorded yet"]);
    expect(sessionBlocks(empty, [])).toEqual([]);
  });

  it("still reports an empty record when a stale rollup carries rows but no session does", () => {
    const empty = record({
      sessions: [],
      rollup: { perUser: [rollup({ turnsDriven: 2 })], totalTurns: 2, totalSessions: 0 },
    });
    expect(rollupLines(empty)).toEqual(["nothing recorded yet"]);
  });
});

describe("sessionBlocks — headers", () => {
  it("labels the machine with its resolved name", () => {
    const blocks = sessionBlocks(record({ sessions: [session()] }), [
      machine("m0", "amys-mbp"),
      machine("m1", "franks-mbp"),
    ]);
    expect(blocks.map((b) => b.header)).toEqual(["s1 — franks-mbp · acme/api · open"]);
  });

  it("falls back to the raw machineId when no machine matches", () => {
    const blocks = sessionBlocks(record({ sessions: [session({ machineId: "m9" })] }), [
      machine("m1", "franks-mbp"),
    ]);
    expect(blocks[0].header).toBe("s1 — m9 · acme/api · open");
  });

  it("says unknown machine when the session has no machineId", () => {
    const blocks = sessionBlocks(record({ sessions: [session({ machineId: null })] }), [
      machine("m1", "franks-mbp"),
    ]);
    expect(blocks[0].header).toBe("s1 — unknown machine · acme/api · open");
  });

  it("says no repo when the session has no repoKey", () => {
    const blocks = sessionBlocks(record({ sessions: [session({ repoKey: null })] }), []);
    expect(blocks[0].header).toBe("s1 — m1 · no repo · open");
  });

  it("appends the closer when a session was closed by someone", () => {
    const blocks = sessionBlocks(
      record({ sessions: [session({ lifecycle: "closed", closedBy: "amy" })] }),
      [machine("m1", "franks-mbp")],
    );
    expect(blocks[0].header).toBe("s1 — franks-mbp · acme/api · closed · closed by amy");
  });

  it("omits the closer segment when closedBy is null", () => {
    const blocks = sessionBlocks(record({ sessions: [session({ lifecycle: "closed" })] }), []);
    expect(blocks[0].header).toBe("s1 — m1 · acme/api · closed");
  });

  it("emits one block per session, in the record's order", () => {
    const blocks = sessionBlocks(
      record({ sessions: [session({ sessionId: "s1" }), session({ sessionId: "s2" })] }),
      [],
    );
    expect(blocks.map((b) => b.header)).toEqual([
      "s1 — m1 · acme/api · open",
      "s2 — m1 · acme/api · open",
    ]);
  });
});

describe("sessionBlocks — turn lines", () => {
  it("renders a full turn: driver, start, prompt, tools, files and approvals", () => {
    expect(
      firstTurnLine(
        turn({
          turn: 2,
          driver: "frank",
          prompt: "add the record panel",
          toolCounts: { Read: 3, Edit: 1 },
          filesChanged: ["src/a.ts", "src/b.ts"],
          approvals: [
            { kind: "permission", decision: "allow", userId: "frank", toolName: "Bash", auto: false },
          ],
        }),
      ),
    ).toBe(
      "#2 frank · 2026-07-29T10:00:00Z · add the record panel · tools: Read×3 Edit×1 · files: src/a.ts, src/b.ts · approvals: allow Bash by frank",
    );
  });

  it("falls back to system, (no prompt) and none for an empty turn", () => {
    expect(firstTurnLine(turn({ driver: null, prompt: null }))).toBe(
      "#1 system · 2026-07-29T10:00:00Z · (no prompt) · tools: none · files: none · approvals: none",
    );
  });

  it("names an approval by its kind when there is no tool, and marks auto deciders", () => {
    expect(
      firstTurnLine(
        turn({
          approvals: [
            { kind: "plan", decision: "approve", userId: "amy", toolName: null, auto: false },
            { kind: "permission", decision: "deny", userId: "amy", toolName: "Bash", auto: false },
            { kind: "permission", decision: "allow", userId: "frank", toolName: "Read", auto: true },
          ],
        }),
      ),
    ).toBe(
      "#1 frank · 2026-07-29T10:00:00Z · fix the thing · tools: none · files: none · approvals: approve plan by amy, deny Bash by amy, allow Read by frank (auto)",
    );
  });

  it("omits the errors segment when there are none and shows it when there are", () => {
    expect(firstTurnLine(turn({ errors: 0 }))).not.toContain("errors");
    expect(firstTurnLine(turn({ errors: 2 }))).toBe(
      "#1 frank · 2026-07-29T10:00:00Z · fix the thing · tools: none · files: none · approvals: none · errors: 2",
    );
  });

  it("marks an open turn IN PROGRESS, after the errors segment", () => {
    expect(firstTurnLine(turn({ inProgress: true, errors: 1 }))).toBe(
      "#1 frank · 2026-07-29T10:00:00Z · fix the thing · tools: none · files: none · approvals: none · errors: 1 · IN PROGRESS",
    );
    expect(firstTurnLine(turn({ inProgress: true }))).toBe(
      "#1 frank · 2026-07-29T10:00:00Z · fix the thing · tools: none · files: none · approvals: none · IN PROGRESS",
    );
  });

  it("says (no time) for a turn the record could not date", () => {
    // `startTs` is null when no event in the turn carried a `ts` (see
    // `record.ts`). Interpolating that would print the word "null" at the one
    // spot a reader scans for a timestamp.
    expect(firstTurnLine(turn({ startTs: null }))).toBe(
      "#1 frank · (no time) · fix the thing · tools: none · files: none · approvals: none",
    );
  });

  it("renders every turn of a session, in order", () => {
    const blocks = sessionBlocks(
      record({ sessions: [session({ turns: [turn({ turn: 1 }), turn({ turn: 2, driver: null })] })] }),
      [],
    );
    expect(blocks[0].turnLines).toEqual([
      "#1 frank · 2026-07-29T10:00:00Z · fix the thing · tools: none · files: none · approvals: none",
      "#2 system · 2026-07-29T10:00:00Z · fix the thing · tools: none · files: none · approvals: none",
    ]);
  });
});

describe("purity", () => {
  it("returns deep-equal output for the same inputs and mutates neither", () => {
    const input = record({
      sessions: [
        session({
          turns: [
            turn({
              toolCounts: { Read: 1 },
              filesChanged: ["src/a.ts"],
              approvals: [
                { kind: "permission", decision: "allow", userId: "frank", toolName: "Read", auto: false },
              ],
              errors: 1,
            }),
          ],
        }),
      ],
      rollup: { perUser: [rollup({ turnsDriven: 1 })], totalTurns: 1, totalSessions: 1 },
    });
    const machines = [machine("m1", "franks-mbp")];
    const before = structuredClone({ input, machines });

    expect(rollupLines(input)).toEqual(rollupLines(input));
    expect(sessionBlocks(input, machines)).toEqual(sessionBlocks(input, machines));
    expect({ input, machines }).toEqual(before);
  });

  it("imports no React — the module is a pure view-model", () => {
    expect(source).not.toMatch(/from\s+["']react/);
    expect(source).not.toMatch(/\bJSX\b|<\/|\/>/);
  });
});
