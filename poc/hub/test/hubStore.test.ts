import { describe, expect, it } from "vitest";
import { HubStore, type HubPersister } from "../src/hubStore.js";
import type { RepoDecl, SessionFacts } from "multiplayer-ai-server/relayProtocol";

/** One entry of a machine's declared repo set. `label` defaults to the key's
 *  last segment, which is what the launch-time scan produces. */
const decl = (key: string, over: Partial<RepoDecl> = {}): RepoDecl => ({
  key,
  label: key.split("/").pop() ?? key,
  attached: true,
  defaultBranch: "origin/main",
  ...over,
});

const T0 = "2026-07-28T10:00:00.000Z";

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
    store.attach("lap-1", "default", "lap-1", [decl("github.com/acme/api")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 0)).toHaveLength(3);
  });

  it("reports resume offsets per session so a reconnect replays only the gap", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.resumeOffsets("lap-1")).toEqual({ auth: { runId: "run-a", lastSeq: 2 } });
  });

  it("serves events from an id, so a late browser gets only what it is missing", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(store.eventsFor("default", "auth", 2).map((e) => e.id)).toEqual([3]);
  });

  it("survives malformed event elements in a publish batch instead of crashing", () => {
    // parseUpFrame validates `events` is an array but not each element's
    // shape (Task 1 ruling), so a frame can legally carry null/string/number
    // elements — or an object whose `seq` is out of range. publish() must
    // degrade them all to "skipped", not throw and not store them.
    const store = new HubStore();
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
    store.setFacts("lap-1", "auth", "run-a", facts());
    expect(store.snapshot("default").sessions[0].presence).toBe("online");

    store.detach("lap-1");
    const after = store.snapshot("default").sessions[0];
    expect(after.presence).toBe("offline");
    expect(after.id).toBe("auth");
  });

  it("routes a command to the laptop that owns the session", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "lap-1", [decl("github.com/acme/api")], "2026-07-28T10:00:00.000Z");
    store.attach("lap-2", "default", "lap-2", [decl("github.com/acme/web")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "lap-1", [decl("k1")], "2026-07-28T10:00:00.000Z");
    store.setFacts("lap-1", "auth", "run-a", facts());
    store.attach("lap-2", "default", "lap-2", [decl("k2")], "2026-07-28T10:00:00.000Z");
    expect(store.setFacts("lap-2", "auth", "run-z", facts())).toEqual({
      ok: false,
      error: 'session "auth" in project "default" is already owned by another machine',
    });
  });

  it("lets a machine that restarted under its persisted machineId reclaim its own sessions (debt §2.3)", () => {
    // debt §2.3, dissolved by this task's `server.ts` Relay construction: the
    // relay used to mint a fresh `randomUUID()` per launch, so a restarted
    // laptop arrived as a STRANGER — every session it had owned stayed bound
    // to a dead uplink, read `offline` forever, and re-creating one by name
    // hit `already owned by another machine`. With the persisted `machineId`
    // as the uplink id, the restart re-attaches under the SAME id and the
    // store's takeover rule (`existing.uplinkId !== uplinkId`) lets it
    // straight back in — including when the repo set it re-declares has moved
    // on in the meantime, which is the ordinary case after an attach.
    const store = new HubStore();
    store.attach("m1", "acme", "Ana's MacBook", [decl("github.com/acme/api")], T0);
    expect(store.setFacts("m1", "auth", "run-a", facts())).toEqual({ ok: true });
    store.detach("m1");

    store.attach(
      "m1",
      "acme",
      "Ana's MacBook",
      [decl("github.com/acme/api"), decl("github.com/acme/web")],
      T0,
    );
    expect(store.setFacts("m1", "auth", "run-b", facts())).toEqual({ ok: true });
    const [machine] = store.machinesIn("acme");
    expect(machine.online).toBe(true);
    expect(machine.repos.map((r) => r.key)).toEqual([
      "github.com/acme/api",
      "github.com/acme/web",
    ]);
  });
});

describe("HubStore machine records", () => {
  it("stores the name and the whole repo list a machine declared", () => {
    const store = new HubStore();
    store.attach(
      "lap-1",
      "acme",
      "Ana's MacBook",
      [decl("github.com/acme/api"), decl("github.com/acme/web", { attached: false, defaultBranch: null })],
      T0,
    );
    expect(store.machinesIn("acme")).toEqual([
      {
        machineId: "lap-1",
        name: "Ana's MacBook",
        online: true,
        repos: [
          { key: "github.com/acme/api", label: "api", attached: true, defaultBranch: "origin/main" },
          { key: "github.com/acme/web", label: "web", attached: false, defaultBranch: null },
        ],
      },
    ]);
  });

  it("REPLACES the repo list on setRepos rather than merging into it", () => {
    // A `repos` frame is always the machine's full authoritative list (spec
    // §5.2). Merging would resurrect a repo the machine just dropped, leaving
    // the hub offering — and routing create_session to — a repo that is no
    // longer there; the machine would refuse and the browser would see a
    // failure it has no way to explain.
    const store = new HubStore();
    store.attach("lap-1", "acme", "lap", [decl("github.com/acme/api"), decl("github.com/acme/web")], T0);
    store.setRepos("lap-1", [decl("github.com/acme/api", { attached: false, defaultBranch: null })]);
    expect(store.machinesIn("acme")[0].repos).toEqual([
      { key: "github.com/acme/api", label: "api", attached: false, defaultBranch: null },
    ]);
  });

  it("ignores a repos frame for an uplink it has never seen", () => {
    const store = new HubStore();
    expect(() => store.setRepos("ghost", [decl("k")])).not.toThrow();
    expect(store.machinesIn("acme")).toEqual([]);
  });
});

describe("HubStore snapshot assembly", () => {
  it("composes one project view across several laptops and repos", () => {
    // Only the hub sees every laptop, so only the hub can build this. It is
    // the thing four servers and four URLs could never do.
    const store = new HubStore();
    store.attach("lap-1", "default", "lap-1", [decl("github.com/acme/api")], "2026-07-28T10:00:00.000Z");
    store.attach("lap-2", "default", "lap-2", [decl("github.com/acme/web")], "2026-07-28T10:00:00.000Z");
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

  it("synthesizes a null repoKey for a session that published before it declared facts", () => {
    // The hub does not know which repo a session lives in until the owning
    // laptop says so in a `facts` frame (spec §7). A machine now offers
    // SEVERAL repos, so the old stand-in — the uplink's single scalar repoKey
    // — has no successor that could be honest: naming the first one would put
    // a confident, wrong repo on the project screen for the whole window
    // before facts land. Null says "not known yet", which is the truth.
    const store = new HubStore();
    store.attach("lap-1", "acme", "lap", [decl("github.com/acme/api"), decl("github.com/acme/web")], T0);
    store.publish("lap-1", "auth", "run-a", [ev(0)]);
    expect(store.snapshot("acme").sessions[0].repoKey).toBeNull();
  });

  it("aggregates arcade records across every attached laptop", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
    store.attach("lap-2", "default", "lap-2", [decl("k2")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "default", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "acme", "lap-1", [decl("github.com/acme/api")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "acme", "lap-1", [decl("k")], "2026-07-28T10:00:00.000Z");
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
    store.attach("lap-1", "acme", "lap-1", [decl("github.com/acme/api")], T);
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    store.setFacts("lap-1", "billing", "run-a", facts({ id: "billing", lifecycle: "closed" }));

    const [summary] = store.listProjects();
    expect(summary.id).toBe("acme");
    expect(summary.name).toBe("Acme Migration");
    expect(summary.members).toEqual(["ana"]);
    expect(summary.sessionCount).toBe(2);
    expect(summary.liveSessionCount).toBe(1);
    expect(summary.machines).toEqual([
      { machineId: "lap-1", name: "lap-1", repos: [decl("github.com/acme/api")], online: true },
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
    store.attach("lap-1", "acme", "lap-1", [decl("github.com/acme/api")], T);
    store.detach("lap-1");
    expect(store.machinesIn("acme")).toEqual([
      { machineId: "lap-1", name: "lap-1", repos: [decl("github.com/acme/api")], online: false },
    ]);
  });

  it("keeps machines scoped to their own project", () => {
    const store = new HubStore();
    store.createProject("acme", "Acme", "ana", T);
    store.createProject("other", "Other", "bo", T);
    store.attach("lap-1", "acme", "lap-1", [decl("github.com/acme/api")], T);
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
    store.attach(
      "lap-1",
      "acme",
      "Ana's MacBook",
      [decl("github.com/acme/api"), decl("github.com/acme/web", { attached: false, defaultBranch: null })],
      T,
    );
    store.setFacts("lap-1", "auth", "run-a", facts({ id: "auth" }));
    const snap = store.snapshot("acme");
    // Straight from the store's own machine records — the name and the list
    // the machine declared in hello v2, candidates included. No synthesis:
    // Task 4's stand-in (name = machineId, one invented RepoDecl) is gone.
    expect(snap.machines).toEqual([
      {
        machineId: "lap-1",
        name: "Ana's MacBook",
        repos: [
          { key: "github.com/acme/api", label: "api", attached: true, defaultBranch: "origin/main" },
          { key: "github.com/acme/web", label: "web", attached: false, defaultBranch: null },
        ],
        online: true,
      },
    ]);
    expect(snap.sessions[0].machineId).toBe("lap-1");
  });

  it("has no top-level repo property — a hub spans repos and has no single one (D10)", () => {
    const store = new HubStore();
    store.attach("lap-1", "acme", "lap-1", [decl("github.com/acme/api")], T);
    const snap = store.snapshot("acme");
    expect(snap).not.toHaveProperty("repo");
    expect(snap.machines?.[0].name).toBe("lap-1");
    expect(snap.machines?.[0].repos[0].key).toBe("github.com/acme/api");
  });
});

/** A `HubPersister` that records every call in order, so a test can assert
 *  WHICH calls a mutation made, in what order, and what each carried — the
 *  only observable form of "one transaction per frame".
 *
 *  `state.throwOn` makes one method refuse, which is how the durability
 *  invariant is tested: a real persister's refusal is a failed commit, and the
 *  store must then behave as if the frame never happened. */
function recorder() {
  const calls: { m: string; args: unknown[] }[] = [];
  const state: { throwOn: string | null } = { throwOn: null };
  const rec =
    (m: string) =>
    (...args: unknown[]): void => {
      calls.push({ m, args });
      if (state.throwOn === m) throw new Error(`persister refused ${m}`);
    };
  const persister: HubPersister = {
    projectSaved: rec("projectSaved"),
    memberAdded: rec("memberAdded"),
    memberRemoved: rec("memberRemoved"),
    machineSaved: rec("machineSaved"),
    sessionSaved: rec("sessionSaved"),
    eventsAppended: rec("eventsAppended"),
  };
  return {
    persister,
    calls,
    state,
    names: () => calls.map((c) => c.m),
    clear: () => {
      calls.length = 0;
    },
  };
}

describe("HubStore persister seam", () => {
  const T = "2026-07-28T10:00:00.000Z";
  const EMPTY_FACTS: SessionFacts = {
    id: "auth",
    participants: [],
    driverName: null,
    intent: null,
    lastActivityTs: null,
    ended: false,
    pendingGate: null,
    skills: [],
    repoKey: null,
    lifecycle: "open",
  };

  it("persists a created project and its creator, and nothing for a duplicate id", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    expect(store.createProject("acme", "Acme Migration", "ana", T)).toEqual({ ok: true });
    expect(r.calls).toEqual([
      {
        m: "projectSaved",
        args: [
          { id: "acme", name: "Acme Migration", createdBy: "ana", createdAt: T, lifecycle: "active" },
        ],
      },
      { m: "memberAdded", args: ["acme", "ana"] },
    ]);

    r.clear();
    expect(store.createProject("acme", "Someone Else's", "bo", T).ok).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("persists an auto-created project with a null creator, and nothing for one it already holds", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.ensureProject("acme", T);
    expect(r.calls).toEqual([
      {
        m: "projectSaved",
        args: [{ id: "acme", name: "acme", createdBy: null, createdAt: T, lifecycle: "active" }],
      },
    ]);
    // No memberAdded: attaching a laptop is not joining a project.
    r.clear();
    store.ensureProject("acme", "2026-07-29T10:00:00.000Z");
    expect(r.calls).toEqual([]);
  });

  it("persists the whole project record with the updated lifecycle", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.createProject("acme", "Acme", "ana", T);
    r.clear();
    expect(store.setLifecycle("acme", "closed")).toEqual({ ok: true });
    expect(r.calls).toEqual([
      {
        m: "projectSaved",
        args: [{ id: "acme", name: "Acme", createdBy: "ana", createdAt: T, lifecycle: "closed" }],
      },
    ]);

    r.clear();
    expect(store.setLifecycle("nope", "closed").ok).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("persists membership changes only when they change something", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.createProject("acme", "Acme", "ana", T);
    r.clear();

    expect(store.joinProject("acme", "bo")).toBe(true);
    expect(r.calls).toEqual([{ m: "memberAdded", args: ["acme", "bo"] }]);
    r.clear();
    expect(store.joinProject("acme", "bo")).toBe(false);
    expect(r.calls).toEqual([]);

    expect(store.leaveProject("acme", "bo")).toBe(true);
    expect(r.calls).toEqual([{ m: "memberRemoved", args: ["acme", "bo"] }]);
    r.clear();
    expect(store.leaveProject("acme", "bo")).toBe(false);
    expect(store.leaveProject("nope", "bo")).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("persists the machine on attach, and the project the attach auto-created", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "Ana's MacBook", [decl("github.com/acme/api")], T);
    // The project row first: a machine row that referenced a project no record
    // mentions would be a dangling reference on the next boot.
    expect(r.names()).toEqual(["projectSaved", "machineSaved"]);
    expect(r.calls[1].args).toEqual([
      {
        uplinkId: "lap-1",
        projectId: "acme",
        name: "Ana's MacBook",
        repos: [decl("github.com/acme/api")],
      },
    ]);

    r.clear();
    store.attach("lap-2", "acme", "Bo's ThinkPad", [decl("github.com/acme/web")], T);
    expect(r.names()).toEqual(["machineSaved"]);
  });

  it("persists the replaced repo list on setRepos, and nothing for an unknown uplink", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("github.com/acme/api"), decl("github.com/acme/web")], T);
    r.clear();

    store.setRepos("lap-1", [decl("github.com/acme/api", { attached: false, defaultBranch: null })]);
    expect(r.calls).toEqual([
      {
        m: "machineSaved",
        args: [
          {
            uplinkId: "lap-1",
            projectId: "acme",
            name: "lap-1",
            // The whole new list, not a merge — the record mirrors memory's
            // wholesale replacement (spec §5.2).
            repos: [decl("github.com/acme/api", { attached: false, defaultBranch: null })],
          },
        ],
      },
    ]);

    r.clear();
    store.setRepos("ghost", [decl("k")]);
    expect(r.calls).toEqual([]);
  });

  it("persists a facts-only session with no offsets, and nothing on an ownership refusal", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("k")], T);
    r.clear();

    expect(store.setFacts("lap-1", "auth", "run-a", facts())).toEqual({ ok: true });
    expect(r.calls).toEqual([
      {
        m: "sessionSaved",
        args: [
          {
            projectId: "acme",
            sessionId: "auth",
            uplinkId: "lap-1",
            facts: facts(),
            // `runId` is deliberately not recorded by a facts-only session:
            // the hub holds no events for it, so it may claim no offset.
            lastRunId: null,
            lastSeq: -1,
          },
        ],
      },
    ]);

    store.attach("lap-2", "acme", "lap-2", [decl("k2")], T);
    r.clear();
    expect(store.setFacts("lap-2", "auth", "run-z", facts()).ok).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("persists updated facts with the offsets the hub already holds for that session", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("k")], T);
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    r.clear();

    store.setFacts("lap-1", "auth", "run-a", facts({ intent: "ship auth" }));
    expect(r.calls).toEqual([
      {
        m: "sessionSaved",
        args: [
          {
            projectId: "acme",
            sessionId: "auth",
            uplinkId: "lap-1",
            facts: facts({ intent: "ship auth" }),
            lastRunId: "run-a",
            lastSeq: 2,
          },
        ],
      },
    ]);
  });

  it("persists exactly one eventsAppended per publish frame for a session it already holds", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("k")], T);
    store.setFacts("lap-1", "auth", "run-a", facts());
    r.clear();

    const accepted = store.publish("lap-1", "auth", "run-a", [ev(0), ev(1), ev(2)]);
    expect(r.names()).toEqual(["eventsAppended"]);
    const args = r.calls[0].args;
    // The very array the caller fans out — the record is written from the
    // store's own instances, with no copy on this path.
    expect(args.slice(0, 5)).toEqual(["acme", "auth", accepted, "run-a", 2]);
    expect(args[2]).toBe(accepted);
    // No `newSession`: the session row already exists in the record.
    expect(args[5]).toBeUndefined();
  });

  it("writes an implicitly created session and its events in ONE frame", () => {
    // A publish for a session nobody declared facts for creates it. Two calls
    // (sessionSaved then eventsAppended) would be two transactions, and a
    // crash between them leaves events attached to a session no row mentions.
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("k")], T);
    r.clear();

    const accepted = store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);
    expect(r.names()).toEqual(["eventsAppended"]);
    const args = r.calls[0].args;
    expect(args.slice(0, 5)).toEqual(["acme", "auth", accepted, "run-a", 1]);
    expect(args[5]).toEqual({ uplinkId: "lap-1", facts: EMPTY_FACTS });
    // And the facts the frame carried are the ones memory now shows.
    expect(store.snapshot("acme").sessions[0].repoKey).toBeNull();
    expect(store.ownerOf("acme", "auth")).toBe("lap-1");
  });

  it("persists nothing for a publish frame that accepted no events", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("k")], T);
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);
    r.clear();

    // A resume overshoot: history the hub already holds, so nothing to write.
    expect(store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)])).toEqual([]);
    expect(r.calls).toEqual([]);

    // An all-malformed batch for a session the hub does not hold: nothing
    // durable, therefore nothing in memory either. Memory and the record stay
    // in lockstep, so a restart cannot lose a session the hub was showing.
    expect(store.publish("lap-1", "fresh", "run-a", [null as any, { ...ev(0), seq: -1 } as any])).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(store.ownerOf("acme", "fresh")).toBeNull();

    // Same for a session owned by another machine.
    store.attach("lap-2", "acme", "lap-2", [decl("k2")], T);
    r.clear();
    expect(store.publish("lap-2", "auth", "run-z", [ev(5)])).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it("leaves memory untouched when the persister refuses a publish frame", () => {
    // Durable before visible (spec §3.3). A refused commit must not become
    // history in memory: browsers would see events a restarted hub forgot,
    // and `resumeOffsets` would tell the laptop not to re-send them.
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("k")], T);
    store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)]);
    r.clear();
    r.state.throwOn = "eventsAppended";

    expect(() => store.publish("lap-1", "auth", "run-a", [ev(2), ev(3)])).toThrow(
      /persister refused eventsAppended/,
    );
    expect(r.names()).toEqual(["eventsAppended"]);
    expect(store.eventsFor("acme", "auth", 0).map((e) => e.event.seq)).toEqual([0, 1]);
    expect(store.resumeOffsets("lap-1")).toEqual({ auth: { runId: "run-a", lastSeq: 1 } });
  });

  it("does not create the session when the frame that would have created it is refused", () => {
    const r = recorder();
    const store = new HubStore(r.persister);
    store.attach("lap-1", "acme", "lap-1", [decl("k")], T);
    r.state.throwOn = "eventsAppended";

    expect(() => store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)])).toThrow(
      /persister refused eventsAppended/,
    );
    expect(store.ownerOf("acme", "auth")).toBeNull();
    expect(store.snapshot("acme").sessions).toEqual([]);
    expect(store.eventsFor("acme", "auth", 0)).toEqual([]);
    expect(store.resumeOffsets("lap-1")).toEqual({});
  });

  it("defaults to a no-op persister, so a store built with no arguments still works", () => {
    // The shape the hub itself constructs today (hub.ts:61) and every other
    // test in this file uses. The seam must cost nothing when nobody injects a
    // persister — no calls to make, and no crash from a missing one.
    const store = new HubStore();
    expect(store.createProject("acme", "Acme", "ana", T)).toEqual({ ok: true });
    expect(store.joinProject("acme", "bo")).toBe(true);
    expect(store.leaveProject("acme", "bo")).toBe(true);
    expect(store.setLifecycle("acme", "closed")).toEqual({ ok: true });
    store.ensureProject("other", T);
    store.attach("lap-1", "acme", "lap-1", [decl("github.com/acme/api")], T);
    store.setRepos("lap-1", [decl("github.com/acme/web")]);
    expect(store.setFacts("lap-1", "auth", "run-a", facts())).toEqual({ ok: true });
    expect(store.publish("lap-1", "auth", "run-a", [ev(0), ev(1)])).toHaveLength(2);
    expect(store.publish("lap-1", "chat", "run-a", [ev(0)])).toHaveLength(1);

    expect(store.eventsFor("acme", "auth", 0).map((e) => e.id)).toEqual([1, 2]);
    expect(store.resumeOffsets("lap-1")).toEqual({
      auth: { runId: "run-a", lastSeq: 1 },
      chat: { runId: "run-a", lastSeq: 0 },
    });
    expect(store.lifecycleOf("acme")).toBe("closed");
    expect(store.lifecycleOf("other")).toBe("active");
    expect(store.machinesIn("acme")[0].repos).toEqual([decl("github.com/acme/web")]);
  });
});
