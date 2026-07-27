import fs from "node:fs";
import path from "node:path";
import { startServer } from "./server.js";
import { validateProductionConfig } from "./config.js";

const config = validateProductionConfig(process.env, (dir) =>
  fs.existsSync(path.join(dir, "index.html")),
);
if (!config.ok) {
  console.error(`config error: ${config.error}`);
  process.exit(1);
}

// Development keeps the old advisory warning: the Claude CLI's own
// credentials may be available even with no key in the environment.
if (!config.staticDir && !process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "ANTHROPIC_API_KEY not set — the agent will rely on Claude CLI credentials if available",
  );
}

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
});

console.log(`multiplayer-ai server listening on http://${host}:${actual}`);
if (config.staticDir) console.log(`serving client from ${config.staticDir}`);
if (requireInvite) console.log("REQUIRE_INVITE=1 — invite gate is ON");
if (config.auth) {
  console.log(`GitHub auth ON — allowlist: ${config.auth.allowlist}`);
} else {
  console.log("GitHub auth OFF — anonymous identities (development)");
}
