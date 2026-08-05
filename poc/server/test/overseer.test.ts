import { describe, it, expect, vi } from "vitest";
import { Overseer, oversightToolText, type OversightInput } from "../src/overseer.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeOverseer(opts?: {
  summarize?: (input: OversightInput) => Promise<string>;
  debounceMs?: number;
}) {
  const calls: OversightInput[] = [];
  const updates: string[] = [];
  const summarize =
    opts?.summarize ??
    (async (input: OversightInput) => {
      calls.push(input);
      return `summary ${calls.length}`;
    });
  const overseer = new Overseer(
    async (input) => {
      if (opts?.summarize) calls.push(input);
      return summarize(input);
    },
    () => [],
    (projectId) => updates.push(projectId),
    opts?.debounceMs ?? 20,
  );
  return { overseer, calls, updates };
}

describe("Overseer", () => {
  it("defaults to disabled with no summary", () => {
    const { overseer } = makeOverseer();
    expect(overseer.isEnabled("p1")).toBe(false);
    expect(overseer.latest("p1")).toBe(null);
  });

  it("notify while disabled never summarizes", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.notify("p1");
    await wait(60);
    expect(calls).toHaveLength(0);
  });

  it("enabling triggers an immediate refresh and broadcasts", async () => {
    const { overseer, calls, updates } = makeOverseer();
    overseer.setEnabled("p1", true);
    await wait(20);
    expect(calls).toHaveLength(1);
    expect(overseer.latest("p1")).toMatchObject({ text: "summary 1", seq: 1 });
    // one push for the toggle itself, one for the summary landing
    expect(updates).toEqual(["p1", "p1"]);
  });

  it("a burst of notifies collapses into one debounced refresh", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.setEnabled("p1", true);
    await wait(20); // initial refresh done (1 call)
    overseer.notify("p1");
    overseer.notify("p1");
    overseer.notify("p1");
    await wait(60);
    expect(calls).toHaveLength(2);
    expect(overseer.latest("p1")?.seq).toBe(2);
  });

  it("notifies during an in-flight refresh coalesce into one follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const { overseer, calls } = makeOverseer({
      summarize: async () => {
        n++;
        if (n === 1) await gate;
        return `summary ${n}`;
      },
      debounceMs: 10,
    });
    overseer.setEnabled("p1", true); // starts refresh 1, held open
    await wait(5);
    overseer.notify("p1");
    overseer.notify("p1");
    release();
    await wait(60);
    expect(calls).toHaveLength(2); // held refresh + exactly one follow-up
  });

  it("a failing summarize keeps the previous summary and recovers on next activity", async () => {
    let fail = false;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { overseer } = makeOverseer({
      summarize: async () => {
        if (fail) throw new Error("model down");
        return "good";
      },
      debounceMs: 10,
    });
    overseer.setEnabled("p1", true);
    await wait(20);
    expect(overseer.latest("p1")?.text).toBe("good");
    fail = true;
    overseer.notify("p1");
    await wait(40);
    expect(overseer.latest("p1")?.text).toBe("good");
    expect(overseer.latest("p1")?.seq).toBe(1);
    fail = false;
    overseer.notify("p1");
    await wait(40);
    expect(overseer.latest("p1")?.seq).toBe(2);
    errSpy.mockRestore();
  });

  it("disabling mid-flight drops the in-flight result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { overseer } = makeOverseer({
      summarize: async () => {
        await gate;
        return "late";
      },
      debounceMs: 10,
    });
    overseer.setEnabled("p1", true);
    await wait(5);
    overseer.setEnabled("p1", false);
    release();
    await wait(20);
    expect(overseer.latest("p1")).toBe(null);
  });

  it("passes the previous summary and project id to the summarizer", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.setEnabled("p1", true);
    await wait(20);
    overseer.notify("p1");
    await wait(60);
    expect(calls[0]).toMatchObject({ projectId: "p1", previousSummary: null });
    expect(calls[1]).toMatchObject({ projectId: "p1", previousSummary: "summary 1" });
  });

  it("dispose prevents post-disposal timer re-arm and update broadcasts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { overseer, calls, updates } = makeOverseer({
      summarize: async () => {
        await gate;
        return "late";
      },
      debounceMs: 10,
    });
    overseer.setEnabled("p1", true); // starts refresh 1, held open
    await wait(5);
    overseer.notify("p1"); // sets pending during in-flight
    overseer.dispose(); // dispose while in-flight + pending
    release();
    await wait(60);
    expect(calls).toHaveLength(1); // no post-dispose follow-up
    expect(overseer.latest("p1")).toBe(null); // late result dropped
  });
});

describe("Overseer.seed", () => {
  it("installs persisted state silently — no onUpdate, no refresh scheduled", async () => {
    const { overseer, calls, updates } = makeOverseer();
    const S = { text: "restored summary", ts: "2026-08-04T00:00:00.000Z", seq: 4 };
    overseer.seed("p1", { enabled: true, latest: S });
    expect(overseer.isEnabled("p1")).toBe(true);
    expect(overseer.latest("p1")).toBe(S);
    // Seeding is a load from the durable store, not a change: it must not
    // broadcast the toggle nor kick off a summarize call.
    expect(updates).toEqual([]);
    await wait(60);
    expect(calls).toHaveLength(0);
    expect(updates).toEqual([]);
  });

  it("seeds a disabled/empty state with seq 0", () => {
    const { overseer } = makeOverseer();
    overseer.seed("p1", { enabled: false, latest: null });
    expect(overseer.isEnabled("p1")).toBe(false);
    expect(overseer.latest("p1")).toBe(null);
  });

  it("seeded state is live — a later notify runs a debounced refresh continuing the seq", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.seed("p1", {
      enabled: true,
      latest: { text: "restored", ts: "2026-08-04T00:00:00.000Z", seq: 5 },
    });
    overseer.notify("p1");
    await wait(60);
    // The seeded state is not inert: activity summarizes, and seq is restored
    // from the seeded latest (5) so the next summary is 6, never a reset to 1.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ projectId: "p1", previousSummary: "restored" });
    expect(overseer.latest("p1")?.seq).toBe(6);
  });

  it("a notify against a seeded-disabled project never summarizes", async () => {
    const { overseer, calls } = makeOverseer();
    overseer.seed("p1", { enabled: false, latest: null });
    overseer.notify("p1");
    await wait(60);
    expect(calls).toHaveLength(0);
  });
});

describe("oversightToolText", () => {
  it("says disabled when disabled", () => {
    expect(oversightToolText(false, null)).toBe("team oversight is disabled");
    expect(oversightToolText(false, { text: "x", ts: "t", seq: 1 })).toBe(
      "team oversight is disabled",
    );
  });

  it("says no summary yet when enabled but empty", () => {
    expect(oversightToolText(true, null)).toBe("no team summary yet");
  });

  it("returns the summary text when available", () => {
    expect(oversightToolText(true, { text: "the team is shipping", ts: "t", seq: 3 })).toBe(
      "the team is shipping",
    );
  });
});
