# Local & non-Anthropic models

Run any model — Ollama, an OpenAI-compatible endpoint, or Anthropic — in the harness,
**alongside** Claude, through a proxy the harness itself generates and supervises. Members add
models from the product UI; nothing is hand-edited on disk to add a model anymore.

```
mpai daemon (agentDriver) → claude-agent-sdk → ANTHROPIC_BASE_URL → managed litellm :4010
                                                                    ├─ claude-*  → api.anthropic.com
                                                                    └─ <id>      → your baseUrl (Ollama, etc.)
```

The proxy only exists when it is needed: if every registered model is a Claude built-in, the
daemon never spawns litellm and the SDK talks to Anthropic directly — zero regression for the
common case. The moment one `ollama` or `openai-compatible` model is registered, the daemon:

1. Generates `$MPAI_HOME/litellm/config.yaml` from the live model registry — one route per
   built-in (`anthropic/<id>` pass-through) plus one route per routed entry
   (`ollama/<providerModel>` or `openai/<providerModel>`, each with its `baseUrl`).
2. Spawns `litellm` as a managed child on `http://127.0.0.1:4010` (override with
   `MPAI_PROXY_PORT`), passing `ANTHROPIC_API_KEY` through to its environment so cloud
   pass-through never 401s.
3. Waits for a health check before pointing the SDK's base URL at it, then supervises the
   process: a crash restarts with backoff; adding or removing a model regenerates the config and
   restarts the proxy.

If `litellm` isn't installed, routed entries stay listed with a note that the proxy is
unavailable and picking one refuses with the same message — Claude built-ins keep working
direct, because the proxy was never in their path to begin with.

## 1. Add a model (the normal path)

1. Install and run the backend yourself — e.g. [Ollama](https://ollama.com):
   `ollama pull qwen3.6:27b` (or any model it serves).
2. Install `litellm` once per machine so the daemon can spawn it:
   `pip install 'litellm[proxy]'` (a venv is fine — see the version-pin note below).
3. Open the project screen as a member and use the **MODELS** panel: fill in label, provider
   (`ollama` or `openai-compatible`), base URL (e.g. `http://127.0.0.1:11434`), provider model
   (e.g. `qwen3.6:27b`), context window, and — for `openai-compatible` only — the name of an env
   var holding the API key (`apiKeyEnv`; the key itself is never typed into the form or stored on
   disk). The routing id previews as you type (`qwen3.6:27b` → `qwen3.6-27b`).
4. Submit. The daemon validates, persists the entry to `$MPAI_HOME/models.json`, regenerates and
   restarts the proxy, and every live session's model picker refreshes with the new entry —
   nobody restarts the server.

**Version pins (2026-08-03, litellm 1.95.0):** `pip install 'fastapi<0.116' 'sse-starlette<3'` —
the proxy imports `get_flat_dependant`, removed in newer FastAPI, and sse-starlette 3.x wants a
newer starlette than FastAPI 0.115 allows. (`pip check` still flags the `mcp` package's starlette
want — unused by this setup; the proxy boots and serves regardless.)

## 2. Removing a model

The same MODELS panel lists every registered model, built-ins marked `built-in`. Non-built-in
rows carry a REMOVE button that arms to `SURE?` on first click and sends on the second — the same
arm-and-confirm idiom as the project lifecycle controls. Built-ins can never be removed. A model
currently selected by any live session refuses removal, naming the session that's using it —
switch that session off the model first.

## 3. Environment variables

| Variable | Meaning |
|---|---|
| `MPAI_PROXY_PORT` | Overrides the managed proxy's port (default `4010`). |
| `MPAI_PROXY_EXTERNAL` | URL of an operator-run proxy. When set, the daemon never generates a config or spawns litellm — it just points the SDK's base URL there. See the appendix. |
| `MPAI_EXTRA_MODELS` | **Deprecated, back-compat only.** JSON array of model entries, applied AFTER `models.json` at boot. Predates the UI/registry flow — prefer the MODELS panel. Still warn-and-skips on malformed entries and can never shadow a built-in. |

Registered models — however they were added — live in `$MPAI_HOME/models.json`, a per-machine
file (model availability is a property of the machine, not the project). Every write keeps the
previous version as `models.json.bak` for accidental-removal recovery.

## 4. Key-less first run

A machine with no `ANTHROPIC_API_KEY` and no Claude CLI login still boots. The Claude built-ins
stay listed but carry the note `no Anthropic credentials — set ANTHROPIC_API_KEY or add a local
model`; picking one is still allowed (a turn attempt surfaces the real error), and if at least
one routed model is registered, new sessions default to it instead of a silent, unusable opus.
Boot only refuses when NO model could possibly answer — no credentials AND no routed model —
naming both remedies in the refusal.

## 5. What a member sees per session

The header model picker lists every registered model; routed entries carry their degradation
note as a tooltip when the proxy isn't reachable. Pick per session — one session can run opus 5
while another runs a local model on the same daemon. Everything else is unchanged: permission
gates, sub-sessions, skills, the record.

- **Degradation is disclosed, not hidden.** A routed/local backend may never report cost, context
  window, rate limits, thinking blocks, or compaction — the HUD shows nothing rather than
  fabricating zeros.
- **Gates catch bad tool calls.** A local model will occasionally emit malformed inputs; the
  permission layer gates them exactly like any other call — expect noisier gates until you trust
  the model.
- **The SDK's system prompt is Claude-tuned.** If a routed model visibly struggles, the named
  intermediate fix is a per-model prompt transform in the proxy (LiteLLM pre/post-processing) —
  not a harness change.

## Appendix: operator-run proxy (`MPAI_PROXY_EXTERNAL`)

This is the manual path from before the harness generated and supervised its own proxy. It still
exists for one real topology: the backend lives on a different machine than the daemon (e.g. a PC
with the GPU, a laptop driving it), so an operator runs `litellm` themselves — often on that PC —
and the daemon is just pointed at it.

Set `MPAI_PROXY_EXTERNAL=<url>` and the daemon skips config generation and spawn entirely; it
never manages this process, never restarts it, never regenerates its config on add/remove. You
own the whole lifecycle.

**Data-exposure note:** if the external proxy is reachable over anything other than loopback, the
Anthropic key and every routed model's traffic **traverses the hop** between the daemon and the
proxy in the clear unless you terminate TLS yourself. Plain `http://` to an external proxy is a
**trusted-LAN topology**, not a hardened one — prefer `https://` for anything beyond a box you
physically control.

Hand-write `$MPAI_HOME/litellm/config.yaml` (or any path you like, since the daemon never reads
it) in the same shape the daemon would generate:

```yaml
model_list:
  # Pass-through: every built-in registry id lands here unchanged. The ids are
  # byte-identical to poc/server/src/models.ts — do not rename.
  - model_name: claude-opus-5
    litellm_params:
      model: anthropic/claude-opus-5
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: claude-sonnet-5
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: anthropic/claude-haiku-4-5-20251001
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: claude-fable-5
    litellm_params:
      model: anthropic/claude-fable-5
      api_key: os.environ/ANTHROPIC_API_KEY
  # Routed: model_name is whatever id you register in models.json (or, on the
  # deprecated path, MPAI_EXTRA_MODELS) — it is the routing key the picker shows.
  - model_name: qwen3.6-27b
    litellm_params:
      model: ollama/qwen3.6:27b
      api_base: http://127.0.0.1:11434
```

Run it: `litellm --config config.yaml --port 4000` (any port — just match `MPAI_PROXY_EXTERNAL`).
Then register the routed entry through the MODELS panel with that `baseUrl`, or, on the
deprecated path only, `export MPAI_EXTRA_MODELS='[...]'` before boot.

## Out of scope (recorded in the plan)

Auto-discovery of local backends (probing Ollama `/api/tags`); a real backend interface beyond
proxy translation; per-subagent model selection; per-model cost/rate-limit metrics for
non-Anthropic providers. Plan of record:
`docs/plans/2026-08-06-model-agnostic-models.md`; design: `docs/specs/2026-08-06-model-agnostic-models-design.md`.
