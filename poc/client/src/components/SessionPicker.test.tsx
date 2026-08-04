import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MEMBERSHIP_IDLE, SessionGroups, membershipStep } from "./SessionPicker";
import pickerSource from "./SessionPicker.tsx?raw";
import type { MachineInfo, ProjectSessionInfo, ProjectSummary } from "../types";

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
    // `setError` runs for every error whose code is NOT the membership refusal.
    expect(pickerSource).toMatch(/msg\.code !== "not_a_member"\)\s*setError\(msg\.message\)/);
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
