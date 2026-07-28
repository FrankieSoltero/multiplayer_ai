import { startHub } from "./hub.js";

const port = Number(process.env.PORT ?? 4000);
// Loopback by default, like the server (A1a): the deployed port is reachable
// only through the reverse proxy. Set HOST=0.0.0.0 for LAN access.
const host = process.env.HOST ?? "127.0.0.1";

const { port: actual } = await startHub({
  port,
  host,
  staticDir: process.env.CLIENT_DIST,
});

console.log(`multiplayer-ai hub listening on http://${host}:${actual}`);
if (process.env.CLIENT_DIST) console.log(`serving client from ${process.env.CLIENT_DIST}`);
console.log("auth OFF — v7b1 development hub, do NOT expose this to the internet");
