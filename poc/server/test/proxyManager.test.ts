import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// models.js MUST be imported before modelsConfig.js: models.ts calls
// initRegistry() at module bottom, and evaluating modelsConfig first would hit
// its top-level consts in TDZ → a ReferenceError boot crash (Task 2 review).
import { MODELS } from "../src/models.js";
import { initRegistry, registerModel, unregisterModel, type ManagedModelEntry } from "../src/modelsConfig.js";
import {
  ProxyManager,
  generateLitellmConfig,
  type ProxySpawner,
  type ChildLike,
} from "../src/proxyManager.js";

/** Task 3 (spec §2.2 managed proxy): the daemon generates the LiteLLM config,
 *  spawns the child, health-gates it, and supervises it — all with injected
 *  deps so unit tests never spawn real litellm and drive timing with fake
 *  timers. */

const BINARY_MISSING_WARN = "[proxy] litellm not found — install: pip install 'litellm[proxy]'";
const DEGRADED_NOTE = "proxy unavailable — install litellm (pip install 'litellm[proxy]')";
const HEALTH_TIMEOUT_WARN = "[proxy] health check failed after 15s — restarting";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mpai-t3-"));
}

function credEnv(home: string): NodeJS.ProcessEnv {
  return { ANTHROPIC_API_KEY: "sk-test", MPAI_HOME: home } as NodeJS.ProcessEnv;
}

const OLLAMA_ENTRY = {
  id: "q",
  label: "Q",
  contextWindow: 1,
  provider: "ollama" as const,
  baseUrl: "http://127.0.0.1:11434",
  providerModel: "q:1",
};

/** Register one routed ollama entry on top of the built-ins. */
function withRoutedRegistry(home: string): void {
  initRegistry(credEnv(home), () => {});
  const res = registerModel({ ...OLLAMA_ENTRY }, credEnv(home));
  if (!res.ok) throw new Error(`setup failed: ${res.error}`);
}

/** A recording fake child + spawner. `probe` answers per the injected fn. */
interface ChildHandle {
  child: ChildLike;
  kills: string[];
  fireExit: (code?: number | null) => void;
}

function makeHarness() {
  const children: ChildHandle[] = [];
  const spawnCalls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; statusAtSpawn: string }[] = [];
  let onSpawn: (() => void) | undefined;
  let statusProbe: (() => string) | undefined;
  const spawner: ProxySpawner = {
    spawn(cmd, args, opts) {
      let exitFn: ((code: number | null) => void) | undefined;
      const kills: string[] = [];
      const child: ChildLike = {
        on(ev, fn) {
          if (ev === "exit") exitFn = fn;
        },
        kill(sig) {
          kills.push(sig);
        },
      };
      children.push({ child, kills, fireExit: (code = 0) => exitFn?.(code ?? null) });
      spawnCalls.push({ cmd, args, env: opts.env, statusAtSpawn: statusProbe ? statusProbe() : "" });
      onSpawn?.();
      return child;
    },
  };
  return {
    spawner,
    children,
    spawnCalls,
    setOnSpawn: (fn: () => void) => (onSpawn = fn),
    setStatusProbe: (fn: () => string) => (statusProbe = fn),
    get spawnCount() {
      return spawnCalls.length;
    },
  };
}

let savedBaseUrl: string | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  initRegistry(credEnv(tmpHome()), () => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
  initRegistry(credEnv(tmpHome()), () => {});
});

describe("generateLitellmConfig — pure YAML string (spec §2.2 Exact values)", () => {
  it("emits model_list in order, quoted scalars, one block per provider family", () => {
    const models: ManagedModelEntry[] = [
      { key: "opus", id: "claude-opus-5", label: "opus 5", contextWindow: 1000000, builtin: true },
      {
        key: "q",
        id: "qwen",
        label: "Q",
        contextWindow: 1,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        providerModel: "qwen3.6:27b",
      },
      {
        key: "g",
        id: "gptx",
        label: "G",
        contextWindow: 1,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8000",
        providerModel: "gpt-x",
        apiKeyEnv: "TOGETHER_API_KEY",
      },
    ];
    expect(generateLitellmConfig(models)).toBe(
      `model_list:
  - model_name: "claude-opus-5"
    litellm_params:
      model: "anthropic/claude-opus-5"
      api_key: "os.environ/ANTHROPIC_API_KEY"
  - model_name: "qwen"
    litellm_params:
      model: "ollama/qwen3.6:27b"
      api_base: "http://127.0.0.1:11434"
  - model_name: "gptx"
    litellm_params:
      model: "openai/gpt-x"
      api_base: "http://127.0.0.1:8000"
      api_key: "os.environ/TOGETHER_API_KEY"
`,
    );
  });

  it("omits the api_key line for a keyless openai-compatible entry", () => {
    const yaml = generateLitellmConfig([
      {
        key: "k",
        id: "kless",
        label: "K",
        contextWindow: 1,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8000",
        providerModel: "gpt-x",
      },
    ]);
    expect(yaml).not.toMatch(/api_key/);
    expect(yaml).toContain('model: "openai/gpt-x"');
  });

  it("injection inert: a newline-bearing field renders as ONE quoted scalar", () => {
    const yaml = generateLitellmConfig([
      {
        key: "x",
        id: "x",
        label: "X",
        contextWindow: 1,
        provider: "ollama",
        baseUrl: "http://h",
        providerModel: "m\n  api_key: os.environ/EVIL",
      },
    ]);
    // The literal newline is escaped to backslash-n, so it stays on one line.
    expect(yaml).toContain('model: "ollama/m\\n  api_key: os.environ/EVIL"');
    // No physical line becomes a standalone injected api_key mapping.
    expect(yaml.split("\n").some((l) => l.trim() === "api_key: os.environ/EVIL")).toBe(false);
  });

  it("no two entries may share a model_name — throws on a duplicate id", () => {
    expect(() =>
      generateLitellmConfig([
        { key: "a", id: "dup", label: "A", contextWindow: 1 },
        { key: "b", id: "dup", label: "B", contextWindow: 1 },
      ]),
    ).toThrow(/duplicate model_name/);
  });
});

describe("mode decision — start()", () => {
  it("no routed models → status absent, nothing spawned, no config, baseUrl undefined", async () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {}); // built-ins only
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => false),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.status()).toBe("absent");
    expect(pm.baseUrl()).toBeUndefined();
    expect(h.spawnCount).toBe(0);
    expect(fs.existsSync(path.join(home, "litellm", "config.yaml"))).toBe(false);
  });

  it("MPAI_PROXY_EXTERNAL → status external, baseUrl is that URL, nothing spawned", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    const pm = new ProxyManager(
      { ...credEnv(home), MPAI_PROXY_EXTERNAL: "http://pc:4000" } as NodeJS.ProcessEnv,
      { spawner: h.spawner, probe: vi.fn(async () => false), warn: vi.fn(), binaryExists: () => true },
    );
    await pm.start();
    expect(pm.status()).toBe("external");
    expect(pm.baseUrl()).toBe("http://pc:4000");
    expect(h.spawnCount).toBe(0);
    expect(fs.existsSync(path.join(home, "litellm", "config.yaml"))).toBe(false);
  });

  it("binary missing → warn, status unavailable, baseUrl undefined, routed entries get the degradedNote", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const warn = vi.fn();
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => false),
      warn,
      binaryExists: () => false,
    });
    await pm.start();
    expect(pm.status()).toBe("unavailable");
    expect(pm.baseUrl()).toBeUndefined();
    expect(h.spawnCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(BINARY_MISSING_WARN);
    expect(MODELS.q.degradedNote).toBe(DEGRADED_NOTE);
  });
});

describe("managed happy path + spawn contract", () => {
  it("writes config, spawns litellm with the right args, transitions starting→healthy, sets baseUrl", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned), // false at the port pre-check, true once our child is up
      warn: vi.fn(),
      binaryExists: () => true,
    });
    h.setStatusProbe(() => pm.status());
    const before = process.env.ANTHROPIC_BASE_URL;
    await pm.start();
    expect(pm.status()).toBe("healthy");
    expect(pm.baseUrl()).toBe("http://127.0.0.1:4010");
    const cfg = path.join(home, "litellm", "config.yaml");
    expect(fs.existsSync(cfg)).toBe(true);
    expect(fs.readFileSync(cfg, "utf8")).toContain('model_name: "q"');
    expect(h.spawnCalls[0].cmd).toBe("litellm");
    expect(h.spawnCalls[0].args).toEqual(["--config", cfg, "--port", "4010"]);
    expect(h.spawnCalls[0].statusAtSpawn).toBe("starting");
    // start() (boot) never writes ANTHROPIC_BASE_URL — main.ts owns that.
    expect(process.env.ANTHROPIC_BASE_URL).toBe(before);
  });

  it("MPAI_PROXY_PORT overrides the port arg and baseUrl", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager({ ...credEnv(home), MPAI_PROXY_PORT: "5011" } as NodeJS.ProcessEnv, {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.baseUrl()).toBe("http://127.0.0.1:5011");
    expect(h.spawnCalls[0].args).toEqual([
      "--config",
      path.join(home, "litellm", "config.yaml"),
      "--port",
      "5011",
    ]);
  });

  it("scoped spawn env (spec §2.5.9): allowlist only, reserved secrets absent", async () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const reg = registerModel(
      {
        id: "oc",
        label: "OC",
        contextWindow: 1,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8000",
        providerModel: "gpt-x",
        apiKeyEnv: "TOGETHER_API_KEY",
      },
      credEnv(home),
    );
    expect(reg.ok).toBe(true);
    const fullEnv = {
      MPAI_HOME: home,
      PATH: "/usr/bin",
      HOME: "/Users/x",
      ANTHROPIC_API_KEY: "sk-anthropic",
      TOGETHER_API_KEY: "sk-together",
      SESSION_SECRET: "shh",
      GITHUB_CLIENT_ID: "gid",
      GITHUB_CLIENT_SECRET: "gsec",
      GITHUB_ALLOWLIST: "list",
    } as NodeJS.ProcessEnv;
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager(fullEnv, {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    const env = h.spawnCalls[0].env;
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/x");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-anthropic");
    expect(env.TOGETHER_API_KEY).toBe("sk-together");
    for (const reserved of ["SESSION_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_ALLOWLIST"]) {
      expect(reserved in env).toBe(false);
    }
  });

  it("config written at spawn is the exact generated YAML, model_list unique", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    const cfg = fs.readFileSync(path.join(home, "litellm", "config.yaml"), "utf8");
    const names = [...cfg.matchAll(/model_name: "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length); // no duplicate model_name
    expect(names[0]).toBe("claude-opus-5"); // built-ins first
    expect(names).toContain("q");
  });
});

describe("port already occupied (spec §2.5.6) — no kill of a process we didn't spawn", () => {
  it("probe true before any spawn → status down, exact warn, nothing spawned/killed", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const warn = vi.fn();
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => true), // something already answers on the port
      warn,
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.status()).toBe("down");
    expect(h.spawnCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "[proxy] port 4010 already in use — free it or set MPAI_PROXY_PORT (a crashed daemon may have left litellm running: pkill -f litellm)",
    );
  });
});

describe("health gate + supervision (unified rule: exit OR timeout → kill if alive → backoff respawn)", () => {
  it("health timeout → status down, exact warn, baseUrl stays defined, hung child killed", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const warn = vi.fn();
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => false), // never healthy
      warn,
      binaryExists: () => true,
    });
    const p = pm.start();
    await vi.advanceTimersByTimeAsync(15000);
    await p;
    expect(pm.status()).toBe("down");
    expect(pm.baseUrl()).toBe("http://127.0.0.1:4010"); // stays defined during down
    expect(warn).toHaveBeenCalledWith(HEALTH_TIMEOUT_WARN);
    expect(h.children[0].kills).toEqual(["SIGTERM"]); // hung child SIGTERM'd
  });

  it("crash-restart backoff doubles 1s → 2s (counter not yet reset)", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => false),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    const p = pm.start();
    await vi.advanceTimersByTimeAsync(15000); // first health timeout → down, respawn scheduled 1s
    await p;
    expect(pm.status()).toBe("down");
    expect(h.spawnCount).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawnCount).toBe(1); // not yet
    await vi.advanceTimersByTimeAsync(1); // 1s elapsed → respawn
    expect(h.spawnCount).toBe(2);
    expect(pm.status()).toBe("starting");
    await vi.advanceTimersByTimeAsync(15000); // second timeout → down, respawn scheduled 2s
    expect(pm.status()).toBe("down");
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.spawnCount).toBe(2); // still waiting — proves the 2s (not 1s) backoff
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawnCount).toBe(3);
  });

  it("backoff counter RESETS to 1s once the child reaches healthy", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    let healthy = false;
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => healthy),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    const p = pm.start();
    await vi.advanceTimersByTimeAsync(15000); // spawn1 times out → down, respawn 1s
    await p;
    healthy = true;
    await vi.advanceTimersByTimeAsync(1000); // spawn2 respawns and goes healthy
    expect(pm.status()).toBe("healthy");
    expect(h.spawnCount).toBe(2);
    // crash the healthy child → respawn must wait the RESET 1s, not 2s
    h.children[1].fireExit(1);
    expect(pm.status()).toBe("down");
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawnCount).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawnCount).toBe(3); // 1s → reset confirmed
  });

  it("exit during starting → same backoff respawn path (down then starting)", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => false),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    const p = pm.start();
    await vi.advanceTimersByTimeAsync(0); // reach spawn + first (failing) probe → starting
    expect(pm.status()).toBe("starting");
    h.children[0].fireExit(0); // dies before ever healthy
    expect(pm.status()).toBe("down");
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(h.spawnCount).toBe(2);
    expect(pm.status()).toBe("starting");
  });
});

describe("stop()", () => {
  it("with a managed child: SIGTERM, supervision cancelled (no respawn), status frozen", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.status()).toBe("healthy");
    pm.stop();
    expect(h.children[0].kills).toEqual(["SIGTERM"]);
    // even if the child now exits, no respawn happens and status stays frozen
    h.children[0].fireExit(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.spawnCount).toBe(1);
    expect(pm.status()).toBe("healthy");
  });

  it("without a child (absent) is a no-op", async () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => false),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.status()).toBe("absent");
    pm.stop();
    expect(h.spawnCount).toBe(0);
    expect(pm.status()).toBe("absent");
  });
});

describe("reload() — re-runs the full mode decision against the current registry", () => {
  it("managed child running, routed models remain → regenerate config, SIGTERM old, respawn", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.status()).toBe("healthy");
    // add a second routed model, then reload
    registerModel(
      {
        id: "q2",
        label: "Q2",
        contextWindow: 1,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        providerModel: "q:2",
      },
      credEnv(home),
    );
    await pm.reload();
    expect(h.children[0].kills).toEqual(["SIGTERM"]); // old child SIGTERM'd
    expect(h.spawnCount).toBe(2); // respawned
    expect(pm.status()).toBe("healthy");
    // config regenerated from the current registry (now includes q2)
    expect(fs.readFileSync(path.join(home, "litellm", "config.yaml"), "utf8")).toContain('model_name: "q2"');
  });

  it("from absent: first routed model added, binary present → spawn + set ANTHROPIC_BASE_URL at runtime", async () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {}); // built-ins only → absent
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.status()).toBe("absent");
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    registerModel({ ...OLLAMA_ENTRY }, credEnv(home));
    await pm.reload();
    expect(pm.status()).toBe("healthy");
    expect(pm.baseUrl()).toBe("http://127.0.0.1:4010");
    expect(process.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4010");
  });

  it("from absent, binary missing → unavailable, no spawn, degradedNote applied", async () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const warn = vi.fn();
    const h = makeHarness();
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => false),
      warn,
      binaryExists: () => false,
    });
    await pm.start();
    expect(pm.status()).toBe("absent");
    registerModel({ ...OLLAMA_ENTRY }, credEnv(home));
    await pm.reload();
    expect(pm.status()).toBe("unavailable");
    expect(h.spawnCount).toBe(0);
    expect(MODELS.q.degradedNote).toBe(DEGRADED_NOTE);
  });

  it("last routed model removed, child running → child NOT stopped (keeps serving pass-through)", async () => {
    const home = tmpHome();
    withRoutedRegistry(home);
    const h = makeHarness();
    let spawned = false;
    h.setOnSpawn(() => (spawned = true));
    const pm = new ProxyManager(credEnv(home), {
      spawner: h.spawner,
      probe: vi.fn(async () => spawned),
      warn: vi.fn(),
      binaryExists: () => true,
    });
    await pm.start();
    expect(pm.status()).toBe("healthy");
    unregisterModel("q", credEnv(home));
    await pm.reload();
    expect(h.children[0].kills).toEqual([]); // NOT stopped
    expect(h.spawnCount).toBe(1); // not respawned
    expect(pm.status()).toBe("healthy"); // still serving
    expect(pm.baseUrl()).toBe("http://127.0.0.1:4010");
  });
});
