import { startHub } from "./hub.js";
import { hubDbPath, storeLogLine } from "./bootConfig.js";

const port = Number(process.env.PORT ?? 4000);
// Loopback by default, like the server (A1a): the deployed port is reachable
// only through the reverse proxy. Set HOST=0.0.0.0 for LAN access.
const host = process.env.HOST ?? "127.0.0.1";
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
});

console.log(`multiplayer-ai hub listening on http://${host}:${actual}`);
console.log(storeLogLine(dbPath));
if (process.env.CLIENT_DIST) console.log(`serving client from ${process.env.CLIENT_DIST}`);
console.log("auth OFF — v7b1 development hub, do NOT expose this to the internet");
