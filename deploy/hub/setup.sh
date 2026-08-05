#!/usr/bin/env bash
# multiplayer-ai hub — universal one-command setup (Ubuntu/Debian).
# Automates RUNBOOK.md §1 end to end, idempotently: safe to re-run (re-runs
# update the checkout and rebuild; they never overwrite your filled-in env).
#
# Usage (as root, on a fresh box):
#   sudo HUB_HOSTNAME=hub.example.com REPO_URL=https://github.com/YOU/multiplayer_ai.git \
#        bash deploy/hub/setup.sh
#
# Optional env:
#   BRANCH=main            git ref to deploy (default main)
#   SKIP_CADDY=1           skip TLS/reverse-proxy install (e.g. LAN-only trial run)
#   SKIP_UFW=1             skip firewall configuration
#
# What it does NOT do: fill in your secrets. It seeds SESSION_SECRET and the
# hostname-derived values, then names exactly which vars you still fill by hand
# (GITHUB_* and ANTHROPIC_API_KEY) before starting the service.
set -euo pipefail

say()  { printf '\n== %s\n' "$*"; }
die()  { printf 'setup.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
command -v apt-get >/dev/null || die "apt-based systems only (Ubuntu/Debian)"
HUB_HOSTNAME="${HUB_HOSTNAME:-}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
[ -n "$HUB_HOSTNAME" ] || die "HUB_HOSTNAME is required (the DNS name browsers will load)"
[ -n "$REPO_URL" ] || [ -d /opt/multiplayer-ai/.git ] || die "REPO_URL is required on first run"

APP=/opt/multiplayer-ai
ENVDIR=/etc/multiplayer-ai
ENVFILE=$ENVDIR/hub.env
STATE=/var/lib/multiplayer-ai
BACKUPS=/var/backups/multiplayer-ai

say "1/7 base packages"
apt-get update -qq
apt-get install -y -qq git curl openssl >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

say "2/7 service user + directories"
id mpai >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin mpai
mkdir -p "$APP" "$ENVDIR" "$STATE" "$BACKUPS"
chown -R mpai:mpai "$APP" "$STATE" "$BACKUPS"

say "3/7 checkout + build (server → hub → client)"
if [ -d "$APP/.git" ]; then
  sudo -u mpai git -C "$APP" fetch --all --prune
  sudo -u mpai git -C "$APP" checkout "$BRANCH"
  sudo -u mpai git -C "$APP" pull --ff-only
else
  sudo -u mpai git clone --branch "$BRANCH" "$REPO_URL" "$APP"
fi
# poc/client imports poc/server's built dist, so server builds first. better-sqlite3
# (poc/hub) is a native dep — if hub boot later fails on it: npm rebuild better-sqlite3.
( cd "$APP/poc/server" && sudo -u mpai npm ci --silent && sudo -u mpai npm run build --silent )
( cd "$APP/poc/hub"    && sudo -u mpai npm ci --silent && sudo -u mpai npm run build --silent )
( cd "$APP/poc/client" && sudo -u mpai npm ci --silent && sudo -u mpai npm run build --silent )

say "4/7 environment file"
if [ -f "$ENVFILE" ]; then
  echo "kept existing $ENVFILE (never overwritten — edit it by hand)"
else
  install -o mpai -g mpai -m 0600 "$APP/deploy/hub/env.example" "$ENVFILE"
  SECRET=$(openssl rand -hex 32)
  sed -i \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" \
    -e "s|^CLIENT_DIST=.*|CLIENT_DIST=$APP/poc/client/dist|" \
    -e "s|^HUB_ORIGIN=.*|HUB_ORIGIN=https://$HUB_HOSTNAME|" \
    -e "s|^OAUTH_CALLBACK_URL=.*|OAUTH_CALLBACK_URL=https://$HUB_HOSTNAME/auth/callback|" \
    "$ENVFILE"
  # Hub-side oversight (PRD §8.8): the summarizer runs on THIS box with THIS key.
  # env.example predates it; appended here so the operator sees it beside the rest.
  if ! grep -q '^ANTHROPIC_API_KEY=' "$ENVFILE"; then
    printf '\n# Hub-side oversight (PRD §8.8): the team summarizer runs on the hub with this\n# key. Unset => oversight truthfully reports unavailable; everything else works.\nANTHROPIC_API_KEY=\n' >> "$ENVFILE"
  fi
  echo "wrote $ENVFILE (SESSION_SECRET seeded; hostname values set)"
fi

say "5/7 systemd unit"
cp "$APP/deploy/hub/multiplayer-ai-hub.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable multiplayer-ai-hub >/dev/null

say "6/7 caddy (TLS + reverse proxy)"
if [ "${SKIP_CADDY:-0}" = "1" ]; then
  echo "skipped (SKIP_CADDY=1)"
else
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  if [ -f /etc/caddy/Caddyfile ] && ! grep -q 'multiplayer-ai hub' /etc/caddy/Caddyfile; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.pre-multiplayer-ai.bak"
    echo "existing Caddyfile backed up to Caddyfile.pre-multiplayer-ai.bak"
  fi
  { echo "# multiplayer-ai hub — managed by deploy/hub/setup.sh"; \
    sed "s/hub\.example\.com/$HUB_HOSTNAME/" "$APP/deploy/hub/Caddyfile"; } \
    > /etc/caddy/Caddyfile
  systemctl restart caddy
fi

say "7/7 firewall"
if [ "${SKIP_UFW:-0}" = "1" ] || ! command -v ufw >/dev/null; then
  echo "skipped"
else
  ufw allow 22 >/dev/null; ufw allow 80 >/dev/null; ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
  echo "ufw: 22/80/443 open; 4000 stays loopback-only"
fi

say "DONE — what remains is yours:"
NEED=$(grep -E '^(GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET|GITHUB_ALLOWLIST|ANTHROPIC_API_KEY)=$' "$ENVFILE" || true)
if [ -n "$NEED" ]; then
  echo "1. Fill these in $ENVFILE (OAuth app callback must be exactly https://$HUB_HOSTNAME/auth/callback):"
  echo "$NEED" | sed 's/^/     /'
  echo "2. Then: systemctl start multiplayer-ai-hub"
else
  systemctl restart multiplayer-ai-hub
  echo "env already filled — service (re)started"
fi
echo "3. Verify: systemctl status multiplayer-ai-hub; curl -s localhost:4000/healthz"
echo "   journalctl -u multiplayer-ai-hub -n 20   # must say: hub store: sqlite $STATE/hub.db (NOT in-memory)"
echo "4. Pair each laptop: mpai --hub wss://$HUB_HOSTNAME/uplink --root <repo> --root <repo>"
