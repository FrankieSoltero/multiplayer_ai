# v7 PLANNING TRACK — resume packet

*Written 2026-07-27 by the background planning session. **This is NOT the project's HANDOFF.md.** It covers one branch — `feature/v7b-hub-relay-plan` — which is docs-only. See "Why this file exists" at the bottom.*

## 1. Goal and status

**Goal:** write the implementation plans for the rest of v7, against
`docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md`.

**Status: four plans written, self-reviewed, committed and pushed. Draft PR #18 is open.
Nothing is half-finished on this branch.** No code was written and no test was run — these
are plans, and they are unexecuted by design.

| Plan | File (`docs/superpowers/plans/`) | Tasks | Delivers |
|---|---|---|---|
| **v7b1** | `2026-07-27-v7b1-hub-relay-spine.md` | 8 | A browser on the hub drives a session whose agent runs on another machine |
| **v7b2** | `2026-07-27-v7b2-trust-and-pairing.md` | 8 | The hub is safe to expose to the internet |
| **v7b3** | `2026-07-27-v7b3-host-and-team-surface.md` | 7 | A hub with an owner, spanning repos, with cross-machine oversight |
| **v7c** | `2026-07-27-v7c-hub-persistence.md` | 5 | The hub survives its own restart |

**v7d (handoff continuity) and v7e (collision detection) are deliberately NOT written.**
Each has one paragraph in spec §7 and no spec of its own. v7e was explicitly shelved
mid-brainstorm and HANDOFF is emphatic that it "starts at brainstorming, not at code."
Writing TDD plans from that would invent design decisions and present them as settled.
**Their next step is `superpowers:brainstorming` → a spec, not a plan.**

## 2. Decisions made here (do not re-litigate; reject them in one place if you disagree)

- **v7b is three plans, not one**, deviating from spec §1.2's "one spec, two plans." As a
  single plan it is ~23 tasks with no working-software checkpoint until the end, and every
  risky unknown is in the transport. Recorded in v7b1's header.
- **Spec §11's open questions are answered rather than blocked on**, each in one place per
  plan with its reasoning:
  - *Uplink token revocation* → **per-device records with an explicit revoke**; the bearer is
    stored only as sha256. Short-lived-tokens-with-refresh was rejected because expiry cannot
    revoke a connected laptop *now*, so you still need the list.
  - *Revocation scope* → self-service in v7b2 (your own devices), host-wide in v7b3.
  - *Session close on reconnect* → accept and surface it (the spec's own proposal).
  - *Oversight paid tier* → not built; only the host-supplies-their-own-key arm. Reselling
    inference needs a read of Anthropic's commercial terms.
- **Shared code between server and hub** → `poc/hub` depends on `poc/server` via a `file:`
  dependency plus an `exports` map. Copying `auth.ts` was rejected (two divergent copies of
  cookie verification is how a security bug ships); a `poc/shared/` hoist was rejected because
  it forces `tsconfig.build.json` off `rootDir: "src"`, which breaks `node dist/main.js` and
  the systemd `ExecStart` (HANDOFF §4e).
- **v7c uses `node:sqlite`, zero new dependencies.** Verified by running it, not by reading
  docs: works synchronously on Node v22.22.0 here, prints an `ExperimentalWarning`. Both facts
  and the `better-sqlite3` fallback are in the plan, with Task 1 Step 1 as the check.
- **v7b3 flags two scope interpretations** against spec text that reads two ways — oversight
  running on the hub, and invites staying laptop-side. Each is cuttable in one place.

## 3. Defects found and closed while writing (not left for execution)

1. A session created while the uplink is **already up** would have lost its `skill_roster`
   event — no second `welcome`, and the subscribe is registered after the append. Fixed by
   having `trackSession` publish the backlog, registered last in `getOrCreateSession`.
2. A browser disconnect had **no path to the laptop**, so `presence_leave` never fired and the
   roster kept ghosts forever. Added a `detach` down-frame.
3. A client-chosen `uplinkId` would have let **two laptops publish for each other's sessions**.
   v7b2 derives the uplink identity from the device record and ignores the frame's claim.
4. A pairing-code regex admitted `L` while the alphabet excludes it.

## 4. Ordered next steps

1. **Decide whether the three-way v7b split is right.** Everything downstream assumes it.
2. **Review the four open-question answers in §2.** They are the parts a reviewer should push
   back on, and they are cheap to change now and expensive later.
3. **Execute v7b1** via `superpowers:subagent-driven-development`. It is the only one of the
   four whose prerequisites are already merged.
4. **Brainstorm v7d and v7e** when they come up. v7e must also absorb the worktree-sharing bug
   in spec §9 — it has to dedupe by resolved workdir, or every file either session touches
   reads as contested.

## 5. Gotchas specific to this branch

- **The plans are unexecuted.** Every test count in them is a *prediction* derived by chaining
  from the v7a baseline (server 345 / client 179). They chain consistently, but the first task
  executed will tell you whether the arithmetic held.
- **v7b2 Task 6 changes `--hub` from a `ws://` URL to an `http(s)://` base URL** and edits the
  four `--hub` tests v7b1 adds. That is the one place in the set where an existing test
  legitimately changes, and it is called out in the plan.
- **v7b1 Task 5's acceptance criterion is unusual**: all 363 server tests pass with *zero edits
  to any existing test file*. An edited assertion means the refactor changed behaviour.
- The plans reference real line numbers verified against `main` at `a6e9d76`. If v7a2 lands
  first, `server.ts` line refs may shift by a few lines — the anchors are named
  (`getOrCreateSession`, `pushProject`, `wss.on("connection")`), so they stay findable.

## 6. Why this file exists instead of a HANDOFF.md update

**`HANDOFF.md` was deliberately not touched.** Its live copy is on
`feature/exit-and-session-leave` (v7a2), which another session was actively editing while this
work happened — as of this writing that branch is at `a635c29` ("v7a2 code-complete and
reviewed; browser pass outstanding") and is **not merged into main**. Editing the same file
from two branches would produce a merge conflict for no benefit, and would risk one session's
account of the project overwriting the other's.

**When this branch merges, fold §1–§4 above into `HANDOFF.md` and delete this file.**

## 7. Resume and verify

```bash
git checkout feature/v7b-hub-relay-plan
git log --oneline -3          # 3 docs commits; working tree clean
ls docs/superpowers/plans/2026-07-27-v7b*.md docs/superpowers/plans/2026-07-27-v7c*.md
gh pr view 18                 # draft, docs-only, describes all four plans
```

Expect: no code changes anywhere. `git diff --stat main -- poc/` must be **empty** — if it is
not, something on this branch strayed outside its scope.
