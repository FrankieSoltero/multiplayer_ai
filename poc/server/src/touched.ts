/** `touched` — the git-derived set of repo-relative paths one session worktree
 *  has changed (spec §3.1). NODE-ONLY: it shells out to git, so nothing that
 *  the browser bundles may import it.
 *
 *  The three shared wire constants are DECLARED in `collisions.ts` (the
 *  isomorphic module) and re-exported here unchanged, so the isomorphic module
 *  never imports this node-only one and no consumer sees two copies of a
 *  literal. `PATH_WIRE_CAP` lives there rather than here because
 *  `relayProtocol.ts` must import it too and cannot import a node-only
 *  module. */
import { execFileSync } from "node:child_process";
import { PATH_WIRE_CAP, TOUCH_CAP, TOUCH_SENTINEL } from "./collisions.js";

export { TOUCH_CAP, TOUCH_SENTINEL, PATH_WIRE_CAP } from "./collisions.js";

/** EXACTLY 5000 ms per git invocation (spec §8a.8). This call sits on the
 *  permission-gate path (turn boundaries and pre-gate recompute) and
 *  `execFileSync` blocks the whole node event loop, so this figure is a
 *  WHOLE-SERVER freeze bound, not a per-gate one: for up to 5 s every other
 *  session's websocket traffic, the throttled project push, the uplink
 *  heartbeat and every other pending gate are frozen too. Accepted at this
 *  posture — a laptop process serves one developer and a healthy
 *  `git status`/`git diff` returns in tens of milliseconds, so the timeout is
 *  the pathological ceiling, not the expected cost. Revisit only on an
 *  observed freeze. */
const GIT_TIMEOUT_MS = 5000;

/** 500 paths of a few dozen chars is tens of KB; the ceiling exists only so a
 *  pathological repo fails loudly (and is treated as any other git failure)
 *  rather than being silently truncated mid-path. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Code-unit order — locale-independent, matching `collisions.ts`, so the
 *  laptop and every browser agree on which paths survive the cap. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One git invocation in `workdir`. argv-only (never shell-interpolated).
 *  THROWS on any failure, INCLUDING the timeout — the caller owns
 *  keep-previous-value semantics (stale beats absent, spec §3.1). */
function git(workdir: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    const detail = stderr.trim() || e.message || "unknown error";
    throw new Error(`git ${args.join(" ")} failed in ${workdir}: ${detail}`, { cause: err });
  }
}

function lines(out: string): string[] {
  return out.split("\n").filter((line) => line !== "");
}

/** Paths from `git status --porcelain` (v1). Layout is `XY<space>path`; a
 *  rename or copy entry is `R  old -> new` and BOTH sides contribute, because
 *  both are paths this session diverged on. `-uall` lists untracked FILES
 *  rather than collapsing a new directory into one `dir/` entry — a directory
 *  is not a path any other session can collide with. `core.quotePath=false`
 *  keeps non-ASCII paths unescaped. */
function statusPaths(workdir: string): string[] {
  const out = git(workdir, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const paths: string[] = [];
  for (const line of lines(out)) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const sep = rest.indexOf(" -> ");
      if (sep !== -1) {
        paths.push(rest.slice(0, sep), rest.slice(sep + 4));
        continue;
      }
    }
    paths.push(rest);
  }
  return paths;
}

/** Committed divergence: everything HEAD changed since it forked from
 *  `baseRef`. Computed against the MERGE-BASE, so changes the base has made on
 *  its own since the fork are not this session's. `--no-renames` keeps a
 *  rename as a delete + an add, so both sides contribute. */
function committedPaths(workdir: string, baseRef: string): string[] {
  const base = git(workdir, ["merge-base", baseRef, "HEAD"]).trim();
  return lines(git(workdir, ["diff", "--name-only", "--no-renames", `${base}..HEAD`]));
}

/** Repo-relative paths this worktree has changed relative to `baseRef` —
 *  committed divergence UNION uncommitted work (staged, unstaged, untracked),
 *  deduped, sorted ascending, capped.
 *
 *  Synchronous by design (see `GIT_TIMEOUT_MS`). THROWS on any git failure,
 *  including a timeout; the caller keeps its previous value. */
export function touchedFiles(workdir: string, baseRef: string): string[] {
  // argv-only exec already rules out shell injection; this rules out a ref
  // that git would read as an option instead of a revision.
  if (baseRef === "" || baseRef.startsWith("-")) {
    throw new Error(`touchedFiles: invalid baseRef ${JSON.stringify(baseRef)}`);
  }

  const all = new Set<string>();
  for (const p of committedPaths(workdir, baseRef)) all.add(p);
  for (const p of statusPaths(workdir)) all.add(p);

  // Producer rule: a path longer than the wire cap is DROPPED, never
  // truncated — a truncated path is a different path and would false-collide.
  // Dropping costs that one path; emitting it would cost the session's whole
  // facts frame, which the validator rejects wholesale. The drop is logged
  // once per call so the exemption is attributable, and the path itself is
  // never logged (a >512-char path in a log line is the same size problem one
  // layer down).
  const kept: string[] = [];
  let dropped = 0;
  for (const p of all) {
    if (p.length > PATH_WIRE_CAP) dropped++;
    else kept.push(p);
  }
  if (dropped > 0) {
    process.stderr.write(
      `[touched] dropped ${dropped} path(s) over ${PATH_WIRE_CAP} chars in ${workdir}\n`,
    );
  }

  kept.sort(cmp);
  if (kept.length > TOUCH_CAP) return [...kept.slice(0, TOUCH_CAP), TOUCH_SENTINEL];
  return kept;
}
