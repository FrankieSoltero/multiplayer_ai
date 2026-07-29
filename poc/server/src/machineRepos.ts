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
