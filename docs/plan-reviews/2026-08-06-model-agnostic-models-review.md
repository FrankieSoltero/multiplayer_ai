# Plan Review — Model-Agnostic Model Surface

## ✅ FINAL VERDICT: **PASS 85.2** — Cycle 4 Round 2 (workflow round 11), 2026-08-06

Run `wf_1ed9bade-206`, councilComplete true, 18 agents, 0 errors. Gate: overall 85.2 ≥ 85 ✓ ·
all dimensions ≥ 80 ✓ · blocking violations **0** ✓. Eleven rounds total across four cycles;
every substantive finding (private refreshRoster, absent signal handling, list_models auth
asymmetry, YAML injection, id-spoof route hijack, apiKeyEnv exfiltration, SSRF threat-model
treatment, scoped spawn env) is fixed and adopted into spec §2.5. Post-PASS mechanical fixes
applied per house precedent: Task 8's stale-name grep extended to all touched docs; the
trusted-LAN grep re-anchored to a phrase unique to the new note (the old pattern matched a
pre-existing ollama.com link). D1 bundling notes remain the recorded standing ruling
(owner-decision, kept-with-justification through five consecutive rounds).

Plan: `docs/plans/2026-08-06-model-agnostic-models.md`
Spec: `docs/specs/2026-08-06-model-agnostic-models-design.md`
Council: soltero-skills:plan-review bundled workflow (6 graders opus, skeptics sonnet, re-grades on confirmed misses).

## Round 1 — 2026-08-06 — **BLOCKED — do not execute** (overall 85.4, 1 blocking violation)

Run `wf_4f21ecfc-40f`, councilComplete true, 10 agents, 0 errors.

| Dimension | Weight | Grader | Skeptic misses | Final |
|-----------|--------|--------|----------------|-------|
| D1 Decomposition & ordering | 15 | 87 | 0 | 87 |
| D2 Verifiability | 20 | 91 | 2 | **83** |
| D3 Spec fidelity & traceability | 20 | 86 | 0 | 86 |
| D4 Concreteness | 15 | 95 | 2 | **82** |
| D5 Risk & reversibility | 15 | 88 | 0 | 88 |
| D6 Consistency & completeness | 15 | 87 | 0 | 87 |

Gate: overall 85.4 ≥ 85 ✓ · all dimensions ≥ 80 ✓ · blocking violations 1 ✗ → **BLOCKED**.

### Blocking violation

- **D2 (owner-decision):** the live-proof done gate ("one managed-proxy session… deferrable
  only with a recorded note") states no observable pass condition and carries a deferral
  loophole. **Resolution (controller, logged):** the user's standing /goal directive is to
  finish the cycle and leave it testable on real machines; litellm 1.95.0
  (`~/.mpai/litellm/venv/bin/`) and ollama `qwen3.6:27b` are verified present on this Mac, so
  the strict direction is feasible. The gate is now REQUIRED (deferral clause removed) with an
  observable pass condition (reply streams; proxy log shows the ollama-model request hitting
  `127.0.0.1:4010`; `turn_end` outcome success). Resolved strict-ward, not user-asked —
  flag to the user at PR time.

### Fix list (round 1 → applied to the plan before round 2)

1. D1: Tasks 4/5 ProxyManager handoff unowned + false concurrency claim → server.ts gains an
   optional `proxyManager` option (Task 5); Task 4 threads the instance in main.ts and now
   **depends on 5**; concurrency note dropped.
2. D1: Task 2 bundling → kept as one task with a logged justification (initRegistry's
   credential annotation couples registry to detection; a split creates a two-way dep).
3. D2: Task 8 "human-read" verify → mechanical grep assertions.
4. D3: in-use refusal restored to the spec's string shape `model in use by session <id>`.
5. D3: server console log line on add/remove success added as behavior rows (spec §2.1).
6. D3: HUD 1M-denominator test action → behavior row + derive.test.ts added to Task 6.
7. D4: `local?`/`degradedNote?` declared pre-existing (models.ts:16-18) in Task 2's produces;
   Task 6 mirror now consistent (also resolves the D6 duplicate and the second
   "owner-decision", which was mechanical in substance).
8. D4: dev-mode boot warning string quoted verbatim (third "owner-decision", mechanical in
   substance: it reuses the production refusal text with a `[boot]` prefix).
9. D4: `Session.append` fan-out pinned to `session.ts:19-28`.
10. D5: managed-proxy reload blast radius (SIGTERM interrupts in-flight turns of ALL live
    sessions) recorded as an accepted edge alongside the crash-restart note.
11. D5: gate-relaxation rollback note (git revert, no persisted-state effect).
12. D6: proxy failure paths unified — any child exit or health-timeout → kill if alive →
    backoff respawn (covers exit-during-starting and hung-child cases).

## Round 2 — 2026-08-06 — **BLOCKED — do not execute** (overall 86.1, 1 blocking violation)

Run `wf_6bc17044-691`, councilComplete true, 8 agents, 0 errors.

| Dimension | Weight | Grader | Skeptic misses | Final |
|-----------|--------|--------|----------------|-------|
| D1 Decomposition & ordering | 15 | 88 | 0 | 88 |
| D2 Verifiability | 20 | 89 | 0 | 89 |
| D3 Spec fidelity & traceability | 20 | 88 | 0 | 88 |
| D4 Concreteness | 15 | 91 | 4 | **80** |
| D5 Risk & reversibility | 15 | 88 | 0 | 88 |
| D6 Consistency & completeness | 15 | 82 | 0 | 82 |

Gate: overall 86.1 ≥ 85 ✓ · all dimensions ≥ 80 ✓ (D4 exactly at floor) · blocking 1 ✗ → **BLOCKED**.

### Blocking violation

- **D4:** Task 2's register-validates row used the placeholder `<same string the warn path
  uses>` where every sibling row pins a literal — and the wire layer re-emits it to clients.
  Fixed: literal pinned as `model entry needs string id, string label, numeric contextWindow`.

### Fix list (round 2 → applied before round 3)

1. D4 blocking: literal validation error string pinned (above).
2. D4: empty-apiKeyEnv skip string pinned; ADD-form context-window input contract pinned
   (number, required, integer > 0); YAML `model_list` ordering rule stated (managedModels()
   registration order).
3. D4 "owner-decisions" (mechanical in substance — targets discoverable by reading the repo):
   Task 8's PRD target pinned to `docs/PRD.md:512-520` (§8.6 *Final state* local-models
   paragraph); tech-debt target pinned to §2.9 (line 395).
4. D1: Task 4 banner ("build after Task 5") added; numbering kept, table is the contract.
5. D2: Task 4's base-url-wiring and shutdown rows annotated "verified by the Done-gate live
   proof, not config.test.ts".
6. D3: spec citations added to Tasks 4/7/8; proxy-unavailable string extension over spec §2.2
   recorded as a logged deviation.
7. D5: MPAI_PROXY_EXTERNAL data-exposure constraint added (https for non-loopback; plain http
   = trusted-LAN only, documented in Task 8).
8. D6: reload() now runs the full start-style mode decision (absent→managed, →unavailable,
   respawn; last-routed-model-removed keeps the child serving pass-through until next boot);
   two reload behavior rows added; resolveDefaultModel multi-routed tiebreak pinned
   (first routed in registration order). NEW edge found while fixing: sessions created before
   an absent→managed transition have CLI processes without the proxy base URL — pinned an
   honest refusal (`this session predates the proxy — start a new session to use local
   models`) backed by a new `AgentDriver.proxied` flag.

## Round 3 — 2026-08-06 — **BLOCKED** (overall 85.7, 2 blocking violations) — cycle-1 max rounds hit

Run `wf_80e72b4d-057`, councilComplete true, 12 agents, 0 errors.
Finals: D1 85 · D2 81 · D3 88 · D4 87 · D5 87 · D6 87. Floors all met.

Blocking: (a) D2 — the proxy-ABSENT base-URL branch was deferred to a live proof that never
exercises it; (b) D2 — Task 8's HANDOFF row had no observable check. Standout minor: D5 caught
a real member-driven key-exfiltration vector (openai-compatible entry with
`apiKeyEnv=ANTHROPIC_API_KEY` + hostile baseUrl forwards the real key off-box).

**Cycle-1 max rounds reached → plan re-authored with the full fix set (house precedent:
presentation cycle 2026-07-31) and review restarts as cycle 2.** Fixes applied:

1. Blocking (a): new pure `resolveBaseUrl(operatorBaseUrl, proxyBaseUrl)` with three
   config.test.ts unit rows (proxy active / absent / neither) — the absent branch is
   unit-covered.
2. Blocking (b): Task 8 verify gains greps for HANDOFF ("START HERE" + "model-agnostic"),
   tech-debt §2.9 annotation, and the trusted-LAN/https note.
3. D5 security: `apiKeyEnv` guard — must match `/^[A-Z][A-Z0-9_]*$/` and must not name a
   daemon-reserved variable (ANTHROPIC_API_KEY, SESSION_SECRET, GITHUB_* set); exact
   skip/refusal string pinned. Resolved strict-ward without asking (security floor, corporate
   standards); disclose at PR time.
4. Shutdown verification: proxyManager.test.ts stop()-sends-SIGTERM assertion + live-proof
   `pgrep -f litellm` empty-after-exit observable.
5. set_model during `starting` refuses with the same `proxy is down — restarting` string;
   GC reload line carves out the last-routed-model exception (child keeps serving
   pass-through); Task 3 gains the matching behavior row.
6. Deviation notes logged: predates-proxy refusal (spec-silent, architecture-forced),
   proxy-down second string (spec has only the unavailable string); the spec's internally
   inconsistent credential-note caveat was aligned to the single exact string.
7. D4 pins: session iteration handle (`projects.values()` → `project.sessions.values()`,
   server.ts:684), deterministic first-offender ordering, error-line pattern cite,
   `hasRoutedModels = managedModels().some(isRouted)`.
8. D1 owner-decisions resolved as justification notes (Task 2 atomic validate→mutate→persist
   contract; Task 5 one-wire-contract/one-test-file coupling); Task 4/5 numbering kept with
   the banner (council round-3 fix text accepts either).

## Cycle 2 Round 1 (workflow round 4) — 2026-08-06 — **BLOCKED** (overall 82.9, D2 floor breach 78, 3 blocking)

Run `wf_2b255b45-157`, councilComplete true, 14 agents, 0 errors. This round's skeptics read
the SOURCE, not just the plan — and caught real defects:

- **Blocking (D4): `AgentDriver.refreshRoster()` is `private`** (agentDriver.ts:653) — the
  plan told server.ts to call it. Fixed: Task 5 now explicitly makes it public.
- **Blocking (D4): "process exit path" was vapor** — main.ts has no signal handling at all.
  Fixed: Task 5→4 shutdown row now specifies `process.on("SIGTERM"/"SIGINT")` handlers
  calling `proxyManager.stop()` then `process.exit(0)`, registered after server start.
- **Blocking (D3): ordering rule misattributed to spec §2.1** — fixed: string shape per spec,
  iteration order explicitly plan-pinned.
- D2 floor: added modelsWire row for server-without-proxyManager, Task 7 id-derivation
  example row (`qwen3:27b`→`qwen3-27b`), Task 4 coverage note (main.ts glue = live proof +
  Task 3's stop() assertion).
- Minors: spec citations for Tasks 1/3/6; concrete ProxyManager dep adapters named;
  `isMember` corrected to `isProjectMember(project, userId)` (types.ts:213); persist-failure
  rollback row (`failed to write models.json: <message>`); apiKeyEnv validation order +
  split per-branch strings (empty → format → reserved); one-daemon-one-endpoint constraint
  scoped around the predates-proxy edge; execution-order summary line added
  (1‖6 → 2 → 3 → 5 → 4 → 7 → 8). D1 split suggestions (Tasks 2/4/5) remain
  justified-not-split — the bundles share atomic contracts and single test files.

## Cycle 2 Round 2 (workflow round 5) — 2026-08-06 — **BLOCKED** (overall 84.5, D5 floor breach 74, 2 blocking)

Run `wf_eb68e85a-439`, councilComplete true, 14 agents, 0 errors. Two real D5 blockers:

- **Blocking: list_models auth asymmetry** — read was identity-gated while writes were
  member-gated, exposing baseUrl/providerModel/apiKeyEnv of every registered model to any
  identified user. Fixed strict-ward: `list_models { projectId }` is member-gated with the
  same refusal as add/remove; panel sends projectId on mount.
- **Blocking: unflagged global reroute** — first routed model rewrites ANTHROPIC_BASE_URL for
  all new sessions with no flag or justification. Resolved as justify-not-flag (a flag would
  re-create the env fiddling the spec removes): loopback-only hop, byte-identical pass-through
  proven live 2026-08-04, single-endpoint SDK architecture, truthful degradation, live
  sessions never rerouted mid-life, MPAI_PROXY_EXTERNAL escape hatch. Recorded verbatim in
  Global Constraints.
- Minors applied: `models.json.bak` retained on every persist (accidental-remove recovery);
  schema-rollback note (old code warn-and-skips new fields — revert strands, never corrupts);
  register-collision row (`model "<id>" already registered`); env-set ownership named (main.ts
  at boot, ProxyManager on undefined→defined reload transition); Task 4 verify runs
  proxyManager.test.ts and owns the pgrep acceptance; per-task full-suite regression gate
  stated; Task 2 spec citation; Task 4/6 bundling justifications; execution order notation
  `1‖6 → 2 → 3 → 5 → (4 ‖ 7) → 8`; SessionPicker plumbing pinned (wsRef :111, guarded send
  :159-160, error state :99); inline validation message pinned; warn sink pinned (main.ts:17-18).

## Cycle 2 Round 3 (workflow round 6) — 2026-08-06 — **BLOCKED** (overall 84.1, D5 floor 74, 3 blocking) — cycle-2 max rounds hit → re-authored again (cycle 3)

Run `wf_13e1e21b-a89`, councilComplete true, 14 agents, 0 errors. Two REAL security blockers
found by source-reading skeptics, one verification blocker:

- **YAML injection (D5):** id/providerModel/baseUrl were raw-spliced into the generated
  LiteLLM YAML — a crafted value could inject an `api_key:` line, defeating the apiKeyEnv
  guard. Fixed two-layer: registration charset/URL validation (exact regexes + skip strings
  in Global Constraints) AND generateLitellmConfig double-quotes every interpolated scalar,
  with a golden test proving a `\n  api_key:`-bearing value renders inert.
- **Route hijack via id spoofing (D5):** collision guard checked registry KEYS, but the proxy
  routes on ID — key `myopus` with id `claude-opus-5` + hostile baseUrl would hijack real
  Anthropic traffic (a latent hole in the EXISTING MPAI_EXTRA_MODELS path too). Fixed:
  id-route uniqueness against entry VALUES incl. built-in ids (`entry "<id>" skipped — id
  already routed`); invariant: no duplicate model_name, asserted.
- **stop() unverified (D2):** Task 4 cited a Task 3 assertion that didn't exist. Fixed: Task 3
  gains stop()-with-child / stop()-without-child rows; Task 4 gains
  `installShutdownHandlers(proc, proxyManager)` — a testable seam with fake-injected
  SIGTERM order assertion.
- Minors applied: orphan-reclaim on start (health-probe-identified leftovers killed by
  config-path match; foreign squatters never killed), .bak single-level caveat, health poll
  cadence 500ms, backoff counter resets on healthy, models.json key-recovery rule (key===id),
  concurrent add/remove serialization rationale, `<exact string>` placeholder resolved.
- D1 bundling owner-decisions: bundles kept with justifications (three rounds of graders
  scored D1 85-93 with them; the regrade pattern flags the justification shape itself —
  splitting further would trade real atomic contracts for rubric cosmetics; recorded as the
  controller's standing decomposition ruling).

## Cycle 3 Round 1 (workflow round 7) — 2026-08-06 — **BLOCKED** (overall 85.2, floors met, 3 blocking)

Run `wf_8ddca25d-f4e`, councilComplete true, 14 agents, 0 errors. All three blockers targeted
the round-6 orphan-reclaim addition (unnamed kill mechanism, undefined "spawn-shape-match"
term, quoting-rule-vs-template contradiction). Resolution: **cut the gold-plating** — the
automated orphan kill (itself scope creep from a round-6 minor) is REMOVED. ProxyManager never
kills a process it did not spawn; a pre-occupied port is a `down` status with an exact warn
naming the manual remedy (`pkill -f litellm`), testable through the existing injected probe.
Also applied: YAML template now shows the double-quoted scalars (template = quoting rule);
boot-order prose now uses `resolveBaseUrl(...)` verbatim; id-derivation example aligned to the
live-proof model (`qwen3.6:27b`); joiner-after-add replay row added (server.ts:1343-1345);
HANDOFF START HERE content pinned. D1 bundling flags: standing ruling unchanged.

## Cycle 3 Round 2 (workflow round 8) — 2026-08-06 — **BLOCKED** (overall 83.6, D3 floor 77, 1 blocking)

Run `wf_a0efdd97-c6a`, councilComplete true, 14 agents, 0 errors. Root cause identified as
STRUCTURAL: eight rounds of council-driven security hardening lived in the plan while the spec
stayed at its approved state — D3 correctly read the guards (apiKeyEnv, charset, id-uniqueness,
list_models, .bak) as unlogged inventions, and the last-routed-model reload exception
contradicted spec §2.2's unconditional restart. **Resolution: the SPEC was amended** — new
§2.5 "Hardening amendments" adopting all seven council-driven behaviors as spec of record
(each traceable to the round that surfaced it, this file is the audit trail), §2.2 point 4
amended with the reload exception, out-of-scope renumbered §2.6. Plan citations updated to
§2.5.1-7. Also: MPAI_EXTRA_MODELS grep added to Task 8; stale-name regex documented as
complete (only opus-4-8 forms retired). D1 bundling flags: standing ruling unchanged (fourth
consecutive round of graders scoring D1 91-93 with the justifications in place).

## Cycle 3 Round 3 (workflow round 9) — 2026-08-06 — **BLOCKED** (overall 83.5, D5 floor 79, 3 blocking) — cycle-3 max hit → re-authored (cycle 4)

Run `wf_ed968192-e9d`, councilComplete true, 16 agents, 0 errors. Substantive blockers fixed:

- **SSRF via member-set baseUrl (D5):** resolved as accepted-by-threat-model, NOT range-blocked
  (spec §2.5.8): blocking private/loopback ranges would break the product's primary topology
  (Ollama on 127.0.0.1/LAN PC); credential forwarding is already closed by §2.5.1-3; every
  member already drives a gated agent with tool access — a strictly more powerful
  internal-access primitive than a proxy route.
- **Live-proof spec mismatch (D3):** the plan was STRICTER than spec §4's deferral clause;
  spec §4 amended to REQUIRED (the deferral premise — model possibly absent — is gone) +
  post-proof cleanup step.
- **Reload recovery half (D5):** §2.5.7 gains the recovery sentence (failed turns re-runnable
  once healthy; nothing lost beyond the interrupted turn).
- Mechanical: "→ green" precisely defined once in the header (behavior cases exist as
  failing-first tests and pass; vitest exit 0; tsc exit 0); corrupt-file and health-timeout
  warn strings pinned; set_model routed-success row added; live-proof cleanup in done gates.

**Process observation (recorded for the wrap-up):** grader scores have run 87-96 every round;
the mandated skeptic pass ("find what the grader MISSED", score framed as suspicious) has
found progressively shallower items each round — round 9's D2 misses were wording-level
("'green' → 'exits 0'"). The genuinely substantive findings (private refreshRoster, absent
signal handling, list_models auth asymmetry, YAML injection, id-spoof hijack, apiKeyEnv
exfiltration, SSRF treatment) are all fixed and now spec-adopted. If cycle 4 round 1 blocks
only on wording-novelty, the controller will stop the loop and surface the terminal state to
the user rather than iterate indefinitely.

## Cycle 4 Round 1 (workflow round 10) — 2026-08-06 — **BLOCKED** (overall 85.0, floors met, 1 blocking) — CONVERGING

Run `wf_e7c3ba0c-409`, councilComplete true, 18 agents, 0 errors. Down to a single blocking
violation, and it was substantive: **the spawned litellm child inherited the daemon's full
process.env** (SESSION_SECRET, GitHub OAuth secrets included). Fixed as spec §2.5.9: scoped
allowlist spawn env (`PATH`, `HOME`, `ANTHROPIC_API_KEY`, plus exactly the registered
`apiKeyEnv` names), with a behavior row asserting the reserved secrets are absent. Also:
wildcard-vs-enumerated route wording reconciled in spec §2.2 (enumeration is the proven
shape); screenshot restored to the live-proof observables (spec §4 parity); literal PATH
invocation pinned for the live proof; PC-box grep coverage extended; "R4" spelled out.
D1 bundling: the round-10 grader itself marked Tasks 2/5 "accept as-is / no structural change
required" — standing ruling holds.
