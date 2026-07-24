import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import type { RunQuery } from "../src/agentDriver.js";

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

function collect(ws: WebSocket, sink: unknown[]): void {
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
});
