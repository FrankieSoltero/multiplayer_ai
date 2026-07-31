import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The ONE seam this file mocks: every `git` child process the server spawns is
 *  recorded onto a shared timeline and then delegated to the REAL git binary.
 *  Nothing is stubbed out — the worktrees below are real git worktrees and the
 *  touched sets are real `git` output. The timeline exists only so the
 *  ORDERING rows ("the recompute ran BEFORE the gate decision") and the
 *  no-storm rows ("no git invocation at all") can be asserted mechanically
 *  instead of inferred. */
const probe = vi.hoisted(() => ({ timeline: [] as string[], argv: [] as string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: string[], opts: unknown) => {
      if (file === "git" && Array.isArray(args)) {
        // `-c core.quotePath=false status …` — name the subcommand, not the -c.
        probe.timeline.push(`git:${args[0] === "-c" ? args[2] : args[0]}`);
        probe.argv.push([...args]);
      }
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, opts);
    },
  };
});

import { execFileSync } from "node:child_process";
import { startServer } from "../src/server.js";
import { AgentDriver, type DriverHooks, type RunQuery } from "../src/agentDriver.js";
import { buildCanUseTool } from "../src/permissions.js";
import type { RelaySocket } from "../src/relay.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relayProtocol.js";
import { Session } from "../src/session.js";
import { WorkspaceManager } from "../src/workspace.js";

/** Only the invocations `touchedFiles` makes. `merge-base` is its first call,
 *  so ONE merge-base entry === ONE recompute; WorkspaceManager's provisioning
 *  git calls (`worktree add`, `rev-parse`, `remote`) never use it. */
const recomputes = (): number =>
  probe.timeline.filter((t) => t === "git:merge-base").length;

const touchedGitCalls = (): string[] =>
  probe.timeline.filter(
    (t) => t === "git:merge-base" || t === "git:diff" || t === "git:status",
  );

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Real repo on `main` with one seed commit. */
function seedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-srvtouched-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "touched@example.test");
  git(repo, "config", "user.name", "Touched Test");
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

function collect(ws: WebSocket, sink: any[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Latest project snapshot this socket has been pushed. */
const lastProject = (seen: any[]) => [...seen].reverse().find((m) => m.type === "project");
const rowOf = (seen: any[], id: string) =>
  lastProject(seen)?.sessions.find((s: any) => s.id === id);

/** One fake hub end: every up-frame this laptop emitted, IN ORDER, plus the
 *  levers to drive the handshake. Same shape as `relay.test.ts`'s fakeSocket —
 *  the real `Relay` runs, only the wire is fake, so this exercises the actual
 *  publish path (`publishEvent` / `publishFacts` → `emit`). */
function fakeHub() {
  const sent: any[] = [];
  const handlers = new Map<string, (arg?: unknown) => void>();
  const socket: RelaySocket = {
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {},
    on: (event, fn) => void handlers.set(event, fn),
  };
  return {
    sent,
    connect: () => socket,
    open: () => handlers.get("open")?.(),
    deliver: (frame: unknown) => handlers.get("message")?.(JSON.stringify(frame)),
  };
}

/** A fake stream that ends the turn (`result` → `turn_end`) per prompt. */
const turnRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield { type: "result" } as never;
  }
};

let close: (() => Promise<void>) | undefined;
const sockets: WebSocket[] = [];
const tmpDirs: string[] = [];
let appendSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  probe.timeline.length = 0;
  probe.argv.length = 0;
  // Every session event lands on the SAME timeline as the git invocations, so
  // "the recompute ran before the permission_request append" is one array
  // comparison rather than a wall-clock guess. Session.append is the single
  // producer of every session event, so one spy covers all of them.
  const original = Session.prototype.append;
  appendSpy = vi
    .spyOn(Session.prototype, "append")
    .mockImplementation(function (this: any, event: any) {
      probe.timeline.push(`append:${event.type}`);
      return original.call(this, event);
    }) as never;
});

afterEach(async () => {
  appendSpy?.mockRestore();
  appendSpy = undefined;
  for (const ws of sockets.splice(0)) ws.close();
  await close?.();
  close = undefined;
  delete process.env.AGENT_WORKDIR_ROOT;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Real server over a real socket on a real repo: create the session (which
 *  provisions a real worktree through Task 2a's WorkspaceManager), join it,
 *  and hand back the driving socket plus the worktree path. */
async function liveSession(opts: {
  runQuery: RunQuery;
  repo: string;
  baseRef?: string;
  name?: string;
}): Promise<{ ws: WebSocket; seen: any[]; sessionId: string; workdir: string; port: number }> {
  const worktrees = path.join(opts.repo, ".mpai", "worktrees");
  const server = await startServer({
    port: 0,
    runQuery: opts.runQuery,
    workspace: new WorkspaceManager(opts.repo, worktrees),
  });
  close = server.close;
  const ws = await connect(server.port);
  sockets.push(ws);
  const seen: any[] = [];
  collect(ws, seen);
  send(ws, { type: "watch_project", projectId: "default" });
  const name = opts.name ?? "work";
  send(ws, { type: "create_session", name, baseRef: opts.baseRef });
  await vi.waitFor(() => {
    expect(seen.some((m) => m.type === "session_created")).toBe(true);
  });
  const sessionId = seen.find((m) => m.type === "session_created").sessionId;
  send(ws, { type: "join", projectId: "default", sessionId, userId: "u1", name: "Ana" });
  await vi.waitFor(() => {
    expect(rowOf(seen, sessionId)).toBeTruthy();
  });
  return { ws, seen, sessionId, workdir: path.join(worktrees, "default", sessionId), port: server.port };
}

describe("turn-boundary recompute", () => {
  it("recomputes touched on turn_end and the project push carries it", async () => {
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: turnRun, repo });
    fs.writeFileSync(path.join(live.workdir, "feature.ts"), "export const a = 1;\n");

    send(live.ws, { type: "prompt", text: "go" });

    await vi.waitFor(
      () => {
        expect(rowOf(live.seen, live.sessionId)?.touched).toEqual(["feature.ts"]);
      },
      { timeout: 4000 },
    );
  });

  it("runs git against the persisted baseRef, never the default branch", async () => {
    const repo = seedRepo();
    tmpDirs.push(repo);
    // A REAL `origin/dev` remote-tracking ref that diverges from `main`: the
    // repo's default branch stays `main`, so a call site that reached for
    // defaultBranch() (or a literal "main") produces a different merge-base
    // and a different touched set.
    git(repo, "checkout", "-b", "dev-src");
    fs.writeFileSync(path.join(repo, "only-on-dev.txt"), "dev\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--no-gpg-sign", "-m", "dev-only");
    const devSha = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/dev", devSha);
    git(repo, "checkout", "main");

    const live = await liveSession({ runQuery: turnRun, repo, baseRef: "origin/dev" });
    probe.argv.length = 0;

    send(live.ws, { type: "prompt", text: "go" });
    await vi.waitFor(
      () => {
        expect(probe.argv.some((a) => a[0] === "merge-base")).toBe(true);
      },
      { timeout: 4000 },
    );

    // Recorded argv, not just the subcommand: this row is about WHICH ref.
    expect(probe.argv.find((a) => a[0] === "merge-base")).toEqual([
      "merge-base",
      "origin/dev",
      "HEAD",
    ]);
  });

  it("makes NO git call when the session has a workdir but a null baseRef", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-nobase-"));
    tmpDirs.push(root);
    process.env.AGENT_WORKDIR_ROOT = root;
    const server = await startServer({ port: 0, runQuery: turnRun });
    close = server.close;
    const ws = await connect(server.port);
    sockets.push(ws);
    const seen: any[] = [];
    collect(ws, seen);
    send(ws, { type: "watch_project", projectId: "default" });
    send(ws, { type: "join", projectId: "default", sessionId: "solo", userId: "u1", name: "Ana" });
    await vi.waitFor(() => {
      expect(rowOf(seen, "solo")).toBeTruthy();
    });
    probe.timeline.length = 0;

    send(ws, { type: "prompt", text: "go" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:turn_end");
    });
    await wait(50);

    expect(touchedGitCalls()).toEqual([]);
    expect(rowOf(seen, "solo")?.touched).toBeNull();
  });

  it("makes NO git call when the session has no workdir at all", async () => {
    const server = await startServer({ port: 0, runQuery: turnRun });
    close = server.close;
    const ws = await connect(server.port);
    sockets.push(ws);
    const seen: any[] = [];
    collect(ws, seen);
    send(ws, { type: "watch_project", projectId: "default" });
    send(ws, { type: "join", projectId: "default", sessionId: "solo", userId: "u1", name: "Ana" });
    await vi.waitFor(() => {
      expect(rowOf(seen, "solo")).toBeTruthy();
    });
    probe.timeline.length = 0;

    send(ws, { type: "prompt", text: "go" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:turn_end");
    });
    await wait(50);

    expect(touchedGitCalls()).toEqual([]);
    expect(rowOf(seen, "solo")?.touched).toBeNull();
  });

  it("keeps the previous touched value on a git failure and logs once per session", async () => {
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: turnRun, repo });
    fs.writeFileSync(path.join(live.workdir, "kept.ts"), "1\n");
    send(live.ws, { type: "prompt", text: "one" });
    await vi.waitFor(
      () => {
        expect(rowOf(live.seen, live.sessionId)?.touched).toEqual(["kept.ts"]);
      },
      { timeout: 4000 },
    );

    // Break git for this session only: the worktree directory disappears, so
    // every later invocation throws (the Task 1 contract).
    fs.rmSync(live.workdir, { recursive: true, force: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      send(live.ws, { type: "prompt", text: "two" });
      await vi.waitFor(() => {
        expect(
          stderr.mock.calls.some((c) => String(c[0]).startsWith("[touched] session=")),
        ).toBe(true);
      });
      send(live.ws, { type: "prompt", text: "three" });
      await wait(300);
      const lines = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("[touched] session="));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        `[touched] session=${live.sessionId} recompute failed: ${lines[0].split("recompute failed: ")[1]}`,
      );
      expect(lines[0].endsWith("\n")).toBe(true);
    } finally {
      stderr.mockRestore();
    }

    // Stale beats absent: the pre-failure value is still what the project push
    // carries.
    expect(rowOf(live.seen, live.sessionId)?.touched).toEqual(["kept.ts"]);
  });

  it("does not recompute on ordinary events — a Read tool_call triggers no git", async () => {
    const readRun: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield {
          type: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }],
        } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: readRun, repo });
    probe.timeline.length = 0;

    send(live.ws, { type: "prompt", text: "look" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:tool_call");
    });
    await wait(100);

    expect(touchedGitCalls()).toEqual([]);
  });
});

describe("hub uplink — touched ships with its own turn", () => {
  it("emits the fresh touched to the hub for the turn_end itself, with no later event", async () => {
    const repo = seedRepo();
    tmpDirs.push(repo);
    const hub = fakeHub();
    const worktrees = path.join(repo, ".mpai", "worktrees");
    const server = await startServer({
      port: 0,
      runQuery: turnRun,
      workspace: new WorkspaceManager(repo, worktrees),
      hub: {
        url: "ws://hub.test",
        projectId: "default",
        uplinkId: "lap-1",
        connect: hub.connect,
      },
    });
    close = server.close;
    hub.open();
    hub.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });

    const ws = await connect(server.port);
    sockets.push(ws);
    const seen: any[] = [];
    collect(ws, seen);
    send(ws, { type: "watch_project", projectId: "default" });
    send(ws, { type: "create_session", name: "beta", baseRef: "main" });
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created")).toBe(true);
    });
    const sessionId = seen.find((m) => m.type === "session_created").sessionId;
    send(ws, { type: "join", projectId: "default", sessionId, userId: "u1", name: "Ana" });
    await vi.waitFor(() => {
      expect(rowOf(seen, sessionId)).toBeTruthy();
    });
    // Quiesce until the uplink has been silent for a FULL throttle window.
    // Load-bearing, and the reason a first draft of this test passed against
    // the defect: a trailing push left over from the join fires ~1s later, and
    // if it lands after turn_end it carries the fresh set and masks the bug
    // exactly the way the walk's "a later trivial event flushed it" did. After
    // this loop `lastPush` is >1s old, so the prompt below pushes IMMEDIATELY
    // (stale facts) and leaves NO timer queued when the turn ends.
    for (let n = -1; n !== hub.sent.length; ) {
      n = hub.sent.length;
      await wait(1200);
    }

    fs.writeFileSync(path.join(worktrees, "default", sessionId, "beta.ts"), "export const b = 2;\n");
    hub.sent.length = 0;
    send(ws, { type: "prompt", text: "go" });

    await vi.waitFor(() => {
      expect(
        hub.sent.some(
          (f) =>
            f.t === "publish" && f.events?.some((e: any) => e.type === "turn_end"),
        ),
      ).toBe(true);
    });

    // From here the client sends NOTHING. The hub must still learn the new
    // touched set from this turn's own facts frame. Before the fix the last
    // facts frame the hub ever saw was the pre-recompute one and this timed
    // out — the collision signal was one event stale.
    await vi.waitFor(
      () => {
        const facts = hub.sent.filter((f) => f.t === "facts" && f.sessionId === sessionId);
        expect(facts.at(-1)?.facts.touched).toEqual(["beta.ts"]);
      },
      { timeout: 3000 },
    );

    const turnAt = hub.sent.findIndex(
      (f) => f.t === "publish" && f.events?.some((e: any) => e.type === "turn_end"),
    );
    const factsAt = hub.sent.findIndex(
      (f) => f.t === "facts" && f.sessionId === sessionId && f.facts.touched?.includes("beta.ts"),
    );
    expect(factsAt).toBeGreaterThan(turnAt);
    // The turn's own frame — not a later one. Nothing but this turn's push may
    // sit between the turn_end and the facts that carry its touched set.
    expect(
      hub.sent
        .slice(turnAt + 1, factsAt)
        .filter((f) => f.t === "publish").length,
    ).toBe(0);
    // 20s: the quiesce loop alone spends >2s waiting out the push throttle.
  }, 20000);
});

describe("pre-gate recompute at the decision sites", () => {
  it("site 1: recomputes before the auto-mode permission_request append", async () => {
    const editRun: RunQuery = async function* (prompts, hooks) {
      for await (const _p of prompts) {
        await hooks.onPermissionRequest("Edit", { file_path: "README.md" });
        yield { type: "result" } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: editRun, repo });
    send(live.ws, { type: "set_permission_mode", mode: "auto" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:permission_mode_change");
    });
    probe.timeline.length = 0;

    send(live.ws, { type: "prompt", text: "edit it" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:permission_request");
    });

    const gitAt = probe.timeline.indexOf("git:merge-base");
    const requestAt = probe.timeline.indexOf("append:permission_request");
    expect(gitAt).toBeGreaterThanOrEqual(0);
    // Strictly BEFORE: a recompute hung off the event subscriber runs during
    // (never before) this append, and fails here.
    expect(gitAt).toBeLessThan(requestAt);
  });

  it("site 1: a Read permission request triggers no recompute", async () => {
    const readAskRun: RunQuery = async function* (prompts, hooks) {
      for await (const _p of prompts) {
        await hooks.onPermissionRequest("Read", { file_path: "README.md" });
        yield { type: "assistant", content: [{ type: "text", text: "done" }] } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: readAskRun, repo });
    send(live.ws, { type: "set_permission_mode", mode: "auto" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:permission_mode_change");
    });
    probe.timeline.length = 0;

    send(live.ws, { type: "prompt", text: "read it" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:permission_request");
    });
    await wait(100);

    expect(touchedGitCalls()).toEqual([]);
  });

  it("site 2: exactly ONE recompute before allowAllPending, however many are pending", async () => {
    const twoWritesRun: RunQuery = async function* (prompts, hooks) {
      for await (const _p of prompts) {
        void hooks.onPermissionRequest("Write", { file_path: "/tmp/outside-a.txt" });
        void hooks.onPermissionRequest("Edit", { file_path: "/tmp/outside-b.txt" });
        yield { type: "assistant", content: [{ type: "text", text: "waiting" }] } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: twoWritesRun, repo });
    send(live.ws, { type: "prompt", text: "write it" });
    await vi.waitFor(() => {
      expect(
        probe.timeline.filter((t) => t === "append:permission_request").length,
      ).toBe(2);
    });
    probe.timeline.length = 0;

    send(live.ws, { type: "set_permission_mode", mode: "auto" });
    await vi.waitFor(() => {
      expect(
        probe.timeline.filter((t) => t === "append:permission_decision").length,
      ).toBe(2);
    });
    await wait(50);

    expect(recomputes()).toBe(1);
    expect(probe.timeline.indexOf("git:merge-base")).toBeLessThan(
      probe.timeline.indexOf("append:permission_decision"),
    );
  });

  it("site 2: no recompute when every pending request is a non-write tool", async () => {
    const bashAskRun: RunQuery = async function* (prompts, hooks) {
      for await (const _p of prompts) {
        void hooks.onPermissionRequest("Bash", { command: "rm -rf /tmp/x" });
        yield { type: "assistant", content: [{ type: "text", text: "waiting" }] } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: bashAskRun, repo });
    send(live.ws, { type: "prompt", text: "run it" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:permission_request");
    });
    probe.timeline.length = 0;

    send(live.ws, { type: "set_permission_mode", mode: "auto" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:permission_decision");
    });
    await wait(50);

    expect(touchedGitCalls()).toEqual([]);
  });

  it("site 3: recomputes before buildCanUseTool's contained-write early-allow", async () => {
    const canUseRun: RunQuery = async function* (prompts, hooks) {
      const canUseTool = buildCanUseTool(hooks);
      for await (const _p of prompts) {
        probe.timeline.push("probe:canUseTool-enter");
        const result = await canUseTool(
          "Edit",
          { file_path: "README.md" },
          { signal: new AbortController().signal } as never,
        );
        probe.timeline.push(`probe:canUseTool-exit:${(result as any).behavior}`);
        yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: canUseRun, repo });
    probe.timeline.length = 0;

    send(live.ws, { type: "prompt", text: "edit it" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("probe:canUseTool-exit:allow");
    });

    const enter = probe.timeline.indexOf("probe:canUseTool-enter");
    const exit = probe.timeline.indexOf("probe:canUseTool-exit:allow");
    const gitAt = probe.timeline.indexOf("git:merge-base");
    // No permission_request event exists on this path at all — an
    // event-subscriber recompute cannot cover this site.
    expect(probe.timeline.slice(enter, exit)).not.toContain("append:permission_request");
    expect(gitAt).toBeGreaterThan(enter);
    expect(gitAt).toBeLessThan(exit);
  });

  it("sites 3→1 in one chain: ONE git spawn, not two", async () => {
    // A write OUTSIDE the worktree: site 3 recomputes, fails the containment
    // test, and falls straight through to site 1's hook — which recomputes
    // again. This is the PRODUCTION chain (`buildCanUseTool` →
    // `onPermissionRequest`), and it is synchronous end to end: nothing can
    // append to the session between the two calls, so the second call can only
    // ever re-measure what the first just measured. Both sites still CALL the
    // recompute; the recompute itself declines to shell out when nothing has
    // been appended since it last succeeded.
    const chainRun: RunQuery = async function* (prompts, hooks) {
      const canUseTool = buildCanUseTool(hooks);
      for await (const _p of prompts) {
        const result = await canUseTool(
          "Write",
          { file_path: "/tmp/mpai-outside-chain.txt" },
          { signal: new AbortController().signal } as never,
        );
        probe.timeline.push(`probe:chain:${(result as any).behavior}`);
        yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: chainRun, repo });
    send(live.ws, { type: "set_permission_mode", mode: "auto" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("append:permission_mode_change");
    });
    probe.timeline.length = 0;

    send(live.ws, { type: "prompt", text: "write outside" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("probe:chain:allow");
    });
    await wait(50);

    // Both sites ran (the write reached site 1's auto-approval), and the touched
    // set was measured — once.
    expect(probe.timeline).toContain("append:permission_request");
    expect(recomputes()).toBe(1);
  });

  it("site 3: an auto-approved Bash command triggers no recompute", async () => {
    const bashRun: RunQuery = async function* (prompts, hooks) {
      const canUseTool = buildCanUseTool(hooks);
      for await (const _p of prompts) {
        const result = await canUseTool(
          "Bash",
          { command: "git status" },
          { signal: new AbortController().signal } as never,
        );
        probe.timeline.push(`probe:bash:${(result as any).behavior}`);
        yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as never;
      }
    };
    const repo = seedRepo();
    tmpDirs.push(repo);
    const live = await liveSession({ runQuery: bashRun, repo });
    probe.timeline.length = 0;

    send(live.ws, { type: "prompt", text: "status" });
    await vi.waitFor(() => {
      expect(probe.timeline).toContain("probe:bash:allow");
    });

    expect(touchedGitCalls()).toEqual([]);
  });

  it("a driver constructed without the hook neither recomputes nor throws", async () => {
    let captured: DriverHooks | undefined;
    const capturingRun: RunQuery = (_prompts, hooks) => {
      captured = hooks;
      return (async function* () {
        await new Promise((r) => setTimeout(r, 500));
      })() as never;
    };
    const session = new Session("no-hook");
    // Positional construction WITHOUT the collision wiring — exactly what the
    // pre-existing call sites and test fakes do.
    const driver = new AgentDriver(session, capturingRun, "/tmp/does-not-matter");
    probe.timeline.length = 0;

    expect(captured?.recomputeTouched).toBeUndefined();
    const pending = captured!.onPermissionRequest("Edit", { file_path: "x.ts" });
    expect(pending).toBeInstanceOf(Promise);
    await wait(20);
    expect(touchedGitCalls()).toEqual([]);
    expect(driver.isDead).toBe(false);
  });
});
