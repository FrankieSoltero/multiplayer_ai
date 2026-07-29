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
