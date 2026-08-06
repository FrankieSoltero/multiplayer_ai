import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
// models.js MUST be imported before modelsConfig.js (TDZ boot-crash guard,
// Task 2 review): models.ts runs initRegistry() at its module bottom, so the
// registry is populated (builtins → models.json → env) as a load side effect,
// and modelsConfig's top-level consts are in TDZ until models.js has evaluated.
// Keep this line above the modelsConfig import.
import "./models.js";
import { hasAnthropicCredentials, isRouted, managedModels } from "./modelsConfig.js";
import { startServer } from "./server.js";
import {
  installShutdownHandlers,
  noUsableModelMessage,
  resolveBaseUrl,
  validateProductionConfig,
} from "./config.js";
import { ProxyManager, type ChildLike } from "./proxyManager.js";

// The boot warning sink main.ts already used for advisory messages.
const warn = (message: string): void => console.warn(message);

// Boot capabilities (local-models §2.4): a box is usable when it has Anthropic
// credentials (the built-ins route direct) OR at least one routed model (served
// through the managed proxy). Computed from the registry, which models.js has
// already populated at import time.
const hasAnthropicCreds = hasAnthropicCredentials(process.env, fs.existsSync);
const hasRoutedModels = managedModels().some(isRouted);

const config = validateProductionConfig(
  process.env,
  (dir) => fs.existsSync(path.join(dir, "index.html")),
  { hasAnthropicCreds, hasRoutedModels },
);
if (!config.ok) {
  console.error(`config error: ${config.error}`);
  process.exit(1);
}

// Development advisory: a box with neither credentials nor a routed model will
// run but has nothing to drive the agent — say so once, don't refuse boot.
if (!config.staticDir && !hasAnthropicCreds && !hasRoutedModels) {
  console.warn(`[boot] ${noUsableModelMessage(process.env)}`);
}

// The harness-managed LiteLLM proxy (local-models §2.2). Concrete deps: a thin
// adapter over node:child_process spawn, an HTTP liveliness probe, a PATH
// lookup for the litellm binary, and the boot warning sink.
const spawner = {
  spawn(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }): ChildLike {
    const child = spawn(cmd, args, { env: opts.env, stdio: "ignore" });
    // Adapt to ChildLike: node's kill() is typed to NodeJS.Signals, the manager
    // only ever sends "SIGTERM".
    return {
      on: (ev, fn) => {
        child.on(ev, fn);
      },
      kill: (sig) => {
        child.kill(sig as NodeJS.Signals);
      },
    };
  },
};
const probe = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status === 200;
  } catch {
    return false;
  }
};
const binaryExists = (name: string): boolean => {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const proxyManager = new ProxyManager(process.env, { spawner, probe, warn, binaryExists });
await proxyManager.start();

// Route every driver through the proxy when one is active, BEFORE any
// AgentDriver is constructed (the drivers read ANTHROPIC_BASE_URL at build
// time). undefined ⇒ leave the operator's env untouched.
const resolvedBaseUrl = resolveBaseUrl(process.env.ANTHROPIC_BASE_URL, proxyManager.baseUrl());
if (resolvedBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = resolvedBaseUrl;

/** A positive finite integer from the env, or undefined so the caller's
 *  default applies. Guards against NaN/negative values from a typo'd env var
 *  silently reaching the store. */
function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const port = Number(process.env.PORT ?? 3001);
// Loopback by default so the deployed port is reachable only through the
// reverse proxy. Set HOST=0.0.0.0 for LAN access, e.g. testing from a phone.
const host = process.env.HOST ?? "127.0.0.1";
// Off by default (spec §7's bound only applies once an operator opts in).
// Project-scoped: with the gate on, joining an OCCUPIED project requires an
// invite; the founder and previously-admitted members enter free.
const requireInvite = process.env.REQUIRE_INVITE === "1";
const inviteTtlMs = positiveIntEnv("INVITE_TTL_MS");
const inviteMaxUses = positiveIntEnv("INVITE_MAX_USES");

const { port: actual } = await startServer({
  port,
  host,
  staticDir: config.staticDir,
  requireInvite,
  inviteTtlMs,
  inviteMaxUses,
  auth: config.auth,
  proxyManager,
});

// Graceful shutdown right after the server is up: SIGTERM/SIGINT stop the
// managed proxy child, then exit 0 (local-models §2.2).
installShutdownHandlers(process, proxyManager);

console.log(`multiplayer-ai server listening on http://${host}:${actual}`);
if (config.staticDir) console.log(`serving client from ${config.staticDir}`);
if (requireInvite) console.log("REQUIRE_INVITE=1 — invite gate is ON");
if (config.auth) {
  // Count, not contents: the journal is readable by anyone with box access
  // and the roster of who can drive is not something to print on every boot.
  const listed = config.auth.allowlist.split(",").filter((e) => e.trim()).length;
  console.log(`GitHub auth ON — ${listed} login(s) on the allowlist`);
} else {
  console.log("GitHub auth OFF — anonymous identities (development)");
}
