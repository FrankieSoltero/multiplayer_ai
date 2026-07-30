import { describe, it, expect, vi, afterEach } from "vitest";
import WebSocket from "ws";

/** The session entries the SERVER builds are reachable no other way: nothing on
 *  the wire carries `workdir`/`baseRef` (Task 4 is the first consumer), and
 *  `startServer` exposes no registry. So the `Project` the server constructs is
 *  captured here at construction — the class it imports is the one this file
 *  mocks — and the real entries are read straight off it. Everything else in
 *  the module is passed through untouched. */
const { createdProjects } = vi.hoisted(() => ({
  createdProjects: [] as {
    id: string;
    sessions: Map<string, import("../src/project.js").ProjectSessionEntry>;
  }[],
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  Project,
  projectSnapshot,
  SLUG,
  sessionFactsOf,
  arcadeRecordsFrom,
  type ProjectMessage,
} from "../src/project.js";
import type { RepoDecl } from "../src/relayProtocol.js";
import { parseUpFrame } from "../src/relayProtocol.js";
import { PATH_WIRE_CAP } from "../src/collisions.js";
import { touchedFiles } from "../src/touched.js";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery } from "../src/agentDriver.js";
import { startServer } from "../src/server.js";

const idleRun: RunQuery = async function* (prompts) {
  for await (const _p of prompts) {
    /* never yields; stays alive */
  }
};

function addSession(
  project: Project,
  id: string,
  skills: { name: string; description: string }[] = [],
  repoKey: string | null = null,
  workdir: string | undefined = repoKey === null ? undefined : `/tmp/wt/${id}`,
  baseRef: string | null = repoKey === null ? null : "main",
  touched: string[] | null = null,
  contestedFrame: import("../src/project.js").ProjectSessionEntry["contestedFrame"] = null,
): Session {
  const session = new Session(id);
  // Every field of the real entry, `contestedAsked` (Task 8b) included: the
  // snapshot must not grow a field just because the entry did.
  project.sessions.set(id, { session, driver: new AgentDriver(session, idleRun), skills, pendingSuggests: new Map(), pendingOversight: false, repoKey, workdir, baseRef, touched, contestedFrame, contestedAsked: new Set<string>() });
  return session;
}

describe("SLUG", () => {
  it("accepts lowercase slugs and rejects traversal/uppercase/overlong ids", () => {
    expect(SLUG.test("ana-1")).toBe(true);
    expect(SLUG.test("../etc")).toBe(false);
    expect(SLUG.test("Ana")).toBe(false);
    expect(SLUG.test("a".repeat(41))).toBe(false);
    expect(SLUG.test("")).toBe(false);
  });
});

describe("projectSnapshot", () => {
  it("derives participants, driver, intent, lastActivity, ended per session", () => {
    const project = new Project("demo");
    const ana = addSession(project, "ana");
    ana.join("u1", "Ana");
    ana.append({ type: "intent_update", text: "Migrating auth" });
    addSession(project, "ben");

    const snap = projectSnapshot(project);
    expect(snap.type).toBe("project");
    expect(snap.sessions).toHaveLength(2);
    const anaSnap = snap.sessions.find((s) => s.id === "ana")!;
    expect(anaSnap.participants).toEqual(["Ana"]);
    expect(anaSnap.driverName).toBe("Ana");
    expect(anaSnap.intent).toBe("Migrating auth");
    expect(anaSnap.ended).toBe(false);
    expect(typeof anaSnap.lastActivityTs).toBe("string");
    const benSnap = snap.sessions.find((s) => s.id === "ben")!;
    expect(benSnap.intent).toBeNull();
    expect(benSnap.driverName).toBeNull();
    expect(benSnap.lastActivityTs).toBeNull();
  });

  it("includes each session's skill roster in the snapshot", () => {
    const project = new Project("demo");
    addSession(project, "ana", [{ name: "auth-migration-guide", description: "Migrate cookie auth to JWT." }]);
    addSession(project, "ben");
    const snap = projectSnapshot(project);
    expect(snap.sessions.find((s) => s.id === "ana")!.skills).toEqual([
      { name: "auth-migration-guide", description: "Migrate cookie auth to JWT." },
    ]);
    expect(snap.sessions.find((s) => s.id === "ben")!.skills).toEqual([]);
  });

  it("reports machines[0] with name and repos, and has NO top-level repo property (D10)", () => {
    const project = new Project("demo");
    addSession(project, "ana");
    const repos: RepoDecl[] = [
      { key: "github.com/acme/api", label: "api", attached: true, defaultBranch: "main" },
    ];
    const snap = projectSnapshot(project, undefined, {
      machineId: "m1",
      name: "Frankie's Laptop",
      repos,
    });
    expect(snap).not.toHaveProperty("repo");
    expect(snap.machines).toEqual([
      { machineId: "m1", name: "Frankie's Laptop", repos, online: true },
    ]);
  });

  it("session rows carry each entry's OWN repoKey, not a machine-wide global", () => {
    // The two-keys assertion is the discriminating one: feeding every row the
    // same (e.g. machine-derived) key instead of entry.repoKey must fail this.
    const project = new Project("demo");
    addSession(project, "ana", [], "github.com/acme/api");
    addSession(project, "ben", [], "github.com/acme/web");

    const snap = projectSnapshot(project);
    expect(snap.sessions.find((s) => s.id === "ana")!.repoKey).toBe("github.com/acme/api");
    expect(snap.sessions.find((s) => s.id === "ben")!.repoKey).toBe("github.com/acme/web");
  });
});

describe("arcade records", () => {
  it("keeps the best score per game across sessions and survives the holder leaving", () => {
    const project = new Project("demo");
    const ana = addSession(project, "ana");
    ana.join("u1", "Ana", { glyph: "▲", color: "#ff0000" });
    ana.append({ type: "game_score", userId: "u1", game: "dino", score: 120 });
    const ben = addSession(project, "ben");
    ben.join("u2", "Ben");
    ben.append({ type: "game_score", userId: "u2", game: "dino", score: 90 });
    ben.append({ type: "game_score", userId: "u2", game: "snake", score: 40 });
    ana.leave("u1"); // record must outlive the holder's presence

    const snap = projectSnapshot(project);
    expect(snap.arcade).toHaveLength(2);
    const dino = snap.arcade.find((r) => r.game === "dino")!;
    expect(dino).toMatchObject({ score: 120, userId: "u1", name: "Ana", glyph: "▲", color: "#ff0000" });
    const snake = snap.arcade.find((r) => r.game === "snake")!;
    expect(snake).toMatchObject({ score: 40, userId: "u2", name: "Ben" });
    expect(snake.glyph).toBeUndefined(); // no glyph sent — client falls back
  });

  it("skips malformed game_score events instead of crashing", () => {
    const project = new Project("demo");
    const ana = addSession(project, "ana");
    ana.join("u1", "Ana");
    ana.append({ type: "game_score", userId: "u1", game: "dino", score: 2.5 } as never);
    ana.append({ type: "game_score", userId: "u1", game: "dino", score: -5 } as never);
    expect(projectSnapshot(project).arcade).toEqual([]);
  });

  it("breaks ties chronologically across sessions, not by iteration order", () => {
    vi.useFakeTimers();
    try {
      const project = new Project("demo");
      const ana = addSession(project, "ana");
      ana.join("u1", "Ana");

      // Ana scores 100 at timestamp 1000
      vi.setSystemTime(1000);
      ana.append({ type: "game_score", userId: "u1", game: "dino", score: 100 });

      // Later session Ben created, but scores 100 (tie) at timestamp 500 (earlier)
      vi.setSystemTime(500);
      const ben = addSession(project, "ben");
      ben.join("u2", "Ben");
      ben.append({ type: "game_score", userId: "u2", game: "dino", score: 100 });

      const snap = projectSnapshot(project);
      const dino = snap.arcade.find((r) => r.game === "dino")!;
      // Ben's score has earlier timestamp (500 < 1000), so Ben should win the tie
      expect(dino).toMatchObject({ userId: "u2", name: "Ben", score: 100 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sessionFactsOf", () => {
  it("produces exactly the snapshot row minus presence", () => {
    // The relay publishes facts and the hub adds `presence`. If the two ever
    // diverge, a hub-attached session renders differently from a standalone
    // one for no reason a user could explain — so pin the relationship.
    const project = new Project("p");
    addSession(project, "auth", [], "github.com/acme/api");
    const entry = project.sessions.get("auth")!;

    const snapshot = projectSnapshot(project);
    const facts = sessionFactsOf("auth", entry, "github.com/acme/api");

    const { presence, ...row } = snapshot.sessions[0];
    expect(presence).toBe("online");
    expect(facts).toEqual(row);
  });

  it("carries a null repoKey through rather than inventing one", () => {
    const project = new Project("p");
    addSession(project, "auth");
    expect(sessionFactsOf("auth", project.sessions.get("auth")!, null).repoKey).toBeNull();
  });
});

describe("touched on session facts", () => {
  it("is null on a fresh entry rather than an empty list", () => {
    // Null and [] are different claims: null is "this session has never been
    // measured", [] is "measured, and it has changed nothing". A fresh entry has
    // not been measured, so the honest default is null.
    const project = new Project("p");
    addSession(project, "auth", [], "github.com/acme/api");
    expect(project.sessions.get("auth")!.touched).toBeNull();
    expect(sessionFactsOf("auth", project.sessions.get("auth")!, "github.com/acme/api").touched).toBeNull();
  });

  it("carries the entry's list through as a COPY, never an alias", () => {
    // The facts object crosses the wire, the snapshot and the collision engine.
    // If it aliased the entry's array, any consumer that sorted or truncated the
    // list it was handed would silently rewrite the session's own stored state.
    const project = new Project("p");
    addSession(project, "auth", [], "github.com/acme/api", undefined, undefined, ["a.ts", "b.ts"]);
    const entry = project.sessions.get("auth")!;

    const facts = sessionFactsOf("auth", entry, "github.com/acme/api");
    expect(facts.touched).toEqual(["a.ts", "b.ts"]);
    expect(facts.touched).not.toBe(entry.touched);

    facts.touched!.push("c.ts");
    facts.touched!.sort().reverse();
    expect(entry.touched).toEqual(["a.ts", "b.ts"]);
  });

  it("reaches the project snapshot row, not just SessionFacts", () => {
    // The snapshot row type enumerates its fields explicitly and does NOT inherit
    // from SessionFacts, even though `projectSnapshot` builds each row by
    // spreading `sessionFactsOf(...)`. The annotation below is the assertion that
    // matters: adding the field to `SessionFacts` alone fails to compile here.
    const project = new Project("p");
    addSession(project, "auth", [], "github.com/acme/api", undefined, undefined, ["a.ts"]);

    const row: ProjectMessage["sessions"][number] = projectSnapshot(project).sessions[0];
    expect(row.touched).toEqual(["a.ts"]);
  });

  it("rides the project push to that project's members ONLY", () => {
    // `touched` is a session's FULL changed-path list and it goes to every member
    // of its project (spec §8a ruling 5, accepted). The bound that DOES hold is
    // project membership — one server holding two projects must never leak one
    // project's paths into the other's push.
    const alpha = new Project("alpha");
    addSession(alpha, "a1", [], "github.com/acme/api", undefined, undefined, ["alpha-only.ts"]);
    const beta = new Project("beta");
    addSession(beta, "b1", [], "github.com/acme/api", undefined, undefined, ["beta-only.ts"]);

    const push = projectSnapshot(alpha);
    expect(push.sessions.map((s) => s.id)).toEqual(["a1"]);
    expect(push.sessions.map((s) => s.touched)).toEqual([["alpha-only.ts"]]);
    const wire = JSON.stringify(push);
    expect(wire).not.toContain("beta-only.ts");
    expect(wire).not.toContain("b1");
  });

  it("never produces a facts frame its own validator rejects, even from a repo holding an over-long path", () => {
    // Paired with the producer's drop rule: `touchedFiles` drops a path longer
    // than PATH_WIRE_CAP rather than truncating it, so one pathological path
    // costs that path and never the session's whole facts frame.
    const repo = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mpai-facts-"));
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-b", "main");
    git("config", "user.email", "facts@example.test");
    git("config", "user.name", "Facts Test");
    fs.writeFileSync(nodePath.join(repo, "README.md"), "seed\n");
    git("add", "-A");
    git("commit", "--no-gpg-sign", "-m", "seed");

    const seg = "d".repeat(100);
    const overLong = [seg, seg, seg, seg, seg, seg, "leaf.ts"].join("/");
    expect(overLong.length).toBeGreaterThan(PATH_WIRE_CAP);
    fs.mkdirSync(nodePath.join(repo, nodePath.dirname(overLong)), { recursive: true });
    fs.writeFileSync(nodePath.join(repo, overLong), "x\n");
    fs.writeFileSync(nodePath.join(repo, "src.ts"), "y\n");

    // The producer logs one drop line; silence it without hiding a real failure.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let paths: string[];
    try {
      paths = touchedFiles(repo, "main");
    } finally {
      stderr.mockRestore();
    }

    const project = new Project("p");
    addSession(project, "auth", [], "github.com/acme/api", repo, "main", paths);
    const facts = sessionFactsOf("auth", project.sessions.get("auth")!, "github.com/acme/api");

    expect(facts.touched).toEqual(["src.ts"]);
    const frame = parseUpFrame({ t: "facts", sessionId: "auth", runId: "run-a", facts });
    expect(frame?.t).toBe("facts");

    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("arcadeRecordsFrom", () => {
  it("aggregates best-per-game across independent event logs", () => {
    const logs = [
      [
        { type: "presence_join", userId: "ana", name: "ana", seq: 0, ts: "2026-07-27T00:00:00.000Z" },
        { type: "game_score", userId: "ana", game: "tetris", score: 100, seq: 1, ts: "2026-07-27T00:00:01.000Z" },
      ],
      [
        { type: "presence_join", userId: "ben", name: "ben", seq: 0, ts: "2026-07-27T00:00:02.000Z" },
        { type: "game_score", userId: "ben", game: "tetris", score: 250, seq: 1, ts: "2026-07-27T00:00:03.000Z" },
      ],
    ] as any;
    expect(arcadeRecordsFrom(logs)).toEqual([
      { game: "tetris", score: 250, userId: "ben", name: "ben", glyph: undefined, color: undefined },
    ]);
  });

  it("resolves a holder's identity from any log, not just its own", () => {
    // On the hub the join and the score can arrive on different sessions of
    // the same project. Identity must still resolve, or the leaderboard reads
    // "unknown" for a player who is right there in the roster.
    const logs = [
      [{ type: "presence_join", userId: "ana", name: "ana", glyph: "▲", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
      [{ type: "game_score", userId: "ana", game: "snake", score: 12, seq: 0, ts: "2026-07-27T00:00:01.000Z" }],
    ] as any;
    expect(arcadeRecordsFrom(logs)[0]).toMatchObject({ name: "ana", glyph: "▲" });
  });
});

describe("projectSnapshot plugins", () => {
  it("carries the plugin registry and enabled flag when provided", () => {
    const project = new Project("p1");
    const plugins = [
      {
        name: "soltero-skills",
        url: "https://github.com/x/soltero-skills",
        skills: [{ name: "soltero-skills:agent-handoff", description: "d" }],
        addedBy: "u1",
      },
    ];
    const snap = projectSnapshot(project, { plugins, enabled: true });
    expect(snap.plugins).toEqual(plugins);
    expect(snap.pluginsEnabled).toBe(true);
  });

  it("defaults to an empty, disabled registry when omitted (back-compat)", () => {
    const snap = projectSnapshot(new Project("p2"));
    expect(snap.plugins).toEqual([]);
    expect(snap.pluginsEnabled).toBe(false);
  });
});

describe("projectSnapshot and the stored contested frame (spec §6a)", () => {
  it("keeps the hub's frame OFF the wire — the row carries touched, not peers", () => {
    // `contestedFrame` is laptop-local state for `digestFor` and the gate
    // (Tasks 7b/8b). The snapshot row is built field by field from
    // `sessionFactsOf`, so a row assembled by spreading the ENTRY instead would
    // publish the hub's peer ids to every browser watching this project.
    const project = new Project("p3");
    addSession(project, "auth", [], "github.com/acme/api", "/tmp/wt/auth", "main", ["src/a.ts"], {
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["auth", "s9"] }],
    });
    const snap = projectSnapshot(project);
    expect(snap.sessions[0]).not.toHaveProperty("contestedFrame");
    expect(JSON.stringify(snap)).not.toContain("s9");
    // The field the row DOES carry is untouched by any of this.
    expect(snap.sessions[0].touched).toEqual(["src/a.ts"]);
  });
});

describe("session workdir/baseRef binding (spec §3.1, §3.2)", () => {
  /** A workspace that records exactly what it was handed, so a test can compare
   *  the bound `entry.baseRef` against the string that actually reached
   *  `provision` rather than against a literal it wrote itself. */
  function recordingWorkspace(defaultBranch: string | null = "main") {
    const calls: { projectId: string; slug: string; baseRef: string }[] = [];
    return {
      calls,
      provision(projectId: string, slug: string, baseRef: string) {
        calls.push({ projectId, slug, baseRef });
        return { ok: true as const, workdir: `/tmp/wt/${projectId}/${slug}` };
      },
      // A repo with no default branch is a real state (RepoEntry.defaultBranch
      // is `string | null`); the fake reproduces it for the pass-through row.
      defaultBranch: () => defaultBranch as unknown as string,
      repoKey: () => "local:test:000000000000",
    };
  }

  function entryOf(projectId: string, sessionId: string) {
    for (let i = createdProjects.length - 1; i >= 0; i--) {
      const project = createdProjects[i];
      const entry = project.id === projectId ? project.sessions.get(sessionId) : undefined;
      if (entry) return entry;
    }
    throw new Error(`no session entry for ${projectId}/${sessionId}`);
  }

  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  let closeServer: (() => Promise<void>) | undefined;
  let sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets = [];
    await closeServer?.();
    closeServer = undefined;
  });

  async function open(port: number, sink: unknown[]): Promise<WebSocket> {
    const ws = await connect(port);
    sockets.push(ws);
    ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
    return ws;
  }

  it("binds the provisioned worktree and the exact baseRef on create_session", async () => {
    const workspace = recordingWorkspace();
    const server = await startServer({ port: 0, runQuery: idleRun, workspace });
    closeServer = server.close;
    const seen: any[] = [];
    const ws = await open(server.port, seen);
    ws.send(JSON.stringify({ type: "create_session", name: "Auth", baseRef: "origin/main" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "auth")).toBe(true);
    });

    const entry = entryOf("default", "auth");
    expect(entry.workdir).toBe("/tmp/wt/default/auth");
    expect(entry.baseRef).toBe("origin/main");
    // Character-identical to what provision actually received.
    expect(entry.baseRef).toBe(workspace.calls[0].baseRef);
  });

  it("stores the session's own baseRef, never a re-derived default branch", async () => {
    // Discriminating: the repo's default branch is `main`, the session was cut
    // from `origin/dev`. Any binding that consults defaultBranch() or falls back
    // to a "main" literal of its own fails here.
    const workspace = recordingWorkspace("main");
    const server = await startServer({ port: 0, runQuery: idleRun, workspace });
    closeServer = server.close;
    const seen: any[] = [];
    const ws = await open(server.port, seen);
    ws.send(JSON.stringify({ type: "create_session", name: "Dev Work", baseRef: "origin/dev" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "dev-work")).toBe(true);
    });

    expect(workspace.defaultBranch()).toBe("main");
    expect(workspace.calls).toEqual([
      { projectId: "default", slug: "dev-work", baseRef: "origin/dev" },
    ]);
    expect(entryOf("default", "dev-work").baseRef).toBe("origin/dev");
  });

  it("binds on EVERY creation path — deep-link join as well as create_session", async () => {
    // Discriminating: a binding wired into only one of the two paths leaves the
    // other session with an unset pair while its worktree exists.
    const workspace = recordingWorkspace();
    const server = await startServer({ port: 0, runQuery: idleRun, workspace });
    closeServer = server.close;
    const seen: any[] = [];
    const ws = await open(server.port, seen);

    ws.send(JSON.stringify({ type: "join", sessionId: "adhoc", userId: "u1", name: "Ana" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.event?.type === "presence_join")).toBe(true);
    });
    ws.send(JSON.stringify({ type: "create_session", name: "made", baseRef: "origin/main" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "made")).toBe(true);
    });

    for (const call of workspace.calls) {
      const entry = entryOf("default", call.slug);
      expect(entry.workdir).toBe(`/tmp/wt/default/${call.slug}`);
      expect(entry.baseRef).toBe(call.baseRef);
    }
    expect(workspace.calls.map((c) => c.slug).sort()).toEqual(["adhoc", "made"]);
  });

  it("passes a default chosen by the CALL SITE through byte-for-byte", async () => {
    // The repo has no default branch, so getOrCreateSession itself hands
    // provision "main". Storing that is correct — it is what git branched from.
    const workspace = recordingWorkspace(null);
    const server = await startServer({ port: 0, runQuery: idleRun, workspace });
    closeServer = server.close;
    const seen: any[] = [];
    const ws = await open(server.port, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "adhoc", userId: "u1", name: "Ana" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.event?.type === "presence_join")).toBe(true);
    });

    expect(workspace.calls).toEqual([
      { projectId: "default", slug: "adhoc", baseRef: "main" },
    ]);
    expect(entryOf("default", "adhoc").baseRef).toBe("main");
  });

  it("records no workdir and a null baseRef for a session with no repo", async () => {
    const previousRoot = process.env.AGENT_WORKDIR_ROOT;
    delete process.env.AGENT_WORKDIR_ROOT;
    try {
      const server = await startServer({ port: 0, runQuery: idleRun });
      closeServer = server.close;
      const seen: any[] = [];
      const ws = await open(server.port, seen);
      ws.send(JSON.stringify({ type: "join", sessionId: "solo", userId: "u1", name: "Ana" }));
      await vi.waitFor(() => {
        expect(seen.some((m) => m.event?.type === "presence_join")).toBe(true);
      });

      const entry = entryOf("default", "solo");
      // Bound deliberately, not merely absent: both keys exist on the entry.
      expect(Object.hasOwn(entry, "workdir")).toBe(true);
      expect(Object.hasOwn(entry, "baseRef")).toBe(true);
      expect(entry.workdir).toBeUndefined();
      expect(entry.baseRef).toBeNull();
    } finally {
      if (previousRoot === undefined) delete process.env.AGENT_WORKDIR_ROOT;
      else process.env.AGENT_WORKDIR_ROOT = previousRoot;
    }
  });

  it("starts contestedFrame null on every creation path (spec §6a)", async () => {
    // `null` means NO HUB FRAME HAS ARRIVED, which is not the same claim as an
    // empty frame ("the hub says nothing is contested any more") — the two are
    // distinguishable on the entry, so a fresh session must start at the former.
    // Both creation paths, because a field wired into only one of them leaves
    // the other session missing the key entirely.
    const workspace = recordingWorkspace();
    const server = await startServer({ port: 0, runQuery: idleRun, workspace });
    closeServer = server.close;
    const seen: any[] = [];
    const ws = await open(server.port, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "adhoc", userId: "u1", name: "Ana" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.event?.type === "presence_join")).toBe(true);
    });
    ws.send(JSON.stringify({ type: "create_session", name: "made", baseRef: "origin/main" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "made")).toBe(true);
    });

    for (const sessionId of ["adhoc", "made"]) {
      const entry = entryOf("default", sessionId);
      expect(Object.hasOwn(entry, "contestedFrame")).toBe(true);
      expect(entry.contestedFrame).toBeNull();
    }
  });
});
