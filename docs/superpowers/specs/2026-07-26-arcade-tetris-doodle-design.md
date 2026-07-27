# Arcade — Tetris and Doodle Jump — Design

*Status: approved 2026-07-26. Branch `feature/arcade-tetris-doodle`, based on `feature/invite-system` (stack tip). Supersedes the Type Race cartridge.*

## 1. Problem

The arcade ships three playable cartridges (`dino`, `snake`, `typerace`) and one empty slot (`breakout`, which renders "cartridge not inserted"). Type Race is the weakest of the three: it consumes printable letters, so it is the only engine that must set `capturesText` and suppress the `G`-swaps-cartridge hotkey mid-run, and a typing test is a poor fit for a thing you play while an agent thinks.

Replace Type Race with Tetris, and fill the empty fourth slot with Doodle Jump. Both are arrow-driven, so both leave `G` free, and the roster reaches four real engines for the first time.

## 2. Goals and non-goals

**Goals**

- Two new pure `GameEngine` modules, `tetris` and `doodlejump`, that satisfy the existing contract in `poc/client/src/game/engine.ts` with no changes to that contract and no changes to the `ThinkingStrip` host.
- A four-slot roster where every slot has an engine: DINO RUN · SNAKE · TETRIS · DOODLE JUMP.
- Both games score into the existing party-best pipeline (`game_score` → `arcadeRecords` → snapshot `arcade`) with no new wire shapes.
- The server's game allowlist and its error message stop being able to drift apart.

**Non-goals**

- No canvas, no DOM, no React inside an engine. Every engine is a pure text module returning `rows` strings of `LANE_WIDTH` chars. This is the standing architecture rule and it does not bend for these two.
- No arcade screen. The dead `.carts` / `.lane.big` CSS stays dead; this work does not build the screen it was written for.
- No per-cell color. The lane is one `<pre>` with a single color; piece identity is carried by glyph, not hue.
- No ghost piece, hold queue, T-spin scoring, wall kicks beyond a simple in-bounds check, or Doodle Jump enemies/power-ups. YAGNI.
- No migration of existing `typerace` score history. See §7.

## 3. Decisions and rationale (for review)

All four were put to the user as blocking questions before any code was written; three came back with the recommendation, one against it.

**3.1 Tall lane per game, not a rotated playfield and not a new screen.** Tetris at ~20×10 and Doodle Jump's vertical climb do not fit the slim strip (dino 2 rows, snake 5, typerace 3). Three options were offered: rotate the playfields 90° to preserve the slim footprint, let engines declare a taller `rows`, or build a dedicated full-height ARCADE screen. Chosen: **taller `rows`**. The `rows` field is already per-engine, so the contract and the host need no change at all — the strip simply grows when one of these cartridges is selected. Rotation was rejected as reading like a novelty with unintuitive controls; the dedicated screen was rejected as far more scope (new screen, split roster, routing) than two engines justify.

*Accepted cost:* selecting Tetris or Doodle Jump grows the strip by ~18 rows, pushing the transcript up, including while the agent is thinking. That is the point of the trade and it is not a defect.

**3.2 Four slots, Type Race out.** Roster becomes DINO · SNAKE · TETRIS · DOODLE JUMP. Tetris takes Type Race's slot; Doodle Jump takes the empty `breakout` slot. Staying at four keeps the existing `.carts { repeat(4, 1fr) }` correct and retires the "cartridge not inserted" state from the shipped roster.

**3.3 `typerace` removed entirely, not unlisted.** The alternative — drop it from the client roster but keep the id in `ARCADE_GAMES` so old records stay valid — was offered and declined. See §7 for exactly what that orphans.

**3.4 Seed determinism relaxed for these two engines.** Every existing engine is a pure `tick(s, dt)` seeded by the LCG at `engine.ts:5`, and every existing engine test asserts that the same seed reproduces the same run. The user chose to let these two use `Math.random()` instead, dropping the seed-determinism assertion for them only. Both engines keep the `init(seed)` signature for contract conformance and ignore the argument.

*Consequence, recorded deliberately:* the arcade's engines are no longer uniformly deterministic. §8 explains how these two stay testable without it.

**3.5 Tripwire — `Math.random()` inside `tick` is only safe because there is no StrictMode.** `ThinkingStrip.tsx:132` calls `setState((s) => engine.tick(s, dt))`, and `:186` calls `setState((s) => engine.input(s, e.key))` — React state updaters. `poc/client/src/main.tsx` deliberately omits `<StrictMode>` ("double-mounted effects would double-join the shared ws session"), so updaters are invoked exactly once. **If StrictMode is ever added, these two engines will misbehave in dev** (double-invoked updaters would consume two random draws per input) while every other engine, being seed-pure, would not. Whoever adds StrictMode must give these engines an injected RNG seam first.

## 4. The contract (unchanged, quoted for the implementer)

From `poc/client/src/game/engine.ts:7-25` — a new game implements `key`, `label`, `rows`, optional `capturesText`, `init(seed)`, `tick(s, dt)`, `input(s, key)`, `render(s)`, `score(s)`, `over(s)`, `hint(s, playing)`.

Host behavior the engines depend on, all in `ThinkingStrip.tsx`:

- RAF loop with `dt` clamped to 0.05s (`:129-137`) — an engine must tolerate a 50ms step and must not assume a fixed frame rate.
- SPACE starts a run when not playing (`:179-183`); while playing, SPACE is forwarded to `input` like any other key.
- Raw `e.key` is forwarded (`:186`); unknown keys must be a no-op.
- Lane click sends the synthetic `"click"` (`:226`), and starts a run if one is not live.
- `render(s)` must return **exactly `rows` strings, each exactly `LANE_WIDTH` (40) chars.**
- `capturing` is set automatically for any engine-bearing slot while playing (`:94-99`), which suppresses the S/W/O/I/M screen hotkeys and the transcript's a/d permission keys. Neither new engine needs wiring for this.
- `capturesText` is only about whether the host steals `G` to swap cartridges mid-run. Both new engines are arrow-driven, so both leave it unset and `G` keeps working during play, matching dino and snake.
- **Shift+Tab must never be captured** (v6a accessibility ruling, `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md:12`). Neither engine binds it.

## 5. Tetris

`poc/client/src/game/tetris.ts` — `key: "tetris"`, `label: "TETRIS"`, `rows: 20`, `capturesText` unset.

**Geometry.** Terminal cells are roughly twice as tall as wide, which `snake.ts` already compensates for with `V_ASPECT = 2`. Tetris compensates spatially instead: each well cell renders as **two characters wide**, so a standard 10-cell well occupies 20 chars. With one border char on each side that is 22, leaving 18 chars of right margin for the HUD. Rows are 1 top border + 18 playfield + 1 bottom border = 20.

```
        ┌────────────────────┐                  <- row 0
        │                    │  NEXT            <- rows 1..18
        │        ▓▓▓▓        │   ██             (18 playfield rows,
        │                    │   ████            10 cells × 2 chars)
        │  ██                │
        │  ████  ██████      │  LINES  4
        │████████████████    │  LEVEL  2
        └────────────────────┘                  <- row 19
```

Locked cells render `██`; the active falling piece renders `▓▓` so it stays legible against the stack under a single lane color. Empty cells render two spaces.

**Controls.** Arrows only, plus SPACE and click:

| Key | Action |
|---|---|
| `ArrowLeft` / `ArrowRight` | move one cell, blocked at walls and against locked cells |
| `ArrowUp` | rotate clockwise; rejected if the rotated cells would leave the well or overlap the stack (no wall kicks) |
| `ArrowDown` | soft drop one cell |
| `" "` | hard drop — fall to rest and lock immediately |
| `"click"` | rotate clockwise (same as `ArrowUp`) |

Everything else is a no-op.

**Gravity and locking.** `tick` accumulates `dt` into a drop accumulator and steps the piece down once per interval. The interval shortens with level. When gravity fails — the piece cannot move down — the piece locks **immediately**, with no lock delay. This matches the retro feel of the other cartridges and keeps the state machine small enough to test exhaustively.

**Pieces.** The seven standard tetrominoes, selected by a 7-bag shuffle: fill a bag with all seven, shuffle it with `Math.random()`, deal until empty, refill. Guarantees no long droughts without tracking history.

**Lines and scoring.** After a lock, full rows are cleared and the stack above collapses down. Score uses the classic NES table — 40 / 100 / 300 / 1200 for 1 / 2 / 3 / 4 lines — multiplied by `(level + 1)`, where `level = floor(lines / 10)`. `score(s)` clamps its return to **99999**, the server's `MAX_GAME_SCORE`; without the clamp a long run could produce a score the server rejects outright, turning a personal best into an error toast.

**Game over.** `over(s)` is true when a freshly spawned piece overlaps the existing stack.

**Hint line.** Playing: `← → MOVE · ↑ ROTATE · ↓ SOFT · SPACE DROP`. Not playing: `SPACE to play`, to which the host appends ` · G swaps game`.

## 6. Doodle Jump

`poc/client/src/game/doodle.ts` — `key: "doodlejump"`, `label: "DOODLE JUMP"`, `rows: 20`, `capturesText` unset. Uses the full 40-char width; no border chrome.

**Movement.** Auto-bounce, as in the original — there is no jump key. The player carries a vertical velocity under constant gravity, and receives a fixed upward impulse when it contacts a platform **while falling** (a rising player passes through, which is what makes the game work). Horizontal movement is `ArrowLeft` / `ArrowRight` only, wrapping at the screen edges, at roughly twice the vertical rate in cells/sec — the same 2:1 aspect compensation `snake.ts` applies, here as a speed multiplier rather than a step-timing one.

**Camera and generation.** The world scrolls when the player rises above the upper third of the view; below that the view is static. New platforms are generated above the visible region as the camera climbs, with horizontal position and spacing drawn from `Math.random()` within bounds that keep the next platform reachable from the bounce impulse. Platforms below the view are discarded.

**Score and death.** `score(s)` is the maximum altitude reached, in rows, and never decreases. `over(s)` is true once the player falls below the bottom of the view.

**Glyphs.** Player `@`, platform `▔▔▔▔▔`, empty space blank.

**Hint line.** Playing: `← → MOVE · BOUNCE IS AUTOMATIC`. Not playing: `SPACE to play`.

**Height parity.** Both new engines declare `rows: 20` so swapping between them does not resize the strip. Only the dino/snake ↔ tetris/doodlejump transitions change the strip's height.

## 7. Registry changes, and what removing `typerace` orphans

There are **two hand-maintained registries, neither derived from the other**, and both must be edited:

1. **Client roster** — `ThinkingStrip.tsx:17-22` becomes DINO RUN · SNAKE · TETRIS · DOODLE JUMP, all four carrying engines. The `typeRaceEngine` import goes.
2. **Server allowlist** — `events.ts:11` becomes `["dino", "snake", "tetris", "doodlejump"]`.

Additionally, **`server.ts:716` hardcodes the game list inside its error string** (`"game_score requires game: dino|snake|typerace"`) rather than reading `ARCADE_GAMES`. This change is exactly the one that would make it lie. It becomes `` `game_score requires game: ${ARCADE_GAMES.join("|")}` ``.

`poc/client/src/game/typerace.ts` and `typerace.test.ts` are deleted. Any server wire test asserting on `game: "typerace"` is retargeted to a surviving id.

`.carts { grid-template-columns: repeat(4, 1fr) }` (`terminal.css:434-443`) is already correct for a four-slot roster and is not touched.

The engine-less fallback branch in `ThinkingStrip.tsx:231-235` is **kept** even though the shipped roster no longer reaches it. `engine?` being optional is the documented way to add a slot before its engine exists, and deleting the fallback would remove that affordance.

**What the removal orphans.** Scores are keyed by the game id string end to end: `game_score` events carry it, `arcadeRecords` (`project.ts:51-79`) aggregates best-per-game under it, and the client reads `partyBests[game]`. Deleting the id does not delete anything already recorded. Existing `typerace` `game_score` events remain in the append-only log and continue to aggregate into an `arcade` snapshot entry that no roster slot renders — orphaned, not removed. A replayed historical log now also carries an id the allowlist rejects at the validation boundary. Local personal bests under `localStorage["mpai-typerace-high"]` are likewise stranded. This was offered as the explicit cost of removing rather than unlisting and was accepted.

## 8. Testing

Two new suites, `tetris.test.ts` and `doodle.test.ts`, co-located in `poc/client/src/game/` per house convention.

**The two invariants every engine suite already asserts, asserted here too:**

- `render(s)` returns exactly `engine.rows` strings.
- Every returned row is exactly `LANE_WIDTH` (40) characters. Asserted on a fresh state, mid-run, and at game over — the states where padding bugs hide.

**Tetris behavior:** a piece spawns at the top; left/right clamp at the walls and against locked cells; rotation is rejected rather than clipped when it would leave the well or overlap the stack; gravity steps down once per interval and locks immediately when blocked; a filled row clears and the stack above collapses; the score table applies the level multiplier; `score()` clamps at 99999; `over()` becomes true when a spawn collides.

**Doodle Jump behavior:** gravity accelerates the player downward; a bounce fires when descending onto a platform and does **not** fire when ascending through one; horizontal movement wraps at both edges; `score()` is monotonic across a descent; `over()` becomes true after falling below the view.

**How these stay testable without seed determinism (§3.4).** Both modules export their state types and a constructor for a specific state, the way `snake.ts` exports `initialState`. Tests build the exact board or platform layout they need and drive `tick`/`input` directly, so no test depends on a random draw. Randomness only decides *which* tetromino spawns and *where* the next platform lands; every assertion is written to be piece-agnostic and layout-agnostic.

**Verification gate — driving the real UI is required, not optional.** `ThinkingStrip.tsx` has no test coverage at all: roster, cartridge swap, keyboard, capture flag, RAF loop, and localStorage are all untested. That gap is precisely what caused the recorded swap crash in `docs/mistakes-and-fixes.md:9-14`, whose lesson is that passing pure tests plus a clean build cannot catch it. This change makes the risky path much larger — a 2-row cartridge swapping to a 20-row one — so acceptance requires playing both new games and swapping through all four cartridges in a real browser before the work is called done.

## 9. Out of scope for v1 (candidates for later)

- The dedicated ARCADE screen the `.carts` / `.lane.big` CSS was written for.
- Ghost piece, hold queue, wall kicks, T-spin scoring, back-to-back bonuses.
- Doodle Jump enemies, springs, breakable platforms, or a jetpack.
- Per-piece color (needs the lane to stop being a single-color `<pre>`).
- Any migration or backfill of orphaned `typerace` records.
- Restoring seed determinism to these two engines via an injected RNG seam — required only if StrictMode is ever adopted (§3.5).
