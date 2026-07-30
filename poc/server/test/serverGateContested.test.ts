import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";

/** Same capture seam `serverContested.test.ts` uses, for the same reason: the
 *  `ProjectSessionEntry` the SERVER builds is reachable no other way, and this
 *  task's bookkeeping (`contestedAsked`) lives on it. */
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

import { AgentDriver, type DriverHooks, type RunQuery } from "../src/agentDriver.js";
import { buildCanUseTool } from "../src/permissions.js";
import { Session } from "../src/session.js";
import { startServer } from "../src/server.js";
import { WorkspaceManager } from "../src/workspace.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relayProtocol.js";
import type { LoggedEvent } from "../src/events.js";

const WORKDIR = "/tmp/wt/ana";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every driver built in this file, so the fake streams can be ended in
 *  afterEach rather than left hanging on the event loop. */
const stops: (() => void)[] = [];
let seq = 0;

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  delete process.env.MPAI_CONTESTED_GATE;
});

/** A stream that stays alive until the test ends. Captures the SAME hooks
 *  object the driver hands `run` — which is the object site 3
 *  (`buildCanUseTool`) reads, so both sites can be exercised against one
 *  wiring in one test. */
function makeRun(): { run: RunQuery; hooksOf: () => DriverHooks } {
  let stop!: () => void;
  const done = new Promise<void>((r) => (stop = r));
  stops.push(stop);
  let captured: DriverHooks | undefined;
  const run: RunQuery = (_prompts, hooks) => {
    captured = hooks;
    return (async function* () {
      await done;
    })() as never;
  };
  return { run, hooksOf: () => captured! };
}

interface Wiring {
  /** `undefined` models a session with no repo. */
  workdir: string | undefined;
  contested: Set<string>;
  asked: Set<string>;
  peers: Map<string, string[]>;
  /** false → a driver constructed with NO collision wiring at all. */
  wired: boolean;
}

function build(over: Partial<Wiring> = {}) {
  const contested = over.contested ?? new Set<string>();
  const asked = over.asked ?? new Set<string>();
  const peers = over.peers ?? new Map<string, string[]>();
  const workdir = "workdir" in over ? over.workdir : WORKDIR;
  const session = new Session(`s-${++seq}`);
  session.join("u1", "Ana"); // first join takes the wheel → driverId = u1
  const { run, hooksOf } = makeRun();
  const reads = { contested: 0 };
  const answered: string[] = [];
  const driver =
    over.wired === false
      ? new AgentDriver(session, run, workdir)
      : new AgentDriver(
          session,
          run,
          workdir,
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          () => {
            reads.contested++;
            return contested;
          },
          () => asked,
          (p: string) => peers.get(p) ?? [],
          (p: string) => {
            answered.push(p);
            asked.add(p);
          },
        );
  return { session, driver, hooks: hooksOf(), contested, asked, peers, answered, reads };
}

const events = (session: Session): LoggedEvent[] => session.eventsFrom(0);
const ofType = (session: Session, type: string): any[] =>
  events(session).filter((e) => e.type === type);

const opts = () =>
  ({
    signal: new AbortController().signal,
    toolUseID: "t1",
    requestId: "cr1",
  }) as never;

/** One contested path with one named peer — the shape every site row uses. */
function contestedOn(path: string, peer = "s9"): Partial<Wiring> {
  return { contested: new Set([path]), peers: new Map([[path, [peer]]]) };
}

// ---------------------------------------------------------------------------
// Site 1 — agentDriver.ts onPermissionRequest, the AUTO branch
// ---------------------------------------------------------------------------

describe("site 1 — auto mode withdraws for a contested write", () => {
  it("appends no auto decision, does not resolve, and carries the reason", async () => {
    const t = build(contestedOn("src/a.ts"));
    expect(t.driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });

    let settled: string | null = null;
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" }).then((d) => {
      settled = d;
    });
    await wait(20);

    // The gate did NOT resolve itself.
    expect(settled).toBeNull();
    expect(ofType(t.session, "permission_decision")).toEqual([]);
    // The request landed, and it says WHY.
    const requests = ofType(t.session, "permission_request");
    expect(requests).toHaveLength(1);
    expect(requests[0].reason).toBe("contested with session s9");
    // Nothing was recorded yet — no human has answered.
    expect([...t.asked]).toEqual([]);
    expect(t.answered).toEqual([]);
  });

  it("auto-approves a write to an UNcontested path exactly as today", async () => {
    const t = build(contestedOn("src/a.ts"));
    t.driver.setPermissionMode("auto", "u1");

    const decision = await t.hooks.onPermissionRequest("Edit", { file_path: "src/b.ts" });

    expect(decision).toBe("allow");
    const [request] = ofType(t.session, "permission_request");
    // Byte-exact with today: no `reason` KEY at all, not a null one.
    expect(Object.prototype.hasOwnProperty.call(request, "reason")).toBe(false);
    expect(ofType(t.session, "permission_decision")[0]).toMatchObject({
      decision: "allow",
      auto: true,
    });
  });

  it("auto-approves again once a human has answered for that file (once per file, per session)", async () => {
    const t = build(contestedOn("src/a.ts"));
    t.driver.setPermissionMode("auto", "u1");
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" });
    await wait(10);
    const [request] = ofType(t.session, "permission_request");

    // A human answers — DENY is an answer too.
    expect(t.driver.resolvePermission(request.requestId, "deny", "u1")).toBe(true);
    expect(t.answered).toEqual(["src/a.ts"]);
    expect([...t.asked]).toEqual(["src/a.ts"]);

    const second = await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" });
    expect(second).toBe("allow");
    const requests = ofType(t.session, "permission_request");
    expect(requests).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(requests[1], "reason")).toBe(false);
  });

  it("does not re-ask after the path leaves the contested set and returns", async () => {
    const t = build(contestedOn("src/a.ts"));
    t.driver.setPermissionMode("auto", "u1");
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" });
    await wait(10);
    t.driver.resolvePermission(ofType(t.session, "permission_request")[0].requestId, "allow", "u1");

    // The collision clears…
    t.contested.delete("src/a.ts");
    expect(await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" })).toBe("allow");
    // …and comes back. `contestedAsked` is never cleared on set changes.
    t.contested.add("src/a.ts");
    expect(await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" })).toBe("allow");

    expect(ofType(t.session, "permission_request")).toHaveLength(3);
    expect(t.answered).toEqual(["src/a.ts"]);
  });

  it("a second write while the first gate is pending neither auto-approves nor records an answer", async () => {
    const t = build(contestedOn("src/a.ts"));
    t.driver.setPermissionMode("auto", "u1");
    let firstSettled = false;
    let secondSettled = false;
    void t.hooks
      .onPermissionRequest("Edit", { file_path: "src/a.ts" })
      .then(() => (firstSettled = true));
    await wait(10);
    void t.hooks
      .onPermissionRequest("Edit", { file_path: "src/a.ts" })
      .then(() => (secondSettled = true));
    await wait(10);

    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(ofType(t.session, "permission_decision")).toEqual([]);
    // Nothing is recorded until a human actually answers.
    expect([...t.asked]).toEqual([]);
    // The existing queuing behavior is unchanged: `pendingGateOf` surfaces the
    // OLDEST unanswered request, so only ONE contested gate is on the screen.
    const { pendingGateOf } = await import("../src/pendingGate.js");
    const gate = pendingGateOf(events(t.session));
    expect(gate).toEqual({
      toolName: "Edit",
      sinceTs: ofType(t.session, "permission_request")[0].ts,
      reason: "contested with session s9",
    });
  });
});

// ---------------------------------------------------------------------------
// Site 2 — agentDriver.ts allowAllPending
// ---------------------------------------------------------------------------

describe("site 2 — allowAllPending leaves a contested write pending", () => {
  it("leaves the contested one pending and allows every other pending request", async () => {
    const t = build(contestedOn("src/a.ts"));
    let contestedSettled = false;
    let otherSettled: string | null = null;
    void t.hooks
      .onPermissionRequest("Edit", { file_path: "src/a.ts" })
      .then(() => (contestedSettled = true));
    void t.hooks.onPermissionRequest("Bash", { command: "rm -rf build" }).then((d) => {
      otherSettled = d;
    });
    await wait(10);
    const [contestedReq, otherReq] = ofType(t.session, "permission_request");

    expect(t.driver.setPermissionMode("auto", "u1")).toEqual({ ok: true });
    await wait(20);

    // The other request was swept exactly as today.
    expect(otherSettled).toBe("allow");
    const decisions = ofType(t.session, "permission_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      requestId: otherReq.requestId,
      decision: "allow",
      userId: "u1",
      auto: true,
    });
    // The contested one is NOT resolved and NOT denied — it is still pending,
    // which means a human can still answer it.
    expect(contestedSettled).toBe(false);
    expect(t.driver.resolvePermission(contestedReq.requestId, "allow", "u1")).toBe(true);
    await wait(10);
    expect(contestedSettled).toBe(true);
    // Answering the LEFT-PENDING gate records the path, so the next sweep takes it.
    expect(t.answered).toEqual(["src/a.ts"]);
  });

  it("sweeps a contested write once the human has already answered for that file", async () => {
    const t = build({ ...contestedOn("src/a.ts"), asked: new Set(["src/a.ts"]) });
    let settled: string | null = null;
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" }).then((d) => {
      settled = d;
    });
    await wait(10);

    t.driver.setPermissionMode("auto", "u1");
    await wait(20);

    expect(settled).toBe("allow");
    expect(ofType(t.session, "permission_decision")).toHaveLength(1);
  });

  it("judges the batch against the CURRENT set, not the one current when each was queued", async () => {
    const t = build({ contested: new Set(), peers: new Map([["src/a.ts", ["s9"]]]) });
    let settled = false;
    void t.hooks
      .onPermissionRequest("Edit", { file_path: "src/a.ts" })
      .then(() => (settled = true));
    await wait(10);
    // Nothing was contested when the request was queued…
    expect(ofType(t.session, "permission_request")[0].reason).toBeUndefined();

    // …and it becomes contested before the sweep.
    t.contested.add("src/a.ts");
    t.driver.setPermissionMode("auto", "u1");
    await wait(20);

    expect(settled).toBe(false);
    expect(ofType(t.session, "permission_decision")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Site 3 — permissions.ts buildCanUseTool contained-write early allow
// ---------------------------------------------------------------------------

describe("site 3 — the contained-write auto-allow is suppressed", () => {
  it("falls through to the driver ask for a contested contained write in DEFAULT mode", async () => {
    const t = build(contestedOn("src/a.ts"));
    // Default mode — the site-1 auto branch is not even in play here.
    const pending = buildCanUseTool(t.hooks)("Edit", { file_path: "src/a.ts" }, opts());
    await wait(20);

    const requests = ofType(t.session, "permission_request");
    expect(requests).toHaveLength(1);
    expect(requests[0].reason).toBe("contested with session s9");
    expect(ofType(t.session, "permission_decision")).toEqual([]);

    t.driver.resolvePermission(requests[0].requestId, "allow", "u1");
    expect(await pending).toEqual({ behavior: "allow" });
    expect(t.answered).toEqual(["src/a.ts"]);
  });

  it("still early-allows an UNcontested contained write, with no gate at all", async () => {
    const t = build(contestedOn("src/a.ts"));
    const result = await buildCanUseTool(t.hooks)("Edit", { file_path: "src/b.ts" }, opts());
    expect(result).toEqual({ behavior: "allow" });
    expect(ofType(t.session, "permission_request")).toEqual([]);
  });

  it("reads the SAME getContested the driver was given — one source of truth", async () => {
    const t = build(contestedOn("src/a.ts"));
    expect(t.reads.contested).toBe(0);

    // Site 3, off the hooks object.
    void buildCanUseTool(t.hooks)("Edit", { file_path: "src/z.ts" }, opts());
    await wait(10);
    const afterSite3 = t.reads.contested;
    expect(afterSite3).toBeGreaterThan(0);

    // Site 1, off the driver's own field.
    t.driver.setPermissionMode("auto", "u1");
    await t.hooks.onPermissionRequest("Edit", { file_path: "src/z.ts" });
    const afterSite1 = t.reads.contested;
    expect(afterSite1).toBeGreaterThan(afterSite3);

    // Site 2, over the pending batch.
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/z.ts" });
    t.driver.setPermissionMode("default", "u1");
    t.driver.setPermissionMode("auto", "u1");
    await wait(10);
    expect(t.reads.contested).toBeGreaterThan(afterSite1);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("MPAI_CONTESTED_GATE", () => {
  it('"0" restores today\'s behavior byte-exactly at all THREE sites', async () => {
    process.env.MPAI_CONTESTED_GATE = "0";
    const t = build(contestedOn("src/a.ts"));

    // Site 3: the early allow fires, no gate.
    expect(
      await buildCanUseTool(t.hooks)("Edit", { file_path: "src/a.ts" }, opts()),
    ).toEqual({ behavior: "allow" });
    expect(ofType(t.session, "permission_request")).toEqual([]);

    // Site 2: a pending contested write is swept.
    let queued: string | null = null;
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" }).then((d) => {
      queued = d;
    });
    await wait(10);
    t.driver.setPermissionMode("auto", "u1");
    await wait(20);
    expect(queued).toBe("allow");

    // Site 1: a fresh contested write auto-approves.
    expect(await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" })).toBe("allow");

    // No reason anywhere, and nothing was ever recorded.
    for (const request of ofType(t.session, "permission_request")) {
      expect(Object.prototype.hasOwnProperty.call(request, "reason")).toBe(false);
    }
    expect([...t.asked]).toEqual([]);
    expect(t.answered).toEqual([]);
    expect(ofType(t.session, "permission_decision")).toHaveLength(2);
  });

  it("is ON for any other value, and when unset", async () => {
    for (const value of [undefined, "1", "", "00", "false", "off"]) {
      if (value === undefined) delete process.env.MPAI_CONTESTED_GATE;
      else process.env.MPAI_CONTESTED_GATE = value;
      const t = build(contestedOn("src/a.ts"));
      t.driver.setPermissionMode("auto", "u1");
      void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" });
      await wait(10);
      expect(ofType(t.session, "permission_decision")).toEqual([]);
      expect(ofType(t.session, "permission_request")[0].reason).toBe(
        "contested with session s9",
      );
    }
  });

  it("is read PER DECISION, not cached at construction", async () => {
    process.env.MPAI_CONTESTED_GATE = "0";
    const t = build(contestedOn("src/a.ts"));
    t.driver.setPermissionMode("auto", "u1");
    expect(await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" })).toBe("allow");

    delete process.env.MPAI_CONTESTED_GATE;
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" });
    await wait(10);
    expect(ofType(t.session, "permission_request")).toHaveLength(2);
    expect(ofType(t.session, "permission_decision")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bounds: unwired drivers, no workdir, non-write tools, escapes, peer strings
// ---------------------------------------------------------------------------

describe("bounds", () => {
  it("a driver with no collision wiring behaves exactly as today and never throws", async () => {
    const t = build({ ...contestedOn("src/a.ts"), wired: false });
    expect(t.hooks.getContested).toBeUndefined();
    expect(t.hooks.contestedAsked).toBeUndefined();
    t.driver.setPermissionMode("auto", "u1");

    expect(await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" })).toBe("allow");
    expect(
      await buildCanUseTool(t.hooks)("Edit", { file_path: "src/a.ts" }, opts()),
    ).toEqual({ behavior: "allow" });
    expect(t.driver.isDead).toBe(false);
  });

  it("a session with no workdir auto-approves exactly as today", async () => {
    const t = build({ ...contestedOn("src/a.ts"), workdir: undefined });
    t.driver.setPermissionMode("auto", "u1");
    expect(await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" })).toBe("allow");
    const [request] = ofType(t.session, "permission_request");
    expect(Object.prototype.hasOwnProperty.call(request, "reason")).toBe(false);
    expect([...t.asked]).toEqual([]);
  });

  it("never affects non-write tools, whatever their paths look like", async () => {
    const t = build(contestedOn("src/a.ts"));
    t.driver.setPermissionMode("auto", "u1");
    expect(await t.hooks.onPermissionRequest("Read", { file_path: "src/a.ts" })).toBe("allow");
    expect(await t.hooks.onPermissionRequest("Bash", { command: "cat src/a.ts" })).toBe("allow");
    for (const request of ofType(t.session, "permission_request")) {
      expect(Object.prototype.hasOwnProperty.call(request, "reason")).toBe(false);
    }
  });

  it("leaves the outside-worktree rule exactly as it was — it never widens what may be written", async () => {
    const t = build({
      contested: new Set(["../escape.ts", "src/a.ts"]),
      peers: new Map([["src/a.ts", ["s9"]]]),
    });
    // An escaping write was ALREADY driver-asked; it still is, with no reason.
    const pending = buildCanUseTool(t.hooks)("Write", { file_path: "../escape.ts" }, opts());
    await wait(10);
    const requests = ofType(t.session, "permission_request");
    expect(requests).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(requests[0], "reason")).toBe(false);
    t.driver.resolvePermission(requests[0].requestId, "deny", "u1");
    expect((await pending)?.behavior).toBe("deny");
    // …and nothing was recorded for a path the gate never claimed.
    expect(t.answered).toEqual([]);
  });

  it("interpolates the peer id verbatim and stays far under the 512-char gate-reason cap", async () => {
    const peer = "a".repeat(40); // the widest id `SLUG` admits
    const t = build({
      contested: new Set(["src/a.ts"]),
      peers: new Map([["src/a.ts", [peer, "b0"]]]),
    });
    t.driver.setPermissionMode("auto", "u1");
    void t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" });
    await wait(10);
    const reason = ofType(t.session, "permission_request")[0].reason;
    // First colliding session, ascending — `contestedSessionsFor` already sorts.
    expect(reason).toBe(`contested with session ${peer}`);
    expect(reason.length).toBeLessThan(512);
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("advisory bound: a contested write is never blocked — only asked, once", async () => {
    const t = build(contestedOn("src/a.ts"));
    t.driver.setPermissionMode("auto", "u1");
    const pending = buildCanUseTool(t.hooks)("Edit", { file_path: "src/a.ts" }, opts());
    await wait(10);
    const [request] = ofType(t.session, "permission_request");
    t.driver.resolvePermission(request.requestId, "allow", "u1");
    expect(await pending).toEqual({ behavior: "allow" });
    // Nothing the contested gate did produced a deny.
    expect(
      ofType(t.session, "permission_decision").filter((d) => d.decision === "deny"),
    ).toEqual([]);
    // And the same write is auto-approved from here on.
    expect(await t.hooks.onPermissionRequest("Edit", { file_path: "src/a.ts" })).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Server wiring — real server, real worktree, real contested state
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function seedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-gatecontested-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "gate@example.test");
  git(repo, "config", "user.name", "Gate Test");
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--no-gpg-sign", "-m", "seed");
  return repo;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));
const lastProject = (seen: any[]) => [...seen].reverse().find((m) => m.type === "project");
const rowOf = (seen: any[], id: string) =>
  lastProject(seen)?.sessions.find((s: any) => s.id === id);

/** A hub end that drives `contested` frames back at the laptop. */
function fakeHub() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  return {
    connect: () => ({
      send: () => {},
      close: () => {},
      on: (event: string, fn: (arg?: unknown) => void) => void handlers.set(event, fn),
    }),
    open: () => handlers.get("open")?.(),
    deliver: (frame: unknown) => handlers.get("message")?.(JSON.stringify(frame)),
  };
}

/** The write gate every server row drives. A prompt containing MEASURE just
 *  ends the turn (`result` → `turn_end` → the turn-boundary recompute), which
 *  is how a session that raises no gate of its own still gets a measured
 *  `touched` set for the local-derivation row. Anything else raises one Edit
 *  and leaves it open. */
function editRun(file: string): RunQuery {
  return async function* (prompts, hooks) {
    for await (const p of prompts) {
      const text = p.message.content.map((c) => c.text).join("");
      if (text.includes("MEASURE")) {
        yield { type: "result" } as never;
        continue;
      }
      void hooks.onPermissionRequest("Edit", { file_path: file });
      yield { type: "assistant", content: [{ type: "text", text: "asked" }] } as never;
    }
  };
}

describe("server wiring", () => {
  let close: (() => Promise<void>) | undefined;
  const sockets: WebSocket[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await close?.();
    close = undefined;
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    createdProjects.length = 0;
  });

  /** The watcher socket sees project snapshots; each session gets its OWN
   *  socket, because a connection holds exactly one joined session. */
  async function laptop(runQuery: RunQuery, withHub: boolean) {
    const repo = seedRepo();
    tmpDirs.push(repo);
    const hub = fakeHub();
    createdProjects.length = 0;
    const server = await startServer({
      port: 0,
      runQuery,
      workspace: new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees")),
      hub: withHub
        ? { url: "ws://hub.test", projectId: "default", connect: hub.connect }
        : undefined,
    });
    close = server.close;
    if (withHub) {
      hub.open();
      hub.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });
    }
    const ws = await connect(server.port);
    sockets.push(ws);
    const seen: any[] = [];
    ws.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    send(ws, { type: "watch_project", projectId: "default" });

    async function session(name: string) {
      send(ws, { type: "create_session", name });
      await vi.waitFor(() => {
        expect(seen.some((m) => m.type === "session_created" && m.sessionId === name)).toBe(
          true,
        );
      });
      const sock = await connect(server.port);
      sockets.push(sock);
      const own: any[] = [];
      sock.on("message", (raw) => own.push(JSON.parse(raw.toString())));
      send(sock, {
        type: "join",
        projectId: "default",
        sessionId: name,
        userId: `u-${name}`,
        name,
      });
      await vi.waitFor(() => {
        expect(own.some((m) => m.type === "event" && m.event?.type === "presence_join")).toBe(
          true,
        );
      });
      return { id: name, ws: sock, seen: own };
    }

    return { repo, hub, ws, seen, session };
  }

  const projectOf = () => {
    const matches = createdProjects.filter((p) => p.id === "default");
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };

  const eventsOf = (seen: any[]): any[] =>
    seen.filter((m) => m.type === "event").map((m) => m.event);

  it("withdrawal in hub mode: the gate names the hub's peer and the entry records the answer", async () => {
    const lap = await laptop(editRun("src/a.ts"), true);
    const work = await lap.session("work");
    const entry = projectOf().sessions.get("work")!;
    expect([...entry.contestedAsked]).toEqual([]);

    lap.hub.deliver({
      t: "contested",
      sessionId: "work",
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["work", "s9", "b2"] }],
    });
    send(work.ws, { type: "set_permission_mode", mode: "auto" });
    send(work.ws, { type: "prompt", text: "edit it" });

    // Auto-approve withdrew: a gate is on the project snapshot, with the reason.
    await vi.waitFor(
      () => {
        expect(rowOf(lap.seen, "work")?.pendingGate).toMatchObject({
          toolName: "Edit",
          // Ascending — `b2` sorts before `s9` and before `work`.
          reason: "contested with session b2",
        });
      },
      { timeout: 4000 },
    );
    expect([...entry.contestedAsked]).toEqual([]);

    const request = eventsOf(work.seen).find((e) => e?.type === "permission_request");
    expect(request.reason).toBe("contested with session b2");
    expect(eventsOf(work.seen).some((e) => e?.type === "permission_decision")).toBe(false);

    send(work.ws, { type: "permission", requestId: request.requestId, decision: "allow" });
    await vi.waitFor(() => {
      expect([...entry.contestedAsked]).toEqual(["src/a.ts"]);
    });
    // Once answered, the gate is gone — nothing was ever blocked.
    await vi.waitFor(() => {
      expect(rowOf(lap.seen, "work")?.pendingGate).toBeNull();
    });
    // …and the same file auto-approves from here on, at all three sites.
    send(work.ws, { type: "prompt", text: "edit it again" });
    await vi.waitFor(() => {
      expect(
        eventsOf(work.seen).filter((e) => e?.type === "permission_decision" && e.auto === true),
      ).toHaveLength(1);
    });
  });

  it("withdrawal from LOCAL derivation only: the reason names the real local peer", async () => {
    const lap = await laptop(editRun("shared.ts"), false);
    const one = await lap.session("one");
    const two = await lap.session("two");
    const project = projectOf();
    // Two real worktrees on the same repo, both changing the same file — the
    // only source of contest here is local derivation. No hub exists at all.
    for (const id of ["one", "two"]) {
      fs.writeFileSync(path.join(project.sessions.get(id)!.workdir!, "shared.ts"), `// ${id}\n`);
    }
    // `two` raises no gate of its own, so only a turn boundary measures it.
    send(two.ws, { type: "prompt", text: "MEASURE" });
    await vi.waitFor(
      () => {
        expect(rowOf(lap.seen, "two")?.touched).toEqual(["shared.ts"]);
      },
      { timeout: 6000 },
    );

    send(one.ws, { type: "set_permission_mode", mode: "auto" });
    send(one.ws, { type: "prompt", text: "edit it" });

    await vi.waitFor(
      () => {
        expect(rowOf(lap.seen, "one")?.pendingGate).toMatchObject({
          toolName: "Edit",
          reason: "contested with session two",
        });
      },
      { timeout: 6000 },
    );
  });

  it("a non-contested write is auto-approved by the real server exactly as today", async () => {
    const lap = await laptop(editRun("src/b.ts"), true);
    const work = await lap.session("work");
    lap.hub.deliver({
      t: "contested",
      sessionId: "work",
      paths: ["src/a.ts"],
      collisions: [{ path: "src/a.ts", sessionIds: ["work", "s9"] }],
    });
    send(work.ws, { type: "set_permission_mode", mode: "auto" });
    send(work.ws, { type: "prompt", text: "edit it" });

    await vi.waitFor(
      () => {
        expect(
          eventsOf(work.seen).some((e) => e?.type === "permission_decision" && e.auto === true),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
    const request = eventsOf(work.seen).find((e) => e?.type === "permission_request");
    expect(Object.prototype.hasOwnProperty.call(request, "reason")).toBe(false);
    expect(rowOf(lap.seen, "work")?.pendingGate).toBeNull();
    expect([...projectOf().sessions.get("work")!.contestedAsked]).toEqual([]);
  });
});
