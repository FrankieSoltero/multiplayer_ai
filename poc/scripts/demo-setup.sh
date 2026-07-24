#!/usr/bin/env bash
# Creates a tiny demo repo + per-session git worktrees for the v2 demo.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf demo-project demo-worktrees
mkdir -p demo-project demo-worktrees
cd demo-project
git init -q -b main

mkdir -p src
cat > src/auth.ts <<'TS'
// Legacy session-cookie auth middleware (to be migrated to JWT).
export function authMiddleware(req: { cookies: Record<string, string> }): boolean {
  return Boolean(req.cookies["session_id"]);
}
TS
cat > src/api.ts <<'TS'
// API entry points. Rate limiting not yet implemented.
import { authMiddleware } from "./auth.js";
export function handleRequest(req: { cookies: Record<string, string> }): string {
  if (!authMiddleware(req)) return "401";
  return "200 ok";
}
TS
cat > README.md <<'MD'
# Demo project
A tiny fake service used to demo multiplayer agent sessions.
MD
git add -A && git commit -qm "init demo project"

git worktree add -q ../demo-worktrees/ana -b ana
git worktree add -q ../demo-worktrees/ben -b ben
echo "Worktrees ready. Start the server with:"
echo "  AGENT_WORKDIR_ROOT=$(cd ../demo-worktrees && pwd) npm run dev"
