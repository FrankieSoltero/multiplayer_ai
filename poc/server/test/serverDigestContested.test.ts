import { describe, it, expect, vi, afterEach } from "vitest";

/** `digestFor` is a non-exported local inside `startServer`'s closure and its
 *  output is never returned to the client — it rides into the agent as the
 *  prompt's context block. So this suite reads it the only two ways it exists:
 *  the text handed to `runQuery`, and the `MPAI_DIGEST_DUMP` stderr line.
 *
 *  The `Project` the server builds is captured at construction (the seam
 *  `serverContested.test.ts` and `project.test.ts` already use) because nothing
 *  on the wire carries `touched` or `contestedFrame` for a peer session. */
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

import type { Project } from "../src/project.js";
import type { RunQuery } from "../src/agentDriver.js";
import { startServer } from "../src/server.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relayProtocol.js";

const REPO = "github.com/acme/api";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every prompt text the agent was actually handed, context block included. */
const prompts: string[] = [];
const capturingRun: RunQuery = async function* (incoming) {
  for await (const p of incoming) {
    prompts.push(String((p.message.content as { text: string }[])[0].text));
  }
};

/** A hub end that records what the laptop sent and drives frames back. */
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

describe("digestFor — contested lines and the dump gate", () => {
  let close: (() => Promise<void>) | undefined;
  const conns: { close: () => void }[] = [];

  afterEach(async () => {
    for (const conn of conns.splice(0)) conn.close();
    await close?.();
    close = undefined;
    createdProjects.length = 0;
    prompts.length = 0;
    delete process.env.MPAI_DIGEST_DUMP;
    vi.restoreAllMocks();
  });

  /** A live laptop with an uplink and the named sessions joined, each by its
   *  own user so every session has a resolvable driver. */
  async function laptop(
    sessions: { id: string; userId: string; name: string }[],
  ): Promise<{ hub: ReturnType<typeof fakeHub>; project: Project; send: (id: string, msg: unknown) => void }> {
    const hub = fakeHub();
    createdProjects.length = 0;
    const server = await startServer({
      port: 0,
      runQuery: capturingRun,
      hub: { url: "ws://hub.test", projectId: "default", connect: hub.connect },
    });
    close = server.close;
    hub.open();
    hub.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });

    const byId = new Map<string, { handleMessage: (m: unknown) => void }>();
    for (const s of sessions) {
      const conn = server.createConnection({ mode: "direct", send: () => {} });
      conns.push(conn);
      conn.handleMessage({
        type: "join",
        projectId: "default",
        sessionId: s.id,
        userId: s.userId,
        name: s.name,
      });
      byId.set(s.id, conn);
    }
    const matches = createdProjects.filter((p) => p.id === "default");
    expect(matches).toHaveLength(1);
    const project = matches[0]!;
    for (const s of sessions) expect(project.sessions.has(s.id)).toBe(true);
    return {
      hub,
      project,
      send: (id, msg) => byId.get(id)!.handleMessage(msg as never),
    };
  }

  /** Give a local session a repo identity and a changed-file set — the two
   *  facts local collision derivation runs on. */
  function touch(project: Project, id: string, touched: string[] | null): void {
    const entry = project.sessions.get(id)!;
    entry.repoKey = REPO;
    entry.touched = touched;
  }

  /** The `<teammates>` contested lines carried into the last prompt. */
  function contestedLines(): string[] {
    expect(prompts.length).toBeGreaterThan(0);
    return prompts
      .at(-1)!
      .split("\n")
      .filter((l) => l.includes("has also changed"));
  }

  it("names a peer from LOCAL derivation alone (solo-mode source)", async () => {
    const { project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    touch(project, "alpha", ["notes.txt", "src/z.ts"]);
    touch(project, "beta", ["notes.txt"]);

    send("beta", { type: "prompt", text: "what files are contested right now?" });
    await wait(50);

    expect(contestedLines()).toEqual([
      "  session alpha (driven by Ana) has also changed: notes.txt",
    ]);
    // Thesis bound: the peer's own prompt text never crosses over.
    expect(prompts.at(-1)).not.toContain("src/z.ts");
  });

  it("names a peer from the HUB FRAME alone, with no local overlap at all", async () => {
    const { hub, project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    // Nothing local collides: alpha has no touched set on this laptop.
    touch(project, "alpha", null);
    touch(project, "beta", ["src/other.ts"]);
    hub.deliver({
      t: "contested",
      sessionId: "beta",
      paths: ["notes.txt"],
      collisions: [{ path: "notes.txt", sessionIds: ["beta", "alpha"] }],
    });

    send("beta", { type: "prompt", text: "go" });
    await wait(50);

    expect(contestedLines()).toEqual([
      "  session alpha (driven by Ana) has also changed: notes.txt",
    ]);
  });

  it("unions both sources onto one ascending line per peer", async () => {
    const { hub, project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    // The frame's path sorts AFTER the locally derived one, so a line that
    // merely echoed the union's insertion order (frame first, then local)
    // would print them the wrong way round.
    touch(project, "alpha", ["src/a-local.ts"]);
    touch(project, "beta", ["src/a-local.ts"]);
    hub.deliver({
      t: "contested",
      sessionId: "beta",
      paths: ["src/z-frame.ts"],
      collisions: [{ path: "src/z-frame.ts", sessionIds: ["beta", "alpha"] }],
    });

    send("beta", { type: "prompt", text: "go" });
    await wait(50);

    expect(contestedLines()).toEqual([
      "  session alpha (driven by Ana) has also changed: src/a-local.ts, src/z-frame.ts",
    ]);
  });

  it("names a frame peer that has NO session on this laptop (cross-machine)", async () => {
    // The case the down-frame exists for (spec §6a): `remote-9` runs on another
    // machine, so it is in no local map and can be named ONLY by the frame.
    const { hub, project, send } = await laptop([{ id: "beta", userId: "u2", name: "Ben" }]);
    touch(project, "beta", ["notes.txt"]);
    hub.deliver({
      t: "contested",
      sessionId: "beta",
      paths: ["notes.txt"],
      collisions: [{ path: "notes.txt", sessionIds: ["beta", "remote-9"] }],
    });

    send("beta", { type: "prompt", text: "go" });
    await wait(50);

    // Whole prompt pinned: with no local peers there is no `<teammates>` block
    // at all today, so this fails loudly rather than on a substring.
    expect(prompts.at(-1)).toBe(
      [
        "<teammates>",
        '- session "remote-9": no declared intent yet',
        "  session remote-9 has also changed: notes.txt",
        "</teammates>",
        "",
        "go",
      ].join("\n"),
    );
    // The frame carries no names, and none is invented.
    expect(prompts.at(-1)).not.toContain("driven by");
    expect(prompts.at(-1)).not.toContain("undefined");
  });

  it("names local and remote contesting peers side by side, each once", async () => {
    const { hub, project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    touch(project, "alpha", ["notes.txt"]);
    touch(project, "beta", ["notes.txt"]);
    hub.deliver({
      t: "contested",
      sessionId: "beta",
      paths: ["notes.txt", "src/w.ts"],
      collisions: [
        // `alpha` IS local — it must not be named twice (once resolved, once raw).
        { path: "notes.txt", sessionIds: ["beta", "alpha", "remote-9"] },
        { path: "src/w.ts", sessionIds: ["beta", "remote-2"] },
      ],
    });

    send("beta", { type: "prompt", text: "go" });
    await wait(50);

    expect(contestedLines()).toEqual([
      "  session alpha (driven by Ana) has also changed: notes.txt",
      // Remote peers follow the local ones, ascending by id.
      "  session remote-2 has also changed: src/w.ts",
      "  session remote-9 has also changed: notes.txt",
    ]);
    expect(prompts.at(-1)!.split("\n").filter((l) => l.includes("alpha"))).toHaveLength(2);
  });

  it("degrades to the bare form when the peer's driver has left", async () => {
    const { project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    touch(project, "alpha", ["notes.txt"]);
    touch(project, "beta", ["notes.txt"]);
    // Ana walks away from alpha; the session (and its changed files) stays.
    send("alpha", { type: "leave_session" });
    expect(project.sessions.get("alpha")!.session.driverId).toBeNull();

    send("beta", { type: "prompt", text: "go" });
    await wait(50);

    expect(contestedLines()).toEqual(["  session alpha has also changed: notes.txt"]);
    expect(prompts.at(-1)).not.toContain("driven by");
    expect(prompts.at(-1)).not.toContain("undefined");
  });

  it("leaves the block untouched when nothing is contested", async () => {
    const { project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    touch(project, "alpha", ["src/a.ts"]);
    touch(project, "beta", ["src/b.ts"]);

    send("beta", { type: "prompt", text: "go" });
    await wait(50);

    expect(contestedLines()).toEqual([]);
    expect(prompts.at(-1)).toBe(
      ['<teammates>', '- session "alpha": no declared intent yet', "</teammates>", "", "go"].join(
        "\n",
      ),
    );
  });

  it("writes NOTHING to stderr when MPAI_DIGEST_DUMP is unset", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const { project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    touch(project, "alpha", ["notes.txt"]);
    touch(project, "beta", ["notes.txt"]);

    send("beta", { type: "prompt", text: "go" });
    await wait(50);

    // The digest itself did build — the gate is what is off, not the feature.
    expect(contestedLines()).toHaveLength(1);
    expect(written.filter((w) => w.includes("[digest-dump]"))).toEqual([]);
  });

  it("emits exactly one [digest-dump] line naming the session when the gate is on", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    process.env.MPAI_DIGEST_DUMP = "1";

    const { project, send } = await laptop([
      { id: "alpha", userId: "u1", name: "Ana" },
      { id: "beta", userId: "u2", name: "Ben" },
    ]);
    touch(project, "alpha", ["notes.txt"]);
    touch(project, "beta", ["notes.txt"]);

    send("beta", { type: "prompt", text: "what files are contested right now?" });
    await wait(50);

    const dumps = written.filter((w) => w.startsWith("[digest-dump] "));
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toMatch(/^\[digest-dump\] session=beta /);
    expect(dumps[0].endsWith("\n")).toBe(true);
    // ONE line: the whole digest is JSON-escaped, newlines included.
    expect(dumps[0].split("\n")).toHaveLength(2);
    const payload = JSON.parse(dumps[0].slice("[digest-dump] session=beta ".length));
    expect(payload).toContain("notes.txt");
    expect(payload).toContain("session alpha (driven by Ana) has also changed: notes.txt");
    // The dump is the digest verbatim — never the prompt the human typed.
    expect(payload).not.toContain("what files are contested right now?");
  });
});
