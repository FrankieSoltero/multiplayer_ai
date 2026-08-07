/** Harness-managed LiteLLM proxy (spec §2.2): the daemon generates the proxy
 *  config, spawns the litellm child, health-gates it, and supervises it with a
 *  crash-restart backoff. Pure-Claude installs never spawn it.
 *
 *  Import ordering is load-bearing: `./models.js` MUST be evaluated before
 *  `./modelsConfig.js`. models.ts calls initRegistry() at its module bottom;
 *  making modelsConfig the evaluation root would reach its top-level consts in
 *  TDZ → a ReferenceError boot crash (Task 2 review). Keep models.js first. */
import fs from "node:fs";
import path from "node:path";
import { MODELS } from "./models.js";
import { isRouted, managedModels, type ManagedModelEntry } from "./modelsConfig.js";
import { mpaiHome } from "./machineIdentity.js";

/** `absent` = no routed models, proxy never started (Claude built-ins route
 *  direct). `external` = MPAI_PROXY_EXTERNAL supplies the endpoint.
 *  `unavailable` = routed models exist but litellm was never started (binary
 *  missing). `starting`/`healthy` = a managed child is booting / serving.
 *  `down` = a managed child existed and died or failed health; supervision
 *  continues (crash-restart backoff), OR the configured port was already in
 *  use at start (we never kill a process we did not spawn). */
export type ProxyStatus = "absent" | "external" | "unavailable" | "starting" | "healthy" | "down";

/** The minimal child-process surface the manager drives; the real adapter over
 *  node:child_process `spawn` is injected by main.ts (Task 4). Unit tests inject
 *  a fake so they never spawn real litellm. */
export interface ChildLike {
  on(ev: "exit", fn: (code: number | null) => void): void;
  kill(sig: string): void;
}

export interface ProxySpawner {
  spawn(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }): ChildLike;
}

interface ProxyDeps {
  spawner: ProxySpawner;
  probe: (url: string) => Promise<boolean>;
  warn: (m: string) => void;
  binaryExists: (name: string) => boolean;
}

const DEFAULT_PORT = "4010";
const HEALTH_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 500;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30000;

const BINARY_MISSING_WARN = "[proxy] litellm not found — install: pip install 'litellm[proxy]'";
const DEGRADED_NOTE = "proxy unavailable — install litellm (pip install 'litellm[proxy]')";
const HEALTH_TIMEOUT_WARN = "[proxy] health check failed after 15s — restarting";

/** Double-quoted YAML scalar with escaping — layer two of the config-injection
 *  guard (Global Constraints §2.5.2). Even a value that slipped registration
 *  validation renders as ONE inert string: a literal newline becomes the two
 *  characters `\n`, so it can never open a new YAML mapping line. */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Pure: render the LiteLLM `model_list` YAML for a registry snapshot, in
 *  `managedModels()` registration order (built-ins first). Every interpolated
 *  scalar is double-quoted with YAML escaping. Throws if two entries would emit
 *  the same `model_name` — the id-route uniqueness invariant (§2.5.3) makes this
 *  unreachable in practice, asserted here as defense in depth. */
export function generateLitellmConfig(models: ManagedModelEntry[]): string {
  const seen = new Set<string>();
  const lines: string[] = ["model_list:"];
  for (const m of models) {
    if (seen.has(m.id)) {
      throw new Error(`generateLitellmConfig: duplicate model_name ${JSON.stringify(m.id)}`);
    }
    seen.add(m.id);
    lines.push(`  - model_name: ${yamlQuote(m.id)}`);
    lines.push("    litellm_params:");
    if (m.provider === "ollama") {
      lines.push(`      model: ${yamlQuote(`ollama/${m.providerModel ?? ""}`)}`);
      lines.push(`      api_base: ${yamlQuote(m.baseUrl ?? "")}`);
    } else if (m.provider === "openai-compatible") {
      lines.push(`      model: ${yamlQuote(`openai/${m.providerModel ?? ""}`)}`);
      lines.push(`      api_base: ${yamlQuote(m.baseUrl ?? "")}`);
      if (m.apiKeyEnv !== undefined) {
        lines.push(`      api_key: ${yamlQuote(`os.environ/${m.apiKeyEnv}`)}`);
      }
    } else {
      // anthropic pass-through (the built-ins, or an explicit anthropic entry)
      lines.push(`      model: ${yamlQuote(`anthropic/${m.id}`)}`);
      lines.push('      api_key: "os.environ/ANTHROPIC_API_KEY"');
    }
  }
  return `${lines.join("\n")}\n`;
}

export class ProxyManager {
  private _status: ProxyStatus = "absent";
  private _baseUrl: string | undefined;
  private child: ChildLike | undefined;
  private childAlive = false;
  /** Bumped whenever the supervised child is superseded (respawn, reload, stop,
   *  crash). A health gate or exit handler tagged with a stale generation is a
   *  no-op — this is how a single supervision path is guaranteed. */
  private generation = 0;
  private backoffMs = BACKOFF_START_MS;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly deps: ProxyDeps,
  ) {}

  status(): ProxyStatus {
    return this._status;
  }

  /** The routing target. Defined for external/starting/healthy/down; undefined
   *  for absent AND unavailable (proxy never started ⇒ Claude built-ins keep
   *  routing direct to Anthropic, spec §2.2). */
  baseUrl(): string | undefined {
    return this._baseUrl;
  }

  /** Boot-time mode decision. Does NOT write ANTHROPIC_BASE_URL — main.ts owns
   *  that at boot (Task 4). */
  async start(): Promise<void> {
    const external = this.env.MPAI_PROXY_EXTERNAL;
    if (external && external.length > 0) {
      this._status = "external";
      this._baseUrl = external;
      return;
    }
    if (!this.hasRoutedModels()) {
      this._status = "absent";
      this._baseUrl = undefined;
      return;
    }
    if (!this.deps.binaryExists("litellm")) {
      this.enterUnavailable();
      return;
    }
    await this.enterManaged();
  }

  /** Re-run the FULL mode decision against the CURRENT registry (spec §2.2): the
   *  registry may have gained its first routed model, lost its last one, or the
   *  binary presence may differ. Unlike start(), reload sets
   *  process.env.ANTHROPIC_BASE_URL when baseUrl transitions undefined→defined
   *  (the absent→managed case) — the only runtime writer of that var. */
  async reload(): Promise<void> {
    const external = this.env.MPAI_PROXY_EXTERNAL;
    if (external && external.length > 0) {
      this._status = "external";
      this._baseUrl = external;
      return;
    }
    if (!this.hasRoutedModels()) {
      // Last routed model removed while a child runs: do NOT stop it — the child
      // keeps serving pass-through until next boot (ANTHROPIC_BASE_URL is already
      // fixed and live drivers route through it). With no child, we are just idle.
      if (!this.child) {
        this._status = "absent";
        this._baseUrl = undefined;
      }
      return;
    }
    if (!this.deps.binaryExists("litellm")) {
      this.enterUnavailable();
      return;
    }
    if (this.child) {
      await this.sigtermAndRespawn();
      return;
    }
    const wasUndefined = this._baseUrl === undefined;
    await this.enterManaged();
    if (wasUndefined && this._baseUrl !== undefined) {
      process.env.ANTHROPIC_BASE_URL = this._baseUrl;
    }
  }

  /** SIGTERM the managed child and cancel supervision — no respawn, status
   *  frozen. A no-op when no child was ever spawned. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    if (this.child && this.childAlive) {
      this.child.kill("SIGTERM");
      this.childAlive = false;
    }
  }

  // --- internals -----------------------------------------------------------

  private hasRoutedModels(): boolean {
    return managedModels().some((m) => isRouted(m));
  }

  private port(): string {
    const p = this.env.MPAI_PROXY_PORT;
    return p && p.length > 0 ? p : DEFAULT_PORT;
  }

  private configPath(): string {
    return path.join(mpaiHome(this.env), "litellm", "config.yaml");
  }

  private enterUnavailable(): void {
    this._status = "unavailable";
    this._baseUrl = undefined;
    this.deps.warn(BINARY_MISSING_WARN);
    for (const entry of Object.values(MODELS)) {
      if (isRouted(entry)) entry.degradedNote = DEGRADED_NOTE;
    }
  }

  /** The scoped child env (spec §2.5.9): ONLY PATH, HOME, ANTHROPIC_API_KEY, and
   *  exactly the apiKeyEnv names of registered openai-compatible entries — never
   *  the daemon's full process.env. apiKeyEnv can never name a reserved secret
   *  (rejected at registration), so no daemon secret can leak to the child. */
  private scopedEnv(): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    if (this.env.PATH !== undefined) out.PATH = this.env.PATH;
    if (this.env.HOME !== undefined) out.HOME = this.env.HOME;
    if (this.env.ANTHROPIC_API_KEY !== undefined) out.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
    for (const entry of Object.values(MODELS)) {
      if (entry.provider === "openai-compatible" && entry.apiKeyEnv) {
        const value = this.env[entry.apiKeyEnv];
        if (value !== undefined) out[entry.apiKeyEnv] = value;
      }
    }
    return out;
  }

  /** Managed-mode entry: set the loopback baseUrl, refuse to touch a port that
   *  is already answering (never kill a process we did not spawn, §2.5.6), else
   *  spawn + health-gate. */
  private async enterManaged(): Promise<void> {
    const port = this.port();
    const url = `http://127.0.0.1:${port}`;
    this._baseUrl = url;
    if (await this.deps.probe(`${url}/health/liveliness`)) {
      this._status = "down";
      this.deps.warn(
        `[proxy] port ${port} already in use — free it or set MPAI_PROXY_PORT ` +
          `(a crashed daemon may have left litellm running: pkill -f litellm)`,
      );
      return;
    }
    await this.spawnAndGate();
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  /** Write fresh config, spawn litellm, and health-gate the new child. */
  private async spawnAndGate(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    const cfgPath = this.configPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, generateLitellmConfig(managedModels()));

    this._status = "starting";
    const child = this.deps.spawner.spawn("litellm", ["--config", cfgPath, "--port", this.port()], {
      env: this.scopedEnv(),
    });
    this.child = child;
    this.childAlive = true;
    child.on("exit", () => {
      if (gen !== this.generation || this.stopped) return; // superseded child
      this.childAlive = false;
      this.restartWithBackoff();
    });
    await this.healthGate(gen, `${this._baseUrl}/health/liveliness`);
  }

  /** Poll GET /health/liveliness every 500ms until 200 or 15s. On success:
   *  healthy + backoff counter reset. On timeout: the unified recovery rule. */
  private async healthGate(gen: number, url: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (gen !== this.generation || this.stopped) return;
      const ok = await this.deps.probe(url);
      if (gen !== this.generation || this.stopped) return;
      if (ok) {
        this._status = "healthy";
        this.backoffMs = BACKOFF_START_MS; // reset once healthy
        return;
      }
      await this.delay(POLL_INTERVAL_MS);
    }
    if (gen !== this.generation || this.stopped) return;
    this.deps.warn(HEALTH_TIMEOUT_WARN);
    this.restartWithBackoff();
  }

  /** Unified recovery rule (any exit OR health-timeout): kill the child if still
   *  alive, then schedule a backoff respawn (1s,2s,4s… capped 30s). */
  private restartWithBackoff(): void {
    if (this.stopped) return;
    this.generation++; // supersede any in-flight gate for the dead/hung child
    this._status = "down";
    if (this.child && this.childAlive) {
      this.child.kill("SIGTERM");
      this.childAlive = false;
    }
    this.child = undefined;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = undefined;
      if (this.stopped) return;
      void this.spawnAndGate();
    }, wait);
  }

  /** Reload of a running managed child: supersede it, SIGTERM it, respawn now
   *  (no backoff — this is an intentional restart, not a crash). */
  private async sigtermAndRespawn(): Promise<void> {
    this.generation++;
    if (this.child && this.childAlive) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.childAlive = false;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
    await this.spawnAndGate();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        resolve();
      }, ms);
    });
  }
}
