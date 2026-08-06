import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import {
  AgentDriver,
  type DriverHooks,
  type RunQuery,
  type SdkMessage,
} from "../src/agentDriver.js";
import { Session } from "../src/session.js";
import { MODELS } from "../src/models.js";
import {
  initRegistry,
  managedModels,
  registerModel,
  type ManagedModelEntry,
} from "../src/modelsConfig.js";
import type { ProxyStatus } from "../src/proxyManager.js";

// --- shared fakes -----------------------------------------------------------

/** A streaming query that stays alive (awaits prompts, never ends), optionally
 *  augmented with `setModel` and `supportedCommands` so set_model and the
 *  roster re-emit have the SDK-control methods the driver reaches for. */
function makeRun(opts?: {
  setModel?: (m: string) => Promise<void>;
  commands?: { name: string; description: string }[];
}): RunQuery {
  return (prompts) => {
    const gen = (async function* () {
      for await (const _p of prompts) {
        yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as SdkMessage;
        yield { type: "result" } as SdkMessage;
      }
    })();
    const extra: Record<string, unknown> = {
      supportedCommands: async () => opts?.commands ?? [{ name: "demo", description: "d" }],
    };
    if (opts?.setModel) extra.setModel = opts.setModel;
    return Object.assign(gen, extra);
  };
}

function fakeProxy(status: ProxyStatus, reload?: () => Promise<void>) {
  return { status: () => status, reload: reload ?? (async () => {}) };
}

const OLLAMA = {
  id: "q1",
  label: "Q1",
  contextWindow: 1000,
  provider: "ollama" as const,
  baseUrl: "http://127.0.0.1:11434",
  providerModel: "qwen3",
};

// --- env / registry isolation ----------------------------------------------

const ENV_KEYS = ["MPAI_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MPAI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-t5-"));
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-t5-"));
  delete process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = "sk-test"; // creds present by default
  initRegistry(process.env, () => {});
});

afterEach(async () => {
  for (const c of closers) await c();
  closers.length = 0;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  initRegistry(process.env, () => {});
});

const closers: Array<() => Promise<void>> = [];

// --- wire helpers -----------------------------------------------------------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function waitFor(
  sink: any[],
  pred: (m: any) => boolean,
  ms = 3000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const found = sink.find(pred);
    if (found) return found;
    await wait(10);
  }
  throw new Error(`waitFor timeout; sink=${JSON.stringify(sink)}`);
}

async function openClient(port: number, opts?: { identify?: boolean; userId?: string }) {
  const ws = await connect(port);
  const sink: any[] = [];
  ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
  const userId = opts?.userId ?? "u1";
  if (opts?.identify !== false) {
    ws.send(JSON.stringify({ type: "identify", userId, name: "Ana" }));
    await waitFor(sink, (m) => m.type === "identified");
  }
  return { ws, sink, userId };
}

async function join(
  client: { ws: WebSocket; sink: any[]; userId: string },
  projectId: string,
  sessionId: string,
) {
  client.ws.send(
    JSON.stringify({ type: "join", projectId, sessionId, userId: client.userId, name: "Ana" }),
  );
  await waitFor(client.sink, (m) => m.type === "joined");
}

// ===========================================================================
// AgentDriver state: currentModel, proxied, default-fallback auto model_change
// ===========================================================================

function makeDriver(session: Session, run: RunQuery, initialModelKey?: string) {
  return new AgentDriver(
    session,
    run,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    initialModelKey,
  );
}

describe("AgentDriver.currentModel / proxied / default fallback", () => {
  it("currentModel initializes to the resolved default key and updates on setModel", () => {
    const session = new Session("s");
    const driver = makeDriver(session, makeRun({ setModel: async () => {} }));
    expect(driver.currentModel).toBe("opus");
    const res = driver.setModel("haiku", "u1");
    expect(res).toEqual({ ok: true });
    expect(driver.currentModel).toBe("haiku");
  });

  it("proxied captures Boolean(ANTHROPIC_BASE_URL) at construction", () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4010";
    const proxied = makeDriver(new Session("a"), makeRun());
    expect(proxied.proxied).toBe(true);
    delete process.env.ANTHROPIC_BASE_URL;
    const direct = makeDriver(new Session("b"), makeRun());
    expect(direct.proxied).toBe(false);
  });

  it("starts on the fallback model id and logs an auto model_change when default ≠ opus", () => {
    let captured: DriverHooks | undefined;
    const run: RunQuery = (_prompts, hooks) => {
      captured = hooks;
      return (async function* () {})();
    };
    const session = new Session("s");
    const driver = makeDriver(session, run, "sonnet");
    expect(driver.currentModel).toBe("sonnet");
    expect(captured?.initialModel).toBe("claude-sonnet-5");
    const ev = session.eventsFrom(0).find((e) => e.type === "model_change");
    expect(ev).toMatchObject({ model: "sonnet", userId: "system", auto: true });
  });

  it("does NOT log an auto model_change when the default is opus", () => {
    const session = new Session("s");
    makeDriver(session, makeRun(), "opus");
    expect(session.eventsFrom(0).some((e) => e.type === "model_change")).toBe(false);
  });
});

// ===========================================================================
// list_models
// ===========================================================================

describe("list_models wire surface", () => {
  it("returns the full ManagedModelEntry set incl. apiKeyEnv to a member", async () => {
    registerModel(
      {
        id: "oai",
        label: "O",
        contextWindow: 1000,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:9/v1",
        providerModel: "gpt",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      process.env,
    );
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    c.ws.send(JSON.stringify({ type: "list_models", projectId: "p1" }));
    const reply = await waitFor(c.sink, (m) => m.type === "models_list");
    const models = reply.models as ManagedModelEntry[];
    expect(models.find((m) => m.key === "opus")).toMatchObject({ builtin: true });
    expect(models.find((m) => m.key === "oai")).toMatchObject({ apiKeyEnv: "OPENAI_API_KEY" });
  });

  it("refuses a non-member with the exact member-gate string", async () => {
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port);
    c.ws.send(JSON.stringify({ type: "list_models", projectId: "other" }));
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("join this project before managing models");
  });

  it("refuses an unidentified connection with identify first", async () => {
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port, { identify: false });
    c.ws.send(JSON.stringify({ type: "list_models", projectId: "p1" }));
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("identify first");
  });
});

// ===========================================================================
// add_model
// ===========================================================================

describe("add_model wire surface", () => {
  it("refuses a non-member with the member-gate string", async () => {
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port);
    c.ws.send(JSON.stringify({ type: "add_model", projectId: "other", entry: OLLAMA }));
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("join this project before managing models");
  });

  it("passes Task 2's validation string through verbatim and persists nothing", async () => {
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    c.ws.send(
      JSON.stringify({
        type: "add_model",
        projectId: "p1",
        entry: { id: "bad", label: "B", contextWindow: 1000, provider: "ollama", providerModel: "x" },
      }),
    );
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe('entry "bad" skipped — provider "ollama" requires baseUrl');
    expect(Object.hasOwn(MODELS, "bad")).toBe(false);
  });

  it("registers, persists, awaits reload, re-emits the roster, replies models_list, logs", async () => {
    const reload = vi.fn(async () => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await startServer({
      port: 0,
      runQuery: makeRun(),
      proxyManager: fakeProxy("healthy", reload),
    });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    c.ws.send(JSON.stringify({ type: "add_model", projectId: "p1", entry: OLLAMA }));
    const reply = await waitFor(c.sink, (m) => m.type === "models_list");
    expect((reply.models as ManagedModelEntry[]).some((m) => m.key === "q1")).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // roster re-emit reached the live session's log (subscribed events)
    await waitFor(
      c.sink,
      (m) => m.type === "event" && m.event.type === "skill_roster" && (m.event.models ?? []).some((r: any) => r.key === "q1"),
    );
    expect(logSpy).toHaveBeenCalledWith('[models] u1 added "q1"');
    // persisted to disk
    const file = path.join(process.env.MPAI_HOME!, "models.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).some((e: any) => e.id === "q1")).toBe(true);
    logSpy.mockRestore();
  });

  it("with no proxyManager injected, add still succeeds (reload skipped)", async () => {
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    c.ws.send(JSON.stringify({ type: "add_model", projectId: "p1", entry: OLLAMA }));
    const reply = await waitFor(c.sink, (m) => m.type === "models_list");
    expect((reply.models as ManagedModelEntry[]).some((m) => m.key === "q1")).toBe(true);
  });
});

// ===========================================================================
// remove_model
// ===========================================================================

describe("remove_model wire surface", () => {
  it("refuses removing a built-in", async () => {
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    c.ws.send(JSON.stringify({ type: "remove_model", projectId: "p1", key: "opus" }));
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("cannot remove a built-in model");
  });

  it("refuses a model in use, naming the session (deterministic first offender)", async () => {
    delete process.env.ANTHROPIC_API_KEY; // no creds → default falls back to q1
    registerModel(OLLAMA, process.env);
    const server = await startServer({ port: 0, runQuery: makeRun() });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1"); // driver starts on q1 (fallback) → currentModel q1
    c.ws.send(JSON.stringify({ type: "remove_model", projectId: "p1", key: "q1" }));
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("model in use by session s1");
  });

  it("removes an unused extra: persists, reloads, re-emits roster, replies, logs", async () => {
    registerModel(OLLAMA, process.env); // creds present → session uses opus, q1 unused
    const reload = vi.fn(async () => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await startServer({
      port: 0,
      runQuery: makeRun(),
      proxyManager: fakeProxy("healthy", reload),
    });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    c.ws.send(JSON.stringify({ type: "remove_model", projectId: "p1", key: "q1" }));
    const reply = await waitFor(c.sink, (m) => m.type === "models_list");
    expect((reply.models as ManagedModelEntry[]).some((m) => m.key === "q1")).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[models] u1 removed "q1"');
    const file = path.join(process.env.MPAI_HOME!, "models.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).some((e: any) => e.id === "q1")).toBe(false);
    logSpy.mockRestore();
  });
});

// ===========================================================================
// set_model proxy-status selection rules
// ===========================================================================

describe("set_model proxy-status selection", () => {
  async function selectRouted(
    status: ProxyStatus,
    opts?: { proxied?: boolean; runQuery?: RunQuery; proxyManager?: any },
  ) {
    registerModel(OLLAMA, process.env);
    if (opts?.proxied) process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4010";
    const server = await startServer({
      port: 0,
      runQuery: opts?.runQuery ?? makeRun(),
      ...(opts && "proxyManager" in opts ? { proxyManager: opts.proxyManager } : { proxyManager: fakeProxy(status) }),
    });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    if (opts?.proxied) delete process.env.ANTHROPIC_BASE_URL;
    c.ws.send(JSON.stringify({ type: "set_model", model: "q1" }));
    return c;
  }

  it("proxy down → proxy is down — restarting", async () => {
    const c = await selectRouted("down", { proxied: true });
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("proxy is down — restarting");
  });

  it("proxy starting → proxy is down — restarting", async () => {
    const c = await selectRouted("starting", { proxied: true });
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("proxy is down — restarting");
  });

  it("proxy unavailable → install-litellm string", async () => {
    const c = await selectRouted("unavailable", { proxied: true });
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe("proxy unavailable — install litellm (pip install 'litellm[proxy]')");
  });

  it("predates proxy (healthy but driver not proxied) → predates refusal", async () => {
    const c = await selectRouted("healthy", { proxied: false });
    const err = await waitFor(c.sink, (m) => m.type === "error");
    expect(err.message).toBe(
      "this session predates the proxy — start a new session to use local models",
    );
  });

  it("routed success (healthy + proxied) sets the model and logs model_change", async () => {
    const setModel = vi.fn(async (_m: string) => {});
    const c = await selectRouted("healthy", { proxied: true, runQuery: makeRun({ setModel }) });
    const ev = await waitFor(
      c.sink,
      (m) => m.type === "event" && m.event.type === "model_change" && m.event.model === "q1",
    );
    expect(ev.event.model).toBe("q1");
    expect(setModel).toHaveBeenCalledWith("q1");
  });

  it("no proxyManager injected: routed set_model gets NO proxy-status refusal", async () => {
    const setModel = vi.fn(async (_m: string) => {});
    // proxyManager explicitly absent; session not proxied
    const c = await selectRouted("absent", {
      proxied: false,
      runQuery: makeRun({ setModel }),
      proxyManager: undefined,
    });
    const ev = await waitFor(
      c.sink,
      (m) => m.type === "event" && m.event.type === "model_change" && m.event.model === "q1",
    );
    expect(ev.event.model).toBe("q1");
  });

  it("credential-less Claude selection is ALLOWED (no proxy/credential refusal)", async () => {
    delete process.env.ANTHROPIC_API_KEY; // no creds
    const setModel = vi.fn(async (_m: string) => {});
    const server = await startServer({ port: 0, runQuery: makeRun({ setModel }) });
    closers.push(server.close);
    const c = await openClient(server.port);
    await join(c, "p1", "s1");
    c.ws.send(JSON.stringify({ type: "set_model", model: "opus" }));
    const ev = await waitFor(
      c.sink,
      (m) => m.type === "event" && m.event.type === "model_change" && m.event.model === "opus",
    );
    expect(ev.event.userId).toBe("u1");
  });
});

// ===========================================================================
// joiner-after-add replay
// ===========================================================================

describe("joiner after add", () => {
  it("a session joining after add_model replays the re-emitted roster with the new model", async () => {
    const server = await startServer({ port: 0, runQuery: makeRun(), proxyManager: fakeProxy("healthy") });
    closers.push(server.close);
    const a = await openClient(server.port, { userId: "u1" });
    await join(a, "p1", "s1");
    a.ws.send(JSON.stringify({ type: "add_model", projectId: "p1", entry: OLLAMA }));
    await waitFor(a.sink, (m) => m.type === "models_list");

    const b = await openClient(server.port, { userId: "u2" });
    await join(b, "p1", "s1");
    await waitFor(
      b.sink,
      (m) => m.type === "event" && m.event.type === "skill_roster" && (m.event.models ?? []).some((r: any) => r.key === "q1"),
    );
  });
});
