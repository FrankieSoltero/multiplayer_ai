# Local models via shim routing (Path 3) — implementation plan

**Origin:** user design discussion 2026-08-03 — run local models (Qwen3-class, e.g. 32B dense or
30B-A3B MoE) in the harness. Path 3 of three was chosen: the Claude Agent SDK keeps doing
everything; a LiteLLM proxy routes Anthropic-API traffic **by model id** — `claude-*` passes
through to Anthropic, local ids go to a local server (Ollama/vLLM/LM Studio). Path 2 (backend
interface swap) is explicitly shelved: its deliverable (a tuned local runtime) is only justified
if this cycle proves local models usable AND the shim's ceiling too low — record that as the
revisit condition, not a default.

**Process note:** Kimi Code CLI, no soltero council; plan carries its own design section.

**Goal:** a session can pick a local model from the same model picker, on the same daemon, with
the full harness intact (gates, sub-sessions, skills, record) — and the UI is honest about what a
local backend can't report.

**Architecture (locked):**

```
daemon (agentDriver) → claude-agent-sdk → ANTHROPIC_BASE_URL → LiteLLM proxy
                                                             ├─ claude-*  → Anthropic API
                                                             └─ qwen3-32b → Ollama (local)
```

- The SDK never knows: it speaks the Anthropic Messages API to the proxy; LiteLLM's model-list
  routing maps ids to backends. Per-session mixing is free — model choice is already per-session
  (`set_model`).
- One daemon = one proxy endpoint (`ANTHROPIC_BASE_URL` is process-global). The proxy holds the
  real Anthropic key for pass-through.
- Degradation is the cycle-1 payoff: every wire field is additive-optional, so a backend that
  reports no cost/contextWindow/rate-limit/thinking simply shows less. No new wire shapes.

**Stack / suites (baselines at `feature/agent-surface` head, 2026-08-03):**
- server 789 · hub 368 · client 566 (commands per `docs/plans/2026-08-01-agent-surface.md`).

**Plan done gate (objective):**
1. Tasks 1–3 landed; all three suites fresh, exit 0, tsc clean.
2. Registry-driven picker: adding a model entry requires touching ONLY `models.ts` (registry) —
   pinned by test (picker/derive read the registry, no hardcoded trio anywhere else).
3. Absent-field rendering proven by test: a turn_end with no usage/cost/contextWindow shows no
   fabricated numbers (already the additive rule — pin it for the local-model shape).
4. Live demo scripted IF Ollama is present on the box (check first): LiteLLM up, one local-model
   session answers a prompt, a gate renders; screenshot via the /tmp/pw harness. If Ollama is
   absent, the gate degrades to: proxy config + setup doc reviewed, and the demo is recorded as
   deferred in HANDOFF (not silently skipped).

## §1 Design (locked)

1. **Model registry** (`poc/server/src/models.ts`): entries become `{ id, label, contextWindow,
   local?: boolean, degradedNote?: string }`. The id is the routing key the proxy sees
   (`claude-opus-4-8` / `qwen3-32b` / …). The three Claude entries keep byte-identical ids —
   pass-through depends on it. Registry is the single source: `set_model` validation, the
   client roster, and labels all derive from it.
2. **Roster to the client:** the model list rides an additive field on an existing frame
   (project summary or session facts — pick at implementation, named in commit) so the picker
   stops hardcoding `MODEL_LABELS`. Entries carry `label`, `local`, `degradedNote`.
3. **Honesty, not decoration:** local entries show their `degradedNote` where the model is
   picked (picker title/footnote) — "local model: no cost/rate-limit reporting, gates may be
   noisier." The HUD's absent-field behavior (cycle 1) already covers the rest; do NOT fabricate
   zeros.
4. **Proxy config ships as a doc, not code:** `deploy/local-models.md` — LiteLLM `config.yaml`
   (pass-through `claude-*` + Ollama `qwen3:32b`/`qwen3:30b-a3b`), launch env
   (`ANTHROPIC_BASE_URL`, proxy key), the one-daemon-one-endpoint rule, and the mixed-fleet
   topology (a second daemon with a different proxy for a different local set).
5. **Accepted bounds (named):** local-model sessions can produce malformed tool inputs — the
   permission layer gates them (that is the system working, not failing); subagent threads run
   on the same routed model; compaction/rate-limit/thinking signals may never fire for local
   backends; the SDK's system prompt is Claude-tuned and the shim cannot change that (prompt
   transforms in the proxy are the named intermediate fix if it proves hobbling — NOT this
   cycle).
6. **Out of scope:** Path 2 (backend interface); per-model prompt transformation; per-subagent
   model selection; any change to permission/gate semantics; Ollama installation itself
   (operator's machine, operator's call).

## §2 Global constraints

1. **Additive wire only; zero hub changes** (hub relays opaquely).
2. **Truthful UI** — no fabricated metrics for local backends; degradation is disclosed where
   the model is chosen, not discovered later.
3. **Cloud behavior byte-identical** — no registry change may alter the ids, labels, or behavior
   of the three Claude entries; existing tests pin this.
4. **T14 parity** — picker changes keep theme-independent labels.

## §3 Tasks

1. **Server registry** — `models.ts` registry + `set_model`/roster derivation + roster-to-client
   field. Tests: registry is the single source (grep-pin: no other hardcoded trio), ids
   unchanged for the Claude trio, additive roster field on the wire.
2. **Client picker + honesty** — picker reads the roster, groups cloud/local, shows
   `degradedNote`; HUD absent-field test for the local shape. T14 green.
3. **Docs + live demo** — `deploy/local-models.md` (proxy config, env, topology, bounds);
   scripted demo per done-gate 4; PRD §8.6 note + HANDOFF wrap.

## §4 Verification per task

- T1/T2: suites green; registry single-source pin; absent-field rendering pin.
- T3: doc review + demo (or recorded deferral); all three suites fresh at the end.
