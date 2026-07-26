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
