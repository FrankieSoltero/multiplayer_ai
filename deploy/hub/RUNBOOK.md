# Hub deployment runbook (§8.10 / B4)

**NOT YET VERIFIED against a real box — written for §8.10 (B4); verify before
first use.** The user has no box to run this on, so every step here is an
unverified draft (spec §5, B4 disclosure). Nothing in this file is claimed
deployable. Expect to correct it in place on the first real deployment, so the
second is cheaper.

The operator runs these over SSH by hand. This is the **hub** — the box that
holds the record and that laptops pair to; it is separate from the relay unit
in `deploy/`.

## 1. Install

Base packages and a Node 22+ runtime:

    sudo apt update && sudo apt install -y git curl
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version    # expect v22.x or newer

Service user, the record dir, and the backup dir. MPAI_HOME and HUB_BACKUP_DIR
live under `/var` — NOT the mpai home — because the systemd unit sets
`ProtectHome=true`, which hides `/home` from the process:

    sudo useradd --system --create-home --shell /usr/sbin/nologin mpai
    sudo mkdir -p /opt/multiplayer-ai /etc/multiplayer-ai \
                  /var/lib/multiplayer-ai /var/backups/multiplayer-ai
    sudo chown -R mpai:mpai /opt/multiplayer-ai \
                  /var/lib/multiplayer-ai /var/backups/multiplayer-ai

Checkout and build the hub. `better-sqlite3` is a **native** dependency of
`poc/hub`; a failed native build breaks hub boot even when the config is fine
(recover with `npm rebuild better-sqlite3`).

    sudo -u mpai git clone <repo-url> /opt/multiplayer-ai
    cd /opt/multiplayer-ai/poc/hub && sudo -u mpai npm ci && sudo -u mpai npm run build

Secrets:

    sudo cp /opt/multiplayer-ai/deploy/hub/env.example /etc/multiplayer-ai/hub.env
    sudo chown mpai:mpai /etc/multiplayer-ai/hub.env
    sudo chmod 0600 /etc/multiplayer-ai/hub.env
    sudo -e /etc/multiplayer-ai/hub.env   # fill in the GITHUB_* + SESSION_SECRET vars

Service:

    sudo cp /opt/multiplayer-ai/deploy/hub/multiplayer-ai-hub.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now multiplayer-ai-hub
    sudo systemctl status multiplayer-ai-hub     # expect active (running)
    curl -s localhost:4000/healthz               # expect a JSON health body

Caddy (TLS + reverse proxy). Add Caddy's official apt repo first, per Caddy's
documented Debian/Ubuntu install instructions, then:

    sudo cp /opt/multiplayer-ai/deploy/hub/Caddyfile /etc/caddy/Caddyfile
    sudo sed -i 's/hub.example.com/YOUR.HUB.HOSTNAME/' /etc/caddy/Caddyfile
    sudo systemctl restart caddy
    sudo journalctl -u caddy -n 50 --no-pager    # confirm certificate obtained

Firewall — port 4000 is never opened; the hub binds loopback and only Caddy
reaches it:

    sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
    sudo ufw enable

Confirm the boot journal names the store you expect (`hub store: sqlite
/var/lib/multiplayer-ai/hub.db`) and prints one line per enabled control
(retention, backups, origin check, trusting proxy headers). If it says
`in-memory`, the record is NOT persisting.

## 2. Pairing a laptop (Branch A)

A teammate's laptop gets a revocable device credential — no password is ever
typed into the CLI:

1. On the laptop: `mpai --hub https://YOUR.HUB.HOSTNAME`. It prints a **short
   pairing code** and waits.
2. In a browser already **signed in** to the hub (allowlisted GitHub account),
   open the hub and **approve** that code.
3. The hub issues an **opaque bearer token**, stored only as a hash against a
   revocable device record. The laptop keeps the token; the hub keeps the hash.

From then on the laptop's uplink authenticates with that bearer. To take a
device's access away, see "Revoking a device" below — that is the whole
revocation story.

## 3. Backup / restore

Backups are opt-in and hot: with `HUB_BACKUP_DIR` set, the hub takes a
`VACUUM INTO` snapshot at boot and every `HUB_BACKUP_INTERVAL_MS`, keeping the
newest `HUB_BACKUP_KEEP` files named `hub-YYYYMMDD-HHmmssZ.db`. Each snapshot is
a single self-contained file — it sidesteps the `.db`/`-wal`/`-shm` trio-copy
hazard (spec §8a ruling 7), so you restore from one file, not three.

At boot, the hub always takes its backup snapshot BEFORE running any configured
retention prune (the canonical boot order, spec §8.7), so a pruned row is never
lost before a backup exists to recover it — that boot-order guarantee is what
makes the recoverability claim in §4 and env.example true. It also means the
double opt-in below is real: with `HUB_RETENTION_DAYS` set but NO
`HUB_BACKUP_DIR`, there is no pre-prune snapshot, so the prune deletes
unrecoverably (§8.7) — the operator's explicit choice, not a default.

To restore from a snapshot:

1. Stop the hub:  `sudo systemctl stop multiplayer-ai-hub`
2. Replace the live db with the backup:
   `sudo -u mpai cp /var/backups/multiplayer-ai/hub-YYYYMMDD-HHmmssZ.db /var/lib/multiplayer-ai/hub.db`
3. **Delete any leftover WAL/SHM sidecars** — they belong to the OLD db and
   would corrupt the restored one:
   `sudo rm -f /var/lib/multiplayer-ai/hub.db-wal /var/lib/multiplayer-ai/hub.db-shm`
4. Start the hub:  `sudo systemctl start multiplayer-ai-hub`

A backup failure is never fatal — the hub logs once and keeps serving the live
record. A **corrupt** `hub.db` has no recovery except a snapshot: the record to
that point is lost unless a backup was kept. This is why retention without a
backup dir deletes unrecoverably (§8.7) — set both together unless you mean to.

## 4. Disk-full recovery

Since B1 a low disk no longer crash-loops. Below `HUB_MIN_FREE_BYTES` the hub
**refuses to boot loudly** (`insufficient disk headroom: … free space or lower
HUB_MIN_FREE_BYTES`) and refuses publishes at runtime instead of writing memory
ahead of a disk it cannot commit to.

Operator recovery order (spec §8a ruling 7 — **back up first**):

1. **BACK UP the record first.** Copy the `hub.db` + `hub.db-wal` + `hub.db-shm`
   trio TOGETHER to safe storage. The journal is the product's sole record;
   moving `hub.db` alone strands committed WAL data and a botched recovery loses
   the record permanently.
2. Free disk space (rotate journals, prune old `hub-*.db` backups off-box), or
   move the trio together to a larger volume.
3. If you must serve immediately and cannot free space, run degraded and
   ephemeral with `HUB_DB=:memory:` — nothing persists, but the hub is up.

Then lower the pressure for next time: set `HUB_RETENTION_DAYS` (with a backup
dir, so pruned rows stay recoverable), or raise the volume.

## 5. Revoking a device

Revocation is deleting the device's record — the hashed bearer no longer
matches anything, and any live uplink for that device is dropped. Do it from a
signed-in browser's device list on the hub (the `/pair/revoke` path). Re-pairing
issues a fresh token; the old one is dead. There is no separate password to
change.

## 6. Upgrading

Follow the **back-up-before-upgrade** convention (spec §8a ruling 7):

1. `sudo systemctl stop multiplayer-ai-hub`
2. Take a fresh snapshot (copy the newest `hub-*.db`, or the live trio per §4
   step 1) somewhere off the box.
3. Pull and rebuild:
   `cd /opt/multiplayer-ai && sudo -u mpai git pull && cd poc/hub && sudo -u mpai npm ci && sudo -u mpai npm run build`
4. `sudo systemctl start multiplayer-ai-hub` and watch the boot journal.

If a schema migration ran, an older hub binary will then **refuse to open the
newer-schema db** — this is the designed fail-stop, not a bug. Recover by
running the newer hub (roll forward), or restore the pre-upgrade backup and run
the older hub (roll back). Never point two hubs at one db.
