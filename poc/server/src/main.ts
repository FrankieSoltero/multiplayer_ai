import { startServer } from "./server.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "ANTHROPIC_API_KEY not set — the agent will rely on Claude CLI credentials if available",
  );
}

const port = Number(process.env.PORT ?? 3001);
const { port: actual } = await startServer({ port });
console.log(`multiplayer-ai server listening on ws://localhost:${actual}`);
