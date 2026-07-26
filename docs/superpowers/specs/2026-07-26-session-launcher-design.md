# Session Initiation + Launch-Anywhere CLI — Design Spec

**Date:** 2026-07-26 · **Status:** approved by user (verbal, this session) · **Sub-projects B+C merged into one spec** (C automates what B parameterizes; both share one provisioning core).

## §1 Goal

Anyone can start the multiplayer stack in any git repo with one command, and anyone in the browser can create or join a session without touching a terminal. A session's agent always gets its own auto-provisioned git worktree, preserving the existing containment model.

Locked decisions (user-approved 2026-07-26):
- Creation happens from **both** surfaces from day one: in-app UI and CLI. Both call the same server-side provisioning core.
- Every session's workdir is an **auto-provisioned git worktree** off the launched repo — no repo-dir sessions, no arbitrary paths.
- CLI is **one command, one port**: server serves the built client statically over the same HTTP server the WS uses.
- No-param entry shows a **minimal session picker** (deliberately NOT the v6b fleet dashboard).
- NEW SESSION asks for **name + base branch** (base-ref field pre-filled with the repo's default branch).

## §2 Server core: WorkspaceManager (`poc/server/src/workspace.ts`, new)

One class owns worktree provisioning; nothing else shells out to git for it.

- Constructor: `new WorkspaceManager(repoRoot: string, worktreesRoot: string)`. Both absolute paths. A server launched without a repo (current dev/demo mode) has **no** WorkspaceManager — provisioning is unavailable and `create_session` errors ("server not launched in a repo").
- `provision(slug: string, baseRef: string): { ok: true; workdir: string } | { ok: false; error: string }`
  - Slug already validated by the caller (same `SLUG` rule as session ids: 1–40 chars of `a-z0-9-`).
  - If `<worktreesRoot>/<slug>` exists: return `{ ok: true, workdir }` (idempotent — join semantics; no ref check, the worktree's existing state wins).
  - Validate `baseRef` with `git rev-parse --verify --quiet <baseRef>^{commit}` in `repoRoot`; unknown ref → `{ ok: false, error: "unknown base ref: <ref>" }`.
  - If branch `mpai/<slug>` already exists (without its worktree dir): `{ ok: false, error: "session name taken (branch mpai/<slug> exists)" }`.
  - Else `git worktree add <worktreesRoot>/<slug> -b mpai/<slug> <baseRef>`; git failure → `{ ok: false, error }` with git's stderr, truncated to 300 chars.
- `defaultBranch(): string` — `git symbolic-ref --short HEAD` in `repoRoot` (fallback `"main"` on detached HEAD or error).
- One child process per git operation (`execFile` with argv, no shell — slug/ref are passed as arguments, never string-interpolated into a command).
- Provisioning is **server-side and trusted**. The agent never drives it. `isContainedWrite` and the "your own worktree" system prompt are untouched.

## §3 Wire: `create_session` + project snapshot

- New WS command `{ type: "watch_project", projectId }` (valid before `join`): adds the socket to the project's push list and sends an immediate snapshot. (Planning finding: the existing `peek` is one-shot and only joined sockets receive pushes — the picker needs a live non-joined watcher.) Removed from the push list on socket close.
- New project-channel WS command: `{ type: "create_session", name: string, baseRef?: string }` (also valid before `join`; `projectId` optional, defaulting to `default`).
  - `name` is slugified server-side: lowercase, spaces→`-`, strip anything outside `[a-z0-9-]`, collapse dashes, trim to 40. Empty after slugify → error `"create_session requires a usable name"`.
  - `baseRef` defaults to `defaultBranch()`. Length-capped at 100 chars.
  - Flow: slugify → `workspace.provision(slug, baseRef)` → on ok, `getOrCreateSession(project, slug)` with the provisioned workdir → `pushProject`. On error: `{ type: "error", message }` to the **creator only**; no session created.
  - Ack to creator: `{ type: "session_created", sessionId: slug }` (so the picker can auto-join without racing the project push).
  - A `create_session` for an id whose session already exists in memory is not an error — it acks with the existing id (matches provision idempotence).
- Deep-link joins provision through the same core: when `getOrCreateSession` must create a session and a WorkspaceManager exists, it provisions `(sessionId, defaultBranch())` and uses the resulting workdir; provisioning failure on the join path surfaces as a join error. When no WorkspaceManager exists, current behavior is unchanged (`AGENT_WORKDIR_ROOT/<sessionId>` if set, else driver default) — existing demo stacks keep working.
- `projectSnapshot` (project.ts) gains one top-level field: `repo: { defaultBranch: string } | null` (null when no WorkspaceManager). Per-session fields already carried (`id`, `participants`, `driverName`, `intent`, `lastActivityTs`, `ended`) are sufficient for the picker — no per-session additions.
- Session-level wire events unchanged. Creation is project-level state; append-only session discipline is not in play.

## §4 Client: SessionPicker (`poc/client/src/components/SessionPicker.tsx`, new)

- With no `?session=` param, App renders the picker instead of defaulting to `"demo"`. Deep links (`?session=X`) bypass it entirely and keep exact current behavior. `?project=` still defaults to `"default"`.
- The picker connects on the existing project watcher channel and renders from `project` pushes:
  - Session rows: name, participant names, agent state (from `ended`), intent one-liner, sorted by `lastActivityTs` desc. JOIN navigates to `?session=<id>` (full navigation, existing join flow + Lobby unchanged).
  - Empty state when no sessions exist.
- NEW SESSION: name text input + base-ref text input pre-filled from `repo.defaultBranch`; disabled with a hint when `repo` is null ("launch via the CLI to create sessions"). Submit sends `create_session`; on `session_created`, navigate to `?session=<id>`. Server errors render inline; the form never optimistically navigates.
- CRT idiom (existing panel/pix/btn classes), keyboard accessible (inputs and buttons in tab order, Enter submits). Display logic that needs tests (row formatting, sorting, slug preview) lives in pure functions (`sessionRow.ts` or equivalent — recorded no-component-test pattern).

## §5 CLI: `mpai` (bin in the `poc/server` package)

- `mpai` (default subcommand = launch), run from any directory:
  1. Resolve the git repo: `git rev-parse --show-toplevel` from cwd; not a repo → exit 1 with a clear message.
  2. Ensure `<repo>/.mpai/worktrees/` exists and `.mpai/` is in the repo's `.git/info/exclude` (no user-visible .gitignore edits).
  3. Start the server with `WorkspaceManager(repo, <repo>/.mpai/worktrees)`, single port (default 3001, `--port` to override; in-use → exit 1 with hint).
  4. Serve the built client statically on the same HTTP server the WS uses (tiny hand-rolled handler: `/` + asset paths from the client `dist/`, `index.html` fallback for path-less requests; no new framework dependency). The dist path resolves relative to the CLI's own install location, not cwd.
  5. Print the URL and open the browser (`--no-open` to skip; open via platform opener, failure to open is non-fatal).
- `mpai new <name> [--base <ref>] [--port <p>] [--project <id>]`: connects as a project watcher (project `default` unless `--project`) to the already-running server on localhost, sends `create_session`, prints the join URL on `session_created`, exits 1 with the server's error message otherwise. No running server → exit 1: "no server on port <p> — run `mpai` first".
- `AGENT_WORKDIR_ROOT` / `AGENT_PLUGINS_ROOT` envs keep working for non-CLI launches (dev/demo stacks unchanged).
- Packaging/publishing to npm is out of scope; v1 is run from a checkout (`npm link` / direct bin path).

## §6 Errors (summary of creator-facing failures)

| Failure | Surface | Message shape |
|---|---|---|
| Not a git repo (CLI launch) | CLI exit 1 | "not a git repository: <cwd>" |
| Port in use | CLI exit 1 | "port <p> in use — try --port" |
| No repo (UI create on env-launched server) | picker hint + server error | "server not launched in a repo" |
| Unusable name | inline in form | "create_session requires a usable name" |
| Unknown base ref | inline in form | "unknown base ref: <ref>" |
| Branch collision | inline in form | "session name taken (branch mpai/<slug> exists)" |
| git worktree failure | inline in form | git stderr, ≤300 chars |
| `mpai new` with no server | CLI exit 1 | "no server on port <p> — run `mpai` first" |

No session is created on any failure path; the wire never sees a half-provisioned session.

## §7 Testing

- **WorkspaceManager:** integration tests against a real temp git repo fixture (init, commit, then: provision happy path; idempotent re-provision; unknown ref; branch collision; defaultBranch on normal + detached HEAD). Real `git`, temp dirs, cleaned up.
- **create_session handler:** server.test.ts with an injected fake WorkspaceManager (ok / error paths): ack shape, error-to-creator-only, no session on failure, slugify rules, existing-session ack, no-workspace error.
- **Deep-link provisioning:** getOrCreateSession provisions via the fake when present; env-root behavior unchanged when absent.
- **Client:** pure-function tests for picker row formatting/sorting and the client-side slug preview. No component tests (recorded pattern).
- **CLI:** unit tests for arg parsing and URL construction; launch path + static serving verified manually at the demo checkpoint (subagent sandboxes can't launch the SDK binary — recorded constraint).

## §8 Out of scope (deliberate)

v6b fleet cards / interrupt rail; worktree deletion or GC UI; initial-prompt-on-create; npm publishing and auto-update (deployment spec territory); auth/multi-tenant; remote (non-localhost) hardening; base-ref dropdown populated from `git branch` (typed ref only in v1).
