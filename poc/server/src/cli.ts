import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadMachineIdentity, mpaiHome, type MachineIdentity } from "./machineIdentity.js";
import { MAX_REPO_CANDIDATES, scanRepoRoots, type RepoCandidate } from "./machineRepos.js";
import { SLUG } from "./project.js";
import { startServer } from "./server.js";
import { ensureExcluded, WorkspaceManager } from "./workspace.js";

export interface CliArgs {
  cmd: "launch" | "new";
  name?: string;
  base?: string;
  port: number;
  project: string;
  open: boolean;
  /** Absent unless `--hub` was passed; only `launch` reads it. */
  hub?: string;
  /** Allowlisted roots for the repo candidate scan (spec §4), repeatable.
   *  Empty means "no --root flags" — machine.json's persisted roots apply. */
  roots: string[];
  /** One-launch display-name override (spec's D2); sliced to 40 chars to
   *  match the identity file's own bound and the hello frame's `name` field
   *  (spec §5.2). */
  machineName?: string;
  error?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cmd: "launch", port: 3001, project: "default", open: true, roots: [] };
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
      // Validated HERE because the failure it prevents is invisible. A
      // projectId the hub's `parseUpFrame` rejects makes every `hello` a
      // "bad frame" 1008 close, and the relay's error handling swallows it and
      // reconnects every 2s — while `launch()` has already printed "attached
      // to hub". A startup error beats an infinite silent loop.
      if (!SLUG.test(value)) {
        return { ...args, error: "--project requires 1-40 chars of a-z, 0-9, -" };
      }
      args.project = value;
    } else if (flag === "--hub") {
      const value = rest.shift();
      if (!value) return { ...args, error: "--hub requires a url" };
      if (!/^wss?:\/\//i.test(value)) {
        return { ...args, error: "--hub requires a ws:// or wss:// url" };
      }
      args.hub = value;
    } else if (flag === "--no-open") {
      args.open = false;
    } else if (flag === "--root") {
      const value = rest.shift();
      if (!value) return { ...args, error: "--root requires a path" };
      args.roots.push(value);
    } else if (flag === "--machine-name") {
      const value = rest.shift();
      if (!value) return { ...args, error: "--machine-name requires a name" };
      args.machineName = value.slice(0, 40);
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

/** The URL a non-hub launch opens and prints (solo-mode fix). A bare
 *  `http://localhost:PORT/` routes to the hub-shaped entrance
 *  (`ProjectPicker`), which the standalone server can now answer but which
 *  most solo users never need to see — the normal path should not depend on
 *  it. Carrying `?project=<args.project>` (`default` unless `--project` was
 *  passed) lands directly on the project screen instead, exactly like every
 *  other pre-entrance deep link. A hub-attached launch keeps the bare URL:
 *  it is a fallback single-machine view, not the primary experience, and
 *  is never auto-opened anyway (see the `!args.hub` guard below). */
export function localUrlFor(port: number, args: Pick<CliArgs, "project" | "hub">): string {
  const base = `http://localhost:${port}/`;
  if (args.hub) return base;
  return `${base}?project=${encodeURIComponent(args.project)}`;
}

/** The URL `mpai new` prints. `project` is always appended — omitting it for
 *  "default" would lean on the client's legacy `?session=`-implies-default
 *  fallback, which is a convention, not a contract. */
export function sessionUrlFor(port: number, sessionId: string, project: string): string {
  return `http://localhost:${port}/?session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`;
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

/** The roots to scan (spec §4): the `--root` flag wins over machine.json's
 *  persisted roots when both are present. Pure so the precedence rule has a
 *  test that needs neither a real identity file nor a real scan. */
export function resolveRoots(
  args: Pick<CliArgs, "roots">,
  identity: Pick<MachineIdentity, "roots">,
): string[] {
  return args.roots.length > 0 ? args.roots : identity.roots;
}

/** Drops the scanned candidate that collides with the cwd repo's key (it
 *  enters pre-attached inside `startServer`, so a scanned duplicate would
 *  collide) and enforces the launch-time cap COUNTING that pre-attached
 *  entry. `scanRepoRoots`'s own >100 throw only bounds the scan itself
 *  (`byKey.size`); the machine's final repo declarations are
 *  candidates.length + 1, so a scan of exactly 100 (none sharing the cwd's
 *  key) slips past that throw and would reach the hub as a 101-repo hello —
 *  which `parseUpFrame`'s ≤100 bound (spec §5.1/§5.2) rejects with a
 *  misleading "versions may not match" diagnosis while the relay reconnects
 *  forever. Pure over the already-scanned list so this boundary is a fast
 *  unit test instead of 100 real git repos on disk. */
export function finalizeCandidates(
  scanned: RepoCandidate[],
  cwdKey: string,
): { candidates: RepoCandidate[] } | { error: string } {
  const candidates = scanned.filter((c) => c.key !== cwdKey);
  const total = candidates.length + 1; // + the cwd repo itself
  if (total > MAX_REPO_CANDIDATES) {
    return {
      error:
        `repo scan found ${candidates.length} candidate repo(s); plus this launch's cwd ` +
        `repo, that's ${total} repos — over the ${MAX_REPO_CANDIDATES} cap; narrow --root`,
    };
  }
  return { candidates };
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
  let identity: MachineIdentity;
  try {
    identity = loadMachineIdentity(mpaiHome());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const machineName = args.machineName ?? identity.name;
  let scanned: RepoCandidate[];
  try {
    scanned = scanRepoRoots(resolveRoots(args, identity));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // One WorkspaceManager, constructed once and reused by the startServer call
  // below.
  const workspace = new WorkspaceManager(repoRoot, worktreesRoot);
  // The cwd repo enters pre-attached inside startServer; a scanned candidate
  // with the same key would collide, so drop it here, and refuse launch if
  // the total (candidates + the cwd repo) is over spec §5.2's 100-entry cap.
  const resolved = finalizeCandidates(scanned, workspace.repoKey());
  if ("error" in resolved) {
    console.error(resolved.error);
    return 1;
  }
  const candidates = resolved.candidates;
  try {
    const { port } = await startServer({
      port: args.port,
      workspace,
      workspaceLabel: path.basename(repoRoot),
      workspaceRoot: repoRoot,
      staticDir: distDir,
      projectId: args.project,
      machine: { machineId: identity.machineId, name: machineName },
      repoCandidates: candidates,
      ...(args.hub
        ? { hub: { url: args.hub, projectId: args.project, uplinkId: identity.machineId } }
        : {}),
    });
    const url = localUrlFor(port, args);
    if (args.hub) {
      // The local URL still works and is still served; it is just not where
      // the team is. Printing the hub first is the honest ordering, and not
      // auto-opening a browser at the local URL avoids sending someone to a
      // single-machine view of a multi-machine session.
      console.log(`multiplayer-ai attached to hub ${args.hub} (repo: ${repoRoot})`);
      console.log(`open the hub in your browser; this machine is also on ${url}`);
    } else {
      console.log(`multiplayer-ai on ${url} (repo: ${repoRoot})`);
    }
    if (args.open && !args.hub) openBrowser(url);
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
        console.log(sessionUrlFor(args.port, msg.sessionId, args.project));
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
      "usage: mpai [--port N] [--hub <ws-url>] [--project <id>] [--no-open] [--root <path>]... [--machine-name <name>] | mpai new <name> [--base <ref>] [--project <id>] [--port N]",
    );
    return 1;
  }
  if (args.cmd === "new") return createSession(args);
  return launch(args);
}
