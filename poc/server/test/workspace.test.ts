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
