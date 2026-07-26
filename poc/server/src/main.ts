import { startServer } from "./server.js";

if (!process.env.ANTHROPIC_API_KEY) {
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
// Off by default (spec §7's bound only applies once an operator opts in).
const requireInvite = process.env.REQUIRE_INVITE === "1";
const inviteTtlMs = positiveIntEnv("INVITE_TTL_MS");
const inviteMaxUses = positiveIntEnv("INVITE_MAX_USES");
const { port: actual } = await startServer({
  port,
  requireInvite,
  inviteTtlMs,
  inviteMaxUses,
});
console.log(`multiplayer-ai server listening on ws://localhost:${actual}`);
if (requireInvite) console.log("REQUIRE_INVITE=1 — invite gate is ON");
