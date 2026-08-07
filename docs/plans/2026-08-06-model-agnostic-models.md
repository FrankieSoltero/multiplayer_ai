# Model-Agnostic Model Surface — Implementation Plan

> **For executors:** execute with soltero-skills:lean-sdd. The Task Dependency
> Table below is the scheduling and review-depth contract.
> Spec of record: `docs/specs/2026-08-06-model-agnostic-models-design.md`.

**Goal:** Models become a first-class per-machine surface — persisted config +
UI add/remove, a harness-managed LiteLLM proxy, refreshed Claude defaults, and
a supported key-less first run.

**Architecture:** The server daemon owns a mutable model registry loaded
builtins → `$MPAI_HOME/models.json` → `MPAI_EXTRA_MODELS` (deprecated
back-compat). Non-Anthropic entries route through a LiteLLM child process the
daemon generates config for, spawns, health-gates, and supervises; pure-Claude
installs never spawn it. New member-gated standalone wire messages manage the
registry; the roster reaches sessions on the existing additive
`skill_roster.models` field via `AgentDriver.refreshRoster()`.

**Tech stack / test runner:** TypeScript/Node + React. `cd poc/server && npx
vitest run [file]` (same for `poc/hub`, `poc/client`); typecheck `npx tsc -b`
per package.

**Done gates (executor/controller, not tasks):** three suites ≥ baselines
(server 867 · hub 388 · client 604), tsc ×3 clean; live proof per spec §4 —
REQUIRED, not deferrable: one managed-proxy session on this Mac with an Ollama
model (add via UI, select, run a turn). Observable pass condition: the
assistant reply streams to the client; the managed proxy's output shows the
ollama-model request arriving at `127.0.0.1:4010`; the session log's
`turn_end` for that turn has outcome success; the session is screenshotted
(spec §4); after daemon exit, `pgrep -f litellm` finds no orphaned proxy
process. (litellm 1.95.0 lives at `~/.mpai/litellm/venv/bin/litellm` — NOT on
PATH — and ollama has `qwen3.6:27b` pulled; launch the daemon as
`PATH="$HOME/.mpai/litellm/venv/bin:$PATH" <usual daemon command>`.)
Per-task regression gate: after each task, the executor runs the touched
package's FULL suite (not just the task's files) against the baselines —
lean-sdd standard practice; the per-task Verify lines are the fast inner
loop, this gate is the blast-radius check.
"→ green" in every per-task Verify line means, precisely: the task's
behavior-table cases exist as tests (written failing-first per lean-tdd) and
all pass; vitest exits 0; `npx tsc -b` exits 0.
Live-proof cleanup: after the proof passes, remove the test ollama entry via
the UI so models.json returns to its pre-proof state (spec §4 as amended).

## Global Constraints

- Product ruling: the harness is the layer between the model and its tools;
  Anthropic credentials are one way to power it, never a requirement to run it.
- Wire back-compat: `skill_roster.models` stays additive; new standalone
  messages must not break old clients/servers (client renders the models panel
  only after a `models_list` reply arrives).
- Hub is UNTOUCHED. Registry and proxy are per-machine (server daemon).
- No secrets on disk: `models.json` stores `apiKeyEnv` (an env var NAME), never
  a key. Config parsing never crashes boot (warn-and-skip, existing contract).
- `apiKeyEnv` exfiltration guard (spec §2.5.1): a member could otherwise register
  an openai-compatible entry with `apiKeyEnv=ANTHROPIC_API_KEY` and a hostile
  `baseUrl`, making the proxy forward the real Anthropic key off-box. Therefore
  `apiKeyEnv` must match `/^[A-Z][A-Z0-9_]*$/` AND must not name a
  daemon-reserved variable: `ANTHROPIC_API_KEY`, `SESSION_SECRET`,
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWLIST`. Validation
  order and per-branch strings: empty/type check first (`entry "<id>" skipped —
  apiKeyEnv must be a non-empty string`), then format (`entry "<id>" skipped —
  apiKeyEnv must be an uppercase env var name`), then reserved (`entry "<id>"
  skipped — apiKeyEnv names a reserved variable`).
- Config-injection guard (spec §2.5.2, defense in two layers): every value that
  is ever interpolated into the generated LiteLLM YAML is charset-validated at
  REGISTRATION (Task 2): `id` must match `/^[a-z0-9][a-z0-9._-]*$/i`
  (skip string: `entry "<id>" skipped — id has invalid characters`);
  `providerModel` must match `/^[A-Za-z0-9._:\/-]+$/` (skip string: `entry
  "<id>" skipped — providerModel has invalid characters`); `baseUrl` must
  parse via `new URL()` with protocol http/https and contain no whitespace
  (skip string: `entry "<id>" skipped — baseUrl must be a valid http(s) URL`).
  Private/loopback baseUrl ranges are deliberately NOT blocked — SSRF via a
  member-set baseUrl is accepted by threat model (spec §2.5.8): LAN/loopback
  endpoints ARE the product's primary topology, credential forwarding is
  closed by §2.5.1-3, and every member already holds a strictly more powerful
  internal-access primitive (a gated agent with tool access on the machine).
  Layer two: `generateLitellmConfig` double-quotes every interpolated scalar
  with YAML escaping, so even a value that slipped validation renders as an
  inert string (Task 3 behavior row proves a `\n  api_key:`-bearing value
  cannot inject a line).
- Route-hijack guard (spec §2.5.3): registration rejects an entry whose `id`
  equals ANY registered entry's id — including the built-ins' `claude-*` ids,
  which do NOT appear as registry keys (skip string: `entry "<id>" skipped —
  id already routed`). Without this, key `myopus` with id `claude-opus-5` and
  a hostile baseUrl would emit a second `model_name: claude-opus-5` route and
  hijack real Anthropic traffic. Invariant: `generateLitellmConfig` can never
  emit two entries sharing a `model_name`.
- Paths: models config `$MPAI_HOME/models.json`; generated proxy config
  `$MPAI_HOME/litellm/config.yaml`; `$MPAI_HOME` resolves via the existing
  `mpaiHome(env)` (`poc/server/src/machineIdentity.ts:16-20`).
- Proxy: default `127.0.0.1:4010` (`MPAI_PROXY_PORT` overrides);
  `MPAI_PROXY_EXTERNAL=<url>` skips spawn/generation and uses that URL; health
  probe `GET /health/liveliness` polled every 500ms until 200 or 15s elapsed;
  crash restart backoff 1s,2s,4s… capped 30s, counter RESETS to 1s once the
  child reaches healthy; add/remove_model regenerates config then SIGTERM →
  respawn — EXCEPT removing the last routed model, which leaves the running
  child serving pass-through until next boot (spec §2.2 point 4 as amended
  2026-08-06; Task 3). Refusal string for
  routed selection while `starting` or `down`: `proxy is down — restarting`
  *(logged deviation: spec §2.2 defines only the unavailable string; this
  second string distinguishes crash-restart/health-gating from
  binary-missing)*.
- One-daemon-one-endpoint: when a proxy (managed or external) is active, ALL
  models route through it (`claude-*` ids pass through byte-identical) — with
  one scoped exception: sessions whose CLI was spawned BEFORE the proxy came
  up retain direct routing (the predates-proxy edge, Task 5);
  `ANTHROPIC_API_KEY` is passed through to the managed proxy's env.
- Why the reroute ships unflagged (deliberate, justified — not an oversight):
  (a) the managed hop is loopback-only (`127.0.0.1`), so no new network
  exposure; (b) `claude-*` pass-through is byte-identical and was proven live
  2026-08-04 with this exact LiteLLM topology (`deploy/local-models.md`);
  (c) the SDK's single-endpoint architecture precludes per-model routing, so
  a flag would only re-create today's env-var fiddling the spec exists to
  remove; (d) failure degrades truthfully (turn-time `agent_error`, refusals
  while down), never silently; (e) live sessions are never rerouted mid-life
  (predates-proxy edge). An operator escape hatch exists regardless:
  `MPAI_PROXY_EXTERNAL`, or simply removing routed models and rebooting.
- Refreshed built-ins (spec §2.3): opus→`claude-opus-5`/"opus 5"/1000000,
  sonnet→`claude-sonnet-5`/"sonnet 5"/1000000,
  haiku→`claude-haiku-4-5-20251001`/"haiku 4.5"/200000,
  fable→`claude-fable-5`/"fable 5"/1000000. `DEFAULT_MODEL` stays `"opus"`.
- Credential detection is best-effort and advisory (annotate, don't block
  selection): env `ANTHROPIC_API_KEY` non-empty OR
  `<CLAUDE_CONFIG_DIR ?? ~/.claude>/.credentials.json` exists. Exact
  degradedNote: `no Anthropic credentials — set ANTHROPIC_API_KEY or add a
  local model`.
- Proxy-unavailable routed models DO refuse selection. Exact string (used as
  degradedNote AND set_model refusal): `proxy unavailable — install litellm
  (pip install 'litellm[proxy]')`; while a managed proxy is down/restarting:
  `proxy is down — restarting`. *(Logged deviation: spec §2.2's note is the
  shorter `proxy unavailable — install litellm`; the plan extends it with the
  pip command so the remedy is actionable in place.)*
- `MPAI_PROXY_EXTERNAL` data-exposure note: `ANTHROPIC_BASE_URL` points at
  that URL, so the Anthropic API key traverses the hop. Non-loopback external
  proxies should be `https://`; plain `http://` is accepted only as a
  trusted-LAN topology, and `deploy/local-models.md` (Task 8) states this.

## Task Dependency Table

| Task | Files touched | Depends on | Risk tier |
|------|---------------|------------|-----------|
| 1. Claude defaults refresh | `poc/server/src/models.ts`, `poc/server/test/models.test.ts` | — | standard |
| 2. Config store, credentials, mutable registry | `poc/server/src/models.ts`, `poc/server/src/modelsConfig.ts` (new), `poc/server/test/models.test.ts`, `poc/server/test/modelsConfig.test.ts` (new) | 1 | judgment |
| 3. Proxy manager | `poc/server/src/proxyManager.ts` (new), `poc/server/test/proxyManager.test.ts` (new) | 2 | judgment |
| 4. Boot wiring + gate relaxation | `poc/server/src/config.ts`, `poc/server/src/main.ts`, `poc/server/test/config.test.ts` | 2, 3, 5 | standard |
| 5. Wire handlers + roster re-emit + in-use tracking | `poc/server/src/server.ts`, `poc/server/src/agentDriver.ts`, `poc/server/src/events.ts`, `poc/server/test/modelsWire.test.ts` (new) | 2, 3 | judgment |
| 6. Client foundation | `poc/client/src/types.ts`, `poc/client/src/components/Header.tsx`, `poc/client/src/components/Header.test.tsx`, `poc/client/src/derive.test.ts` | — | standard |
| 7. Models panel | `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/components/SessionPicker.test.tsx` | 6 | standard |
| 8. Docs sweep | `deploy/local-models.md`, `deploy/multi-machine-test.md`, `docs/PRD.md`, `docs/tech-debt.md`, `HANDOFF.md` | 1–7 | mechanical |

Execution order: 1‖6 → 2 → 3 → 5 → (4 ‖ 7) → 8 — Task 7 needs only Task 6 and
may run any time after it; Task 4 builds AFTER Task 5 despite its lower
number (the table, not the numbering, is the contract).
Tasks 1 and 6 touch disjoint files and may execute/review concurrently.
Task 4 depends on 5: Task 5 gives server creation an optional `proxyManager`
option; Task 4 constructs the instance in main.ts and threads it through that
option (the handoff is owned across exactly these two tasks, in that order).
Task 7 overlaps nothing server-side; it may run concurrently with 4/5.

---

## Task 1: Claude defaults refresh

*(implements spec §2.3)*

**Files:**
- Modify: `poc/server/src/models.ts`
- Test: `poc/server/test/models.test.ts`

**Interfaces:**
- Consumes: existing `BUILTIN_MODELS` record (`models.ts:41-45`), byte-pin
  tests (`models.test.ts:24-30`), roster shape test (`:153-165`), no-hardcode
  sweep regex (`:40`).
- Produces: `BUILTIN_MODELS` with exactly four entries in order opus, sonnet,
  haiku, fable (values in Global Constraints). Later tasks rely on key `fable`
  existing and `contextWindow` values above.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| refreshed pins | `MODELS.opus` | `{ id: "claude-opus-5", label: "opus 5", contextWindow: 1000000 }` |
| fable added | `MODELS.fable` | `{ id: "claude-fable-5", label: "fable 5", contextWindow: 1000000 }` |
| default unchanged | `DEFAULT_MODEL` | `"opus"` |
| roster order | `modelRoster()` | four entries, opus → sonnet → haiku → fable |
| sweep updated | grep of `../src` | regex becomes `/claude-(opus-5|sonnet-5|haiku-4-5|fable-5)/`; only `models.ts` may match |

**Exact values:** the four-entry table in Global Constraints; the sweep regex
above (note `claude-haiku-4-5-20251001` intentionally matches `claude-haiku-4-5`).

**Verify:** `cd poc/server && npx vitest run test/models.test.ts && npx tsc -b` → green
**Commit:** `feat(server): refresh built-in models — opus 5, sonnet 5, haiku 4.5, fable 5 (1M windows)`

---

## Task 2: Config store, credentials, mutable registry

*(implements spec §2.1 persisted config + §2.4 credential detection / default fallback)*

**Files:**
- Create: `poc/server/src/modelsConfig.ts`
- Modify: `poc/server/src/models.ts`
- Test: `poc/server/test/modelsConfig.test.ts` (new), `poc/server/test/models.test.ts`

**Interfaces:**
- Consumes: Task 1's `BUILTIN_MODELS`; `mpaiHome(env)` from
  `machineIdentity.ts:16` (signature `mpaiHome(env: NodeJS.ProcessEnv): string`);
  existing `parseExtraModels(json, warn)` validation rules (`models.ts:55-112`).
- Kept as ONE task deliberately (council rounds 1+3 note): `initRegistry`'s
  credential annotation couples the registry to credential detection, and the
  persistence layer co-locates because `registerModel`'s contract is a single
  atomic validate→mutate→persist sequence — a separate I/O task would ship an
  untestable half-contract (persist with no validated mutation to persist).
- Produces (later tasks consume verbatim):
  - `ModelEntry` gains optional fields
    `provider?: "anthropic" | "ollama" | "openai-compatible"`,
    `baseUrl?: string`, `providerModel?: string`, `apiKeyEnv?: string`
    (`local?: boolean` and `degradedNote?: string` ALREADY exist on ModelEntry,
    `models.ts:16-18` — not new, but part of the persisted/managed shape).
  - `interface ManagedModelEntry extends ModelEntry { key: string; builtin?: true }`
  - `loadModelsFile(path: string, warn: (m: string) => void): Record<string, ModelEntry>`
  - `persistModelsFile(path: string, entries: Record<string, ModelEntry>): void`
    (atomic: write `<path>.tmp` then rename; per spec §2.5.5, before the
    rename the existing file — if any — is copied to `<path>.bak`, so an accidental successful
    remove_model is recoverable by restoring the .bak; single-level: the .bak
    recovers exactly ONE operation back — the next successful write overwrites
    it; blast radius of each persist is the whole non-builtin set, which is
    why the backup rides every write)
  - `initRegistry(env: NodeJS.ProcessEnv, warn: (m: string) => void): void`
    (rebuilds the exported mutable `MODELS` record: builtins → models.json →
    MPAI_EXTRA_MODELS; module load calls it with `process.env`)
  - `registerModel(entry: ModelEntry, env: NodeJS.ProcessEnv): { ok: true } | { ok: false; error: string }`
    (validates, mutates `MODELS`, persists)
  - `unregisterModel(key: string, env: NodeJS.ProcessEnv): { ok: true } | { ok: false; error: string }`
  - `managedModels(): ManagedModelEntry[]` (registration order, `builtin: true`
    on the four built-ins)
  - `isRouted(entry: ModelEntry): boolean` (provider is ollama or
    openai-compatible)
  - `hasAnthropicCredentials(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): boolean`
  - `resolveDefaultModel(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): ModelKey`

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| load order | same id in models.json and MPAI_EXTRA_MODELS | models.json wins; env entry warn-and-skipped ("key already registered") |
| no shadowing | models.json entry with id `opus` | warn-and-skip (existing rule extends to file) |
| routed needs baseUrl | ollama entry without `baseUrl` | warn-and-skip: `entry "<id>" skipped — provider "<p>" requires baseUrl` |
| routed needs providerModel | ollama/openai entry without `providerModel` | warn-and-skip: `entry "<id>" skipped — provider "<p>" requires providerModel` |
| openai key ref | openai-compatible entry, `apiKeyEnv` absent | allowed (some endpoints are keyless); if present but empty/non-string, warn-and-skip: `entry "<id>" skipped — apiKeyEnv must be a non-empty string` |
| apiKeyEnv guard: format | `apiKeyEnv` non-empty but fails `/^[A-Z][A-Z0-9_]*$/` (checked AFTER the empty/type check, BEFORE the reserved check) | warn-and-skip: `entry "<id>" skipped — apiKeyEnv must be an uppercase env var name` |
| apiKeyEnv guard: reserved | `apiKeyEnv` passes the regex but names a reserved variable (Global Constraints list) | warn-and-skip: `entry "<id>" skipped — apiKeyEnv names a reserved variable` (registerModel returns either guard string as the error) |
| charset guards | `id`/`providerModel`/`baseUrl` fail the Global-Constraints config-injection charsets/URL parse | warn-and-skip with the matching exact string; registerModel returns it as the error |
| id-route uniqueness | entry `id` equals any registered entry's id (e.g. extra with id `claude-opus-5`) | warn-and-skip: `entry "<id>" skipped — id already routed` — checked against entry VALUES (ids), not just keys |
| corrupt file | models.json is invalid JSON | warn exactly `[models] models.json is not valid JSON — ignoring (<message>)`, treat as empty, file NOT rewritten until next successful registerModel |
| atomic persist | registerModel succeeds | models.json contains full non-builtin set; write is tmp+rename |
| persist failure | `persistModelsFile` throws after validation (disk full/read-only) | in-memory `MODELS` mutation ROLLED BACK; returns `{ ok: false, error: \`failed to write models.json: ${message}\` }` — no state where memory and disk disagree |
| register validates | registerModel with missing label | `{ ok: false, error: 'model entry needs string id, string label, numeric contextWindow' }`, nothing persisted (this literal is the register-path validation error for any missing/mistyped core field; the wire layer re-emits it verbatim via sendError) |
| register collision | registerModel with key `opus` or an already-registered extra | `{ ok: false, error: 'model "<id>" already registered' }`, nothing persisted |
| unregister builtin | key `opus` | `{ ok: false, error: "cannot remove a built-in model" }` |
| unregister unknown | key `nope` | `{ ok: false, error: "unknown model \"nope\"" }` |
| creds via env | `ANTHROPIC_API_KEY=sk-x` | `hasAnthropicCredentials` true |
| creds via CLI file | no env key, exists(`~/.claude/.credentials.json`) true | true (respect `CLAUDE_CONFIG_DIR` when set) |
| no creds | neither | false |
| default fallback | no creds, one ollama entry registered | `resolveDefaultModel` returns that entry's key |
| default fallback tiebreak | no creds, MULTIPLE routed entries | first routed entry in registration order (matches `managedModels()` order contract) |
| default normal | creds present | returns `"opus"` |
| default no options | no creds, no routed entries | returns `"opus"` (annotation handles honesty) |
| credential annotation | initRegistry with no creds | the four Claude built-ins get `degradedNote: "no Anthropic credentials — set ANTHROPIC_API_KEY or add a local model"`; with creds, no note |

**Exact values:** paths and note strings in Global Constraints; models.json is
a JSON array of ModelEntry (spec §2.1 schema). Persisted elements carry no
separate `key` field: on load the Record key is each entry's `id` (the extras
invariant key === id, which the id-route uniqueness rule keeps sound).

**Verify:** `cd poc/server && npx vitest run test/models.test.ts test/modelsConfig.test.ts && npx tsc -b` → green
**Commit:** `feat(server): persisted per-machine model registry — models.json, credential detection, default fallback`

---

## Task 3: Proxy manager

*(implements spec §2.2 managed proxy)*

**Files:**
- Create: `poc/server/src/proxyManager.ts`
- Test: `poc/server/test/proxyManager.test.ts`

**Interfaces:**
- Consumes: Task 2's `MODELS`, `isRouted(entry)`, `managedModels()`,
  `mpaiHome(env)`.
- Produces:
  - `type ProxyStatus = "absent" | "external" | "unavailable" | "starting" | "healthy" | "down"`
    (`unavailable` = routed models exist but litellm was never started — binary
    missing; `down` = a managed child existed and died/failed health,
    supervision continues)
  - `interface ProxySpawner { spawn(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }): ChildLike }`
    with `ChildLike = { on(ev: "exit", fn: (code: number | null) => void): void; kill(sig: string): void }`
    (injected; unit tests never spawn real litellm)
  - `class ProxyManager { constructor(env: NodeJS.ProcessEnv, deps: { spawner: ProxySpawner; probe: (url: string) => Promise<boolean>; warn: (m: string) => void; binaryExists: (name: string) => boolean }) }`
  - `ProxyManager.start(): Promise<void>` — decides mode, generates config,
    spawns, health-gates. Env ownership: main.ts sets
    `process.env.ANTHROPIC_BASE_URL` at BOOT via `resolveBaseUrl` (Task 4);
    ProxyManager itself sets it at RUNTIME when `baseUrl()` transitions
    undefined→defined during a reload (the absent→managed case) — the only
    two writers, each named here
  - `ProxyManager.status(): ProxyStatus`
  - `ProxyManager.baseUrl(): string | undefined` — the routing target. Defined
    for `external`/`starting`/`healthy`/`down`; **undefined for `absent` AND
    `unavailable`** — when the proxy never started, Claude built-ins must keep
    routing direct to Anthropic (spec §2.2). Accepted edge (record, don't fix):
    during `down` (crash-restart) Claude turns route to the dead proxy and fail
    truthfully at turn time until the respawn lands
  - `ProxyManager.reload(): Promise<void>` — re-runs the FULL start-style mode
    decision against the current registry (external? routed models present?
    binary present?), not just a respawn. Transitions: `absent`→managed when
    the first routed model is added (generate config, spawn, health-gate);
    anything→`unavailable` when routed models exist but the binary is missing;
    managed child already running → regenerate config, SIGTERM, respawn. When
    the LAST routed model is removed, the child is NOT stopped — it keeps
    serving pass-through until next boot, because `ANTHROPIC_BASE_URL` was
    already fixed at boot and live drivers route through it (recorded
    behavior, keeps Claude traffic working)
  - `ProxyManager.stop(): void`
  - `generateLitellmConfig(models: ManagedModelEntry[]): string` (pure; YAML string)

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| no routed models | registry has only Claude built-ins | status `absent`, nothing spawned, no config written, `baseUrl()` undefined |
| external | `MPAI_PROXY_EXTERNAL=http://pc:4000` | status `external`, `baseUrl()` = that URL, nothing spawned/generated |
| managed happy path | routed entry exists, binary found, probe true | config written to `$MPAI_HOME/litellm/config.yaml`, spawn `litellm` with args `["--config", <path>, "--port", "4010"]`, status `starting`→`healthy`, `baseUrl()` = `http://127.0.0.1:4010` |
| scoped spawn env (spec §2.5.9) | any managed spawn | the child receives an ALLOWLISTED env, never the daemon's full process.env: `PATH`, `HOME`, `ANTHROPIC_API_KEY`, plus exactly the `apiKeyEnv` names of registered openai-compatible entries. Asserted: the spawned env contains NONE of `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWLIST` |
| port override | `MPAI_PROXY_PORT=5011` | port arg and baseUrl use 5011 |
| binary missing | routed entry exists, `binaryExists("litellm")` false | warn `[proxy] litellm not found — install: pip install 'litellm[proxy]'`; status `unavailable`; `baseUrl()` undefined; routed entries in registry get degradedNote `proxy unavailable — install litellm (pip install 'litellm[proxy]')` |
| health timeout | probe never true within 15s | status `down`, warn exactly `[proxy] health check failed after 15s — restarting`; `baseUrl()` stays defined; recovery per the unified rule below (kill if alive → backoff respawn) |
| crash restart | child exits after healthy | respawn with backoff 1s,2s,4s…cap 30s; status `down` while waiting, `starting` on respawn |
| reload | reload() called, managed child running, routed models remain | config regenerated from current registry, SIGTERM old child, respawn. Accepted edge (spec §2.5.7): the member-triggerable restart window can fail in-flight turns of ALL live sessions (one-daemon-one-endpoint) — member-gated, seconds-bounded, truthfully surfaced; permission tiers out of scope while the hub is untouched |
| reload, last routed removed | reload() called, no routed models remain, child running | child NOT stopped — keeps serving pass-through until next boot (env base URL is fixed for live drivers) |
| exit during starting | child exits before ever healthy | same backoff respawn path as crash restart |
| hung child | health timeout, child alive but never healthy | kill (SIGTERM) the hung child, then backoff respawn — unified rule: any exit OR health-timeout → kill if alive → backoff respawn |
| config shape | one of each provider registered | YAML per Exact values below; `model_list` entries emitted in `managedModels()` registration order (built-ins first, then extras); every interpolated scalar double-quoted with YAML escaping |
| injection inert | entry field containing `\n  api_key: os.environ/EVIL` (hypothetically past validation) | renders as ONE quoted scalar — no new YAML line appears; asserted by a golden test |
| no duplicate routes | full registry | no two `model_list` entries share a `model_name` (guaranteed by the id-route uniqueness registration invariant; asserted) |
| stop() with child | managed child running | `child.kill("SIGTERM")` called, supervision cancelled (no respawn), status frozen |
| stop() without child | absent/external/unavailable | no-op |
| port already occupied | start(): the probe answers on the configured port BEFORE we spawn (e.g. an orphan from a crashed daemon, or any other process) | NO automatic kill (spec §2.5.6) — ProxyManager never terminates a process it did not spawn. Status `down`, warn exactly `[proxy] port <port> already in use — free it or set MPAI_PROXY_PORT (a crashed daemon may have left litellm running: pkill -f litellm)`. Deterministically testable through the existing injected `probe` (probe true before any spawner call ⇒ this row) |
| reload from absent | status `absent`, first routed model added, binary present | reload() runs the full mode decision: config generated, child spawned, `starting`→`healthy`; `process.env.ANTHROPIC_BASE_URL` set at that moment (sessions created BEFORE keep direct routing — see Task 5's predates-proxy refusal) |
| reload binary missing | status `absent`, routed model added, binary missing | reload() → status `unavailable`, no spawn, routed entries get the install degradedNote |

**Exact values:** `generateLitellmConfig` output shape (external API — LiteLLM):

```yaml
model_list:
  - model_name: "<id>"                    # every anthropic/builtin entry
    litellm_params:
      model: "anthropic/<id>"
      api_key: "os.environ/ANTHROPIC_API_KEY"
  - model_name: "<id>"                    # provider: ollama
    litellm_params:
      model: "ollama/<providerModel>"
      api_base: "<baseUrl>"
  - model_name: "<id>"                    # provider: openai-compatible
    litellm_params:
      model: "openai/<providerModel>"
      api_base: "<baseUrl>"
      api_key: "os.environ/<apiKeyEnv>"   # line omitted when apiKeyEnv absent
```
(All interpolated scalars double-quoted with YAML escaping — the template IS
the quoting rule from Global Constraints, not a contradiction of it.)

**Verify:** `cd poc/server && npx vitest run test/proxyManager.test.ts && npx tsc -b` → green
**Commit:** `feat(server): harness-managed LiteLLM proxy — config generation, spawn, health gate, supervision`

---

## Task 4: Boot wiring + gate relaxation

*(implements spec §2.4 boot gate relaxation + §2.2 boot wiring + graceful
shutdown)*
**NOTE: build after Task 5 — consumes its `proxyManager` server option (the
dependency table, not the numbering, is the scheduling contract).**
Kept as ONE task deliberately: gate relaxation, boot wiring, and the
SIGTERM/SIGINT handlers are one process-lifecycle contract — the gate decides
whether boot proceeds, the wiring orders what boot does, shutdown undoes it;
each is a few lines and all live in the same two files.

**Files:**
- Modify: `poc/server/src/config.ts`, `poc/server/src/main.ts`
- Test: `poc/server/test/config.test.ts`

**Interfaces:**
- Consumes: Task 2's `initRegistry`, `hasAnthropicCredentials`, `isRouted`,
  `MODELS`; Task 3's `ProxyManager`; existing
  `validateProductionConfig(env, hasIndexHtml)` (`config.ts:25-79`, pure,
  FS probes injected).
- Produces: `validateProductionConfig(env, hasIndexHtml, capabilities)` where
  `capabilities = { hasAnthropicCreds: boolean; hasRoutedModels: boolean }`
  (injected like `hasIndexHtml`; main.ts computes
  `hasAnthropicCreds = hasAnthropicCredentials(process.env, fs.existsSync)`
  and `hasRoutedModels = managedModels().some(isRouted)`), and a pure
  `resolveBaseUrl(operatorBaseUrl: string | undefined, proxyBaseUrl: string |
  undefined): string | undefined` — proxy URL when defined, else the
  operator's value — unit-tested in config.test.ts and used by main.ts to set
  `process.env.ANTHROPIC_BASE_URL` — and
  `installShutdownHandlers(proc: { on(ev: string, fn: () => void): void; exit(code: number): void }, proxyManager: { stop(): void }): void`
  (registers SIGTERM+SIGINT; each calls `proxyManager.stop()` then
  `proc.exit(0)`; unit-tested with fakes). Concrete ProxyManager deps main.ts passes
  (Task 3 defines the injected interfaces): `spawner` = thin adapter over
  node:child_process `spawn` returning ChildLike; `probe` = HTTP GET
  `${baseUrl}/health/liveliness`, resolves true on status 200;
  `binaryExists` = PATH lookup for `litellm` (`which litellm` semantics);
  `warn` = the boot warning sink main.ts already uses (`console.warn`,
  `main.ts:17-18`). Boot order in
  main.ts: initRegistry → credential detection/annotation → construct + start
  ProxyManager → `process.env.ANTHROPIC_BASE_URL =
  resolveBaseUrl(operator ANTHROPIC_BASE_URL, proxyManager.baseUrl())`
  (when the result is undefined the var is left unset) BEFORE any AgentDriver
  is constructed → existing startup, passing the ProxyManager instance through
  Task 5's `proxyManager` server option.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| prod, key only | CLIENT_DIST set, key set, no routed models | boots (unchanged) |
| prod, local only | CLIENT_DIST set, no creds, ≥1 routed model | boots — the old hard key gate is REMOVED. Rollback note: the gate change is pure code, `git revert` restores strict behavior, no persisted-state effect. Schema-rollback note (Task 2's persisted state): old code encountering models.json entries with the new provider/baseUrl/providerModel/apiKeyEnv fields warn-and-skips them per the existing parse contract — a revert strands routed models but can never corrupt boot |
| prod, neither | CLIENT_DIST set, no creds, no routed models | `{ ok: false, error: "no usable model: set ANTHROPIC_API_KEY or add a model to $MPAI_HOME/models.json" }` |
| dev, neither | no CLIENT_DIST, no creds | boots; console warning is exactly `[boot] no usable model: set ANTHROPIC_API_KEY or add a model to $MPAI_HOME/models.json` ($MPAI_HOME resolved; replaces the old `main.ts:16-18` warning) |
| base url: proxy active | `resolveBaseUrl("https://op.example", "http://127.0.0.1:4010")` | returns the proxy URL (unit test in config.test.ts); main.ts applies it before driver construction |
| base url: proxy absent | `resolveBaseUrl("https://op.example", undefined)` | returns the operator's URL unchanged (unit test in config.test.ts — the proxy-absent branch is unit-covered, not live-proof-only) |
| base url: neither | `resolveBaseUrl(undefined, undefined)` | returns undefined; env var left unset |
| shutdown | SIGTERM or SIGINT received | main.ts currently has NO signal handling (only `process.exit(1)` on an error path); this task ADDS `process.on("SIGTERM", ...)` and `process.on("SIGINT", ...)` handlers — registered right after server start in main.ts — that call `proxyManager.stop()` then `process.exit(0)`. The stop()-sends-SIGTERM assertion runs under Task 3's Verify (proxyManager.test.ts); the end-to-end observable is the live proof's `pgrep -f litellm` empty-after-exit check |

**Exact values:** boot refusal string above (literal `$MPAI_HOME` replaced with
the resolved path at runtime).

**Verify:** `cd poc/server && npx vitest run test/config.test.ts test/proxyManager.test.ts && npx tsc -b` → green
(runs Task 3's stop() behavior rows — SIGTERM to child, no-op without —
alongside the pure config contracts). This task ALSO adds a boot-order unit
test in config.test.ts: extract the signal-wiring into a testable
`installShutdownHandlers(proc: { on, exit }, proxyManager)` helper, inject a
fake process and fake ProxyManager, assert both handlers are registered and a
simulated SIGTERM calls `proxyManager.stop()` then `exit(0)` in that order.
The done-gate live proof's `pgrep -f litellm` empty-after-exit check is the
end-to-end confirmation, recorded against Task 4.
**Commit:** `feat(server): key-less boot — usable-model gate replaces the ANTHROPIC_API_KEY requirement, proxy wired at startup`

---

## Task 5: Wire handlers, roster re-emit, in-use tracking

*(implements spec §2.1 wire surface + §2.4 selection rules)*
Kept as ONE task deliberately (council round-3 note): the handlers, the driver
state (`currentModel`/`proxied`), and the refusal paths share one wire
contract and one test file — the in-use and predates-proxy refusals read
driver state that exists only with the getters, so a split would force
cross-task test scaffolding with no independent review value.

**Files:**
- Modify: `poc/server/src/server.ts`, `poc/server/src/agentDriver.ts`,
  `poc/server/src/events.ts`
- Test: `poc/server/test/modelsWire.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `registerModel`, `unregisterModel`, `managedModels`,
  `resolveDefaultModel`, `isRouted`; Task 3's `ProxyManager.status()` +
  `reload()`; existing `isProjectMember(project, userId)` (`server.ts:366`),
  `AgentDriver.refreshRoster()` (`agentDriver.ts:653-670` — currently
  `private`, invoked only internally at :623/:928/:1316; THIS TASK makes it
  public so server.ts can call it),
  `Session.append` fan-out (`session.ts:19-28`), `set_model` handler
  (`server.ts:1657-1667`), `model_change` event (`events.ts:82`).
- Produces:
  - Wire messages (client→server, standalone; ALL THREE member-gated on
    `projectId`; the third message `list_models` is spec §2.5.4):
    `{ type: "list_models", projectId: string }` → reply `{ type: "models_list", models: ManagedModelEntry[] }`;
    `{ type: "add_model", projectId: string, entry: ModelEntry }` and
    `{ type: "remove_model", projectId: string, key: string }` → on success
    reply a fresh `models_list`; on failure `sendError(...)` with the
    applicable refusal string from the behavior table below (Task 2's
    validation strings pass through verbatim). Concurrency: handlers run on
    Node's single thread and `registerModel`/`unregisterModel` are
    synchronous validate→mutate→persist, so each mutation is atomic;
    overlapping `reload()`s converge because each re-runs the full mode
    decision against the CURRENT registry — residual risk is a redundant
    SIGTERM/respawn, accepted.
  - `AgentDriver` gains `get currentModel(): ModelKey` — initialized to the
    resolved default key, updated on successful `setModel` — and
    `readonly proxied: boolean`, captured at construction as
    `Boolean(process.env.ANTHROPIC_BASE_URL)` (whether this session's CLI
    routes through a proxy).
  - Server creation gains an optional `proxyManager?: Pick<ProxyManager,
    "status" | "reload">` option (absent ⇒ behave as status `"absent"`).
    Task 4 constructs the real instance in main.ts and passes it here; Task 5's
    tests inject a fake.
  - `model_change` event gains `auto?: true`
    (`{ type: "model_change"; model: string; userId: string; auto?: true }`).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| list | MEMBER sends `list_models { projectId }` | models_list with full ManagedModelEntry set (apiKeyEnv included — it is an env var NAME, not a secret). list_models is member-gated EXACTLY like add/remove: reads expose infrastructure detail (baseUrl endpoints, provider ids, env-var names), so the read and write gates match — no auth asymmetry |
| list non-member | identified but not a member of projectId | `sendError("join this project before managing models")` |
| list unidentified | no identity | `sendError("identify first")` |
| add member-gated | add_model from non-member | `sendError("join this project before managing models")` |
| add validates | member, entry missing baseUrl (ollama) | sendError with Task 2's exact skip string; nothing persisted |
| add success | member, valid ollama entry | registered + persisted; `ProxyManager.reload()` awaited; every live session entry (iterate `projects.values()`, each `project.sessions.values()` — same map the join path writes at `server.ts:684`) gets `driver.refreshRoster()` (fresh `skill_roster` with new models); requester gets models_list; server console logs `[models] <userId> added "<key>"` |
| remove builtin | remove_model key `opus` | `sendError("cannot remove a built-in model")` |
| remove in use | some live session's `driver.currentModel` === key | `sendError(\`model in use by session ${sessionId}\`)` — string shape per spec §2.1; WHICH session is named is plan-pinned (spec silent): first match in the same deterministic iteration order as the roster re-emit (projects-map order, then session-map insertion order) |
| remove success | member, unused extra key | unregistered + persisted; proxy reload; roster re-emit; models_list reply; server console logs `[models] <userId> removed "<key>"` |
| set_model proxy down | routed model key, ProxyManager.status() `down` | `sendError("proxy is down — restarting")` |
| set_model proxy unavailable | routed model key, status `unavailable` | `sendError("proxy unavailable — install litellm (pip install 'litellm[proxy]')")` |
| set_model predates proxy | routed model key, proxy healthy, but `driver.proxied` false (session created before the proxy came up) | `sendError("this session predates the proxy — start a new session to use local models")` *(logged deviation: spec is silent on this architecture-forced edge — the CLI's base URL is fixed at spawn; refusal chosen over silent misroute)* |
| set_model proxy starting | routed model key, status `starting` (boot health-gate or respawn window) | `sendError("proxy is down — restarting")` — same string as `down`; selection opens once `healthy` |
| set_model credential-less Claude | no creds, key `opus` | ALLOWED (annotation is advisory; turn-time error stays the truth) |
| set_model routed success | routed key, proxy `healthy`/`external`, `driver.proxied` true | succeeds exactly like the existing handler path (`server.ts:1657-1667`): `stream.setModel(id)`, `model_change` appended, `driver.currentModel` updates |
| default fallback logged | session created, resolveDefaultModel ≠ "opus" | driver starts on the fallback model id AND appends `{ type: "model_change", model: <key>, userId: "system", auto: true }` |
| driver tracks | successful set_model | `driver.currentModel` returns the new key |
| no proxyManager injected | server constructed without the option (old callers, most tests) | handlers treat status as `"absent"`: routed set_model gets NO proxy-status refusal, add/remove skip the reload call — asserted by a modelsWire.test.ts case |
| joiner after add | session joins/reconnects AFTER an add_model | receives the current roster with no extra work: `refreshRoster()`'s re-appended `skill_roster` sits in the session log, which the existing join path replays (`server.ts:1343-1345`) — asserted by a modelsWire.test.ts replay case |

**Exact values:** all refusal strings above, verbatim.

**Verify:** `cd poc/server && npx vitest run test/modelsWire.test.ts test/models.test.ts && npx tsc -b` → green
**Commit:** `feat(server): add/remove/list_models wire surface — member-gated, persisted, live roster re-emit`

---

## Task 6: Client foundation

*(implements spec §2.3 label refresh + §2.1 client type mirror)*
Kept as ONE task deliberately: both changes are the single "client types.ts +
Header fallback" touch Task 7 builds on — splitting a 4-line label map from
the type mirror would make two sub-hour tasks with an artificial dependency.

**Files:**
- Modify: `poc/client/src/types.ts`, `poc/client/src/components/Header.tsx`
- Test: `poc/client/src/components/Header.test.tsx`, `poc/client/src/derive.test.ts`

**Interfaces:**
- Consumes: existing `MODEL_LABELS` fallback (`Header.tsx:11-13`),
  `ModelRosterEntry` (`types.ts:28-34`).
- Produces:
  - `MODEL_LABELS` = `{ opus: "opus 5", sonnet: "sonnet 5", haiku: "haiku 4.5", fable: "fable 5" }`
  - types.ts: `interface ManagedModelEntry` mirroring the server shape
    (`key, id, label, contextWindow, provider?, baseUrl?, providerModel?,
    apiKeyEnv?, local?, degradedNote?, builtin?`); `models_list` message shape
    `{ type: "models_list"; models: ManagedModelEntry[] }`.

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| fallback refreshed | old server, no roster models | picker offers opus 5 / sonnet 5 / haiku 4.5 / fable 5 |
| roster still wins | roster models present | roster rendered, fallback unused (unchanged) |
| HUD 1M denominator | `turn_end` with `modelUsage` entry `contextWindow: 1000000` | `derive` state `contextMax` === 1000000 (pins spec §4's HUD-denominator action; mechanism at `derive.ts:222-229` unchanged) |

**Verify:** `cd poc/client && npx vitest run src/components/Header.test.tsx src/derive.test.ts && npx tsc -b` → green
**Commit:** `feat(client): refreshed model fallback (opus 5, fable 5) + managed-model types`

---

## Task 7: Models panel

*(implements spec §2.1 client MANAGE view)*

**Files:**
- Modify: `poc/client/src/components/SessionPicker.tsx`
- Test: `poc/client/src/components/SessionPicker.test.tsx`

**Interfaces:**
- Consumes: Task 6's `ManagedModelEntry` + `models_list` shape; the
  `LifecyclePanel` member-gating and arm-and-confirm precedent
  (`SessionPicker.tsx:541-556`, armed-state + `"SURE?"` label); SessionPicker's
  existing send/receive plumbing — the `wsRef` WebSocket
  (`SessionPicker.tsx:111`) with the readyState-guarded send helper
  (`SessionPicker.tsx:159-160`) and the component's central `onmessage`
  dispatch — and membership check `isProjectMember(project, userId)`
  (types.ts:213, already used at SessionPicker.tsx:80 and :260); the error
  state is `const [error, setError]` (`SessionPicker.tsx:99`).
- Produces: `ModelsPanel` on the project screen, members only. Sends
  `list_models { projectId }` on mount; renders ONLY after a `models_list` reply (old
  servers: panel never appears). ADD form fields: label, provider
  (select: ollama / openai-compatible), base URL, provider model, context
  window (number input, required, integer > 0), API key env name
  (openai-compatible only); id derived from provider
  model (lowercased, `:`→`-`) with an editable override. REMOVE per non-builtin
  row, arm-and-confirm SURE?. Sends `add_model` / `remove_model` with the
  current projectId; re-renders from each models_list reply; server refusals
  surface in the panel (reuse the picker's existing error-state one-red-line
  pattern, `SessionPicker.tsx` `const [error, setError]` render).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| member sees panel | member, models_list arrived | panel lists entries; built-ins marked, no REMOVE button on them |
| non-member | not a member | no panel (viewing picker unchanged) |
| old server | no models_list reply | no panel |
| add happy path | valid ollama form submit | add_model sent with entry; panel refreshes from reply |
| id derivation | providerModel `qwen3.6:27b` (the live-proof model), id field untouched | derived id `qwen3.6-27b` (lowercase, `:`→`-`) sent; typing in the id field overrides the derivation |
| client-side validation | ollama selected, base URL empty | submit blocked with inline message exactly `base URL is required for ollama` (openai-compatible variant substitutes the provider name; mirrors the server rule, no round-trip) |
| remove armed | first click REMOVE on extra | button flips to SURE?, nothing sent |
| remove confirmed | second click | remove_model sent |
| refusal surfaced | server sendError arrives | error text rendered in panel |

**Verify:** `cd poc/client && npx vitest run src/components/SessionPicker.test.tsx && npx tsc -b` → green
**Commit:** `feat(client): models panel — member-gated add/remove with arm-and-confirm, roster-live`

---

## Task 8: Docs sweep

*(implements spec §2.2 operator docs + §5 files-touched docs rows)*

**Files:**
- Modify: `deploy/local-models.md`, `deploy/multi-machine-test.md`,
  `docs/PRD.md`, `docs/tech-debt.md`, `HANDOFF.md`

**Interfaces:** consumes the shipped behavior of Tasks 1–7 (describe what IS,
not what was planned).

**Behavior:**

| Case | Input / state | Expected |
|------|---------------|----------|
| local-models rewrite | `deploy/local-models.md` | managed flow is the main path (UI add → daemon generates config + runs proxy); manual LiteLLM setup demoted to an appendix (`MPAI_PROXY_EXTERNAL`); env table covers MPAI_PROXY_PORT / MPAI_PROXY_EXTERNAL / deprecated MPAI_EXTRA_MODELS |
| PC-box test section | `deploy/multi-machine-test.md` | new section: PC box (Ollama + daemon, managed proxy, `baseUrl` http://127.0.0.1:11434) + laptop as driver via hub; checklist items: key-less boot on the box, add model via UI from the laptop, fallback default, run a turn, remove-in-use refusal |
| PRD | `docs/PRD.md:512-520` — the §8.6 *Final state* paragraph beginning "Local models ride the same surface" | rewrite to the shipped managed flow (models.json + UI add + harness-managed proxy; `MPAI_EXTRA_MODELS` mentioned only as deprecated back-compat); no stale trio references anywhere in the file |
| tech-debt | `docs/tech-debt.md` §2.9 (line 395, "§8.6 phased scope — the deferrals") | annotate the local-models deferral items this cycle resolves (env-var-only model add, operator-run proxy); leave unrelated §2.9 items untouched |
| HANDOFF | top block | new START HERE block carrying: one-line goal, what shipped this cycle (registry, managed proxy, wire surface, models panel, refreshed defaults, key-less first run), branch + PR state, the PC-box test as the ordered next step, and the standing gotchas (venv litellm path, per-machine models.json) |

**Verify:** all of the following pass:
- `cd poc/server && npx vitest run test/models.test.ts` → green (sweep regex; docs are outside `src`)
- `grep -q "MPAI_PROXY_EXTERNAL" deploy/local-models.md && grep -q "MPAI_PROXY_PORT" deploy/local-models.md && grep -q "MPAI_EXTRA_MODELS" deploy/local-models.md` → exit 0 (env table complete incl. the deprecated var)
- `grep -qi "appendix" deploy/local-models.md` → exit 0 (manual flow demoted)
- `! grep -E "claude-opus-4-8|opus 4\.8" deploy/local-models.md deploy/multi-machine-test.md docs/PRD.md HANDOFF.md` → exit 0 (the ONLY retired identifiers are the opus-4-8 forms — sonnet 5 / haiku 4.5 names are unchanged, so this regex IS the complete stale-name check, across every doc this task touches)
- `grep -q "PC box" deploy/multi-machine-test.md && grep -q "key-less" deploy/multi-machine-test.md && grep -qi "fallback" deploy/multi-machine-test.md && grep -qi "remove" deploy/multi-machine-test.md` → exit 0 (new section present with the key-less-boot, fallback-default, and remove-in-use checklist items)
- `grep -q "trusted-LAN topology" deploy/local-models.md && grep -q "traverses the hop" deploy/local-models.md` → exit 0 (external-proxy data-exposure note landed — phrases unique to the new note, not satisfiable by pre-existing links)
- `grep -q "operator-run proxy" docs/tech-debt.md` → exit 0 (§2.9 deferral annotation landed)
- `grep -q "START HERE" HANDOFF.md && grep -q "model-agnostic" HANDOFF.md` → exit 0 (HANDOFF top block refreshed for this cycle)
**Commit:** `docs: model-agnostic model surface — managed-proxy flow, PC-box test runbook, PRD/tech-debt sweep`
