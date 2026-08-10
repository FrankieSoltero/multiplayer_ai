# Multi-machine test runbook

**This run IS the §8.10 real-box verification.** Everything in `deploy/hub/` (Caddyfile,
systemd unit, `env.example`, `RUNBOOK.md`) is code-complete but explicitly **UNVERIFIED**
against a real box (PRD §8.10) — this is the first time it runs for real. Checklist items
tagged **"this run verifies"** are the specific §8.10 claims this test settles.

This doc is the operator script for the user's acceptance topology: 1 hub + 3 machines,
4 repos with deliberate overlap. Follow `deploy/hub/RUNBOOK.md` for the hub box's install
steps (§1) — this doc starts from a running hub and focuses on the cross-machine test itself.

---

## 1. Topology

| Box | Role | Repos attached | Purpose |
|---|---|---|---|
| Hub | `deploy/hub/` (any of the 3 machines, or a 4th box) | — | auth, record, cross-machine relay, oversight |
| Computer 1 | `mpai --hub` | repo 1, repo 2 | baseline per-repo session |
| Computer 2 | `mpai --hub` | repo 2, repo 3 | **overlaps C1 on repo 2, C3 on repo 3** |
| Computer 3 | `mpai --hub` | repo 3, repo 4 | baseline per-repo session |

**The repo-2/repo-3 overlap is deliberate, not an oversight** — it is the §8.8 collision/
contested-badge demo (two machines with sessions open on the same repo) and the vehicle for
the §8.5 approval-handoff check (control transfer needs two machines on one session).

## 2. Environment per box

### Hub

Copy `deploy/hub/env.example` → the hub's env file and fill in, per `RUNBOOK.md` §1:

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `SESSION_SECRET` / `GITHUB_ALLOWLIST` — auth
  on, allowlist covering every human who will approve pairings or drive. All four are required
  together (`hubEnv.ts`) — a half-configured set refuses boot rather than running anonymous.
- `ANTHROPIC_API_KEY` on the hub process — **required for the §8.8 hub-side oversight check
  below**; without it `set_oversight enabled:true` refuses with `oversight is unavailable on
  this hub — no ANTHROPIC_API_KEY configured` and every snapshot reports `available: false`.
- `HUB_ORIGIN` — the hostname browsers actually load (WS-upgrade origin check, fail-closed).
- `OAUTH_CALLBACK_URL` — must match the GitHub OAuth app's registered callback exactly.
- `HUB_TRUST_PROXY=1` — set when running behind Caddy (this deploy does), so per-IP rate
  limits read the real client IP from `X-Forwarded-For`.
- `HUB_RETENTION_DAYS` + `HUB_BACKUP_DIR` (+ optionally `HUB_BACKUP_INTERVAL_MS`,
  `HUB_BACKUP_KEEP`) — set BOTH together for this run; retention alone (no backup dir) prunes
  unrecoverably (§8.7/§8.10) and this run wants to exercise real backups.
- `HOST=127.0.0.1`, `PORT=4000`, Caddy in front per `deploy/hub/Caddyfile` (TLS termination).

Boot the hub and confirm the journal names the sqlite store (not `in-memory`) and prints one
line per enabled control (retention, backups, origin check, trusting proxy headers) — per
`RUNBOOK.md` §1.

### Machines (computers 1–3)

Each machine pairs once, then launches attached:

```
mpai --hub wss://YOUR.HUB.HOSTNAME/uplink --root <repo-A-path> --root <repo-B-path> \
     --machine-name "computer-N"
```

- The CLI requires `ws://`/`wss://` and the `/uplink` path is normalized in if you type a bare
  origin (this cycle, T1 below) — but write it out anyway, `RUNBOOK.md` §2 pairing steps
  reference the literal `/uplink` URL.
- First launch on each machine prints a pairing code; approve it from a signed-in
  (allowlisted) browser on the hub. The bearer is stored hashed on the hub and in plaintext
  only on the machine — no password is ever typed into the CLI.
- `--root` (repeatable) scans for candidate repos at launch; the create-session form on the
  hub UI lists real `(repo, machine)` pairs. The candidate list is fixed for the daemon's
  lifetime (spec §12.5) — a freshly cloned repo needs a restart to appear.
- **Plugins need `AGENT_PLUGINS_ROOT` set on each machine** (e.g.
  `AGENT_PLUGINS_ROOT=$HOME/mpai-plugins mpai --hub …`) or the agent runs with no plugin
  loadout at all. Found the hard way in the 2026-08-05 lab run — it was undocumented.
- **Hub-attached plugin import via the UI is deferred (v7b3):** the hub snapshot hardcodes
  `pluginsEnabled: false` (`poc/hub/src/hubStore.ts:653`), and the SkillsPanel's "set
  AGENT_PLUGINS_ROOT on the server" message is misleading in this mode — the env var won't
  help. **Workaround** (verified in the lab): install into the machine's registry by hand —
  clone the plugin repo to `<AGENT_PLUGINS_ROOT>/<projectId>/<name>/` and write a sibling
  `<name>.meta.json` containing `{"url":"<https git url>","addedBy":"<who>"}`
  (`pluginStore.ts`'s boot rescan picks it up); sessions created after the machine launch
  get the plugin's skills.

---

## 3. Checklist

Each row maps a PRD claim to what to actually watch for. Check them off in the results table
(§6) as you go — do not batch verification to the end.

1. **Pairing / membership** (§8.1). Pair all 3 machines from allowlisted browsers. Confirm:
   revoking a device (hub UI device list → `/pair/revoke`) drops its live uplink and the old
   bearer stops authenticating; re-pairing issues a fresh token. Confirm a non-allowlisted
   GitHub login cannot sign in at all.

2. **Per-repo sessions** (§8.3). From the hub UI, create one session per repo per machine that
   offers it (repo 2 and repo 3 each get sessions on two different machines — this is the
   overlap setup, not an accident). Confirm the create form's `(repo, machine)` picker shows
   real labels, not raw keys/UUIDs (walk finding W4).

3. **Cross-machine watch** (§1.2/§8.5). From a browser NOT on the same machine as a session's
   driver, join that session and confirm you can watch its transcript live without becoming
   the driver.

4. **Take-the-wheel** (§8.5). From the watching browser, take the wheel on a cross-machine
   session. Confirm control genuinely transfers — the new driver's input reaches the agent
   running on the OTHER machine, proven end to end across the relay (this is the "primitive of
   §1.2" the PRD names).

5. **Approval handoff** (§8.5). While driving a cross-machine session, trigger a permission
   gate (a tool call needing approval). Confirm the gate surfaces as a pinned gate bar above
   the prompt, and that a non-driver watching the same session can take the wheel directly from
   the undecided gate card (wheel-on-card) and answer it themselves.

6. **Contested badges on shared repos** (§8.8). With sessions open on repo 2 from both
   Computer 1 and Computer 2 (or repo 3 from Computer 2 and Computer 3), touch the same file
   from both sessions (edit + turn boundary, or an auto-approved write). Confirm: a
   `⚠ CONTESTED ▸ N` header badge appears, per-session contested markers show, and (if
   `MPAI_CONTESTED_GATE` is not set to `0`) an auto-approve on the contested file asks once
   with gate reason `contested with session X` instead of silently proceeding.

7. **Hub oversight summary spanning machines** (§8.8). With the hub's `ANTHROPIC_API_KEY` set
   (§2 above), enable oversight for the project (`set_oversight enabled:true` from a member
   browser) and confirm the OVERSIGHT screen renders a summary that reflects activity from
   sessions on MORE THAN ONE machine — not just the machine the viewing browser happens to be
   attached to. Confirm a hub restart preserves the oversight toggle state and the latest
   summary (HubDb schema v4 `project_oversight`, written through before the snapshot push).

8. **The record** (§8.7). After a mix of activity across all 3 machines, open the project
   screen's RECORD panel and confirm it reflects who drove what, on which machine, across the
   whole run — not just one machine's local view. Restart the hub process and confirm the
   record survives (replay from disk, not an empty store).

9. **Attach-truth lines** (this cycle, T1/F1+F2). On each machine's launch, confirm the console
   prints `dialing hub <url> …` at launch (before any hub round trip), and
   `multiplayer-ai attached to hub <url> (repo: <root>)` ONLY after the hub's `welcome` —
   never at launch. As a negative test on one machine, briefly point `--hub` at a wrong path or
   a stopped hub and confirm the loud once-per-process warning fires within 5s:
   `hub never welcomed this machine after <ms>ms — the socket is open but this is not an
   uplink handshake`, followed by a line naming the URL check. Also confirm a bare origin
   (e.g. `wss://host` with no path) gets normalized to `.../uplink` and that normalized URL is
   what both the dialing line and the attached line print.

10. **Joined signal** (this cycle, T2/F3). When a browser joins a session with nothing yet to
    replay, confirm the header status promotes from `● ONLINE` to `● JOINED` once the server's
    `joined` ack arrives — both for a hub-relayed session (hub sends `joined` before replay)
    and, if exercised, a solo/direct session (server sends its own `joined`). Confirm an old
    client/server pairing (if you can test one) still renders exactly today's `● ONLINE` UI —
    the message is additive.

11. **§8.10 real-box checklist** — **this run verifies**:
    - **TLS via Caddyfile**: `deploy/hub/Caddyfile` fronts the hub; confirm `journalctl -u
      caddy` shows a certificate obtained and the hub is reachable only over `https://`/`wss://`
      (port 4000 itself is not exposed — `sudo ufw` allows only 22/80/443).
    - **systemd unit**: `deploy/hub/multiplayer-ai-hub.service` runs the hub as the `mpai`
      system user; confirm `systemctl status multiplayer-ai-hub` is `active (running)` and
      `curl -s localhost:4000/healthz` returns a JSON health body.
    - **Backups present**: with `HUB_BACKUP_DIR` set, confirm `hub-YYYYMMDD-HHmmssZ.db` files
      appear in the configured dir at boot and on the configured interval, that the count never
      exceeds `HUB_BACKUP_KEEP`, and that a boot backup runs BEFORE any configured prune
      (canonical boot order, spec §8.7) — do this by setting a short retention window and
      watching the backup timestamp precede the prune in the boot log.
    - **Retention behavior**: with `HUB_RETENTION_DAYS` set, confirm old event rows are pruned
      on a subsequent boot and `sessions` rows are never pruned; confirm `nextEventId` keeps
      increasing across a prune (no id collision after pruning, spec's sequence-continuity
      guarantee).

## 4. Teardown

**Stop order:** machines first, hub last — a machine stopping mid-session is exactly the
"laptop vanishing" case §8.7 already expects the hub to tolerate, so stopping them first is
also a passive check of that tolerance.

1. On each machine: `Ctrl-C` the `mpai --hub` process (or `mpai new`/session-specific process
   if separate). Confirm the hub's device/machine presence updates (no crash, no hang).
2. On the hub: `sudo systemctl stop multiplayer-ai-hub` (or `Ctrl-C` if run in foreground for
   the test). Confirm a clean shutdown in the journal.
3. Stop Caddy if it was started solely for this test: `sudo systemctl stop caddy` (skip if
   Caddy serves other things on this box).

**Keep `hub.db` (and its `-wal`/`-shm` sidecars, and everything under `HUB_BACKUP_DIR`) — it
is the record (§8.7).** Do not delete it after this run; it is the durable artifact this test
produced, and later §8.10 work (or the next test run) can restore from it.

**What to delete:** anything genuinely scratch —
- Repo clones created solely to have "repo 1..4" for this test (if they were throwaway clones
  rather than real work), once you've captured any RECORD-panel screenshots you want.
- Test-only GitHub OAuth app credentials, if you registered one just for this run.
- Any device pairings you created purely to test revocation (§checklist item 1) — revoke them
  if you haven't already, they're a live bearer sitting on a real hub otherwise.

**Do NOT delete:** `hub.db`/`-wal`/`-shm`, the backup directory's contents, or
`~/.mpai/machine.json` on any machine you intend to keep testing with (it's that machine's
persisted identity — deleting it makes it look like a new machine next launch).

## 5. Failure recovery

If a checklist item fails mid-run, stop and capture before moving on — a half-diagnosed
failure is expensive to reconstruct later.

- **Items 1–2 (pairing/membership, per-repo sessions):** capture the hub's stdout/journal
  around the failure (pairing errors are printed plainly), the exact CLI invocation used, and
  whether `GITHUB_ALLOWLIST` covers the login being tested. Resume by re-running from a fresh
  pairing attempt — pairing codes are short-TTL (10 min) and single-use, so a stale code is a
  common false failure, not a real one.
- **Items 3–5 (cross-machine watch, take-the-wheel, approval handoff):** capture which machine
  was driving, which browser watched, and the exact relay/session ids from the browser's
  console or the hub's log around the event. Resume from step 3 (re-join the session) rather
  than re-pairing machines — the control-transfer primitive is the most load-bearing claim in
  this run, worth isolating on its own before assuming a topology problem.
- **Item 6 (contested badges):** capture the two session ids and the exact file path touched
  from each; confirm `MPAI_CONTESTED_GATE` was not set to `0` on either machine (that silently
  disables the whole check and would produce a false negative, not a bug). Resume by re-editing
  the same file from both sessions once confirmed.
- **Item 7 (hub oversight):** capture the hub's boot log line for `ANTHROPIC_API_KEY`
  presence, and the exact `set_oversight` refusal string if any (`oversight is unavailable on
  this hub — no ANTHROPIC_API_KEY configured` means the key isn't set on the HUB process, not
  a machine — a common mix-up). Resume by fixing the env var and restarting the hub; oversight
  state (once successfully enabled) survives that restart, so you don't need to redo item 7
  from scratch.
- **Item 8 (the record):** capture a screenshot of the RECORD panel before the hub restart and
  after, so a diff is possible. If the record looks empty after restart, check the hub's boot
  log for `hub store: sqlite <path>` — an `in-memory` line means `HUB_DB`/`MPAI_HOME` was
  misconfigured for this run, not a record-durability bug.
- **Item 9 (attach-truth):** capture the FULL console output from machine launch through
  either "attached" or the no-welcome warning — the ordering (dialing → [attached | warning])
  is the thing under test, not just the final line. Resume by relaunching that one machine; no
  hub-side state is at risk from a bad attach attempt.
- **Item 10 (joined signal):** capture the browser's network tab (WS frames) around the join —
  confirm whether a `joined` frame was sent at all vs. sent-but-not-rendered (the first is a
  server bug, the second a client bug — different fix owners). Resume by rejoining the session.
- **Item 11 (§8.10 TLS/systemd/backups/retention):** capture `journalctl -u caddy -n 50` and
  `journalctl -u multiplayer-ai-hub -n 50` at the point of failure — these are the box-level
  items where the log, not the UI, has the answer. Resume from `RUNBOOK.md` §1's install steps
  for the specific failing piece (TLS cert, systemd unit, or env file) rather than re-running
  the whole install.

## 6. Results table

Fill in during the run. PASS/FAIL/DEFERRED, with a one-line note (what you saw, or what
blocked it).

**Run in progress — 2026-08-05 home lab** (`deploy/home-lab.md`): hub on WSL2
Ubuntu-24.04 in LAN mode (`SKIP_CADDY=1 SKIP_UFW=1`, http:// origins), ONE machine attached
so far (the Mac). Rows marked PARTIAL passed for what a 1-machine topology can exercise; the
cross-machine rows wait on the full 3-laptop matrix (lab repos 2–4 not yet chosen).

| # | Item | Result | Notes |
|---|---|---|---|
| 1 | Pairing / membership | PARTIAL | 2026-08-05: OAuth round trip + allowlist sign-in ✓, pairing code flow ✓, silent bearer re-attach on relaunch ✓; device revocation NOT yet exercised |
| 2 | Per-repo sessions | PARTIAL | 2026-08-05: project + repo attach + session create ✓ on 1 machine; multi-machine picker overlap untested |
| 3 | Cross-machine watch | | needs machine 2 |
| 4 | Take-the-wheel | | needs machine 2 |
| 5 | Approval handoff | | first agent turn + 🔐 gate queued for lab resume |
| 6 | Contested badges on shared repos | | needs the repo-overlap topology |
| 7 | Hub oversight summary spanning machines | DEFERRED | no `ANTHROPIC_API_KEY` on the hub yet (operator has no key) — refusal path is the expected state |
| 8 | The record | | hub.db + wal ~1.2MB of session history retained through teardown; restart-survival check queued for lab resume |
| 9 | Attach-truth lines (dialing / attached / no-welcome) | PASS | 2026-08-05: `dialing hub …` → `attached to hub` ordering ✓ over the real relay |
| 10 | Joined signal | | queued for lab resume (fresh session join) |
| 11a | §8.10 TLS via Caddyfile | DEFERRED | LAN mode ran `SKIP_CADDY=1` by design; TLS check needs a hostname-mode run |
| 11b | §8.10 systemd unit | PASS | 2026-08-05: unit active as `mpai`, `/healthz` ok, journal names `hub store: sqlite /var/lib/multiplayer-ai/hub.db` (not in-memory) |
| 11c | §8.10 backups present | PARTIAL | boot backup lands in `/var/backups/multiplayer-ai` (2 present); interval + `HUB_BACKUP_KEEP` cap not yet exercised |
| 11d | §8.10 retention behavior | | not yet exercised |
| 12a | PC box — key-less boot | PASS | 2026-08-07: PC daemon attached with no `ANTHROPIC_API_KEY` / no Claude CLI creds, clean boot, no fatal refusal |
| 12b | PC box — add model via UI | | see §7 note: the MODELS panel does not render on the hub project screen (hub does not route `list_models`/`add_model`) — add via the PC daemon's own UI instead |
| 12c | PC box — fallback default | | not yet exercised |
| 12d | PC box — run a turn | | not yet exercised (local-model turn is run by the operator) |
| 12e | PC box — remove-in-use refusal | | not yet exercised |

## 7. PC-box local-model test (model-agnostic-models cycle)

**Topology for this section:** a fourth box — the **PC box** — runs Ollama plus its own `mpai`
daemon, with NO `ANTHROPIC_API_KEY` configured on it. A laptop (any of computers 1–3, or a
separate machine) attaches to the same hub and acts purely as the **driver**: it opens the
project screen, adds the model, and runs the turn, but the agent itself runs on the PC box. This
is the topology the harness-managed proxy is FOR — GPU/local-model hardware on one machine, a
thin driver anywhere else on the hub.

**Setup on the PC box:**

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull qwen3.6:27b`.
2. Install `litellm` (`pip install 'litellm[proxy]'`, version pins per
   `deploy/local-models.md` §1) so the daemon can spawn the managed proxy — do NOT set
   `ANTHROPIC_API_KEY` on this box; that is the point of this test.
3. Launch `mpai --hub wss://YOUR.HUB.HOSTNAME/uplink --root <repo-path> --machine-name
   "pc-box"` and pair it from an allowlisted browser, same as any other machine (§2 above).

**Checklist (map to the results table's item 12 rows):**

1. **Key-less boot** — confirm the PC box's daemon boots cleanly with no `ANTHROPIC_API_KEY` and
   no Claude CLI credentials present. The console shows no fatal refusal; this is the "at least
   one usable model" gate relaxed for local-only operation.
2. **Add model via UI from the laptop** — from the driving laptop's browser, open the project
   screen for a session on the PC box and use the MODELS panel to register the Ollama model:
   provider `ollama`, base URL `http://127.0.0.1:11434` (the PC box's own loopback — the daemon
   runs ON that box, so its Ollama is always local to it even though you're driving from a
   laptop), provider model `qwen3.6:27b`. Confirm the entry appears in the picker without
   restarting anything.
3. **Fallback default** — before adding the model, confirm the Claude built-ins on the PC box
   carry the `no Anthropic credentials` note and a new session's default model is NOT a mute
   opus. After the model is added, confirm a NEW session's default resolves to the routed model
   automatically (first routed entry in registration order).
4. **Run a turn** — from the driving laptop, start a session on the PC box, select the routed
   model (if not already the default), and run a real turn end to end. Confirm the response
   comes back through the managed proxy (`$MPAI_HOME/litellm/config.yaml` on the PC box was
   generated, not hand-written) and gates/record behave identically to a Claude session.
5. **Remove-in-use refusal** — while the session from step 4 is still open with the routed model
   selected, try to REMOVE that model from the MODELS panel. Confirm the server refuses, naming
   the in-use session, instead of silently deleting a model a live session depends on.
