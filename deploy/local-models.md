# Local models via shim routing (Path 3)

Run a local model (Qwen3-class, or anything Ollama/vLLM/LM Studio serves) in the harness
**alongside** Claude — per session, same daemon, gates and record intact. The Claude Agent SDK
never knows: it speaks the Anthropic Messages API to a LiteLLM proxy, which routes **by model
id** — `claude-*` passes through to Anthropic, local ids go to your local server.

```
mpai daemon (agentDriver) → claude-agent-sdk → ANTHROPIC_BASE_URL → LiteLLM :4000
                                                                   ├─ claude-*   → api.anthropic.com
                                                                   └─ qwen3-32b  → Ollama :11434 (local)
```

## 1. Prereqs

- [Ollama](https://ollama.com) installed and running; a model pulled, e.g.
  `ollama pull qwen3:32b` (dense, best quality) or `ollama pull qwen3:30b-a3b` (MoE, ~3B active —
  much faster on a laptop, and agent loops are latency-sensitive).
- LiteLLM proxy: `pip install 'litellm[proxy]'` (in a venv).

## 2. LiteLLM config (`litellm.config.yaml`)

```yaml
model_list:
  # Pass-through: every built-in registry id lands here unchanged. The ids are
  # byte-identical to poc/server/src/models.ts — do not rename.
  - model_name: claude-opus-4-8
    litellm_params:
      model: anthropic/claude-opus-4-8
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: claude-sonnet-5
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: anthropic/claude-haiku-4-5-20251001
      api_key: os.environ/ANTHROPIC_API_KEY
  # Local: the routing key is what MPAI_EXTRA_MODELS registers and the picker shows.
  - model_name: qwen3-32b
    litellm_params:
      model: ollama/qwen3:32b
```

Run it: `litellm --config litellm.config.yaml --port 4000`

## 3. Register the local model with the daemon

The server registry (`poc/server/src/models.ts`) merges an optional env JSON at boot —
**no code change** to add a model:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000        # SDK talks to the proxy, not Anthropic
export MPAI_EXTRA_MODELS='[{"id":"qwen3-32b","label":"QWEN3 32B (LOCAL)","contextWindow":32768,"local":true,"degradedNote":"local model — no cost/rate-limit reporting; gates may be noisier"}]'
npm run dev                                            # or mpai --hub …, same env
```

Malformed JSON or entries missing fields are skipped with a boot warning — never a boot crash.
Entries can never shadow the three built-in Claude keys.

## 4. Use it

The header model picker (driver, between turns) lists the entry with a `· LOCAL` tag; the
`degradedNote` rides the option's tooltip. Pick it per session — session A can run Opus while
session B runs the local model on the same daemon. Everything else is unchanged: permission
gates, sub-sessions, skills, the record.

## 5. Rules of the topology

- **One daemon = one proxy endpoint.** `ANTHROPIC_BASE_URL` is process-global. For a second,
  different local set, run a second daemon attached to the same hub with its own proxy.
- **Degradation is disclosed, not hidden.** A local backend may never report cost, context
  window, rate limits, thinking blocks, or compaction — the HUD shows nothing rather than
  fabricating zeros (that is the additive-wire rule from the agent-surface cycle, working as
  intended).
- **Gates catch bad tool calls.** A local model will occasionally emit malformed inputs; the
  permission layer gates them exactly like any other call. That is the system working, not
  failing — expect noisier gates and keep `default`/`plan` mode on for local sessions until you
  trust the model.
- **The SDK's system prompt is Claude-tuned.** If the local model visibly struggles, the named
  intermediate fix is a per-model prompt transform in the proxy (LiteLLM pre/post-processing) —
  not a harness change.

## 6. Out of scope (recorded in the plan)

Path 2 (a real backend interface with a tuned local runtime) — revisited only if this setup
proves local models usable *and* the shim ceiling too low. Per-subagent model selection, and any
permission-semantics changes. Plan of record: `docs/plans/2026-08-03-local-models-shim.md`.
