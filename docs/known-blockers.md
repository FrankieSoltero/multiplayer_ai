# Known Blockers

Things that must be fixed before a specific milestone, with enough detail that
whoever picks one up does not have to re-derive it. Closed items stay, marked
CLOSED, so the reasoning survives.

---

## OPEN — Session workspace provisioning is missing in production

**Blocks:** A1b (deployment). **Nothing else.** This is a code change, needs no
box, domain, or API key, and can land at any time. Doing it before deploy day
is free and shortens it.

**Severity:** the agent would write into the running deployment's own source tree.

### Symptom

A session started against a production server has no git worktree. Depending on
the environment, the agent either points at a directory that does not exist or —
worse — at the deployment's own checkout.

### Evidence

- `poc/server/src/main.ts` calls `startServer(...)` and **never passes
  `workspace`**. (Contrast `poc/server/src/cli.ts:120`, which passes
  `workspace: new WorkspaceManager(repoRoot, worktreesRoot)` — the local CLI has
  always done this correctly.)
- With no `workspace`, `poc/server/src/server.ts:174-175` computes each session's
  workdir as `path.join(AGENT_WORKDIR_ROOT, sessionId)`, and **nothing in the
  codebase ever creates that directory**: `mkdir` appears only in `workspace.ts`,
  `cli.ts` and `pluginStore.ts`, none of which run on this path.
- If `AGENT_WORKDIR_ROOT` is unset, `poc/server/src/agentDriver.ts:133` falls
  back to `process.cwd()`. Under `deploy/multiplayer-ai.service` that is
  `/opt/multiplayer-ai/poc/server` — the live install.

### The fix, in shape

Mirror `cli.ts`: build a `WorkspaceManager` in `main.ts` from the environment and
pass it to `startServer`. Then extend `validateProductionConfig`
(`poc/server/src/config.ts:12`) so production — signalled by `CLIENT_DIST`, and
by nothing else — **refuses to boot** without a valid repo root, the same way it
already refuses to boot without `GITHUB_CLIENT_ID`. The fail-fast is the point:
it converts a silent misconfiguration into a startup error naming the variable.

### Do NOT do this

Do not pre-create an empty `AGENT_WORKDIR_ROOT` directory to make the error go
away. An empty non-git folder makes the failure **silent instead of loud** — the
agent operates in an empty directory and appears to work while doing nothing
useful. Failing loudly was a deliberate choice, not an oversight.

### Acceptance

- `startServer` receives a real `workspace` in the production path.
- Booting with `CLIENT_DIST` set and no valid repo root exits 1 with a
  `config error:` line naming the missing variable.
- A session created against a production-mode server provisions a real git
  worktree on its own branch, and the agent's workdir is inside it.
- A test in `poc/server/test/config.test.ts` covers the new fatal case, written
  so it fails if the production condition is loosened — the pattern the §4.4
  auth test already uses.

### Also recorded in

`deploy/RUNBOOK.md` §0 (operator-facing, with both failure modes) and its §8
pre-flight checklist; `HANDOFF.md` §0; the A1a deployment spec §9.
