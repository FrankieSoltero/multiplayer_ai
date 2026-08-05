# §8.8 hub-side oversight — implementation plan

**Goal:** the hub runs the team oversight summarizer for hub-attached projects — member-toggled,
persisted in HubDb v4, capability gated on the hub host's `ANTHROPIC_API_KEY`, with summaries
pushed down to uplinks so agents' `team_update`/PULL work identically to solo.

**Architecture:** reuse the server package's `Overseer` state machine on the hub (one instance,
project-keyed), fed by `oversightSessionDigest` over the hub's cross-machine session logs.
A new `oversight_update` down-frame carries state to owning uplinks; the laptop stores the last
frame per project and the existing injection/tool sites prefer hub-pushed state when
hub-attached. Spec of record: `docs/specs/2026-08-04-hub-oversight-design.md` (rulings R1–R4).

**Stack / suites (baselines at main `56296d3`):**
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (824)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (368)
- client: `cd poc/client && npx tsc -b && npx vitest run` (591)

## Global Constraints

1. **Additive wire only** — old snapshots/frames parse; pre-v4 hub DBs migrate forward at open.
2. **Exact strings, locked** (spec §1/§3; existing ones byte-identical to their solo/hub sites):
   - capability refusal: `oversight is unavailable on this hub — no ANTHROPIC_API_KEY configured`
   - membership refusal: `join this project before changing it` (uncoded, = lifecycle's)
   - shape refusals: `set_oversight requires a valid projectId` · `set_oversight requires enabled: true|false` (= solo server.ts:1429/1432)
   - tool text unchanged: `team oversight is disabled` · `no team summary yet`
3. **Durable-before-visible** — HubDb row written before any snapshot push / down-frame emit.
4. **No real API calls in tests** — the `Summarize` seam (`(input: OversightInput) => Promise<string>`) is injected everywhere.
5. **Digest privacy rule holds** — hub digests use `oversightSessionDigest` verbatim (metadata
   only, control-stripped at the producer); never hand transcript prose to the summarizer.
6. **Model:** `MODELS.haiku.id` via the reused `runOversightSummarize`; no new model knob.

## Task Dependency Table

| # | Task | Files | Depends on | Risk |
|---|------|-------|-----------|------|
| 1 | Server package seams: Overseer.seed, exports, down-frame type | `poc/server/src/overseer.ts`, `poc/server/src/relayProtocol.ts`, `poc/server/package.json`, `poc/server/test/overseer.test.ts`, `poc/server/test/relayProtocol.test.ts` | — | standard |
| 2a | Hub: HubDb v4 (migration + table + accessors) | `poc/hub/src/hubDb.ts`, hub db test file | — | standard |
| 2b | Hub: overseer wiring + set_oversight + down-frame emit + snapshot | `poc/hub/src/hub.ts`, `poc/hub/src/hubStore.ts`, hub test files | 1, 2a | judgment |
| 3 | Laptop: relay stores oversight frames; injection/tool precedence | `poc/server/src/relay.ts`, `poc/server/src/server.ts`, `poc/server/test/relayIntegration.test.ts` or new | 1 | standard |
| 4 | Client: truthful unavailable rendering | `poc/client/src/types.ts`, `poc/client/src/components/OversightPanel.tsx`, `poc/client/src/components/OversightPanel.test.tsx` | 1 | mechanical |
| 5 | Docs: PRD §8.8 + tech-debt + HANDOFF | `docs/PRD.md`, `docs/tech-debt.md`, `HANDOFF.md` | 2b,3,4 | mechanical |

## Task 1 — server package seams

*(Three independent seams grouped deliberately: all three are prerequisites of every
downstream task and share the two test files — splitting them buys no parallelism.)*

**Files:** modify `poc/server/src/overseer.ts`, `poc/server/src/relayProtocol.ts`,
`poc/server/package.json`; tests in existing suites for both modules.

**Produces (later tasks rely on, exact):**
- `Overseer.seed(projectId: string, state: { enabled: boolean; latest: OversightSummary | null }): void`
  — installs persisted state WITHOUT calling `onUpdate` and WITHOUT triggering a refresh; seq
  restored from `state.latest?.seq ?? 0`.
- package.json `exports` gains `"./overseer"` and `"./digest"` (types+default, same shape as
  the existing 12 entries).
- relayProtocol: down-frame variant `{ t: "oversight_update", projectId: string,
  enabled: boolean, latest: { text: string; ts: string; seq: number } | null }`, parsed and
  bound-checked by `parseDownFrame` exactly like `contested` (reject overlong/malformed —
  reuse the module's existing bounds discipline; `text` capped at 4096 chars).

**Behavior table:**
| case | input/state | expected |
|---|---|---|
| seed installs silently | seed(p, {enabled:true, latest:S}) | isEnabled true, latest()===S, onUpdate NOT called, no refresh scheduled |
| seed then activity | seeded enabled, then notify(p) | debounced refresh runs (seeded state is live, not inert) |
| frame roundtrip | encode oversight_update → parseDownFrame | identical value out |
| frame bounds | text > 4096 chars | frame rejected, not truncated silently (match contested's reject posture) |

**Verify:** server suite green (824 + new), tsc clean.
**Commit:** `feat(server): oversight seams — Overseer.seed, overseer/digest exports, oversight_update down-frame`

## Task 2a — hub: HubDb v4

**Files:** modify `poc/hub/src/hubDb.ts` (SCHEMA_VERSION 3→4, migration, table + accessors); hub db tests.

**Risk note:** the v3→v4 migration is **additive-only** — a new table via
`CREATE TABLE IF NOT EXISTS`, no `ALTER`, no data movement; blast radius to existing tables is
zero. Rollback posture: the boot backup taken before migrate (existing §8.10 order
open/migrate → backup → prune → load) is the restore point.

**Produces:** HubDb v4 accessors (exact):
- `getOversight(projectId: string): { enabled: boolean; summary: string | null; seq: number; ts: string | null } | null`
- `setOversightEnabled(projectId: string, enabled: boolean): void`
- `saveOversightSummary(projectId: string, summary: string, seq: number, ts: string): void`
- DDL: `CREATE TABLE IF NOT EXISTS project_oversight (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, summary TEXT, seq INTEGER NOT NULL DEFAULT 0, ts TEXT)`

**Behavior table (2a):**
| case | input/state | expected |
|---|---|---|
| v3→v4 migration | open a seeded v3 fixture DB | version becomes 4; rows in ALL prior tables survive intact; `project_oversight` exists empty |
| accessor roundtrip | setOversightEnabled + saveOversightSummary then getOversight | exact values back; unknown project → null |

**Verify:** hub suite green, tsc clean.
**Commit:** `feat(hub): HubDb v4 — project_oversight table + accessors (additive migration)`

## Task 2b — hub: overseer wiring, toggle, emit

**Files:** modify `poc/hub/src/hub.ts` (overseer instance, set_oversight handler, notify hook,
emit), `poc/hub/src/hubStore.ts` (snapshot's real oversight); hub tests.

**Consumes:** Task 1's `seed`, exports, `oversight_update` frame; Task 2a's accessors.

**Field mapping (stated once):** HubDb's `summary` column ↔ `OversightSummary.text` ↔ the
`oversight_update` frame's `latest.text` — one string, three carriers.

**Behavior table (2b):**
| case | input/state | expected |
|---|---|---|
| summarize fails | Summarize rejects | no row saved, no frame emitted, prior enabled/latest retained (Overseer's failure-keeps-previous, inherited — pin it hub-side once) |
| capability off | no `ANTHROPIC_API_KEY` in hub env, set_oversight enabled:true | exact capability refusal string; disable (enabled:false) still ACCEPTED |
| capability off, snapshot | any project | snapshot `oversight: { enabled, latest, available: false }` |
| shape gates | bad projectId / non-bool enabled | exact shape-refusal strings, checked in the lifecycle handler's order (identify → slug → value → membership) |
| member gate | identified non-member | exact membership refusal (uncoded) |
| toggle persists | member enables | `project_oversight` row enabled=1 BEFORE snapshot push; snapshot shows enabled |
| refresh lands | summarize resolves "S1" | row saved (summary,seq,ts) before push; snapshot latest.text="S1"; `oversight_update` frame emitted to every owning uplink of the project's sessions (deduped — same targeting as `emitContested`) |
| disable emits | member disables | frame emitted with enabled:false (latest may persist in row; frame carries latest:null) |
| restart seeds | reopen HubDb, rebuild hub | overseer seeded: enabled + latest + seq survive; NO refresh fired by boot itself |
| cross-machine digest | project with sessions on 2 uplinks | one summarize input containing BOTH sessions' digests (via `oversightSessionDigest`) |
| activity trigger | INTERESTING event published to an enabled project | `overseer.notify(projectId)` called (debounce is Overseer's; hub adds no second timer) |
| replay to joiner | browser joins after refresh | snapshot carries latest (no frame needed for browsers — snapshot is their channel) |
| uplink reconnect | uplink re-attaches while a project is enabled | hub re-emits the current `oversight_update` to that uplink (the laptop cleared its map on disconnect — spec §4 self-heal) |

**Exact values:** capability check is `Boolean(process.env.ANTHROPIC_API_KEY?.trim())` read
once at hub construction and passed in as `oversightAvailable: boolean` (constructor/opts
seam so tests set it directly). *Supersedes the spec's "`hubEnv.ts` pattern" phrasing,
logged here: presence-only needs no validation machinery and hubEnv's job is refusing
malformed values, of which a bare key has none — the read site still lives beside the other
boot config reads.*

**Verify:** hub suite green (368 + new), tsc clean; server suite untouched.
**Commit:** `feat(hub): hub-side oversight — member-gated toggle, cross-machine summarizer, uplink push`

## Task 3 — laptop: frame storage + precedence

**Files:** modify `poc/server/src/relay.ts`, `poc/server/src/server.ts`; server tests.

**Consumes:** Task 1's frame type.
**Produces:** relay exposes `hubOversight(projectId: string): { enabled: boolean; latest: OversightSummary | null } | null`
(memory map, replaced wholesale per frame; cleared on disconnect — hub re-pushes on reconnect).

**Behavior table:**
| case | input/state | expected |
|---|---|---|
| frame stored | oversight_update arrives | hubOversight(p) returns frame's state; second frame replaces first |
| injection precedence | hub-attached project, pendingOversight set, hub latest="H" | `<oversight>\nH\n</oversight>` injected; local overseer NOT consulted |
| tool text precedence | hub-attached, hub enabled+latest | `team_update` text = hub latest; hub disabled → `team oversight is disabled` |
| solo unchanged | no relay / project not hub-attached | injection + tool text read local overseer byte-identically to today |
| solo snapshot | solo project snapshot | gains `available: true` (additive) |
| disconnect | relay closes | stored frames cleared; solo behavior resumes |

**Verify:** server suite green (824 + Task 1's new + these), tsc clean.
**Commit:** `feat(server): hub-pushed oversight — relay frame store, injection/tool precedence`

## Task 4 — client: truthful unavailable

**Files:** modify `poc/client/src/types.ts` (additive `available?: boolean` on the snapshot
oversight shape), `poc/client/src/components/OversightPanel.tsx` (the toggle site —
`set_oversight` wiring at App.tsx:520), `poc/client/src/components/OversightPanel.test.tsx`.

**Behavior table:**
| case | input/state | expected |
|---|---|---|
| available:false | hub says unavailable | toggle control disabled; reason line renders the exact capability string; PULL untouched (spec §5: PULL is unchanged — with oversight unavailable it injects nothing, which is already truthful) |
| available:true / absent | solo or capable hub | renders byte-identically to today (absent field = old server) |
| theme parity | both themes | new text is theme-token only (T14 convention) |

**Verify:** client suite green (591 + new), tsc -b clean.
**Commit:** `feat(client): oversight unavailable rendering — truthful reason, no dead toggle`

## Task 5 — docs

**Files:** `docs/PRD.md` §8.8 (*Today* gains hub-side oversight; *Final state* → reached),
`docs/tech-debt.md` (remove/resolve the "oversight configured hub-side still open" line),
`HANDOFF.md` wrap.

**Verify:** `grep -rin "hub-side oversight" docs/PRD.md docs/tech-debt.md` — every remaining match describes SHIPPED behavior; zero matches phrased as open/pending/still-open.
**Commit:** `docs: §8.8 complete — hub-side oversight shipped (PRD + tech-debt + HANDOFF)`
