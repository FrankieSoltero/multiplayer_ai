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

function branchOf(workdir: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workdir,
    encoding: "utf8",
  }).trim();
}

function mpaiBranches(repo: string): string[] {
  return execFileSync("git", ["branch", "--list", "--format=%(refname:short)", "mpai/*"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

describe("WorkspaceManager", () => {
  it("provisions a worktree at .mpai/worktrees/<projectId>/<slug> on mpai/<projectId>/<slug>", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const result = wm.provision("acme", "auth", "main");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workdir).toBe(path.join(repo, ".mpai", "worktrees", "acme", "auth"));
    expect(fs.existsSync(result.workdir)).toBe(true);
    expect(branchOf(result.workdir)).toBe("mpai/acme/auth");
  });

  it("isolates the same slug across projects — two worktrees, two branches (debt §2.1)", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const acme = wm.provision("acme", "auth", "main");
    const beta = wm.provision("beta", "auth", "main");
    expect(acme.ok).toBe(true);
    expect(beta.ok).toBe(true);
    if (!acme.ok || !beta.ok) return;
    // Neither project reuses the other's worktree.
    expect(acme.workdir).not.toBe(beta.workdir);
    expect(acme.workdir).toBe(path.join(repo, ".mpai", "worktrees", "acme", "auth"));
    expect(beta.workdir).toBe(path.join(repo, ".mpai", "worktrees", "beta", "auth"));
    expect(fs.existsSync(acme.workdir)).toBe(true);
    expect(fs.existsSync(beta.workdir)).toBe(true);
    expect(branchOf(acme.workdir)).toBe("mpai/acme/auth");
    expect(branchOf(beta.workdir)).toBe("mpai/beta/auth");
    expect(mpaiBranches(repo).sort()).toEqual(["mpai/acme/auth", "mpai/beta/auth"]);
  });

  it("is idempotent within a project: an existing worktree dir is reused as-is", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const first = wm.provision("acme", "auth", "main");
    const second = wm.provision("acme", "auth", "definitely-not-a-ref");
    expect(second).toEqual(first); // no ref check on the reuse path
  });

  it("rejects an unknown base ref", () => {
    const repo = makeRepo();
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const result = wm.provision("acme", "feat", "nope");
    expect(result).toEqual({ ok: false, error: "unknown base ref: nope" });
  });

  it("rejects a slug whose project-scoped branch already exists without its worktree", () => {
    const repo = makeRepo();
    execFileSync("git", ["branch", "mpai/acme/auth"], { cwd: repo });
    const wm = new WorkspaceManager(repo, path.join(repo, ".mpai", "worktrees"));
    const result = wm.provision("acme", "auth", "main");
    expect(result).toEqual({
      ok: false,
      error: "session name taken (branch mpai/acme/auth exists)",
    });
    // The check is evaluated against the project-scoped name, so the same slug
    // under a different project is unaffected.
    const other = wm.provision("beta", "auth", "main");
    expect(other.ok).toBe(true);
  });

  it("never reuses, deletes or migrates an old flat-scheme worktree dir", () => {
    const repo = makeRepo();
    const worktreesRoot = path.join(repo, ".mpai", "worktrees");
    const legacy = path.join(worktreesRoot, "auth");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "LEGACY"), "flat-scheme\n");
    const wm = new WorkspaceManager(repo, worktreesRoot);
    const result = wm.provision("acme", "auth", "main");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workdir).toBe(path.join(worktreesRoot, "acme", "auth")); // not reused
    expect(result.workdir).not.toBe(legacy);
    // Untouched: still there, still holding its contents.
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.readFileSync(path.join(legacy, "LEGACY"), "utf8")).toBe("flat-scheme\n");
    expect(fs.readdirSync(legacy)).toEqual(["LEGACY"]); // nothing migrated into it
  });

  it("throws on a non-SLUG projectId and creates nothing", () => {
    const repo = makeRepo();
    const worktreesRoot = path.join(repo, ".mpai", "worktrees");
    const wm = new WorkspaceManager(repo, worktreesRoot);
    for (const bad of ["../escape", "Acme", "", "x".repeat(41), "a/b", "."]) {
      expect(() => wm.provision(bad, "auth", "main")).toThrow(`invalid projectId: ${bad}`);
    }
    expect(fs.existsSync(worktreesRoot)).toBe(false); // no directory created
    expect(mpaiBranches(repo)).toEqual([]); // no branch created
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

describe("WorkspaceManager.repoKey", () => {
  it("normalizes the origin remote when one is configured", () => {
    const dir = makeRepo();
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/api.git"], { cwd: dir });
    const wm = new WorkspaceManager(dir, path.join(dir, ".mpai", "worktrees"));
    expect(wm.repoKey()).toBe("github.com/acme/api");
  });

  it("falls back to a machine-local key when there is no origin", () => {
    const dir = makeRepo();
    const wm = new WorkspaceManager(dir, path.join(dir, ".mpai", "worktrees"));
    // No remote configured — must never produce a key another machine could match.
    expect(wm.repoKey().startsWith("local:")).toBe(true);
  });

  it("is stable across calls", () => {
    const dir = makeRepo();
    const wm = new WorkspaceManager(dir, path.join(dir, ".mpai", "worktrees"));
    expect(wm.repoKey()).toBe(wm.repoKey());
  });
});
