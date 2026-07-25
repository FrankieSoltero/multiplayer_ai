# v5b — Arcade: real engines + party high score

*Design spec, approved 2026-07-25. Brainstormed from the one-liner carried since v5a: "game roster + party high score."*

## 1. Scope decisions (locked in brainstorm)

| Decision | Choice | Why |
|---|---|---|
| Party high score mechanism | `game_score` server event on the append-only wire | Only honest party-wide option: survives refresh, works for late joiners via replay; fits the standing append-only + client-derivation architecture. Ephemeral broadcast would silently reset for late joiners (dash-dishonest). |
| Record granularity | Per-game | Scores across game types aren't comparable (survival time vs length vs WPM); one overall number would be meaningless. `PartyBest.game` field already anticipated this. |
| Party scope | Project-wide | "Party" means the whole team, not one room. Source of truth stays append-only session logs; the server aggregates the per-game best across sessions into the existing throttled `ProjectMessage` snapshot (the lobby pattern). Per-session records would be invisible from sibling sessions. |
| New engines | Snake + Type Race | Snake is the best ASCII-lane fit; Type Race fits the terminal identity. Breakout is the weakest fit (ball physics in character cells) and stays an honest "cartridge not inserted" slot. |
| Party XP / usage events | Stay deferred | Separate concept (agent usage metering, not games) with its own design questions. HUD `PARTY XP` keeps rendering `—`. |
| Arcade surface | Playable anytime | Expands beyond thinking-time: header `ARCADE` toggle + hotkey mounts the same strip while idle; busy behavior unchanged. |
| Client architecture | Shared `GameEngine` interface | One generic host, zero per-game branches; each engine a pure, independently-testable module (the pattern dino set). Rejected: per-game if/else branches in the strip (doubles the file, forks input handling three ways). |

## 2. Wire & server

**New session event** (append to the union in `poc/server/src/events.ts`):

```ts
| { type: "game_score"; userId: string; game: string; score: number }
```

**Client → server message:** `{ type: "game_score", game, score }`, sent when a run ends. The client only submits a score that beats that player's own local best for that game (keeps the log lean). The server stamps `userId` from the connection context — it never trusts client-supplied identity, same as every other message.

**Server gate** (in `server.ts`'s message handler, following the existing `set_model`/`prompt` validation pattern):

- `game` ∈ `{ dino, snake, typerace }`
- `score` is a positive integer ≤ 99999
- Invalid → error message back to the sender, nothing appended.
- Valid → appended to the session's log like any other event.

**Project aggregation:**

- `game_score` joins the `INTERESTING` set in `server.ts` so it triggers the existing throttled project push.
- `projectSnapshot()` (`poc/server/src/project.ts`) gains an `arcade` field: for each game, the best score across all sessions in the project plus the holder's `name`/`glyph`/`color`.
- Holder identity resolves by scanning `presence_join` events for that `userId` — NOT the live participants map — so the record survives the holder leaving.
- Late joiners get records from the snapshot on join; refreshes re-derive.

**Persistence:** in-memory, same as the rest of the POC. Server restart resets records. No new storage.

## 3. Client: engine contract + generic host

**Engine contract** — new `poc/client/src/game/engine.ts`:

```ts
export interface GameEngine<S = unknown> {
  key: string;            // "dino" | "snake" | "typerace"
  label: string;          // roster button text
  rows: number;           // lane height in text rows (dino 2, snake 5, typerace 3)
  init(seed: number): S;
  tick(s: S, dt: number): S;
  input(s: S, key: string): S;   // engine decides what keys mean; unknown keys = no-op
  render(s: S): string[];        // exactly `rows` strings, each LANE_WIDTH cols
  score(s: S): number;
  over(s: S): boolean;           // run finished (death or completion)
  hint(s: S, playing: boolean): string;  // context line for the roster row
}
```

Each game is one pure module with no DOM:

- `game/dino.ts` — adapted: keeps its existing exported functions and tests, plus an `engine` export whose `input` maps Space/click → `jump`.
- `game/snake.ts` — new. 5×40 grid; arrows/WASD steer; snake advances at 8 cells/s, +0.5 cells/s per food eaten (cap 16); `●` food, `█` body. Run ends on wall or self collision; score = food eaten × 10.
- `game/typerace.ts` — new. 3 rows: target phrase / progress / status. Seeded pick from a hardcoded list of terminal-flavored phrases. Printable keys advance on match; wrong keys count as misses. Run ends when the phrase completes; score = `max(1, round(WPM) − 2 × misses)` where WPM = (chars typed / 5) / minutes elapsed. Uses the same window-keydown path as the other games — no actual `<input>`, so the focus guard stays intact.

**Host** — `ThinkingStrip.tsx` rewritten as a generic host, zero per-game branches:

- Registry `ENGINES: GameEngine[]` replaces the `GAMES` list; Breakout stays a `ready: false` roster stub rendering "cartridge not inserted".
- One rAF loop (`engine.tick`), one keyboard path (`engine.input`, keeping the guard: keys ignored while INPUT/SELECT/TEXTAREA is focused), one render path drawing `engine.render(state)` into the `<pre>` lane sized by `engine.rows`.
- Start/restart stays HOST-owned, as today: the first Space (or lane click) starts a run, and after `over()` it re-inits; engines only see inputs while a run is live. Engines never manage "playing" state.
- One score-submit path: when `over(s)` flips true, if the score beats the per-game localStorage best (`mpai-<game>-high`; existing `mpai-dino-high` kept for dino), save it and call `props.onScore(game, score)` — App wires that to `send({ type: "game_score", … })`.
- `G` still cycles the roster; roster buttons still select directly.

## 4. Idle access & party-best display

**Playable anytime:**

- `SessionView` (`App.tsx`) gets `arcadeOpen` state. The strip mounts when `derived.agentBusy || arcadeOpen`. Busy behavior unchanged (auto-appear, 600ms leave animation).
- Entry: `ARCADE` button in the header bar (next to the PLAN toggle) + `A` hotkey when no input is focused. Exit: the button again, or `Esc` while idle-mounted.
- Hotkey collision is safe: `A` only opens when the strip is closed; once open, snake's WASD gets the key.
- Honest header line: busy → today's `✦ {MODEL} IS THINKING… NNs` exactly as is; idle-open → `▪ ARCADE — INSERT COIN`, no timer. If the agent goes busy mid-play, the line switches live and the strip stops being closable until the turn ends (busy owns the mount).

**Party-best plumbing:**

- `useSessionSocket` captures the `arcade` field from project messages alongside `projectSessions`; `types.ts` mirrors it.
- `ThinkingStrip` prop changes from `partyBest?: PartyBest` to `partyBests?: Record<string, PartyBest>`; the host looks up the currently-selected game.
- Header slot per game: `PARTY BEST 0042 ◆ ana` when a record exists, else `YOUR BEST nnnn` from localStorage (existing render shape unchanged).

## 5. Testing

Baselines grow from server 90 / client 22. New coverage:

- **Client:** engine unit tests for snake (movement, collision, growth/speed, scoring) and typerace (match/miss, completion, WPM scoring) — pure-function style, like dino's; host-level test that `over()` + beat-local-best triggers exactly one `onScore`.
- **Server:** gate tests (bad game key; non-integer / negative / oversized score rejected; valid appended with stamped `userId`); `projectSnapshot` arcade aggregation tests (best-across-sessions; holder identity survives `presence_leave`).

## 6. Error handling

- Invalid submissions reuse the existing error-message path (`⚠` line in the client).
- Malformed `game_score` events encountered during aggregation are skipped, never crash the snapshot.

## 7. Out of scope (explicit)

- Breakout engine (roster slot stays honest-empty).
- Party XP / usage events — HUD `PARTY XP` keeps rendering `—` (earmarked separately).
- Any scoreboard surface outside the strip.
- Persistence across server restarts.
- Anti-cheat beyond the range gate.

## 8. Constraints honored

- Append-only wire + client derivation; server = relay + gate; no fake affordances.
- New CSS animations go above the reduced-motion kill list or into the trailing override block (`terminal.css` end-of-file rule).
- Never edit `poc/server` while a live demo runs (tsx watch hot-reload kills turns).
- Accessibility floor stands: reduced-motion killswitch, `--dim` ≥ 5.72:1, `:focus-visible`.
