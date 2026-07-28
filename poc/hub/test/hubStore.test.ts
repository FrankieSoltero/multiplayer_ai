import { describe, expect, it } from "vitest";
import { HubStore } from "../src/hubStore.js";
import type { SessionFacts } from "multiplayer-ai-server/relayProtocol";

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  id: "auth",
  participants: ["ana"],
  driverName: "ana",
  intent: null,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: "github.com/acme/api",
  lifecycle: "open",
  ...over,
});

const ev = (seq: number, type = "user_message") =>
  ({ type, seq, ts: `2026-07-27T00:00:${String(seq).padStart(2, "0")}.000Z`, userId: "ana", text: "x" }) as any;

describe("HubStore event keying", () => {
  it("appends a new run instead of overwriting history when a laptop restarts", () => {
    // THE trap (spec §3.2): the laptop's log is in memory, so a restart resets
    // seq to 0. Keyed by seq alone the hub would silently overwrite real
    // history. Keyed by (runId, seq) it appends a second run.
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    store.publish("lap-1", "auth", "run-b", [ev(0), ev(1)]);

    const all = store.eventsFor("default", "auth", 0);
    expect(all).toHaveLength(5);
    expect(all.map((e) => e.runId)).toEqual(["run-a", "run-a", "run-a", "run-b", "run-b"]);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("ignores a replay of events it already holds for the same run", () => {
    // A reconnecting laptop that resumes from the wrong offset must not
    // duplicate the log for everyone watching.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 0)).toHaveLength(3);
  });

  it("reports resume offsets per session so a reconnect replays only the gap", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.resumeOffsets("lap-1")).toEqual({ auth: { runId: "run-a", lastSeq: 2 } });
  });

  it("serves events from an id, so a late browser gets only what it is missing", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 2).map((e) => e.id)).toEqual([3]);
  });
});

describe("HubStore presence and ownership", () => {
  it("keeps a detached laptop's sessions but flips them offline", () => {
    // The payoff of the hub: sessions survive a laptop disconnecting. What
    // must NOT survive is the illusion that they can be driven.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.setFacts("lap-1", "auth", "run-a", facts());
    expect(store.snapshot("default").sessions[0].presence).toBe("online");

    store.detach("lap-1");
    const after = store.snapshot("default").sessions[0];
    expect(after.presence).toBe("offline");
    expect(after.id).toBe("auth");
  });

  it("routes a command to the laptop that owns the session", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api");
    store.attach("lap-2", "default", "github.com/acme/web");
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    store.setFacts("lap-2", "ui", "run-b", facts({ id: "ui", repoKey: "github.com/acme/web" }));
    expect(store.ownerOf("default", "auth")).toBe("lap-1");
    expect(store.ownerOf("default", "ui")).toBe("lap-2");
    expect(store.ownerOf("default", "nope")).toBeNull();
  });

  it("refuses a second live laptop claiming a session id already owned in the project", () => {
    // Known bound, deliberately loud: two laptops can each have a session
    // called "auth". v7b1 rejects the collision rather than silently merging
    // two machines' streams into one row. Hub-scoped session ids are v7c.
    const store = new HubStore();
    store.attach("lap-1", "default", "k1");
    store.setFacts("lap-1", "auth", "run-a", facts());
    store.attach("lap-2", "default", "k2");
    expect(store.setFacts("lap-2", "auth", "run-z", facts())).toEqual({
      ok: false,
      error: 'session "auth" in project "default" is already owned by another machine',
    });
  });

  it("lets a reconnecting laptop reclaim its own session ids", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.setFacts("lap-1", "auth", "run-a", facts());
    store.detach("lap-1");
    store.attach("lap-1", "default", "k");
    expect(store.setFacts("lap-1", "auth", "run-b", facts())).toEqual({ ok: true });
  });
});

describe("HubStore snapshot assembly", () => {
  it("composes one project view across several laptops and repos", () => {
    // Only the hub sees every laptop, so only the hub can build this. It is
    // the thing four servers and four URLs could never do.
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api");
    store.attach("lap-2", "default", "github.com/acme/web");
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth", repoKey: "github.com/acme/api" }));
    store.setFacts("lap-2", "ui", "run-b", facts({ id: "ui", repoKey: "github.com/acme/web" }));

    const snap = store.snapshot("default");
    expect(snap.type).toBe("project");
    expect(snap.sessions.map((s) => s.id).sort()).toEqual(["auth", "ui"]);
    expect(snap.sessions.map((s) => s.repoKey).sort()).toEqual([
      "github.com/acme/api",
      "github.com/acme/web",
    ]);
  });

  it("aggregates arcade records across every attached laptop", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.attach("lap-2", "default", "k2");
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    store.setFacts("lap-2", "ui", "run-b", facts({ id: "ui" }));
    store.publish("lap-1", "auth", "run-a", [
      { type: "presence_join", userId: "ana", name: "ana", seq: 0, ts: "2026-07-27T00:00:00.000Z" } as any,
      { type: "game_score", userId: "ana", game: "tetris", score: 90, seq: 1, ts: "2026-07-27T00:00:01.000Z" } as any,
    ]);
    store.publish("lap-2", "ui", "run-b", [
      { type: "presence_join", userId: "ben", name: "ben", seq: 0, ts: "2026-07-27T00:00:02.000Z" } as any,
      { type: "game_score", userId: "ben", game: "tetris", score: 400, seq: 1, ts: "2026-07-27T00:00:03.000Z" } as any,
    ]);
    expect(store.snapshot("default").arcade).toEqual([
      { game: "tetris", score: 400, userId: "ben", name: "ben", glyph: undefined, color: undefined },
    ]);
  });

  it("returns an empty but well-formed snapshot for an unknown project", () => {
    const store = new HubStore();
    expect(store.snapshot("nobody")).toEqual({
      type: "project",
      sessions: [],
      arcade: [],
      plugins: [],
      pluginsEnabled: false,
      repo: null,
      oversight: { enabled: false, latest: null },
    });
  });
});
