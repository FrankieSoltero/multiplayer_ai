import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SLUG } from "./project.js";
import { repoKeyFor } from "./repoKey.js";

export type ProvisionResult =
  | { ok: true; workdir: string }
  | { ok: false; error: string };

/** `.git/info/exclude` keeps `.mpai/` out of `git status` without touching the
 *  user's `.gitignore` (spec §5). Non-fatal on failure: worst case `.mpai/`
 *  shows as untracked. Lives here — beside `WorkspaceManager`, the thing that
 *  actually creates `.mpai/worktrees` — rather than in the CLI, so both the
 *  launch path (`cli.ts`, the cwd repo) and the attach path (`server.ts`'s
 *  `attach_repo` handler, any repo attached later from the MACHINES panel)
 *  can call the same function without the attach path importing CLI-only
 *  code. Idempotent: safe to call on every attach, not just the first. */
export function ensureExcluded(repoRoot: string): void {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const excludeFile = path.resolve(repoRoot, gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    if (!current.split("\n").includes(".mpai/")) {
      const sep = current === "" || current.endsWith("\n") ? "" : "\n";
      fs.writeFileSync(excludeFile, `${current}${sep}.mpai/\n`);
    }
  } catch {
    /* non-fatal */
  }
}

/** Structural interface so server tests can inject a fake. */
export interface WorkspaceLike {
  provision(projectId: string, slug: string, baseRef: string): ProvisionResult;
  defaultBranch(): string;
  /** Stable cross-machine identity for this repo (spec §3.3). */
  repoKey(): string;
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

  /** Worktrees are PROJECT-SCOPED (spec §7, §8a.3): the same session slug in
   *  two projects must never collide on one checkout, so the project id is
   *  part of the path (`<worktreesRoot>/<projectId>/<slug>`), the branch
   *  (`mpai/<projectId>/<slug>`) and therefore the identity used for
   *  idempotent reuse — the key is the `${projectId}/${slug}` pair, not the
   *  slug alone. Worktrees created by the older flat scheme
   *  (`<worktreesRoot>/<slug>`) are never reused, deleted or migrated: they
   *  are orphaned on disk by design (spec §8a ruling 7, accepted POC
   *  breakage), and no legacy-key compatibility read exists here.
   *
   *  `projectId` is validated HERE, as the first statement, rather than at the
   *  call sites: this is the function that turns the value into a filesystem
   *  path and a git branch name, so one guard at the point of use covers every
   *  caller and cannot be forgotten by a future one. A bad projectId is a
   *  caller bug (and `../` style traversal is exactly what `SLUG` rejects), so
   *  it throws rather than sanitising or falling back. */
  provision(projectId: string, slug: string, baseRef: string): ProvisionResult {
    if (!SLUG.test(projectId)) throw new Error(`invalid projectId: ${projectId}`);
    const workdir = path.join(this.worktreesRoot, projectId, slug);
    // Idempotent reuse — join semantics; the worktree's existing state wins.
    if (fs.existsSync(workdir)) return { ok: true, workdir };
    try {
      this.git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    } catch {
      return { ok: false, error: `unknown base ref: ${baseRef}` };
    }
    const branch = `mpai/${projectId}/${slug}`;
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
      fs.mkdirSync(path.dirname(workdir), { recursive: true });
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

  /** Stable identity for this repo, shared by every machine that cloned it.
   *  A repo with no `origin` gets a machine-local key that can never match
   *  another laptop's copy — silence beats a wrong match (spec §3.3). */
  repoKey(): string {
    let remote: string | null = null;
    try {
      remote = this.git(["remote", "get-url", "origin"]);
    } catch {
      remote = null;
    }
    return repoKeyFor(remote, { hostname: os.hostname(), repoRoot: this.repoRoot });
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
