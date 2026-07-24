import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const { port: actual } = await startServer({ port });
console.log(`multiplayer-ai server listening on ws://localhost:${actual}`);
