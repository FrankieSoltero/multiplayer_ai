# Deployment runbook (A1b)

**Status: NEVER EXECUTED.** Written during A1a alongside the code. Every step
is unverified until the first real deployment. Expect to correct this file as
you go — and correct it in place, so the second deployment is cheaper.

The operator runs these over SSH by hand.

## 0. Before you start

- A domain, with an **A record already pointing at the box**. Caddy issues its
  certificate at first start; if DNS is not live you get a confusing TLS error
  rather than a clear one.
- If using Cloudflare DNS, set the record to **"DNS only"** (grey cloud), not
  proxied.
- A Hetzner CX22-class box (2 vCPU / 4 GB / 40 GB). 4 GB is the floor, not a
  comfort margin: the Claude Code subprocess is itself a Node process.
- A capped Anthropic Console workspace key.

## 1. Base packages

    sudo apt update && sudo apt install -y git curl
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version    # expect v22.x or newer

## 2. Service user and directories

    sudo useradd --create-home --shell /usr/sbin/nologin mpai
    sudo mkdir -p /opt/multiplayer-ai /srv/mpai-work /srv/mpai-plugins /etc/multiplayer-ai
    sudo chown -R mpai:mpai /opt/multiplayer-ai /srv/mpai-work /srv/mpai-plugins

The user needs a real home directory: the agent subprocess uses `~/.claude`.

## 3. Checkout and build

    sudo -u mpai git clone https://github.com/FrankieSoltero/multiplayer_ai.git /opt/multiplayer-ai
    cd /opt/multiplayer-ai/poc/server && sudo -u mpai npm ci && sudo -u mpai npm run build
    cd /opt/multiplayer-ai/poc/client && sudo -u mpai npm ci && sudo -u mpai npm run build

## 4. Secrets

    sudo cp /opt/multiplayer-ai/deploy/env.example /etc/multiplayer-ai/env
    sudo chown mpai:mpai /etc/multiplayer-ai/env
    sudo chmod 0600 /etc/multiplayer-ai/env
    sudo -e /etc/multiplayer-ai/env      # fill in ANTHROPIC_API_KEY

## 5. Service

    sudo cp /opt/multiplayer-ai/deploy/multiplayer-ai.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now multiplayer-ai
    sudo systemctl status multiplayer-ai        # expect active (running)
    curl -s localhost:3001/healthz              # expect {"status":"ok"}

If `/healthz` returns HTML, the handler ordering regressed — see spec §3.4.

## 6. Caddy

    sudo apt install -y caddy
    sudo cp /opt/multiplayer-ai/deploy/Caddyfile /etc/caddy/Caddyfile
    sudo sed -i 's/<hostname>/YOUR.DOMAIN.HERE/' /etc/caddy/Caddyfile
    sudo systemctl restart caddy
    sudo journalctl -u caddy -n 50 --no-pager   # confirm certificate obtained

## 7. Firewall

    sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
    sudo ufw enable
    sudo ufw status

Port 3001 is never opened: the process binds loopback. This is defence in
depth, not the primary control.

## 8. Verification — A1b is not done until every line passes

- [ ] `https://<domain>` loads the client with a valid certificate
- [ ] `https://<domain>/healthz` returns JSON, not HTML
- [ ] DevTools → Network → WS shows an established **wss://** connection
- [ ] **Two people on two different networks run a session together**
- [ ] **A real permission gate is reached and approved**
- [ ] An agent turn completes end to end
- [ ] `sudo kill -9 <pid>` → systemd respawns within seconds
- [ ] `curl http://<public-ip>:3001` from outside is refused

The last four matter most. It is easy to stop at "the site loads" and call it
deployed while the product itself has never run on that machine.
