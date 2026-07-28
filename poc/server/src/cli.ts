import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startServer } from "./server.js";
import { WorkspaceManager } from "./workspace.js";

export interface CliArgs {
  cmd: "launch" | "new";
  name?: string;
  base?: string;
  port: number;
  project: string;
  open: boolean;
  /** Absent unless `--hub` was passed; only `launch` reads it. */
  hub?: string;
  error?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cmd: "launch", port: 3001, project: "default", open: true };
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

/** .git/info/exclude keeps .mpai/ out of git status without touching the
 *  user's .gitignore (spec §5). Non-fatal on failure: worst case .mpai/
 *  shows as untracked. */
function ensureExcluded(repoRoot: string): void {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const excludeFile = path.resolve(repoRoot, gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile)
      ? fs.readFileSync(excludeFile, "utf8")
      : "";
    if (!current.split("\n").includes(".mpai/")) {
      const sep = current === "" || current.endsWith("\n") ? "" : "\n";
      fs.writeFileSync(excludeFile, `${current}${sep}.mpai/\n`);
    }
  } catch {
    /* non-fatal */
  }
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
  try {
    const { port } = await startServer({
      port: args.port,
      workspace: new WorkspaceManager(repoRoot, worktreesRoot),
      staticDir: distDir,
      ...(args.hub ? { hub: { url: args.hub, projectId: args.project } } : {}),
    });
    const url = `http://localhost:${port}/`;
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
        const project = args.project !== "default" ? `&project=${args.project}` : "";
        console.log(`http://localhost:${args.port}/?session=${msg.sessionId}${project}`);
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
      "usage: mpai [--port N] [--hub <ws-url>] [--project <id>] [--no-open] | mpai new <name> [--base <ref>] [--project <id>] [--port N]",
    );
    return 1;
  }
  if (args.cmd === "new") return createSession(args);
  return launch(args);
}
