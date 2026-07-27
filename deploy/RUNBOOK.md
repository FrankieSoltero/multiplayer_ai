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

**BLOCKER — no session workspace provisioning exists yet (must be fixed in A1b
before any real session runs).** `poc/server/src/main.ts` never passes a
`workspace` to `startServer`. Without one, `server.ts:174-175` computes each
session's workdir as `path.join(AGENT_WORKDIR_ROOT, sessionId)` but **nothing
in the codebase ever creates that directory** — `mkdir` only appears in
`workspace.ts`, `cli.ts`, and `pluginStore.ts`, none of which run on this
path. Two failure modes follow:
  - If `AGENT_WORKDIR_ROOT` is set (as `deploy/env.example` instructs), the
    agent is pointed at a directory that does not exist and was never
    provisioned as a git worktree.
  - If `AGENT_WORKDIR_ROOT` is left unset, `agentDriver.ts:133` falls back to
    `process.cwd()`, which under `deploy/multiplayer-ai.service` is
    `/opt/multiplayer-ai/poc/server` — **the agent would edit the running
    deployment's own source tree.**
  Do not work around this by pre-creating an empty `AGENT_WORKDIR_ROOT`
  directory: an empty non-git folder makes the failure silent instead of
  loud, and the agent would still be operating somewhere it shouldn't be. A
  real fix (provisioning a workspace per session before `startServer` is
  called) is A1b scope, not something to patch here.

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

`https://github.com/FrankieSoltero/multiplayer_ai.git` is currently a
**private** repository. `mpai` has a `nologin` shell, no TTY, and no
credential helper configured, so an unauthenticated HTTPS clone as shown
above will simply fail with a prompt it cannot answer. Either make the repo
public before this step (the launch plan intends to do this anyway, and it
removes this whole step), or authenticate first with a read-only deploy key:

    sudo -u mpai ssh-keygen -t ed25519 -C "mpai@$(hostname)-deploy" -f /home/mpai/.ssh/id_ed25519 -N ""
    sudo -u mpai cat /home/mpai/.ssh/id_ed25519.pub

Add the printed public key as a **deploy key** on the GitHub repo (Settings →
Deploy keys → Add deploy key). Leave "Allow write access" unchecked — this
key only needs to read.

    sudo -u mpai ssh-keyscan github.com >> /home/mpai/.ssh/known_hosts
    sudo -u mpai git clone git@github.com:FrankieSoltero/multiplayer_ai.git /opt/multiplayer-ai
    cd /opt/multiplayer-ai/poc/server && sudo -u mpai npm ci && sudo -u mpai npm run build
    cd /opt/multiplayer-ai/poc/client && sudo -u mpai npm ci && sudo -u mpai npm run build

If the repo has already been made public by this point, the original HTTPS
clone works and the deploy-key steps above can be skipped.

## 4. Secrets

    sudo cp /opt/multiplayer-ai/deploy/env.example /etc/multiplayer-ai/env
    sudo chown mpai:mpai /etc/multiplayer-ai/env
    sudo chmod 0600 /etc/multiplayer-ai/env
    sudo -e /etc/multiplayer-ai/env      # fill in ANTHROPIC_API_KEY

## 4a. GitHub sign-in (A2a) — required in production

**NOT YET VERIFIED against a real GitHub OAuth app.** Written during A2a.

Since A2a the process **refuses to boot** without this. With `CLIENT_DIST`
set, a missing variable exits 1 with e.g.
`config error: GITHUB_CLIENT_ID is required when CLIENT_DIST is set
(production mode)`. That is correct behaviour, not a bug — fill these in.

**Register the OAuth app first.** GitHub → Settings → Developer settings →
OAuth Apps → New OAuth App:

  - **Homepage URL:** `https://<domain>`
  - **Authorization callback URL:** `https://<domain>/auth/callback`

The callback path is `/auth/callback` on the **same origin that serves the
client** — the server handles both, so there is nothing extra to add to the
Caddyfile. Register it exactly; GitHub matches it literally.

Then add to `/etc/multiplayer-ai/env`:

    GITHUB_CLIENT_ID=<from the OAuth app>
    GITHUB_CLIENT_SECRET=<generate one on the OAuth app page>
    SESSION_SECRET=<openssl rand -hex 32>
    GITHUB_ALLOWLIST=alice,bob
    OAUTH_CALLBACK_URL=https://<domain>/auth/callback

  - `SESSION_SECRET` signs the session cookie and **must be high-entropy**
    (`openssl rand -hex 32`), never a reused password. There is no revocation
    list (A2a spec §7): **rotating it signs everyone out**, which is also the
    only way to kill a leaked cookie. Sessions last 7 days.
  - `GITHUB_ALLOWLIST` is **comma-separated GitHub logins, case-insensitive**;
    whitespace around entries is ignored. An **empty list admits nobody** —
    fail-closed, not a wildcard. Anyone signed in but unlisted gets the "not on
    the list" screen, and their join is refused by the server too. Adding
    someone requires editing this file and
    `sudo systemctl restart multiplayer-ai`.
  - `OAUTH_CALLBACK_URL` is technically optional but **set it in production**.
    It is sent to GitHub as `redirect_uri` (so it must match the registered
    callback URL exactly), and an `https://` value is what tells the server it
    is a TLS deployment — without it, a proxy that omits `x-forwarded-proto`
    would get a session cookie issued **without `Secure`**. The post-login
    destination, including an invite token, rides in its own cookie and
    survives the round trip either way.

Never paste the client secret into a shell command; `sudo -e` the env file.
After editing, restart and confirm the boot line reads
`GitHub auth ON — N login(s) on the allowlist` (the roster itself is
deliberately not printed to the journal).

## 5. Service

    sudo cp /opt/multiplayer-ai/deploy/multiplayer-ai.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now multiplayer-ai
    sudo systemctl status multiplayer-ai        # expect active (running)
    curl -s localhost:3001/healthz              # expect {"status":"ok"}

If `/healthz` returns HTML, the handler ordering regressed — see spec §3.4.

## 6. Caddy

`caddy` is not in Ubuntu's default repositories (it ships in Debian bookworm
main, but section 0 above recommends Ubuntu). Add Caddy's official apt
repository first, per Caddy's documented Debian/Ubuntu install instructions:

    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt update
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

- [ ] **Session workspace provisioning is implemented and verified** —
      `startServer` is called with a real `workspace`, or an equivalent fix
      exists, so `AGENT_WORKDIR_ROOT/<sessionId>` is actually created before a
      session starts. Until this box is checked, leaving `AGENT_WORKDIR_ROOT`
      unset makes the agent run in the deployment's own source tree (see the
      blocker in section 0). **This MUST be resolved before any real session
      runs.**
- [ ] `https://<domain>` loads the client with a valid certificate
- [ ] `https://<domain>/healthz` returns JSON, not HTML
- [ ] DevTools → Network → WS shows an established **wss://** connection
- [ ] `https://<domain>/auth/me` returns `{"enabled":true}` with a 401 when
      signed out — **not** `{"enabled":false}`, which would mean auth is off
- [ ] Signing in with an allowlisted GitHub account reaches the session; the
      name shown is the GitHub login and cannot be edited
- [ ] Signing in with a **non**-allowlisted account lands on "NOT ON THE LIST"
- [ ] DevTools → Application → Cookies: `mpai_session` has **Secure**,
      **HttpOnly** and **SameSite=Lax**
- [ ] An invite link opened while signed out survives the sign-in round trip
      and lands back on the invited session, not on `/`
- [ ] **Two people on two different networks run a session together**
- [ ] **A real permission gate is reached and approved**
- [ ] An agent turn completes end to end
- [ ] `sudo kill -9 <pid>` → systemd respawns within seconds
- [ ] `curl http://<public-ip>:3001` from outside is refused

The last four matter most. It is easy to stop at "the site loads" and call it
deployed while the product itself has never run on that machine.
