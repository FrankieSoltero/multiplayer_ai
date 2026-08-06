# Home lab: hub on a Windows PC via WSL2 (LAN mode)

Codified from the first real run (2026-08-05). This is the cheap real-box variant of
`deploy/hub/RUNBOOK.md`: the hub runs in WSL2 Ubuntu on a Windows PC on your LAN, over
plain `http://`, with TLS/firewall deliberately skipped. It exists so the
`deploy/multi-machine-test.md` checklist can run against real, separate machines without
renting a box. **LAN mode is for a trusted home network only** — no TLS means bearers and
session traffic are plaintext on the wire; do not port-forward it to the internet.

Everything below was hit for real on the first run; the numbered gotchas are logged in
`docs/mistakes-and-fixes.md` (2026-08-05/06 entries).

---

## 1. WSL2 prep (Windows side)

1. Install a distro: `wsl --install -d Ubuntu-24.04`.
2. Enable systemd inside the distro — `/etc/wsl.conf`:

   ```ini
   [boot]
   systemd=true
   ```

   then from Windows: `wsl --shutdown`, reopen, verify with
   `systemctl list-units --type=service | head`.
3. **Keep the VM alive (gotcha):** WSL2's utility VM shuts down shortly after its last
   client process exits — closing the last WSL window kills the hub, systemd unit and all.
   Two pieces, both needed:
   - `%UserProfile%\.wslconfig`:

     ```ini
     [wsl2]
     vmIdleTimeout=-1
     ```
   - A Windows Task Scheduler task at logon ("WSL keepalive") that holds a persistent
     `wsl.exe` process, e.g. run `wsl.exe -d Ubuntu-24.04 -- sleep infinity` hidden, so the
     VM survives window closes and comes back after reboot + logon.
4. **Make port 4000 reachable from the LAN.** Pick one:
   - Win11 22H2+: mirrored networking — `%UserProfile%\.wslconfig` gains
     `networkingMode=mirrored` under `[wsl2]`, then `wsl --shutdown`. The distro shares the
     PC's LAN IP directly.
   - Otherwise: NAT port-forward + firewall hole:

     ```powershell
     netsh interface portproxy add v4tov4 listenport=4000 listenaddress=0.0.0.0 `
       connectport=4000 connectaddress=(wsl hostname -I)
     New-NetFirewallRule -DisplayName "multiplayer-ai hub 4000" -Direction Inbound `
       -LocalPort 4000 -Protocol TCP -Action Allow
     ```

     (The WSL IP changes across restarts in NAT mode — mirrored mode avoids re-doing the
     portproxy.)
5. Optional but worth it: an SSH server in the distro (key auth) and/or Tailscale on the
   Windows host, so you can administer the box from your other machines without sitting at
   the PC.

## 2. Hub install (inside the distro)

Run the universal script in LAN mode, with the PC's LAN IP standing in for a hostname:

```bash
sudo HUB_HOSTNAME=<PC-LAN-IP> REPO_URL=https://github.com/YOU/multiplayer_ai.git \
     SKIP_CADDY=1 SKIP_UFW=1 bash deploy/hub/setup.sh
```

- **`REPO_URL` must be a URL the `mpai` service user can reach (gotcha):** the clone runs as
  `sudo -u mpai`, which cannot read your home directory — a local path under `~/` fails with
  a permission error. Use the https GitHub URL (public, or with credentials the `mpai` user
  can present).
- `build-essential` is installed by the script (phase 1) — `better-sqlite3` compiles
  natively and fresh WSL images have no toolchain. If you're on a checkout predating that
  fix and the hub build dies in node-gyp: `sudo apt-get install build-essential` and re-run.

## 3. LAN env edits

`setup.sh` seeds `/etc/multiplayer-ai/hub.env` with `https://` forms; LAN mode needs the
`http://` reality. Edit:

```ini
HOST=0.0.0.0                                   # not 127.0.0.1 — no Caddy in front
HUB_ORIGIN=http://<PC-LAN-IP>:4000
OAUTH_CALLBACK_URL=http://<PC-LAN-IP>:4000/auth/callback
GITHUB_CLIENT_ID=…                             # OAuth app registered against the http:// URLs above
GITHUB_CLIENT_SECRET=…
GITHUB_ALLOWLIST=<your-github-login>
ANTHROPIC_API_KEY=                             # optional; unset ⇒ oversight truthfully "unavailable"
```

Register the GitHub OAuth app with homepage `http://<PC-LAN-IP>:4000` and callback exactly
`http://<PC-LAN-IP>:4000/auth/callback` — GitHub accepts plain-http callbacks for
LAN/loopback-style trials; the exact-match rule from `RUNBOOK.md` §1 still applies.

Then:

```bash
sudo systemctl start multiplayer-ai-hub
curl -s localhost:4000/healthz         # {"status":"ok"}
journalctl -u multiplayer-ai-hub -n 20 # must say: hub store: sqlite /var/lib/multiplayer-ai/hub.db
```

**Insecure-context note:** `http://<LAN-IP>` is not a secure context in browsers.
Secure-context-only Web APIs are unavailable there — the client's identity bootstrap
black-screened on exactly this until PR #43's `randomId` fallback (`poc/client/src/identity.ts`).
If the client ever black-screens on LAN but works on `localhost`, suspect this class first.

## 4. Machines

Per `deploy/multi-machine-test.md` §2 — pairing, `--root`, and the plugin notes there apply
verbatim. The two that bit in the lab:

- `AGENT_PLUGINS_ROOT` must be set on each machine or the agent has no plugin loadout.
- Hub-attached plugin import via the UI is a v7b3 deferral; the manual-registry workaround
  is documented in `multi-machine-test.md` §2.

## 5. Resume / teardown

- Resume: start the unit (step 3's commands), relaunch each machine's `mpai --hub` — a
  previously paired machine re-attaches silently on its stored bearer (no new code).
- Teardown: `multi-machine-test.md` §4 applies unchanged — machines first, hub last, and
  **keep `hub.db` + the backup dir**; they are the record.
- The WSL box survives reboots only if the keepalive task (§1.3) is in place.

## 6. What LAN mode does NOT verify

Checklist items that stay open here and need a hostname-mode run (real TLS via Caddy):
`multi-machine-test.md` §6 rows 11a (TLS) and anything relying on a secure context. LAN
mode is a topology test, not the §8.10 TLS sign-off.
