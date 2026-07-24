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

## Run the v3 full-capabilities demo

Setup is the same as v2 (demo-setup.sh, `AGENT_WORKDIR_ROOT`, two tabs), except
the server start line for v3 is:

`cd poc/server && AGENT_WORKDIR_ROOT=$(pwd)/../demo-worktrees AGENT_SKILLS=auth-migration-guide npm run dev`

New in v3:

- Agents have the full Claude Code tool set (Bash, subagents, web tools,
  project skills). Test/type-check/read-only-git commands run without asking;
  any other Bash command (or Task/WebSearch/WebFetch/...) shows a 🔐 approval
  card. Only the current driver can Approve/Deny — and taking the wheel lets a
  teammate decide a pending request (drop in just to approve something).
- The demo repo ships a project skill (`.claude/skills/auth-migration-guide/`);
  ask the ana agent to "migrate auth to JWT" and it should consult the skill.
  Skills default to none, for isolation from the host CLI's own built-in
  skills; `AGENT_SKILLS` names the comma-separated project skills to expose
  for the demo, and agents can also read `.claude/skills/*/SKILL.md` directly.

## Tests

`cd poc/server && npm test`
