import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectPicker, ProjectRows, normalizePairCode, approvePairing, pairMessage } from "./ProjectPicker";
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

const pickerText = (signedInAs: string | null = null): string[] =>
  textLines(
    renderToStaticMarkup(
      <ProjectPicker userId="frank" name="Frank" signedInAs={signedInAs} theme="arcade" onThemeToggle={() => {}} />,
    ),
  );

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

const rowsText = (projects: ProjectSummary[], userId = "frank", includeArchived = false): string =>
  textLines(
    renderToStaticMarkup(
      <ProjectRows
        projects={projects}
        userId={userId}
        includeArchived={includeArchived}
        onToggleArchived={() => {}}
      />,
    ),
  ).join("\n");

const rowsMarkup = (projects: ProjectSummary[], includeArchived = false): string =>
  renderToStaticMarkup(
    <ProjectRows
      projects={projects}
      userId="frank"
      includeArchived={includeArchived}
      onToggleArchived={() => {}}
    />,
  );

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

describe("ProjectRows — SHOW ARCHIVED toggle (spec §4.1)", () => {
  const archived = project({ id: "old", name: "Museum", lifecycle: "archived", members: ["frank"] });
  const live = project({ id: "live", name: "Alpha", members: ["frank"] });

  it("hides archived projects by default — the toggle's OFF arm is the entrance as it was", () => {
    const text = rowsText([archived, live]);
    expect(text).toContain("Alpha");
    expect(text).not.toContain("Museum");
  });

  it("shows them with an ARCHIVED badge when toggled on", () => {
    const markup = rowsMarkup([archived, live], true);
    expect(textLines(markup)).toContain("Museum");
    expect(markup).toContain('<span class="spstate pix sm">ARCHIVED</span>');
  });

  it("keeps ENTER live on an archived row — archived is still readable, only unworkable", () => {
    const lines = textLines(rowsMarkup([archived], true));
    expect(lines).toContain("ENTER ▸");
  });

  it("labels the toggle for the action the click performs, state carried by aria-pressed", () => {
    expect(rowsMarkup([live], false)).toContain('aria-pressed="false"');
    expect(rowsMarkup([live], true)).toContain('aria-pressed="true"');
    expect(rowsText([live], "frank", false)).toContain("SHOW ARCHIVED");
    expect(rowsText([live], "frank", true)).toContain("HIDE ARCHIVED");
  });

  it("keeps a theme-INDEPENDENT toggle label — the picker reads no theme (T14)", () => {
    // The toggle lives on the picker-rendered list, so pin it through the
    // picker's own static render under BOTH themes, like the THEME switch row.
    const labelOf = (theme: "arcade" | "clean"): string[] =>
      textLines(
        renderToStaticMarkup(
          <ProjectPicker userId="frank" name="Frank" signedInAs={null} theme={theme} onThemeToggle={() => {}} />,
        ),
      ).filter((line) => line.includes("ARCHIVED"));
    expect(labelOf("arcade")).toEqual(["SHOW ARCHIVED"]);
    expect(labelOf("arcade")).toEqual(labelOf("clean"));
  });
});

/** The pairing-approval affordance on the entrance (spec A2).
 *
 *  The normalize/POST/result core is a pure, fetch-injected function so it is
 *  testable in a project with no DOM test env — same seam as `signOut.ts`. The
 *  component's job is only to gate visibility on sign-in and render the result;
 *  the wire contract and both outcomes are proven here against the core. */

describe("normalizePairCode — matches the hub's normalizeCode (spec A2)", () => {
  it("uppercases and strips dashes so any typed form reaches the hub canonical", () => {
    expect(normalizePairCode("abcd-1234")).toBe("ABCD1234");
    expect(normalizePairCode("AbCd-1234")).toBe("ABCD1234");
    expect(normalizePairCode("ab-cd-12-34")).toBe("ABCD1234");
    expect(normalizePairCode("ABCD1234")).toBe("ABCD1234");
  });
});

/** A minimal fetch stand-in that records the one call and answers with a fixed
 *  status + body, structurally what `globalThis.fetch` returns (status + json). */
const fakeFetch = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  return { fn, calls };
};

describe("approvePairing — normalize, POST, result (spec A2)", () => {
  it("POSTs the normalized code to /pair/approve same-origin with the cookie", async () => {
    const { fn, calls } = fakeFetch(200, { machineId: "m1", name: "my-laptop" });
    await approvePairing(fn, "abcd-1234");
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe("/pair/approve");
    expect(init.method).toBe("POST");
    // same-origin: the session cookie must ride, and the URL is relative so it
    // lands on the origin the cookie was set for.
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ code: "ABCD1234" });
  });

  it("on 200 returns the paired machine name from the response", async () => {
    const { fn } = fakeFetch(200, { machineId: "m1", name: "my-laptop" });
    expect(await approvePairing(fn, "abcd-1234")).toEqual({ ok: true, name: "my-laptop" });
  });

  it("on a non-200 returns the response's error text", async () => {
    const { fn } = fakeFetch(404, { error: "unknown or expired code" });
    expect(await approvePairing(fn, "nope")).toEqual({
      ok: false,
      error: "unknown or expired code",
    });
  });

  it("surfaces the allowlist refusal text verbatim on 403", async () => {
    const { fn } = fakeFetch(403, { error: "not on the allowlist" });
    expect(await approvePairing(fn, "abcd1234")).toEqual({
      ok: false,
      error: "not on the allowlist",
    });
  });

  it("degrades to a generic message when a failure carries no error text", async () => {
    const { fn } = fakeFetch(500, null);
    const result = await approvePairing(fn, "abcd1234");
    expect(result.ok).toBe(false);
  });

  it("returns an inline error result when the fetch rejects (offline), never throwing", async () => {
    // An offline browser rejects the fetch. Without a try/catch that rejection
    // propagates out of the component's approve handler as an unhandled
    // rejection and the pairing panel silently sticks with no feedback. The
    // core must instead resolve to a rendered inline error.
    const rejecting = (async () => {
      throw new Error("Failed to fetch");
    }) as unknown as Parameters<typeof approvePairing>[0];
    const result = await approvePairing(rejecting, "abcd1234");
    expect(result).toEqual({ ok: false, error: "could not reach the hub" });
  });
});

describe("pairMessage — what the entrance shows for a result (spec A2)", () => {
  it("shows `paired: <name>` on success", () => {
    expect(pairMessage({ ok: true, name: "my-laptop" })).toBe("paired: my-laptop");
  });

  it("shows the error text inline on failure", () => {
    expect(pairMessage({ ok: false, error: "unknown or expired code" })).toBe(
      "unknown or expired code",
    );
  });
});

describe("ProjectPicker — theme toggle on the entrance (parity)", () => {
  it("carries the same theme switch the session header does, in the screen head", () => {
    expect(pickerText()).toContain("◐ THEME");
  });

  it("keeps a theme-INDEPENDENT label — the current theme rides the title, so the executed control set is identical across themes (T14)", () => {
    const labelOf = (theme: "arcade" | "clean"): string[] =>
      textLines(
        renderToStaticMarkup(
          <ProjectPicker userId="frank" name="Frank" signedInAs={null} theme={theme} onThemeToggle={() => {}} />,
        ),
      ).filter((line) => line.includes("THEME"));
    expect(labelOf("arcade")).toEqual(labelOf("clean"));
  });
});

describe("ProjectPicker — pairing input visibility is signed-in-only (spec A2)", () => {
  it("shows the pair-a-machine affordance to a signed-in user", () => {
    const text = pickerText("frank");
    expect(text).toContain("PAIR A MACHINE");
  });

  it("never shows it to an anonymous / auth-off user (signedInAs null)", () => {
    const text = pickerText(null);
    expect(text).not.toContain("PAIR A MACHINE");
  });

  it("still renders the rest of the entrance for the signed-in user", () => {
    // Not vacuous: the pairing panel is one block of a screen that really rendered.
    const text = pickerText("frank");
    expect(text).toContain("PROJECTS");
    expect(text).toContain("NEW PROJECT");
  });
});
