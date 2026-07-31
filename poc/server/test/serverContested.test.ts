import { describe, it, expect, vi, afterEach } from "vitest";

/** The session entries the SERVER builds are reachable no other way — nothing
 *  on the wire carries `contestedFrame` (Tasks 7b/8b are the first consumers)
 *  and `startServer` exposes no registry — so the `Project` the server
 *  constructs is captured here at construction and the real entries are read
 *  straight off it. Same seam `project.test.ts` uses, for the same reason.
 *  Everything else in the module passes through untouched. */
const { createdProjects } = vi.hoisted(() => ({
  createdProjects: [] as import("../src/project.js").Project[],
}));

vi.mock("../src/project.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/project.js")>();
  class TrackedProject extends actual.Project {
    constructor(id: string) {
      super(id);
      createdProjects.push(this);
    }
  }
  return { ...actual, Project: TrackedProject };
});

import { Project, type ProjectSessionEntry } from "../src/project.js";
import { contestedFor, contestedSessionsFor } from "../src/contested.js";
import { TOUCH_SENTINEL } from "../src/collisions.js";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery } from "../src/agentDriver.js";
import { startServer } from "../src/server.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relayProtocol.js";

const idleRun: RunQuery = async function* (prompts) {
  for await (const _p of prompts) {
    /* never yields; stays alive */
  }
};

/** One session on this laptop's project map. Every field of the real entry is
 *  present — a fixture that omitted `contestedFrame` or `contestedAsked` would
 *  compile only while the field is optional, which neither is. */
function addSession(
  project: Project,
  id: string,
  over: Partial<ProjectSessionEntry> = {},
): ProjectSessionEntry {
  const session = new Session(id);
  const entry: ProjectSessionEntry = {
    session,
    driver: new AgentDriver(session, idleRun),
    skills: [],
    pendingSuggests: new Map(),
    pendingOversight: false,
    repoKey: null,
    workdir: undefined,
    baseRef: null,
    touched: null,
    touchedDirty: true,
    contestedFrame: null,
    contestedAsked: new Set<string>(),
    ...over,
  };
  project.sessions.set(id, entry);
  return entry;
}

describe("contestedFor / contestedSessionsFor — hub frame", () => {
  it("reports the stored frame's paths and names its peers, with no local overlap at all", () => {
    const project = new Project("unit");
    addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["src/z.ts"],
      contestedFrame: {
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
      },
    });
    // A local session that shares NOTHING: the hub-sourced answer must not
    // depend on local derivation finding anything.
    addSession(project, "other", { repoKey: "github.com/acme/api", touched: ["src/y.ts"] });

    expect([...contestedFor(project, "auth")]).toEqual(["src/a.ts"]);
    // The recipient's own id rides in `sessionIds` (relayProtocol §6a) and is
    // never a peer of itself.
    expect(contestedSessionsFor(project, "auth", "src/a.ts")).toEqual(["s9"]);
    // A path nobody is contesting answers empty rather than guessing.
    expect(contestedSessionsFor(project, "auth", "src/z.ts")).toEqual([]);

    // The GATE's bookkeeping (`contestedAsked`, Task 8b) is not an input to
    // either accessor: a file a human has already been asked about is still a
    // contested file, it is only no longer a reason to ask again.
    project.sessions.get("auth")!.contestedAsked.add("src/a.ts");
    expect([...contestedFor(project, "auth")]).toEqual(["src/a.ts"]);
    expect(contestedSessionsFor(project, "auth", "src/a.ts")).toEqual(["s9"]);
  });

  it("loses the hub-sourced paths when a clearing frame lands, and keeps the local ones", () => {
    const project = new Project("unit");
    const auth = addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["src/b.ts"],
      contestedFrame: {
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
      },
    });
    addSession(project, "s2", { repoKey: "github.com/acme/api", touched: ["src/b.ts"] });
    expect([...contestedFor(project, "auth")].sort()).toEqual(["src/a.ts", "src/b.ts"]);

    auth.contestedFrame = { paths: [], collisions: [] };

    // The hub said "nothing left" — but the two LOCAL sessions still overlap,
    // and local derivation is computed on read, so it survives the clear.
    expect([...contestedFor(project, "auth")]).toEqual(["src/b.ts"]);
    expect(contestedSessionsFor(project, "auth", "src/a.ts")).toEqual([]);
    expect(contestedSessionsFor(project, "auth", "src/b.ts")).toEqual(["s2"]);
  });
});

describe("contestedFor / contestedSessionsFor — local derivation", () => {
  it("derives a same-machine collision with no hub frame at all, scoped to one repo", () => {
    const project = new Project("unit");
    addSession(project, "auth", { repoKey: "github.com/acme/api", touched: ["src/b.ts"] });
    addSession(project, "s2", {
      repoKey: "github.com/acme/api",
      touched: ["src/b.ts", "src/c.ts"],
    });
    // Discriminating: the SAME path in a DIFFERENT repo is not a collision —
    // an implementation that intersected touched sets without `collisionsFrom`
    // (or without the repoKey) names `s3` here.
    addSession(project, "s3", { repoKey: "github.com/acme/web", touched: ["src/b.ts"] });
    // Never measured is not "measured, changed nothing": a null touched set
    // contributes nothing rather than throwing.
    addSession(project, "s4", { repoKey: "github.com/acme/api", touched: null });

    expect([...contestedFor(project, "auth")]).toEqual(["src/b.ts"]);
    expect(contestedSessionsFor(project, "auth", "src/b.ts")).toEqual(["s2"]);
    // `src/c.ts` is touched by s2 alone — one session is not a collision.
    expect([...contestedFor(project, "s2")]).toEqual(["src/b.ts"]);
    expect(contestedSessionsFor(project, "s2", "src/c.ts")).toEqual([]);
  });

  it("unions the two sources, each path keeping its own peers", () => {
    const project = new Project("unit");
    addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["src/b.ts"],
      contestedFrame: {
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
      },
    });
    addSession(project, "s2", { repoKey: "github.com/acme/api", touched: ["src/b.ts"] });

    expect([...contestedFor(project, "auth")].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(contestedSessionsFor(project, "auth", "src/a.ts")).toEqual(["s9"]);
    expect(contestedSessionsFor(project, "auth", "src/b.ts")).toEqual(["s2"]);
  });

  it("dedupes a path — and a peer — that both sources report", () => {
    const project = new Project("unit");
    addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["src/c.ts"],
      contestedFrame: {
        paths: ["src/c.ts"],
        // `s2` is ALSO the local peer below, and `auth` is the recipient itself.
        collisions: [{ path: "src/c.ts", sessionIds: ["auth", "s2", "s9"] }],
      },
    });
    addSession(project, "s2", { repoKey: "github.com/acme/api", touched: ["src/c.ts"] });

    const paths = [...contestedFor(project, "auth")];
    expect(paths).toEqual(["src/c.ts"]); // once, not twice
    // Ascending, each id once, and never the asking session itself.
    expect(contestedSessionsFor(project, "auth", "src/c.ts")).toEqual(["s2", "s9"]);
  });
});

describe("contestedFor / contestedSessionsFor — defensive bounds", () => {
  it("never emits the truncation sentinel, from either list", () => {
    const project = new Project("unit");
    addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["src/a.ts", TOUCH_SENTINEL],
      contestedFrame: {
        // Exactly what Task 6b's over-cap producer sends: a real path plus the
        // trailing "…and more" marker. Stored verbatim, filtered on read.
        paths: ["src/a.ts", TOUCH_SENTINEL],
        // Never assume the two lists agree: a sentinel-keyed collisions entry
        // must not produce peers either.
        collisions: [
          { path: "src/a.ts", sessionIds: ["auth", "s9"] },
          { path: TOUCH_SENTINEL, sessionIds: ["auth", "s7"] },
        ],
      },
    });
    // A second local session touching the sentinel too — the derivation side
    // must not resurrect it as a "shared path" either.
    addSession(project, "s2", {
      repoKey: "github.com/acme/api",
      touched: ["src/a.ts", TOUCH_SENTINEL],
    });

    const paths = [...contestedFor(project, "auth")];
    expect(paths).toEqual(["src/a.ts"]);
    expect(paths).not.toContain(TOUCH_SENTINEL);
    expect(contestedSessionsFor(project, "auth", TOUCH_SENTINEL)).toEqual([]);
    expect(contestedSessionsFor(project, "auth", "src/a.ts")).toEqual(["s2", "s9"]);
  });

  it("never emits an empty path, and answers [] when asked about one", () => {
    const project = new Project("unit");
    addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["", "src/a.ts"],
      contestedFrame: {
        // The validator's path bound has no minimum length, so "" reaches here.
        paths: ["", "src/a.ts"],
        collisions: [{ path: "", sessionIds: ["auth", "s9"] }],
      },
    });
    addSession(project, "s2", { repoKey: "github.com/acme/api", touched: [""] });

    expect([...contestedFor(project, "auth")]).toEqual(["src/a.ts"]);
    expect(contestedSessionsFor(project, "auth", "")).toEqual([]);
  });

  it("answers empty for a session it has never heard of, and never throws", () => {
    const project = new Project("unit");
    addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["src/b.ts"],
      contestedFrame: {
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
      },
    });
    addSession(project, "s2", { repoKey: "github.com/acme/api", touched: ["src/b.ts"] });

    expect(contestedFor(project, "nope").size).toBe(0);
    expect(contestedSessionsFor(project, "nope", "src/a.ts")).toEqual([]);
    expect(contestedSessionsFor(project, "nope", "src/b.ts")).toEqual([]);
    expect(() => contestedFor(new Project("empty"), "nope")).not.toThrow();
  });

  it("emits paths and session ids only — no prompt, transcript or file content", () => {
    const project = new Project("unit");
    const auth = addSession(project, "auth", {
      repoKey: "github.com/acme/api",
      touched: ["src/b.ts"],
      contestedFrame: {
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
      },
    });
    addSession(project, "s2", { repoKey: "github.com/acme/api", touched: ["src/b.ts"] });
    auth.session.append({ type: "user_message", userId: "u1", text: "SECRET-PROMPT" });

    const dump = JSON.stringify([
      [...contestedFor(project, "auth")],
      contestedSessionsFor(project, "auth", "src/a.ts"),
      contestedSessionsFor(project, "auth", "src/b.ts"),
    ]);
    expect(dump).not.toContain("SECRET-PROMPT");
    expect(JSON.parse(dump)).toEqual([["src/a.ts", "src/b.ts"], ["s9"], ["s2"]]);
  });
});

/** A hub end that records what the laptop sent and drives the frames back. */
function fakeHub() {
  const sent: any[] = [];
  const handlers = new Map<string, (arg?: unknown) => void>();
  const state = { closeRequested: false };
  return {
    connect: () => ({
      send: (data: string) => void sent.push(JSON.parse(data)),
      close: () => void (state.closeRequested = true),
      on: (event: string, fn: (arg?: unknown) => void) => void handlers.set(event, fn),
    }),
    sent,
    state,
    open: () => handlers.get("open")?.(),
    deliver: (frame: unknown) => handlers.get("message")?.(JSON.stringify(frame)),
  };
}

describe("inbound contested frame (laptop side)", () => {
  let close: (() => Promise<void>) | undefined;
  const conns: { close: () => void }[] = [];

  afterEach(async () => {
    for (const conn of conns.splice(0)) conn.close();
    await close?.();
    close = undefined;
    createdProjects.length = 0;
  });

  /** A live laptop with an uplink to `hub`, holding one joined session. */
  async function laptop(sessionIds: string[] = ["auth"]) {
    const hub = fakeHub();
    // Cleared FIRST: every `new Project(...)` in this file lands in the same
    // capture array, so the entry read below has to be the one THIS server
    // constructed and no other.
    createdProjects.length = 0;
    const server = await startServer({
      port: 0,
      runQuery: idleRun,
      hub: { url: "ws://hub.test", projectId: "default", connect: hub.connect },
    });
    close = server.close;
    hub.open();
    hub.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    for (const sessionId of sessionIds) {
      const conn = server.createConnection({ mode: "direct", send: () => {} });
      conns.push(conn);
      conn.handleMessage({
        type: "join",
        projectId: "default",
        sessionId,
        userId: "u1",
        name: "Ana",
      });
    }
    const matches = createdProjects.filter((p) => p.id === "default");
    expect(matches).toHaveLength(1);
    const project = matches[0]!;
    for (const sessionId of sessionIds) expect(project.sessions.has(sessionId)).toBe(true);
    return { hub, server, project };
  }

  it("stores the frame verbatim on the session entry, and the accessors read it", async () => {
    const { hub, project } = await laptop();
    const frame = {
      t: "contested",
      sessionId: "auth",
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
    };
    hub.deliver(frame);

    expect(project.sessions.get("auth")!.contestedFrame).toEqual({
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
    });
    expect([...contestedFor(project, "auth")]).toEqual(["src/a.ts"]);
    expect(contestedSessionsFor(project, "auth", "src/a.ts")).toEqual(["s9"]);
    // The uplink is untouched by all of this.
    expect(hub.state.closeRequested).toBe(false);
  });

  it("empties the stored frame when a clearing frame arrives", async () => {
    const { hub, project } = await laptop();
    hub.deliver({
      t: "contested",
      sessionId: "auth",
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
    });
    hub.deliver({ t: "contested", sessionId: "auth", paths: [], collisions: [] });

    expect(project.sessions.get("auth")!.contestedFrame).toEqual({ paths: [], collisions: [] });
    expect(contestedFor(project, "auth").size).toBe(0);
  });

  it("drops a frame for an unknown session: no entry, one log line, uplink up", async () => {
    const { hub, project } = await laptop();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      hub.deliver({
        t: "contested",
        sessionId: "ghost",
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["ghost", "s9"] }],
      });
      // A second frame for the same unknown id says NOTHING more.
      hub.deliver({ t: "contested", sessionId: "ghost", paths: [], collisions: [] });

      const lines = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("[contested] "));
      expect(lines).toEqual(["[contested] session=ghost unknown session, frame dropped\n"]);

      // Nothing was created and nothing was stored anywhere.
      expect(project.sessions.has("ghost")).toBe(false);
      expect(project.sessions.size).toBe(1);
      expect(hub.state.closeRequested).toBe(false);

      // A later frame for a session that DOES exist is still applied normally.
      hub.deliver({
        t: "contested",
        sessionId: "auth",
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
      });
      expect(project.sessions.get("auth")!.contestedFrame).toEqual({
        paths: ["src/a.ts"],
        collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
      });
      expect(
        stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[contested] ")),
      ).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("applies each session's own frame, and a malformed frame changes nothing", async () => {
    const { hub, project } = await laptop(["auth", "docs"]);
    hub.deliver({
      t: "contested",
      sessionId: "auth",
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
    });
    // Rejected by `parseDownFrame` (paths is not a path list) — it must never
    // reach the handler, and must not disturb the frame already stored.
    hub.deliver({ t: "contested", sessionId: "auth", paths: "src/a.ts", collisions: [] });

    expect(project.sessions.get("auth")!.contestedFrame).toEqual({
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
    });
    // The other session on the same laptop was never addressed, so it holds
    // the "no frame has arrived" value rather than its neighbour's.
    expect(project.sessions.get("docs")!.contestedFrame).toBeNull();
    expect(hub.state.closeRequested).toBe(false);
  });
});
