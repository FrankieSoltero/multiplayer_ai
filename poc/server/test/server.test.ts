import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import type { RunQuery, SdkMessage } from "../src/agentDriver.js";
import { PluginStore, type CloneFn } from "../src/pluginStore.js";
import { signSession, SESSION_COOKIE } from "../src/auth.js";
import { MAX_FRAME_BYTES, RELAY_PROTOCOL_VERSION, parseUpFrame } from "../src/relayProtocol.js";

const echoRun: RunQuery = async function* (prompts) {
  for await (const prompt of prompts) {
    yield {
      type: "assistant",
      content: [{ type: "text", text: `echo: ${prompt.message.content[0].text}` }],
    };
  }
};

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function connectWithCookie(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { cookie } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collect(ws: WebSocket, sink: unknown[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWorkspace() {
  const calls: { projectId: string; slug: string; baseRef: string }[] = [];
  return {
    calls,
    provision(projectId: string, slug: string, baseRef: string) {
      calls.push({ projectId, slug, baseRef });
      return { ok: true as const, workdir: `/tmp/wt/${projectId}/${slug}` };
    },
    defaultBranch: () => "main",
    repoKey: () => "local:test:000000000000",
  };
}

function keyedWorkspace(key: string) {
  const calls: { projectId: string; slug: string; baseRef: string }[] = [];
  return {
    calls,
    provision(projectId: string, slug: string, baseRef: string) {
      calls.push({ projectId, slug, baseRef });
      return { ok: true as const, workdir: `/tmp/wt/${key}/${projectId}/${slug}` };
    },
    defaultBranch: () => "main",
    repoKey: () => key,
  };
}

/** Suite-output hygiene. The turn-boundary recompute (spec §3.2) runs on every
 *  `turn_end`, and the fake workspaces in this file hand out worktree paths
 *  that never exist on disk — so git fails and the server writes its
 *  once-per-session `[touched] session=… recompute failed: …` line. That log is
 *  specified behavior and stays asserted verbatim in `serverTouched.test.ts`;
 *  here it is pure noise, so this PASSTHROUGH spy drops only those chunks and
 *  forwards every other stderr write untouched. Registered before the teardown
 *  hooks below so it is restored last. */
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

describe("WebSocket hub", () => {
  it("broadcasts live events and replays the log to late joiners", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws1 = await connect(server.port);
    const seen1: any[] = [];
    collect(ws1, seen1);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    ws1.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(200);

    // Late joiner replays the full log
    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(200);

    const types1 = seen1.map((m) => m.event?.type);
    expect(types1).toContain("user_message");
    expect(types1).toContain("agent_text_delta");
    const types2 = seen2.map((m) => m.event?.type);
    // Replay includes everything ws1 saw, plus ws2's own join
    expect(types2).toContain("user_message");
    expect(types2).toContain("agent_text_delta");
    expect(types2).toContain("presence_join");
    ws1.close();
    ws2.close();
  });

  it("sends a `joined` ack before any replayed event (PRD §10.4b)", async () => {
    // Solo parity with the hub: the joining connection is told it is in BEFORE
    // the log replays, so a browser can distinguish success from a dead socket.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(JSON.stringify({ type: "join", sessionId: "js1", userId: "u1", name: "Ana" }));
    ws1.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(200);

    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "js1", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(200);

    expect(seen2[0]).toEqual({ type: "joined", sessionId: "js1", projectId: "default" });
    const joinedAt = seen2.findIndex((m) => m.type === "joined");
    const firstEventAt = seen2.findIndex((m) => m.type === "event");
    expect(joinedAt).toBe(0);
    expect(firstEventAt).toBeGreaterThan(joinedAt);
    ws1.close();
    ws2.close();
  });

  it("sends `joined` on an empty-session join (PRD §10.4b)", async () => {
    // The silence this fixes: the first joiner replays nothing, so the ack is
    // the only success signal it gets.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "jempty", userId: "u1", name: "Ana" }));
    await wait(100);

    expect(seen[0]).toEqual({ type: "joined", sessionId: "jempty", projectId: "default" });
    ws.close();
  });

  it("sends NO `joined` when the join is refused (PRD §10.4b)", async () => {
    // Refusals keep today's error surface — no success signal on a rejected join.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "Bad Slug!", userId: "u1", name: "Ana" }));
    await wait(100);

    expect(seen.some((m) => m.type === "error")).toBe(true);
    expect(seen.some((m) => m.type === "joined")).toBe(false);
    ws.close();
  });

  it("rejects prompts from non-drivers and allows them after take_wheel", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s2", userId: "u1", name: "Ana" }));
    await wait(50);

    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "s2", userId: "u2", name: "Ben" }));
    await wait(50);

    ws2.send(JSON.stringify({ type: "prompt", text: "not my turn" }));
    await wait(100);
    expect(seen2.some((m) => m.type === "error")).toBe(true);

    ws2.send(JSON.stringify({ type: "take_wheel" }));
    ws2.send(JSON.stringify({ type: "prompt", text: "my turn now" }));
    await wait(200);
    const eventTypes = seen2.map((m) => m.event?.type);
    expect(eventTypes).toContain("control_change");
    expect(eventTypes).toContain("user_message");
    ws1.close();
    ws2.close();
  });

  it("rejects a second join on the same connection and delivers subsequent events exactly once", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s3", userId: "u1", name: "Ana" }));
    await wait(50);

    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "s3", userId: "u2", name: "Ben" }));
    await wait(50);

    // Second join on the already-joined ws2 connection should be rejected.
    ws2.send(JSON.stringify({ type: "join", sessionId: "s3", userId: "u2", name: "Ben" }));
    await wait(50);
    expect(seen2.some((m) => m.type === "error" && m.message === "already joined")).toBe(true);

    // Confirm no duplicate subscription: a subsequent event arrives exactly once.
    seen2.length = 0;
    ws2.send(JSON.stringify({ type: "take_wheel" }));
    await wait(100);
    const controlChanges = seen2.filter((m) => m.event?.type === "control_change");
    expect(controlChanges.length).toBe(1);

    ws1.close();
    ws2.close();
  });

  it("treats a negative lastSeq as 0 and replays the full log", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s4", userId: "u1", name: "Ana" }));
    ws1.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(200);

    const wsZero = await connect(server.port);
    const seenZero: any[] = [];
    collect(wsZero, seenZero);
    wsZero.send(
      JSON.stringify({ type: "join", sessionId: "s4", userId: "u2", name: "Ben", lastSeq: 0 })
    );
    await wait(150);

    const wsNeg = await connect(server.port);
    const seenNeg: any[] = [];
    collect(wsNeg, seenNeg);
    wsNeg.send(
      JSON.stringify({ type: "join", sessionId: "s4", userId: "u3", name: "Cy", lastSeq: -1 })
    );
    await wait(150);

    // Both should have replayed the same prior events (excluding each joiner's own presence_join).
    const priorZero = seenZero
      .filter((m) => m.event && m.event.type !== "presence_join")
      .map((m) => m.event.type);
    const priorNeg = seenNeg
      .filter((m) => m.event && m.event.type !== "presence_join")
      .map((m) => m.event.type);
    expect(priorNeg).toEqual(priorZero);
    expect(priorNeg).toContain("user_message");
    expect(priorNeg).toContain("agent_text_delta");

    ws1.close();
    wsZero.close();
    wsNeg.close();
  });

  it("gates game_score and appends valid scores with the sender's identity", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "arc", userId: "u1", name: "Ana" }));
    await wait(50);

    ws.send(JSON.stringify({ type: "game_score", game: "breakout", score: 10 }));
    ws.send(JSON.stringify({ type: "game_score", game: "dino", score: 3.5 }));
    ws.send(JSON.stringify({ type: "game_score", game: "dino", score: 0 }));
    ws.send(JSON.stringify({ type: "game_score", game: "dino", score: 100000 }));
    ws.send(JSON.stringify({ type: "game_score", game: "dino", score: 120, userId: "someone-else" }));
    await wait(100);

    const errors = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toHaveLength(4);
    const scores = seen.filter((m) => m.event?.type === "game_score");
    expect(scores).toHaveLength(1);
    // userId comes from the connection, not the message payload
    expect(scores[0].event).toMatchObject({ game: "dino", score: 120, userId: "u1" });
    ws.close();
  });
});

describe("project awareness", () => {
  const intentEchoRun: RunQuery = async function* (prompts, hooks) {
    for await (const prompt of prompts) {
      hooks.onIntent("Migrating auth to JWT");
      yield {
        type: "assistant",
        content: [
          { type: "text", text: `echo: ${prompt.message.content[0].text}` },
        ],
      };
    }
  };

  it("rejects invalid project/session slugs", async () => {
    const server = await startServer({ port: 0, runQuery: intentEchoRun });
    close = server.close;
    const ws1 = await connect(server.port);
    const seen: any[] = [];
    collect(ws1, seen);
    ws1.send(
      JSON.stringify({
        type: "join",
        projectId: "demo",
        sessionId: "../oops",
        userId: "u1",
        name: "Ana",
      }),
    );
    await wait(100);
    expect(seen.some((m) => m.type === "error")).toBe(true);
    ws1.close();
  });

  it("pushes project snapshots with intent across sessions and injects the digest", async () => {
    const server = await startServer({ port: 0, runQuery: intentEchoRun });
    close = server.close;

    // Ana joins session "ana" in project "demo" and prompts (agent declares intent)
    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(
      JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }),
    );
    wsAna.send(JSON.stringify({ type: "prompt", text: "migrate auth" }));
    await wait(200);

    // Ben joins a DIFFERENT session in the same project
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(
      JSON.stringify({ type: "join", projectId: "demo", sessionId: "ben", userId: "u2", name: "Ben" }),
    );
    await wait(200);

    // Ben's immediate project snapshot includes Ana's session and intent
    const projectMsgs = seenBen.filter((m) => m.type === "project");
    expect(projectMsgs.length).toBeGreaterThan(0);
    const anaEntry = projectMsgs
      .at(-1)
      .sessions.find((s: any) => s.id === "ana");
    expect(anaEntry.intent).toBe("Migrating auth to JWT");

    // Ben prompts: the digest (with Ana's intent) is injected into HIS prompt
    wsBen.send(JSON.stringify({ type: "prompt", text: "add rate limiting" }));
    await wait(300);
    const benEcho = seenBen
      .map((m) => m.event)
      .find((e) => e?.type === "agent_text_delta" && e.text.includes("echo:"));
    expect(benEcho.text).toContain("<teammates>");
    expect(benEcho.text).toContain("Migrating auth to JWT");
    expect(benEcho.text).toContain("add rate limiting");
    // Ben's own transcript logs the raw text only
    const benUserMsg = seenBen
      .map((m) => m.event)
      .find((e) => e?.type === "user_message");
    expect(benUserMsg.text).toBe("add rate limiting");

    wsAna.close();
    wsBen.close();
  });

  it("pushes a fresh project snapshot when control_change fires on another session (INTERESTING coverage)", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    // Ana joins session "sess1" in project "px1" (becomes driver automatically).
    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(
      JSON.stringify({ type: "join", projectId: "px1", sessionId: "sess1", userId: "u1", name: "Ana" }),
    );
    await wait(50);

    // Ben joins a DIFFERENT session ("sess2") in the same project and watches it.
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(
      JSON.stringify({ type: "join", projectId: "px1", sessionId: "sess2", userId: "u2", name: "Ben" }),
    );
    await wait(50);

    // Clear the 1000ms push-throttle window so the upcoming control_change
    // produces an unambiguous, attributable push.
    await wait(1100);
    const priorProjectCount = seenBen.filter((m) => m.type === "project").length;

    // A THIRD client joins session "sess1" and takes the wheel there.
    const ws3 = await connect(server.port);
    collect(ws3, []);
    ws3.send(
      JSON.stringify({ type: "join", projectId: "px1", sessionId: "sess1", userId: "u3", name: "Cara" }),
    );
    await wait(50);
    ws3.send(JSON.stringify({ type: "take_wheel" }));

    // Allow for the throttle's trailing push to fire.
    await wait(1200);

    const projectMsgs = seenBen.filter((m) => m.type === "project");
    expect(projectMsgs.length).toBeGreaterThan(priorProjectCount);
    const sess1Entry = projectMsgs.at(-1).sessions.find((s: any) => s.id === "sess1");
    expect(sess1Entry.driverName).toBe("Cara");

    ws1.close();
    wsBen.close();
    ws3.close();
  });
});

describe("pending gate on the project snapshot", () => {
  // Asks for permission and then waits: the request stays unanswered unless a
  // test explicitly decides it.
  const bashAskRun: RunQuery = async function* (prompts, hooks) {
    for await (const prompt of prompts) {
      const decision = await hooks.onPermissionRequest("Bash", { command: "npm run build" });
      yield { type: "assistant", content: [{ type: "text", text: `bash: ${decision}` }] };
    }
  };

  /** The most recent project snapshot this socket has been pushed. */
  const lastProject = (seen: any[]) =>
    [...seen].reverse().find((m) => m.type === "project");

  it("reports a gate that nobody has answered", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);

    // Ben watches the project from a different session in it.
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ben", userId: "u2", name: "Ben" }));
    await wait(200);

    const entry = lastProject(seenBen)?.sessions.find((s: any) => s.id === "ana");
    // `reason: null` is pinned end-to-end, not just at the unit: this task ships
    // the gate-reason CARRIER only, so a gate opened by the real server through
    // the real snapshot path must still name no reason. Task 8b is where a
    // non-null one first appears here.
    expect(entry.pendingGate).toEqual({
      toolName: "Bash", sinceTs: expect.any(String), reason: null,
    });

    wsAna.close();
    wsBen.close();
  });

  it("clears the gate once the driver decides", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);

    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ben", userId: "u2", name: "Ben" }));
    await wait(200);

    const req = seenAna.map((m) => m.event).find((e) => e?.type === "permission_request");
    wsAna.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "allow" }));
    // permission_decision is in INTERESTING, but schedulePush throttles project
    // snapshots to PROJECT_PUSH_INTERVAL_MS (1000ms) with a trailing push — so
    // the cleared gate arrives on the next push, not immediately. A shorter wait
    // reads the pre-decision snapshot and fails misleadingly.
    await wait(1400);

    const entry = lastProject(seenBen)?.sessions.find((s: any) => s.id === "ana");
    expect(entry.pendingGate).toBeNull();

    wsAna.close();
    wsBen.close();
  });
});

describe("driver approval gate over the wire", () => {
  const bashAskRun: RunQuery = async function* (prompts, hooks) {
    for await (const prompt of prompts) {
      const decision = await hooks.onPermissionRequest("Bash", {
        command: "npm run build",
      });
      yield {
        type: "assistant",
        content: [{ type: "text", text: `bash: ${decision}` }],
      };
    }
  };

  it("broadcasts the request, rejects non-driver decisions, accepts the driver's", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", sessionId: "p1", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);

    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", sessionId: "p1", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(200);

    // Both the live watcher and the late joiner see the pending request.
    const reqAna = seenAna.map((m) => m.event).find((e) => e?.type === "permission_request");
    const reqBen = seenBen.map((m) => m.event).find((e) => e?.type === "permission_request");
    expect(reqAna?.toolName).toBe("Bash");
    expect(reqBen?.requestId).toBe(reqAna?.requestId);

    // Ben (not driving) may not decide.
    wsBen.send(JSON.stringify({ type: "permission", requestId: reqAna.requestId, decision: "allow" }));
    await wait(100);
    expect(seenBen.some((m) => m.type === "error" && /driver/.test(m.message))).toBe(true);

    // Ana (driver) decides; everyone sees the decision and the agent proceeds.
    wsAna.send(JSON.stringify({ type: "permission", requestId: reqAna.requestId, decision: "allow" }));
    await wait(200);
    const decision = seenBen.map((m) => m.event).find((e) => e?.type === "permission_decision");
    expect(decision).toMatchObject({ requestId: reqAna.requestId, decision: "allow", userId: "u1" });
    const echoed = seenBen.map((m) => m.event).find((e) => e?.type === "agent_text_delta");
    expect(echoed?.text).toBe("bash: allow");

    // Replaying the same decision is rejected.
    wsAna.send(JSON.stringify({ type: "permission", requestId: reqAna.requestId, decision: "deny" }));
    await wait(100);
    expect(seenAna.some((m) => m.type === "error" && /unknown or already-decided/.test(m.message))).toBe(true);

    wsAna.close();
    wsBen.close();
  });

  it("lets a NEW driver decide a request raised under the previous driver", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", sessionId: "p2", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);
    const req = seenAna.map((m) => m.event).find((e) => e?.type === "permission_request");
    expect(req).toBeTruthy();

    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", sessionId: "p2", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(100);
    wsBen.send(JSON.stringify({ type: "take_wheel" }));
    await wait(100);
    wsBen.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "deny" }));
    await wait(200);

    const decision = seenBen.map((m) => m.event).find((e) => e?.type === "permission_decision");
    expect(decision).toMatchObject({ requestId: req.requestId, decision: "deny", userId: "u2" });
    const echoed = seenBen.map((m) => m.event).find((e) => e?.type === "agent_text_delta");
    expect(echoed?.text).toBe("bash: deny");

    wsAna.close();
    wsBen.close();
  });

  it("rejects malformed permission messages", async () => {
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;
    const ws1 = await connect(server.port);
    const seen: any[] = [];
    collect(ws1, seen);
    ws1.send(JSON.stringify({ type: "join", sessionId: "p3", userId: "u1", name: "Ana" }));
    await wait(50);
    ws1.send(JSON.stringify({ type: "permission", requestId: 5, decision: "allow" }));
    ws1.send(JSON.stringify({ type: "permission", requestId: "r1", decision: "maybe" }));
    await wait(100);
    const errors = seen.filter((m) => m.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    ws1.close();
  });
});

// §8.6 cycle 2: ALWAYS over the wire — driver-gated exactly like approve/deny,
// recorded with decider + rule, refused when the gate holds no suggestion.
describe("permission always over the wire", () => {
  const suggestedAskRun: RunQuery = async function* (prompts, hooks) {
    for await (const prompt of prompts) {
      const decision = await hooks.onPermissionRequest(
        "Bash",
        { command: "npm test" },
        undefined,
        {
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
              behavior: "allow",
              destination: "userSettings",
            },
          ],
        },
      );
      yield { type: "assistant", content: [{ type: "text", text: `bash: ${decision}` }] };
    }
  };

  it("driver always is recorded with decider + rule; non-driver always is refused", async () => {
    const server = await startServer({ port: 0, runQuery: suggestedAskRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", sessionId: "pa1", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "prompt", text: "test it" }));
    await wait(200);

    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", sessionId: "pa1", userId: "u2", name: "Ben", lastSeq: 0 }));
    await wait(200);

    const req = seenAna.map((m) => m.event).find((e) => e?.type === "permission_request");
    expect(req?.ruleSuggestion).toBe("Bash(npm test:*)");

    // Ben (not driving) may not ALWAYS either — same gate as approve/deny.
    wsBen.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "always" }));
    await wait(100);
    expect(seenBen.some((m) => m.type === "error" && /driver/.test(m.message))).toBe(true);

    // Ana (driver) ALWAYS-decides; the decision event carries the rule display.
    wsAna.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "always" }));
    await wait(200);
    const decision = seenBen.map((m) => m.event).find((e) => e?.type === "permission_decision");
    expect(decision).toMatchObject({
      requestId: req.requestId,
      decision: "always",
      userId: "u1",
      rule: "Bash(npm test:*)",
    });
    const echoed = seenBen.map((m) => m.event).find((e) => e?.type === "agent_text_delta");
    expect(echoed?.text).toBe("bash: always");

    wsAna.close();
    wsBen.close();
  });

  it("always on a gate with no suggestion is refused with a named error", async () => {
    const plainAskRun: RunQuery = async function* (prompts, hooks) {
      for await (const prompt of prompts) {
        const decision = await hooks.onPermissionRequest("Bash", { command: "rm -rf build" });
        yield { type: "assistant", content: [{ type: "text", text: `bash: ${decision}` }] };
      }
    };
    const server = await startServer({ port: 0, runQuery: plainAskRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "pa2", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "prompt", text: "clean" }));
    await wait(200);

    const req = seen.map((m) => m.event).find((e) => e?.type === "permission_request");
    expect(req && "ruleSuggestion" in req).toBe(false);
    ws.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "always" }));
    await wait(100);
    expect(seen.some((m) => m.type === "error" && /cannot always-allow/.test(m.message))).toBe(true);
    // Refused like a malformed decision: no decision event, gate still pending.
    expect(seen.map((m) => m.event).some((e) => e?.type === "permission_decision")).toBe(false);

    ws.close();
  });
});

describe("set_model", () => {
  it("driver can switch; non-driver and bad model rejected", async () => {
    // run fake: reply then result, stream stays open (same shape as resultRun above)
    const run: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) {
          yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as SdkMessage;
          yield { type: "result" } as SdkMessage;
        }
      })();
      return Object.assign(gen, { setModel: async (_m: string) => {} });
    };
    const server = await startServer({ port: 0, runQuery: run });
    const a = await connect(server.port);
    const b = await connect(server.port);
    const aSink: any[] = []; const bSink: any[] = [];
    collect(a, aSink); collect(b, bSink);
    a.send(JSON.stringify({ type: "join", sessionId: "m1", userId: "ua", name: "ana", lastSeq: 0 }));
    b.send(JSON.stringify({ type: "join", sessionId: "m1", userId: "ub", name: "ben", lastSeq: 0 }));
    await vi.waitFor(() => expect(bSink.some((m) => m.type === "event" && m.event.type === "presence_join" && m.event.userId === "ub")).toBe(true));

    b.send(JSON.stringify({ type: "set_model", model: "sonnet" })); // ub is not driving
    await vi.waitFor(() => expect(bSink.some((m) => m.type === "error" && /driver/.test(m.message))).toBe(true));

    a.send(JSON.stringify({ type: "set_model", model: "gpt-5" })); // invalid key
    await vi.waitFor(() => expect(aSink.some((m) => m.type === "error" && /opus\|sonnet\|haiku/.test(m.message))).toBe(true));

    a.send(JSON.stringify({ type: "set_model", model: "sonnet" })); // ua drives (first join)
    await vi.waitFor(() => expect(aSink.some((m) => m.type === "event" && m.event.type === "model_change" && m.event.model === "sonnet" && m.event.userId === "ua")).toBe(true));
    a.close(); b.close(); await server.close();
  });

  it("rejects an inherited-property model key (prototype pollution guard)", async () => {
    // "toString" is `in MODELS` (inherited from Object.prototype) but is not
    // an own key, so MODELS["toString"] is not a valid model entry. isModelKey
    // must reject it the same as any other invalid key.
    const run: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) {
          yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as SdkMessage;
          yield { type: "result" } as SdkMessage;
        }
      })();
      return Object.assign(gen, { setModel: async (_m: string) => {} });
    };
    const server = await startServer({ port: 0, runQuery: run });
    close = server.close;
    const a = await connect(server.port);
    const aSink: any[] = [];
    collect(a, aSink);
    a.send(JSON.stringify({ type: "join", sessionId: "m2", userId: "ua", name: "ana", lastSeq: 0 }));
    await wait(50);

    a.send(JSON.stringify({ type: "set_model", model: "toString" }));
    await vi.waitFor(() => expect(aSink.some((m) => m.type === "error" && /opus\|sonnet\|haiku/.test(m.message))).toBe(true));
    a.close();
  });
});

describe("identity on join and pre-join peek", () => {
  it("join forwards validated glyph/color; junk is dropped", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    const ws = await connect(server.port);
    const sink: any[] = []; collect(ws, sink);
    ws.send(JSON.stringify({ type: "join", sessionId: "g1", userId: "u1", name: "ana", lastSeq: 0, glyph: "▲", color: "#61afef" }));
    await vi.waitFor(() => expect(sink.some((m) => m.type === "event" && m.event.type === "presence_join" && m.event.glyph === "▲" && m.event.color === "#61afef")).toBe(true));
    ws.close();
    const ws2 = await connect(server.port);
    const sink2: any[] = []; collect(ws2, sink2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "g2", userId: "u2", name: "ben", lastSeq: 0, glyph: "<script>", color: "red" }));
    await vi.waitFor(() => {
      const ev = sink2.find((m) => m.type === "event" && m.event.type === "presence_join" && m.event.userId === "u2");
      expect(ev).toBeTruthy();
      expect(ev.event.glyph).toBeUndefined();
      expect(ev.event.color).toBeUndefined();
    });
    ws2.close(); await server.close();
  });

  it("peek returns a project snapshot without joining", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    const member = await connect(server.port);
    member.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "p1", userId: "u1", name: "ana", lastSeq: 0 }));
    const peeker = await connect(server.port);
    const sink: any[] = []; collect(peeker, sink);
    peeker.send(JSON.stringify({ type: "peek", projectId: "demo" }));
    await vi.waitFor(() => {
      const snap = sink.find((m) => m.type === "project");
      expect(snap).toBeTruthy();
      expect(snap.sessions.map((s: any) => s.id)).toContain("p1");
    });
    peeker.send(JSON.stringify({ type: "peek", projectId: "nope" }));
    await vi.waitFor(() => expect(sink.filter((m) => m.type === "project").length).toBeGreaterThanOrEqual(2));
    member.close(); peeker.close(); await server.close();
  });
});

describe("skill roster", () => {
  it("replays a skill_roster event to every joiner", async () => {
    // v6c: the roster now seeds from the plugin registry scan rather than
    // AGENT_SKILLS (retired) — a fake-clone plugin stands in for a real one.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-roster-"));
    const clone: CloneFn = async (_url, dest) => {
      for (const name of ["alpha", "beta"]) {
        const p = path.join(dest, "skills", name, "SKILL.md");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `---\nname: ${name}\n---\n`);
      }
    };
    const store = new PluginStore(root, clone);
    await store.add("default", "https://github.com/x/tools", "u0");
    const server = await startServer({ port: 0, runQuery: echoRun, plugins: store });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "s-roster", userId: "u1", name: "Ana" }));
    await wait(100);
    const roster = seen.find((m) => m.event?.type === "skill_roster");
    expect(roster.event.skills).toEqual([
      { name: "tools:alpha", description: "" },
      { name: "tools:beta", description: "" },
    ]);
    ws.close();
  });
});

describe("skill suggest/decide", () => {
  // v6c: roster is plugin-seeded (AGENT_SKILLS retired) — a fake-clone
  // plugin named "tools" provides a single skill "tools:alpha".
  async function rosterServer() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-suggest-"));
    const clone: CloneFn = async (_url, dest) => {
      const p = path.join(dest, "skills", "alpha", "SKILL.md");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "---\nname: alpha\n---\n");
    };
    const store = new PluginStore(root, clone);
    await store.add("default", "https://github.com/x/tools", "u0");
    const server = await startServer({ port: 0, runQuery: echoRun, plugins: store });
    close = server.close;
    return server;
  }

  it("driver slash-run: one suggest_skill message yields suggest + run decision + agent activity", async () => {
    const server = await rosterServer();
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "sk1", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "suggest_skill", skill: "tools:alpha", args: "the login flow" }));
    await wait(200);
    const types = seen.map((m) => m.event?.type);
    expect(types).toContain("skill_suggest");
    expect(types).toContain("skill_decision");
    const decision = seen.find((m) => m.event?.type === "skill_decision").event;
    expect(decision.decision).toBe("run");
    expect(decision.userId).toBe("u1");
    expect(types).toContain("agent_text_delta"); // the enqueued skill prompt ran
    expect(types).not.toContain("user_message"); // skill runs are recorded by the suggest/decision pair, not a user row
    ws.close();
  });

  it("passenger suggestion waits; driver run decision executes it; non-driver decisions rejected", async () => {
    const server = await rosterServer();
    const wsA = await connect(server.port);
    const seenA: any[] = [];
    collect(wsA, seenA);
    wsA.send(JSON.stringify({ type: "join", sessionId: "sk2", userId: "u1", name: "Ana" }));
    await wait(50);
    const wsB = await connect(server.port);
    const seenB: any[] = [];
    collect(wsB, seenB);
    wsB.send(JSON.stringify({ type: "join", sessionId: "sk2", userId: "u2", name: "Ben" }));
    await wait(50);

    wsB.send(JSON.stringify({ type: "suggest_skill", skill: "tools:alpha", args: "" }));
    await wait(150);
    const suggest = seenA.find((m) => m.event?.type === "skill_suggest").event;
    expect(suggest.userId).toBe("u2");
    expect(seenA.some((m) => m.event?.type === "skill_decision")).toBe(false);

    // Passenger cannot decide their own suggestion
    wsB.send(JSON.stringify({ type: "decide_skill", suggestId: suggest.suggestId, decision: "run" }));
    await wait(100);
    expect(seenB.some((m) => m.type === "error" && /driver/.test(m.message))).toBe(true);

    // Driver runs it — the decision event is attributed to the DECIDER (u1);
    // the suggest event above carries the suggester (u2).
    wsA.send(JSON.stringify({ type: "decide_skill", suggestId: suggest.suggestId, decision: "run" }));
    await wait(200);
    const decision = seenA.find((m) => m.event?.type === "skill_decision").event;
    expect(decision).toMatchObject({ suggestId: suggest.suggestId, decision: "run", userId: "u1" });
    expect(seenA.map((m) => m.event?.type)).toContain("agent_text_delta");

    // Already decided → error
    wsA.send(JSON.stringify({ type: "decide_skill", suggestId: suggest.suggestId, decision: "run" }));
    await wait(100);
    expect(seenA.some((m) => m.type === "error" && /unknown or already-decided/.test(m.message))).toBe(true);
    wsA.close();
    wsB.close();
  });

  it("rejects suggestions for skills not in the roster", async () => {
    const server = await rosterServer();
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "sk3", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "suggest_skill", skill: "rm-rf-everything", args: "" }));
    await wait(100);
    expect(seen.some((m) => m.type === "error" && /roster/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.event?.type === "skill_suggest")).toBe(false);
    ws.close();
  });
});

describe("plan mode", () => {
  it("guards set_permission_mode and decide_plan to the current driver", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const wsA = await connect(server.port);
    collect(wsA, []);
    wsA.send(JSON.stringify({ type: "join", sessionId: "pg1", userId: "u1", name: "Ana" }));
    await wait(50);
    const wsB = await connect(server.port);
    const seenB: any[] = [];
    collect(wsB, seenB);
    wsB.send(JSON.stringify({ type: "join", sessionId: "pg1", userId: "u2", name: "Ben" }));
    await wait(50);
    wsB.send(JSON.stringify({ type: "set_permission_mode", mode: "plan" }));
    wsB.send(JSON.stringify({ type: "decide_plan", requestId: "r1", decision: "approve" }));
    await wait(100);
    const errors = seenB.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors.some((e) => /change the permission mode/.test(e))).toBe(true);
    expect(errors.some((e) => /decide plans/.test(e))).toBe(true);
    wsA.close();
    wsB.close();
  });

  it("guards stop_task to the current driver and appends task_stop for the driver", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const wsA = await connect(server.port);
    const seenA: any[] = [];
    collect(wsA, seenA);
    wsA.send(JSON.stringify({ type: "join", sessionId: "wf1", userId: "u1", name: "Ana" }));
    await wait(50);
    const wsB = await connect(server.port);
    const seenB: any[] = [];
    collect(wsB, seenB);
    wsB.send(JSON.stringify({ type: "join", sessionId: "wf1", userId: "u2", name: "Ben" }));
    await wait(50);
    wsB.send(JSON.stringify({ type: "stop_task", taskId: "T1" })); // watcher: rejected
    await wait(100);
    expect(seenB.some((m) => m.type === "error" && /stop tasks/.test(m.message))).toBe(true);
    expect(seenB.some((m) => m.event?.type === "task_stop")).toBe(false);
    wsA.send(JSON.stringify({ type: "stop_task", taskId: "T1" })); // driver: accepted
    await wait(100);
    expect(seenA.some((m) => m.event?.type === "task_stop" && m.event.taskId === "T1" && m.event.userId === "u1")).toBe(true);
    wsA.send(JSON.stringify({ type: "stop_task" })); // missing taskId: rejected
    await wait(100);
    expect(seenA.some((m) => m.type === "error" && /requires taskId/.test(m.message))).toBe(true);
    wsA.close();
    wsB.close();
  });

  it("guards stop_turn to the current driver and appends turn_stop for the driver", async () => {
    // A stream whose turn stays open (no result) and that supports interrupt.
    const interruptible: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const prompt of prompts) {
          yield {
            type: "assistant",
            content: [{ type: "text", text: `echo: ${prompt.message.content[0].text}` }],
          } as SdkMessage;
        }
      })();
      return Object.assign(gen, { interrupt: async () => {} });
    };
    const server = await startServer({ port: 0, runQuery: interruptible });
    close = server.close;
    const wsA = await connect(server.port);
    const seenA: any[] = [];
    collect(wsA, seenA);
    wsA.send(JSON.stringify({ type: "join", sessionId: "st1", userId: "u1", name: "Ana" }));
    await wait(50);
    const wsB = await connect(server.port);
    const seenB: any[] = [];
    collect(wsB, seenB);
    wsB.send(JSON.stringify({ type: "join", sessionId: "st1", userId: "u2", name: "Ben" }));
    await wait(50);
    wsB.send(JSON.stringify({ type: "stop_turn" })); // watcher: rejected
    await wait(100);
    expect(seenB.some((m) => m.type === "error" && /stop the turn/.test(m.message))).toBe(true);
    expect(seenB.some((m) => m.event?.type === "turn_stop")).toBe(false);
    // idle driver: no turn running — accepted as a no-op, no turn_stop appended
    wsA.send(JSON.stringify({ type: "stop_turn" }));
    await wait(100);
    expect(seenA.some((m) => m.event?.type === "turn_stop")).toBe(false);
    expect(seenA.some((m) => m.type === "error")).toBe(false);
    // mid-turn: the driver's request lands on the wire
    wsA.send(JSON.stringify({ type: "prompt", text: "long work" }));
    await wait(100);
    wsA.send(JSON.stringify({ type: "stop_turn" }));
    await wait(100);
    expect(seenA.some((m) => m.event?.type === "turn_stop" && m.event.userId === "u1")).toBe(true);
    wsA.close();
    wsB.close();
  });
});

describe("auto mode (e2e)", () => {
  it("auto-approves gates end-to-end with driver attribution on the wire", async () => {
    const gateRun: RunQuery = async function* (prompts, hooks) {
      for await (const _prompt of prompts) {
        const decision = await hooks.onPermissionRequest("Bash", {
          command: "npm run build",
        });
        yield {
          type: "assistant",
          content: [{ type: "text", text: `went: ${decision}` }],
        };
      }
    };
    const server = await startServer({ port: 0, runQuery: gateRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "auto1", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "set_permission_mode", mode: "auto" }));
    ws.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(300);

    const events = seen.map((m) => m.event).filter(Boolean);
    expect(events.find((e) => e.type === "permission_mode_change")).toMatchObject({
      mode: "auto",
      userId: "u1",
    });
    expect(events.find((e) => e.type === "permission_request")).toBeTruthy();
    expect(events.find((e) => e.type === "permission_decision")).toMatchObject({
      decision: "allow",
      userId: "u1",
      auto: true,
    });
    expect(
      events.some((e) => e.type === "agent_text_delta" && e.text === "went: allow"),
    ).toBe(true);
    ws.close();
  });

  it("rejects an unknown mode", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "auto2", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "set_permission_mode", mode: "yolo" }));
    await wait(100);
    const errors = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors.some((e) => /plan\|default\|auto/.test(e))).toBe(true);
    ws.close();
  });
});

describe("plugin registry", () => {
  const skeleton: Record<string, string> = {
    "skills/agent-handoff/SKILL.md":
      "---\nname: agent-handoff\ndescription: resume packets\n---\n",
  };
  function storeWithFakeClone(): { store: PluginStore; root: string; clones: string[] } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-e2e-"));
    // Every url the store actually tried to fetch — a refused url must never
    // appear here (audit M1/M6).
    const clones: string[] = [];
    const clone: CloneFn = async (url, dest) => {
      clones.push(url);
      for (const [rel, content] of Object.entries(skeleton)) {
        const p = path.join(dest, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
    };
    return { store: new PluginStore(root, clone), root, clones };
  }

  it("add_plugin appends plugin_change and pushes the registry; later sessions get the paths", async () => {
    const { store } = storeWithFakeClone();
    const hookCaptures: { pluginPaths?: string[] }[] = [];
    const capturingRun: RunQuery = (prompts, hooks) => {
      hookCaptures.push({ pluginPaths: hooks.pluginPaths });
      return echoRun(prompts, hooks);
    };
    const server = await startServer({ port: 0, runQuery: capturingRun, plugins: store });
    close = server.close;

    const ws1 = await connect(server.port);
    const seen1: any[] = [];
    collect(ws1, seen1);
    ws1.send(JSON.stringify({ type: "join", sessionId: "pa", projectId: "prj", userId: "u1", name: "Ana" }));
    await wait(50);
    ws1.send(JSON.stringify({ type: "add_plugin", url: "https://github.com/x/tools" }));
    await wait(200);

    const evTypes = seen1.map((m) => m.event?.type);
    expect(evTypes).toContain("plugin_change");
    const change = seen1.find((m) => m.event?.type === "plugin_change").event;
    expect(change.action).toBe("add");
    expect(change.name).toBe("tools");
    expect(change.skillCount).toBe(1);
    expect(change.userId).toBe("u1");
    const snap = seen1.filter((m) => m.type === "project").at(-1);
    expect(snap.pluginsEnabled).toBe(true);
    expect(snap.plugins.map((p: any) => p.name)).toEqual(["tools"]);

    // session created BEFORE the add carries no plugin paths...
    expect(hookCaptures[0].pluginPaths).toEqual([]);
    // ...a session created AFTER carries the clone path
    const ws2 = await connect(server.port);
    collect(ws2, []);
    ws2.send(JSON.stringify({ type: "join", sessionId: "pb", projectId: "prj", userId: "u2", name: "Ben" }));
    await wait(100);
    expect(hookCaptures[1].pluginPaths).toEqual(store.paths("prj"));
    ws1.close();
    ws2.close();
  });

  it("new sessions seed their roster from the plugin scan", async () => {
    const { store } = storeWithFakeClone();
    const server = await startServer({ port: 0, runQuery: echoRun, plugins: store });
    close = server.close;
    await store.add("prj2", "https://github.com/x/tools", "u0");

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "pr", projectId: "prj2", userId: "u1", name: "Ana" }));
    await wait(100);
    const roster = seen.find((m) => m.event?.type === "skill_roster").event;
    expect(roster.skills).toEqual([
      { name: "tools:agent-handoff", description: "resume packets" },
    ]);
    ws.close();
  });

  it("remove_plugin appends plugin_change remove and shrinks the registry", async () => {
    const { store } = storeWithFakeClone();
    const server = await startServer({ port: 0, runQuery: echoRun, plugins: store });
    close = server.close;
    await store.add("prj3", "https://github.com/x/tools", "u0");

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "pc", projectId: "prj3", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "remove_plugin", name: "tools" }));
    await wait(200);
    const change = seen.find((m) => m.event?.type === "plugin_change")?.event;
    expect(change).toMatchObject({ action: "remove", name: "tools", userId: "u1" });
    const snap = seen.filter((m) => m.type === "project").at(-1);
    expect(snap.plugins).toEqual([]);
    ws.close();
  });

  it("plugin_change hot-reloads the live session: reloadSkills/reloadPlugins + a fresh roster", async () => {
    const { store } = storeWithFakeClone();
    const reloads: string[] = [];
    const reloadableRun: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const prompt of prompts) {
          yield {
            type: "assistant",
            content: [{ type: "text", text: `echo: ${prompt.message.content[0].text}` }],
          } as SdkMessage;
        }
      })();
      return Object.assign(gen, {
        reloadSkills: async () => {
          reloads.push("skills");
        },
        reloadPlugins: async () => {
          reloads.push("plugins");
        },
        supportedCommands: async () => [{ name: "alpha", description: "live" }],
      });
    };
    const server = await startServer({ port: 0, runQuery: reloadableRun, plugins: store });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "phr", projectId: "prj5", userId: "u1", name: "Ana" }));
    await wait(100);
    // session-seed roster (plugin scan) + startup roster (live supportedCommands)
    expect(seen.filter((m) => m.event?.type === "skill_roster").length).toBe(2);
    ws.send(JSON.stringify({ type: "add_plugin", url: "https://github.com/x/tools" }));
    await wait(200);
    expect(seen.some((m) => m.event?.type === "plugin_change")).toBe(true);
    expect(reloads.sort()).toEqual(["plugins", "skills"]);
    // the reload's roster refetch appended a THIRD skill_roster
    expect(seen.filter((m) => m.event?.type === "skill_roster").length).toBe(3);
    ws.close();
  });

  it("rejects bad requests with sendError and appends nothing", async () => {
    const { store } = storeWithFakeClone();
    const server = await startServer({ port: 0, runQuery: echoRun, plugins: store });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "pd", projectId: "prj4", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "add_plugin" }));
    ws.send(JSON.stringify({ type: "add_plugin", url: "git@github.com:x/y.git" }));
    ws.send(JSON.stringify({ type: "remove_plugin", name: "ghost" }));
    await wait(200);
    const errs = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errs).toContain("add_plugin requires url");
    expect(errs).toContain("plugin url must be https://");
    expect(errs).toContain('unknown plugin "ghost"');
    expect(seen.some((m) => m.event?.type === "plugin_change")).toBe(false);
    ws.close();
  });

  /** Audit M1/M6: an off-allowlist host is refused through the SAME error
   *  reply as every other bad `add_plugin`, and appends no plugin_change. */
  it("refuses an off-allowlist plugin host over the wire", async () => {
    const { store, clones } = storeWithFakeClone();
    const server = await startServer({ port: 0, runQuery: echoRun, plugins: store });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "ph", projectId: "prj9", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "add_plugin", url: "https://169.254.169.254/latest/meta-data" }));
    ws.send(JSON.stringify({ type: "add_plugin", url: "https://internal.corp.example/x.git" }));
    await wait(200);
    const errs = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errs).toEqual([
      "plugin url host must be one of: github.com",
      "plugin url host must be one of: github.com",
    ]);
    expect(clones).toEqual([]);
    expect(seen.some((m) => m.event?.type === "plugin_change")).toBe(false);
    ws.close();
  });

  it("add_plugin trims whitespace and caps url length", async () => {
    const { store } = storeWithFakeClone();
    const server = await startServer({ port: 0, runQuery: echoRun, plugins: store });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "pf", projectId: "prj6", userId: "u1", name: "Ana" }));
    await wait(50);
    ws.send(JSON.stringify({ type: "add_plugin", url: "   " }));
    ws.send(JSON.stringify({ type: "add_plugin", url: "https://" + "a".repeat(2049) }));
    ws.send(JSON.stringify({ type: "add_plugin", url: "  https://github.com/x/tools  " }));
    await wait(200);
    const errs = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errs).toContain("add_plugin requires url");
    expect(errs).toContain("url too long (max 2048)");
    const change = seen.find((m) => m.event?.type === "plugin_change")?.event;
    expect(change).toMatchObject({ action: "add", name: "tools" });
    ws.close();
  });

  it("reports the feature as off without a root", async () => {
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      plugins: new PluginStore(undefined),
    });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "pe", projectId: "prj5", userId: "u1", name: "Ana" }));
    await wait(50);
    const snap = seen.filter((m) => m.type === "project").at(-1);
    expect(snap.pluginsEnabled).toBe(false);
    ws.send(JSON.stringify({ type: "add_plugin", url: "https://github.com/x/y" }));
    await wait(100);
    expect(seen.filter((m) => m.type === "error").map((m) => m.message)).toContain(
      "plugin import is off — set AGENT_PLUGINS_ROOT on the server",
    );
    ws.close();
  });
});

describe("session initiation", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("watch_project sends an immediate snapshot with machine info and live pushes", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const watcher = await connect(server.port);
    const seen: any[] = [];
    collect(watcher, seen);
    watcher.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(50);
    const snap = seen.find((m) => m.type === "project");
    expect(snap).toBeTruthy();
    expect(snap.machines).toEqual([
      {
        machineId: "local:test:000000000000",
        name: "repo",
        repos: [
          { key: "local:test:000000000000", label: "repo", attached: true, defaultBranch: "main" },
        ],
        online: true,
      },
    ]);
    expect(snap.sessions).toEqual([]);
    const joiner = await connect(server.port);
    joiner.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await vi.waitFor(() => {
      expect(
        seen.some((m) => m.type === "project" && m.sessions.some((s: any) => s.id === "s1")),
      ).toBe(true);
    });
    watcher.close();
    joiner.close();
  });

  it("watch_project unsubscribes from the previous project on re-watch", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const watcher = await connect(server.port);
    const seen: any[] = [];
    collect(watcher, seen);
    // Watch default project
    watcher.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(30);
    const initialSnap = seen.find((m) => m.type === "project");
    expect(initialSnap).toBeTruthy();
    const snapCount = seen.filter((m) => m.type === "project").length;
    // Switch to watching other project
    watcher.send(JSON.stringify({ type: "watch_project", projectId: "other" }));
    await wait(30);
    // Have a session join the default project (watcher is no longer subscribed)
    const joiner = await connect(server.port);
    joiner.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana", projectId: "default" }));
    await wait(100);
    // Count project messages received: initial "default" + initial "other" + should NOT get updated "default"
    const projectMessages = seen.filter((m) => m.type === "project");
    expect(projectMessages.length).toBe(snapCount + 1); // only the "other" project added
    // Verify the last project message is from "other" (empty sessions initially)
    const lastProjectMsg = projectMessages.at(-1);
    expect(lastProjectMsg).toBeTruthy();
    watcher.close();
    joiner.close();
  });

  it("create_session provisions, acks, and pushes the new session", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const creator = await connect(server.port);
    const seen: any[] = [];
    collect(creator, seen);
    creator.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(30);
    creator.send(JSON.stringify({ type: "create_session", name: "Fix Auth!", baseRef: "dev" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "fix-auth")).toBe(true);
    });
    expect(workspace.calls).toEqual([{ projectId: "default", slug: "fix-auth", baseRef: "dev" }]);
    await vi.waitFor(() => {
      expect(
        seen.some((m) => m.type === "project" && m.sessions.some((s: any) => s.id === "fix-auth")),
      ).toBe(true);
    });
    creator.close();
  });

  it("create_session errors when the server has no workspace", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", name: "x" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /no repo is attached on this machine/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "session_created")).toBe(false);
    ws.close();
  });

  it("create_session validates the name", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session" }));
    ws.send(JSON.stringify({ type: "create_session", name: "###" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /requires name/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "error" && /usable name/.test(m.message))).toBe(true);
    expect(workspace.calls).toEqual([]);
    ws.close();
  });

  it("create_session surfaces provision failure and creates nothing", async () => {
    const workspace = {
      provision: () => ({ ok: false as const, error: "unknown base ref: dev" }),
      defaultBranch: () => "main",
      repoKey: () => "local:test:000000000000",
    };
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", name: "ghost", baseRef: "dev" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && m.message === "unknown base ref: dev")).toBe(true);
    expect(seen.some((m) => m.type === "session_created")).toBe(false);
    ws.close();
  });

  it("create_session for an existing session just acks without re-provisioning", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const joiner = await connect(server.port);
    joiner.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(50);
    const creator = await connect(server.port);
    const seen: any[] = [];
    collect(creator, seen);
    creator.send(JSON.stringify({ type: "create_session", name: "s1" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "s1")).toBe(true);
    });
    expect(workspace.calls.length).toBe(1); // only the join's deep-link provision
    joiner.close();
    creator.close();
  });

  it("deep-link join provisions through the workspace off the default branch", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "adhoc", userId: "u1", name: "Ana" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.event?.type === "presence_join")).toBe(true);
    });
    expect(workspace.calls).toEqual([{ projectId: "default", slug: "adhoc", baseRef: "main" }]);
    ws.close();
  });

  it("deep-link join surfaces provision failure as a join error", async () => {
    const workspace = {
      provision: () => ({ ok: false as const, error: "session name taken (branch mpai/adhoc exists)" }),
      defaultBranch: () => "main",
      repoKey: () => "local:test:000000000000",
    };
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "adhoc", userId: "u1", name: "Ana" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /name taken/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.event?.type === "presence_join")).toBe(false);
    ws.close();
  });
});

describe("solo-mode entrance protocol", () => {
  // ProjectPicker and SessionPicker (poc/client) send identify / list_projects
  // / create_project unconditionally, hub-shaped or not. Before this these all
  // fell through to server.ts's `unknown message type` catch-all, which also
  // replies `{ type: "error", ... }` — so every assertion below pins the exact
  // message text or payload shape, not merely `type`, to discriminate a real
  // guard from that fallthrough (see hub's routing.test.ts for the identical
  // concern against the hub's own `tunnel()` fallthrough).

  describe("identify", () => {
    it("answers with the identity it was given", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "identify", userId: "u1", name: "Ana" }));
      await wait(40);
      expect(seen).toEqual([{ type: "identified", userId: "u1", name: "Ana" }]);
      ws.close();
    });

    it("rejects a non-string field and an empty userId, distinctly", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "identify", userId: 7, name: "Ana" }));
      ws.send(JSON.stringify({ type: "identify", userId: "", name: "Ana" }));
      await wait(40);
      expect(seen.map((m) => m.message)).toEqual([
        "identify requires userId, name",
        "identify requires userId",
      ]);
      ws.close();
    });

    it("truncates an over-long userId and name", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "identify", userId: "u".repeat(80), name: "n".repeat(60) }));
      await wait(40);
      expect(seen[0].userId).toHaveLength(64);
      expect(seen[0].name).toHaveLength(40);
      ws.close();
    });

    it("refuses to rebind identity on a connection that has already joined", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "ana", name: "Ana" }));
      await wait(40);
      seen.length = 0;
      ws.send(JSON.stringify({ type: "identify", userId: "mal", name: "Mal" }));
      await wait(40);
      // Text, not type: an already-joined connection sending an unrecognized
      // type also gets `{ type: "error" }` from the catch-all, just with a
      // different message ("unknown message type: ..."). Only the text
      // proves THIS guard fired.
      expect(seen).toEqual([{ type: "error", message: "already joined" }]);
      ws.close();
    });
  });

  describe("list_projects", () => {
    it("answers an empty list on a fresh server, rather than erroring", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "list_projects" }));
      await wait(40);
      expect(seen).toEqual([{ type: "projects", projects: [] }]);
      ws.close();
    });

    it("never creates the project it is asked to list — a read, not a write", async () => {
      // Regression guard for the explicit ruling: list_projects must use a
      // non-creating read. A creating implementation would let this exact
      // message (with an attacker-chosen projectId riding along, which
      // list_projects does not even accept) grow the project map. Proven here
      // by calling list_projects first and only THEN creating a session in
      // "ghost" — if list_projects had already (wrongly) materialized it,
      // this create_session would see a pre-existing empty project rather
      // than provisioning fresh.
      const workspace = fakeWorkspace();
      const server = await startServer({ port: 0, runQuery: echoRun, workspace });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "list_projects", projectId: "ghost" }));
      await wait(40);
      expect(seen).toEqual([{ type: "projects", projects: [] }]);
      seen.length = 0;
      ws.send(JSON.stringify({ type: "create_session", projectId: "ghost", name: "s1" }));
      await vi.waitFor(() => {
        expect(seen.some((m) => m.type === "session_created")).toBe(true);
      });
      expect(workspace.calls).toEqual([{ projectId: "ghost", slug: "s1", baseRef: "main" }]);
      ws.close();
    });

    it("reports the connecting user as a member and itself as the one online machine", async () => {
      const workspace = { ...fakeWorkspace(), repoKey: () => "github.com/acme/api" };
      const server = await startServer({ port: 0, runQuery: echoRun, workspace });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      // watch_project provisions "default" (getOrCreateProject) before
      // list_projects is asked to read it back — the same order SessionPicker
      // sends them in.
      ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "Ana" }));
      ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
      ws.send(JSON.stringify({ type: "list_projects" }));
      await wait(60);
      const projectsMsg = seen.find((m) => m.type === "projects");
      expect(projectsMsg.projects).toEqual([
        {
          id: "default",
          name: "default",
          lifecycle: "active",
          members: ["ana"],
          memberCount: 1,
          isMember: true,
          sessionCount: 0,
          liveSessionCount: 0,
          machines: [
            {
              machineId: "github.com/acme/api",
              name: "repo",
              repos: [
                { key: "github.com/acme/api", label: "repo", attached: true, defaultBranch: "main" },
              ],
              online: true,
            },
          ],
        },
      ]);
      ws.close();
    });

    it("reports no members before identify has ever run on this connection", async () => {
      const workspace = fakeWorkspace();
      const server = await startServer({ port: 0, runQuery: echoRun, workspace });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
      ws.send(JSON.stringify({ type: "list_projects" }));
      await wait(50);
      const projectsMsg = seen.find((m) => m.type === "projects");
      expect(projectsMsg.projects[0].members).toEqual([]);
      ws.close();
    });

    it("adds memberCount and isMember for standalone parity with the hub (spec A5)", async () => {
      // One browser bundle talks to both servers, so the standalone list must
      // carry the same three fields the hub sends. Solo has no membership
      // concept: memberCount = members.length, and the connecting user is
      // always a member (isMember true).
      const workspace = fakeWorkspace();
      const server = await startServer({ port: 0, runQuery: echoRun, workspace, projectId: "acme" });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "Ana" }));
      ws.send(JSON.stringify({ type: "list_projects" }));
      await wait(50);
      const projectsMsg = seen.find((m) => m.type === "projects");
      const entry = projectsMsg.projects[0];
      expect(entry.members).toEqual(["ana"]);
      expect(entry.memberCount).toBe(1); // members.length
      expect(entry.isMember).toBe(true); // the solo user is always a member
      ws.close();
    });

    it("lists the launch project on a fresh server, seeded at boot", async () => {
      const workspace = fakeWorkspace();
      const server = await startServer({ port: 0, runQuery: echoRun, workspace, projectId: "acme" });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "list_projects" }));
      await wait(40);
      const projectsMsg = seen.find((m) => m.type === "projects");
      expect(projectsMsg).toBeTruthy();
      // Exactly one — a fresh solo server's entrance is the promised one-item
      // list, not an empty page with only a NEW PROJECT button.
      expect(projectsMsg.projects.map((p: any) => p.id)).toEqual(["acme"]);
      ws.close();
    });

    it("refuses a malformed boot-seed projectId instead of seeding a phantom", async () => {
      // A non-slug seed would list a project that join / watch_project /
      // create_session (all SLUG-gated) then refuse — a phantom entrance
      // entry reachable by nothing.
      await expect(
        startServer({ port: 0, runQuery: echoRun, projectId: "Not A Slug!" }),
      ).rejects.toThrow(/projectId/);
    });
  });

  describe("create_project", () => {
    it("requires identify first, distinctly from the catch-all", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
      await wait(40);
      expect(seen).toEqual([{ type: "error", message: "identify first" }]);
      ws.close();
    });

    it("rejects a non-string name and a name that slugifies to nothing", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "Ana" }));
      await wait(30);
      seen.length = 0;
      ws.send(JSON.stringify({ type: "create_project" }));
      ws.send(JSON.stringify({ type: "create_project", name: "!!!" }));
      await wait(40);
      expect(seen.map((m) => m.message)).toEqual([
        "create_project requires name",
        "create_project requires a usable name",
      ]);
      ws.close();
    });

    it("creates a real, reachable project — not just an ack", async () => {
      const workspace = fakeWorkspace();
      const server = await startServer({ port: 0, runQuery: echoRun, workspace });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "Ana" }));
      ws.send(JSON.stringify({ type: "create_project", name: "My Cool Project" }));
      await wait(40);
      expect(seen.at(-1)).toEqual({ type: "project_created", projectId: "my-cool-project" });
      seen.length = 0;
      // Reachable: list_projects is the NON-CREATING read (`projects.values()`
      // never calls getOrCreateProject), so the slug appears here only if
      // create_project actually wrote it. watch_project would not
      // discriminate — it creates the project itself on the way in.
      ws.send(JSON.stringify({ type: "list_projects" }));
      await wait(40);
      const projectsMsg = seen.find((m) => m.type === "projects");
      const created = projectsMsg.projects.find((p: any) => p.id === "my-cool-project");
      expect(created).toBeTruthy();
      expect(created.lifecycle).toBe("active");
      expect(created.sessionCount).toBe(0);
      ws.close();
    });

    it("refuses to create a project whose slug already exists", async () => {
      const server = await startServer({ port: 0, runQuery: echoRun });
      close = server.close;
      const ws = await connect(server.port);
      const seen: any[] = [];
      collect(ws, seen);
      ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "Ana" }));
      ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
      await wait(40);
      seen.length = 0;
      ws.send(JSON.stringify({ type: "create_project", name: "Acme" }));
      await wait(40);
      expect(seen).toEqual([{ type: "error", message: 'project "acme" already exists' }]);
      ws.close();
    });
  });
});

describe("machines on the project snapshot (solo-mode fix)", () => {
  it("reports itself as the one online machine when launched with a repo", async () => {
    const workspace = { ...fakeWorkspace(), repoKey: () => "github.com/acme/api" };
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    const snap = seen.find((m) => m.type === "project");
    expect(snap.machines).toEqual([
      {
        machineId: "github.com/acme/api",
        name: "repo",
        repos: [
          { key: "github.com/acme/api", label: "repo", attached: true, defaultBranch: "main" },
        ],
        online: true,
      },
    ]);
    ws.close();
  });

  it("omits machines when the server has no workspace, same as repo", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(40);
    const snap = seen.find((m) => m.type === "project");
    expect(snap.machines).toBeUndefined();
    ws.close();
  });

  it("peek's synthetic snapshot for an unknown project has no top-level repo property (D10)", async () => {
    const workspace = { ...fakeWorkspace(), repoKey: () => "github.com/acme/api" };
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "peek", projectId: "nosuch" }));
    await wait(40);
    const snap = seen.find((m) => m.type === "project");
    expect(snap).not.toHaveProperty("repo");
    // The synthetic reply mirrors the real snapshot's machine reporting too —
    // the machine itself is reachable regardless of whether this particular
    // project exists yet.
    expect(snap.machines).toEqual([
      { machineId: "github.com/acme/api", name: "repo", repos: expect.any(Array), online: true },
    ]);
    ws.close();
  });
});

describe("oversight wire", () => {
  const instantSummarize = async () => "team is busy";

  it("snapshots carry oversight, defaulting to disabled", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(50);
    const snap = seen.find((m) => m.type === "project");
    // `available: true` is the additive solo-capability flag (2026-08-04 hub
    // oversight §5): a standalone server always has its local overseer.
    expect(snap.oversight).toEqual({ enabled: false, latest: null, available: true });
    // peek fallback for an unknown project also carries the field
    ws.send(JSON.stringify({ type: "peek", projectId: "nosuch" }));
    await wait(50);
    const peeked = seen.filter((m) => m.type === "project").at(-1);
    expect(peeked.oversight).toEqual({ enabled: false, latest: null, available: true });
    ws.close();
  });

  it("validates set_oversight and rejects unknown projects", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "BAD SLUG", enabled: true }));
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: "yes" }));
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "ghost", enabled: true }));
    await wait(50);
    const errors = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toContain("set_oversight requires a valid projectId");
    expect(errors).toContain("set_oversight requires enabled: true|false");
    expect(errors).toContain("unknown project: ghost");
    ws.close();
  });

  it("enabling pushes the toggle and then the first summary to watchers", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(80);
    const snaps = seen.filter((m) => m.type === "project");
    expect(snaps.at(-1).oversight.enabled).toBe(true);
    expect(snaps.at(-1).oversight.latest).toMatchObject({ text: "team is busy", seq: 1 });
    ws.close();
  });

  it("session activity triggers a debounced refresh", async () => {
    let calls = 0;
    const counting = async () => `summary ${++calls}`;
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: counting, oversightDebounceMs: 30 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(50); // initial refresh (call 1)
    ws.send(JSON.stringify({ type: "prompt", text: "do the thing" }));
    await wait(150); // debounce 30ms then refresh (call 2)
    expect(calls).toBeGreaterThanOrEqual(2);
    const snaps = seen.filter((m) => m.type === "project");
    expect(snaps.at(-1).oversight.latest.seq).toBeGreaterThanOrEqual(2);
    ws.close();
  });

  it("pull_oversight is driver-only", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws1 = await connect(server.port);
    collect(ws1, []);
    ws1.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u2", name: "Ben" }));
    await wait(30);
    ws2.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(50);
    expect(seen2.map((m) => m.message)).toContain(
      "only the current driver can pull team updates — take the wheel first",
    );
    ws1.close();
    ws2.close();
  });

  it("pull_oversight errors while disabled and before the first summary", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = async () => {
      await gate;
      return "late summary";
    };
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: held, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(30);
    expect(seen.map((m) => m.message)).toContain("team oversight is disabled");
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(20); // refresh started but held open — no summary yet
    ws.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(30);
    expect(seen.map((m) => m.message)).toContain("no team summary yet");
    release();
    ws.close();
  });

  it("a pull appends the attributed event and injects <oversight> into exactly the next prompt", async () => {
    const promptTexts: string[] = [];
    const recordingRun: RunQuery = async function* (prompts) {
      for await (const p of prompts) {
        promptTexts.push(p.message.content[0].text);
        yield { type: "assistant", content: [{ type: "text", text: "ok" }] };
      }
    };
    const server = await startServer({ port: 0, runQuery: recordingRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(60);
    ws.send(JSON.stringify({ type: "pull_oversight" }));
    await wait(50);
    const pull = seen.find((m) => m.event?.type === "oversight_pull")?.event;
    expect(pull).toMatchObject({ userId: "u1", summarySeq: 1 });
    ws.send(JSON.stringify({ type: "prompt", text: "first after pull" }));
    await wait(100);
    ws.send(JSON.stringify({ type: "prompt", text: "second prompt" }));
    await wait(100);
    expect(promptTexts[0]).toContain("<oversight>\nteam is busy\n</oversight>");
    expect(promptTexts[0]).toContain("first after pull");
    expect(promptTexts[1]).not.toContain("<oversight>");
    ws.close();
  });

  it("disabling clears the summary display state but keeps history honest", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, summarize: instantSummarize, oversightDebounceMs: 10 });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(30);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(60);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: false }));
    await wait(50);
    const last = seen.filter((m) => m.type === "project").at(-1);
    expect(last.oversight.enabled).toBe(false);
    // latest retained (stale-by-timestamp per spec §2), not wiped
    expect(last.oversight.latest).toMatchObject({ text: "team is busy" });
    ws.close();
  });

});

describe("project invites", () => {
  // The shared preamble: an identified founder creates and joins a project,
  // leaving the socket positioned right after the join_project ack.
  async function foundProject(
    port: number,
    projectId: string,
    userId: string,
    name: string,
  ): Promise<{ ws: WebSocket; sink: any[] }> {
    const ws = await connect(port);
    const sink: any[] = [];
    collect(ws, sink);
    ws.send(JSON.stringify({ type: "identify", userId, name }));
    ws.send(JSON.stringify({ type: "create_project", name: projectId }));
    await wait(30);
    ws.send(JSON.stringify({ type: "join_project", projectId }));
    await wait(30);
    return { ws, sink };
  }

  async function joinProject(
    port: number,
    projectId: string,
    userId: string,
    name: string,
    invite?: string,
  ): Promise<{ ws: WebSocket; sink: any[] }> {
    const ws = await connect(port);
    const sink: any[] = [];
    collect(ws, sink);
    ws.send(JSON.stringify({ type: "identify", userId, name }));
    await wait(30);
    ws.send(
      JSON.stringify({ type: "join_project", projectId, ...(invite ? { invite } : {}) }),
    );
    await wait(30);
    return { ws, sink };
  }

  it("mints an invite, keeps the token off the wire, and previews it", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");
    a.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);

    const list = a.sink.find((m) => m.type === "invite_list");
    expect(list.invites).toHaveLength(1);
    const token = list.invites[0].token;
    expect(token).toHaveLength(32);
    // The view is project-scoped: it carries the project and no session.
    expect(list.invites[0].projectId).toBe("default");
    expect(list.invites[0]).not.toHaveProperty("sessionId");
    // Project invites emit NO session events (plan §1.9): nothing named
    // invite_* may appear in any event frame.
    expect(a.sink.some((m) => m.event?.type === "invite_created")).toBe(false);
    // The token rides invite_list to the requesting socket and nothing else.
    for (const m of a.sink) {
      if (m.type !== "invite_list") expect(JSON.stringify(m)).not.toContain(token);
    }

    // peek_invite stays unauthenticated: a fresh socket, no identify.
    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "peek_invite", token }));
    await wait(30);
    const info = sinkB.find((m) => m.type === "invite_info");
    expect(info).toMatchObject({
      projectId: "default",
      projectName: "default",
      inviterName: "ana",
      remaining: 10,
    });
    expect(info).not.toHaveProperty("sessionId");
    // ...and the answer never echoes the token back.
    expect(JSON.stringify(sinkB)).not.toContain(token);
    a.ws.close();
    b.close();
  });

  it("rejects a missing token and an unknown token with the exact strings", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const sink: any[] = [];
    collect(ws, sink);
    ws.send(JSON.stringify({ type: "peek_invite" }));
    ws.send(JSON.stringify({ type: "peek_invite", token: "x".repeat(32) }));
    await wait(30);
    const errors = sink.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toContain("peek_invite requires a token");
    expect(errors).toContain("invite not found");
    ws.close();
  });

  it("redeems at join_project, counts one seat per user, and writes membership", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");
    a.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    const invite = a.sink.find((m) => m.type === "invite_list").invites[0];

    // The invitee redeems the token TWICE (a reload re-joins) — one seat.
    const b = await joinProject(server.port, "default", "u2", "bob", invite.token);
    expect(b.sink.some((m) => m.type === "error")).toBe(false);
    b.ws.send(
      JSON.stringify({ type: "join_project", projectId: "default", invite: invite.token }),
    );
    await wait(30);
    expect(b.sink.some((m) => m.type === "error")).toBe(false);

    a.ws.send(JSON.stringify({ type: "list_invites", projectId: "default" }));
    await wait(30);
    const lists = a.sink.filter((m) => m.type === "invite_list");
    expect(lists[lists.length - 1].invites[0].uses).toBe(1);

    // Membership was written by the redeem: bob may now manage invites.
    b.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    expect(b.sink.some((m) => m.type === "invite_list")).toBe(true);

    // No invite_redeemed session event exists any more (plan §1.9).
    expect(a.sink.some((m) => m.event?.type === "invite_redeemed")).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  it("a failed redeem writes no membership, and session join ignores a stray invite field", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");

    const c = await joinProject(server.port, "default", "u3", "cal", "x".repeat(32));
    expect(c.sink.find((m) => m.type === "error")?.message).toBe("invite not found");
    // No membership: cal cannot manage the project's invites.
    c.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    const refusal = c.sink.filter((m) => m.type === "error").at(-1);
    expect(refusal).toMatchObject({
      message: "join this project before inviting to it",
      code: "not_a_member",
    });

    // The session-join invite field is gone (plan §1.4): a stray one is
    // simply ignored, like any unknown field — the join itself succeeds.
    const errorCount = c.sink.filter((m) => m.type === "error").length;
    c.ws.send(
      JSON.stringify({
        type: "join",
        sessionId: "alpha",
        userId: "u3",
        name: "cal",
        projectId: "default",
        invite: "x".repeat(32),
      }),
    );
    await wait(30);
    expect(c.sink.filter((m) => m.type === "error")).toHaveLength(errorCount);
    expect(c.sink.some((m) => m.type === "project")).toBe(true);
    a.ws.close();
    c.ws.close();
  });

  it("revokes an invite and reports the exact reason afterwards", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");
    a.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    const invite = a.sink.find((m) => m.type === "invite_list").invites[0];

    a.ws.send(JSON.stringify({ type: "revoke_invite", projectId: "default" }));
    a.ws.send(JSON.stringify({ type: "revoke_invite", projectId: "default", inviteId: "nope1234" }));
    a.ws.send(JSON.stringify({ type: "revoke_invite", projectId: "default", inviteId: invite.id }));
    await wait(30);
    const errors = a.sink.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toContain("revoke_invite requires an inviteId");
    expect(errors).toContain("unknown invite: nope1234");
    expect(a.sink.some((m) => m.event?.type === "invite_revoked")).toBe(false);
    const lists = a.sink.filter((m) => m.type === "invite_list");
    expect(lists[lists.length - 1].invites).toHaveLength(0);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "peek_invite", token: invite.token }));
    await wait(30);
    expect(sinkB.find((m) => m.type === "error")?.message).toBe("invite revoked");
    a.ws.close();
    b.close();
  });

  it("gates invite management on project membership and validates like the other project messages", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");
    a.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    const invite = a.sink.find((m) => m.type === "invite_list").invites[0];

    // An identified non-member gets the not_a_member refusal on all three.
    // Management of a project that does not exist collapses to the same
    // refusal — there is no membership to have in it.
    const o = await connect(server.port);
    const sinkO: any[] = [];
    collect(o, sinkO);
    o.send(JSON.stringify({ type: "identify", userId: "u9", name: "ode" }));
    await wait(30);
    o.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    o.send(JSON.stringify({ type: "list_invites", projectId: "default" }));
    o.send(JSON.stringify({ type: "revoke_invite", projectId: "default", inviteId: invite.id }));
    o.send(JSON.stringify({ type: "create_invite", projectId: "ghost" }));
    await wait(30);
    const refusals = sinkO.filter((m) => m.type === "error");
    expect(refusals.map((m) => m.message)).toEqual([
      "join this project before inviting to it",
      "join this project to see its invites",
      "join this project before revoking its invites",
      "join this project before inviting to it",
    ]);
    expect(refusals.every((m) => m.code === "not_a_member")).toBe(true);
    expect(sinkO.some((m) => m.type === "invite_list")).toBe(false);

    // An UNidentified connection is stopped earlier still.
    const n = await connect(server.port);
    const sinkN: any[] = [];
    collect(n, sinkN);
    n.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    n.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(30);
    expect(sinkN.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "identify first",
      "identify first",
    ]);

    // join_project's own validation: slug shape and project existence.
    const v = await connect(server.port);
    const sinkV: any[] = [];
    collect(v, sinkV);
    v.send(JSON.stringify({ type: "identify", userId: "u8", name: "vic" }));
    await wait(30);
    v.send(JSON.stringify({ type: "join_project", projectId: "BAD SLUG" }));
    v.send(JSON.stringify({ type: "join_project", projectId: "ghost" }));
    v.send(JSON.stringify({ type: "create_invite", projectId: "BAD SLUG" }));
    await wait(30);
    expect(sinkV.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "join_project requires a valid projectId",
      'no project "ghost"',
      "create_invite requires a valid projectId",
    ]);

    // The failed management attempts left the live invite untouched.
    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "peek_invite", token: invite.token }));
    await wait(30);
    expect(sinkB.some((m) => m.type === "invite_info")).toBe(true);
    a.ws.close();
    o.close();
    n.close();
    v.close();
    b.close();
  });

  it("cross-project attacker cannot list, revoke, or redeem another project's invite", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    // Victim founds project "default" and mints an invite.
    const victim = await foundProject(server.port, "default", "u1", "ana");
    victim.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    const victimInvite = victim.sink.find((m) => m.type === "invite_list").invites[0];

    // Attacker founds a DIFFERENT project — project ids are guessable
    // `mpai` slugs, and founding an empty project is open by design.
    const attacker = await foundProject(server.port, "evil", "u2", "eve");
    attacker.ws.send(JSON.stringify({ type: "create_invite", projectId: "evil" }));
    await wait(30);

    // Their own project lists exactly their own invite, never the victim's.
    attacker.ws.send(JSON.stringify({ type: "list_invites", projectId: "evil" }));
    await wait(30);
    const lists = attacker.sink.filter((m) => m.type === "invite_list");
    const own = lists[lists.length - 1].invites;
    expect(own).toHaveLength(1);
    expect(own[0].id).not.toBe(victimInvite.id);

    // Listing the VICTIM's project is a membership refusal; scoping the
    // revoke to the attacker's own project collapses to "unknown invite";
    // redeeming the victim's token against the attacker's project collapses
    // to "invite not found" — the token never confirms it is real elsewhere.
    attacker.ws.send(JSON.stringify({ type: "list_invites", projectId: "default" }));
    attacker.ws.send(
      JSON.stringify({ type: "revoke_invite", projectId: "evil", inviteId: victimInvite.id }),
    );
    attacker.ws.send(
      JSON.stringify({ type: "join_project", projectId: "evil", invite: victimInvite.token }),
    );
    await wait(30);
    const attackerErrors = attacker.sink.filter((m) => m.type === "error");
    expect(attackerErrors.map((m) => m.message)).toEqual([
      "join this project to see its invites",
      `unknown invite: ${victimInvite.id}`,
      "invite not found",
    ]);

    // The victim's invite must still be live — unaffected by all of it.
    const checker = await connect(server.port);
    const sinkChecker: any[] = [];
    collect(checker, sinkChecker);
    checker.send(JSON.stringify({ type: "peek_invite", token: victimInvite.token }));
    await wait(30);
    expect(sinkChecker.find((m) => m.type === "invite_info")).toMatchObject({
      projectId: "default",
      projectName: "default",
    });

    victim.ws.close();
    attacker.ws.close();
    checker.close();
  });

  it("requireInvite blocks an uninvited join of an occupied project without provisioning", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace, requireInvite: true });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");
    a.ws.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    // The founder's session join provisions exactly one worktree for "alpha".
    expect(workspace.calls).toHaveLength(1);

    const b = await joinProject(server.port, "default", "u2", "bob");
    expect(b.sink.find((m) => m.type === "error")?.message).toBe("this project requires an invite");
    expect(b.sink.some((m) => m.type === "projects")).toBe(false);
    // The rejected join provisions nothing and writes no membership.
    expect(workspace.calls).toHaveLength(1);
    b.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    expect(b.sink.filter((m) => m.type === "error").at(-1)?.code).toBe("not_a_member");

    // An EMPTY project stays open to whoever arrives first — the founder slot.
    const c = await foundProject(server.port, "other", "u3", "cal");
    expect(c.sink.some((m) => m.type === "error")).toBe(false);
    a.ws.close();
    b.ws.close();
    c.ws.close();
  });

  it("requireInvite admits a reconnecting founder without a token even while the project stays occupied", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, requireInvite: true });
    close = server.close;

    const a = await foundProject(server.port, "default", "u1", "ana");
    a.ws.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);

    // Admit a second member with a minted invite so the project stays
    // occupied by more than just the reconnecting founder.
    a.ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    await wait(30);
    const invite = a.sink.find((m) => m.type === "invite_list").invites[0];
    const b = await joinProject(server.port, "default", "u2", "bob", invite.token);
    expect(b.sink.some((m) => m.type === "error")).toBe(false);
    b.ws.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u2", name: "bob" }));
    await wait(30);

    // Founder's tab refreshes: socket drops, presence_leave fires.
    a.ws.close();
    await wait(30);

    // Reconnect with the same userId and no token. The project is still
    // occupied (by bob), but u1 was admitted before, so this must succeed.
    const a2 = await connect(server.port);
    const sinkA2: any[] = [];
    collect(a2, sinkA2);
    a2.send(JSON.stringify({ type: "identify", userId: "u1", name: "ana" }));
    await wait(30);
    a2.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(30);
    expect(sinkA2.some((m) => m.type === "error")).toBe(false);
    expect(sinkA2.some((m) => m.type === "projects")).toBe(true);

    a2.close();
    b.ws.close();
  });

  it("requireInvite still rejects a genuinely new userId with no token in an occupied project", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, requireInvite: true });
    close = server.close;

    const a = await foundProject(server.port, "default", "u1", "ana");
    a.ws.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);

    const c = await joinProject(server.port, "default", "u3", "cal");
    expect(c.sink.find((m) => m.type === "error")?.message).toBe("this project requires an invite");

    a.ws.close();
    c.ws.close();
  });
});

describe("project lifecycle", () => {
  // The shared preamble, same shape as "project invites": an identified
  // founder creates and joins a project, leaving the socket positioned right
  // after the join_project ack — which is what makes them a member.
  async function foundProject(
    port: number,
    projectId: string,
    userId: string,
    name: string,
  ): Promise<{ ws: WebSocket; sink: any[] }> {
    const ws = await connect(port);
    const sink: any[] = [];
    collect(ws, sink);
    ws.send(JSON.stringify({ type: "identify", userId, name }));
    ws.send(JSON.stringify({ type: "create_project", name: projectId }));
    await wait(30);
    ws.send(JSON.stringify({ type: "join_project", projectId }));
    await wait(30);
    return { ws, sink };
  }

  const setLifecycle = (ws: WebSocket, projectId: string, lifecycle: string) =>
    ws.send(JSON.stringify({ type: "set_project_lifecycle", projectId, lifecycle }));

  it("round trips active→closed→active and active→archived→active, carried in the summary", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");

    // Free transitions, like the hub — no matrix. Each successful set acks
    // with a fresh projects frame carrying the new lifecycle in the summary.
    setLifecycle(a.ws, "default", "closed");
    await wait(30);
    let last = a.sink.filter((m) => m.type === "projects").at(-1);
    expect(last.projects.find((p: any) => p.id === "default").lifecycle).toBe("closed");

    setLifecycle(a.ws, "default", "active");
    await wait(30);
    last = a.sink.filter((m) => m.type === "projects").at(-1);
    expect(last.projects.find((p: any) => p.id === "default").lifecycle).toBe("active");

    setLifecycle(a.ws, "default", "archived");
    await wait(30);
    last = a.sink.filter((m) => m.type === "projects").at(-1);
    expect(last.projects.find((p: any) => p.id === "default").lifecycle).toBe("archived");

    setLifecycle(a.ws, "default", "active");
    await wait(30);
    last = a.sink.filter((m) => m.type === "projects").at(-1);
    expect(last.projects.find((p: any) => p.id === "default").lifecycle).toBe("active");

    // list_projects reports the same state — the summary carries it, so a
    // fresh entrance read sees what the acks said.
    setLifecycle(a.ws, "default", "closed");
    await wait(30);
    a.ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(30);
    last = a.sink.filter((m) => m.type === "projects").at(-1);
    expect(last.projects.find((p: any) => p.id === "default").lifecycle).toBe("closed");
    a.ws.close();
  });

  it("refuses bad input with the hub's exact strings, in the hub's gate order", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");

    // An UNidentified connection is stopped at the first gate.
    const n = await connect(server.port);
    const sinkN: any[] = [];
    collect(n, sinkN);
    setLifecycle(n, "default", "closed");
    await wait(30);
    expect(sinkN.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "identify first",
    ]);

    // The founder, identified and a member: slug validation, then lifecycle
    // value validation — missing projectId collapses to the slug refusal,
    // missing lifecycle to the value refusal.
    a.ws.send(JSON.stringify({ type: "set_project_lifecycle", projectId: "BAD SLUG", lifecycle: "closed" }));
    a.ws.send(JSON.stringify({ type: "set_project_lifecycle", lifecycle: "closed" }));
    setLifecycle(a.ws, "default", "deleted");
    a.ws.send(JSON.stringify({ type: "set_project_lifecycle", projectId: "default" }));
    await wait(30);
    expect(a.sink.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "set_project_lifecycle requires a valid projectId",
      "set_project_lifecycle requires a valid projectId",
      "lifecycle must be active, closed or archived",
      "lifecycle must be active, closed or archived",
    ]);

    // An identified NON-member gets the membership refusal — and a project
    // that does not exist collapses to the same refusal, like the hub's
    // `store.isMember` answering false for it.
    const o = await connect(server.port);
    const sinkO: any[] = [];
    collect(o, sinkO);
    o.send(JSON.stringify({ type: "identify", userId: "u9", name: "ode" }));
    await wait(30);
    setLifecycle(o, "default", "closed");
    setLifecycle(o, "ghost", "closed");
    await wait(30);
    expect(sinkO.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "join this project before changing it",
      "join this project before changing it",
    ]);

    // None of the refusals touched the state: still active.
    a.ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(30);
    const last = a.sink.filter((m) => m.type === "projects").at(-1);
    expect(last.projects.find((p: any) => p.id === "default").lifecycle).toBe("active");
    a.ws.close();
    n.close();
    o.close();
  });

  it("refuses join_project and create_session while closed with the hub's strings, and allows both after reopen", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const a = await foundProject(server.port, "default", "u1", "ana");
    setLifecycle(a.ws, "default", "closed");
    await wait(30);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "identify", userId: "u2", name: "bob" }));
    await wait(30);
    b.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    b.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(30);
    expect(sinkB.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      'project "default" is not open to new members',
      'project "default" is not open',
    ]);
    // The refused create_session provisioned nothing.
    expect(workspace.calls).toHaveLength(0);
    expect(sinkB.some((m) => m.type === "session_created")).toBe(false);

    // Reopen: the same two messages go through.
    setLifecycle(a.ws, "default", "active");
    await wait(30);
    b.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    b.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(30);
    expect(sinkB.filter((m) => m.type === "error")).toHaveLength(2); // the two above, no new ones
    expect(sinkB.some((m) => m.type === "projects")).toBe(true);
    expect(sinkB.some((m) => m.type === "session_created")).toBe(true);
    expect(workspace.calls).toEqual([{ projectId: "default", slug: "s1", baseRef: "main" }]);
    a.ws.close();
    b.close();
  });
});

describe("auth gate on join", () => {
  const AUTH = {
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: "sekrit",
    allowlist: "ana",
  };

  // The rejection assertions below deliberately check for the ABSENCE of the
  // side effects too. An error frame alone proves nothing: a gate that called
  // sendError() and forgot to `return` would emit the error AND admit the
  // user, and a message-only assertion would stay green through it. This is
  // the one boundary the whole feature rests on.
  it("rejects a join with no session cookie, admitting nobody and provisioning nothing", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(50);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "event" && m.event.type === "presence_join")).toBe(false);
    expect(workspace.calls).toEqual([]);
    ws.close();
  });

  it("rejects a verified user who is not on the allowlist, admitting nobody and provisioning nothing", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH, workspace });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("mallory", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "M" }));
    await wait(50);

    expect(seen.some((m) => m.type === "error" && /allowlist/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "event" && m.event.type === "presence_join")).toBe(false);
    expect(workspace.calls).toEqual([]);
    ws.close();
  });

  // THE load-bearing assertion: the client's claim is discarded.
  it("overwrites a spoofed userId with the verified GitHub login", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(
      JSON.stringify({
        type: "join",
        sessionId: "s1",
        userId: "totally-not-ana",
        name: "Ana",
      }),
    );
    await wait(80);

    const join = seen.find((m) => m.type === "event" && m.event.type === "presence_join");
    expect(join).toBeTruthy();
    expect(join.event.userId).toBe("ana");
    expect(JSON.stringify(seen)).not.toContain("totally-not-ana");
    ws.close();
  });

  // The display name is the string humans actually read, so it is locked to
  // the verified login too (spec §3.4) — otherwise the impersonation simply
  // relocates from userId to the rendered name.
  it("overwrites a spoofed display name with the verified GitHub login", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(
      JSON.stringify({
        type: "join",
        sessionId: "s1",
        userId: "ana",
        name: "Ben",
      }),
    );
    await wait(80);

    const join = seen.find((m) => m.type === "event" && m.event.type === "presence_join");
    expect(join).toBeTruthy();
    expect(join.event.name).toBe("ana");
    // Covers the roster in the project snapshot as well as the event, since
    // both are carried in `seen`.
    expect(JSON.stringify(seen)).not.toContain("Ben");
    ws.close();
  });

  it("leaves the anonymous path untouched when auth is not configured", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(80);

    const join = seen.find((m) => m.type === "event" && m.event.type === "presence_join");
    expect(join.event.userId).toBe("u1");
    ws.close();
  });
});

/** C2: six message types sit ABOVE the `if (!ctx) return sendError("join a
 *  session first")` choke point, so before this gate they were reachable by
 *  anyone who could open a WebSocket — no cookie, no join, no allowlist.
 *
 *  `create_session` is the expensive one: it provisions a real git worktree
 *  and constructs an AgentDriver, whose constructor eagerly spawns the Claude
 *  Agent SDK subprocess against the box's ANTHROPIC_API_KEY. `peek` and
 *  `watch_project` disclose the participant roster — post-A2a a list of real
 *  GitHub logins — plus the LLM-written oversight summary of the team's work.
 *
 *  `peek_invite` stays open on purpose (spec §4.3): the invite sign-in screen
 *  calls it while signed out, and an unguessable token already gates it. */
describe("auth gate on the pre-join message types", () => {
  const AUTH = {
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: "sekrit",
    allowlist: "ana",
  };

  it("rejects create_session with no cookie and provisions no worktree", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "create_session", projectId: "p1", name: "free lunch" }));
    await wait(60);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    // The assertion that actually costs the attacker nothing: no git
    // worktree, no branch, and therefore no agent subprocess.
    expect(workspace.calls).toEqual([]);
    expect(seen.some((m) => m.type === "session_created")).toBe(false);
    ws.close();
  });

  it("rejects peek with no cookie and discloses no roster", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(60);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "project")).toBe(false);
    ws.close();
  });

  it("rejects watch_project with no cookie and discloses no roster", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(60);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "project")).toBe(false);
    ws.close();
  });

  it("rejects create_project with no cookie and grows the registry by nothing", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    // identify stays reachable (per-connection state only) — the attack the
    // gate exists to stop is looping identify + create_project pre-auth.
    ws.send(JSON.stringify({ type: "identify", userId: "mallory", name: "M" }));
    ws.send(JSON.stringify({ type: "create_project", name: "free lunch" }));
    await wait(60);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "project_created")).toBe(false);

    // The side-effect assertion: a signed-in user's list_projects (the
    // non-creating read) shows the write never landed.
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const anaWs = await connectWithCookie(server.port, cookie);
    const anaSeen: any[] = [];
    collect(anaWs, anaSeen);
    anaWs.send(JSON.stringify({ type: "list_projects" }));
    await wait(60);
    const projectsMsg = anaSeen.find((m) => m.type === "projects");
    expect(projectsMsg).toBeTruthy();
    expect(projectsMsg.projects.map((p: any) => p.id)).not.toContain("free-lunch");
    ws.close();
    anaWs.close();
  });

  it("rejects list_projects with no cookie and discloses no project list", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(60);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "projects")).toBe(false);
    ws.close();
  });

  it("still lets a signed-in allowlisted user identify, list and create projects", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "identify", userId: "ana", name: "Ana" }));
    ws.send(JSON.stringify({ type: "create_project", name: "Real Work" }));
    ws.send(JSON.stringify({ type: "list_projects" }));
    await wait(80);

    expect(seen.some((m) => m.type === "error")).toBe(false);
    expect(seen.some((m) => m.type === "project_created" && m.projectId === "real-work")).toBe(true);
    const projectsMsg = seen.find((m) => m.type === "projects");
    expect(projectsMsg.projects.map((p: any) => p.id)).toContain("real-work");
    ws.close();
  });

  it("rejects set_oversight with no cookie and mutates nothing", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    // Ana creates the project so set_oversight has a real target to mutate.
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const owner = await connectWithCookie(server.port, cookie);
    const ownerSeen: any[] = [];
    collect(owner, ownerSeen);
    owner.send(JSON.stringify({ type: "join", sessionId: "s1", projectId: "default", userId: "x", name: "x" }));
    await wait(60);

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "default", enabled: true }));
    await wait(60);

    expect(seen.some((m) => m.type === "error" && /authentication required/.test(m.message))).toBe(true);
    // The owner's snapshots would show oversight.enabled flipping if the
    // mutation had landed.
    const snapshots = ownerSeen.filter((m) => m.type === "project");
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.some((m) => m.oversight?.enabled === true)).toBe(false);
    ws.close();
    owner.close();
  });

  it("rejects an allowlisted-but-not signed-in user the same way", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH, workspace });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("mallory", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "create_session", projectId: "p1", name: "free lunch" }));
    await wait(60);

    expect(seen.some((m) => m.type === "error" && /allowlist/.test(m.message))).toBe(true);
    expect(workspace.calls).toEqual([]);
    ws.close();
  });

  it("still lets a signed-in allowlisted user through all four", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH, workspace });
    close = server.close;
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const ws = await connectWithCookie(server.port, cookie);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "create_session", projectId: "p1", name: "real work" }));
    ws.send(JSON.stringify({ type: "peek", projectId: "p1" }));
    ws.send(JSON.stringify({ type: "watch_project", projectId: "p1" }));
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "p1", enabled: true }));
    await wait(120);

    expect(seen.some((m) => m.type === "error")).toBe(false);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);
    expect(workspace.calls.map((c) => c.slug)).toEqual(["real-work"]);
    ws.close();
  });

  // peek_invite is the one pre-join type that MUST stay open: InviteSignIn
  // renders it for a signed-out visitor. Rejecting at the WS upgrade instead
  // of here would have broken exactly this.
  it("leaves peek_invite reachable with no cookie", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "peek_invite", token: "nope" }));
    await wait(60);

    // The token is bogus, so this is an invite error — NOT an auth error.
    // The point is that the auth gate did not consume the message.
    const err = seen.find((m) => m.type === "error");
    expect(err).toBeTruthy();
    expect(err.message).not.toMatch(/authentication required/);
    ws.close();
  });

  // The PROJECT-level invite messages (plan 2026-08-01-project-invites) sit
  // above the join choke point too, so they take the same cookie gate as
  // list_projects/create_project — only peek_invite stays open.
  it("rejects join_project and invite management with no cookie", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "identify", userId: "mallory", name: "M" }));
    ws.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    ws.send(JSON.stringify({ type: "create_invite", projectId: "default" }));
    ws.send(JSON.stringify({ type: "list_invites", projectId: "default" }));
    ws.send(JSON.stringify({ type: "revoke_invite", projectId: "default", inviteId: "nope1234" }));
    await wait(60);

    const errors = seen.filter((m) => m.type === "error");
    // identify answered; the four gated types each refused before any
    // membership check could run.
    expect(seen.some((m) => m.type === "identified")).toBe(true);
    expect(errors).toHaveLength(4);
    expect(errors.every((m) => /authentication required/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "invite_list" || m.type === "projects")).toBe(false);
    ws.close();
  });

  it("leaves all four unguarded when auth is not configured", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "create_session", projectId: "p1", name: "dev flow" }));
    ws.send(JSON.stringify({ type: "peek", projectId: "p1" }));
    ws.send(JSON.stringify({ type: "watch_project", projectId: "p1" }));
    ws.send(JSON.stringify({ type: "set_oversight", projectId: "p1", enabled: true }));
    await wait(120);

    expect(seen.some((m) => m.type === "error")).toBe(false);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);
    expect(workspace.calls.map((c) => c.slug)).toEqual(["dev-flow"]);
    ws.close();
  });
});

describe("repo identity on the project snapshot", () => {
  const lastProject = (seen: any[]) => [...seen].reverse().find((m) => m.type === "project");

  it("stamps every session with the repo key", async () => {
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: { ...fakeWorkspace(), repoKey: () => "github.com/acme/api" },
    });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);

    const snap = lastProject(seen);
    expect(snap).not.toHaveProperty("repo");
    expect(snap.sessions.find((s: any) => s.id === "ana").repoKey).toBe("github.com/acme/api");

    ws.close();
  });

  it("reports a null repo key when the server has no workspace", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);

    const snap = lastProject(seen);
    expect(snap).not.toHaveProperty("repo");
    expect(snap.sessions.find((s: any) => s.id === "ana").repoKey).toBeNull();

    ws.close();
  });
});

describe("session lifecycle", () => {
  const lastProject = (seen: any[]) => [...seen].reverse().find((m) => m.type === "project");

  it("reports open by default and closed after close_session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);
    expect(lastProject(seen).sessions.find((s: any) => s.id === "ana").lifecycle).toBe("open");

    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    expect(lastProject(seen).sessions.find((s: any) => s.id === "ana").lifecycle).toBe("closed");

    ws.close();
  });

  it("attributes the close on the wire so history says who did it", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);

    const closed = seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].event.userId).toBe("u1");

    ws.close();
  });

  it("lets any participant close, not only the driver", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    collect(wsAna, []);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(100);

    // Ben joins second, so Ana holds the wheel and Ben is a passenger.
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(100);
    wsBen.send(JSON.stringify({ type: "close_session" }));
    await wait(200);

    expect(lastProject(seenBen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("closed");

    wsAna.close();
    wsBen.close();
  });

  it("refuses a prompt to a closed session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    ws.send(JSON.stringify({ type: "prompt", text: "keep going" }));
    await wait(200);

    const errors = seen.filter((m: any) => m.type === "error");
    expect(errors.some((e: any) => /closed/i.test(e.message))).toBe(true);

    ws.close();
  });

  it("refuses a second close rather than appending a duplicate event", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);

    expect(
      seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed"),
    ).toHaveLength(1);

    ws.close();
  });

  it("refuses a skill suggestion on a closed session — it would start a new agent run", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    ws.send(JSON.stringify({ type: "suggest_skill", skill: "tools:alpha", args: "" }));
    await wait(200);

    const errors = seen.filter((m: any) => m.type === "error");
    expect(errors.some((e: any) => /closed/i.test(e.message))).toBe(true);
    expect(seen.some((m: any) => m.event?.type === "skill_suggest")).toBe(false);

    ws.close();
  });

  it("refuses a skill decision on a closed session — approving would start a new agent run", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    ws.send(JSON.stringify({ type: "decide_skill", suggestId: "whatever", decision: "run" }));
    await wait(200);

    const errors = seen.filter((m: any) => m.type === "error");
    expect(errors.some((e: any) => /closed/i.test(e.message))).toBe(true);
    expect(seen.some((m: any) => m.event?.type === "skill_decision")).toBe(false);

    ws.close();
  });

  it("still lets the driver resolve an in-flight permission request after the session is closed", async () => {
    // Deliberate exemption: `permission` resolves a request already in flight
    // (the agent is paused waiting for a decision). Guarding it would strand
    // that agent forever on a promise nobody can resolve, which is worse than
    // the problem closing is meant to solve. Do not "tidy" this into a guard.
    const bashAskRun: RunQuery = async function* (prompts, hooks) {
      for await (const prompt of prompts) {
        const decision = await hooks.onPermissionRequest("Bash", { command: "npm run build" });
        yield { type: "assistant", content: [{ type: "text", text: `bash: ${decision}` }] };
      }
    };
    const server = await startServer({ port: 0, runQuery: bashAskRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "prompt", text: "build it" }));
    await wait(200);

    const req = seen.map((m) => m.event).find((e) => e?.type === "permission_request");
    expect(req).toBeTruthy();

    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);

    ws.send(JSON.stringify({ type: "permission", requestId: req.requestId, decision: "allow" }));
    await wait(200);

    const decision = seen.find((m) => m.event?.type === "permission_decision")?.event;
    expect(decision).toMatchObject({ requestId: req.requestId, decision: "allow" });
    expect(seen.some((m: any) => m.type === "error" && /closed/i.test(m.message))).toBe(false);

    ws.close();
  });

  it("reports presence online on a standalone server, which owns every session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);

    expect(lastProject(seen).sessions.find((s: any) => s.id === "ana").presence).toBe("online");

    ws.close();
  });

  it("removes the sender from the roster on leave_session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    collect(wsBen, []);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    // Assert on the event stream, not a `project` snapshot: a second
    // participant's `presence_join` does not force an immediate push, so a
    // snapshot-only assertion here would pass even with no leave_session
    // handler at all — Ben would simply never have appeared in a snapshot
    // to begin with.
    const leaves = seen.filter(
      (m: any) => m.type === "event" && m.event.type === "presence_leave" && m.event.userId === "u2",
    );
    expect(leaves).toHaveLength(1);

    const row = lastProject(seen).sessions.find((s: any) => s.id === "s");
    expect(row.participants).toEqual(["Ana"]);

    wsAna.close();
    wsBen.close();
  });

  it("does NOT close the session when someone leaves and others remain", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    collect(wsBen, []);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    // Assert on the event stream: reading "open" off a `project` snapshot
    // can pass merely because no fresh snapshot happened to arrive, which
    // would be true even with a broken handler. Absence of a session_closed
    // event is the real claim.
    const closed = seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(0);

    expect(lastProject(seen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("open");

    wsAna.close();
    wsBen.close();
  });

  it("closes the session when the LAST participant leaves deliberately", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsWatch = await connect(server.port);
    const seen: any[] = [];
    collect(wsWatch, seen);
    wsWatch.send(JSON.stringify({ type: "watch_project", projectId: "demo" }));

    const wsAna = await connect(server.port);
    collect(wsAna, []);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(200);

    wsAna.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    expect(lastProject(seen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("closed");

    wsWatch.close();
    wsAna.close();
  });

  it("attributes the auto-close to the participant who left last", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    const closed = seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].event.userId).toBe("u1");

    wsAna.close();
  });

  it("a socket close does NOT close the session, even for the last participant", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsWatch = await connect(server.port);
    const seen: any[] = [];
    collect(wsWatch, seen);
    wsWatch.send(JSON.stringify({ type: "watch_project", projectId: "demo" }));

    const wsAna = await connect(server.port);
    collect(wsAna, []);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(200);

    wsAna.close();
    await wait(300);

    // The whole point of leave_session existing: a dropped connection is not
    // a statement of intent, and v7a made closing one-way.
    expect(lastProject(seen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("open");

    wsWatch.close();
  });

  it("writes exactly one presence_leave when leave_session is followed by the socket closing", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsWatch = await connect(server.port);
    collect(wsWatch, []);
    wsWatch.send(JSON.stringify({ type: "watch_project", projectId: "demo" }));

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(200);
    wsAna.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);
    wsAna.close();
    await wait(300);

    const rejoin = await connect(server.port);
    const replay: any[] = [];
    collect(rejoin, replay);
    rejoin.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(300);

    const leaves = replay.filter(
      (m: any) => m.type === "event" && m.event.type === "presence_leave" && m.event.userId === "u1",
    );
    expect(leaves).toHaveLength(1);

    // Pin this task, not just Task 1's idempotency guard: leave_session was
    // the sole participant's deliberate exit, so it must have auto-closed —
    // attributed to u1 — before the socket ever dropped. Without this
    // assertion, deleting the leave_session handler outright would not fail
    // this test (the socket-close leave alone still produces exactly one
    // presence_leave).
    const closed = replay.filter(
      (m: any) => m.type === "event" && m.event.type === "session_closed" && m.event.userId === "u1",
    );
    expect(closed).toHaveLength(1);

    rejoin.close();
    wsWatch.close();
  });

  it("still lets someone leave an already-closed session, without closing it twice", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    collect(wsBen, []);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    wsBen.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    const closed = seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(1);
    const row = lastProject(seen).sessions.find((s: any) => s.id === "s");
    expect(row.participants).toEqual(["Ana"]);
    expect(row.lifecycle).toBe("closed");

    wsAna.close();
    wsBen.close();
  });

  it("does NOT auto-close on a stale leave_session that didn't actually empty the room", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    // Ben leaves deliberately. Ana remains — session stays open.
    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    // Ana's connection drops (not a deliberate exit) — session stays open,
    // per the whole point of this feature.
    wsAna.close();
    await wait(200);

    // Ben, still connected, sends leave_session AGAIN. He already left, so
    // `Session.leave` is a no-op — but the room is now empty because of
    // Ana's disconnect, not because of this call. This must NOT auto-close:
    // a stale repeat leave_session must not get credit (or blame) for a
    // departure it did not cause.
    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    const closed = seenBen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(0);
    expect(lastProject(seenBen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("open");

    wsBen.close();
  });

  it("refuses take_wheel from someone who has left but is still connected", async () => {
    // leave_session deliberately does not null ctx (that would skip
    // ctx.unsubscribe() / ctx.project.watchers.delete(ws) and leak both), so
    // a departed-but-connected socket is reachable — e.g. a second tab of the
    // same signed-in user, since auth replaces userId with the verified
    // login. Without this guard that socket could take the wheel while
    // absent from the roster, and every other surface would show a turn
    // running with no driver named.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seenAna: any[] = [];
    collect(wsAna, seenAna);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    // Ben leaves deliberately but keeps his socket open.
    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    seenBen.length = 0;
    wsBen.send(JSON.stringify({ type: "take_wheel" }));
    await wait(200);

    expect(seenBen.some((m: any) => m.type === "error")).toBe(true);
    expect(seenBen.some((m: any) => m.event?.type === "control_change" && m.event.userId === "u2")).toBe(false);

    // Ana, the sole remaining participant, is still the driver.
    const row = lastProject(seenAna).sessions.find((s: any) => s.id === "s");
    expect(row.driverName).toBe("Ana");

    wsAna.close();
    wsBen.close();
  });
});

describe("relay-mode connections", () => {
  it("accepts a stamped identity instead of a cookie, and never lets the payload override it", async () => {
    // The trust inversion (spec §3.5 rule 1): under the relay the HUB has
    // already verified who is speaking, so the laptop takes identity from the
    // stamp. A payload that claims someone else must be discarded exactly as
    // a cookie-verified join discards a forged userId today.
    //
    // Asserted by reading the overwrite back OUT of the log rather than by
    // inspecting what the relay connection was sent: a relay join is silent by
    // construction, so an assertion over its own outbox is green no matter
    // what the identity code does. A direct client joining the same session
    // replays the log, and that replay is where the forgery would show up.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const relay = server.createConnection({
      mode: "relay",
      send: () => {},
      stampedIdentity: { userId: "ana", name: "ana" },
    });
    relay.handleMessage({ type: "join", sessionId: "s1", userId: "totally-not-ana", name: "Mallory" });

    const seen: any[] = [];
    const direct = server.createConnection({ mode: "direct", send: (m) => seen.push(m) });
    direct.handleMessage({ type: "join", sessionId: "s1", userId: "ben", name: "Ben" });

    const joins = seen
      .filter((m) => m.type === "event" && m.event?.type === "presence_join")
      .map((m) => m.event);
    expect(joins.some((e: any) => e.userId === "ana" && e.name === "ana")).toBe(true);
    expect(JSON.stringify(joins)).not.toContain("totally-not-ana");
    expect(JSON.stringify(joins)).not.toContain("Mallory");
  });

  it("makes a relay connection without a stamp unrepresentable", () => {
    // The fail-open this rules out: when identity keyed off an optional
    // `stampedIdentity` but replay keyed off `mode`, a { mode: "relay" } with
    // no stamp fell through to requireAuth(undefined) and — with auth
    // disabled — kept the payload's claimed userId. ConnectionIO is now a
    // discriminated union, so the connection cannot be constructed at all.
    //
    // This is a compile-time assertion, and it is load-bearing rather than
    // decorative: tsconfig.json includes "test", so `tsc --noEmit` fails if
    // the line below ever starts compiling.
    type IO = Parameters<
      Awaited<ReturnType<typeof startServer>>["createConnection"]
    >[0];
    // @ts-expect-error - relay requires stampedIdentity
    const stampless: IO = { mode: "relay", send: () => {} };
    expect(stampless.mode).toBe("relay");
  });

  it("does not replay the log or subscribe per client in relay mode", async () => {
    // The hub owns replay and fan-out (spec §3.2). If the laptop also replayed
    // and subscribed per browser, a session with six watchers would push six
    // copies of every event up one uplink — the exact cost the two-plane
    // design exists to avoid.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const direct: any[] = [];
    const dconn = server.createConnection({ mode: "direct", send: (m) => direct.push(m) });
    dconn.handleMessage({ type: "join", sessionId: "s2", userId: "ana", name: "ana" });
    const directEvents = direct.filter((m) => m.type === "event").length;
    expect(directEvents).toBeGreaterThan(0);

    const relayed: any[] = [];
    const rconn = server.createConnection({
      mode: "relay",
      send: (m) => relayed.push(m),
      stampedIdentity: { userId: "ben", name: "ben" },
    });
    rconn.handleMessage({ type: "join", sessionId: "s3", userId: "ben", name: "ben" });
    expect(relayed.filter((m: any) => m.type === "event")).toHaveLength(0);
    expect(relayed.filter((m: any) => m.type === "project")).toHaveLength(0);
  });

  it("still enforces the driver gate for a relayed participant", async () => {
    // Approval authority comes from presence, not from transport (spec §2.9).
    // The gate rules are laptop-local and unchanged (spec §3.5 rule 3).
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const a: any[] = [];
    const b: any[] = [];
    const ana = server.createConnection({ mode: "relay", send: (m) => a.push(m), stampedIdentity: { userId: "ana", name: "ana" } });
    ana.handleMessage({ type: "join", sessionId: "s4", userId: "ana", name: "ana" });
    const ben = server.createConnection({ mode: "relay", send: (m) => b.push(m), stampedIdentity: { userId: "ben", name: "ben" } });
    ben.handleMessage({ type: "join", sessionId: "s4", userId: "ben", name: "ben" });

    ben.handleMessage({ type: "prompt", text: "hi" });
    expect(b.some((m) => m.type === "error" && /not driving/.test(m.message))).toBe(true);
  });

  it("drops the participant on close, exactly as a socket close does", async () => {
    // "Did not throw" is not evidence of a departure, and the relay side is
    // silent, so the departure is witnessed through a direct client subscribed
    // to the same session — the same way a real teammate would see it.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const sent: any[] = [];
    const conn = server.createConnection({ mode: "relay", send: (m) => sent.push(m), stampedIdentity: { userId: "ana", name: "ana" } });
    conn.handleMessage({ type: "join", sessionId: "s5", userId: "ana", name: "ana" });

    const seen: any[] = [];
    const witness = server.createConnection({ mode: "direct", send: (m) => seen.push(m) });
    witness.handleMessage({ type: "join", sessionId: "s5", userId: "ben", name: "Ben" });
    seen.length = 0; // ignore the witness's own replay and join

    conn.close();
    conn.close(); // idempotent — a relay channel can be torn down twice

    const leaves = seen.filter(
      (m) => m.type === "event" && m.event?.type === "presence_leave" && m.event.userId === "ana",
    );
    // Exactly one: the second close must not append a second departure, which
    // is what "idempotent" has to mean for an append-only log replayed to
    // every late joiner.
    expect(leaves).toHaveLength(1);
    expect(sent.some((m) => m.type === "error")).toBe(false);
  });
});

describe("repo set", () => {
  it("create_session with an explicit repoKey resolves through the map and refuses an unattached candidate", async () => {
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: cwd,
      repoCandidates: [{ key: "github.com/acme/web", label: "web", root: "/tmp/web" }],
    });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1", repoKey: "github.com/acme/api" }));
    await wait(200);
    expect(seen.some((m) => m.type === "session_created" && m.sessionId === "s1")).toBe(true);
    expect(cwd.calls.map((c) => c.slug)).toEqual(["s1"]);
    // The candidate exists in the map but is NOT attached — refusal, not provisioning.
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s2", repoKey: "github.com/acme/web" }));
    await wait(200);
    expect(seen.some((m) => m.type === "error" && /not attached/.test(m.message))).toBe(true);
    expect(cwd.calls.map((c) => c.slug)).toEqual(["s1"]); // and nothing provisioned anywhere
    ws.close();
  });

  it("create_session with no repoKey keeps today's single-repo behavior", async () => {
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: cwd });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(200);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);
    expect(cwd.calls).toEqual([{ projectId: "default", slug: "s1", baseRef: "main" }]);
    ws.close();
  });

  it("create_session with zero repos gives an actionable refusal naming the MACHINES panel (was: legacy verbatim, Constraint 9; copy updated per whole-branch review's optional fold-in)", async () => {
    // "server not launched in a repo" was accurate for the original,
    // never-attached case but misleading for a server that WAS launched in a
    // repo and then had it detached — the recovery path (MACHINES panel) also
    // did not exist when the old copy was written.
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(200);
    expect(
      seen.some(
        (m) =>
          m.type === "error" &&
          m.message === "no repo is attached on this machine — attach one from the MACHINES panel",
      ),
    ).toBe(true);
    ws.close();
  });

  it("deep-link join to a never-created session binds the lone attached repo", async () => {
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: cwd });
    close = server.close;
    const ws = await connect(server.port);
    collect(ws, []);
    ws.send(JSON.stringify({ type: "join", sessionId: "fresh", userId: "u1", name: "Ana" }));
    await wait(200);
    expect(cwd.calls).toEqual([{ projectId: "default", slug: "fresh", baseRef: "main" }]);
    ws.close();
  });

  it("the snapshot's session rows carry each session's OWN repoKey", async () => {
    // Pins the entry.repoKey binding through the snapshot path. TWO sessions
    // in TWO repos, deliberately: the single-repo version of this assertion
    // passed just as happily for a machine-wide global, which is the exact
    // defect the per-entry binding exists to prevent. Attaching the candidate
    // (Task 6) is what makes the divergent case constructible at all.
    const api = keyedWorkspace("github.com/acme/api");
    const web = keyedWorkspace("github.com/acme/web");
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: api,
      repoCandidates: [{ key: "github.com/acme/web", label: "web", root: "/tmp/web" }],
      workspaceFor: () => web,
      defaultBaseRef: () => "origin/main",
    });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1", repoKey: "github.com/acme/api" }));
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s2", repoKey: "github.com/acme/web" }));
    await wait(200);
    ws.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(200);
    const snap = [...seen].reverse().find((m) => m.type === "project" && m.sessions?.length === 2);
    expect(Object.fromEntries(snap.sessions.map((s: any) => [s.id, s.repoKey]))).toEqual({
      s1: "github.com/acme/api",
      s2: "github.com/acme/web",
    });
    ws.close();
  });
});

describe("attach and detach repos", () => {
  const AUTH = {
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: "sekrit",
    allowlist: "ana",
  };

  /** A machine holding its cwd repo (attached) plus one scanned candidate
   *  (not), with both attach seams injected so nothing here touches real git.
   *  `built` records every root the attach path asked a workspace for — the
   *  side-effect witness for "lazily, and exactly once". */
  function twoRepoFixture() {
    const api = keyedWorkspace("github.com/acme/api");
    const web = keyedWorkspace("github.com/acme/web");
    const built: string[] = [];
    return {
      api,
      web,
      built,
      opts: {
        port: 0,
        runQuery: echoRun,
        workspace: api,
        repoCandidates: [{ key: "github.com/acme/web", label: "web", root: "/tmp/web" }],
        workspaceFor: (root: string) => {
          built.push(root);
          return web;
        },
        defaultBaseRef: () => "origin/main",
      },
    };
  }

  /** One hub end, enough to watch what the uplink declares. */
  function fakeHub() {
    const sent: any[] = [];
    const handlers = new Map<string, (arg?: unknown) => void>();
    return {
      connect: () => ({
        send: (data: string) => void sent.push(JSON.parse(data)),
        close: () => {},
        on: (event: string, fn: (arg?: unknown) => void) => void handlers.set(event, fn),
      }),
      sent,
      open: () => handlers.get("open")?.(),
      deliver: (frame: unknown) => handlers.get("message")?.(JSON.stringify(frame)),
    };
  }

  const reposFrames = (hub: { sent: any[] }) => hub.sent.filter((f: any) => f.t === "repos");
  const declOf = (repos: any[], key: string) => repos.find((r: any) => r.key === key);

  it("attaches a scanned candidate and then hosts a session in it, off the injected base ref", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    expect(seen.some((m) => m.type === "repo_attached" && m.repoKey === "github.com/acme/web")).toBe(true);
    expect(seen.some((m) => m.type === "error")).toBe(false);
    // Lazily, and from the candidate's own root — not the cwd repo's.
    expect(f.built).toEqual(["/tmp/web"]);

    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1", repoKey: "github.com/acme/web" }));
    await wait(200);
    expect(seen.some((m) => m.type === "session_created" && m.sessionId === "s1")).toBe(true);
    // The proof the attach really built a usable workspace: the session was
    // provisioned in it, at the default branch the attach path computed.
    expect(f.web.calls).toEqual([{ projectId: "default", slug: "s1", baseRef: "origin/main" }]);
    expect(f.api.calls).toEqual([]);
    ws.close();
  });

  it("refuses a key this machine does not list, and bounds the key it echoes back", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/nope" }));
    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "x".repeat(500) }));
    ws.send(JSON.stringify({ type: "attach_repo" }));
    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/nope" }));
    await wait(100);

    const errors = seen.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors[0]).toBe(`repo "github.com/acme/nope" is not in this machine's repo list`);
    // Untrusted input reflected into a refusal, bounded like every other repo
    // key that reaches this file (MAX_REPO_KEY_LENGTH).
    expect(errors[1].length).toBeLessThan(300);
    expect(errors[2]).toBe("attach_repo requires repoKey");
    expect(errors[3]).toBe(`repo "github.com/acme/nope" is not in this machine's repo list`);
    expect(seen.some((m) => m.type === "repo_attached" || m.type === "repo_detached")).toBe(false);
    expect(f.built).toEqual([]);
    ws.close();
  });

  it("stays unattached and replies the git error when building the workspace fails", async () => {
    const api = keyedWorkspace("github.com/acme/api");
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: api,
      repoCandidates: [{ key: "github.com/acme/web", label: "web", root: "/tmp/web" }],
      workspaceFor: () => {
        throw new Error("fatal: not a git repository");
      },
      defaultBaseRef: () => "origin/main",
    });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    expect(seen.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "fatal: not a git repository",
    ]);
    expect(seen.some((m) => m.type === "repo_attached")).toBe(false);

    // Nothing half-written. `defaultBranch` is computed BEFORE the workspace,
    // so a failure there must not leave the picker offering a base ref for a
    // repo this machine cannot provision in (RepoEntry's stated invariant:
    // both null until attached).
    ws.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(100);
    const snap = [...seen].reverse().find((m) => m.type === "project");
    expect(declOf(snap.machines[0].repos, "github.com/acme/web")).toEqual({
      key: "github.com/acme/web",
      label: "web",
      attached: false,
      defaultBranch: null,
    });

    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1", repoKey: "github.com/acme/web" }));
    await wait(150);
    expect(seen.some((m) => m.type === "error" && /is not attached on this machine/.test(m.message))).toBe(true);
    ws.close();
  });

  it("acks a second attach without rebuilding the workspace", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);
    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);

    // Idempotent: a bare ack, not an error, and no second workspace — a
    // rebuild would swap the live workspace out from under running sessions.
    expect(seen.filter((m) => m.type === "repo_attached")).toHaveLength(2);
    expect(seen.some((m) => m.type === "error")).toBe(false);
    expect(f.built).toEqual(["/tmp/web"]);
    ws.close();
  });

  it("refuses a detach while an open session is bound to the repo, naming the blockers", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "auth fix", repoKey: "github.com/acme/web" }));
    await wait(200);
    seen.length = 0;

    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    expect(seen.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      "cannot detach: 1 open session (auth-fix)",
    ]);
    expect(seen.some((m) => m.type === "repo_detached")).toBe(false);

    // A refused detach must change nothing: the repo is still attached and
    // still hosting.
    ws.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(100);
    const snap = [...seen].reverse().find((m) => m.type === "project");
    expect(declOf(snap.machines[0].repos, "github.com/acme/web").attached).toBe(true);
    ws.close();
  });

  it("detaches once the only session bound to the repo has been closed", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "auth fix", repoKey: "github.com/acme/web" }));
    await wait(200);

    // End it the way a person does — join, then close_session (lifecycle.ts
    // reads the session_closed event, nothing else).
    const closer = await connect(server.port);
    collect(closer, []);
    closer.send(JSON.stringify({ type: "join", projectId: "default", sessionId: "auth-fix", userId: "u1", name: "Ana" }));
    await wait(150);
    closer.send(JSON.stringify({ type: "close_session" }));
    await wait(150);
    seen.length = 0;

    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    expect(seen.some((m) => m.type === "repo_detached" && m.repoKey === "github.com/acme/web")).toBe(true);
    expect(seen.some((m) => m.type === "error")).toBe(false);

    // Really detached: it can no longer host.
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s2", repoKey: "github.com/acme/web" }));
    await wait(150);
    expect(seen.some((m) => m.type === "error" && /is not attached on this machine/.test(m.message))).toBe(true);
    ws.close();
    closer.close();
  });

  it("refuses to detach a repo it was launched in but could never find again", async () => {
    // The direct-API cwd entry: an injected workspace with no root on disk to
    // rebuild from. Detaching it would strand the machine with a repo nobody
    // can ever re-attach, which is worse than refusing.
    const api = keyedWorkspace("github.com/acme/api");
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: api });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/api" }));
    await wait(100);
    expect(seen.filter((m) => m.type === "error").map((m) => m.message)).toEqual([
      `repo "github.com/acme/api" was launched without a root and cannot be re-attached — detach refused`,
    ]);
    expect(seen.some((m) => m.type === "repo_detached")).toBe(false);

    // Untouched, so it still hosts.
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(150);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);
    ws.close();
  });

  it("keeps the candidate after a detach, so it can be attached again", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);
    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);
    // Detaching a candidate that is already detached is an ack too.
    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);
    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(80);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1", repoKey: "github.com/acme/web" }));
    await wait(200);

    expect(seen.some((m) => m.type === "error")).toBe(false);
    expect(seen.filter((m) => m.type === "repo_detached")).toHaveLength(2);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);
    // Re-attaching builds a fresh workspace — the detached one was released.
    expect(f.built).toEqual(["/tmp/web", "/tmp/web"]);
    ws.close();
  });

  it("attaching a second repo makes both several-repos refusals reachable", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);

    // (1) create_session with no key and two repos attached.
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(150);
    expect(seen.some((m) => m.type === "error" && m.message === "several repos are attached — specify a repo")).toBe(true);

    // (2) deep-link join to a session that was never created, same ambiguity.
    const ws2 = await connect(server.port);
    const seen2: any[] = [];
    collect(ws2, seen2);
    ws2.send(JSON.stringify({ type: "join", projectId: "default", sessionId: "fresh", userId: "u1", name: "Ana" }));
    await wait(200);
    expect(
      seen2.some(
        (m) => m.type === "error" && m.message === `session "fresh" does not exist — create it from the project screen`,
      ),
    ).toBe(true);

    // Neither refusal guessed a repo and provisioned there anyway.
    expect(f.api.calls).toEqual([]);
    expect(f.web.calls).toEqual([]);
    ws.close();
    ws2.close();
  });

  it("pushes a fresh project snapshot on both acks", async () => {
    const f = twoRepoFixture();
    const server = await startServer(f.opts);
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(80);

    seen.length = 0;
    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    const afterAttach = [...seen].reverse().find((m) => m.type === "project");
    expect(declOf(afterAttach.machines[0].repos, "github.com/acme/web")).toEqual({
      key: "github.com/acme/web",
      label: "web",
      attached: true,
      defaultBranch: "origin/main",
    });

    seen.length = 0;
    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    const afterDetach = [...seen].reverse().find((m) => m.type === "project");
    expect(declOf(afterDetach.machines[0].repos, "github.com/acme/web")).toEqual({
      key: "github.com/acme/web",
      label: "web",
      attached: false,
      defaultBranch: null,
    });
    ws.close();
  });

  it("re-declares the whole repo set on the uplink after each ack", async () => {
    const f = twoRepoFixture();
    const hub = fakeHub();
    const server = await startServer({
      ...f.opts,
      hub: { url: "ws://hub.test", projectId: "default", connect: hub.connect },
    });
    close = server.close;
    hub.open();
    hub.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });

    const ws = await connect(server.port);
    collect(ws, []);
    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    expect(reposFrames(hub)).toHaveLength(1);
    expect(declOf(reposFrames(hub)[0].repos, "github.com/acme/web").attached).toBe(true);

    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    expect(reposFrames(hub)).toHaveLength(2);
    // The hub replaces its record wholesale, so the frame carries the cwd repo
    // as well as the one that just changed.
    expect(reposFrames(hub)[1].repos.map((r: any) => r.key)).toEqual([
      "github.com/acme/api",
      "github.com/acme/web",
    ]);
    expect(declOf(reposFrames(hub)[1].repos, "github.com/acme/web").attached).toBe(false);
    ws.close();
  });

  it("refuses attach_repo and detach_repo with no cookie when auth is on, and builds nothing", async () => {
    const f = twoRepoFixture();
    const server = await startServer({ ...f.opts, auth: AUTH });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "github.com/acme/api" }));
    await wait(100);

    expect(seen.filter((m) => m.type === "error" && /authentication required/.test(m.message))).toHaveLength(2);
    expect(seen.some((m) => m.type === "repo_attached" || m.type === "repo_detached")).toBe(false);
    // The gate has to run BEFORE the work: an unauthenticated frame must not
    // shell out to git or drop a live repo.
    expect(f.built).toEqual([]);

    // ...and a signed-in allowlisted user still gets through.
    const cookie = `${SESSION_COOKIE}=${signSession("ana", AUTH.sessionSecret)}`;
    const anaWs = await connectWithCookie(server.port, cookie);
    const anaSeen: any[] = [];
    collect(anaWs, anaSeen);
    anaWs.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
    await wait(100);
    expect(anaSeen.some((m) => m.type === "repo_attached")).toBe(true);
    expect(f.built).toEqual(["/tmp/web"]);
    ws.close();
    anaWs.close();
  });

  describe("RepoDecl bounds (Finding 1)", () => {
    // A machine's real label/key/branch is unbounded upstream (a repo
    // directory name, a git remote path, a branch name), while the hub's
    // parser (relayProtocol.ts's repoList) rejects the WHOLE hello or repos
    // frame on a single out-of-bounds entry. Without a clamp, a 101-char repo
    // directory name takes the machine off the hub with a misleading
    // "versions may not match" loop (relay.ts's 1008 log) — forever, since
    // the reconnect just resends the same oversized decl. Each case here
    // pins the fix by feeding the REAL frame the uplink would have sent
    // through `parseUpFrame`, so a regression fails here, not just on
    // `clampRepoDecl` in isolation.

    it("clamps an over-long cwd label so the uplink's hello stays parseable", async () => {
      const cwd = keyedWorkspace("github.com/acme/api");
      const hub = fakeHub();
      const server = await startServer({
        port: 0,
        runQuery: echoRun,
        workspace: cwd,
        workspaceLabel: "x".repeat(101),
        hub: { url: "ws://hub.test", projectId: "default", connect: hub.connect },
      });
      close = server.close;
      hub.open();

      expect(hub.sent).toHaveLength(1);
      const helloFrame = hub.sent[0];
      expect(helloFrame.t).toBe("hello");
      const decl = declOf(helloFrame.repos, "github.com/acme/api");
      expect(decl.label.length).toBeLessThanOrEqual(100);
      // The whole point: the hub's own parser has to accept this frame.
      expect(parseUpFrame(helloFrame)).not.toBeNull();
    });

    it("falls back to the key when a candidate's label is empty (a root-path repo), so the hello stays parseable", async () => {
      const cwd = keyedWorkspace("github.com/acme/api");
      const hub = fakeHub();
      const server = await startServer({
        port: 0,
        runQuery: echoRun,
        workspace: cwd,
        repoCandidates: [{ key: "local:host:deadbeefcafe", label: "", root: "/" }],
        hub: { url: "ws://hub.test", projectId: "default", connect: hub.connect },
      });
      close = server.close;
      hub.open();

      const helloFrame = hub.sent[0];
      const decl = declOf(helloFrame.repos, "local:host:deadbeefcafe");
      expect(decl.label).toBe("local:host:deadbeefcafe");
      expect(decl.label.length).toBeGreaterThan(0);
      expect(parseUpFrame(helloFrame)).not.toBeNull();
    });

    it("clamps an over-long defaultBranch after attach so the repos frame stays parseable", async () => {
      const f = twoRepoFixture();
      const hub = fakeHub();
      const server = await startServer({
        ...f.opts,
        defaultBaseRef: () => `origin/${"b".repeat(150)}`,
        hub: { url: "ws://hub.test", projectId: "default", connect: hub.connect },
      });
      close = server.close;
      hub.open();
      hub.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {} });

      const ws = await connect(server.port);
      collect(ws, []);
      ws.send(JSON.stringify({ type: "attach_repo", repoKey: "github.com/acme/web" }));
      await wait(100);

      const frame = reposFrames(hub).at(-1);
      const decl = declOf(frame.repos, "github.com/acme/web");
      expect(decl.defaultBranch.length).toBeLessThanOrEqual(100);
      expect(parseUpFrame(frame)).not.toBeNull();
      ws.close();
    });

    it("refuses to construct when the repo set exceeds spec §5.1's 100 cap — a direct-API caller bypassing cli.ts's finalizeCandidates", async () => {
      // finalizeCandidates (cli.ts) only guards the `mpai` launch path. A
      // direct-API caller — this test stands in for one — can hand
      // startServer a workspace plus 100 repoCandidates and reproduce the
      // exact 101-decl hello finalizeCandidates exists to prevent, unless
      // startServer enforces the cap itself.
      const cwd = keyedWorkspace("cwd-key");
      const many = Array.from({ length: 100 }, (_, i) => ({
        key: `github.com/acme/r${i}`,
        label: `r${i}`,
        root: `/tmp/r${i}`,
      }));
      await expect(
        startServer({
          port: 0,
          runQuery: echoRun,
          workspace: cwd,
          repoCandidates: many,
        }),
      ).rejects.toThrow(/100/);
    });
  });
});

describe("attach excludes .mpai/ from git (Finding 2)", () => {
  // cli.ts's launch path has always called ensureExcluded for the cwd repo.
  // The attach path (a repo added later from the MACHINES panel) went through
  // no equivalent call, so every panel-attached repo permanently showed
  // .mpai/ as untracked in `git status`. Real git, real filesystem, no
  // injected workspaceFor/defaultBaseRef — this exercises the actual default
  // factory the attach handler falls back to, not a test fake standing in
  // for it.
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  function realRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-attach-exclude-"));
    tmpDirs.push(dir);
    git(dir, "init", "-b", "main");
    return dir;
  }

  it("writes .mpai/ into the attached repo's .git/info/exclude", async () => {
    const candidateRoot = realRepo();
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: cwd,
      repoCandidates: [{ key: "local:test:attachexclude01", label: "cand", root: candidateRoot }],
      // Deliberately NO workspaceFor/defaultBaseRef — the point is to exercise
      // the real default factory the attach handler falls back to.
    });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "local:test:attachexclude01" }));
    await wait(150);
    expect(seen.some((m) => m.type === "repo_attached")).toBe(true);
    expect(seen.some((m) => m.type === "error")).toBe(false);

    const excludeFile = path.join(candidateRoot, ".git", "info", "exclude");
    expect(fs.existsSync(excludeFile)).toBe(true);
    expect(fs.readFileSync(excludeFile, "utf8").split("\n")).toContain(".mpai/");
    ws.close();
  });

  it("does not duplicate the entry on a second attach after a detach", async () => {
    const candidateRoot = realRepo();
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: cwd,
      repoCandidates: [{ key: "local:test:attachexclude02", label: "cand", root: candidateRoot }],
    });
    close = server.close;
    const ws = await connect(server.port);
    collect(ws, []);

    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "local:test:attachexclude02" }));
    await wait(100);
    ws.send(JSON.stringify({ type: "detach_repo", repoKey: "local:test:attachexclude02" }));
    await wait(100);
    ws.send(JSON.stringify({ type: "attach_repo", repoKey: "local:test:attachexclude02" }));
    await wait(100);

    const excludeFile = path.join(candidateRoot, ".git", "info", "exclude");
    const lines = fs.readFileSync(excludeFile, "utf8").split("\n").filter((l) => l === ".mpai/");
    expect(lines).toHaveLength(1);
    ws.close();
  });
});

/** Audit finding M5 (`docs/audit-2026-07-30.md`): the hub applies
 *  `MAX_FRAME_BYTES` as `maxPayload`, the standalone server did not, and
 *  inherited `ws`'s 100MB default — 100MB reaching `JSON.parse` on a socket
 *  that has passed no gate, since `denyUnauthed` runs INSIDE `handleMessage`. */
describe("WebSocket frame cap", () => {
  it("closes a connection that sends a frame over the cap instead of parsing it", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));

    // Unauthenticated, and `identify` is one of the two messages deliberately
    // never gated — so nothing but `maxPayload` stands between this frame and
    // the parser.
    const oversized = JSON.stringify({
      type: "identify",
      userId: "u1",
      name: "a".repeat(MAX_FRAME_BYTES),
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_FRAME_BYTES);
    ws.send(oversized);

    // 1009 = "message too big" — `ws`'s own answer, raised before the frame is
    // handed to the message handler. Raced so a server without the cap fails
    // the assertion rather than hanging out the suite timeout.
    const code = await Promise.race([closed, wait(1000).then(() => -1)]);
    expect(code).toBe(1009);
    expect(seen).toEqual([]);
  });

  it("still accepts an ordinary frame under the cap", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "cap1", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await wait(200);

    expect(seen.map((m) => m.event?.type)).toContain("user_message");
    ws.close();
  });
});
