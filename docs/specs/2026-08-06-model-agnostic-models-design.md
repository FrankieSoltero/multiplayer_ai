# Model-Agnostic Model Surface — Design

*Status: DRAFT — awaiting user approval. 2026-08-06.*
*Product ruling (user, 2026-08-06): the harness is NOT Claude-specific — the goal is to run any
model, especially local models. The Claude trio in `models.ts` is a default, not the product.*

## 0. Goal

Make model choice a first-class, operator-friendly surface: models are added through the
product (UI + persisted config), routed through a harness-managed proxy, and the built-in
Claude defaults become just that — refreshed, current defaults.

North star (user, 2026-08-06, follow-up): "run this harness with any model once we reach the
hub. We should be the layer between the model and its tools." The harness is the
tool/orchestration layer; any model plugs into it. Anthropic credentials are one way to power
it, never a requirement to run it.

Question-round rulings (user, 2026-08-06):

- **R1 — Config/UI-driven add.** Members add models from the client UI; the harness owns a
  persisted per-machine config file. No more hand-editing `MPAI_EXTRA_MODELS` JSON.
- **R2 — Harness-managed proxy.** LiteLLM stays the translation layer, but the harness
  generates its config from the model registry and launches/manages the proxy process.
  Operators no longer hand-write `litellm.config.yaml`.
- **R3 — Claude defaults refresh rides along** in this cycle (ids, context windows, lineup).
- **R4 — Key-less first run is supported** (user, 2026-08-06 follow-up): a clone with no
  Anthropic subscription must be able to boot, learn why Claude entries won't answer, and run
  fully on local models. See §2.4.

## 1. Current state (verified 2026-08-06)

- `poc/server/src/models.ts:41-45` — `BUILTIN_MODELS` trio: opus→`claude-opus-4-8`,
  sonnet→`claude-sonnet-5`, haiku→`claude-haiku-4-5-20251001`, all `contextWindow: 200000`.
  Stale: current lineup is `claude-opus-5` (1M), `claude-sonnet-5` (1M),
  `claude-haiku-4-5` (200K), `claude-fable-5` (1M, premium).
- Extra models: `MPAI_EXTRA_MODELS` env JSON, warn-and-skip parsing (`models.ts:55-112`),
  proven live 2026-08-04 with `qwen3.6:27b`.
- Routing: one-daemon-one-endpoint — `ANTHROPIC_BASE_URL` → operator-run LiteLLM proxy,
  routes by model id (`claude-*` pass-through, everything else → Ollama). Manual setup doc:
  `deploy/local-models.md`.
- Client: picker reads the roster off `skill_roster.models`; hardcoded fallback trio for old
  servers; HUD CONTEXT denominator = roster `contextWindow` (`poc/client/src/derive.ts:224-225`).
- Tests byte-pin the trio: `poc/server/test/models.test.ts:26-28`, roster shape `:157-159`,
  no-hardcode grep sweep `:40`.

## 2. Design

### 2.1 Persistent per-machine model config (R1)

**File:** `$MPAI_HOME/models.json` (same home dir the daemon already owns). Machine-scoped on
purpose: model availability is a property of the machine (its GPU, its Ollama install), not of
the hub or a project. The hub is untouched — the roster already rides the per-session
`skill_roster` frame, which is wire-compatible as-is.

**Schema** (array of extended `ModelEntry`):

```json
[
  {
    "id": "qwen3.6-27b",
    "label": "QWEN3.6 27B (LOCAL)",
    "contextWindow": 32768,
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "providerModel": "qwen3.6:27b",
    "local": true
  }
]
```

New optional fields on `ModelEntry`:

| Field | Meaning |
|-------|---------|
| `provider` | `"anthropic"` \| `"ollama"` \| `"openai-compatible"`. Absent = anthropic pass-through (built-ins). |
| `baseUrl` | Provider endpoint (required for ollama / openai-compatible). |
| `providerModel` | The model name the provider knows (`qwen3.6:27b`); `id` stays the wire/routing key. |
| `apiKeyEnv` | Name of an env var holding the provider's API key (openai-compatible only). The key itself is NEVER stored in models.json. |

**Load order & precedence:** built-ins → `models.json` → `MPAI_EXTRA_MODELS` (kept working,
documented as deprecated back-compat; same warn-and-skip, same no-shadowing rule). All
existing validation rules (reserved ids, required fields, never-crash-boot) extend to the new
fields: an ollama/openai-compatible entry missing `baseUrl` warns and is skipped.

**Wire protocol (new messages, member-gated like lifecycle controls):**

- `add_model { entry }` — server validates with the same warn-and-skip rules (but replies with
  the specific refusal instead of a log line), persists to `models.json`, updates the live
  registry, regenerates + reloads the proxy config (§2.2), then re-emits `skill_roster`
  (with the updated `models` field) to every live session so pickers refresh.
- `remove_model { key }` — built-ins refuse (`cannot remove a built-in model`); a model
  currently selected by any live session refuses (`model in use by session <name>`);
  otherwise persist + registry update + roster re-emit as above.
- Both refuse for non-members with the established member-refusal shape. Add/remove is
  recorded via a server console log line naming the user and model — NOT a session-log event.
  *(Resolved at planning time, logged deviation from this spec's first draft: project-lifecycle
  changes — the closest precedent — also do not append session events; machine-level state
  changes reach sessions as fresh frames, here the re-emitted roster. Escalate only if the
  user wants per-session audit lines.)*

**Client UI:** the existing model picker gains a member-only MANAGE view — list of registered
models with ADD (form: label, provider, baseUrl, provider model, context window, API-key env
name for openai-compatible) and REMOVE (arm-and-confirm SURE?, matching lifecycle controls).
Non-members see the picker exactly as today. The picker's hardcoded fallback trio is updated
to the new defaults (§2.3) in the same change.

### 2.2 Harness-managed proxy (R2)

**When:** the proxy is needed iff at least one registered model routes off-Anthropic
(`provider` = ollama or openai-compatible). Pure-Claude installs never spawn it and keep
talking straight to Anthropic — zero regression for the common case.

**What the harness does when routed models exist:**

1. Generates the LiteLLM config from the registry into `$MPAI_HOME/litellm/config.yaml`:
   one enumerated `anthropic/<id>` pass-through route per built-in (the shape proven live
   2026-08-04; an earlier draft said "wildcard" — enumeration is what the generator emits and
   what the no-duplicate-route invariant is checked against) + one route per routed entry
   (`ollama/<providerModel>` with `api_base`, or `openai/<providerModel>` with `api_base` +
   key from `apiKeyEnv`).
2. Spawns `litellm` as a managed child process on `127.0.0.1:4010` (default; env-overridable
   via `MPAI_PROXY_PORT`), passing `ANTHROPIC_API_KEY` through to its env — the known 401
   trap from the home lab is thereby codified away. Waits for a health check before wiring.
3. Points the agent driver's base URL at the proxy for ALL models (one-daemon-one-endpoint
   holds; `claude-*` ids pass through byte-identical).
4. Supervises: on proxy exit, restarts with backoff; logs loudly. On config change
   (add/remove_model), regenerates config and restarts the proxy (SIGTERM → respawn; LiteLLM
   has no reliable hot-reload) — EXCEPT when the last routed model is removed: the running
   child keeps serving pass-through until next boot, because the daemon's base URL is fixed
   at boot and live drivers still route through it (amended 2026-08-06, plan-review cycle 2).

**Honest degradation:**

- `litellm` binary not found but routed models configured → boot warning naming the install
  command; routed entries stay listed with `degradedNote: "proxy unavailable — install
  litellm"`; `set_model` to a routed entry refuses with that same message. Claude built-ins
  keep working direct (no proxy in the path when it can't run).
- Proxy running but a turn fails → existing `agent_error` truth-telling applies unchanged.

**Operator escape hatch:** `MPAI_PROXY_EXTERNAL=<url>` skips spawn/generation entirely and
uses the operator's own proxy (today's manual mode, preserved for the lab PC topology where
Ollama lives on another machine — note `baseUrl` may already point cross-machine, so the
common cross-machine case needs no external proxy either). `deploy/local-models.md` is
rewritten around the managed flow with the manual flow demoted to an appendix.

### 2.3 Claude defaults refresh (R3) — defaults chosen, flag for approval

| Key | Id | Label | Context window |
|-----|-----|-------|----------------|
| opus | `claude-opus-5` | opus 5 | 1,000,000 |
| sonnet | `claude-sonnet-5` | sonnet 5 | 1,000,000 |
| haiku | `claude-haiku-4-5-20251001` | haiku 4.5 | 200,000 |
| fable | `claude-fable-5` | fable 5 | 1,000,000 |

**Flagged decisions:** (a) opus key REPLACES its id (4.8 → 5) rather than adding a second
opus entry — the key is the stable wire name, the id is the routed default, and a graveyard
of dated entries defeats a curated default set; (b) fable-5 IS added as a fourth built-in —
it exists, it's selectable in other harnesses, and hiding it is a product opinion we have no
ruling for; its premium cost is NOT annotated on the label (cost is not
degradation — it stays visible in the existing usage HUD). (c) 1M context windows are taken at face value per the verified lineup;
the HUD denominator simply gets bigger.

`DEFAULT_MODEL` stays `"opus"` (the key is unchanged; it now routes to opus 5).

### 2.4 First-run without Anthropic credentials (R4)

Verified current behavior, both wrong under the ruling: dev mode boots with only a console
warning and every turn then dies with a turn-time `api_error` — a working-looking UI whose
every prompt fails (`poc/server/src/main.ts:16-18`); production mode (`CLIENT_DIST` set)
refuses to boot at all without `ANTHROPIC_API_KEY` (`poc/server/src/config.ts:72-75`).

- **Boot-time credential detection:** at boot the server checks for `ANTHROPIC_API_KEY` and,
  failing that, for Claude CLI credentials on disk. If neither is found, the Claude built-ins
  stay listed but carry `degradedNote: "no Anthropic credentials — set ANTHROPIC_API_KEY or
  add a local model"`, which the picker already renders. The user learns before their first
  turn, not from a mystery error.
- **Selection stays allowed:** `set_model` to a credential-less Claude entry is NOT refused —
  detection of absence is best-effort (CLI logins can live in the OS keychain, invisible to
  us), so the note warns rather than blocks, and a turn attempt still surfaces the existing
  truthful `agent_error`. (Contrast: proxy-unavailable routed models DO refuse selection,
  §2.2 — there the unavailability is a verified fact.)
- **Production boot gate relaxed:** the requirement changes from "have `ANTHROPIC_API_KEY`"
  to "have at least one plausibly usable model" — an Anthropic credential OR at least one
  configured routed/local model. Key-less local-only operation becomes a supported topology;
  boot refuses only when NO model could possibly answer, with a message naming both remedies.
- **Default-model fallback:** if Claude built-ins are credential-less and at least one
  routed/local model is registered, the effective default for new sessions resolves to the
  first usable model in registration order instead of a mute opus. `DEFAULT_MODEL` the
  constant stays `"opus"`; resolution happens where sessions pick their initial model, and the
  session log records the fallback.
- **Honest caveat (spec-level):** we can cheaply detect the *absence* of credentials, never
  verify that a present key/login is *valid* without a probe call. The note is the exact
  string above ("no Anthropic credentials — set ANTHROPIC_API_KEY or add a local model");
  an invalid key still fails at turn time exactly as today.

### 2.5 Hardening amendments (2026-08-06, adopted during plan review — spec of record)

The plan-review council surfaced concrete attack paths and operability gaps in this design;
the following are ADOPTED as spec, cited by the plan as §2.5 (full audit trail in
`docs/plan-reviews/2026-08-06-model-agnostic-models-review.md`):

1. **apiKeyEnv guard:** `apiKeyEnv` must match `/^[A-Z][A-Z0-9_]*$/` and must not name a
   daemon-reserved variable (`ANTHROPIC_API_KEY`, `SESSION_SECRET`, `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWLIST`) — otherwise a member could point the real
   Anthropic key at a hostile endpoint.
2. **Config-injection guard:** every value interpolated into the generated proxy config is
   charset-validated at registration (`id`, `providerModel`, `baseUrl` per the plan's exact
   regexes/URL rule) AND the generator double-quotes all interpolated scalars with YAML
   escaping.
3. **Route-hijack guard:** an entry's `id` must not equal ANY registered entry's id,
   including built-in `claude-*` ids — no duplicate proxy routes, no Anthropic-traffic
   hijack via id spoofing.
4. **`list_models` wire message:** a third standalone message
   (`list_models { projectId }` → `models_list`), member-gated exactly like add/remove —
   the panel needs full entries (baseUrl etc.) which the session roster deliberately omits,
   and reads of infrastructure detail deserve the same gate as writes.
5. **Backup on persist:** each models.json write retains the previous file as
   `models.json.bak` (single-level) for accidental-removal recovery.
6. **No orphan killing:** the proxy manager never terminates a process it did not spawn; a
   pre-occupied port is an honest `down` + warning naming the manual remedy.
7. **Member-triggered reload disruption accepted:** an add/remove-triggered proxy restart can
   fail in-flight turns of all live sessions on the machine — accepted because it is
   member-gated, seconds-bounded, truthfully surfaced (turn-time errors), equivalent in kind
   to a member switching models mid-session, and permission tiers are out of scope while the
   hub is untouched. Recovery: a failed turn is simply re-runnable once the respawned proxy
   is healthy — no state is lost beyond the interrupted turn itself.
8. **SSRF via member-set baseUrl: accepted by threat model, not range-blocked.** Blocking
   private/loopback ranges would break the product's core topology (Ollama on 127.0.0.1 or a
   LAN PC is the primary use case). The real credential-forwarding vectors are closed by
   §2.5.1-2.5.3 (no daemon secret can be attached to a member-added route). What remains is a
   member pointing the proxy at an internal HTTP service — but every project member ALREADY
   drives an agent with tool/Bash access on this machine through the permission gates, which
   is a strictly more powerful internal-access primitive than a proxy route. The proxy adds
   no capability a member does not already hold.
9. **Scoped proxy spawn env:** the managed litellm child receives an allowlisted environment
   — `PATH`, `HOME`, `ANTHROPIC_API_KEY`, plus exactly the `apiKeyEnv` variable names of
   registered openai-compatible entries — never the daemon's full `process.env`, so the
   third-party proxy process can never see `SESSION_SECRET` or the GitHub OAuth secrets.

### 2.6 Explicitly out of scope (this cycle)

- **Auto-discovery** of local backends (probing Ollama `/api/tags`) — natural cycle 2 on top
  of this config layer; declined in the question round in favor of explicit add.
- Hub-side model config or cross-machine roster aggregation.
- Per-model cost/rate-limit metrics for non-Anthropic providers (absent-metric rendering
  already handles their absence honestly).
- Fine-tuning pipeline (parked separately).

## 3. Error handling summary

- All config parsing: warn-and-skip, never crash boot (existing contract, extended).
- `add_model` validation failures: specific refusal strings to the requester, nothing persisted.
- Proxy spawn failure / binary missing: loud boot warning, routed models refuse selection
  with the reason, Claude built-ins unaffected.
- `models.json` unreadable/corrupt: warn, treat as empty, do NOT overwrite until the first
  successful `add_model` (which rewrites the whole file atomically — write temp + rename).
- Credential-less boot: refuse only when zero plausibly-usable models exist (§2.4); otherwise
  boot, annotate, and let turn-time errors stay truthful.

## 4. Testing

- Registry: load-order/precedence, new-field validation, persistence round-trip (temp-dir
  `MPAI_HOME`), atomic-write behavior on corrupt file.
- Proxy manager: config generation golden tests; spawn/supervise via an injected spawn
  interface (no real litellm in unit tests); health-gate and degradation paths.
- Wire: add/remove_model member-gating, refusals (built-in, in-use, invalid), roster re-emit
  to live sessions and replay to joiners.
- Client: MANAGE view gating, form validation, picker fallback trio updated, HUD denominator
  with 1M windows.
- The models.test.ts byte-pins (`:26-28`, `:157-159`) and the no-hardcode sweep regex (`:40`)
  are updated to the new default set — tests go red first under lean-tdd, as usual.
- First-run (R4): boot gate matrix (key only / local only / both / neither — only "neither"
  refuses in production mode), credential-detection annotation on the roster, default-model
  fallback resolution + its session-log line, set_model-allowed-but-annotated behavior.
- Live proof (done gate): one managed-proxy session on this Mac with an Ollama model —
  add via UI, select, run a turn — screenshotted. REQUIRED, not deferrable (amended
  2026-08-06 at plan review round 1: litellm and the model are verified present on the box,
  so the original deferral clause's premise is gone); after the proof, the test entry is
  removed via the UI so models.json returns to its pre-proof state.

## 5. Files touched (expected)

- `poc/server/src/models.ts` (+ new `modelsConfig.ts`/`proxyManager.ts` or similar split)
- `poc/server/src/config.ts` (boot gate relaxation) + `main.ts` (credential detection, warning)
- `poc/server/src/` wire handlers (add/remove_model), roster re-emit path
- `poc/server/test/models.test.ts` + new suites
- `poc/client/src/components/` picker MANAGE view, `derive.ts` (nothing expected — denominator
  already roster-driven), fallback trio constants, `types.ts`
- `deploy/local-models.md` rewrite; PRD model-surface mentions; tech-debt entry closure
