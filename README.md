# Multiplayer AI — Research + PoC

Exploration of YC's Fall 2026 "Multiplayer AI" RFS: shared live agent sessions
for dev teams. See `docs/research-report.md` for the research and
`docs/superpowers/specs/` for the design.

## Run the PoC

1. `cd poc/server && cp .env.example .env` and set `ANTHROPIC_API_KEY`
   (or rely on an active `claude` / `ant auth login` credential).
2. `cd poc/server && npm install && npm run dev` — server on ws://localhost:3001
3. `cd poc/client && npm install && npm run dev` — UI on http://localhost:5173
4. Open http://localhost:5173 in **two tabs**. Each tab first hits the
   **lobby**: pick a name (a glyph + color are auto-assigned, both editable)
   and join. Appending `?name=...` to the URL bypasses the lobby and joins
   directly — handy for demo scripts. Tab A is driving; prompt the agent, and
   optionally switch its model via the header picker (only the current
   driver can). Tab B watches the same stream live, clicks "Take the wheel",
   and redirects the agent mid-task.

## Run the v2 multi-session demo

1. `poc/scripts/demo-setup.sh` — creates a demo repo + `ana`/`ben` worktrees.
2. `cd poc/server && AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees npm run dev`
3. `cd poc/client && npm run dev`
4. Tab A: http://localhost:5173/?project=demo&session=ana — prompt: an auth→JWT
   migration task. The agent declares its intent (✦) and it appears in Tab B's
   PARTY pane.
5. Tab B: http://localhost:5173/?project=demo&session=ben — prompt: a
   rate-limiting task *without mentioning Ana*. Ben's agent should acknowledge
   Ana's in-flight migration via the injected `<teammates>` digest.

## Run the v3 full-capabilities demo

Setup is the same as v2 (demo-setup.sh, `AGENT_WORKDIR_ROOT`, two tabs), except
the server start line for v3 is:

`cd poc/server && AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees AGENT_PLUGINS_ROOT=$(pwd)/../demo-plugins npm run dev`

New in v3:

- Agents have the full Claude Code tool set (Bash, subagents, web tools,
  project skills). Test/type-check/read-only-git commands run without asking;
  any other Bash command (or Task/WebSearch/WebFetch/...) shows a 🔐 approval
  card. Only the current driver can Approve/Deny — and taking the wheel lets a
  teammate decide a pending request (drop in just to approve something).
- The demo repo ships a project skill (`.claude/skills/auth-migration-guide/`);
  ask the ana agent to "migrate auth to JWT" and it should consult the skill.
  As of v6c, skills plugins are imported per-project from the skills screen
  by git URL (`AGENT_PLUGINS_ROOT` sets where clones land); every session
  started after an import runs with Claude Code's built-in skills
  (`skills: "all"`) plus that project's imported plugin skills.

### Residual risk (PoC scope)

The Bash auto-approve allowlist (`npm test`, `npx vitest`, `npx tsc`, `git
status`/`diff`/`log`) runs commands whose *behavior* an agent can still
steer via config or scripts it authored in its own worktree — e.g. a
`package.json` test script, `vitest.config`, `tsc --outDir`/`-p`, or a `git
--output` argument — none of which the containment check inspects. So a
worktree-authored file plus an allowlisted command can reach outside the
worktree with no driver approval in the loop. OS-level sandboxing
(containers, restricted filesystem permissions, etc.) is explicitly out of
scope for this PoC per the spec; this is the residual boundary until that
lands.

## Run the v4 design pass

Setup is the same as above. New in v4:

- The client UI is a faithful terminal shell (monospace, box-drawing frames,
  `⏺`/`⎿`/`✦`/`🛞`/`🔐` glyphs) instead of a plain dark web app.
- Joining goes through a **lobby**: pick a name, glyph, and color before
  entering a session (`?name=...` in the URL bypasses it).
- The **PARTY pane** replaces the old teammates sidebar, showing the session
  roster with each participant's glyph/color and current quest line.
- Agent intents render as a `✦` objective quest-log entry in the transcript.
- Each session's driver can pick the agent's model (opus/sonnet/haiku) from a
  header select; switches apply between turns and are logged as a visible
  `model_change` event.
- While the agent is working, the thinking strip shows a small playable dino
  mini-game in place of a static spinner.

## Tests

`cd poc/server && npm test`
