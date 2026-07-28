#!/usr/bin/env bash
# v7b1 hub-relay demo — two processes, one browser.
#
# Starts the HUB (owns identity, roster, relayed events, the web client; runs no
# agent and holds no API key) and a LAPTOP server that dials OUT to it. A browser
# pointed at the hub then drives a session whose agent runs in the laptop process.
#
#   ./poc/demo-hub-relay.sh          start the stack and create a demo session
#   ./poc/demo-hub-relay.sh stop     stop everything this script started
#
# Deliberately does NOT source poc/server/.env — it holds a placeholder API key
# that would break the agent, and auth stays OFF for the demo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_PORT="${HUB_PORT:-4000}"
LAPTOP_PORT="${LAPTOP_PORT:-3001}"
LAPTOP_B_PORT="${LAPTOP_B_PORT:-3002}"
RUN="$ROOT/poc/.demo-run"
PROJECT="${PROJECT:-default}"
SESSION="${SESSION:-hubdemo}"
SESSION_B="${SESSION_B:-bendemo}"

stop() {
  for f in "$RUN"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "stopping $(basename "$f" .pid) (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  done
  echo "stopped."
}

if [ "${1:-start}" = "stop" ]; then stop; exit 0; fi

for p in "$HUB_PORT" "$LAPTOP_PORT" "$LAPTOP_B_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is already in use — stop that process first, or set HUB_PORT/LAPTOP_PORT." >&2
    exit 1
  fi
done

mkdir -p "$RUN"

echo "building the client and both packages..."
(cd "$ROOT/poc/client" && npm run build >/dev/null)
(cd "$ROOT/poc/server" && npm run build >/dev/null)
(cd "$ROOT/poc/hub" && npm run build >/dev/null)

echo "starting the hub on :$HUB_PORT (no agent, no API key)..."
CLIENT_DIST="$ROOT/poc/client/dist" HOST=127.0.0.1 PORT="$HUB_PORT" \
  node "$ROOT/poc/hub/dist/main.js" > "$RUN/hub.log" 2>&1 &
echo $! > "$RUN/hub.pid"

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$HUB_PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

# Two laptops, two unrelated repos, ONE hub. Both attach with the same
# --project, which is what puts their sessions in a single browser view: that is
# the whole product claim, and one laptop cannot demonstrate it.
start_laptop() {                     # name  repo-dir  port  session
  local name="$1" dir="$2" port="$3" session="$4"
  echo "starting laptop '$name' on :$port from $(basename "$dir"), dialling out to the hub..."
  (cd "$dir" && "$HOME/.local/bin/mpai" --port "$port" --project "$PROJECT" \
      --hub "ws://127.0.0.1:$HUB_PORT/uplink" --no-open) > "$RUN/$name.log" 2>&1 &
  echo $! > "$RUN/$name.pid"
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
    sleep 0.2
  done
  echo "creating session '$session' on '$name'..."
  (cd "$dir" && "$HOME/.local/bin/mpai" new "$session" --port "$port" --project "$PROJECT") \
    >/dev/null 2>&1 || true
}

if [ ! -d "$ROOT/poc/demo-project-b/.git" ]; then
  echo "creating the second demo repo..."
  mkdir -p "$ROOT/poc/demo-project-b/src"
  cat > "$ROOT/poc/demo-project-b/README.md" <<'MD'
# payments-service (demo repo B)

A second, unrelated repo. Ben's agent runs here, in ben's own laptop process,
while alice's agent runs in demo-project. One hub shows both.
MD
  cat > "$ROOT/poc/demo-project-b/src/charge.ts" <<'TS'
export function chargeCents(amount: number): number {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be a positive integer");
  return amount;
}
TS
  (cd "$ROOT/poc/demo-project-b" && git init -q && git add -A && \
    git -c user.email=demo@local -c user.name=demo commit -qm "init payments-service demo repo")
fi

start_laptop laptop-a "$ROOT/poc/demo-project"   "$LAPTOP_PORT"   "$SESSION"
start_laptop laptop-b "$ROOT/poc/demo-project-b" "$LAPTOP_B_PORT" "$SESSION_B"

cat <<EOF

  ready. Two engineers, two repos, two laptop processes, ONE hub.

  BOTH REPOS AT ONCE  http://127.0.0.1:$HUB_PORT/
      one list, two sessions, two different repoKeys

  ALICE (demo-project, agent on :$LAPTOP_PORT)
      http://127.0.0.1:$HUB_PORT/?session=$SESSION&name=alice

  BEN (demo-project-b, agent on :$LAPTOP_B_PORT)
      http://127.0.0.1:$HUB_PORT/?session=$SESSION_B&name=ben

  Every URL is the HUB. It runs no agent and holds no API key — each agent runs
  in its own laptop process, against its own repo, and dials out.

  To watch each other instead of driving, open the other person's session URL
  with your own &name=.

  logs:  $RUN/hub.log  $RUN/laptop-a.log  $RUN/laptop-b.log
  stop:  ./poc/demo-hub-relay.sh stop

EOF
