import { describe, it, expect, afterEach, vi } from "vitest";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import type { RunQuery, SdkMessage } from "../src/agentDriver.js";
import { PluginStore, type CloneFn } from "../src/pluginStore.js";
import { signSession, SESSION_COOKIE } from "../src/auth.js";

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
  const calls: { slug: string; baseRef: string }[] = [];
  return {
    calls,
    provision(slug: string, baseRef: string) {
      calls.push({ slug, baseRef });
      return { ok: true as const, workdir: `/tmp/wt/${slug}` };
    },
    defaultBranch: () => "main",
    repoKey: () => "local:test:000000000000",
  };
}

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
    expect(entry.pendingGate).toEqual({ toolName: "Bash", sinceTs: expect.any(String) });

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
  function storeWithFakeClone(): { store: PluginStore; root: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-e2e-"));
    const clone: CloneFn = async (_url, dest) => {
      for (const [rel, content] of Object.entries(skeleton)) {
        const p = path.join(dest, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
    };
    return { store: new PluginStore(root, clone), root };
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

  it("watch_project sends an immediate snapshot with repo info and live pushes", async () => {
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
    expect(snap.repo).toEqual({ defaultBranch: "main", key: "local:test:000000000000" });
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
    expect(workspace.calls).toEqual([{ slug: "fix-auth", baseRef: "dev" }]);
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
    expect(seen.some((m) => m.type === "error" && /not launched in a repo/.test(m.message))).toBe(true);
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
    expect(workspace.calls).toEqual([{ slug: "adhoc", baseRef: "main" }]);
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
    expect(snap.oversight).toEqual({ enabled: false, latest: null });
    // peek fallback for an unknown project also carries the field
    ws.send(JSON.stringify({ type: "peek", projectId: "nosuch" }));
    await wait(50);
    const peeked = seen.filter((m) => m.type === "project").at(-1);
    expect(peeked.oversight).toEqual({ enabled: false, latest: null });
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

  it("mints an invite, keeps the token off the wire, and previews it", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await connect(server.port);
    const sinkA: any[] = [];
    collect(a, sinkA);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    a.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);

    const list = sinkA.find((m) => m.type === "invite_list");
    expect(list.invites).toHaveLength(1);
    const token = list.invites[0].token;
    expect(token).toHaveLength(32);

    const created = sinkA.find((m) => m.event?.type === "invite_created")?.event;
    expect(created).toMatchObject({ userId: "u1", inviteId: list.invites[0].id, maxUses: 10 });
    expect(JSON.stringify(created)).not.toContain(token);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "peek_invite", token }));
    await wait(30);
    expect(sinkB.find((m) => m.type === "invite_info")).toMatchObject({
      projectId: "default",
      sessionId: "alpha",
      inviterName: "ana",
      remaining: 10,
    });
    a.close();
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

  it("attributes a redeemed invite on the wire and counts one seat per user", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await connect(server.port);
    const sinkA: any[] = [];
    collect(a, sinkA);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    a.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);
    const invite = sinkA.find((m) => m.type === "invite_list").invites[0];

    const b = await connect(server.port);
    b.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u2", name: "bob", invite: invite.token }));
    await wait(30);
    const redeemed = sinkA.find((m) => m.event?.type === "invite_redeemed")?.event;
    expect(redeemed).toMatchObject({ userId: "u2", inviteId: invite.id });

    a.send(JSON.stringify({ type: "list_invites" }));
    await wait(30);
    const lists = sinkA.filter((m) => m.type === "invite_list");
    expect(lists[lists.length - 1].invites[0].uses).toBe(1);
    a.close();
    b.close();
  });

  it("revokes an invite and reports the exact reason afterwards", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await connect(server.port);
    const sinkA: any[] = [];
    collect(a, sinkA);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    a.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);
    const invite = sinkA.find((m) => m.type === "invite_list").invites[0];

    a.send(JSON.stringify({ type: "revoke_invite" }));
    a.send(JSON.stringify({ type: "revoke_invite", inviteId: "nope1234" }));
    a.send(JSON.stringify({ type: "revoke_invite", inviteId: invite.id }));
    await wait(30);
    const errors = sinkA.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toContain("revoke_invite requires an inviteId");
    expect(errors).toContain("unknown invite: nope1234");
    expect(sinkA.find((m) => m.event?.type === "invite_revoked")?.event).toMatchObject({
      userId: "u1",
      inviteId: invite.id,
    });
    const lists = sinkA.filter((m) => m.type === "invite_list");
    expect(lists[lists.length - 1].invites).toHaveLength(0);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "peek_invite", token: invite.token }));
    await wait(30);
    expect(sinkB.find((m) => m.type === "error")?.message).toBe("invite revoked");
    a.close();
    b.close();
  });

  it("cross-project attacker cannot list or revoke another project's invites for the same session id", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    // Victim founds project "default", session "alpha", and mints an invite.
    const victim = await connect(server.port);
    const sinkVictim: any[] = [];
    collect(victim, sinkVictim);
    victim.send(
      JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana", projectId: "default" }),
    );
    await wait(30);
    victim.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);
    const victimInvite = sinkVictim.find((m) => m.type === "invite_list").invites[0];

    // Attacker founds an empty room with the SAME session id "alpha" but a
    // DIFFERENT project — the founder slot is open by design, and session
    // ids are guessable `mpai new` slugs (alpha, demo, fix-login).
    const attacker = await connect(server.port);
    const sinkAttacker: any[] = [];
    collect(attacker, sinkAttacker);
    attacker.send(
      JSON.stringify({ type: "join", sessionId: "alpha", userId: "u2", name: "eve", projectId: "evil" }),
    );
    await wait(30);

    attacker.send(JSON.stringify({ type: "list_invites" }));
    await wait(30);
    const attackerLists = sinkAttacker.filter((m) => m.type === "invite_list");
    expect(attackerLists[attackerLists.length - 1].invites).toEqual([]);

    attacker.send(JSON.stringify({ type: "revoke_invite", inviteId: victimInvite.id }));
    await wait(30);
    const attackerErrors = sinkAttacker.filter((m) => m.type === "error").map((m) => m.message);
    expect(attackerErrors).toContain(`unknown invite: ${victimInvite.id}`);

    // The victim's invite must still be live — unaffected by the failed
    // cross-project revoke attempt.
    const checker = await connect(server.port);
    const sinkChecker: any[] = [];
    collect(checker, sinkChecker);
    checker.send(JSON.stringify({ type: "peek_invite", token: victimInvite.token }));
    await wait(30);
    expect(sinkChecker.find((m) => m.type === "invite_info")).toMatchObject({
      projectId: "default",
      sessionId: "alpha",
    });

    victim.close();
    attacker.close();
    checker.close();
  });

  it("requireInvite blocks an uninvited join of an occupied session without provisioning", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace, requireInvite: true });
    close = server.close;
    const a = await connect(server.port);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    // The founder's join provisions exactly one worktree for "alpha".
    expect(workspace.calls).toHaveLength(1);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u2", name: "bob" }));
    await wait(30);
    expect(sinkB.find((m) => m.type === "error")?.message).toBe("this session requires an invite");
    expect(sinkB.some((m) => m.type === "project")).toBe(false);
    // The rejected join must not provision a second worktree for "alpha".
    expect(workspace.calls).toHaveLength(1);

    const c = await connect(server.port);
    const sinkC: any[] = [];
    collect(c, sinkC);
    c.send(JSON.stringify({ type: "join", sessionId: "bravo", userId: "u3", name: "cal" }));
    await wait(30);
    expect(sinkC.some((m) => m.type === "error")).toBe(false);
    expect(sinkC.some((m) => m.type === "project")).toBe(true);
    a.close();
    b.close();
    c.close();
  });

  it("rejects a join with an unknown invite token before ever provisioning the brand-new session it targets", async () => {
    // A session that already exists (founded by a prior join) can't
    // distinguish correct gate ordering from broken ordering, because
    // getOrCreateSession only calls workspace.provision for a session that
    // doesn't yet exist. This test targets a sessionId that has never been
    // created, so any provisioning at all would prove the gate ran too late.
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const sink: any[] = [];
    collect(ws, sink);
    ws.send(
      JSON.stringify({
        type: "join",
        sessionId: "never-created",
        userId: "u1",
        name: "eve",
        invite: "x".repeat(32),
      }),
    );
    await wait(30);
    expect(sink.find((m) => m.type === "error")?.message).toBe("invite not found");
    expect(workspace.calls).toHaveLength(0);
    ws.close();
  });

  it("requireInvite admits a reconnecting founder without a token even while the room stays occupied", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, requireInvite: true });
    close = server.close;

    const a = await connect(server.port);
    const sinkA: any[] = [];
    collect(a, sinkA);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);

    // Admit a second participant with a minted invite so the room is
    // occupied by more than just the reconnecting founder.
    a.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);
    const invite = sinkA.find((m) => m.type === "invite_list").invites[0];
    const b = await connect(server.port);
    b.send(
      JSON.stringify({ type: "join", sessionId: "alpha", userId: "u2", name: "bob", invite: invite.token }),
    );
    await wait(30);

    // Founder's tab refreshes: socket drops, presence_leave fires.
    a.close();
    await wait(30);

    // Reconnect with the same userId and no token. The room is still
    // occupied (by bob), but u1 was admitted before, so this must succeed.
    const a2 = await connect(server.port);
    const sinkA2: any[] = [];
    collect(a2, sinkA2);
    a2.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    expect(sinkA2.some((m) => m.type === "error")).toBe(false);
    expect(sinkA2.some((m) => m.type === "project")).toBe(true);

    a2.close();
    b.close();
  });

  it("requireInvite still rejects a genuinely new userId with no token in an occupied room", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun, requireInvite: true });
    close = server.close;

    const a = await connect(server.port);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);

    const c = await connect(server.port);
    const sinkC: any[] = [];
    collect(c, sinkC);
    c.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u3", name: "cal" }));
    await wait(30);
    expect(sinkC.find((m) => m.type === "error")?.message).toBe("this session requires an invite");

    a.close();
    c.close();
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
    expect(snap.repo).toEqual({ defaultBranch: "main", key: "github.com/acme/api" });
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
    expect(snap.repo).toBeNull();
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
});
