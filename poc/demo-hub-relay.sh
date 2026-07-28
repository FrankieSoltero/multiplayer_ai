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
RUN="$ROOT/poc/.demo-run"
SESSION="${SESSION:-hubdemo}"

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

for p in "$HUB_PORT" "$LAPTOP_PORT"; do
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

echo "starting the laptop on :$LAPTOP_PORT, dialling out to the hub..."
(cd "$ROOT/poc/demo-project" && \
  "$HOME/.local/bin/mpai" --port "$LAPTOP_PORT" \
    --hub "ws://127.0.0.1:$HUB_PORT/uplink" --no-open) > "$RUN/laptop.log" 2>&1 &
echo $! > "$RUN/laptop.pid"

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$LAPTOP_PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "creating session '$SESSION' on the laptop..."
(cd "$ROOT/poc/demo-project" && \
  "$HOME/.local/bin/mpai" new "$SESSION" --port "$LAPTOP_PORT") >/dev/null 2>&1 || true

cat <<EOF

  ready.

  DRIVER tab   http://127.0.0.1:$HUB_PORT/?session=$SESSION&name=alice
  SECOND tab   http://127.0.0.1:$HUB_PORT/?session=$SESSION&name=ben

  Both URLs are the HUB. The agent runs in the laptop process on :$LAPTOP_PORT.

  logs:  $RUN/hub.log   $RUN/laptop.log
  stop:  ./poc/demo-hub-relay.sh stop

EOF
