import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as collisions from "../src/collisions.js";
import { PATH_WIRE_CAP, TOUCH_CAP, TOUCH_SENTINEL, touchedFiles } from "../src/touched.js";

/** Every fixture below is a REAL git repo in a temp dir — git is never mocked,
 *  because the whole point of this module is that git's own output shapes
 *  (porcelain rename lines, merge-base semantics, repo-relative paths) are
 *  parsed correctly. */
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mpai-touched-"));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function write(repo: string, rel: string, body: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function commit(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "--no-gpg-sign", "-m", message);
}

/** Repo on `main` with one seed commit; HEAD === main, nothing dirty. */
function seedRepo(): string {
  const repo = tmp();
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "touched@example.test");
  git(repo, "config", "user.name", "Touched Test");
  write(repo, "README.md", "seed\n");
  commit(repo, "seed");
  return repo;
}

/** Runs `fn` with `process.stderr.write` captured. The captured lines are read
 *  out BEFORE the spy is restored — `mockRestore()` also resets recorded
 *  calls, so asserting on the spy afterwards would pass vacuously. */
function captureStderr<T>(fn: () => T): { value: T; lines: string[] } {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const value = fn();
    return { value, lines: spy.mock.calls.map((call) => String(call[0])) };
  } finally {
    spy.mockRestore();
  }
}

/** A path whose length exceeds `PATH_WIRE_CAP`, built from directory segments
 *  short enough to stay under every filesystem's per-component limit. */
function overLongPath(leaf: string): string {
  const seg = "d".repeat(100);
  const rel = [seg, seg, seg, seg, seg, seg, leaf].join("/");
  if (rel.length <= PATH_WIRE_CAP) throw new Error(`fixture too short: ${rel.length}`);
  return rel;
}

describe("touched constants", () => {
  it("re-exports the canonical wire constants from collisions.ts unchanged", () => {
    expect(TOUCH_CAP).toBe(collisions.TOUCH_CAP);
    expect(TOUCH_SENTINEL).toBe(collisions.TOUCH_SENTINEL);
    expect(PATH_WIRE_CAP).toBe(collisions.PATH_WIRE_CAP);
    expect(TOUCH_CAP).toBe(500);
    expect(TOUCH_SENTINEL).toBe("…");
    expect(PATH_WIRE_CAP).toBe(512);
  });
});

describe("touchedFiles — committed divergence", () => {
  it("returns paths changed since the merge-base, excluding base-side-only changes", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    write(repo, "src/feat.ts", "mine\n");
    commit(repo, "feature work");

    // The base advances AFTER the branch point — its own changes must not appear.
    git(repo, "checkout", "main");
    write(repo, "src/base-only.ts", "theirs\n");
    commit(repo, "base work");
    git(repo, "checkout", "feature");

    expect(touchedFiles(repo, "main")).toEqual(["src/feat.ts"]);
  });

  it("uses the merge-base, not a plain two-dot diff against the advanced base tip", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    write(repo, "a.ts", "mine\n");
    commit(repo, "feature work");
    git(repo, "checkout", "main");
    write(repo, "b.ts", "theirs\n");
    write(repo, "README.md", "base rewrote the seed\n");
    commit(repo, "base work");
    git(repo, "checkout", "feature");

    const out = touchedFiles(repo, "main");
    expect(out).toEqual(["a.ts"]);
    expect(out).not.toContain("b.ts");
    expect(out).not.toContain("README.md");
  });
});

describe("touchedFiles — uncommitted work", () => {
  it("includes staged, unstaged and untracked paths when nothing is committed", () => {
    const repo = seedRepo();
    write(repo, "README.md", "modified, unstaged\n");
    write(repo, "staged.ts", "staged\n");
    git(repo, "add", "staged.ts");
    write(repo, "untracked.ts", "untracked\n");

    expect(touchedFiles(repo, "main")).toEqual(["README.md", "staged.ts", "untracked.ts"]);
  });

  it("includes a deleted file's path", () => {
    const repo = seedRepo();
    write(repo, "gone.ts", "x\n");
    commit(repo, "add gone");
    fs.rmSync(path.join(repo, "gone.ts"));

    expect(touchedFiles(repo, "main")).toContain("gone.ts");
  });
});

describe("touchedFiles — union, dedupe, sort", () => {
  it("lists a path changed both in a commit and in the worktree exactly once, sorted", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    write(repo, "src/both.ts", "committed\n");
    write(repo, "src/zeta.ts", "committed\n");
    commit(repo, "feature work");
    write(repo, "src/both.ts", "and re-modified in the worktree\n");
    write(repo, "src/alpha.ts", "untracked\n");

    const out = touchedFiles(repo, "main");
    expect(out).toEqual(["src/alpha.ts", "src/both.ts", "src/zeta.ts"]);
    expect(out.filter((p) => p === "src/both.ts")).toHaveLength(1);
    expect(out).toEqual([...out].sort());
  });
});

describe("touchedFiles — renames", () => {
  it("contributes both sides of a committed rename", () => {
    const repo = seedRepo();
    write(repo, "a.ts", "content that is stable enough to be detected as a rename\n");
    commit(repo, "add a");
    git(repo, "checkout", "-b", "feature");
    git(repo, "mv", "a.ts", "b.ts");
    commit(repo, "rename a -> b");

    const out = touchedFiles(repo, "main");
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });

  it("contributes both sides of a staged rename (porcelain `R  old -> new`)", () => {
    const repo = seedRepo();
    write(repo, "src/old-name.ts", "content that is stable enough to be a rename\n");
    commit(repo, "add old-name");
    git(repo, "mv", "src/old-name.ts", "src/new-name.ts");

    // Guard the fixture: this row exists to exercise the porcelain rename line.
    const porcelain = git(repo, "status", "--porcelain");
    expect(porcelain).toMatch(/^R\s+src\/old-name\.ts -> src\/new-name\.ts$/m);

    const out = touchedFiles(repo, "main");
    expect(out).toContain("src/old-name.ts");
    expect(out).toContain("src/new-name.ts");
  });
});

describe("touchedFiles — repo-relative paths", () => {
  it("emits posix, repo-root-relative paths with no leading ./ for nested files", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    write(repo, "deep/nested/dir/committed.ts", "x\n");
    commit(repo, "nested commit");
    write(repo, "deep/nested/dir/untracked.ts", "y\n");

    const out = touchedFiles(repo, "main");
    expect(out).toEqual(["deep/nested/dir/committed.ts", "deep/nested/dir/untracked.ts"]);
    for (const p of out) {
      expect(p.startsWith("./")).toBe(false);
      expect(p.startsWith("/")).toBe(false);
      expect(p).not.toContain("\\");
      expect(path.posix.normalize(p)).toBe(p);
    }
  });

  it("lists untracked FILES in a brand-new directory, not the directory itself", () => {
    const repo = seedRepo();
    write(repo, "brand/new/dir/one.ts", "x\n");
    write(repo, "brand/new/dir/two.ts", "y\n");

    const out = touchedFiles(repo, "main");
    expect(out).toEqual(["brand/new/dir/one.ts", "brand/new/dir/two.ts"]);
    expect(out).not.toContain("brand/");
  });
});

describe("touchedFiles — over-long paths", () => {
  it("drops paths longer than PATH_WIRE_CAP and logs ONE line per call", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    const long1 = overLongPath("one.ts");
    const long2 = overLongPath("two.ts");
    write(repo, long1, "x\n");
    write(repo, long2, "y\n");
    write(repo, "ok.ts", "z\n");
    commit(repo, "two over-long paths and one fine one");

    const { value: out, lines: logged } = captureStderr(() => touchedFiles(repo, "main"));

    expect(out).toEqual(["ok.ts"]);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(PATH_WIRE_CAP);
    // Two dropped paths in one call → ONE line with n = 2, never two lines.
    expect(logged).toEqual([`[touched] dropped 2 path(s) over ${PATH_WIRE_CAP} chars in ${repo}\n`]);
    // The path itself is never logged.
    expect(logged[0]).not.toContain(long1);
    expect(logged[0]).not.toContain(long2);
  });

  it("never truncates an over-long path into a different path", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    const long = overLongPath("solo.ts");
    write(repo, long, "x\n");
    commit(repo, "one over-long path");

    const { value: out, lines: logged } = captureStderr(() => touchedFiles(repo, "main"));

    expect(out).toEqual([]);
    expect(out.some((p) => long.startsWith(p))).toBe(false);
    expect(logged).toEqual([`[touched] dropped 1 path(s) over ${PATH_WIRE_CAP} chars in ${repo}\n`]);
  });

  it("writes NOTHING to stderr when no path is over the cap", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    write(repo, "src/fine.ts", "x\n");
    commit(repo, "fine");
    write(repo, "also-fine.ts", "y\n");

    const { value: out, lines: logged } = captureStderr(() => touchedFiles(repo, "main"));

    expect(out).toEqual(["also-fine.ts", "src/fine.ts"]);
    expect(logged).toEqual([]);
  });
});

describe("touchedFiles — cap and sentinel", () => {
  it("keeps the first TOUCH_CAP sorted paths and appends the sentinel", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    const names: string[] = [];
    for (let i = 0; i < TOUCH_CAP + 5; i++) {
      const rel = `src/f${String(i).padStart(4, "0")}.ts`;
      names.push(rel);
      write(repo, rel, "x\n");
    }
    commit(repo, "many files");

    const out = touchedFiles(repo, "main");
    expect(out).toHaveLength(TOUCH_CAP + 1);
    expect(out[TOUCH_CAP]).toBe(TOUCH_SENTINEL);
    expect(out.slice(0, TOUCH_CAP)).toEqual([...names].sort().slice(0, TOUCH_CAP));
  });

  it("does not cap or add a sentinel at exactly TOUCH_CAP paths", () => {
    const repo = seedRepo();
    git(repo, "checkout", "-b", "feature");
    for (let i = 0; i < TOUCH_CAP; i++) write(repo, `src/f${String(i).padStart(4, "0")}.ts`, "x\n");
    commit(repo, "exactly the cap");

    const out = touchedFiles(repo, "main");
    expect(out).toHaveLength(TOUCH_CAP);
    expect(out).not.toContain(TOUCH_SENTINEL);
  });
});

describe("touchedFiles — clean worktree", () => {
  it("returns [] with no divergence and nothing uncommitted", () => {
    const repo = seedRepo();
    expect(touchedFiles(repo, "main")).toEqual([]);
  });
});

describe("touchedFiles — git failure", () => {
  it("throws when the workdir is not a git repo, carrying git's stderr", () => {
    const dir = tmp();
    expect(() => touchedFiles(dir, "main")).toThrow(/not a git repository/i);
  });

  it("throws when the base ref does not exist", () => {
    const repo = seedRepo();
    expect(() => touchedFiles(repo, "no-such-ref")).toThrow();
  });

  it("rejects a base ref that would be read as a git option", () => {
    const repo = seedRepo();
    expect(() => touchedFiles(repo, "--upload-pack=touch /tmp/pwned")).toThrow(/invalid baseRef/);
    expect(() => touchedFiles(repo, "")).toThrow(/invalid baseRef/);
  });

  it(
    "throws when a git invocation exceeds the 5000 ms timeout",
    { timeout: 30000 },
    () => {
      // A stand-in `git` on PATH that hangs — the only way to observe the
      // timeout without waiting on a pathological real repo. The fixtures in
      // every other row are real git.
      const repo = seedRepo();
      const shimDir = tmp();
      const shim = path.join(shimDir, "git");
      fs.writeFileSync(shim, "#!/bin/sh\nexec sleep 30\n");
      fs.chmodSync(shim, 0o755);
      const savedPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ""}`;
      const started = Date.now();
      try {
        expect(() => touchedFiles(repo, "main")).toThrow();
      } finally {
        process.env.PATH = savedPath;
      }
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(15000);
    },
  );
});
