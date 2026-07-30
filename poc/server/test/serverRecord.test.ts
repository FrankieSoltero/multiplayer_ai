import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import type { RunQuery, SdkMessage } from "../src/agentDriver.js";
import { signSession, SESSION_COOKIE } from "../src/auth.js";

/** Standalone-server `get_record` (spec §4.3). The wire pair is byte-shape
 *  identical to the hub's (`{type:"get_record", projectId}` →
 *  `{type:"record", projectId, record}`); the only deliberate asymmetry is the
 *  gate — the hub requires `identify`, this side reuses `denyUnauthed()` like
 *  `watch_project` (spec §8a.1 owner ruling). */

/** Echoes, then ends the SDK cycle — the `result` message is what makes the
 *  driver append `turn_end` (agentDriver.ts:758), which is what closes a turn
 *  in the record. */
const echoRun: RunQuery = async function* (prompts) {
  for await (const prompt of prompts) {
    yield {
      type: "assistant",
      content: [{ type: "text", text: `echo: ${prompt.message.content[0].text}` }],
    };
    yield { type: "result" } as SdkMessage;
  }
};

function connect(port: number, cookie?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}`,
      cookie ? { headers: { cookie } } : undefined,
    );
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collect(ws: WebSocket, sink: any[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWorkspace() {
  return {
    provision(projectId: string, slug: string) {
      return { ok: true as const, workdir: `/tmp/wt/${projectId}/${slug}` };
    },
    defaultBranch: () => "main",
    repoKey: () => "local:test:000000000000",
  };
}

const AUTH = {
  clientId: "cid",
  clientSecret: "csecret",
  sessionSecret: "sekrit",
  allowlist: "ana",
};

/** Suite-output hygiene — same reason as `server.test.ts`: these tests drive
 *  real turns to `turn_end` against a fake workspace whose worktree paths do
 *  not exist, so the turn-boundary recompute logs its once-per-session
 *  `[touched] session=… recompute failed: …` line. The log stays asserted
 *  verbatim in `serverTouched.test.ts`; this PASSTHROUGH spy drops only those
 *  chunks and forwards every other stderr write untouched. */
let stderrFilter: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  const realWrite = process.stderr.write.bind(process.stderr) as (...a: any[]) => boolean;
  stderrFilter = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: any, ...rest: any[]) =>
      String(chunk).startsWith("[touched] session=") ? true : realWrite(chunk, ...rest)) as never);
});
afterEach(() => {
  stderrFilter?.mockRestore();
  stderrFilter = undefined;
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** Drives real turns on `sessionId` of `projectId` from a real socket: join
 *  (first joiner drives), then one prompt per text, each awaited to its
 *  `turn_end` so the turns land in the log closed and in order. */
async function driveTurns(
  port: number,
  projectId: string,
  sessionId: string,
  userId: string,
  texts: string[],
): Promise<WebSocket> {
  const ws = await connect(port);
  const seen: any[] = [];
  collect(ws, seen);
  ws.send(JSON.stringify({ type: "join", projectId, sessionId, userId, name: "Ana", lastSeq: 0 }));
  await vi.waitFor(() =>
    expect(seen.some((m) => m.type === "event" && m.event.type === "presence_join")).toBe(true),
  );
  const ends = () => seen.filter((m) => m.type === "event" && m.event.type === "turn_end").length;
  for (const [i, text] of texts.entries()) {
    ws.send(JSON.stringify({ type: "prompt", text }));
    await vi.waitFor(() => expect(ends()).toBe(i + 1));
  }
  expect(seen.some((m) => m.type === "error")).toBe(false);
  return ws;
}

describe("standalone get_record", () => {
  it("answers a project with sessions, stamping this machine on every session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: fakeWorkspace() });
    close = server.close;
    const member = await driveTurns(server.port, "demo", "s1", "u1", [
      "ship the record",
      "now the panel",
    ]);

    const asker = await connect(server.port);
    const seen: any[] = [];
    collect(asker, seen);
    asker.send(JSON.stringify({ type: "get_record", projectId: "demo" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "record")).toBe(true));

    const reply = seen.find((m) => m.type === "record");
    expect(reply.projectId).toBe("demo");
    expect(reply.record.projectId).toBe("demo");
    expect(reply.record.sessions.map((s: any) => s.sessionId)).toEqual(["s1"]);
    // This laptop is the one machine it can honestly report — the same value
    // the project snapshot's `machines` entry carries.
    expect(reply.record.sessions.map((s: any) => s.machineId)).toEqual([
      "local:test:000000000000",
    ]);
    const session = reply.record.sessions[0];
    expect(session.repoKey).toBe("local:test:000000000000");
    // Straight off `sessionFactsOf` — the same row the project snapshot shows.
    expect(session.lifecycle).toBe("open");
    expect(session.closedBy).toBe(null);
    expect(session.turns.length).toBe(2);
    // Turn 1 opens on the session's own bookkeeping (skill_roster /
    // presence_join / control_change) and only then carries the prompt — and
    // its driver is still the prompter, because the driver keys on the turn's
    // FIRST `user_message`, not its literal first event (spec §8a ruling 9).
    // This is exactly the real-log shape that ruling exists for. `record.ts`'s
    // rule, not this handler's: the point here is that the handler hands the
    // WHOLE log to `projectRecordFrom` and publishes its answer unaltered.
    expect(session.turns[0]).toMatchObject({
      turn: 1,
      driver: "u1",
      prompt: "ship the record",
      inProgress: false,
    });
    expect(session.turns[1]).toMatchObject({
      turn: 2,
      driver: "u1",
      prompt: "now the panel",
      inProgress: false,
    });
    expect(reply.record.rollup).toEqual({
      perUser: [{ userId: "u1", turnsDriven: 2, approvalsGiven: 0, denialsGiven: 0 }],
      totalTurns: 2,
      totalSessions: 1,
    });
    expect(seen.some((m) => m.type === "error")).toBe(false);
    member.close();
    asker.close();
  });

  it("reports machineId null when this server has no machine identity", async () => {
    // No workspace, no injected identity: `machineView()` is null, so there is
    // no machine to name and the record says so rather than inventing one.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const member = await driveTurns(server.port, "demo", "s1", "u1", ["no machine here"]);

    const asker = await connect(server.port);
    const seen: any[] = [];
    collect(asker, seen);
    asker.send(JSON.stringify({ type: "get_record", projectId: "demo" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "record")).toBe(true));

    const reply = seen.find((m) => m.type === "record");
    expect(reply.record.sessions.map((s: any) => s.machineId)).toEqual([null]);
    member.close();
    asker.close();
  });

  it("rejects a projectId that is missing or fails SLUG, with the hub's string", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "get_record", projectId: "BAD SLUG" }));
    ws.send(JSON.stringify({ type: "get_record" }));
    ws.send(JSON.stringify({ type: "get_record", projectId: 7 }));
    await wait(60);

    const errors = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toEqual([
      "get_record requires a valid projectId",
      "get_record requires a valid projectId",
      "get_record requires a valid projectId",
    ]);
    expect(seen.some((m) => m.type === "record")).toBe(false);
    ws.close();
  });

  it("answers an unknown project with an empty record and grows nothing", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: fakeWorkspace() });
    close = server.close;
    const member = await driveTurns(server.port, "demo", "s1", "u1", ["real work"]);

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "get_record", projectId: "ghost" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "record")).toBe(true));

    const reply = seen.find((m) => m.type === "record");
    expect(reply).toEqual({
      type: "record",
      projectId: "ghost",
      record: {
        projectId: "ghost",
        sessions: [],
        rollup: { perUser: [], totalTurns: 0, totalSessions: 0 },
      },
    });

    // The peek discipline (server.ts:907): a read never grows the registry, or
    // an unauthenticated caller could loop `get_record` and fill the Map.
    ws.send(JSON.stringify({ type: "list_projects" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "projects")).toBe(true));
    const listed = seen.find((m) => m.type === "projects");
    expect(listed.projects.map((p: any) => p.id)).toEqual(["demo"]);
    member.close();
    ws.close();
  });

  it("refuses an unauthenticated get_record and discloses no record", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "get_record", projectId: "default" }));
    await wait(60);

    // Same gate, same string as `watch_project` (server.ts:948) — the
    // hub/standalone gate asymmetry is the recorded owner ruling (spec §8a.1).
    expect(seen.some((m) => m.type === "error" && m.message === "authentication required")).toBe(
      true,
    );
    expect(seen.some((m) => m.type === "record")).toBe(false);
    ws.close();
  });

  it("answers a signed-in allowlisted user", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const ws = await connect(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "get_record", projectId: "default" }));
    await vi.waitFor(() => expect(seen.some((m) => m.type === "record")).toBe(true));
    expect(seen.some((m) => m.type === "error")).toBe(false);
    ws.close();
  });
});
