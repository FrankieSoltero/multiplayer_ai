# Multiplayer AI — Research + PoC

Exploration of YC's Fall 2026 "Multiplayer AI" RFS: shared live agent sessions
for dev teams. See `docs/research-report.md` for the research and
`docs/superpowers/specs/` for the design.

## Run the PoC

1. `cd poc/server && cp .env.example .env` and set `ANTHROPIC_API_KEY`
   (or rely on an active `claude` / `ant auth login` credential).
2. `cd poc/server && npm install && npm run dev` — server on ws://localhost:3001
3. `cd poc/client && npm install && npm run dev` — UI on http://localhost:5173
4. Open http://localhost:5173 in **two tabs**. Tab A is driving; prompt the
   agent. Tab B watches the same stream live, clicks "Take the wheel", and
   redirects the agent mid-task.

## Run the v2 multi-session demo

1. `poc/scripts/demo-setup.sh` — creates a demo repo + `ana`/`ben` worktrees.
2. `cd poc/server && AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees npm run dev`
3. `cd poc/client && npm run dev`
4. Tab A: http://localhost:5173/?project=demo&session=ana — prompt: an auth→JWT
   migration task. The agent declares its intent (🎯) and it appears in Tab B's
   teammates sidebar.
5. Tab B: http://localhost:5173/?project=demo&session=ben — prompt: a
   rate-limiting task *without mentioning Ana*. Ben's agent should acknowledge
   Ana's in-flight migration via the injected `<teammates>` digest.

## Tests

`cd poc/server && npm test`
