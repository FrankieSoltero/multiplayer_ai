import { startHub } from "./hub.js";
import { hubDbPath, storeLogLine } from "./bootConfig.js";
import { hubAuthFrom, hubConfigFrom, opsBootLines } from "./hubEnv.js";

// Auth is all-or-nothing (spec §4.5): a partial config would silently run
// anonymous and look like a bug, so a half-set environment takes the process
// down here rather than booting into a false sense of security.
const authResult = hubAuthFrom(process.env);
if (!authResult.ok) {
  console.error(`config error: ${authResult.error}`);
  process.exit(1);
}
const auth = authResult.auth;

// Operating knobs, all validated together (spec §3, B6): a typo REFUSES BOOT
// with a named error rather than silently defaulting. HOST fail-closed lives
// here because it depends on whether auth was configured above.
const configResult = hubConfigFrom(process.env, auth);
if (!configResult.ok) {
  console.error(`config error: ${configResult.error}`);
  process.exit(1);
}
const config = configResult.config;
const { port, host } = config;
// Home-anchored, `HUB_DB` overriding (spec §8a.2): the launch directory never
// decides where the record lives. Resolved BEFORE the hub starts so the boot
// line below names the same path the hub opened, not a second guess at it.
const dbPath = hubDbPath(process.env);

// A record that cannot be opened — corrupt, newer schema, or already locked by
// another hub — rejects here and this top-level await takes the process down
// with a non-zero exit. That is the intent (spec §3.6): a hub that silently ran
// non-durable would present a record it cannot honor.
const { port: actual } = await startHub({
  port,
  host,
  staticDir: process.env.CLIENT_DIST,
  dbPath,
  auth,
});

console.log(`multiplayer-ai hub listening on http://${host}:${actual}`);
console.log(storeLogLine(dbPath));
if (process.env.CLIENT_DIST) console.log(`serving client from ${process.env.CLIENT_DIST}`);
if (auth) {
  // Count, not contents: the journal is readable by anyone with box access and
  // the roster of who can drive is not something to print on every boot.
  const n = auth.allowlist.split(",").filter((e) => e.trim()).length;
  console.log(`auth ON — allowlist: ${n} login(s)`);
} else {
  console.log("auth OFF — development hub, do NOT expose this to the internet");
}
// One line per enabled/non-default operating control; nothing for the defaults.
for (const line of opsBootLines(config)) console.log(line);
