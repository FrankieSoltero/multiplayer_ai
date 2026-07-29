# Machines & Repos (PRD §8.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a machine a first-class durable thing — persisted identity, human name, a *set* of repos attachable/detachable from the hub UI — per `docs/superpowers/specs/2026-07-28-machines-repos-design.md` (the document of record; where this plan's code disagrees with it, the spec governs).

**Architecture:** Protocol v2 evolves the uplink in place (one uplink per machine, repos as a set on the hello, a full-list `repos` update frame). The laptop owns a `Map<repoKey, RepoEntry>` replacing the single `repo` const; attach/detach are ordinary client messages routed through the existing tunnel + reply-grant machinery. The hub store swaps its scalar `repoKey` for the list wholesale. The client gets real `(machine, repo)` choices and a MACHINES panel; all logic lands in pure modules, TSX stays thin.

**Tech Stack:** TypeScript, Node `ws`, vitest, React (poc/client). No new dependencies.

## Execution model assignment (session directive)

- **Orchestrator + review gate for every task: fable** (the main session — dispatches, reviews diffs, holds the gate).
- **opus** for the complex tasks: 3, 5, 6, 9, 12.
- **sonnet** for the mechanical tasks: 1, 2, 4, 7, 8, 10, 11, 13.
- **haiku** for cheap summarization passes (condensing task reports for the ledger) and first-pass checklist review; fable always performs the final review itself.

## Global Constraints

Every task's requirements implicitly include all of these.

1. **The spec governs.** `docs/superpowers/specs/2026-07-28-machines-repos-design.md`. A task whose verbatim code contradicts the spec is a plan bug: implement the spec, record the deviation in the ledger (`.superpowers/sdd/2026-07-28-machines-repos/progress.md`).
2. **Revert-and-rerun on every test.** After a test passes, revert the implementation change (`git stash` the src edit), rerun, watch it FAIL for the named reason, unstash. A test that cannot fail is a plan failure — strengthen its assertions, never weaken the intent (standing ruling).
3. **Never predict suite totals.** Run the suites and report the real numbers. Never invent tests to hit a count.
4. **Never `git add -A` / `git add .`.** Add exact paths; verify every commit with `git diff-tree --no-commit-id --name-only -r HEAD`.
5. **Rebuild the server after type changes:** `poc/hub` and `poc/client` consume `poc/server`'s built `dist/` — run `cd poc/server && npm run build` after changing any exported type, or downstream typechecks pass against stale declarations.
6. **Client typecheck is `npx tsc -b`** (its tsconfig is solution-style with `"files": []`; `--noEmit` is a NO-OP).
7. **Wire bounds (spec §5.1-5.2, verbatim):** `RELAY_PROTOCOL_VERSION = 2`; machine `name` ≤ 40 chars; `RepoDecl.key` ≤ 200; `RepoDecl.label` ≤ 100; `RepoDecl.defaultBranch` ≤ 100 or null; repos list ≤ 100 entries (parse rejects over-cap frames; a launch scanning > 100 candidates refuses to start).
8. **Identity is strict:** corrupt `machine.json` refuses launch — never silent regeneration (spec §3).
9. **Zero-attached-repos must behave exactly like today's `repo === null`** — the I3-ruled no-workspace mode (debt §2.6) must not regress (spec §6).
10. **`.env` in `poc/server` holds a placeholder API key — never source it.** Launch laptops only with the `mpai` CLI in walks.
11. **Do not merge PR #22 or touch `main`.** All work goes on the branch `feature/machines-repos` cut from `feature/projects` (Task 1 Step 1 creates it).

## File structure

New files:
- `poc/server/src/machineIdentity.ts` — machine.json load/mint (spec §3)
- `poc/server/src/machineRepos.ts` — roots scan + D8 default base ref (spec §4)
- `poc/server/test/machineIdentity.test.ts`, `poc/server/test/machineRepos.test.ts`
- `poc/client/src/repoChoices.ts` — (machine, repo) options, default choice, key→label map (spec §8)
- `poc/client/src/machineRows.ts` — MACHINES panel row model (spec §8)
- `poc/client/src/components/MachinesPanel.tsx` — thin TSX over machineRows
- `poc/client/src/repoChoices.test.ts`, `poc/client/src/machineRows.test.ts`

Modified (task-by-task below): `relayProtocol.ts`, `relay.ts`, `server.ts`, `project.ts`, `cli.ts`, `hubStore.ts`, `hub.ts`, client `types.ts`, `SessionPicker.tsx`, `repoGroups.ts`, `projectList.ts`, `ProjectPicker.tsx`, tests beside each.

---

### Task 1: Machine identity module

**Model:** sonnet

**Files:**
- Create: `poc/server/src/machineIdentity.ts`
- Test: `poc/server/test/machineIdentity.test.ts`

**Interfaces:**
- Produces: `interface MachineIdentity { machineId: string; name: string; roots: string[] }`; `mpaiHome(env?: NodeJS.ProcessEnv): string`; `loadMachineIdentity(dir: string): MachineIdentity` (throws on corrupt file). Task 8 (CLI) consumes both functions.

- [ ] **Step 0: Create the working branch**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git checkout feature/projects && git pull
git checkout -b feature/machines-repos
```

- [ ] **Step 1: Write the failing tests**

```ts
// poc/server/test/machineIdentity.test.ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMachineIdentity, mpaiHome } from "../src/machineIdentity.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mpai-id-"));

describe("loadMachineIdentity", () => {
  it("mints an identity on first run and persists it", () => {
    const dir = tmp();
    const first = loadMachineIdentity(dir);
    expect(first.machineId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(first.name).toBe(os.hostname());
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "machine.json"), "utf8"));
    expect(onDisk.machineId).toBe(first.machineId);
  });

  it("returns the SAME id on a second load — identity survives restarts", () => {
    const dir = tmp();
    const first = loadMachineIdentity(dir);
    expect(loadMachineIdentity(dir).machineId).toBe(first.machineId);
  });

  it("throws on a corrupt file rather than regenerating", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "machine.json"), "{not json");
    expect(() => loadMachineIdentity(dir)).toThrow(/machine identity/);
    // The corrupt file must still be there — no silent overwrite.
    expect(fs.readFileSync(path.join(dir, "machine.json"), "utf8")).toBe("{not json");
  });

  it("throws on a parseable file missing machineId", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "machine.json"), JSON.stringify({ name: "x" }));
    expect(() => loadMachineIdentity(dir)).toThrow(/machine identity/);
  });

  it("reads optional roots, dropping non-strings", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "machine.json"),
      JSON.stringify({ machineId: "m-1", name: "frank", roots: ["/a", 7, "/b"] }),
    );
    expect(loadMachineIdentity(dir).roots).toEqual(["/a", "/b"]);
  });
});

describe("mpaiHome", () => {
  it("prefers MPAI_HOME and falls back to ~/.mpai", () => {
    expect(mpaiHome({ MPAI_HOME: "/custom" } as NodeJS.ProcessEnv)).toBe("/custom");
    expect(mpaiHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), ".mpai"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd poc/server && npx vitest run test/machineIdentity.test.ts`
Expected: FAIL — cannot resolve `../src/machineIdentity.js`.

- [ ] **Step 3: Implement**

```ts
// poc/server/src/machineIdentity.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MachineIdentity {
  machineId: string;
  name: string;
  roots: string[];
}

/** Same shape `relayProtocol.ts`'s ID regex admits, so a persisted id can
 *  never fail the hello parse. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function mpaiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MPAI_HOME && env.MPAI_HOME.length > 0
    ? env.MPAI_HOME
    : path.join(os.homedir(), ".mpai");
}

/** Read (or first-run mint) the persisted machine identity (spec §3).
 *
 *  Throws — never regenerates — on a corrupt file: a fresh machineId would
 *  orphan every session the hub attributes to the old one. Written atomically
 *  (temp + rename) so a crashed first run cannot half-write identity. */
export function loadMachineIdentity(dir: string): MachineIdentity {
  const file = path.join(dir, "machine.json");
  if (!fs.existsSync(file)) {
    const fresh = { machineId: randomUUID(), name: os.hostname() };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `machine.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(fresh, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ...fresh, roots: [] };
  }
  const fail = (): never => {
    throw new Error(
      `corrupt machine identity at ${file} — fix or delete it by hand; ` +
        `regenerating the id would orphan this machine's sessions on the hub`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fail();
  }
  const obj =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (!obj) return fail();
  const machineId =
    typeof obj.machineId === "string" && ID.test(obj.machineId) ? obj.machineId : null;
  const name =
    typeof obj.name === "string" && obj.name.length > 0 ? obj.name.slice(0, 40) : null;
  if (!machineId || !name) return fail();
  const roots = Array.isArray(obj.roots)
    ? obj.roots.filter((r): r is string => typeof r === "string")
    : [];
  return { machineId, name, roots };
}
```

- [ ] **Step 4: Run to verify pass, then revert-and-rerun**

Run: `npx vitest run test/machineIdentity.test.ts` → all pass. Stash `src/machineIdentity.ts`'s corrupt-file `throw` (replace with a regenerate) → the corrupt-file test must FAIL → restore.

- [ ] **Step 5: Full server suite + typecheck, commit**

```bash
cd poc/server && npx tsc --noEmit && npx vitest run
git add poc/server/src/machineIdentity.ts poc/server/test/machineIdentity.test.ts
git commit -m "feat(server): persisted machine identity — ~/.mpai/machine.json"
```

---

### Task 2: Roots scan + D8 default base ref

**Model:** sonnet

**Files:**
- Create: `poc/server/src/machineRepos.ts`
- Test: `poc/server/test/machineRepos.test.ts`

**Interfaces:**
- Consumes: `repoKeyFor` from `./repoKey.js`.
- Produces: `interface RepoCandidate { key: string; label: string; root: string }`; `MAX_REPO_CANDIDATES = 100`; `scanRepoRoots(roots: string[], warn?: (msg: string) => void): RepoCandidate[]` (throws on bad root / over-cap); `defaultBaseRefFor(repoRoot: string): string`. Tasks 3, 6, 8 consume these.

- [ ] **Step 1: Write the failing tests** (real temp git repos — same approach as `workspace.test.ts`)

```ts
// poc/server/test/machineRepos.test.ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultBaseRefFor, scanRepoRoots } from "../src/machineRepos.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mpai-scan-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function makeRepo(dir: string, origin?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  if (origin) git(dir, "remote", "add", "origin", origin);
}

describe("scanRepoRoots", () => {
  it("finds the root itself when it is a repo", () => {
    const root = tmp();
    makeRepo(root, "git@github.com:acme/api.git");
    const found = scanRepoRoots([root]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: "github.com/acme/api", root });
    expect(found[0].label).toBe(path.basename(root));
  });

  it("finds immediate children only — depth 1, non-repos ignored", () => {
    const root = tmp();
    makeRepo(path.join(root, "api"), "git@github.com:acme/api.git");
    makeRepo(path.join(root, "web"), "git@github.com:acme/web.git");
    fs.mkdirSync(path.join(root, "notes"));                       // not a repo
    makeRepo(path.join(root, "notes", "deep"), "git@github.com:acme/deep.git"); // depth 2
    const keys = scanRepoRoots([root]).map((c) => c.key).sort();
    expect(keys).toEqual(["github.com/acme/api", "github.com/acme/web"]);
  });

  it("throws on a nonexistent root", () => {
    expect(() => scanRepoRoots([path.join(tmp(), "missing")])).toThrow(/not a directory/);
  });

  it("skips a duplicate key, first wins, and says so", () => {
    const root = tmp();
    makeRepo(path.join(root, "api"), "git@github.com:acme/api.git");
    makeRepo(path.join(root, "api-clone"), "https://github.com/acme/api.git"); // same key
    const warnings: string[] = [];
    const found = scanRepoRoots([root], (m) => warnings.push(m));
    expect(found).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("api-clone");
  });
});

describe("defaultBaseRefFor", () => {
  it("falls back to the current checkout when there is no origin/HEAD", () => {
    const repo = tmp();
    makeRepo(repo);
    git(repo, "commit", "--allow-empty", "-m", "x");
    git(repo, "checkout", "-b", "feature-x");
    expect(defaultBaseRefFor(repo)).toBe("feature-x");
  });

  it("prefers origin/HEAD over the current checkout (the D8 stale-branch trap)", () => {
    const upstream = tmp();
    makeRepo(upstream);
    git(upstream, "commit", "--allow-empty", "-m", "x");
    const clone = path.join(tmp(), "clone");
    execFileSync("git", ["clone", upstream, clone], { encoding: "utf8" });
    git(clone, "checkout", "-b", "stale-branch");
    expect(defaultBaseRefFor(clone)).toBe("origin/main");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/machineRepos.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// poc/server/src/machineRepos.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoKeyFor } from "./repoKey.js";

export interface RepoCandidate {
  key: string;
  label: string;
  root: string;
}

/** Spec §5.1: a bigger scan is a config error, and a truncated list would
 *  misrepresent the machine — so over-cap refuses launch, never trims. */
export const MAX_REPO_CANDIDATES = 100;

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** `.git` may be a directory (normal clone) or a file (worktree/submodule);
 *  existsSync admits both. */
const isGitRepo = (dir: string): boolean => fs.existsSync(path.join(dir, ".git"));

function candidateOf(root: string): RepoCandidate {
  const remote = git(["remote", "get-url", "origin"], root);
  return {
    key: repoKeyFor(remote, { hostname: os.hostname(), repoRoot: root }),
    label: path.basename(root).slice(0, 100),
    root,
  };
}

/** Scan allowlisted roots for git repos (spec §4): the root itself when it is
 *  one, otherwise its immediate children. Depth 1, launch-time only. Bad
 *  roots and an over-cap scan throw (fail loud); a duplicate key is skipped
 *  first-wins with a warning naming both paths. */
export function scanRepoRoots(
  roots: string[],
  warn: (msg: string) => void = console.error,
): RepoCandidate[] {
  const byKey = new Map<string, RepoCandidate>();
  for (const raw of roots) {
    const root = path.resolve(raw);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`--root ${raw}: not a directory`);
    }
    const dirs = isGitRepo(root)
      ? [root]
      : fs
          .readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(root, e.name))
          .filter(isGitRepo);
    for (const dir of dirs) {
      const candidate = candidateOf(dir);
      const seen = byKey.get(candidate.key);
      if (seen) {
        warn(`repo scan: ${dir} has the same key as ${seen.root} — skipped`);
        continue;
      }
      byKey.set(candidate.key, candidate);
    }
  }
  if (byKey.size > MAX_REPO_CANDIDATES) {
    throw new Error(
      `repo scan found ${byKey.size} repos — over the ${MAX_REPO_CANDIDATES} cap; narrow --root`,
    );
  }
  return [...byKey.values()];
}

/** D8: what the create form suggests for an ATTACHED repo. `origin/HEAD`
 *  resolves the repo's true default branch and provisions from the
 *  remote-tracking ref (fresh, not a stale local); only origin-less repos
 *  fall back to whatever the checkout is sitting on. (A repo whose origin
 *  was added without a clone may lack origin/HEAD — that also falls back.) */
export function defaultBaseRefFor(repoRoot: string): string {
  const sym = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (sym) return sym; // e.g. "origin/main"
  return git(["symbolic-ref", "--short", "HEAD"], repoRoot) ?? "main";
}
```

- [ ] **Step 4: Run to verify pass; revert-and-rerun** the depth-1 filter (make the scan recursive → the depth-1 test must FAIL) and the origin/HEAD preference (return checkout first → the D8 test must FAIL).

- [ ] **Step 5: Full suite + commit**

```bash
cd poc/server && npx tsc --noEmit && npx vitest run
git add poc/server/src/machineRepos.ts poc/server/test/machineRepos.test.ts
git commit -m "feat(server): allowlist roots scan and origin/HEAD base ref"
```

---

### Task 3: The server-side repo set — Map, resolution, session binding

**Model:** opus

**Files:**
- Modify: `poc/server/src/server.ts` (the `repo` const `:147-155`, `getOrCreateSession` `:250-269`, `create_session` `:689-721`, `startServer` opts `:116-141`)
- Modify: `poc/server/src/project.ts:13-21` (`ProjectSessionEntry`)
- Modify: `poc/server/src/relayProtocol.ts` (add the `RepoDecl` interface — type only, NO version bump yet)
- Test: `poc/server/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `RepoCandidate` from Task 2 (type only).
- Produces, used by Tasks 4-6:
  - `RepoDecl` in relayProtocol.ts: `{ key: string; label: string; attached: boolean; defaultBranch: string | null }`
  - startServer opts gain: `workspaceLabel?: string; workspaceRoot?: string; machine?: { machineId: string; name: string }; repoCandidates?: RepoCandidate[]; workspaceFor?: (root: string) => WorkspaceLike; defaultBaseRef?: (root: string) => string`
  - Inside startServer: `repos: Map<string, RepoEntry>` where `RepoEntry = { key; label; root: string | null; attached: boolean; workspace: WorkspaceLike | null; defaultBranch: string | null }`; helpers `repoDecls(): RepoDecl[]`, `attachedRepos(): RepoEntry[]`, `machineView(): { machineId; name; repos: RepoDecl[]; online: true } | null`
  - `ProjectSessionEntry` gains `repoKey: string | null`

**Notes for the implementer:**
- Keep the OLD snapshot/summary call sites compiling in this task by feeding them from the map: define `const repo = ...` is DELETED; where `:202/:221/:484/:630/:1104` referenced `repo`, use a temporary `const firstAttached = () => attachedRepos()[0] ?? null` shim so behavior is unchanged for a single-repo server. Task 4 replaces those sites properly; this task's job is the map + resolution + binding.
- `machineView()` rule (spec §6/§7): with `opts.machine` → real identity + `repoDecls()`. Without it (direct-API tests) → legacy fallback: first attached repo's `key` as machineId and `label` as name; `null` when no repos. CLI always passes `machine` after Task 8.
- The cwd workspace enters the map pre-attached: `key = opts.workspace.repoKey()`, `label = opts.workspaceLabel ?? "repo"`, `root = opts.workspaceRoot ?? null`, `defaultBranch = opts.workspace.defaultBranch()` (D8's cwd carve-out — current checkout). Candidates enter `attached: false, workspace: null, defaultBranch: null`.
- `create_session` resolution (spec §6): explicit `msg.repoKey` → `repos.get(key)`, refuse `!found || !found.attached` with `repo "${key}" is not attached on this machine`; absent → single attached repo; zero attached → the existing `server not launched in a repo` refusal verbatim (Constraint 9); several attached and no key → `several repos are attached — specify a repo`. `baseRef` fallback becomes the RESOLVED entry's `defaultBranch ?? "main"`.
- `getOrCreateSession` (deep-link join): signature becomes `(project, sessionId, opts?: { workdir?: string; repoKey?: string | null })`. Existing entry → reuse (unchanged). New entry, no workdir: exactly one attached repo → provision with ITS workspace and ITS `defaultBranch`; zero → the `AGENT_WORKDIR_ROOT` branch verbatim with `repoKey: null` (Constraint 9); several → `{ error: 'session "<id>" does not exist — create it from the project screen' }`. Bind `entry.repoKey` on every creation path (create_session passes the resolved key).

- [ ] **Step 1: Write failing tests** (extend `server.test.ts`; use its existing helpers `connect(port)`, `collect(ws, sink)`, `wait(ms)`, the `close` afterEach, and a keyed variant of its `fakeWorkspace()`):

```ts
// Add beside fakeWorkspace() at the top of server.test.ts:
function keyedWorkspace(key: string) {
  const calls: { slug: string; baseRef: string }[] = [];
  return {
    calls,
    provision(slug: string, baseRef: string) {
      calls.push({ slug, baseRef });
      return { ok: true as const, workdir: `/tmp/wt/${key}/${slug}` };
    },
    defaultBranch: () => "main",
    repoKey: () => key,
  };
}

describe("repo set", () => {
  it("create_session with an explicit repoKey resolves through the map and refuses an unattached candidate", async () => {
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: cwd,
      repoCandidates: [{ key: "github.com/acme/web", label: "web", root: "/tmp/web" }],
    });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1", repoKey: "github.com/acme/api" }));
    await wait(200);
    expect(seen.some((m) => m.type === "session_created" && m.sessionId === "s1")).toBe(true);
    expect(cwd.calls.map((c) => c.slug)).toEqual(["s1"]);
    // The candidate exists in the map but is NOT attached — refusal, not provisioning.
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s2", repoKey: "github.com/acme/web" }));
    await wait(200);
    expect(seen.some((m) => m.type === "error" && /not attached/.test(m.message))).toBe(true);
    expect(cwd.calls.map((c) => c.slug)).toEqual(["s1"]); // and nothing provisioned anywhere
    ws.close();
  });

  it("create_session with no repoKey keeps today's single-repo behavior", async () => {
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: cwd });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(200);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);
    expect(cwd.calls).toEqual([{ slug: "s1", baseRef: "main" }]);
    ws.close();
  });

  it("create_session with zero repos keeps the legacy refusal verbatim (Constraint 9)", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1" }));
    await wait(200);
    expect(seen.some((m) => m.type === "error" && m.message === "server not launched in a repo")).toBe(true);
    ws.close();
  });

  it("deep-link join to a never-created session binds the lone attached repo", async () => {
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: cwd });
    close = server.close;
    const ws = await connect(server.port);
    collect(ws, []);
    ws.send(JSON.stringify({ type: "join", sessionId: "fresh", userId: "u1", name: "Ana" }));
    await wait(200);
    expect(cwd.calls).toEqual([{ slug: "fresh", baseRef: "main" }]);
    ws.close();
  });

  it("the snapshot's session rows carry each session's OWN repoKey", async () => {
    // Pins the entry.repoKey binding through the snapshot path. Full
    // multi-repo divergence (two keys in one snapshot) becomes reachable in
    // Task 6 via attach_repo — extend this test there.
    const cwd = keyedWorkspace("github.com/acme/api");
    const server = await startServer({ port: 0, runQuery: echoRun, workspace: cwd });
    close = server.close;
    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "create_session", projectId: "default", name: "s1", repoKey: "github.com/acme/api" }));
    await wait(200);
    ws.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(200);
    const snap = seen.find((m) => m.type === "project" && m.sessions?.length > 0);
    expect(snap.sessions[0].repoKey).toBe("github.com/acme/api");
    ws.close();
  });
});
```

- [ ] **Step 2: Run to verify each fails** for its named reason (missing refusal text, missing binding), not for compile noise.

- [ ] **Step 3: Implement** per the notes above. `RepoDecl` goes in `relayProtocol.ts` beside `SessionFacts` with a doc comment pointing at spec §5.1.

- [ ] **Step 4: Suite green; revert-and-rerun** the explicit-key resolution (make it ignore `msg.repoKey` as today → the first test must FAIL by observing the WRONG workspace provisioned — this is scout blocker (d)'s regression test at the unit level; Task 12 repeats it across the wire).

- [ ] **Step 5: Rebuild dist + downstream typechecks + commit**

```bash
cd poc/server && npx tsc --noEmit && npx vitest run && npm run build
cd ../hub && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc -b && npx vitest run
git add poc/server/src/server.ts poc/server/src/project.ts poc/server/src/relayProtocol.ts poc/server/test/server.test.ts
git commit -m "feat(server): repo set — Map, create/join resolution, session binding"
```

---

### Task 4: Snapshot/summary shape swap — machines carry the repo list, `repo` field retired

**Model:** sonnet

**Files:**
- Modify: `poc/server/src/project.ts` (`ProjectMessage:126-171`, `projectSnapshot:173-202`, `MachineSummary:204-208`, `projectSummaryOf:239-256`)
- Modify: `poc/server/src/server.ts` (`snapshotFor:198-205`, facts push `:221`, `list_projects:483-485`, `peek:630`)
- Test: `poc/server/test/project.test.ts`, `poc/server/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `repoDecls()`, `machineView()`, `entry.repoKey` from Task 3; `RepoDecl` from relayProtocol.
- Produces (Tasks 5, 9-11 rely on these shapes):
  - `ProjectMessage.machines?: { machineId: string; name: string; repos: RepoDecl[]; online: boolean }[]` — the `repo` field is **deleted** from `ProjectMessage` (D10)
  - `projectSnapshot(project, pluginState?, machine?: { machineId: string; name: string; repos: RepoDecl[] } | null, oversight?)` — third param replaces the old `repo` param; session rows get `repoKey` from `entry.repoKey`, not a global
  - `MachineSummary = { machineId: string; name: string; repos: RepoDecl[]; online: boolean }`
  - `projectSummaryOf(project, memberUserId, machine: { machineId; name; repos: RepoDecl[] } | null)`

- [ ] **Step 1: Failing tests** — in `project.test.ts`: `projectSnapshot` reports `machines[0]` with `name` and a `repos` array and NO `repo` property (`expect(snapshot).not.toHaveProperty("repo")` — pins D10); session rows carry each entry's own `repoKey` (two entries, two different keys, assert both appear). In `server.test.ts`: `peek` for an unknown project answers the synthetic snapshot without a `repo` property.
- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement.** `snapshotFor` passes `machineView()`; the facts loop at `:221` becomes `relay.publishFacts(id, sessionFactsOf(id, entry, entry.repoKey))`; `projectSummaryOf` call at `:484` passes `machineView()`.
- [ ] **Step 4: Suites green (server), revert-and-rerun** the per-session repoKey (feed the global first-attached key again → the two-keys test must FAIL).
- [ ] **Step 5: Rebuild + downstream typecheck + commit** (same command block as Task 3 Step 5; adjust `git add` paths).

```bash
git add poc/server/src/project.ts poc/server/src/server.ts poc/server/test/project.test.ts poc/server/test/server.test.ts
git commit -m "feat(server): machines carry name+repos; single repo field retired"
```

---

### Task 5: Protocol v2 — the wire swap (relayProtocol, relay, hubStore, hub hello/routing)

**Model:** opus. This is the one task that must land all three packages coherently — every intermediate state where hello v1 and the new store shapes coexist fails to compile, which is the point (D6: no shim).

**Files:**
- Modify: `poc/server/src/relayProtocol.ts` (version `:12`, hello `:41`, parse `:99-107`, new `repos` frame)
- Modify: `poc/server/src/relay.ts` (`RelayOptions:24-33`, hello write `:167-173`, new `sendRepos()`)
- Modify: `poc/server/src/server.ts:1099-1110` (Relay construction)
- Modify: `poc/hub/src/hubStore.ts` (`Uplink:23-28`, `MachineInfo:46-50`, `attach:144-147`, new `setRepos`, `machinesIn:153-160`, `emptyFacts:364-377` + its call `:273`)
- Modify: `poc/hub/src/hub.ts` (hello handling `:198-218`, new `repos` branch, `create_session` target match `:533-541`)
- Modify: `poc/hub/test/relayIntegration.test.ts:89-143` (`laptop()`/`laptopThatAnswers()` option shapes), `poc/hub/test/hubStore.test.ts`, `poc/hub/test/routing.test.ts`, `poc/server/test/relayProtocol.test.ts`, `poc/server/test/relay.test.ts` (all: hello/attach shapes)

**Interfaces:**
- Produces (Tasks 6, 7, 12 rely on):
  - `RELAY_PROTOCOL_VERSION = 2`
  - `UpFrame` hello: `{ t: "hello"; v: number; uplinkId: string; name: string; projectId: string; repos: RepoDecl[] }`; new `{ t: "repos"; repos: RepoDecl[] }`
  - `RelayOptions`: `repoKey` deleted; gains `name: string; repos: () => RepoDecl[]` (a getter, so every reconnect hello carries the CURRENT list); `Relay.sendRepos(): void` emits the full list through the same buffered `emit` path facts use
  - `HubStore.attach(uplinkId, projectId, name: string, repos: RepoDecl[], attachedAt)`; `HubStore.setRepos(uplinkId: string, repos: RepoDecl[]): void` (wholesale replacement); `MachineInfo = { machineId; name; repos: RepoDecl[]; online }`
  - hub `create_session`: optional `msg.machineId`; matcher `offers = (m: MachineInfo) => m.repos.some((r) => r.attached && r.key === repoKey)`

**Parse rules (spec §5.1-5.2, exact):** reject hello/repos frames where `repos` is not an array, has > 100 entries, or any entry fails: `key` string 1-200 chars; `label` string 1-100; `attached` boolean; `defaultBranch` null or string ≤ 100. `name`: reject non-string; store `.slice(0, 40)`.

**Hub `repos` branch** (after the `hello first` guard): `store.setRepos(uplinkId, frame.repos); schedulePush(projectId);`.

**Two log lines the spec's §12 disclosures require (small, in this task because they touch the same seams):**
- Hub hello handling: when `uplinks.get(frame.uplinkId)` already holds a DIFFERENT open socket, log `console.error(`uplink ${frame.uplinkId}: superseded by a new connection (same machineId from two daemons? check MPAI_HOME)`)` before replacing it — spec §12.2's diagnosability line for the shared-MPAI_HOME trap.
- Relay close handling (`relay.ts:178-188`): the close callback's first argument is the close code (the `ws` adapter passes it through). When it is `1008`, log `console.error("hub rejected this uplink (protocol violation) — laptop and hub versions may not match")` — spec §12.3's distinct version-refusal log. Guard it so a normal reconnect stays silent.

**Hub `create_session` routing change:**

```ts
const requestedMachine = typeof msg.machineId === "string" && msg.machineId ? msg.machineId : null;
const offers = (m: MachineInfo) => m.repos.some((r) => r.attached && r.key === repoKey);
const machines = store.machinesIn(projectId);
let target: MachineInfo | undefined;
if (requestedMachine) {
  const named = machines.find((m) => m.machineId === requestedMachine);
  if (!named || !named.online || !uplinks.get(named.machineId)) {
    return error(`machine "${requestedMachine}" is not online right now`);
  }
  if (!offers(named)) return error(`that machine is not offering repo "${repoKey}"`);
  target = named;
} else {
  target = machines.find((m) => m.online && offers(m));
}
const uplink = target ? uplinks.get(target.machineId) : undefined;
if (!target || !uplink) return error(`no machine is offering repo "${repoKey}" right now`);
```

**`emptyFacts`** loses its `repoKey` parameter and hardcodes `repoKey: null` (spec §7 — the hub honestly doesn't know until the facts frame lands); update the call at `hubStore.ts:273`.

**server.ts Relay construction:**

```ts
const relay = opts.hub
  ? new Relay(
      {
        hubUrl: opts.hub.url,
        projectId: opts.hub.projectId,
        name: opts.machine?.name ?? "machine",
        repos: () => repoDecls(),
        uplinkId: opts.hub.uplinkId ?? opts.machine?.machineId ?? randomUUID(),
        connect: opts.hub.connect,
      },
      { createConnection },
    )
  : null;
```

- [ ] **Step 1: Failing tests.** `relayProtocol.test.ts`: hello v2 round-trips; a v1 hello (`v: 1`) parses to null; 101-entry repos list → null; bad RepoDecl entry → null; `repos` frame round-trips. `hubStore.test.ts`: `attach` stores name+list; `setRepos` REPLACES (attach with `[a, b]`, setRepos `[a]`, `machinesIn` shows exactly `[a]`); a facts-less `publish` synthesizes `repoKey: null`; **restart-reclaim named test** — `attach("m1", ...)`, `setFacts("m1", "auth", ...)` ok, `detach("m1")`, `attach("m1", ...)` again, `setFacts("m1", "auth", ...)` still ok (pins debt §2.3's dissolution). `routing.test.ts`: create_session matched via the repos list; explicit `machineId` naming a machine that doesn't offer the repo → the exact error text.
- [ ] **Step 2: Verify failures** (parse tests fail on shape, store tests on missing methods).
- [ ] **Step 3: Implement** everything above in one pass; update the two integration-test helpers (`laptop()`/`laptopThatAnswers()` pass `name: "lap"`, `repos: () => [{ key: "github.com/acme/api", label: "api", attached: true, defaultBranch: "origin/main" }]` instead of `repoKey`).
- [ ] **Step 4: All three package suites green.** Revert-and-rerun: restore `emptyFacts`' old uplink-scalar behavior → the null-repoKey test FAILS; make `setRepos` merge instead of replace → the replacement test FAILS.
- [ ] **Step 5: Rebuild + commit**

```bash
cd poc/server && npx tsc --noEmit && npx vitest run && npm run build
cd ../hub && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc -b && npx vitest run
git add poc/server/src/relayProtocol.ts poc/server/src/relay.ts poc/server/src/server.ts \
        poc/server/test/relayProtocol.test.ts poc/server/test/relay.test.ts \
        poc/hub/src/hubStore.ts poc/hub/src/hub.ts \
        poc/hub/test/hubStore.test.ts poc/hub/test/routing.test.ts poc/hub/test/relayIntegration.test.ts
git commit -m "feat(protocol): v2 — machine name + repos set on the uplink"
```

---

### Task 6: Laptop attach/detach handlers

**Model:** opus

**Files:**
- Modify: `poc/server/src/server.ts` (new handlers beside `create_project`, in the pre-join block; imports `WorkspaceManager`, `defaultBaseRefFor`)
- Test: `poc/server/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `repos` map + `RepoEntry` (Task 3), `relay.sendRepos()` (Task 5), `opts.workspaceFor` / `opts.defaultBaseRef` injections (Task 3), `lifecycleOf` from `./lifecycle.js`.
- Produces: client messages `attach_repo { repoKey }` → `{ type: "repo_attached", repoKey }` and `detach_repo { repoKey }` → `{ type: "repo_detached", repoKey }`, with spec §9's exact refusals. Tasks 7, 10, 12 rely on these message names.

**Handler (place after `create_project`, same gate posture — spec §6):**

```ts
if (msg.type === "attach_repo" || msg.type === "detach_repo") {
  if (denyUnauthed()) return;
  const key = typeof msg.repoKey === "string" ? msg.repoKey : "";
  if (!key) return sendError(`${msg.type} requires repoKey`);
  const entry = repos.get(key);
  if (!entry) return sendError(`repo "${key}" is not in this machine's repo list`);
  if (msg.type === "attach_repo") {
    if (!entry.attached) {
      // Candidates always carry a root (the scanner set it); only the
      // direct-API cwd entry can lack one, and it starts attached.
      if (!entry.root) return sendError(`repo "${key}" has no root to attach from`);
      try {
        entry.defaultBranch = (opts.defaultBaseRef ?? defaultBaseRefFor)(entry.root);
        entry.workspace = (opts.workspaceFor ??
          ((root: string) => new WorkspaceManager(root, path.join(root, ".mpai", "worktrees"))))(
          entry.root,
        );
        entry.attached = true;
      } catch (err) {
        // Stay unattached; reply the git error (spec §9).
        const message = err instanceof Error ? err.message : String(err);
        return sendError(message.slice(0, 300));
      }
    }
    io.send({ type: "repo_attached", repoKey: key }); // idempotent ack
  } else {
    if (entry.attached) {
      const blockers: string[] = [];
      for (const project of projects.values()) {
        for (const [id, e] of project.sessions) {
          if (e.repoKey === key && lifecycleOf(e.session.eventsFrom(0)) === "open") {
            blockers.push(id);
          }
        }
      }
      if (blockers.length > 0) {
        return sendError(
          `cannot detach: ${blockers.length} open session${blockers.length === 1 ? "" : "s"} (${blockers.join(", ")})`,
        );
      }
      if (!entry.root) return sendError(`repo "${key}" was launched without a root and cannot be re-attached — detach refused`);
      entry.attached = false;
      entry.workspace = null;
      entry.defaultBranch = null;
    }
    io.send({ type: "repo_detached", repoKey: key }); // idempotent ack
  }
  relay?.sendRepos();
  for (const project of projects.values()) pushProject(project);
  return;
}
```

- [ ] **Step 1: Failing tests**, one `it()` each: attach a scanned candidate → `repo_attached`, then `create_session` with its key succeeds (proves the workspace exists — use `opts.workspaceFor` returning a recording fake and `opts.defaultBaseRef: () => "origin/main"`); attach an unknown key → `/not in this machine's repo list/`; attach twice → second is a bare ack (no error, still attached); detach with an open session bound to the key → error containing the session's NAME (`/cannot detach: 1 open session \(auth-fix\)/`); detach with only an ENDED session → `repo_detached` (needs a fixture that ends the session first — check how `lifecycle.test.ts` produces a closed lifecycle); detach then attach again → works (candidate kept); unauthed attach with auth ON → refused (mirror the C1 gate tests' auth fixture in `server.test.ts`).
- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green; revert-and-rerun** the blocker check (drop the lifecycle filter → the ended-session detach test FAILS; drop the check entirely → the blocker test FAILS).
- [ ] **Step 5: Rebuild + downstream typecheck + commit**

```bash
git add poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat(server): attach_repo/detach_repo — candidate-only, blocker-refused"
```

---

### Task 7: Hub routing for attach_repo/detach_repo

**Model:** sonnet

**Files:**
- Modify: `poc/hub/src/hub.ts` (new branch between `create_session` and `HUB_HANDLED`)
- Test: `poc/hub/test/routing.test.ts` (extend)

**Interfaces:**
- Consumes: `store.machinesIn`, `uplinks`, `channel.pendingReplyFrom` (existing), Task 5's `MachineInfo.repos`.
- Produces: hub-side routing for `attach_repo { projectId, machineId, repoKey }` / `detach_repo { ... }` — gates in `create_session`'s exact order (spec §9): identify → membership → project active → machine resolution → grant → tunnel.

```ts
if (msg?.type === "attach_repo" || msg?.type === "detach_repo") {
  if (!channel.identity) return error("identify first");
  const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
  if (!SLUG.test(projectId)) return error(`${msg.type} requires a valid projectId`);
  if (!store.isMember(projectId, channel.identity.userId)) {
    return error("join this project before changing its machines");
  }
  if (store.lifecycleOf(projectId) !== "active") {
    return error(`project "${projectId}" is not open`);
  }
  const machineId = typeof msg.machineId === "string" ? msg.machineId : "";
  const repoKey = typeof msg.repoKey === "string" ? msg.repoKey : "";
  if (!machineId || !repoKey) return error(`${msg.type} requires machineId and repoKey`);
  const machine = store.machinesIn(projectId).find((m) => m.machineId === machineId);
  const uplink = machine?.online ? uplinks.get(machineId) : undefined;
  if (!machine || !uplink) return error(`machine "${machineId}" is not online right now`);
  // Refuse before tunneling (spec §9): a key the machine never advertised
  // would only burn the channel's one reply slot on a doomed round trip.
  if (!machine.repos.some((r) => r.key === repoKey)) {
    return error(`machine "${machineId}" does not list repo "${repoKey}"`);
  }
  channel.pendingReplyFrom = machineId;
  down(uplink, { t: "tunnel", channelId, identity: channel.identity, payload: msg });
  return;
}
```

- [ ] **Step 1: Failing tests** in `routing.test.ts` (its existing fake-uplink pattern): tunnel arrives at the named machine with identity stamped and the grant set; non-member → refused; offline machine → `is not online`; key not in the machine's list → `does not list`; reply from the machine reaches the asking browser (grant spent).
- [ ] **Step 2: Verify failures.** **Step 3: Implement.** **Step 4: Green + revert-and-rerun the offer check.**
- [ ] **Step 5: Commit**

```bash
cd poc/hub && npx tsc --noEmit && npx vitest run
git add poc/hub/src/hub.ts poc/hub/test/routing.test.ts
git commit -m "feat(hub): route attach_repo/detach_repo to the named machine"
```

---

### Task 8: CLI wiring — identity, roots, launch failures

**Model:** sonnet

**Files:**
- Modify: `poc/server/src/cli.ts` (`CliArgs:10-20`, `parseArgs:22-71`, `launch:141-185`)
- Test: `poc/server/test/cli.test.ts` (extend)

**Interfaces:**
- Consumes: `loadMachineIdentity`, `mpaiHome` (Task 1); `scanRepoRoots` (Task 2); Task 3's startServer opts.
- Produces: flags `--root <path>` (repeatable, `roots: string[]` on CliArgs) and `--machine-name <name>`; launch-refusal behavior for corrupt identity / bad root / over-cap scan.

**parseArgs additions:**

```ts
// in CliArgs:
roots: string[];            // initialize [] in the defaults literal
machineName?: string;

// in the flag loop:
} else if (flag === "--root") {
  const value = rest.shift();
  if (!value) return { ...args, error: "--root requires a path" };
  args.roots.push(value);
} else if (flag === "--machine-name") {
  const value = rest.shift();
  if (!value) return { ...args, error: "--machine-name requires a name" };
  args.machineName = value.slice(0, 40);
}
```

**launch() additions (before startServer):**

```ts
let identity: MachineIdentity;
try {
  identity = loadMachineIdentity(mpaiHome());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
}
const machineName = args.machineName ?? identity.name;
let candidates: RepoCandidate[] = [];
try {
  // Flag wins over machine.json's roots when both are present (spec §4).
  const roots = args.roots.length > 0 ? args.roots : identity.roots;
  candidates = scanRepoRoots(roots);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
}
// One WorkspaceManager, constructed once and reused by the startServer call
// below (replace the inline `new WorkspaceManager(...)` there with this).
const workspace = new WorkspaceManager(repoRoot, worktreesRoot);
// The cwd repo enters pre-attached inside startServer; a scanned candidate
// with the same key would collide, so drop it from the candidate list here.
candidates = candidates.filter((c) => c.key !== workspace.repoKey());
```

and the startServer call gains:

```ts
workspace,
workspaceLabel: path.basename(repoRoot),
workspaceRoot: repoRoot,
machine: { machineId: identity.machineId, name: machineName },
repoCandidates: candidates,
...(args.hub ? { hub: { url: args.hub, projectId: args.project, uplinkId: identity.machineId } } : {}),
```

- [ ] **Step 1: Failing tests** in `cli.test.ts` (it already tests `parseArgs` pure): `--root` repeats accumulate; `--root` without value errors; `--machine-name` sliced to 40; defaults have `roots: []`. For `launch()` failures, follow `cli.test.ts`'s existing pattern for exercising `main()` (if it only tests parseArgs today, test the pure pieces: parseArgs + a small extracted `resolveLaunchIdentity(args, home)` helper if needed — prefer extracting a pure helper over an un-testable inline block).
- [ ] **Step 2-4: Standard RED → implement → GREEN → revert-and-rerun** (drop the flag-wins-over-config rule → its test fails).
- [ ] **Step 5: Commit**

```bash
cd poc/server && npx tsc --noEmit && npx vitest run && npm run build
git add poc/server/src/cli.ts poc/server/test/cli.test.ts
git commit -m "feat(cli): machine identity, --root allowlist, --machine-name"
```

---

### Task 9: Client — types, repo choices, create form

**Model:** opus

**Files:**
- Modify: `poc/client/src/types.ts` (`MachineInfo:87`, delete `RepoInfo:136`, add `RepoDecl`)
- Create: `poc/client/src/repoChoices.ts` + `poc/client/src/repoChoices.test.ts`
- Modify: `poc/client/src/components/SessionPicker.tsx` (state `:30-35`, fallback `:88-99`, send `:122-130`, select `:201-213`)

**Interfaces:**
- Consumes: Task 4's snapshot shape (`machines` with `name`/`repos`, no `repo` field).
- Produces (Tasks 10-11 rely on):

```ts
// types.ts
export type RepoDecl = { key: string; label: string; attached: boolean; defaultBranch: string | null };
export type MachineInfo = { machineId: string; name: string; repos: RepoDecl[]; online: boolean };
// RepoInfo is DELETED (D10). Remove every import of it.

// repoChoices.ts
export type RepoChoice = {
  machineId: string;
  machineName: string;
  repoKey: string;
  label: string;              // "<repo label> — <machine name>"
  defaultBranch: string | null;
};
/** One option per (online machine, attached repo) pair, in machine order. */
export function repoChoices(machines: MachineInfo[]): RepoChoice[];
/** Explicit pick when it still exists, else the first choice, else null. */
export function chooseRepo(choices: RepoChoice[], picked: { machineId: string; repoKey: string } | null): RepoChoice | null;
/** repoKey → label map from every machine's list (attached or not); when two
 *  distinct keys share a label, suffix each with a short key prefix (spec §8). */
export function repoLabels(machines: MachineInfo[]): Map<string, string>;
```

**SessionPicker changes:** state `repoKey`/`repo` → `picked: { machineId: string; repoKey: string } | null` and drop the `repo` state + `RepoInfo` import entirely; `const choices = repoChoices(machines)`; `const chosen = chooseRepo(choices, picked)`; base-ref prefill `const baseValue = baseRef ?? chosen?.defaultBranch ?? ""` and **reset `baseRef` to null when the selection changes** (a `<select onChange>` that calls `setPicked(...)` and `setBaseRef(null)` — this is D9's re-prefill); `canCreate` requires `chosen !== null`; the send becomes:

```ts
wsRef.current?.send(JSON.stringify({
  type: "create_session",
  projectId: props.projectId,
  name: finalName,
  repoKey: chosen.repoKey,
  machineId: chosen.machineId,
  ...(baseValue.trim() ? { baseRef: baseValue.trim() } : {}),
}));
```

the select renders `choices` with `value={`${c.machineId}:${c.repoKey}`}` and label `c.label`; `onChange` splits on the FIRST `:` only (repoKeys contain `:` in `local:` form — split with `indexOf(":")`, not `.split(":")`).

- [ ] **Step 1: Failing tests** (`repoChoices.test.ts`, pure): pairs — 1 machine × 2 attached repos → 2 choices, unattached candidates excluded, offline machines excluded; labels — `"api — franks-mbp"`; `chooseRepo` — explicit pick survives a snapshot refresh, a pick whose machine went offline falls back to first, empty → null; `repoLabels` — collision: two keys labeled `api` → both values distinct and prefixed (assert `new Set(values).size === 2`).
- [ ] **Step 2: Verify failures. Step 3: Implement** module + types + SessionPicker.
- [ ] **Step 4: `npx tsc -b` clean is the component's compile gate; suite green; revert-and-rerun** the offline-machine exclusion and the collision suffix.
- [ ] **Step 5: Commit**

```bash
cd poc/client && npx tsc -b && npx vitest run && npm run build
git add poc/client/src/types.ts poc/client/src/repoChoices.ts poc/client/src/repoChoices.test.ts poc/client/src/components/SessionPicker.tsx
git commit -m "feat(client): (machine, repo) create choices with per-repo base prefill"
```

---

### Task 10: Client — MACHINES panel

**Model:** sonnet

**Files:**
- Create: `poc/client/src/machineRows.ts` + `poc/client/src/machineRows.test.ts`
- Create: `poc/client/src/components/MachinesPanel.tsx`
- Modify: `poc/client/src/components/SessionPicker.tsx` (render the panel under the session list when `refusal === null`; pass a `send` callback and the shared error/pending plumbing)

**Interfaces:**
- Consumes: `MachineInfo` (Task 9).
- Produces:

```ts
// machineRows.ts
export type MachineRow = {
  machineId: string;
  name: string;
  online: boolean;
  attached: RepoDecl[];     // DETACH targets
  candidates: RepoDecl[];   // ATTACH targets (repos with attached === false)
};
export function machineRows(machines: MachineInfo[]): MachineRow[];
```

- `MachinesPanel` props: `{ machines: MachineInfo[]; onAttach: (machineId: string, repoKey: string) => void; onDetach: (machineId: string, repoKey: string) => void; pending: boolean; error: string | null }`. Rendered ONLY when `refusal === null` (spec §8 — absent, not disabled). Buttons: `ATTACH ▸` per candidate, `DETACH ▸` per attached repo, disabled while `pending`. Offline machines render rows with no buttons (nothing can be routed to them).
- SessionPicker sends `{ type: "attach_repo", projectId, machineId, repoKey }` / `detach_repo`, reusing the EXISTING create-timer pattern verbatim (`CREATE_TIMEOUT_MS`, arm before send, clear on `repo_attached`/`repo_detached`/`error` — add those two message types to the `ws.onmessage` switch, clearing the timer and `pending`).

- [ ] **Step 1: Failing tests** (`machineRows.test.ts`): attached/candidate split; offline machine keeps its row (sessions outlive machines — hiding it would orphan its rows); empty machines → `[]`.
- [ ] **Step 2-4: RED → implement → GREEN → revert-and-rerun** the split (swap the filter → both split tests fail).
- [ ] **Step 5: Commit**

```bash
cd poc/client && npx tsc -b && npx vitest run && npm run build
git add poc/client/src/machineRows.ts poc/client/src/machineRows.test.ts poc/client/src/components/MachinesPanel.tsx poc/client/src/components/SessionPicker.tsx
git commit -m "feat(client): MACHINES panel — attach/detach from the project screen"
```

---

### Task 11: Client — names everywhere UUIDs render (W4)

**Model:** sonnet

**Files:**
- Modify: `poc/client/src/components/SessionPicker.tsx` (group heads `:160-162`, row line `:173-179`)
- Modify: `poc/client/src/repoGroups.ts` (no shape change — heads get labels at the render site via `repoLabels`)
- Modify: `poc/client/src/projectList.ts` + test (entrance line unchanged in shape; verify it still compiles against the new `MachineInfo` — it reads only `.online`, which survives)

**Interfaces:** Consumes `repoLabels` (Task 9) and a machine name lookup: `const machineNames = new Map(machines.map((m) => [m.machineId, m.name]))`.

- Group head: `labels.get(group.repoKey) ?? group.repoKey ?? "unknown repo"` (raw-key fallback for a repo no machine offers — ended sessions, spec §8).
- Session row `spwho` line: `labels.get(s.repoKey) ?? s.repoKey ?? "unknown repo"` and `machineNames.get(s.machineId) ?? s.machineId ?? "unknown machine"`.
- Screen head: `{online.length} MACHINES` stays (counts, not names — the panel now shows names).

- [ ] **Step 1: Failing test** — extend `repoChoices.test.ts` with a `repoLabels` fallback case if not already pinned (key present in no machine's list → caller-side fallback is exercised in TSX, so the pure pin is: `repoLabels` simply omits it, `expect(labels.has("gone-key")).toBe(false)`).
- [ ] **Step 2-4: RED → implement → GREEN.**
- [ ] **Step 5: Commit**

```bash
cd poc/client && npx tsc -b && npx vitest run && npm run build
git add poc/client/src/components/SessionPicker.tsx poc/client/src/repoGroups.ts poc/client/src/projectList.ts
git commit -m "feat(client): repo labels and machine names replace raw keys (W4)"
```

---

### Task 12: Seam scenarios — real relay against real hub

**Model:** opus

**Files:**
- Modify: `poc/hub/test/relayIntegration.test.ts` (new describe block; extend `laptopThatAnswers` so its `createConnection` builds a REAL `startServer`-less command plane is NOT possible here — instead give it an `onCommand` override: `laptopThatAnswers(port, over, onCommand?: (msg: any, io: { send: (m: unknown) => void }) => boolean)` where a truthy return means "handled")

**Interfaces:** Consumes everything shipped in Tasks 5-7. All reply scenarios use `laptopThatAnswers` (the `laptop()` helper's command plane is a no-op — gotcha pinned in the handoff).

The five scenarios (spec §11), each its own `it(...)`, poll-to-deadline style like the existing block, `TIMEOUT` for each:

1. **Attach round-trip.** Browser identifies, then `join_project { projectId: "default" }` — NOT `create_project`: the laptop's hello already `ensureProject`ed `default` memberless, so a create refuses with `already exists`; `join_project` is the membership fixture that works. Then it sends `attach_repo { projectId: "default", machineId: "lap-1", repoKey: "github.com/acme/web" }`. The laptop's `onCommand` answers `{ type: "repo_attached", repoKey }` and the test then drives `relay.sendRepos()` with the updated list (the real server does this; here the test IS the server side). Assert: browser receives `repo_attached`; a subsequent `watch_project` snapshot's `machines[0].repos` contains `web` with `attached: true`.
2. **Detach refusal end-to-end.** `onCommand` answers `detach_repo` with `{ type: "error", message: "cannot detach: 1 open session (auth)" }`. Assert the browser receives that exact message — proving refusal text survives the tunnel + grant path.
3. **Restart reclaim.** Laptop publishes facts for session `auth`; `relay.stop()`; NEW `Relay` with the SAME `uplinkId` (fresh runId); publish facts again → assert the hub's snapshot still lists exactly one `auth` owned session and no `already owned by another machine` line was logged (spy on `console.error`). This is debt §2.3's seam-level pin.
4. **v1 hello rejected.** Raw `ws` to `/uplink`, send `{ t: "hello", v: 1, uplinkId: "old", projectId: "default", repoKey: "x" }` → socket closes with code 1008 (`bad frame`).
5. **Blocker (d) regression across the wire.** ONE laptop offering TWO attached repos (`api`, `web`). Browser sends `create_session { projectId, name: "s1", repoKey: <web's key>, machineId: "lap-1" }`. `onCommand` records the arriving message and answers `session_created`. Assert the tunneled `create_session`'s `repoKey` IS web's key (the hub forwarded it untouched) — and, per the discriminating-fixture rule, that a SECOND create naming `api` arrives with api's key. (The unit-level wrong-workspace assertion lives in Task 3; this leg proves the wire carries the choice.)

- [ ] **Step 1: Write all five failing** (they fail against stubs until wired). **Step 2: Verify each fails for its named reason. Step 3: Wire helpers. Step 4: Green; revert-and-rerun scenario 5** by reverting Task 5's routing match to first-online-match-ignoring-machineId → scenario 5's second assertion must fail.
- [ ] **Step 5: Commit**

```bash
cd poc/hub && npx tsc --noEmit && npx vitest run
git add poc/hub/test/relayIntegration.test.ts
git commit -m "test(hub): seam scenarios — attach round-trip, reclaim, v2 gate"
```

---

### Task 13: Docs, debt ledger, walk brief

**Model:** sonnet (haiku may draft the ledger summaries)

**Files:**
- Modify: `docs/tech-debt.md` (§2.3 restart reclaim → resolved, pointer to the named hubStore test; §1.5b → largely dissolved, note what remains; W4 → resolved)
- Modify: `docs/PRD.md` (§8.3 "Today" paragraph → describe what now ships; sweep the OTHER sections' "Today" paragraphs against the new reality — machines/repos claims elsewhere may now be stale)
- Create: `.superpowers/sdd/2026-07-28-machines-repos/task-walk-brief.md` — the live walk script (git-ignored scratch)

**Walk brief content (spec §11's live walk, written as numbered commands with expected output):** two daemons on one laptop via `MPAI_HOME=/tmp/mpai-a` / `MPAI_HOME=/tmp/mpai-b` env overrides; hub launch **requires `CLIENT_DIST=<abs path to poc/client/dist>` and reads `PORT`, not `--port`** (walk finding W1 — as written elsewhere the hub 404s); attach a second repo from the MACHINES panel; create a session in it via the select's second entry; hit the detach refusal and read the blocker text; restart daemon A and watch its sessions reclaim (no ownership refusal in hub logs); verify a fresh solo `mpai` launch still lands on the one-item entrance (regression: I4).

- [ ] **Step 1: Write the three docs.** No test cycle — but every debt claim must name the test or commit that discharges it.
- [ ] **Step 2: Commit**

```bash
git add docs/tech-debt.md docs/PRD.md
git commit -m "docs: §8.3 shipped — debt 2.3/1.5b/W4 discharged, Today refreshed"
```

- [ ] **Step 3 (orchestrator, not a subagent): run the walk.** Fable executes the walk brief live, records findings in the ledger, and only then opens the PR: `feature/machines-repos` → `main`, disclosing any parked bounds (spec §12) in the body. **Merging is the user's call, never ours.**

---

## Self-review (performed while writing; re-verify at execution)

- **Spec coverage:** §3→T1/T8; §4→T2/T8; §5.1-5.2→T5; §5.3→T6/T7; §6→T3/T4/T6; §7→T5; §8→T9/T10/T11; §9→T6/T7/T8; §11→every task's tests + T12/T13; §12 disclosures→T13 PR body. D7 (baseRef stays) needs NO task — pinned by T3's base-ref fallback test reusing the existing field.
- **Known coupling:** T5 touches three packages in one commit by design (D6, no shim). T3/T4 leave the LIVE client briefly behind the server shapes — the branch is not walkable until T9 lands; the walk is deliberately last.
- **Type consistency spot-checks:** `RepoDecl` defined once (relayProtocol.ts), imported everywhere server-side; client mirrors it in types.ts (the codebase's existing duplication pattern — see MachineInfo today). `machineView()` (T3) feeds both `projectSnapshot` and `projectSummaryOf` (T4). `repoChoices`/`repoLabels`/`machineRows` names match between T9's produces and T10/T11's consumes.
