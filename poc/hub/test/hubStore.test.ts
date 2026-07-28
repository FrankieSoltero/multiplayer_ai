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
    store.attach("lap-1", "default", "github.com/acme/api", "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 0)).toHaveLength(3);
  });

  it("reports resume offsets per session so a reconnect replays only the gap", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.resumeOffsets("lap-1")).toEqual({ auth: { runId: "run-a", lastSeq: 2 } });
  });

  it("serves events from an id, so a late browser gets only what it is missing", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 2).map((e) => e.id)).toEqual([3]);
  });

  it("survives malformed event elements in a publish batch instead of crashing", () => {
    // parseUpFrame validates `events` is an array but not each element's
    // shape (Task 1 ruling), so a frame can legally carry null/string/number
    // elements — or an object whose `seq` is out of range. publish() must
    // degrade them all to "skipped", not throw and not store them.
    const store = new HubStore();
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    let accepted: unknown;
    expect(() => {
      accepted = store.publish("lap-1", "auth", "run-a", [
        ev(0),
        null as any,
        "not an event" as any,
        42 as any,
        { ...ev(0), seq: 9e99 } as any, // legal JSON; Number.isInteger(9e99) is true
        { ...ev(0), seq: -3 } as any,
        { ...ev(0), seq: 1.5 } as any,
        { ...ev(0), seq: "7" } as any,
        ev(1),
      ]);
    }).not.toThrow();
    expect((accepted as { event: { seq: number } }[]).map((e) => e.event.seq)).toEqual([0, 1]);
    expect(store.eventsFor("default", "auth", 0).map((e) => e.event.seq)).toEqual([0, 1]);
  });

  it("does not let one out-of-range seq freeze a session's history for the life of the hub", () => {
    // `seq` becomes `session.lastSeq`, the high-water mark every later event is
    // compared against AND the offset `resumeOffsets` hands back in `welcome`.
    // Accept `9e99` once and every subsequent event fails `seq <= lastSeq`
    // forever, while the resume protocol confirms the corruption rather than
    // repairing it: the laptop replays from 9e99, which is an empty slice.
    // Only a hub restart clears it.
    const store = new HubStore();
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [ev(0), { ...ev(1), seq: 9e99 } as any]);
    store.publish("lap-1", "auth", "run-a", [ev(1), ev(2)]);

    expect(store.eventsFor("default", "auth", 0).map((e) => e.event.seq)).toEqual([0, 1, 2]);
    expect(store.resumeOffsets("lap-1")).toEqual({ auth: { runId: "run-a", lastSeq: 2 } });
  });
});

describe("HubStore presence and ownership", () => {
  it("keeps a detached laptop's sessions but flips them offline", () => {
    // The payoff of the hub: sessions survive a laptop disconnecting. What
    // must NOT survive is the illusion that they can be driven.
    const store = new HubStore();
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.setFacts("lap-1", "auth", "run-a", facts());
    expect(store.snapshot("default").sessions[0].presence).toBe("online");

    store.detach("lap-1");
    const after = store.snapshot("default").sessions[0];
    expect(after.presence).toBe("offline");
    expect(after.id).toBe("auth");
  });

  it("routes a command to the laptop that owns the session", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api", "2026-07-28T10:00:00.000Z");
    store.attach("lap-2", "default", "github.com/acme/web", "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "k1", "2026-07-28T10:00:00.000Z");
    store.setFacts("lap-1", "auth", "run-a", facts());
    store.attach("lap-2", "default", "k2", "2026-07-28T10:00:00.000Z");
    expect(store.setFacts("lap-2", "auth", "run-z", facts())).toEqual({
      ok: false,
      error: 'session "auth" in project "default" is already owned by another machine',
    });
  });

  it("lets a reconnecting laptop reclaim its own session ids", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.setFacts("lap-1", "auth", "run-a", facts());
    store.detach("lap-1");
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    expect(store.setFacts("lap-1", "auth", "run-b", facts())).toEqual({ ok: true });
  });
});

describe("HubStore snapshot assembly", () => {
  it("composes one project view across several laptops and repos", () => {
    // Only the hub sees every laptop, so only the hub can build this. It is
    // the thing four servers and four URLs could never do.
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api", "2026-07-28T10:00:00.000Z");
    store.attach("lap-2", "default", "github.com/acme/web", "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.attach("lap-2", "default", "k2", "2026-07-28T10:00:00.000Z");
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
      machines: [],
      arcade: [],
      plugins: [],
      pluginsEnabled: false,
      repo: null,
      oversight: { enabled: false, latest: null },
    });
  });

  it("does not create a project just because something read one", () => {
    // A browser names the projectId in `peek`, `watch_project` and `join`, and
    // the hub reads the store on all three. A creating read is therefore
    // unbounded growth from unauthenticated input that no socket close ever
    // reclaims. It is also what keeps `peek` parity with the standalone
    // server, which reads with `projects.get` and never creates.
    const store = new HubStore();
    expect(store.ownerOf("ghost", "auth")).toBeNull();
    expect(store.eventsFor("ghost", "auth", 0)).toEqual([]);
    expect(store.snapshot("ghost").sessions).toEqual([]);
    expect(store.resumeOffsets("nobody")).toEqual({});
    // Reaching into the private map is the point: "did not grow" has no other
    // observable form, and the leak is invisible until the hub is out of RAM.
    expect((store as unknown as { projects: Map<string, unknown> }).projects.size).toBe(0);
  });

  it("deep-copies session facts so mutating a returned snapshot cannot reach stored state", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k", "2026-07-28T10:00:00.000Z");
    store.setFacts(
      "lap-1",
      "auth",
      "run-a",
      facts({
        participants: ["ana"],
        skills: [{ name: "deploy", description: "ship it" }],
        pendingGate: { toolName: "bash", sinceTs: "2026-07-27T00:00:00.000Z" },
      }),
    );

    const snap = store.snapshot("default");
    snap.sessions[0].participants.push("mallory");
    snap.sessions[0].skills[0].name = "tampered";
    (snap.sessions[0].pendingGate as { toolName: string }).toolName = "tampered";

    const again = store.snapshot("default");
    expect(again.sessions[0].participants).toEqual(["ana"]);
    expect(again.sessions[0].skills).toEqual([{ name: "deploy", description: "ship it" }]);
    expect(again.sessions[0].pendingGate).toEqual({
      toolName: "bash",
      sinceTs: "2026-07-27T00:00:00.000Z",
    });
  });
});

describe("HubStore project registry", () => {
  const T = "2026-07-28T10:00:00.000Z";

  it("creates a project with a name and its creator as the first member", () => {
    const store = new HubStore();
    expect(store.createProject("acme", "Acme Migration", "ana", T)).toEqual({ ok: true });
    expect(store.isMember("acme", "ana")).toBe(true);
    expect(store.lifecycleOf("acme")).toBe("active");
  });

  it("refuses to create a project that already exists", () => {
    const store = new HubStore();
    store.createProject("acme", "Acme Migration", "ana", T);
    const again = store.createProject("acme", "Someone Else's", "bo", T);
    expect(again.ok).toBe(false);
  });

  it("auto-creates a project when a machine attaches to one nobody named", () => {
    // The launch-time seam (spec §9): `mpai --hub <url> --project acme` may
    // name a project that does not exist yet. It must appear, not vanish.
    const store = new HubStore();
    store.attach("lap-1", "acme", "github.com/acme/api", "2026-07-28T10:00:00.000Z");
    expect(store.lifecycleOf("acme")).toBe("active");
    // Auto-created, so nobody is a member and the display name is the slug.
    expect(store.isMember("acme", "ana")).toBe(false);
  });

  it("does not overwrite an existing project's record when a machine re-attaches", () => {
    // ensureProject must not touch a record that already exists — attaching a
    // laptop is not a person creating or rejoining a project. `isMember`
    // alone can't prove this: "ana" already left, so it reads `false` under
    // both a correct guard and a buggy unconditional overwrite. Lifecycle is
    // the state a fresh auto-created record would NOT carry (it is always
    // "active"), so setting it to a non-default value before the re-attach
    // and asserting it survives is what actually discriminates "left alone"
    // from "silently replaced".
    const store = new HubStore();
    store.createProject("acme", "Acme Migration", "ana", T);
    store.leaveProject("acme", "ana");
    store.setLifecycle("acme", "closed");
    store.attach("lap-1", "acme", "k", "2026-07-28T10:00:00.000Z");
    expect(store.lifecycleOf("acme")).toBe("closed");
    expect(store.isMember("acme", "ana")).toBe(false);
  });

  it("joins and leaves membership idempotently", () => {
    const store = new HubStore();
    store.createProject("acme", "Acme", "ana", T);
    expect(store.joinProject("acme", "bo")).toBe(true);
    expect(store.joinProject("acme", "bo")).toBe(false);
    expect(store.isMember("acme", "bo")).toBe(true);
    expect(store.leaveProject("acme", "bo")).toBe(true);
    expect(store.leaveProject("acme", "bo")).toBe(false);
    expect(store.isMember("acme", "bo")).toBe(false);
  });

  it("refuses membership and lifecycle changes on a project that does not exist", () => {
    const store = new HubStore();
    expect(store.joinProject("nope", "ana")).toBe(false);
    expect(store.lifecycleOf("nope")).toBe(null);
    expect(store.setLifecycle("nope", "closed").ok).toBe(false);
  });

  it("moves through the lifecycle and back", () => {
    const store = new HubStore();
    store.createProject("acme", "Acme", "ana", T);
    expect(store.setLifecycle("acme", "closed")).toEqual({ ok: true });
    expect(store.lifecycleOf("acme")).toBe("closed");
    expect(store.setLifecycle("acme", "active")).toEqual({ ok: true });
    expect(store.lifecycleOf("acme")).toBe("active");
  });
});

describe("HubStore project listing", () => {
  const T = "2026-07-28T10:00:00.000Z";

  it("summarizes a project with its sessions and machines", () => {
    const store = new HubStore();
    store.createProject("acme", "Acme Migration", "ana", T);
    store.attach("lap-1", "acme", "github.com/acme/api", T);
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    store.setFacts("lap-1", "billing", "run-a", facts({ id: "billing", lifecycle: "closed" }));

    const [summary] = store.listProjects();
    expect(summary.id).toBe("acme");
    expect(summary.name).toBe("Acme Migration");
    expect(summary.members).toEqual(["ana"]);
    expect(summary.sessionCount).toBe(2);
    expect(summary.liveSessionCount).toBe(1);
    expect(summary.machines).toEqual([
      { machineId: "lap-1", repoKey: "github.com/acme/api", online: true },
    ]);
  });

  it("lists a project that has no sessions at all", () => {
    // The launch-time seam: a project created in the UI is empty until
    // somebody points a machine at it. It must still be visible.
    const store = new HubStore();
    store.createProject("acme", "Acme", "ana", T);
    const [summary] = store.listProjects();
    expect(summary.sessionCount).toBe(0);
    expect(summary.machines).toEqual([]);
  });

  it("reports a machine as offline once it detaches, without dropping it", () => {
    const store = new HubStore();
    store.createProject("acme", "Acme", "ana", T);
    store.attach("lap-1", "acme", "github.com/acme/api", T);
    store.detach("lap-1");
    expect(store.machinesIn("acme")).toEqual([
      { machineId: "lap-1", repoKey: "github.com/acme/api", online: false },
    ]);
  });

  it("keeps machines scoped to their own project", () => {
    const store = new HubStore();
    store.createProject("acme", "Acme", "ana", T);
    store.createProject("other", "Other", "bo", T);
    store.attach("lap-1", "acme", "github.com/acme/api", T);
    expect(store.machinesIn("other")).toEqual([]);
  });

  it("returns an empty machine list for a project that does not exist", () => {
    expect(new HubStore().machinesIn("nope")).toEqual([]);
  });
});

describe("HubStore snapshot machines", () => {
  const T = "2026-07-28T10:00:00.000Z";

  it("reports which machines are present and which runs each session", () => {
    const store = new HubStore();
    store.attach("lap-1", "acme", "github.com/acme/api", T);
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    const snap = store.snapshot("acme") as any;
    expect(snap.machines).toEqual([
      { machineId: "lap-1", repoKey: "github.com/acme/api", online: true },
    ]);
    expect(snap.sessions[0].machineId).toBe("lap-1");
  });

  it("keeps repo null — a hub spans repos and has no single one", () => {
    const store = new HubStore();
    store.attach("lap-1", "acme", "github.com/acme/api", T);
    expect(store.snapshot("acme").repo).toBe(null);
  });
});
