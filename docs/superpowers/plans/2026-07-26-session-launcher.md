# Session Initiation + Launch-Anywhere CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command launches the stack in any git repo; anyone in the browser (or via `mpai new`) creates a session that gets its own auto-provisioned git worktree.

**Architecture:** A server-side `WorkspaceManager` owns worktree provisioning (both surfaces call it). The project WS channel gains `watch_project` (live snapshots without joining) and `create_session` (+ `session_created` ack); `projectSnapshot` gains a `repo` field. The client renders a `SessionPicker` when no `?session=` param is present. A `mpai` bin starts the server single-port with the built client served statically off the same HTTP server.

**Tech Stack:** Node 22 / TypeScript server (`ws`, `execFileSync` git calls, no new deps), React 18 client, Vitest both sides, plain CSS (`terminal.css`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-session-launcher-design.md`. Deviations get recorded in this plan's Deviations section at the end.
- Branch: `feature/session-launcher` (already created; contains the spec commit). Never merge without the user.
- **A demo stack may be running** (`lsof -ti :3001`): editing `poc/server/` triggers tsx-watch hot reload. Editing files is allowed, but NEVER switch branches and don't restart/kill running processes.
- Worktree provisioning is server-side and trusted; the agent never drives it. `isContainedWrite` and the agent system prompt are untouched.
- Git calls: one child process per operation, argv only, never shell-interpolated (`execFileSync` — the sync variant keeps the join path synchronous; recorded as within the spec's intent).
- Branch naming: `mpai/<slug>`. Slug rule: 1–40 chars of `a-z0-9-` (the existing `SLUG` regex).
- Error message strings from spec §6 are exact: "server not launched in a repo", "create_session requires a usable name", "unknown base ref: <ref>", "session name taken (branch mpai/<slug> exists)", "not a git repository: <cwd>", "port <p> in use — try --port", "no server on port <p> — run `mpai` first". Git stderr truncates to 300 chars.
- No session is created on any failure path.
- Server commands run from `poc/server/`: `npx vitest run <file>`, full `npx vitest run`, `npx tsc --noEmit`. Client from `poc/client/`: `npm test`, `npm run build`.
- Baselines going in: **server 131 passing, client 66 passing**, both builds clean. Expected after all tasks: **server 160, client 72**.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: WorkspaceManager + slugify

**Files:**
- Create: `poc/server/src/workspace.ts`
- Test: `poc/server/test/workspace.test.ts` (new file)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Tasks 2, 6 rely on these exact shapes):

```ts
export type ProvisionResult = { ok: true; workdir: string } | { ok: false; error: string };
export interface WorkspaceLike {
  provision(slug: string, baseRef: string): ProvisionResult;
  defaultBranch(): string;
}
export class WorkspaceManager implements WorkspaceLike {
  constructor(repoRoot: string, worktreesRoot: string);
}
export function slugify(name: string): string;
```

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/workspace.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager, slugify } from "../src/workspace.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-repo-"));
  tmpDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  git("add", "README.md");
  git("commit", "-m", "init");
  return dir;
}

describe("WorkspaceManager", () => {
  it("provisions a worktree on a new mpai/<slug> branch", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const result = wm.provision("feat", "main");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.existsSync(result.workdir)).toBe(true);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: result.workdir,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe("mpai/feat");
  });

  it("is idempotent: an existing worktree dir is reused as-is", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const first = wm.provision("feat", "main");
    const second = wm.provision("feat", "definitely-not-a-ref");
    expect(second).toEqual(first); // no ref check on the reuse path
  });

  it("rejects an unknown base ref", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const result = wm.provision("feat", "nope");
    expect(result).toEqual({ ok: false, error: "unknown base ref: nope" });
  });

  it("rejects a slug whose branch already exists without its worktree", () => {
    const repo = makeRepo();
    execFileSync("git", ["branch", "mpai/taken"], { cwd: repo });
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const result = wm.provision("taken", "main");
    expect(result).toEqual({
      ok: false,
      error: "session name taken (branch mpai/taken exists)",
    });
  });

  it("reports the default branch", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    expect(wm.defaultBranch()).toBe("main");
  });

  it("falls back to main on detached HEAD", () => {
    const repo = makeRepo();
    execFileSync("git", ["checkout", "--detach"], { cwd: repo });
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    expect(wm.defaultBranch()).toBe("main");
  });
});

describe("slugify", () => {
  it("lowercases, dashes spaces, strips punctuation, collapses dashes", () => {
    expect(slugify("Fix Auth!!")).toBe("fix-auth");
    expect(slugify("  a  b--c  ")).toBe("a-b-c");
  });

  it("returns empty for unusable names and trims to 40 chars", () => {
    expect(slugify("###")).toBe("");
    expect(slugify("x".repeat(60))).toBe("x".repeat(40));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/workspace.test.ts`
Expected: FAIL — `../src/workspace.js` unresolvable.

- [ ] **Step 3: Implement**

Create `poc/server/src/workspace.ts`:

```ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ProvisionResult =
  | { ok: true; workdir: string }
  | { ok: false; error: string };

/** Structural interface so server tests can inject a fake. */
export interface WorkspaceLike {
  provision(slug: string, baseRef: string): ProvisionResult;
  defaultBranch(): string;
}

/** Server-side git worktree provisioning (spec §2). Trusted code path — the
 *  agent never drives this. One child process per git operation, argv only
 *  (never shell-interpolated); sync so the WS join path stays synchronous. */
export class WorkspaceManager implements WorkspaceLike {
  constructor(
    private repoRoot: string,
    private worktreesRoot: string,
  ) {}

  private git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  provision(slug: string, baseRef: string): ProvisionResult {
    const workdir = path.join(this.worktreesRoot, slug);
    // Idempotent reuse — join semantics; the worktree's existing state wins.
    if (fs.existsSync(workdir)) return { ok: true, workdir };
    try {
      this.git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    } catch {
      return { ok: false, error: `unknown base ref: ${baseRef}` };
    }
    const branch = `mpai/${slug}`;
    let branchExists = true;
    try {
      this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      return { ok: false, error: `session name taken (branch ${branch} exists)` };
    }
    try {
      fs.mkdirSync(this.worktreesRoot, { recursive: true });
      this.git(["worktree", "add", workdir, "-b", branch, baseRef]);
      return { ok: true, workdir };
    } catch (err) {
      const stderr = (err as { stderr?: unknown }).stderr;
      const message =
        (typeof stderr === "string" && stderr.trim()) ||
        (err instanceof Error ? err.message : String(err));
      return { ok: false, error: message.slice(0, 300) };
    }
  }

  defaultBranch(): string {
    try {
      return this.git(["symbolic-ref", "--short", "HEAD"]);
    } catch {
      return "main";
    }
  }
}

/** Session names → SLUG-safe ids (spec §3). The client mirrors this in
 *  sessionRow.ts for the form's preview — keep them in sync. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/workspace.test.ts && npx tsc --noEmit`
Expected: PASS (8 tests), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 139 passing (131 + 8).

```bash
git add poc/server/src/workspace.ts poc/server/test/workspace.test.ts
git commit -m "feat(server): WorkspaceManager — git worktree provisioning + slugify"
```

---

### Task 2: project wire — watch_project, create_session, repo snapshot, deep-link provisioning

**Files:**
- Modify: `poc/server/src/project.ts` (`ProjectMessage`, `projectSnapshot`)
- Modify: `poc/server/src/server.ts` — `startServer` opts, `getOrCreateSession`, snapshot call sites, new handlers before the `if (!ctx)` guard, close handler
- Test: `poc/server/test/server.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: Task 1's `WorkspaceLike`, `ProvisionResult`, `slugify`.
- Produces (Tasks 4, 6 rely on these):
  - `startServer` opts gain `workspace?: WorkspaceLike` and (Task 3) `staticDir?: string`.
  - WS commands (both valid BEFORE `join`): `{ type: "watch_project", projectId }` → immediate `project` snapshot + membership in the project's push list; `{ type: "create_session", projectId?, name, baseRef? }` → `{ type: "session_created", sessionId }` ack or `{ type: "error", message }`.
  - `ProjectMessage` gains `repo: { defaultBranch: string } | null`.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/server.test.ts` (top-level, after the existing describes; uses the file's existing `echoRun`, `connect`, `collect`, `wait` helpers and `startServer` import):

```ts
describe("session initiation", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  function fakeWorkspace() {
    const calls: { slug: string; baseRef: string }[] = [];
    return {
      calls,
      provision(slug: string, baseRef: string) {
        calls.push({ slug, baseRef });
        return { ok: true as const, workdir: `/tmp/wt/${slug}` };
      },
      defaultBranch: () => "main",
    };
  }

  it("watch_project sends an immediate snapshot with repo info and live pushes", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const watcher = await connect(server.port);
    const seen: any[] = [];
    collect(watcher, seen);
    watcher.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(50);
    const snap = seen.find((m) => m.type === "project");
    expect(snap).toBeTruthy();
    expect(snap.repo).toEqual({ defaultBranch: "main" });
    expect(snap.sessions).toEqual([]);
    const joiner = await connect(server.port);
    joiner.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await vi.waitFor(() => {
      expect(
        seen.some((m) => m.type === "project" && m.sessions.some((s: any) => s.id === "s1")),
      ).toBe(true);
    });
    watcher.close();
    joiner.close();
  });

  it("create_session provisions, acks, and pushes the new session", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const creator = await connect(server.port);
    const seen: any[] = [];
    collect(creator, seen);
    creator.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(30);
    creator.send(JSON.stringify({ type: "create_session", name: "Fix Auth!", baseRef: "dev" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "fix-auth")).toBe(true);
    });
    expect(workspace.calls).toEqual([{ slug: "fix-auth", baseRef: "dev" }]);
    await vi.waitFor(() => {
      expect(
        seen.some((m) => m.type === "project" && m.sessions.some((s: any) => s.id === "fix-auth")),
      ).toBe(true);
    });
    creator.close();
  });

  it("create_session errors when the server has no workspace", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", name: "x" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /not launched in a repo/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "session_created")).toBe(false);
    ws.close();
  });

  it("create_session validates the name", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session" }));
    ws.send(JSON.stringify({ type: "create_session", name: "###" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /requires name/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.type === "error" && /usable name/.test(m.message))).toBe(true);
    expect(workspace.calls).toEqual([]);
    ws.close();
  });

  it("create_session surfaces provision failure and creates nothing", async () => {
    const workspace = {
      provision: () => ({ ok: false as const, error: "unknown base ref: dev" }),
      defaultBranch: () => "main",
    };
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", name: "ghost", baseRef: "dev" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && m.message === "unknown base ref: dev")).toBe(true);
    expect(seen.some((m) => m.type === "session_created")).toBe(false);
    ws.close();
  });

  it("create_session for an existing session just acks without re-provisioning", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const joiner = await connect(server.port);
    joiner.send(JSON.stringify({ type: "join", sessionId: "s1", userId: "u1", name: "Ana" }));
    await wait(50);
    const creator = await connect(server.port);
    const seen: any[] = [];
    collect(creator, seen);
    creator.send(JSON.stringify({ type: "create_session", name: "s1" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.type === "session_created" && m.sessionId === "s1")).toBe(true);
    });
    expect(workspace.calls.length).toBe(1); // only the join's deep-link provision
    joiner.close();
    creator.close();
  });

  it("deep-link join provisions through the workspace off the default branch", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "adhoc", userId: "u1", name: "Ana" }));
    await vi.waitFor(() => {
      expect(seen.some((m) => m.event?.type === "presence_join")).toBe(true);
    });
    expect(workspace.calls).toEqual([{ slug: "adhoc", baseRef: "main" }]);
    ws.close();
  });

  it("deep-link join surfaces provision failure as a join error", async () => {
    const workspace = {
      provision: () => ({ ok: false as const, error: "session name taken (branch mpai/adhoc exists)" }),
      defaultBranch: () => "main",
    };
    const server = await startServer({ port: 0, runQuery: echoRun, workspace });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", sessionId: "adhoc", userId: "u1", name: "Ana" }));
    await wait(50);
    expect(seen.some((m) => m.type === "error" && /name taken/.test(m.message))).toBe(true);
    expect(seen.some((m) => m.event?.type === "presence_join")).toBe(false);
    ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: FAIL — `workspace` is not a known `startServer` opt (type error) and/or `unknown message type: watch_project`.

- [ ] **Step 3: Implement**

In `poc/server/src/project.ts`:

1. Add `repo` to `ProjectMessage` (after `pluginsEnabled: boolean;`):

```ts
  repo: { defaultBranch: string } | null;
```

2. Extend `projectSnapshot` with a third optional param and return field:

```ts
export function projectSnapshot(
  project: Project,
  pluginState?: { plugins: PluginInfo[]; enabled: boolean },
  repo?: { defaultBranch: string } | null,
): ProjectMessage {
```

and in the returned object add `repo: repo ?? null,`.

In `poc/server/src/server.ts`:

1. Import: extend the project import with nothing new; add
   `import { slugify, type WorkspaceLike } from "./workspace.js";`

2. `startServer` opts gain `workspace?: WorkspaceLike;` (Task 3 adds `staticDir`). At the top of `startServer` (after `pluginStore`):

```ts
  // Cached once at startup: the default branch changing mid-run is rare and
  // harmless (it only seeds the create form's base-ref field).
  const repo = opts.workspace
    ? { workspace: opts.workspace, defaultBranch: opts.workspace.defaultBranch() }
    : null;
```

3. Add a snapshot helper (beside `pushProject`) and use it at ALL THREE existing `projectSnapshot(...)` call sites (`pushProject`, join's immediate personal snapshot, peek's existing-project arm):

```ts
  function snapshotFor(project: Project) {
    return projectSnapshot(
      project,
      { plugins: pluginStore.list(project.id), enabled: pluginStore.enabled },
      repo && { defaultBranch: repo.defaultBranch },
    );
  }
```

Peek's no-project fallback object gains `repo: repo && { defaultBranch: repo.defaultBranch }`.

4. `getOrCreateSession` gains a `workdirOverride` param and an error return (deep-link provisioning, spec §3):

```ts
  function getOrCreateSession(
    project: Project,
    sessionId: string,
    workdirOverride?: string,
  ): ProjectSessionEntry | { error: string } {
    let entry = project.sessions.get(sessionId);
    if (!entry) {
      let workdir: string | undefined = workdirOverride;
      if (workdir === undefined) {
        if (repo) {
          // Deep-link join to a not-yet-provisioned session: same core as
          // create_session, branched off the default branch (spec §3).
          const result = repo.workspace.provision(sessionId, repo.defaultBranch);
          if (!result.ok) return { error: result.error };
          workdir = result.workdir;
        } else {
          const root = process.env.AGENT_WORKDIR_ROOT;
          workdir = root ? path.join(root, sessionId) : undefined;
        }
      }
      // ... the rest of the existing body is unchanged (skill_roster append,
      // new AgentDriver(session, runQuery, workdir, ...), subscribe) ...
    }
    return entry;
  }
```

(Only the workdir derivation block changes; keep everything else in the function byte-identical.)

5. In the `join` handler, the call site becomes:

```ts
        const entry = getOrCreateSession(project, msg.sessionId);
        if ("error" in entry) return sendError(entry.error);
```

6. Track project watching per connection: beside `let ctx: ClientContext | null = null;` add `let watching: Project | null = null;`. In the `close` handler add (before the `ctx` block):

```ts
      if (watching) {
        watching.watchers.delete(ws);
        watching = null;
      }
```

7. New handlers, placed after the `peek` handler and BEFORE the `if (!ctx) return sendError("join a session first");` guard:

```ts
      if (msg.type === "watch_project") {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        if (!SLUG.test(projectId)) {
          return sendError("watch_project requires a valid projectId");
        }
        const project = getOrCreateProject(projectId);
        project.watchers.add(ws);
        watching = project;
        ws.send(JSON.stringify(snapshotFor(project)));
        return;
      }

      if (msg.type === "create_session") {
        const projectId =
          typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId)) {
          return sendError("create_session requires a valid projectId");
        }
        if (typeof msg.name !== "string") {
          return sendError("create_session requires name");
        }
        const slug = slugify(msg.name);
        if (!slug) return sendError("create_session requires a usable name");
        const project = getOrCreateProject(projectId);
        if (project.sessions.has(slug)) {
          // Matches provision idempotence (spec §3): existing session acks.
          ws.send(JSON.stringify({ type: "session_created", sessionId: slug }));
          return;
        }
        if (!repo) return sendError("server not launched in a repo");
        const baseRef =
          typeof msg.baseRef === "string" && msg.baseRef.length > 0
            ? msg.baseRef.slice(0, 100)
            : repo.defaultBranch;
        const result = repo.workspace.provision(slug, baseRef);
        if (!result.ok) return sendError(result.error);
        const entry = getOrCreateSession(project, slug, result.workdir);
        if ("error" in entry) return sendError(entry.error);
        ws.send(JSON.stringify({ type: "session_created", sessionId: slug }));
        // Deliberate user action, not a hot stream — immediate push (same
        // rationale as add_plugin).
        pushProject(project);
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/server.test.ts && npx tsc --noEmit`
Expected: PASS (existing + 8 new), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 147 passing (139 + 8).

```bash
git add poc/server/src/project.ts poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat(server): watch_project + create_session wire commands, repo snapshot, deep-link provisioning"
```

---

### Task 3: static client serving + listen-error rejection

**Files:**
- Create: `poc/server/src/staticFiles.ts`
- Modify: `poc/server/src/server.ts` — `startServer` opts (`staticDir?: string`), `createServer(...)` call, listen promise
- Test: `poc/server/test/staticFiles.test.ts` (new file)

**Interfaces:**
- Consumes: `startServer` (Task 2 state of `server.ts`).
- Produces (Task 6 relies on these): `startServer` opts `staticDir?: string`; `startServer` REJECTS (instead of hanging) when the port is in use, with the `EADDRINUSE` error; `staticHandler(distDir: string): (req: IncomingMessage, res: ServerResponse) => void`.

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/staticFiles.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import type { RunQuery } from "../src/agentDriver.js";

const idleRun: RunQuery = async function* () {};

describe("static client serving", () => {
  let dist: string;
  let close: (() => Promise<void>) | undefined;
  let port = 0;

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-dist-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>mpai</title>");
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log(1)");
    const server = await startServer({ port: 0, runQuery: idleRun, staticDir: dist });
    close = server.close;
    port = server.port;
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("mpai");
  });

  it("serves assets with content types", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("falls back to index.html for extensionless paths (SPA deep links)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/anything?session=x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mpai");
  });

  it("404s missing assets", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/nope.js`);
    expect(res.status).toBe(404);
  });

  it("rejects path traversal", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
  });
});

describe("listen errors", () => {
  it("rejects startup when the port is in use", async () => {
    const first = await startServer({ port: 0, runQuery: idleRun });
    try {
      await expect(
        startServer({ port: first.port, runQuery: idleRun }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/staticFiles.test.ts`
Expected: FAIL — `staticDir` not a known opt (type error) / fetch to `/` gets no response body; the listen-error test times out or fails.

- [ ] **Step 3: Implement**

Create `poc/server/src/staticFiles.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

/** Minimal static handler for the built client (spec §5): GET-only, path
 *  containment, SPA fallback for extensionless paths. WS upgrades never hit
 *  this handler. Deliberately not a framework — the POC serves one dist dir. */
export function staticHandler(
  distDir: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(distDir);
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let filePath = path.resolve(root, "." + path.posix.normalize(pathname));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (path.extname(filePath) === "") {
        filePath = path.join(root, "index.html"); // SPA fallback
      } else {
        res.writeHead(404);
        res.end("not found");
        return;
      }
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  };
}
```

In `poc/server/src/server.ts`:

1. `import { staticHandler } from "./staticFiles.js";`
2. `startServer` opts gain `staticDir?: string;`
3. Change `const httpServer = createServer();` to:

```ts
  const httpServer = createServer(
    opts.staticDir ? staticHandler(opts.staticDir) : undefined,
  );
```

4. Replace the listen promise (`await new Promise<void>((resolve) => httpServer.listen(opts.port, resolve));`) with:

```ts
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/staticFiles.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests), tsc clean.

- [ ] **Step 5: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 153 passing (147 + 6).

```bash
git add poc/server/src/staticFiles.ts poc/server/src/server.ts poc/server/test/staticFiles.test.ts
git commit -m "feat(server): serve the built client statically on the WS port + reject on EADDRINUSE"
```

---

### Task 4: client pure layer — dynamic SERVER_URL, RepoInfo, sessionRow helpers

**Files:**
- Modify: `poc/client/src/types.ts` (SERVER_URL, new `RepoInfo`)
- Create: `poc/client/src/sessionRow.ts`
- Test: `poc/client/src/sessionRow.test.ts` (new file)

**Interfaces:**
- Consumes: Task 2's `project` message `repo` field (shape only).
- Produces (Task 5 relies on these):
  - `types.ts`: `SERVER_URL` (now host-derived in prod builds), `export type RepoInfo = { defaultBranch: string };`
  - `sessionRow.ts`: `sortSessions(sessions: ProjectSessionInfo[]): ProjectSessionInfo[]`; `agentStateLabel(ended: boolean): string`; `slugPreview(name: string): string`

- [ ] **Step 1: Write the failing tests**

Create `poc/client/src/sessionRow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { agentStateLabel, slugPreview, sortSessions } from "./sessionRow";
import type { ProjectSessionInfo } from "./types";

const row = (id: string, ts: string | null): ProjectSessionInfo => ({
  id,
  participants: [],
  driverName: null,
  intent: null,
  lastActivityTs: ts,
  ended: false,
});

describe("sortSessions", () => {
  it("sorts by lastActivityTs desc with nulls last", () => {
    const sorted = sortSessions([
      row("old", "2026-07-26T10:00:00Z"),
      row("idle", null),
      row("fresh", "2026-07-26T12:00:00Z"),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["fresh", "old", "idle"]);
  });

  it("does not mutate the input", () => {
    const input = [row("a", "2026-07-26T10:00:00Z"), row("b", "2026-07-26T12:00:00Z")];
    sortSessions(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("agentStateLabel", () => {
  it("maps ended to labels", () => {
    expect(agentStateLabel(false)).toBe("LIVE");
    expect(agentStateLabel(true)).toBe("ENDED");
  });
});

describe("slugPreview", () => {
  it("slugifies names with spaces and punctuation", () => {
    expect(slugPreview("Fix Auth!!")).toBe("fix-auth");
    expect(slugPreview("  a  b--c  ")).toBe("a-b-c");
  });

  it("returns empty for unusable names", () => {
    expect(slugPreview("###")).toBe("");
  });

  it("trims to 40 chars", () => {
    expect(slugPreview("x".repeat(60))).toBe("x".repeat(40));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npx vitest run src/sessionRow.test.ts`
Expected: FAIL — `./sessionRow` unresolvable.

- [ ] **Step 3: Implement**

In `poc/client/src/types.ts`, replace `export const SERVER_URL = "ws://localhost:3001";` with:

```ts
/** In vite dev the server runs separately on 3001; in a built bundle the
 *  page is served BY the server (spec §5), so the socket targets the same
 *  host. The DEV short-circuit also keeps window untouched under vitest. */
export const SERVER_URL = import.meta.env.DEV
  ? "ws://localhost:3001"
  : `ws://${window.location.host}`;

export type RepoInfo = { defaultBranch: string };
```

Create `poc/client/src/sessionRow.ts`:

```ts
import type { ProjectSessionInfo } from "./types";

/** Pure helpers for the session picker (no component-test infra in this
 *  repo — recorded pattern). */

export function sortSessions(sessions: ProjectSessionInfo[]): ProjectSessionInfo[] {
  return [...sessions].sort((a, b) =>
    (b.lastActivityTs ?? "").localeCompare(a.lastActivityTs ?? ""),
  );
}

export function agentStateLabel(ended: boolean): string {
  return ended ? "ENDED" : "LIVE";
}

/** Mirror of the server's slugify (poc/server/src/workspace.ts) so the form
 *  can preview the id a name will become — keep them in sync. */
export function slugPreview(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/client && npx vitest run src/sessionRow.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full client suite and commit**

Run: `cd poc/client && npm test && npm run build`
Expected: 72 passing (66 + 6), build clean.

```bash
git add poc/client/src/types.ts poc/client/src/sessionRow.ts poc/client/src/sessionRow.test.ts
git commit -m "feat(client): host-derived SERVER_URL + session picker pure helpers"
```

---

### Task 5: SessionPicker screen + App wiring + CSS

**Files:**
- Create: `poc/client/src/components/SessionPicker.tsx`
- Modify: `poc/client/src/App.tsx` — `sessionId` derivation (`:26`) and the `Cabinet`/`Crt` render gate (`:46-64`)
- Modify: `poc/client/src/terminal.css` — new rules appended at the end
- Test: none new (no component-test infra — recorded pattern; the logic underneath is Task 4's tested module). Verification = clean build + suite green.

**Interfaces:**
- Consumes: `SERVER_URL`, `ProjectSessionInfo`, `RepoInfo` (Task 4 / existing types); `sortSessions`, `agentStateLabel`, `slugPreview` from `../sessionRow` (note: `../` from `components/`); WS `watch_project` / `create_session` / `session_created` (Task 2).
- Produces: `<SessionPicker projectId />`.

- [ ] **Step 1: Create `poc/client/src/components/SessionPicker.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { SERVER_URL } from "../types";
import type { ProjectSessionInfo, RepoInfo } from "../types";
import { agentStateLabel, slugPreview, sortSessions } from "../sessionRow";

/** Entry screen when no ?session= is present (spec §4): live list of the
 *  project's sessions plus a NEW SESSION form. Watches the project channel;
 *  never joins a session itself. Navigation is a full page move — the
 *  existing join/Lobby flow takes over from there. */
export function SessionPicker(props: { projectId: string }) {
  const [sessions, setSessions] = useState<ProjectSessionInfo[]>([]);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  // null = untouched: the field shows the server-reported default branch.
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "watch_project", projectId: props.projectId }));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "project") {
          setSessions(msg.sessions ?? []);
          setRepo(msg.repo ?? null);
        }
        if (msg.type === "session_created") joinSession(msg.sessionId, props.projectId);
        if (msg.type === "error") {
          setError(msg.message);
          setPending(false);
        }
      } catch {
        return;
      }
    };
    return () => ws.close();
  }, [props.projectId]);

  const baseValue = baseRef ?? repo?.defaultBranch ?? "";
  const slug = slugPreview(name);
  const canCreate = repo !== null && slug.length > 0 && !pending;

  const create = () => {
    if (!canCreate) return;
    setError(null);
    setPending(true);
    wsRef.current?.send(
      JSON.stringify({
        type: "create_session",
        projectId: props.projectId,
        name,
        ...(baseValue.trim() ? { baseRef: baseValue.trim() } : {}),
      }),
    );
  };

  const rows = sortSessions(sessions);

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix lg">SESSIONS</span>
        <span className="rule" />
        <span className="pix">{props.projectId}</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          {rows.length === 0 && (
            <div className="line dim">no sessions yet — create one below.</div>
          )}
          {rows.map((s) => (
            <div className="sprow" key={s.id}>
              <div className="spbody">
                <div className="spname">
                  {s.id}
                  <span className={`spstate pix sm ${s.ended ? "ended" : "live"}`}>
                    {agentStateLabel(s.ended)}
                  </span>
                </div>
                {s.intent && <div className="spintent dim">{s.intent}</div>}
                <div className="spwho pix sm">
                  {s.participants.length > 0 ? s.participants.join(" · ") : "empty"}
                </div>
              </div>
              <button className="btn" onClick={() => joinSession(s.id, props.projectId)}>
                JOIN ▸
              </button>
            </div>
          ))}
        </div>
        <div className="panel pix top">NEW SESSION</div>
        <div className="panel">
          {repo === null && (
            <div className="line dim">launch via the CLI (mpai) to create sessions.</div>
          )}
          <div className="spform">
            <input
              className="spinput"
              placeholder="session name"
              value={name}
              disabled={repo === null}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <input
              className="spinput"
              placeholder="base ref"
              value={baseValue}
              disabled={repo === null}
              onChange={(e) => setBaseRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button className="btn" disabled={!canCreate} onClick={create}>
              CREATE ▸
            </button>
          </div>
          {slug.length > 0 && slug !== name && (
            <div className="line dim">will create as: {slug}</div>
          )}
          {error && <div className="line red">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function joinSession(sessionId: string, projectId: string): void {
  const params = new URLSearchParams(window.location.search);
  params.set("session", sessionId);
  if (projectId !== "default") params.set("project", projectId);
  window.location.search = params.toString();
}
```

(If `terminal.css` has no `.line.red` rule, the `.red` color-modifier class used by the workflows screen covers it; verify visually that the error line renders in `--red` and adjust the class to match the file's existing idiom if not.)

- [ ] **Step 2: Wire App.tsx**

1. Import: `import { SessionPicker } from "./components/SessionPicker";`
2. Change `const sessionId = params.get("session") ?? "demo";` (`:26`) to:

```ts
  // No param → session picker (spec §4). Deep links keep exact old behavior.
  const sessionId = params.get("session");
```

3. Replace the `Crt` body gate (`:49-61`, the `profile === null ? <Lobby .../> : <SessionView .../>` ternary) with:

```tsx
        {sessionId === null ? (
          <SessionPicker projectId={projectId} />
        ) : profile === null ? (
          <Lobby
            projectId={projectId}
            sessionId={sessionId}
            defaultName={`user-${userId.slice(0, 4)}`}
            onEnter={(p) => {
              saveProfile(p);
              setProfile(p);
            }}
          />
        ) : (
          <SessionView userId={userId} sessionId={sessionId} projectId={projectId} profile={profile} screen={screen} onScreenChange={setScreen} />
        )}
```

(The ternary narrows `sessionId` to `string` in the Lobby/SessionView branches — no prop type changes needed.)

- [ ] **Step 3: CSS**

Append to `poc/client/src/terminal.css`:

```css
/* ================================================================ sessions
   Session picker rows + create form. Same idiom as the workflows screen. */
.sprow {
  display: flex; align-items: flex-start; gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-bottom: 1px dashed var(--frame);
}
.sprow:last-child { border-bottom: 0; }
.spbody { flex: 1; min-width: 0; }
.spname { overflow-wrap: anywhere; }
.spstate { margin-left: var(--sp-2); }
.spstate.live { color: var(--green); }
.spstate.ended { color: var(--red); }
.spintent { margin-top: 2px; overflow-wrap: anywhere; }
.spwho { color: var(--accent); margin-top: 2px; }
.spform { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
.spinput {
  background: var(--bg); color: var(--fg);
  border: 1px solid var(--frame); padding: 6px 8px;
  font: inherit; min-width: 0; flex: 1;
}
```

(If `terminal.css` already has a shared input rule used by PromptBar/Lobby inputs, reuse that class instead of `.spinput` and drop the `.spinput` block — match the file's idiom.)

- [ ] **Step 4: Verify build + suite, then commit**

Run: `cd poc/client && npm run build && npm test`
Expected: build clean, 72 passing (no count change).

```bash
git add poc/client/src/components/SessionPicker.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): SESSIONS picker — live rows, JOIN, name+base-ref create form"
```

---

### Task 6: mpai CLI — launch + new

**Files:**
- Create: `poc/server/src/cli.ts`
- Create: `poc/server/bin/mpai.js` (executable)
- Modify: `poc/server/package.json` (add `bin`)
- Test: `poc/server/test/cli.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1's `WorkspaceManager`; Task 2's `create_session`/`session_created` wire; Task 3's `staticDir` opt + `EADDRINUSE` rejection.
- Produces: `mpai` bin — `mpai [--port N] [--no-open]` (launch) and `mpai new <name> [--base <ref>] [--project <id>] [--port N]`. Exported for tests: `parseArgs(argv: string[]): CliArgs`, `findRepoRoot(cwd: string): string | null`, `main(argv: string[]): Promise<number | null>` (null = server running, keep process alive).

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/cli.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, findRepoRoot } from "../src/cli.js";

describe("parseArgs", () => {
  it("defaults to launch on port 3001, project default, open", () => {
    expect(parseArgs([])).toEqual({
      cmd: "launch",
      port: 3001,
      project: "default",
      open: true,
    });
  });

  it("parses --port and --no-open", () => {
    const args = parseArgs(["--port", "4000", "--no-open"]);
    expect(args.port).toBe(4000);
    expect(args.open).toBe(false);
    expect(args.error).toBeUndefined();
  });

  it("parses new with name, base, and project", () => {
    const args = parseArgs(["new", "Fix Auth", "--base", "dev", "--project", "p1"]);
    expect(args.cmd).toBe("new");
    expect(args.name).toBe("Fix Auth");
    expect(args.base).toBe("dev");
    expect(args.project).toBe("p1");
    expect(args.error).toBeUndefined();
  });

  it("errors when new has no name", () => {
    expect(parseArgs(["new"]).error).toMatch(/requires a session name/);
  });

  it("errors on unknown flags and bad ports", () => {
    expect(parseArgs(["--bogus"]).error).toMatch(/unknown argument/);
    expect(parseArgs(["--port", "nope"]).error).toMatch(/--port/);
  });
});

describe("findRepoRoot", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("finds the repo root from a subdirectory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-cli-"));
    tmpDirs.push(dir);
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    expect(findRepoRoot(sub)).toBe(fs.realpathSync(dir));
  });

  it("returns null outside a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-nogit-"));
    tmpDirs.push(dir);
    expect(findRepoRoot(dir)).toBe(null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/cli.test.ts`
Expected: FAIL — `../src/cli.js` unresolvable.

- [ ] **Step 3: Implement**

Create `poc/server/src/cli.ts`:

```ts
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startServer } from "./server.js";
import { WorkspaceManager } from "./workspace.js";

export interface CliArgs {
  cmd: "launch" | "new";
  name?: string;
  base?: string;
  port: number;
  project: string;
  open: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cmd: "launch", port: 3001, project: "default", open: true };
  const rest = [...argv];
  if (rest[0] === "new") {
    args.cmd = "new";
    rest.shift();
    if (rest[0] && !rest[0].startsWith("-")) args.name = rest.shift();
  }
  while (rest.length > 0) {
    const flag = rest.shift()!;
    if (flag === "--port") {
      const value = Number(rest.shift());
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        return { ...args, error: "--port requires a port number" };
      }
      args.port = value;
    } else if (flag === "--base") {
      const value = rest.shift();
      if (!value) return { ...args, error: "--base requires a ref" };
      args.base = value;
    } else if (flag === "--project") {
      const value = rest.shift();
      if (!value) return { ...args, error: "--project requires an id" };
      args.project = value;
    } else if (flag === "--no-open") {
      args.open = false;
    } else {
      return { ...args, error: `unknown argument: ${flag}` };
    }
  }
  if (args.cmd === "new" && !args.name) {
    return { ...args, error: "mpai new requires a session name" };
  }
  return args;
}

export function findRepoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** .git/info/exclude keeps .mpai/ out of git status without touching the
 *  user's .gitignore (spec §5). Non-fatal on failure: worst case .mpai/
 *  shows as untracked. */
function ensureExcluded(repoRoot: string): void {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const excludeFile = path.resolve(repoRoot, gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile)
      ? fs.readFileSync(excludeFile, "utf8")
      : "";
    if (!current.split("\n").includes(".mpai/")) {
      const sep = current === "" || current.endsWith("\n") ? "" : "\n";
      fs.writeFileSync(excludeFile, `${current}${sep}.mpai/\n`);
    }
  } catch {
    /* non-fatal */
  }
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const openerArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(opener, openerArgs, () => {});
  } catch {
    /* non-fatal */
  }
}

async function launch(args: CliArgs): Promise<number | null> {
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error(`not a git repository: ${process.cwd()}`);
    return 1;
  }
  const worktreesRoot = path.join(repoRoot, ".mpai", "worktrees");
  fs.mkdirSync(worktreesRoot, { recursive: true });
  ensureExcluded(repoRoot);
  const distDir = path.resolve(
    fileURLToPath(import.meta.url), "..", "..", "..", "client", "dist",
  );
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    console.error(`client build missing at ${distDir} — run: cd poc/client && npm run build`);
    return 1;
  }
  try {
    const { port } = await startServer({
      port: args.port,
      workspace: new WorkspaceManager(repoRoot, worktreesRoot),
      staticDir: distDir,
    });
    const url = `http://localhost:${port}/`;
    console.log(`multiplayer-ai on ${url} (repo: ${repoRoot})`);
    if (args.open) openBrowser(url);
    return null; // server holds the process open
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`port ${args.port} in use — try --port`);
      return 1;
    }
    throw err;
  }
}

function createSession(args: CliArgs): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
  return new Promise<number>((resolve) => {
    const done = (code: number) => {
      clearTimeout(timer);
      ws.close();
      resolve(code);
    };
    const timer = setTimeout(() => {
      console.error("timed out waiting for the server");
      done(1);
    }, 10_000);
    ws.on("error", () => {
      console.error(`no server on port ${args.port} — run \`mpai\` first`);
      done(1);
    });
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "create_session",
          projectId: args.project,
          name: args.name,
          ...(args.base ? { baseRef: args.base } : {}),
        }),
      );
    });
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "session_created") {
        const project = args.project !== "default" ? `&project=${args.project}` : "";
        console.log(`http://localhost:${args.port}/?session=${msg.sessionId}${project}`);
        done(0);
      } else if (msg.type === "error") {
        console.error(msg.message);
        done(1);
      }
    });
  });
}

/** Returns an exit code, or null when the launched server should keep the
 *  process alive. */
export async function main(argv: string[]): Promise<number | null> {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error(
      "usage: mpai [--port N] [--no-open] | mpai new <name> [--base <ref>] [--project <id>] [--port N]",
    );
    return 1;
  }
  if (args.cmd === "new") return createSession(args);
  return launch(args);
}
```

Create `poc/server/bin/mpai.js`:

```js
#!/usr/bin/env node
// v1 runs from a checkout (spec §5): tsx compiles src/cli.ts on the fly.
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/cli.ts");
const code = await main(process.argv.slice(2));
if (code !== null) process.exit(code);
```

Then: `chmod +x poc/server/bin/mpai.js`

In `poc/server/package.json`, add after `"type": "module",`:

```json
  "bin": { "mpai": "bin/mpai.js" },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run test/cli.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests), tsc clean.

- [ ] **Step 5: Smoke the bin end-to-end (no browser)**

Run (from the repo root; uses a throwaway port so the running demo stack is untouched):

```bash
cd poc/client && npm run build && cd ../.. && node poc/server/bin/mpai.js --port 3777 --no-open &
sleep 3
curl -s http://localhost:3777/ | head -c 80        # expect the built index.html
node poc/server/bin/mpai.js new smoke-test --port 3777   # expect a join URL
git worktree list | grep .mpai                      # expect .mpai/worktrees/smoke-test
kill %1
git worktree remove --force .mpai/worktrees/smoke-test && git branch -D mpai/smoke-test
```

Expected: HTML served, join URL printed, worktree created on branch `mpai/smoke-test`, then cleaned up. (`.mpai/` is excluded via `.git/info/exclude`, so `git status` stays clean throughout.)

- [ ] **Step 6: Run the full server suite and commit**

Run: `cd poc/server && npx vitest run`
Expected: 160 passing (153 + 7).

```bash
git add poc/server/src/cli.ts poc/server/bin/mpai.js poc/server/package.json poc/server/test/cli.test.ts
git commit -m "feat(cli): mpai — one-command launch (single port, static client) + mpai new"
```

---

### Task 7: final verification sweep

**Files:** none created; read-only against the spec + full runs.

- [ ] **Step 1: Full suites + builds**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: **160 passing** (131 baseline + 8 workspace + 8 wire + 6 static/listen + 7 cli), tsc clean. If the count differs, find out why and record the arithmetic in Deviations.

Run: `cd poc/client && npm test && npm run build`
Expected: **72 passing** (66 + 6), build clean.

- [ ] **Step 2: Spec re-read**

Re-read `docs/superpowers/specs/2026-07-26-session-launcher-design.md` §2–§7 against `git diff main --stat` and the shipped code. Every locked requirement (WorkspaceManager provisioning rules incl. idempotence and exact error strings; create_session slugify/ack/error flow; `repo` in the project snapshot; deep-link provisioning; SessionPicker on no-param entry with sorted rows, JOIN, name+base form, disabled-without-repo hint, inline errors, no optimistic navigation; single-port static serving with SPA fallback and traversal rejection; `mpai` launch flow incl. `.git/info/exclude`, dist check, EADDRINUSE message; `mpai new` against a running server; env-root back-compat) maps to shipped code with file:line, or gets a recorded deviation below.

- [ ] **Step 3: Commit any fixes and stop**

Stop for the user's manual demo checkpoint: from a scratch git repo (or this one), `node poc/server/bin/mpai.js` → browser opens the SESSIONS picker → create a session (watch the slug preview + base ref default) → Lobby → prompt the agent and confirm its workdir is the new worktree (`.mpai/worktrees/<slug>`, branch `mpai/<slug>`) → second browser tab with no param joins via the picker → `mpai new cli-made` prints a working join URL. Do not merge; PR on user go.

---

## Deviations (recorded during execution)

(none yet)
