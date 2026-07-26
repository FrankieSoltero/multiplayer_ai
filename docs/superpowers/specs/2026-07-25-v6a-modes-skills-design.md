# v6a — Mode cycling (DEFAULT → AUTO → PLAN) + skills screen discoverability

*Design spec, approved 2026-07-25. Brainstormed from the user's four-part ask (skills discoverability, mode cycling, fleet view, multi-session coordination); scope split "quick wins first" — this spec covers the first two. Fleet view + coordination decisions are banked in §8 for the v6b cycle. Positioning constraints from `market-research.md` are baked in throughout.*

## 1. Scope decisions (locked in brainstorm)

| Decision | Choice | Why |
|---|---|---|
| Cycle split | v6a = mode cycling + skills discoverability; v6b = interrupt rail / fleet screen + coordination | Ship small UI wins fast; the big pieces get their own design cycle. |
| AUTO semantics | Relay-enforced: server auto-allows permission gates while mode is `auto` | Works instantly mid-turn, no SDK restart (sidesteps gotcha #11), keeps every gate on the wire. Rejected: SDK-native `acceptEdits` (restart-bound, silently bypasses the wire — dishonest transcript); driver's client auto-clicking (dies with the tab, forges the driver's decisions). |
| Who cycles, when | Driver-only, anytime including mid-turn | Matches principle "every capability is scoped to the driver". Mid-turn flip to AUTO rescues a turn stuck on gates. Watchers see the mode, can't change it. |
| Mode hotkey | `M` (bare letter), plus the header control | Consistent with the A=arcade, S=skills single-letter family. Shift+Tab rejected: it is reverse focus traversal in a browser — hijacking it breaks the accessibility floor. `M` is dead while an input is focused; the header MODE control covers that case. |
| Skills screen access | Header `SKILLS` button + `S` hotkey; `screen` becomes React state seeded by `?screen=` | No page reload, arcade/scroll state survives; deep links keep working. `?screen=status` stays URL-only (design-only screen — advertising it would be a fake affordance). |
| TUI future | Noted as carried direction, not built | User wants a shell program like Claude Code eventually. Constraint adopted now: the wire protocol stays client-agnostic — no web-only assumptions in events or semantics. |

## 2. Wire & server

**Extend** (no new event types needed):

```ts
// events.ts — existing unions extended
| { type: "permission_mode_change"; mode: "plan" | "default" | "auto"; userId: string }
| { type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string; auto?: true }
```

**Client → server:** `set_permission_mode` accepts `mode: "default" | "auto" | "plan"`. Server validation (existing pattern at `server.ts:331`):

- Sender must be the driver → else error, nothing appended.
- Mode must be one of the three → else error.
- The `!agentBusy` restriction is **dropped** for mode changes (mid-turn switching is the point). Model switching keeps its existing idle-only rule — unchanged.

**AUTO behavior (relay layer, `agentDriver.ts` + `server.ts`):**

- While mode is `auto`, an incoming `permission_request` is appended to the wire as normal, then immediately resolved `allow`: the SDK's `canUseTool` promise resolves, and a `permission_decision { requestId, decision: "allow", userId: <current driverId>, auto: true }` is appended. Attribution is deliberate: the driver owns the mode, so the driver's id is on every auto-decision — accountability stays human.
- Switching **into** `auto` mid-turn sweeps all currently-pending permission requests the same way (`agentDriver` exposes a resolve-all-pending; only unanswered gates are touched — idempotent, cannot double-answer; the existing abort-cleanup path in `agentDriver.ts:222-245` already guards races).
- Switching **out of** `auto` leaves past auto-decisions resolved; new requests gate normally.
- Plan-approval requests (`pendingPlans` / ExitPlanMode) are **not** auto-approved — plan review is a human checkpoint, not a tool gate.
- The SDK's own `permissionMode` is untouched by `auto` — AUTO lives entirely at the relay. `plan`/`default` keep their existing SDK semantics (take effect on the next turn; known cosmetic pairing gotcha #11 unchanged).

## 3. Client — mode control

- `derive.ts`: `permissionMode` becomes the three-value union; `permission_decision` events with `auto: true` are distinguishable to renderers.
- Header: the PLAN toggle becomes a MODE control rendering the current mode `DEFAULT / AUTO / PLAN`; click advances the cycle. `canCycleMode = isDriver` (replaces `canTogglePlan`'s `isDriver && !agentBusy`).
- AUTO gets loud warning styling (amber, per terminal.css palette) — this is load-bearing, not decoration: while AUTO is on, gates self-approve, and nobody in the party may miss that.
- Hotkey `M`: advances the cycle with the standard guards — driver only, ignored while INPUT/SELECT/TEXTAREA focused, ignored with meta/ctrl/alt held, ignored while the arcade has the keyboard (`arcadeCapturing`). No conflict with gate hotkeys (`a`/`d`) or arcade letters by construction of those guards.
- Transcript gate cards resolved by an auto-decision render an `⚡ AUTO` marker (with the driver's glyph beside it) instead of a plain participant decision.

## 4. Client — skills screen

- `App.tsx`: `screen` moves from a read-once URL param to `useState(params.get("screen"))`; `?screen=skills` seeds the state (deep link preserved).
- Header gains a `SKILLS` button (ARCADE's pattern); hotkey `S` toggles skills ↔ main with the same guards as `A` (not while typing, not while arcade capturing).
- From the skills screen, `S` or `Esc` returns to main; `SkillsPanel` gets an explicit back affordance (button + key hint) so it stops being a dead end.
- `?screen=status` remains URL-only and dash-honest; no nav points at it.

## 5. Errors & edge cases

- Non-driver / unknown-mode `set_permission_mode` → existing `sendError` path, nothing on the wire.
- Auto-sweep touches only gates without a recorded decision (idempotent; safe against the SDK-abort race already handled in `agentDriver`).
- Driver flips DEFAULT→AUTO→PLAN rapidly mid-turn: each transition appends a `permission_mode_change`; the sweep runs only on entering `auto`; last mode wins.
- Late joiners / refresh: mode replays from the event log as today — no new snapshot state.

## 6. Testing

- **Server (vitest, baseline 94):** auto mode auto-allows a fresh `permission_request` with `auto: true` + driver attribution; entering auto sweeps pending gates exactly once; leaving auto restores gating; plan requests never auto-approve; non-driver and unknown-mode rejected; mid-turn mode change accepted.
- **Client (vitest, baseline 39):** derive handles the three-mode union and auto-marked decisions; `M` guard behavior (dead while typing / arcade capturing, cycles otherwise); screen-state toggling incl. `?screen=skills` seeding and Esc return.
- Manual demo check: flip to AUTO mid-turn while a gate is pending → gate card resolves with ⚡ AUTO; open skills via header and `S`; return via Esc.

## 7. Risks (named deliberately — from `market-research.md`)

- **AUTO competes with the headline primitive.** The product's strongest moment is approval handoff — a teammate takes the wheel solely to resolve a pending 🔐. While AUTO is on, that moment never happens. Accepted trade: AUTO is Claude Code parity and driver-scoped; mitigations (amber styling, every auto-decision visible and driver-attributed on the wire) are load-bearing.
- **Trust-boundary widening.** The security model rests on driver approval; AUTO removes the human from that loop while on, and amplifies the known Bash-allowlist containment residual (worktree-authored files steering allowlisted commands). PoC stance stays "trusted team", but the spec names it; expect the question from anyone technical.

## 8. Carried for v6b (decided in this brainstorm, not built here)

- **Interrupt rail first, fleet cards second** (amended per market research: build the interrupt system, not the stream). The v6b screen leads with pulls — pending 🔐 gates across the server and file-collision alerts, each with one-click jump-in (core loop: notice → drop in → act) — with per-project status cards (sessions, driver, busy/idle, last prompt, current tool) as the layer underneath. Scope: everyone on this server; no auth/org model yet. Naming: never "team hub".
- **Collision signal must generate pulls, not just prompts.** The `<teammates>` digest (`digest.ts`) already injects sibling intent + recent file targets into agent prompts. The v6b delta is human-facing: detect file overlap server-side and surface it as an interrupt in both sessions (and on the fleet screen). Agent-side tiering (explicit overlap warning appended to the digest on collision) is a small add on the existing digest.
- **Presence, co-op framed.** Focus-based presence (which of your sessions is hot, idle elsewhere) rendered in the PARTY visual language at session level — never a person-level activity monitor; gamified framing is the answer to the surveillance objection and is load-bearing.
- **TUI client** — future direction; protocol stays client-agnostic starting now.
- **Language:** "awareness", not "shared context"; "take the wheel" / "driver" everywhere.
