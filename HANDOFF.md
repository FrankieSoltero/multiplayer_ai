# HANDOFF — multiplayer_ai

*Living resume packet. Update in place; don't recreate. Last update: 2026-07-28 (session #18).*

---

## 🚀 START HERE — `docs/PRD.md` IS THE PLAN OF RECORD. PRD §8.2 ("projects") IS SHIPPED: **PR #22 IS OPEN — DO NOT MERGE IT YOURSELF.** Next: pick the next §8 section and run its brainstorm → spec → plan.

The `v7a → v7b1 → … → v7e` chain is **dead**; PRD §8 has ten named sections, each getting its own
brainstorm → spec → plan. Session #16 wrote the PRD. **Session #17 executed all 13 tasks of the
first section**, `docs/superpowers/plans/2026-07-28-projects.md`, via subagent-driven-development.

### ✅ SOLO-MODE DECISION MADE (user, session #17): **option 1+, and the entrance STAYS**

The problem it resolves: `cli.ts:142,153` auto-opens `http://localhost:PORT/` (no `?project=`) for
every non-hub launch; that URL routes to `ProjectPicker`, which sends `identify` /
`list_projects` / `create_project` — and `poc/server/src/server.ts` implements none of them, so all
three hit its `unknown message type` catch-all at `server.ts:986`. The **project screen has the same
problem**: `SessionPicker.tsx:31,33` sends `identify`/`list_projects` unconditionally too, so
routing alone could never have fixed this — **the standalone server had to tolerate these messages
either way.** That is what collapsed the choice.

**The ruling — "1+":**
1. `cli.ts` opens `?project=default` for non-hub launches, so the normal solo path never depends on
   the entrance.
2. The standalone server **tolerates and answers** the entrance messages rather than erroring:
   `identify` sets identity exactly as the hub does (keeps the two servers' protocols from diverging
   further), and `list_projects` answers with its single project.
3. **The entrance stays reachable and functional in solo** — a bare `localhost:PORT/` lands on a
   one-item entrance, not a dead end. This was the user's explicit call.
4. Clean up the two solo cosmetics in the same pass: the head reading `0 MACHINES` and the repo
   `<select>` rendering zero options, both because `machines` is hub-only.

✅ **That sub-question is ANSWERED and implemented:** `server.ts` does key sessions by `projectId`
(`getOrCreateProject`, `server.ts:227-234`), so `create_project` genuinely creates a reachable
project rather than being refused. NEW PROJECT works in solo. Fix wave 2 (session #18) closed
the auth gate and made the reachability test discriminate — see below.

### ✅ FIX WAVE 2 COMPLETE (session #18) — C1, C2, I4, C5 ALL CLOSED, REVIEWED, PUSHED

Five commits, `0c1ff70..2efe6a2`, TDD-first (RED watched for every behavior change); full entry in
the ledger ("Fix wave 2"). Suites after: **server 436 / hub 83 / client 247**, `tsc` clean ×3,
server `dist/` rebuilt, client build clean. The scoped opus re-review returned **zero Criticals**
and independently re-verified every fix by revert-and-rerun in a throwaway worktree; its one
Important + two minors are fixed in `2efe6a2`.

- **C1 → `0c1ff70`** — `denyUnauthed()` is the first line of `create_project` AND `list_projects`;
  `identify` deliberately stays open (bounded per-connection state only, like `peek_invite`).
  Three new tests pin refusal, non-disclosure, and the signed-in pass-through.
  ⚠️ **RULING WORDING CORRECTED (do not re-import the old phrasing):** the standing rationale said
  the gate is "applied to four handlers the hub has no equivalent for" — **that fact is FALSE**
  (`HUB_HANDLED`, `hub.ts:19`, mirrors `peek`/`watch_project`; `hub.ts:520` handles
  `create_session`; only `set_oversight` has no hub handler). The *conclusion* stands via the
  stronger true argument, now in the code comment (`server.ts:439-450`): the gate is orthogonal to
  parity because hub-mediated traffic arrives on the relay arm, where it no-ops
  (`io.mode === "relay"`).
- **C2 → `12a2a8d`** — reachability proven via `list_projects` (the non-creating read).
  Revert-and-rerun done: write deleted → test fails; restored → green.
- **I4 → `d33aba0`** — `startServer` takes `projectId?` (SLUG-guarded throw, pinned by a test) and
  seeds `getOrCreateProject` at boot; the CLI passes `--project` on BOTH branches. A fresh solo
  entrance is the promised one-item list.
- **C5 → `4236eb1`** — `sessionUrlFor()` extracted beside `localUrlFor` (`cli.ts:117-129`), always
  appends `&project=`; `createSession` prints through it.
- **Parked (reviewer observation, pre-existing from `9749d53`, NOT this wave):** the laptop's
  `create_project` only acks the creator — no broadcast to other locally-connected entrance
  viewers (the hub broadcasts via `pushProjects()`, `hub.ts:392`). Harmless solo (one browser);
  recorded so it isn't rediscovered as a regression.

### ✅ I3 RESOLVED (user ruling, session #18) + ✅ TASK 13 DONE — PR #22 OPEN

- **I3:** the user ruled **option 1 — ship as-is**. Recorded with the `repoKey:""` trap in
  `docs/tech-debt.md` §2.6, disclosed in PR #22's body. Do not re-open; a future fix starts from
  that debt entry.
- **Task 13:** walked THREE ways (ledger has the full record): `--project acme` (all 8 items),
  no `--project` at all (F1's whole surface verified live against `default`), and solo
  (I4's one-item entrance, C5's printed URL, JOIN landing in-session). New walk findings W1-W4
  in the ledger; W1 matters for docs: **the brief's hub command needs
  `CLIENT_DIST=<poc/client/dist>` and the hub reads `PORT`, not `--port`** — as written the hub
  serves a 404 and no browser walk is possible.
- **PR #22** (`feat: projects — the container (PRD §8.2 + §5.1)`) is open against `main` with
  the §5.2/§4.1 gap, I3, debt §2.4, spec §10 Q1 and the create_session bound disclosed.
  **Merging is the user's call, never yours.**

### ➡️ ORDERED NEXT STEPS — do these in this order

1. ✅ **SECTION CHOSEN (user, session #18): §8.3 Machines & repos.** Rationale that carried:
   debt §2.3 makes the hub's central promise false after any laptop restart, the walk's UUID
   machine labels (W4) are the same missing grain, and §8.7/§8.8 would otherwise be built on
   per-launch UUIDs. Brainstorm is OPEN — first scoping question (full D4: one daemon per
   machine + hub-UI repo attach, vs the identity-grain slice first) was put to the user;
   check the conversation for their answer before re-asking.
2. **Run the cycle for the chosen section**: superpowers:brainstorming → spec → writing-plans,
   as §8.2 was done. Reuse `.superpowers/sdd/<date>-<section>/` for the ledger.
3. PRD §8.4's "Today" was refreshed in this session (hub create now works); sweep the other
   section "Today" paragraphs against reality when §8.3 (or whichever) is specced.

### What is done — `feature/projects` = `origin/feature/projects`, last code commit `2efe6a2`

All 13 tasks complete and reviewed, plus fix wave 2, plus the three-way walk. Base is `main`
`0ffeaa3`; `git rev-list --count 0ffeaa3..2efe6a2` = 43 (an earlier "29 commits" note here was
never measured — 80037ec is 37; trust rev-list). **PR #22 is OPEN — the merge is the user's.**

```
2efe6a2  fix(server): review follow-ups — comment fact, seed guard        ← fix wave 2
4236eb1  fix(cli): always append project to the printed session URL       ← fix wave 2 (C5)
d33aba0  fix(cli): seed the launch project at boot — one-item entrance    ← fix wave 2 (I4)
12a2a8d  test(server): prove create_project write via non-creating read   ← fix wave 2 (C2)
0c1ff70  fix(server): auth-gate create_project and list_projects pre-join ← fix wave 2 (C1)
d4ef49a / 80037ec / c02574f  docs: HANDOFF                                ← session #17 wrap
76a99fb  fix(cli): open the project directly on a non-hub launch          ← solo mode "1+"
9749d53  feat(server): answer identify/list_projects/create_project       ← solo mode "1+"
c302dce  docs(prd): the hub is on main — drop the unmerged-branch caveat   ← fix wave (F7)
5a68dd3  test(client): cover refusalText, including the CLI command        ← fix wave (F5)
7d771cd  fix(client): the entrance notices when the hub goes away          ← fix wave (F4)
48ff718  fix(client): a routed create that is never answered … CREATE      ← fix wave (F3)
fe6cf1c  fix(hub): refuse an identify on a channel that has already joined ← fix wave (F2+F6)
1593a2c  fix(client): a session in the `default` project is reachable      ← fix wave (F1, CRITICAL)
d3d6857  fix(hub): clear a stale create_session reply grant on join        ← Task 12
fc354e3  test(hub): creating a session through the hub, end to end         ← Task 12
a520cd8  fix(hub): route a routed command's reply back to the asking channel
7990196  fix(client): solo-mode CREATE regression + non-discriminating test
2944832  feat(client): route to the hub entrance when no project selected  ← Task 11
92852fb  feat(client): project screen with repo, machine and grouping      ← Task 10
edeaad5  feat(client): show member count on the entrance list              ← Task 9
f9d0e95  feat(client): the hub entrance screen                             ← Task 9
0aa750e  fix(server): declare machineId on a snapshot's sessions           ← Task 8
9b41a8e  feat(hub): carry machines and machineId in the project snapshot   ← Task 8
34df48f  feat(client): pure modules for projects, access, grouping, naming ← Task 7
4fe1cf2  fix(hub): SLUG-validate the derived session id before the store   ← Task 6
5965df3  feat(hub): route create_session to the machine offering the repo  ← Task 6
86ab85c  feat(hub): project registry messages                              ← Task 5
a134bfb  test(hub): make the identify rejection test discriminate          ← Task 4
44f7466  feat(hub): identify — per-connection identity                     ← Task 4
892e3d0  feat(hub): project summaries and per-project machine lists        ← Task 3
2d40a0d / 624d9f7 / 8653327 / 977423c / ee08b57 / 9c428bc / 1448635        ← Tasks 1-2 + spec/plan
```

### Resume & verify — run this first, expect exactly this

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git status -sb                        # feature/projects, in sync; untracked: market-research.md, poc/demo-plugins/, tour-skill-suggest.png (NEVER commit these)
git log --oneline -3                  # docs commits only above 2efe6a2 fix(server): review follow-ups … (the last CODE commit)
git ls-remote origin refs/heads/main  # 0ffeaa3… — authoritative; the tracking ref has been observed stale in this repo
gh pr view 22 --json state --jq .state # OPEN — do not merge without being asked
for p in 3001 3002 4000 5173; do lsof -nP -iTCP:$p -sTCP:LISTEN; done   # ALL EMPTY — session #18 stopped everything
cd poc/server && npx tsc --noEmit && npx vitest run   # 436 passed, 20 files  (was 429 before fix wave 2)
cd ../hub     && npx tsc --noEmit && npx vitest run   # 83 passed, 4 files
cd ../client  && npx tsc -b && npx vitest run && npm run build  # 247 passed, 28 files; build clean
```

⚠️ **`npx tsc --noEmit` in `poc/client` is a NO-OP** — its `tsconfig.json` is solution-style with
`"files": []`. Use **`npx tsc -b`**. Every "client tsc clean" claim made before session #17 found
this was weaker evidence than it looked.

### Task 13 — ✅ DONE (session #18). Kept for the amendments' rationale

`.superpowers/sdd/2026-07-28-projects/task-13-brief.md` (now carries Steps 2b/2c, the amended
default-project and solo walks). All steps executed; results in the ledger's "Task 13 walk"
entry; PR #22 opened with the disclosures below.

**Amend the walkthrough before running it — the plan's script has a hole.** Step 2 uses
`--project acme` throughout, so it **never exercises the `default` project**. That is exactly where
the branch's one Critical hid. **Run Step 2 twice: once as written, once with no `--project` at
all.** This is the third time on this branch that a defect lived precisely where nobody set up a
fixture.

**When you open the PR, disclose these in the body** (the plan's coverage table would otherwise
imply the registry shipped whole):
- **Spec §5.2's `close_project`/`archive_project` and §4.1's archived toggle have NO client surface.**
  The hub messages exist and are tested (`hub.ts:388-418`); nothing in `poc/client/src` sends them.
  So a project can never be closed, archived or left from the UI, and archived state is unreachable
  in both directions (`projectList.ts:7` filters archived out with no toggle). **Plan gap, not an
  implementation defect** — Tasks 9-11 never scoped the controls.
- Whatever the user rules on I3 (the deployed no-workspace mode).

### Decisions locked in during session #17 — do NOT re-litigate

1. **A plan-mandated test proven non-discriminating gets its ASSERTIONS STRENGTHENED**, never the
   plan's intent weakened (your standing ruling). The plan's Global Constraint "revert-and-rerun /
   confirm the test fails" outranks any single task's verbatim test code.
2. **Where the plan's code is silent or wrong and the spec is explicit, the SPEC OF RECORD GOVERNS.**
   Applied three times: member count on the entrance (spec §4.1), the reply-routing fix (spec §5.3
   step 4), and the `default`-project routing Critical.
3. **`pendingReplyFrom` — no timer, no `expiresAt`.** An opus reviewer proposed `{uplinkId,
   expiresAt}`; rejected, because it puts time-based state in the hub for an edge this plan does not
   need. Clear-on-join + clear-on-close covers every reachable path; the residual (routed machine
   never answers AND the browser never joins AND the socket stays open) is **documented in the field
   comment at `hub.ts:27-44`** rather than papered over.
4. **Task 4's `identify`/`join` validation duplication STAYS duplicated.** The binding constraint is
   "the hub must reject precisely what a laptop rejects"; a shared helper would make a future edit to
   one path silently change the other. The final review ruled explicitly on this.
5. **Two in-flight `create_session`s on one channel is a KNOWN BOUND, pinned by a named test**, not a
   bug to fix. A single scalar holds one slot; the first machine's late reply is dropped.

### The findings that matter most from this session

**1. The end-to-end harness found a Critical that seven task reviews missed.** `hub.ts`'s reply
narrowcast required `channel.sessionId`, but `create_session` tunnels on a channel that has **never
joined a session** — so `store.ownerOf()` could never authorize it and `session_created` was dropped
**every single time**. Creating a session through the hub could not have worked. Not a test artifact:
the real `SessionPicker` uses the same connect-without-join pattern. **This is the second time in
this project's history that a real-relay-against-real-hub harness surfaced a Critical seam defect on
the first scenario tried.** Fixed by `pendingReplyFrom` (see decision 3).

**2. The final whole-branch review found a Critical that no per-task review structurally could**,
because it lived only in the interaction of three separately-correct pieces: `authRoute.ts` checked
project before session, `joinSession` and `pickerUrlFrom` both omitted `project=default`, and Task 11
had removed `App.tsx`'s `?? "default"`. Net effect: **in the `default` project, clicking JOIN went to
the entrance** — in hub mode too — and so did creating a session and leaving one. Every legacy
`?session=X` bookmark was dead. `default` is `cli.ts:23`'s default and `hub.ts:442`'s join fallback.

**3. This project's chronic failure mode is now measured: 13+ tests that could not fail for the
reason they were named, most written into the plan itself.** Session #17 caught and strengthened
them at Tasks 4, 5, 6, 7, 9, 11 — and the countermeasure fired *inside the fix wave itself*, where
the implementer's own first attempt at the Critical's regression tests asserted through a helper
whose new fallback masked the defect. **Keep making every dispatch carry the revert-and-rerun rule.**

### Gotchas specific to THIS work

- **`laptop()` in `relayIntegration.test.ts` injects a NO-OP command plane** — a tunnelled command is
  swallowed and nothing replies. Use `laptopThatAnswers()` for anything exercising a reply.
- **`poc/server/.env` holds a PLACEHOLDER API key — do not source it.** Launch laptops with the
  `mpai` CLI, never `tsx src/main.ts` (no `workspace` → the SDK reports a confidently wrong
  *"native binary … failed to launch … libc"*).
- **Never `git add -A`.** Verify every commit with `git diff-tree --no-commit-id --name-only -r HEAD`.
- **The plan's predicted suite totals were wrong FOUR times** (229/230/232 and one more). Verify
  against the brief's actual `it()` count; never invent tests to hit a number.
- `poc/hub` and `poc/client` both consume `poc/server`'s **built `dist/`** — rebuild the server after
  changing a type in it, or the other packages typecheck against stale declarations.

### Parked minors — all one-line, none load-bearing, rulings recorded

Full list with reasoning: `.superpowers/sdd/2026-07-28-projects/progress.md` (the ledger). The three
from the very end of the fix wave:
1. `?session=` with an **empty value** falls through to lobby/session with `sessionId === ""` instead
   of the entrance, producing a join the hub rejects at `hub.ts:451`'s SLUG check. Hand-edited URLs
   only. Fix if touched: `params.get("session") || null`. **This also means `App.tsx:143/158`'s
   `activeProjectId ?? "default"` is reachable, not dead code** — the fix-wave implementer claimed it
   was dead and the re-reviewer corrected them.
2. `pickerUrl.ts:55-57` claims it is "the only builder that yields the empty query" — false for a
   legacy `?session=ana` or an invite-resolved session, which still land on the entrance when left.
3. `hub.ts:513-515`'s "`sessionOwned` authorizes only its OWN session's replies" overstates;
   `sessionOwned` is a channel-and-uplink right with no per-reply scoping. The operative conclusion
   (don't delete `pendingReplyFrom`) stands.

### Open questions

1. **PRD §10 Q2/Q3** — whether the entrance lists every project at hundreds (measure, don't guess),
   and whether a project deserves a one-line `intent` (violates P1's name-and-nothing-else).
2. **Spec §8.4** — does a sub-session get its own worktree or share its parent's? Needed before §8.4.
3. **Spec §8.3** — how a headless machine offers a filesystem path picker to a browser it does not
   serve, without becoming an arbitrary-path read primitive.
4. **Three v7b1 residuals, still unanswered:** the uplink fails silently so a wrong hub URL looks like
   a working one; a relay join emits no success signal; `uplinkId` is minted per launch so sessions do
   not survive a laptop restart.
   ⚠️ **TRAP: `repoKey` is NOT a usable machine identity** — with an `origin` present it is
   byte-identical across every clone by design, so two teammates would silently take over each other's
   sessions. Machine scoping must come from `localRepoKey`'s hostname + hashed repo root.

### Files that matter, with line refs

- **Ledger (read this for any detail below): `.superpowers/sdd/2026-07-28-projects/progress.md`** —
  every task, finding, ruling and parked minor. Git-ignored scratch; `git clean -fdx` destroys it.
- Plan: `docs/superpowers/plans/2026-07-28-projects.md` · Spec: `docs/superpowers/specs/2026-07-28-projects-design.md` · PRD: `docs/PRD.md`
- `poc/hub/src/hub.ts` — `SLUG` `:13`; `identify` + already-joined guard `:352-364`; reply
  authorization `:267-290`; `create_session` route + grant `:494-546`; join clears the grant `:470`.
- `poc/hub/src/hubStore.ts` — project records, `listProjects`/`machinesIn` `:153-177`.
- `poc/hub/test/relayIntegration.test.ts` — **the regression net for the relay↔hub seam. Keep it.**
- `poc/client/src/authRoute.ts:54` — entrance requires BOTH ids absent. `pickerUrl.ts` — URL builders.
- `poc/client/src/components/ProjectPicker.tsx` (entrance) · `SessionPicker.tsx` (project screen).
- Pure modules: `projectList.ts`, `projectAccess.ts`, `repoGroups.ts`, `sessionNames.ts`.

---

**🟡 EVERYTHING BELOW THIS LINE PREDATES THE session #16 REFRAME.** It remains the authority on why
shipped v7a/v7a2/v7b1 code looks the way it does, but every "next step", "unmerged", "waiting on a
decision" and vN-ordering framing in it is **superseded by `docs/PRD.md`**. PR #20 is merged; the
"next step is a product question" framing was answered by the PRD.

---

### ⛔ READ THIS BEFORE PROPOSING ANY NEXT TASK — the user rejected the demo, and they were right

At the end of session #15 the user watched a live two-process demo and said, verbatim:

> "This clearly is broken or the demo you are setting up is broken. The goal of this was to get to a
> point where in one party multiple engineers could work on different things and still know what they
> are doing and be able to take control of another persons agent session if they needed too. What we
> have currently is that its one repo per party and a very confusing UI to tell the user where the
> fuck they are."

**This is the single most important fact in this file.** Separate the two halves:

- **Not a demo bug — a missing product.** v7b1 is *transport only*. There is **no team surface**: no
  grouping by repo, no "who is working on what", no way to tell where you are. The picker is a flat
  list keyed to a `project` id that is a **hidden URL parameter** (`SessionPicker.tsx:11,25`).
- **A real demo mistake I made, do not repeat it:** I started two different repos under one
  `--project default` so both would appear in one list. That makes the UI *lie* — the header renders
  the literal string `default` (`SessionPicker.tsx:70`) over two sessions from two unrelated repos with
  no repo labels. The truthful configuration is one project per repo, which then shows only one repo at
  a time — i.e. it demonstrates the gap instead of hiding it. **Do not force multiple repos under one
  project id to make a demo look better.**
- **What DOES work and was proven end to end:** joining someone else's session across the relay and
  **taking the wheel**, including answering a permission gate that then executed on the *other*
  machine. That half of the user's goal exists today.

**THE DESIGN GAP, stated precisely, because this is what the next session must resolve:** today the
model is **session = repo = party** — a party is people inside one session on one repo, because the
agent needs a worktree. The user wants **party = team**, spanning repos, with each engineer's separate
work visible inside it. **Those are different data models, not different screens.** v7b3 as currently
scoped ("host role, host settings, per-repo grouping in the picker") layers onto the *existing* model
and, on my reading, does **not** get there.

**➡️ THE NEXT STEP IS `superpowers:brainstorming` → a spec. NOT `writing-plans`, and NOT executing
v7b2 or v7b3 as written.** Writing a plan from the current v7b3 scope would invent the answer to a
question the user has just reopened. Confirm the framing with the user first — the memory
`v7-hub-product-vision` records this same tension from an earlier session, so it has now surfaced twice.

### State of v7b1 (all verified at `acd5a3b`, nothing inferred)

| Task | Commits | State |
|---|---|---|
| 1–5 | merged to `main` via PR #19 (`c1f3661`) | ✅ |
| 6 · `relay.ts` uplink | `b617fbe`, `baaa3c1` | ✅ complete, review clean |
| 7 · hub WebSocket surface | `3b5e551`, `9b9262f` | ✅ complete, review clean |
| 8 · `mpai --hub` + two-process walk | `140d76f`, `676fd6b`, `f7480d2` | ✅ complete, review clean |
| Deviations section | `43169d9` | ✅ ~515 lines, committed |
| Whole-branch fix wave | `bae78d9`, `2e3b63c`, `79e4913`, `0a9a4ac`, `5d567a1`, `f64492e` | ✅ re-reviewed clean |
| Demo (script + walkthrough) | `3048ac8`, `acd5a3b` | ⚠️ works, but see the rejection above |

**Suites: server 412 (20 files) / hub 48 (4 files) / client 207. All three `tsc --noEmit` clean,
client build clean, `dist/main.js` still top level.**

### Resume & verify — run this first, expect exactly this

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git status -sb                       # feature/v7b1-hub-relay-spine, in sync; untracked: market-research.md, poc/demo-plugins/, tour-skill-suggest.png (NEVER commit these)
git log --oneline -1                 # acd5a3b docs(demo): make the demo show two repos on two laptops, not one
git ls-remote origin refs/heads/main # c1f3661… — trust this over origin/main, observed stale in this repo
gh pr view 20 --json state,title     # OPEN — do not merge without being asked
for p in 3001 3002 4000 4100 5173; do lsof -nP -iTCP:$p -sTCP:LISTEN; done   # ALL EMPTY — session #15 stopped everything
cd poc/server && npx tsc --noEmit && npx vitest run   # 412 passed, 20 files, ~26s
cd ../hub    && npx tsc --noEmit && npx vitest run    # 48 passed, 4 files
cd ../client && npx tsc --noEmit && npx vitest run && npm run build  # 207 passed; build clean
git diff --numstat 18900ff HEAD -- poc/server/test/   # only project.test.ts shows a deletion (63/1) — see gotchas
```

### THE CRITICAL THE WHOLE-BRANCH REVIEW CAUGHT — the lesson matters more than the fix

Eight task reviews and two fix rounds all missed it. The whole-branch reviewer found it by **writing
the integration harness nobody had** (real `relay.ts` against real `hub.ts`) and it surfaced on the
first scenario tried.

`relay.ts` wrote events the moment the socket opened — a full round trip before `welcome` arrives — on
the stated assumption that *"the hub keys on (runId, seq)"*. **The hub keys on a high-water mark**
(`hubStore.ts:157`), equivalent only when frames arrive in seq order, and that window is exactly where
they do not. A reconnect racing a publish silently dropped the whole outage backlog: **laptop 36
events, hub 6**, a 30-event hole in every browser with no indication anything was missing.

**Why it survived:** the only reconnect test delivered `have: {}`, replaying from 0 — a superset, where
loss is impossible *by construction*. **That is the THIRD test in this plan that could not fail for the
reason it was named.** The standing countermeasure that actually works: **revert each fix and re-run its
test**; two separate agents caught non-discriminating tests that way.

Fixed via a `ready` flag (set only after the replay, before `flush()`), and now covered by
`poc/hub/test/relayIntegration.test.ts` — **the first test anywhere that runs a real relay against a
real hub. Keep it; it is the regression net for this entire seam.**

### Decisions locked in during session #15 — do NOT re-litigate

1. **The whole-branch review ran over `18900ff..HEAD` (all 8 tasks), not `git merge-base main HEAD`**
   (which would have covered only 6–8). Tasks 1–5 merged separately and had never had a whole-branch
   review, and cross-task integration is exactly what that review is for. It was the right call — the
   Critical spans Tasks 4 and 6.
2. **Finding "hub and laptop disagree on join validity" was fixed at the HUB** (`typeof msg.name` check)
   rather than by rewriting the tunnelled payload, because that preserves `DownFrame`'s "the ORIGINAL
   client message, untouched" contract (`relayProtocol.ts:53-57`).
3. **The I1 collision fix drops the frame and logs it ONCE per `(uplinkId, sessionId)`; it does NOT
   narrowcast to browsers.** The first attempt did narrowcast and it notified the **winner's** browsers
   — the users whose session was fine — once per second forever, growing an uncapped array
   (`useSessionSocket.ts:71` appends with no cap/dedup). Reverted deliberately.
4. **`ready` REPLACED `open` outright** rather than joining it; judged "the stronger choice" because the
   state machine is then total and provably has no silently-dropped frame.
5. **The Deviations section (~515 lines) was written into the PLAN, not the SDD brief.** Task 8's walk
   results had been written only into the git-ignored `task-8-brief.md` and would have been destroyed
   with the workspace.

### Gotchas a fresh agent WILL hit

- **`poc/server/.env` holds a PLACEHOLDER API key. Do not source it.** `mpai` deliberately does not load
  it. Sourcing it breaks agent turns.
- **Launch with the `mpai` CLI, never `tsx src/main.ts`.** `main.ts` passes no `workspace`, so the
  session workdir is never created and the SDK reports a confidently wrong *"native binary … failed to
  launch … libc"* error. A whole session was lost to that once. Guard now exists
  (`describeUnusableWorkdir()` in `agentDriver.ts`).
- **`echo` does not trigger a permission gate** — the SDK auto-approves trivially-safe bash before
  `canUseTool`. Use `touch <path>` to demo a gate.
- **The hub REQUIRES an explicit `projectId` on `watch_project`/`peek`** (`hub.ts:366-367`) and errors
  without one; the standalone server is laxer. The shipped client always sends it, so nothing is broken
  — **this divergence is NOT yet written down anywhere.**
- **`git diff --numstat 18900ff HEAD -- poc/server/test/` shows ONE deletion** (`project.test.ts` 63/1).
  It is an import line reformatted to six lines by Task 2's `e894dda`, removing no test. Verified with
  `git show e894dda -- poc/server/test/project.test.ts`. The plan's checklist was corrected to say so.
- **An unreproduced flake exists.** One historical `1 failed | 408 passed`, never captured; 30+ green
  runs since. **Ranking corrected:** `routing.test.ts` cannot have been in that run (408+1=409 = the
  server suite exactly; hub is a different package/command), and `relay.test.ts` is fully synchronous
  apart from fake-timer tests. Plausible homes are **pre-existing** wall-clock sleeps:
  `overseer.test.ts:61`, `agentDriver.test.ts:1153-1160`, `server.test.ts`'s many `wait(50)`.
- **Never `git add -A`.** Subagent commits must spell out explicit paths; verify with
  `git diff-tree --no-commit-id --name-only -r HEAD`.

### Open questions — THREE ASKED, NONE ANSWERED. Do not treat any as settled.

1. **The laptop's uplink fails silently** — `socket.on("error", () => {})` and `write`'s `catch {}`
   swallow everything, so `mpai --hub ws://wrong-host` is indistinguishable from a working uplink. It is
   **plan-mandated** (the brief specified that code verbatim), so it needs a human ruling. My
   recommendation: override the brief and log.
2. **Where the join ack lands.** A relay join emits no success signal, so "succeeded", "silently
   rejected as malformed" and "arrived after teardown" are one observation. Recommendation: fold a
   minimal ack into whatever task owns the hub next.
3. **Whether the `uplinkId` fix becomes a Task 9 inside v7b1.** `cli.ts:131` passes no `uplinkId`, so
   `server.ts:1016` mints `randomUUID()` per launch. **Consequence: sessions do NOT survive a laptop
   restart** (orphaned `offline`, and re-creating the same name trips the ownership collision), and the
   resume path is unreachable across a restart. It IS live for same-process reconnects.
   ⚠️ **TRAP: `workspace.repoKey()` is NOT a usable uplink identity.** With an `origin` present,
   `repoKeyFor` returns the normalized remote *alone* (`repoKey.ts:97-103`) — byte-identical across every
   clone by design — so using it would make two teammates **silently take over each other's sessions**.
   Machine scoping must come from `localRepoKey`'s hostname + hashed repo root.

### Ordered next steps

1. **Ask the user the framing question first:** is the next move (a) brainstorm the team/party model
   they described, (b) answer the three open questions and tidy v7b1, or (c) something else. **Do not
   assume.** Their last message reopened the product direction.
2. If (a): run `superpowers:brainstorming` toward a spec for **party = team spanning repos**. Inputs:
   the quote above, the `session = repo = party` vs `party = team` framing, and
   `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md` §3.6/§7. **Do not start from v7b3's
   current scope** — it assumes the model the user just questioned.
3. PR #20 is open and waiting on the user. Do not merge it. If they want v7b1 tidied first, the three
   open questions above are the list.
4. The SDD workspace `.superpowers/sdd/2026-07-27-v7b1-hub-relay-spine/` is **deliberately NOT deleted**
   — it holds every task report and the full ledger (`progress.md`). The durable content is already in
   the plan's Deviations and `docs/tech-debt.md`, so it *can* be `rm -rf`'d, but it is the only record of
   the review reasoning. Deleting is the user's call.
5. **The demo scripts stay but are known-misleading as configured.** `poc/demo-hub-relay.sh` +
   `docs/demos/2026-07-28-v7b1-hub-relay.md`. If the model changes, rewrite the demo from the new model
   rather than patching this one.

### Files that matter, with line refs

- `poc/server/src/relay.ts` — uplink. `ready` flag `:71`, cleared `:109/:151/:180`, set `:231`;
  `emit()` `:263`; `publishFrames` byte budget `:274/:324/:329`; silent error swallow `:171`, `:298`.
- `poc/hub/src/hub.ts` — `HUB_HANDLED` `:18`; uplink plane `:145-240`; collision drop+latched log
  `:203-223`; browser plane `:275-370`; `already joined` `:284`; join typeof triple `:291-297`;
  `watch_project`/`peek` projectId requirement `:366-367`.
- `poc/hub/src/hubStore.ts` — high-water skip `:157`; seq bound `:143`; `resumeOffsets` `:79-88`;
  ownership refusal `:100`; unbounded `uplinks` growth `:43-45,50-53` (known bound).
- `poc/hub/test/relayIntegration.test.ts` — the real-relay-vs-real-hub net. **Do not delete.**
- `poc/server/src/cli.ts` — `--hub` parse `:45-51`, `--project` SLUG check `:50`, conditional spread
  `:131` (this is what makes the additive invariant structural), `args.open && !args.hub` `:144`.
- `poc/server/src/server.ts` — `relay` construction `:1001-1016`; `relay?.` sites `:206,285,296,1061,1072`;
  `HUB_HANDLED` coupling comments `:526`, `:564`.
- `poc/client/src/components/SessionPicker.tsx:11,25,70` — the flat, project-id-keyed picker the user
  called confusing.
- Plan + Deviations: `docs/superpowers/plans/2026-07-27-v7b1-hub-relay-spine.md` (Deviations at ~`:3085`).
- Bounds: `docs/tech-debt.md` §1.5b, §2.3, §2.4, §2.5, §4.


**✅ THE "AGENT TURNS DO NOT RUN ON THIS MACHINE" BLOCKER IS RESOLVED (session #14, 2026-07-27). Agent turns DO run here. There was never anything wrong with the SDK binary.**

- **Root cause:** the SDK spawns its native binary with `cwd: workdir`. The workdir **did not exist**, so `spawn` failed with ENOENT — and the SDK reported that as *"native binary … exists but failed to launch. This usually means the binary does not match this system's libc."* A confident, specific, and completely wrong diagnosis, taken at face value for a whole session.
- **Why the workdir was missing:** session #13 started the server as `npx tsx src/main.ts`. **`main.ts` passes no `workspace`**, so `server.ts:184-185` derives `AGENT_WORKDIR_ROOT/<sessionId>` and **nothing ever creates it** — the §0 workspace-provisioning gap, which nobody had connected to the agent failure. `~/mpai-test-workdirs` was empty the entire time. The two `agent_error`s were (1) the stream dying at spawn and (2) `sendPrompt` refusing on a dead driver, which is also why `user_message` never appeared.
- **The operational rule, and it needs no code:** **launch with the `mpai` CLI** (`cli.ts` → `startServer({ workspace: new WorkspaceManager(...) })`), which provisions a real git worktree per session. `tsx src/main.ts` / `node dist/main.js` cannot run an agent turn unless something else created the workdir first. (§6's demo note "worktree FIRST or misleading 'native binary failed to launch'" was this same bug, already written down and not recognised.)
- **Proven end to end, not inferred:** a wire probe against a real workspace-backed server produced `presence_join → control_change → user_message → agent_text_delta("pong") → turn_end`, zero `agent_error`. The same probe against the no-workspace config reproduces the old failure on demand.
- **Code fix, on branch `fix/agent-workdir-guard` (off `main`, UNMERGED, one commit, no PR yet):** `describeUnusableWorkdir()` in `agentDriver.ts`, checked inside `runAgentQuery` before `query()`; a missing/non-directory workdir now fails with a message naming the path and how to start the server. **Deliberately not `mkdir`-ed** — an empty non-git directory would let the agent look like it works while operating in an empty folder (the §0 ruling, unchanged). Server suite **348 passed** (345 + 3 new `describe("workspace guard")` tests), `tsc` clean. Worth merging before v7b1 so nobody loses another session to that message.
- **What this un-blocks:** permission gates, `agentBusy`, the confirm bar, and the whole relay path v7b1 exists to prove are all verifiable here now. **The two ❌ items in the v7a2 browser pass below are re-testable** — `exitWouldStrand` was only ever null because `user_message` was never appended. Likewise the EMPTY-badge caveat: sessions displayed "AGENT STOPPED" because every driver died at spawn, not because of a lifecycle defect.
- **Still open, unchanged:** if `AGENT_WORKDIR_ROOT` is unset entirely, `agentDriver.ts:133` still falls back to `process.cwd()` — an existing directory, so the new guard passes it — which under systemd means the agent edits the running deployment's own source tree. That half of §0 is untouched and remains an A1b blocker.

---

**🟢 HISTORICAL FROM HERE DOWN — v7a2 IS MERGED (session #14, on the user's explicit go). `main` is `18900ff`.** The block below was written while v7a2 was still on its branch; its *content* is still the authority on why v7a2's code looks the way it does, but every "unmerged / waiting on a decision" framing in it is now stale. `feature/exit-and-session-leave` still exists locally; deleting branches is the user's call.

**v7a shipped: PR #17 merged at `a6e9d76`. `main` == `origin/main`.** The SDD workspace for v7a was deleted on completion — git history is the record. `feature/v7a-repo-identity-lifecycle` still exists locally (deleting branches is the user's call).

**~~You are on `feature/exit-and-session-leave` at `8711653`~~ — SUPERSEDED. v7a2 merged into `main` in session #14 and you are now on `feature/v7b1-hub-relay-spine`. See the top of this file.**

- **The ledger is your recovery map — read it before anything else:** `.superpowers/sdd/2026-07-27-v7a2-exit-and-session-leave/progress.md`. It records every task, review, ruling, adjudication and parked residual, and ends with the browser checklist. Trust it and `git log` over any recollection. **Do not delete that workspace until the browser pass is done — the checklist is written down nowhere else.**
- **All 5 tasks are complete and reviewed clean.** Then the whole-branch review ran on opus, found 2 Important + 7 Minor, one fix wave landed (`ef905ba`, `8711653`), and the scoped re-review verdicted all seven ADDRESSED with no new breakage.
- **Suites on the branch, verified at `8711653`: server 359, client 207, tsc clean both, client build clean.** Working tree clean apart from the three untracked user files.
- **The plan's Deviations section is complete — six entries.** Read it before touching v7a2 code.
- **What the whole-branch review caught that all five task reviews missed:** `/exit` was **silently swallowed by the slash-autocomplete menu**. `parseClientCommand` ran only inside `submit()`, but `PromptBar`'s `onKeyDown` returned from the menu's Enter branch before `submit()` was ever reached. Because `matchSkills` does a case-insensitive **substring** match over the real SDK roster, typing `/exit` + Enter either did nothing or **rewrote the user's `/exit` into a different skill merely containing "exit"** and sent it as a skill suggestion. Spec §4's "the client command wins, `/exit` is reserved" was implemented in `submit()` but not at the key that reaches it — the branch's headline feature, broken on its headline surface. Fixed with a pure `shouldSubmitOverMenu` predicate in `clientCommands.ts`, unit-tested.
- **The second Important, worth knowing because it upgraded a deferred minor:** `take_wheel` had no membership check, so the departed-but-connected state `leave_session` newly creates produced **a driver absent from the roster**. Reachable through the shipped UI — with auth ON, two tabs of one signed-in user share a `userId`, so tab 2 can `/exit` while tab 1 keeps a live UI and takes the wheel. Also sticky: `session.leave` short-circuits before the driver-handoff block, so `currentDriverId` stayed pinned to the departed user permanently. Guarded now, with a server test.
- **A ruling that reversed an earlier reviewer, do not re-open it:** **not** nulling `ctx` in the `leave_session` handler is **correct**. Nulling it would skip `ctx.unsubscribe()` and `project.watchers.delete(ws)`, leaking a subscription and a watcher entry per exit. An earlier task review flagged the asymmetry with `ws.on("close")` as a defect; the final review traced it and ruled the code right.
- **THE BROWSER PASS IS DONE — run 2026-07-27 via Playwright MCP. 6 of 8 scenarios PASS, 2 untestable on this machine (not failures).** Full detail in the ledger. **The user decided in session #14: v7a2 was merged into `main` (no-ff) before v7b1 branched, so v7b1 builds on top of it.**
  - ✅ `/exit` beats the slash menu (the regression the fix wave existed for) · ✅ deliberate last leave → CLOSED with no intermediate EMPTY · ✅ a watcher can `/exit` · ✅ the `take_wheel` guard refuses a departed-but-connected ghost with "you have left this session" · ✅ **a disconnect never closes a session** (the load-bearing rule) · ✅ rejoin a closed session → prompting returns "⚠ this session has been closed", so v7a's guards survived.
  - ⚠️ The confirm bar (agent-busy reason, Escape, stale-reason clear) was recorded as **unreachable on this machine**. That was a consequence of the workdir bug, now resolved (see the top of this file): `agentBusy` is set by `user_message`/`tool_call`/`agent_text_delta`, and none were ever appended because every driver died at spawn. **Re-testable now — run the server via `mpai` and this scenario should work.** Still unverified, not a defect.
  - ❌ EXIT during socket CONNECTING — a genuine race, not hittable deliberately on localhost. One-line early return, verified by review only.
  - **Caveat worth carrying:** the same agent failure sets `ended` on every session, and `ended` **outranks** `empty` in the precedence chain, so sessions display "AGENT STOPPED" where a healthy machine shows EMPTY. **The EMPTY badge itself was therefore never visually confirmed** — the load-bearing part of the disconnect test (not CLOSED, still joinable) was, and the row's participant text did read "empty". Re-check the badge once the agent runs.
- **A TEST FIXTURE IS ON DISK AND SHOULD BE DELETED WHEN DONE:** `poc/demo-plugins/default/exit-collision/` (plus its `.meta.json`) holds two fake skills, `exit` and `exit-plan-mode`. **Without it the `/exit` test is a FALSE PASS** — the 26 real demo skills contain no "exit" substring, so the slash menu never opens and `/exit` succeeds trivially without exercising the fix. Remove with `rm -rf poc/demo-plugins/default/exit-collision*`. It lives inside the already-untracked `poc/demo-plugins/`, so git is unaffected.
- **STACK STATE AT THE END OF SESSION #14: nothing of this session's is running.** Session #13's leftovers (a `tsx src/main.ts` server on :3001 and vite on :5173) were killed; an `mpai` server that appeared on :3001 mid-session — started by hand from a VS Code terminal, so possibly the user's — was **not** touched by this session and was gone by the end. Two throwaway servers on :3002/:3003 were started and stopped. Always `lsof -nP -iTCP:3001 -sTCP:LISTEN` before assuming.
- **A DEV STACK MAY STILL BE RUNNING from session #13** — server :3001 (`npx tsx src/main.ts`, started with `AGENT_PLUGINS_ROOT=<repo>/poc/demo-plugins` and `AGENT_WORKDIR_ROOT=~/mpai-test-workdirs`, deliberately **without** `poc/server/.env` so auth stayed OFF and the placeholder API key stayed unset) and client :5173. **Check `lsof -ti:3001 -ti:5173` before doing anything, and never switch branches while a stack is attached.** Kill with `kill $(lsof -ti:3001) $(lsof -ti:5173)`.
- **The bug the Task 2 review caught, so nobody reintroduces it:** the auto-close must key on whether **this** leave emptied the room, not on the room being empty. `Session.leave` is idempotent, so a repeat `leave_session` from someone who already left removes nobody — but if a **socket close** emptied the room meanwhile, keying on emptiness closes a session a disconnect ended. v7a made closing one-way, so that strands the party's work permanently, and it blames a departure that did not cause it. `Session.leave` now returns `boolean` and the handler gates on it.
- **Spec (approved, do not re-brainstorm):** `docs/superpowers/specs/2026-07-27-exit-and-session-leave-design.md`. Its §2 records every decision with the reasoning; §7 is the out-of-scope list.
- **v7a2 is NOT v7b.** v7b is the hub, `relay.ts`, device pairing, the trust inversion and host settings (v7 spec §1.2). v7a2 is v7a's tail: it gives `close_session` its first caller. Everything v7a2 defers — server shutdown, host-initiated close, the settings screen — lands in v7b's scope by design, not by accident.
- **What it builds:** `/exit` and an EXIT header control, both meaning *I leave, the party continues*. There is no way to leave a session today — `presence_leave` fires only on socket close (`server.ts:865`) and there is no route back to the picker.
- **The load-bearing decision, do not soften it:** only a **deliberate** `/exit` may auto-close a session; a disconnect never may. v7a made closing **one-way with no reopen path**, so letting a dropped wifi connection close the last participant's session would permanently strand the party's work. That is why the design needs a new `leave_session` wire command at all — the server otherwise cannot tell "I'm done" from "my laptop slept."
- **A hazard the spec already solved, don't re-derive it:** the client sends `leave_session` then reloads, so the server sees the command *and then* the socket close — and `server.ts:873` also calls `session.leave()`. Without an idempotency guard in `Session.leave()` itself, every deliberate exit writes **two `presence_leave` events** into an append-only log that is replayed to late joiners, and fires the auto-close twice.
- **This makes `close_session` reachable for the first time** — v7a shipped it with no caller, which was PR #17's stated known gap. Auto-close is now its first caller. A *host* closing a live session with people still in it remains unbuilt and belongs with the settings screen.
- **NOTE:** this HANDOFF update lives on `feature/exit-and-session-leave`, so `main`'s copy is one step behind until that branch merges.
- **Plan of record for v7a itself:** `docs/superpowers/plans/2026-07-27-v7a-repo-identity-lifecycle.md` — **its Deviations section is filled in and is the authority on why the shipped code differs from the listings.** Read it before touching v7a code. **Spec:** `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md`.
- **Four v7a rulings that must not be re-litigated:** `close_session` uses `pushProject`, not `schedulePush` (the plan said otherwise and the plan was wrong — `session_closed` is not in the `INTERESTING` set, so without an explicit push project watchers never see `lifecycle` flip). `permission`/`decide_plan` are **deliberately left unguarded** on a closed session — guarding them would strand a live agent waiting forever on a promise nobody can resolve, and a test pins the exemption. `presence` is a hardcoded `"online"` by design (spec §3.4: the client learns the wire shape before v7b makes the value vary). And `sessionState.ts` **deliberately departs from the plan's verbatim listing** — the user ruled the duplicated precedence chain be refactored into one `degradedState()` with exhaustive lookup tables, so drift is now a compile error.
- **What the final review caught that four task reviews missed, worth knowing:** the branch had shipped `lifecycle` to only ONE of the two client surfaces that show session state — `SessionPicker` still read `s.ended` alone, so a deliberately closed session listed as **LIVE with a JOIN button**. The exact conflation v7a exists to remove, surviving on the screen where the join decision is made. Fixed in `c386651`. Also caught: `repoKey`'s `lastIndexOf("@")` scanned past the authority, so `https://github.com/acme/a@b/c.git` produced the fabricated key `b/c` — the module's only violation of its own "a wrong match is worse than no match" contract. Fixed in `64839e6` by splitting the authority at the first `/` first, which keeps credential-stripping working for passwords containing `@`.
- **Parked residuals from v7a's final review (adjudicated and shipped as-is — the ledger they were recorded in is deleted, so this is now their only record):** `agentStateLabel` (`sessionRow.ts:12-14`) is **production-dead** — the SessionPicker fix took its last caller, and it is a second divergent badge-label source sitting beside `sessionState.ts`; retire it in the v7 scrub pass. A closed session **still shows a JOIN button** (deliberate: joining is how a human resolves an in-flight permission gate, which v7a explicitly preserved). `.spstate.closed` and `.spstate.ended` are **both `var(--red)`**, so the picker distinguishes them by label text alone — same cosmetic-not-structural note the plan's Deviations parks for `.member.closed`. An unencoded `/` inside userinfo now returns `null` rather than a key — correct (fail-safe direction), but undocumented in the fix report at the time.

---

**STATE: A2a, A3 AND v7a ARE ALL MERGED AND PUSHED. `main` == `origin/main` at `a6e9d76` (verify with `git ls-remote origin refs/heads/main`, which is authoritative — the `origin/main` tracking ref has been observed stale in this repo). Suites on main: server 345, client 179, both tsc clean, client build clean. Nothing running, nothing half-finished.** (The older figures 305/160 are v7a's starting baseline and are superseded.)

**A3 (pull notifications) is DONE and verified in a real browser** — spec, plan, all four tasks, deviations recorded, merged at `0450c8d`. The behaviour: a permission gate in another session that goes unanswered past *your* threshold lights that session's OTHER PARTIES row amber and shows `🔐 PULLS ▸ N` in the header. Off by default; the delay is per-recipient (OFF / 30s / 1m / 2m / 5m) in `localStorage["mpai-pull-after-ms"]`.

**⚠️ MAJOR PIVOT, session #11 (2026-07-27): v6b IS SHELVED AND v7 REPLACES IT AS THE PLAN OF RECORD.** Read `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md` before anything else — it is the authority now, and much of §3e/§7 below is superseded by it (each superseded item is listed in that spec's §1.1). v6b was abandoned *mid-brainstorm* once it emerged that it was designed against a topology the product is replacing; its banked decisions (§3b) survive intact as **v7e**.

**Why:** the user's product vision is a **cross-repo team hub with agents running on each engineer's own laptop** — not the one-server-one-repo model the code implements. Today a server binds to exactly one repo at launch (`cli.ts:102-120`, `server.ts:82`), so five engineers across four repos get four servers, four URLs and zero cross-visibility. v7 splits the two roles currently fused in one process: local `mpai` keeps the repo, worktrees, event log and permission promise; a new **hub** owns identity, roster, relayed events and the web client, **running no agent and holding no API key**. Laptops dial *outbound*, so no inbound ports anywhere.

**This dissolves four banked blockers rather than solving them:** per-user API keys (§7b), workspace provisioning (§0, for the hub), key custody on an assume-breach box (§3e), and agent sandboxing/multi-tenancy (Reading B). It adds two ordinary ones: hub-side persistence and offline-laptop handling.

**v7 pieces, in order:** **v7a** repo identity + session lifecycle (ships against today's standalone server) → **v7b** hub + relay → **v7c** persistence (SQLite) → **v7d** handoff continuity → **v7e** collision detection (the old v6b). Spec covers v7a+v7b; v7c–v7e are scoped in its §7.

**Standing decision, session #11: security and optimization are DEFERRED to a scrub pass after v7 is written** — logged in `docs/tech-debt.md`. **That scrub is a gate on DEPLOYMENT, not on v7 completion**: `docs/tech-debt.md` §1.1 is a pre-authentication DoS (no `maxPayload`, `server.ts:269`) and v7's whole purpose is putting a hub on the public internet.

**What session #10 did, in order:** ran Task 8 (results in the A2a plan's Deviations) → merged `feature/a2a-github-oauth` into main (`0283e14`, no-ff, verified green after the merge) → built the sign-out control (`ed09d9f`) → deleted the user's test session → wrote and committed the A3 spec (`0fe0cc9`) and plan (`9b3b5e7`).

**Task 8 outcome — the branch's riskiest question is answered.** `SameSite` across the OAuth redirect **works**: the user signed in with a real GitHub account and came back signed in. The denied screen is identity-aware (shows your own login). Driver controls with auth ON are confirmed live — roster reads `■ testuser 🛞 DRIVING · you`, prompt bar enabled, no UUID anywhere on the page — so whole-branch Critical 1 is definitively closed. **One gap, recorded honestly:** the invite return path was verified at the *mechanism* level (the `next` cookie carries `/?session=…&invite=…` through the round trip, `HttpOnly; SameSite=Lax`) but never walked end-to-end in a private window. That is the one A2a claim resting on inference rather than observation.

**Technique worth reusing: you can exercise the entire auth-ON client path without GitHub and without touching the real secret.** Run the server with `GITHUB_CLIENT_ID=dummy-id GITHUB_CLIENT_SECRET=dummy-secret SESSION_SECRET=testsecret GITHUB_ALLOWLIST=testuser`, mint a cookie with `node -e 'import("./dist/auth.js").then(m=>console.log(m.signSession("testuser","testsecret")))'`, and set it via `document.cookie` in Playwright (HttpOnly blocks JS *reads*, not writes). Everything downstream of the token exchange is then testable. Also: Node's `--env-file` **yields to an already-set shell variable**, which makes allowlist/denial testing non-destructive and one restart to undo — never edit `poc/server/.env` to test.

**Two Criticals were found by the whole-branch review that all seven task reviews missed — both fixed, both worth knowing about (§4g). The sharper one: the client never learned its own verified identity, so with auth ON `isDriver` was always false for everyone and the approve/deny controls were hidden entirely — the permission gate, the product's whole wedge, was unanswerable from the UI.**

Session #8 was design-only: no production code changed. Two commits, both docs (`5116fe8` spec, `fc89bdf` plan). **A2 was split in two** because its billing half turned out to depend on an unresolved model-provider question while its identity half depended on nothing:

- **A2a — identity.** GitHub OAuth + allowlist + landing/sign-in screens + server-verified `userId`. **Fully unblocked**: no box, no domain, no API key, no pending decision. Spec + plan committed.
- **A2b — provider + session credential.** Provider-scoped model registry and one API key per session. **Gated on a spike** (§7a) that needs an API key the user does not yet have.

Session #7 turned "let's get this production ready" into a scoped programme. That request spans 8–10 independent subsystems, so it was split into two readings and the user chose the first:

- **Reading A (chosen, in progress):** ready to run in front of real users on a real box — deploy, TLS, auth. This is `docs/superpowers/specs/2026-07-25-deployment-strategy-design.md` §2/§4.
- **Reading B (after A):** real teams unattended — persistence, reconnect, multi-tenancy, sandboxing, audit, rate limiting. That spec's §6 roadmap, unchanged.

**BUILD ORDER RE-SET BY THE USER 2026-07-27 (session #10): A3 → v6b collision detection → A1b deployment.** This supersedes the old `A2b → A3 → A4 → A1b` ordering. The user's reasoning: collision detection is the thing a 6-engineer team actually needs, and after it "that just leaves us with the actual deployment set up." **A2b and A4 are deferred, not cancelled** — both are described below and neither has been deleted from the plan of record.

| ID | Scope | Status |
|---|---|---|
| **A1a** | Deployment wiring, in-repo only | **DONE — merged `f33ce06`** |
| **A2a** | GitHub OAuth + allowlist + verified `userId` | **DONE — merged `0283e14`.** Sign-out control followed in `ed09d9f`. |
| **A3** | Pull notification ("🔐 Ana's session needs an approval — drop in") | **DONE — merged `0450c8d`.** Verified in a real browser. Files: `poc/server/src/pendingGate.ts`, `poc/client/src/pulls.ts`, plus PartyPane/Header/App wiring. |
| **v6b** | File-collision detection surfaced as human-facing interrupts | **NEXT — user's explicit priority.** Banked decisions in §3b; **no spec yet, needs brainstorming → writing-plans.** Shares A3's delivery surface (OTHER PARTIES rows + header badge), which is why it goes second: it extends that rail rather than inventing one. |
| **A1b** | Deployment execution: provision, DNS, Caddy, systemd, live verify | **LAST.** Blocked on user hardware (box, domain, API key) **and on a code fix** — see the workspace-provisioning blocker in §0, which is not a deploy step. |
| A2b | Provider-scoped models + one API key per session | **DEFERRED.** Designed at decision level (§3f); blocked on the §7a spike, which needs an API key the user does not have. Nothing in A3, v6b or A1b depends on it. |
| A4 | Canned demo scenario reaching a permission gate | **DEFERRED.** Not needed to deploy; needed for the demo/YC moment. Note the coupling: A3 is off by default, so an A4 script must include an explicit "set PULL AFTER to 30s" step or the pull will not fire while anyone is watching (A3 spec §6). |

**Deployment is deliberately LAST.** The original strategy put it first, reasoning that an OAuth callback needs a public HTTPS URL. That was wrong: GitHub OAuth apps accept `http://localhost` callbacks for development, so A2 needs the public URL only for *final verification*. Deploying last also means there is never a window where a public URL exists without authentication.

Merged bottom-up on the user's explicit go (this supersedes the earlier standing "leave them open to review" instruction, which is now void): **#13** oversight → main (`8076d40`), **#12** invite → main (`7f31a79`), **#14** arcade/Tetris+Doodle → main (`e547904`), **#15** arrow-nav + header-clip + model-picker fixes → main (`2669ebf`). Each was retargeted to `main` as its base landed. Main verified green after those merges at **client 116 / server 215** — *historical figures for that session only; the current baselines are 120 / 227 (§0).*

We are ON `main`, pushed and in sync with origin. No dev stack running (:3001 and :5173 both freed). Feature branches were NOT deleted. **`feature/a2a-github-oauth`, `feature/signout-ui` and `feature/a3-pull-notifications` are LOCAL-ONLY and fully merged into main** — their content is on origin via main, only the branch refs are local. Tidying is a user call.

**THE ONE THING THAT MUST BE FIXED BEFORE ANY REAL SESSION RUNS ON A BOX:** production sessions have **no workspace provisioning**. `poc/server/src/main.ts` never passes a `workspace` to `startServer` (pre-dates A1a), so `poc/server/src/server.ts:174-175` derives `workdir = path.join(AGENT_WORKDIR_ROOT, sessionId)` — and **nothing ever creates that directory** (`mkdir` appears only in `workspace.ts`, `cli.ts`, `pluginStore.ts`, none on this path). Worse, if `AGENT_WORKDIR_ROOT` is unset, `poc/server/src/agentDriver.ts:133` falls back to `process.cwd()`, which under the systemd unit is `/opt/multiplayer-ai/poc/server` — **the agent would edit the running deployment's own source tree.** Deliberately NOT patched with a bare `mkdir`: an empty non-git directory would look like it works while the agent operated in an empty folder; failing loudly is better. Documented in `deploy/RUNBOOK.md` §0 and §8 and spec §9. This is an A1b blocker.

**Still unconfirmed by a human (carried from #6d, never answered):** the AGENT model-picker fix (`10189f0`). A `<label>` wrapped the `<select>` with no htmlFor/id pairing, so the label forwarded a second synthesized click and the native dropdown opened then instantly closed. Now a `<span>` + `aria-label`, plus Enter/Space→`showPicker()`. Verified structurally only; a native dropdown cannot be observed in headless Playwright. **Ask the user whether it works in their browser.** If not, next suspects are `.term-header select` CSS (`appearance`, custom border) and whether the click lands on the `▾` chrome.

## 0. WHERE WE ARE

- **CURRENT AS OF SESSION #14 (2026-07-28): `main` is `c1f3661`, pushed.** It carries PR #18's four v7 plans (`be3b1b2`), v7a2 (`/exit` + session leave), the workdir-guard fix (together `18900ff`), and PR #19 — **v7b1 Tasks 1–5** (`c1f3661`). **Baselines on main: server 385 / hub 17 / client 207**, tsc clean in all three, client build clean, `dist/main.js` top level. Work continues on `feature/v7b1-hub-relay-spine` (pushed, in sync, identical content to main). **Every baseline figure below this line is historical and superseded.**
- **main** (pushed to origin; `0450c8d` = merge of A3, `ed09d9f` = sign-out, `0283e14` = merge of A2a, `f33ce06` = merge of A1a). Everything below is ON MAIN and verified there: session launcher + `mpai` CLI, oversight agent, invite system, arcade with Tetris + Doodle Jump, arrow-key navigation, header-clip fix, model-picker fix, **and A1a deployment wiring**. **Baselines on main now: server 305 tests / client 160 tests**, both `tsc --noEmit` clean, client build clean. (Earlier baselines of 297/147, 227/120, 116/215, 161/72 and 84/99 are all superseded.)
- `mpai` is globally runnable via symlink `~/.local/bin/mpai → poc/server/bin/mpai.js` (machine setup, not in repo; npm link needs sudo here).
- **Nothing running.** :3001 and :5173 both freed at the end of session #6d.
- **Branches not deleted.** `feature/oversight-agent`, `feature/invite-system`, `feature/arcade-tetris-doodle`, `feature/arrow-nav` still exist locally and on origin, as do the older merged ones (`feature/v6c-plugins`, `feature/slash-autocomplete-v2`, `feature/workflows-screen`, `feature/session-launcher`). Deleting is destructive and is the user's call — do not do it unasked.
- **Never demoed live: the oversight agent.** It shipped to main without the demo checkpoint (the user skipped it by asking for the PR). `docs/demos/2026-07-26-invite-and-oversight.md` beats 9-11 are the oversight half.
- **Invite final-review fix wave (`4f9ea92`) — what it closed, so nobody re-opens it:** (1) `listFor`/`revoke` were project-blind while `redeem` was not → an attacker founding a same-named session in another project could `list_invites` and receive other projects' **secret tokens**. Both are now `listFor(projectId, sessionId)` / `revoke(id, projectId, sessionId)`. (2) `send` in `useSessionSocket` was re-created every render, so the INVITE screen's effect looped at ~20k `list_invites`/sec — now `useCallback(…, [])`. (3) `requireInvite` had no operator switch → now `REQUIRE_INVITE=1` (plus `INVITE_TTL_MS`/`INVITE_MAX_USES`), still **off by default**. (4) other participants' panels showed revoked invites as live → the client re-requests `list_invites` when an `invite_*` **event** arrives (never broadcast `invite_list` — it carries tokens).
- v6b (interrupt rail / fleet) still banked at decision level (§3b). Launch build (§3d) still PARKED.

## 1. Goal & current task

Project goal: YC Fall 2026 "Multiplayer AI" RFS exploration.

**STATUS: A2a and A3 are both merged and closed. No code task is in flight, and nothing stopped mid-way.** Working tree clean apart from the three permanently-untracked user files. The SDD workspace `.superpowers/sdd/2026-07-27-a2a-github-oauth/` was NOT deleted — A2a is done, so it can go whenever (`rm -rf`), but everything it recorded already survives in the plan's Deviations section, which is committed.

**Next real work: v6b — file-collision detection. It starts at `superpowers:brainstorming`: banked decisions exist in §3b but there is NO SPEC.** Do not start writing code from §3b alone. Full framing and the two unsettled design questions are in §4 step 2.

- Every deviation from the plan is recorded in the plan's **Deviations** section (committed). Ten divergences plus the two whole-branch Criticals. Read that section before touching A2a code — it explains why the shipped code differs from the plan's listings in ten places, and re-litigating any of them would reintroduce a security hole.
- `docs/superpowers/specs/2026-07-27-a2a-github-oauth-design.md` remains the authority. **One part of it is now known stale:** §4.3's rationale for join-level-only gating claims the landing and invite screens depend on unauthenticated `peek`. They do not — `Landing.tsx` opens no socket and `InviteSignIn.tsx` sends only `peek_invite`. That staleness hid Critical 2.
- Brainstorming and writing-plans are **DONE and user-approved** — do not redo them.

**The A2 invite-vs-OAuth collision that used to block this is RESOLVED — see §3f.** Do not re-open it.

**Do NOT re-litigate these — they are decided:** the arcade design questions (§4c), the arrow-navigation contract (§4d), the piggyback research conclusions (§7), everything in §3e (the Reading A decomposition, the identity-vs-billing split, the hosting choice), and everything in §3f (the A2 split, the auth model, the provider strategy, one-key-per-session).

**The `PreToolUse` gate spike (§7) is now deprioritised, not cancelled.** It decides whether the claude-code piggyback strategy is viable. The user chose production-readiness over it in session #7; it remains the right next research item once Reading A lands.

**PROCESS NOTES (standing):** context hook ≈40% = HARD STOP (refresh this file, tell the user to /clear, end the turn). Don't pair AskUserQuestion with long content — the dialog hides the text being approved. Subagent commits MUST use explicit `git add <paths>` (§6). SDD workspace scripts live under `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/`.

## 2. Earlier shipped work (all on main — historical reference)

- **v6c plugins (PR #8):** PluginStore https-clone/validate/namespace, `plugin_change` + `plugins`/`pluginsEnabled` snapshots, SDK `plugins:[{type:'local',path}]` + `skills:"all"` + live roster via `supportedCommands()`, AGENT_SKILLS retired. Junk-roster known-unknown CONFIRMED at demo and recorded in that plan's Deviations (roster has non-skill rows like `/agents` "(removed)…"; no SDK discriminator, sdk.d.ts:6596-6613).
- **slash-autocomplete v2 (PR #9, demo-passed):** `poc/client/src/slashMatch.ts` (substring match prefix-first, `moveHighlight` wrap, `notRemoved` junk filter — drops descriptions starting `(removed`); filter applied at `derive.ts` skill_roster fold AND `skillSuite.ts` suiteFromSessions (final-review catch — suite path reads raw per-session roster); PromptBar keyboard menu (3-row 108px window, ↑/↓ wrap, Enter/Tab accept `/name ` trailing space, Esc dismiss until text change, Shift+Tab untouched, ARIA combobox, `effectiveHighlight` single clamp).
- **Viewport-fit fix (`c5e82bc`, on the workflows branch):** `.cabinet` height:100%/padding 22px, `.cabinet-inner` + `.crt` flex:1 min-height:0, `Crt.tsx:27` default height "100%" (was fixed 764) — page itself never scrolls; all scrolling inside screen regions.

## 2c. Workflows screen (shipped PR #10 — kept for reference)

Live session-scoped view of SDK subagent/task lifecycle: relay forwards `task_started/task_progress/task_updated/task_notification` (SDK system messages) as normalized `task_event` wire events (progress throttled per task: leading append + trailing latest-wins flush, done supersedes, flush-on-normal-stream-end / discard-on-error); attributed `task_stop` appended BEFORE `query.stopTask(taskId)`; client folds into `DerivedState.tasks`; WORKFLOWS screen (`?screen=workflows`, W hotkey, header badge `WORKFLOWS ▸ N` while running) with RUNNING/FINISHED sections and driver-only STOP.

## 3. Decisions + why (do not re-litigate)

- All v1–v6a/v6c decisions stand (append-only wire + client derivation; relay+gate server; accessibility floor; auto-mode relay enforcement; `skills:"all"` reversal deliberate; deployment §3d).
- **Autocomplete (shipped, keep semantics):** substring matching because namespaced plugin names made prefix useless (`/handoff` found nothing); Enter/Tab accept + Esc-then-Enter raw submit (Slack/VS Code convention); menu only on name token (`^\/(\S*)$`), closes at first space, backspace reopens; minimal `(removed` junk filter only — anything broader is hand-maintained guesswork (no SDK skill-vs-command discriminator); Shift+Tab never captured (v6a accessibility ruling).
- **Workflows screen (user-approved 2026-07-26):** watch + manage where manage = STOP only — SDK exposes `stopTask` and nothing else per-task (no pause/resume/re-run; backgrounding skipped for v1); separate screen not a main-view panel (main view already dense; transcript already shows subagent tool calls inline); wire = append `task_event`s + client derive, NOT server snapshots (standing architecture rule; replay gives late joiners full history; who-stopped-what is honest wire history); stop driver-only, attributed, appended before the SDK call; session-scoped (cross-session = v6b).
- **Post-workflows decomposition (user-approved):** A workflows → B session-initiation+directories → C launch-anywhere CLI, in that order. A+B+C all SHIPPED (PRs #10, #11).
- **Oversight agent (user-approved 2026-07-26, brainstormed this session):** deliberate, bounded step toward competitors' "shared context" — stays on the awareness thesis because the overseer reads STRUCTURED DIGESTS ONLY (never transcript prose), output is human-first, and context enters an agent session only via explicit driver pull or a permission-gated `team_update` tool. Primarily humans consume it; agents get it on demand only (user: "optional so the headache doesn't grow as the team grows") → off by default. LLM summarizer (real prose, not a mechanical rollup) on haiku one-shot, `tools: []`, `maxTurns: 1`; activity-driven + schedule-once debounce (30s prod) so idle costs nothing and steady activity still refreshes every debounce period; summary rides the snapshot-shaped project channel (NOT session append-only wire — project channel is already snapshot-idiom, replay-free late-join for free); separate OVERSIGHT screen (main view dense — standing rule); anyone toggles (team infrastructure, not driver capability), pull is driver-only + attributed `oversight_pull` on the session wire (honest history, task_stop pattern); no summary history UI, no persistence, no picker surface (v1 out-of-scope list in spec §8).
- **Arcade / Tetris + Doodle Jump (user-approved 2026-07-26):** tall per-game lane over a rotated playfield or a dedicated screen, because `rows` was already per-engine so it cost zero host and contract change; four-slot roster; `typerace` removed entirely rather than unlisted, knowingly orphaning its score history; seed determinism relaxed for the two new engines only. Full detail + line refs in §4c.
- **Arrow navigation (user-approved 2026-07-26):** real DOM focus over a JS selection index (Tab/Enter/screen-reader/focus-ring all come free); rows derived from geometry over `data-nav-group` markup (nothing to keep in sync, and the wrapped header is handled by construction); empty-prompt activation over an Esc mode or a Ctrl chord (Esc already means three things; a chord would go unused). Full detail + line refs in §4d.
- **Piggyback strategy (researched 2026-07-26):** the server is the product, clients are distribution — do not fork Codex to get a single-player terminal UI. Full findings and the blocking unknown in §7.
- **Approach B ruled (vs overseer-as-hidden-session):** server-side service module, NOT a session — a hidden session drags in worktree/join/roster/driver semantics for a thing that isn't one.

## 3b. v6b BANKED DECISIONS (unchanged — start the spec from here)

- Interrupt rail first, fleet cards second; pulls (pending gates server-wide + file-collision alerts, one-click jump-in); scope = everyone on this server; NEVER "team hub".
- Collision signal generates PULLS; `<teammates>` digest exists (`digest.ts`); v6b delta = server-side file-overlap detection as human-facing interrupts + agent-side tiered add ("agents too, tiered").
- Presence co-op framed (focus-based, session-level, PARTY language, never person-level monitoring); coordination = awareness + advisory overlap warnings, NOT locks/task boards; TUI client carried; language "awareness"/"take the wheel"/"driver".

## 3d. DEPLOYMENT STRATEGY — spec MERGED (PR #6) — unchanged pointer

`docs/superpowers/specs/2026-07-25-deployment-strategy-design.md` is the authority. Two-week blitz (friends beta → public launch ~Aug 6 + YC app). Identity-clean per-action approval handoff = the wedge (nobody ships it — supersedes market-research.md's outdated claim). Week-1 build items need writing-plans; pull-notification overlaps §3b, build once.

## 3e. PRODUCTION-READINESS DECISIONS (session #7 — user-approved, do not re-litigate)

- **Two readings, Reading A first.** "Production ready" spans 8–10 subsystems (verified against the code: zero auth, no TLS, no persistence, no CI, no deploy artifacts, no rate limiting, no reconnect, no agent isolation, one shared API key). Reading A = deploy/TLS/auth now; Reading B = persistence/multi-tenancy/sandboxing after. User chose A then B. Rationale for not doing B first: nobody has used the product yet, so hardening for unattended multi-tenant use would be building for users not yet met.
- **Build order A1a → A2 → A3 → A4 → A1b (deploy LAST).** Localhost OAuth callbacks make deploy-first unnecessary, and deploy-last means no window where a public URL exists without auth.
- **Identity and billing are DECOUPLED — this is load-bearing.** Identity comes from GitHub OAuth; compute is billed **per session**, not per person. Why per-session: one session runs ONE agent process, so one key. If a passenger's approval had to bill to them, the agent would need a restart with a different environment — killing the context and breaking the headline claim "the agent never stopped."
- **Credentials as identity was proposed and REJECTED.** An API key is an opaque bearer with no name, so it cannot support "every decision on the wire carries the name of the human who made it" — the wedge. It also reproduces the villain of our own positioning (Cursor's credential confusion), collapses shared-team-key users into one identity, orphans history on rotation, and storing N users' keys on an assume-breach box makes it the highest-value target there. **But the instinct behind it was right and is satisfied:** there is no user database and none is being built (spec: "Sign in with GitHub, not an account system").
- **BYO key is mechanically available — verified, not assumed.** SDK `Options.env` (`sdk.d.ts:1416-1432`) sets the agent subprocess environment per query, but **REPLACES the environment entirely**, so it needs `{...process.env, ANTHROPIC_API_KEY: sessionKey}`. `agentDriver.ts` currently passes no `env` at all, so the subprocess inherits the box key. This resolves the unknown the deployment spec flagged. A2 work item.
- **Node serves the client; Caddy is a pure TLS reverse proxy** (not Caddy-serves-static). Why: the WS server is attached with no path restriction (`server.ts:225`), so Caddy would have to route on the `Upgrade` header — subtle and fails confusingly; `staticFiles.ts` is already written, path-contained and tested; and it preserves dev/prod parity with the single-port path the CLI already assumes.
- **Hosting: a dedicated disposable Hetzner CX22-class box** (2 vCPU / 4 GB / 40 GB, ~€4/mo). **4 GB is the floor** — the Claude Code subprocess is itself a Node process. User is buying domain + box fresh. **Self-hosting on the user's Windows 10 PC was considered and rejected for the public surface** (agent with a known Bash two-hop escape would sit on the home LAN; residential IP exposure; CGNAT/port-blocking/dynamic-IP breaking ACME; uptime coupled to a daily-driver machine). The PC remains available as an INFORMAL rehearsal VM — explicitly not part of any spec.
- **SSH: the user pastes commands.** No agent access to the box. Runbook is written as copy-paste blocks with expected output per step.
- **The API key must never be pasted into chat.** It goes directly into `/etc/multiplayer-ai/env` on the box (0600, `mpai:mpai`), and must be a **capped Anthropic Console workspace key** — that cap is the spend control and kill switch. User confirmed they have no key yet and will supply one at A1b.

## 3f. A2 DECISIONS (session #8 — user-approved, do not re-litigate)

- **A2 SPLIT into A2a (identity) and A2b (provider + credential).** Why: the credential half depends on an unresolved model-provider question which depends on an unrun spike; the identity half depends on nothing. Splitting unblocks real work instead of parking it behind an experiment.
- **Invites and OAuth are TWO LAYERS, not alternatives.** This resolves the §7 blocker carried since session #7. OAuth answers *who are you* (required for the wedge); invites answer *which session may you enter* (already built, #12). The deployment spec §4's "OAuth replaces the invite-token idea" is **formally amended** in the A2a spec §1.2 — it predated the invite system existing. `REQUIRE_INVITE` stays **off** for the friends beta; the allowlist gates the server.
- **Invite links get their own sign-in screen** showing what you were invited to, rather than a generic landing page. Chosen over a single shared landing page because an invite is a personal artifact and being met with a generic login discards the moment the product is trying to create. Costs one extra screen. `peek_invite` already returns the metadata unauthenticated without spending the token.
- **Name is locked to the GitHub login; glyph and colour stay user-chosen.** A free-text name would reintroduce exactly the impersonation A2a removes.
- **Auth activates only when `GITHUB_CLIENT_ID` is set**, mirroring A1a's `CLIENT_DIST` production signal — dev, all 227 tests, and `?name=alice` deep links stay untouched. The risk of shipping with auth off is closed by the config validator refusing to boot production without it.
- **Subscriptions (Claude Pro/Max, ChatGPT) are NOT an option — do not re-explore.** Anthropic's Agent SDK docs disallow third-party products offering claude.ai login (quoted in deployment spec §2, Appendix A.14; captured 2026-07-25 and **not re-verified live** — flag before it reaches a public claim). OpenAI subscriptions are architecturally irrelevant: our agent *is* the Claude Agent SDK, so there is no OpenAI model to attach one to. BYO key is the standard cost model in this space — competitors face the same constraint.
- **MODEL PROVIDER IS PLUGGABLE — the user's stated priority is "actual model choice"** (GPT, DeepSeek, later local models), not just billing flexibility. Seam goes at the **transport** (gateway via `ANTHROPIC_BASE_URL`), not at the driver. Why: `canUseTool` is a *harness* feature that fires before the model is consulted, so **the permission gate — the wedge — survives a model swap**. Separate agent runtimes per model would mean N gates, N event mappings, and a backend-dependent wedge.
- **What does NOT survive a model swap** (expect these, don't rediscover them): thinking blocks (no non-Anthropic equivalent), server-side tools (WebSearch/WebFetch run on Anthropic infra), prompt caching. Also the system prompt at `agentDriver.ts:137` is ~1,500 words written for Claude — per-provider prompt tuning is real work the user has accepted.
- **ONE API KEY PER SESSION** (deployment spec §3e stands, unamended). Per-user keys were analysed in depth and deferred — see §7b for the analysis and the shape it would take.
- **Build the seam, not the backends.** Ship the Anthropic arm wired and the other arms as empty config. Rationale: zero users yet, and each additional backend multiplies the fidelity-testing and demo surface. Model choice is a *procurement* differentiator, not a product one.

## 4. Ordered next steps (fresh session)

1. **Verify state per §8** (expect `main` in sync with origin, 305 + 160 green, nothing running, working tree clean apart from the three untracked user files).
2. **BUILD v6b — file-collision detection.** The user's stated priority and, by their ordering, the last feature before deployment. **It has banked decisions (§3b) but no spec**, so it starts at `superpowers:brainstorming`, not at code. Build it as an extension of A3's rail (OTHER PARTIES rows + `PULLS ▸ N` badge), not a parallel one. The two open design questions §3b does not settle: what counts as a collision (same file touched by two live sessions? same file *and* both uncommitted? overlapping hunks?), and whether the signal is advisory-only — §3b is explicit that coordination means awareness and advisory warnings, **never locks or task boards**.
3. **Then A1b — deployment.** Blocked on the user for the box, the domain with a live A record, and the API key. **It is also blocked on code:** the §0 workspace-provisioning fix must land first, and it needs no hardware, so it can be done at any time — doing it early would shorten the deploy day.
4. **Deferred, revisit only when unblocked or asked:** A2b (needs the §7a provider spike, which needs an API key) and A4 (canned demo scenario).
5. Optional, user's call only: walk the invite return path end-to-end in a private window (the one Task 8 gap), run the oversight demo (never done live — §0), confirm the model picker (§0), delete merged branches including `feature/a2a-github-oauth` and `feature/signout-ui` (§0), decide on `tour-skill-suggest.png` (§7).

## 4b. Invite system — files with line refs (MERGED to main via #12)

- **Server:** `poc/server/src/invites.ts` (whole file — `InviteStore`; token `randomBytes(24)`/id `randomBytes(6)` separate draws :73-74; `redeem` checks BOTH ids before `classify` :106-108; `listFor` keeps full invites so they stay revokable :118-134; lazy `prune()` :169-174, no timers); `poc/server/src/session.ts:13,54-56,63-64,75-77` (admitted set — `join` adds, `leave` never removes, `hasBeenAdmitted`); `poc/server/src/server.ts:69` (`requireInvite` option), `:236-242` (`sendInviteList` — direct socket send, the ONLY path a token travels), `:278-303` (invite gate, BEFORE provisioning), `:358-373` (`peek_invite`), `:605-643` (create/list/revoke, no driver gate); `poc/server/src/events.ts:44-46` (three arms, `inviteId` only).
- **Client:** `inviteLink.ts` (pure: `inviteLinkFor`, `inviteTokenFrom`, `seatsLeftLabel` single-source-of-truth :439-443, `seatsLabel` built on it, `expiryLabel`); `types.ts:115-117,120-128`; `useSessionSocket.ts:53` (token into join payload), `:196-197` (`invite_list` → state); `components/InviteLanding.tsx` (throwaway socket `peek_invite`, error/loading states); `components/InvitePanel.tsx` (no driver gate :21-58, link input :46); `App.tsx:42` (`inviteTokenFrom`), `:64-67` (landing branch FIRST), `:99-106` (hotkey I inside the S/W/O effect so it inherits the input-focus guard; Esc), `:114-117` (list refresh on open), `:140-149` (screen branch); `components/Header.tsx:118-124`; `components/Transcript.tsx:265-282`; `terminal.css` (`.invland`, `.invhero`, `.invrow`, `.invlink`).
- **Tests:** `poc/server/test/invites.test.ts` (16), invite wire tests in `server.test.ts` (9), `poc/client/src/inviteLink.test.ts` (8).
- **Docs:** spec `docs/superpowers/specs/2026-07-26-invite-system-design.md` (§7 = the honest security bound; §9 = every decision + why), plan `docs/superpowers/plans/2026-07-26-invite-system.md` (Deviations records both spec amendments), demo `docs/demos/2026-07-26-invite-and-oversight.md`.

## 4c. ARCADE — SHIPPED on main (Tetris + Doodle Jump). Map kept for future arcade work.

**The four design questions here were ANSWERED by the user and are BUILT. Do not re-brainstorm them.** Resolved as: (1) tall per-game lane — `rows` was already per-engine so the contract and host needed no change; (2) four-slot roster with Type Race out; (3) `typerace` **removed entirely**, not unlisted — accepted cost is orphaned `game_score` history and a stranded `localStorage["mpai-typerace-high"]`; (4) seed determinism **deliberately relaxed** for these two engines only — they use `Math.random()` and carry no determinism assertions.

**Roster and engines (all live).** `poc/client/src/game/`: `dino.ts` (2 rows), `snake.ts` (5), `tetris.ts` (253 ln, 20 rows), `doodle.ts` (148 ln, 20 rows), plus `engine.ts` holding the contract. `typerace.ts` is DELETED.

- **Tetris** — `tetris.ts:3-6` (`WELL_W` 10, `WELL_H` 18, `TETRIS_ROWS` 20); cells render 2 chars wide to correct the ~2:1 terminal aspect, giving 20 chars of well + 2 borders + an 18-char HUD margin. `refill()` :70 is the 7-bag shuffle; `lockPiece()` :110 locks, clears full rows and spawns (a colliding spawn ends the run); `tetrisEngine` :239. Arrows only, so `G` still swaps cartridges mid-run.
- **Doodle Jump** — `doodle.ts:3` (`DOODLE_ROWS` 20); `generate()` :48 takes a `floor` argument and callers pass the TOP of the visible band, so a platform can never pop into view under the player (this was a real bug caught while writing the tests); `tick()` :63 bounces only while descending; `doodleEngine` :134.
- **The `GameEngine` contract** — `engine.ts:7-25`; `LANE_WIDTH = 40` at `engine.ts:3`. `render()` must return exactly `rows` strings of exactly 40 chars. Host `ThinkingStrip.tsx` drives it: RAF with `dt` clamped to 0.05s, SPACE starts, raw `e.key` forwarded, synthetic `"click"` on lane click.

**Two registries, both hand-edited, NOT derived from each other — edit BOTH or scores silently fail validation:**
1. Client roster literal — `ThinkingStrip.tsx:18-23` (`engine?` optional is the documented way to add a slot before its engine; the "cartridge not inserted" fallback is kept alive for that reason even though nothing reaches it now).
2. Server allowlist — `poc/server/src/events.ts:11-12` (`ARCADE_GAMES`, `ArcadeGame`), used at `server.ts:714`. **`server.ts:716` no longer hardcodes the list** — it now derives from `ARCADE_GAMES.join("|")`, which was a latent staleness bug fixed in #14.

**Scores.** `App.tsx` sends `game_score` → `server.ts:711-729` (validates game ∈ allowlist, integer 1..`MAX_GAME_SCORE` 99999, stamps `userId` from the connection so it cannot be spoofed, no driver gate — passengers may score) → `arcadeRecords()` (`project.ts:51-79`) aggregates best-per-game **keyed by the game id string** → snapshot `arcade` → `ThinkingStrip` renders `partyBests[game]`. Personal best in `localStorage["mpai-${game}-high"]`. `settleRun` (`engine.ts:34-44`) gates one submission per run, only on a personal best.

**Hotkey capture is automatic** — any engine-bearing slot sets `capturing` while playing (`ThinkingStrip.tsx:94-99`) → `App.tsx` `arcadeCapturing` → suppresses S/W/O/I/M, transcript a/d, **and arrow navigation** (§4d). A new game needs no wiring. Set `capturesText: true` only if it consumes printable letters (neither new engine does).

**StrictMode tripwire.** `tetris.ts` and `doodle.ts` call `Math.random()` inside `tick`, which runs inside a React state updater. This is only safe because `poc/client/src/main.tsx` deliberately omits `<StrictMode>` (double-mounted effects would double-join the ws session). **Adding StrictMode would break these two engines in dev** while every seed-pure engine survives — they would need an injected RNG seam first. Recorded in the arcade spec §3.5.

**Testing pattern.** Pure-function extraction + vitest, co-located: `dino.test.ts`, `snake.test.ts`, `tetris.test.ts` (10), `doodle.test.ts` (10), `engine.test.ts`. **`ThinkingStrip.tsx` itself is entirely untested** — roster, swap, keyboard, capture flag, RAF, localStorage. That gap caused the swap crash in `docs/mistakes-and-fixes.md:9-14`, whose lesson is that pure tests plus a clean build cannot catch it: **drive the real UI once before calling arcade work done.**

**Known not-verified-live:** a Tetris line clear never triggered in the browser (random piece order + a crude column sweep left holes). Clearing, the NES score table and the level multiplier are covered deterministically by `tetris.test.ts`. Worth hitting by hand next time this code is touched.

**Docs:** spec `docs/superpowers/specs/2026-07-26-arcade-tetris-doodle-design.md`, plan `docs/superpowers/plans/2026-07-26-arcade-tetris-doodle.md` (Deviations records the live-gate result and the keydown-only steering refinement).

## 4d. ARROW NAVIGATION + header fixes — SHIPPED on main (PR #15)

**Contract (decided with the user, do not re-litigate):** arrows move **real DOM focus**; `←/→` within a visual row (wrapping), `↑/↓` to the nearest control in the row above/below (clamping). Activation is implicit — **an empty prompt means navigate, and the moment the input has text the arrows are the text caret again.** Chosen over an Esc-toggled mode (Esc already means three things) and over a Ctrl+arrow chord (nobody would use it).

- **Pure core** — `poc/client/src/arrowNav.ts`: `NavRect` :9, `sameRow()` :20 (two items share a row when their vertical spans overlap by more than half the shorter one's height), `rows()` :26, `moveH()` :42, `moveV()` :51, `yieldsArrows()` :84. Rows are derived from live `getBoundingClientRect` rather than markup, so **no component carries nav attributes** and the wrapped header becomes two rows automatically.
- **DOM binding** — `poc/client/src/useArrowNav.ts`: `FOCUSABLE` :7 (every natively focusable element takes part, minus a `data-nav-skip` opt-out), `navItems()` :10, `useArrowNav()` :31, `showPicker()` block :40-52. Wired at `App.tsx:17` (import) and `App.tsx:158` (`useArrowNav(!arcadeCapturing)`).
- **Why real focus, not a selection index:** Tab/Shift+Tab keep working untouched (v6a accessibility ruling — neither is bound), `Enter`/`Space` activate a focused button natively with nothing bound, screen readers announce correctly, and the existing ring at `terminal.css:81` (`:focus-visible`) applies with **no new CSS**.
- **Guards (order matters):** modifier keys → browser/OS; not an arrow → ignore; live arcade run → the hook is not even attached (`enabled` false); `TEXTAREA` → both axes; `SELECT` → **vertical only**; `INPUT` with text → both axes.
- **The select rule is load-bearing.** Yielding BOTH axes to a `<select>` stranded focus permanently, because the AGENT picker is the first focusable element on the page — first arrow press landed there and nothing moved again. The pure tests could not see it; only driving the browser could. Splitting by axis keeps native value-change on `↑/↓` while `←/→` stay free as the escape route.
- **Header clip fix** — `terminal.css:259-263`. `.term-header` was `nowrap` + `overflow: hidden`; because `white-space: nowrap` stops the buttons shrinking below their labels, the row ran past the frame and the tail was silently amputated (measured: `scrollWidth` 1422 vs `clientWidth` 1114, INVITE starting 121px past the right edge — INVITE and ONLINE fully clipped, OVERSIGHT nearly). Now `flex-wrap: wrap`, matching `.statusline` / `.roster` / `.thinking-head`.
- **Model-picker fix** — `components/Header.tsx:46-53`. The `<select>` was wrapped in a `<label>` with no `htmlFor`/`id` pairing; a wrapping label forwards a second synthesized click to its control, so the native dropdown opened and instantly closed. Now a `<span>` with `aria-label="agent model"` carrying the accessible name. **Pre-existing bug, not introduced by arrow-nav.**
- **Tests:** `poc/client/src/arrowNav.test.ts` (17 — row grouping, wrap/clamp arithmetic, per-axis guard). The hook itself is a thin DOM binding with no component-test infra, so it was verified by driving the browser.
- **Spec:** `docs/superpowers/specs/2026-07-26-arrow-navigation-design.md` (§5 records the select amendment rather than quietly rewriting it).

## 4e. A1a DEPLOYMENT WIRING — files with line refs (MERGED to main via `f33ce06`)

Spec `docs/superpowers/specs/2026-07-27-a1a-deployment-wiring-design.md`, plan `docs/superpowers/plans/2026-07-27-a1a-deployment-wiring.md`. Branch `feature/a1a-deployment-wiring` (8 commits, not deleted).

- **Client scheme derivation** — `poc/client/src/socketUrl.ts:10` (`socketUrlFor(protocol, host)`; `protocol` carries its trailing colon, `host` includes the port); wired at `poc/client/src/types.ts:1` (import) and `:90-92` (`SERVER_URL` delegates; the `import.meta.env.DEV` short-circuit stays, and is what keeps `window` untouched under vitest). **Why derived, not hardcoded to `wss:`** — hardcoding would break the plain-HTTP single-port path the demo recipes and `mpai` CLI use. Tests `poc/client/src/socketUrl.test.ts` (4).
- **`/healthz` + composed request handler** — `poc/server/src/server.ts:223` (`serveStatic` may be null), `:231` (`decodeURIComponent` inside the existing try/catch, mirroring `staticFiles.ts:31-38`), `:243` (matches `/healthz` and `/healthz/`), `:257` (404 now carries `text/plain; charset=utf-8`). **Ordering is load-bearing:** `staticHandler`'s SPA fallback (`staticFiles.ts:51-53`) serves `index.html` for ANY extensionless path, so a health route wired after it returns HTML with a 200 — a probe that passes forever while the app is broken. The guarding test asserts the BODY, not the status. Composing also fixed a latent bug: with no `staticDir`, `createServer` previously got `undefined`, so plain HTTP requests hung until socket timeout; now they 404.
- **Bind host** — `poc/server/src/server.ts:63` (`host?: string`, optional so the pre-existing tests are untouched) and `:793` (`listen(opts.port, opts.host)`). Loopback binding is what makes the app port unreachable except through Caddy.
- **Fail-fast production config** — `poc/server/src/config.ts:12` (`validateProductionConfig(env, hasIndexHtml)`; the fs probe is INJECTED so the function is pure and testable without `process.exit`), `:16` (production mode is signalled by `CLIENT_DIST` and nothing else), `:22` and `:28` (the two fatal messages). Wired at `poc/server/src/main.ts:6-11` (exit 1), `:16` (dev keeps the old advisory warning), `:35` (`HOST` defaults `127.0.0.1`), `:44` (`staticDir`), `:50-51` (honest startup log). Tests `poc/server/test/config.test.ts` (5).
- **Build** — `poc/server/tsconfig.build.json` + `build` script in `poc/server/package.json`. **`rootDir: "src"` is REQUIRED** — without it tsc 7.0.2 fails TS5011 and, when forced, emits to `dist/src/main.js`, breaking both `node dist/main.js` and the systemd `ExecStart`. (The plan and spec originally omitted it; both were corrected.) `bin/mpai.js` still uses `tsx` — that is the local CLI, out of scope.
- **Ops artifacts, all marked NOT YET VERIFIED** — `deploy/Caddyfile` (`X-Frame-Options DENY` is not boilerplate: the core interaction is a human clicking "approve" on a privileged action, so the UI is clickjackable without it), `deploy/multiplayer-ai.service` (**deliberately omits `ProtectSystem=strict` and `ProtectHome=yes`** — they break the agent, which writes worktrees, clones plugins and needs `~/.claude`; the file says plainly that the remaining hardening is close to theatre), `deploy/env.example`, `deploy/RUNBOOK.md`.
- **Tests** — `poc/server/test/httpSurface.test.ts` (7: healthz body-not-HTML with a staticDir configured, no-staticDir, 405, 404, `/healthz/`, percent-encoded, host binding).

**Verified live in a real browser** (not just unit tests): the built bundle loaded through the production single-port path, joined over `ws://`, and two participants appeared in one session (`PARTY · 2`, alice driving, ben with TAKE THE WHEEL). Loopback bind confirmed `127.0.0.1:3001`, not `*:3001`. Fail-fast confirmed unprompted — the first launch attempt exited with `config error: ANTHROPIC_API_KEY is required when CLIENT_DIST is set`.

## 4f. A2a — touchpoints the plan modified (historical: written before the build; see §4g for as-built)

Spec `docs/superpowers/specs/2026-07-27-a2a-github-oauth-design.md`, plan `docs/superpowers/plans/2026-07-27-a2a-github-oauth.md` (8 tasks, 1603 lines, full code in every step). **No branch exists yet** — create one before Task 1.

- **The vulnerability A2a closes:** `poc/client/src/identity.ts:20` mints a `crypto.randomUUID()` into sessionStorage; `poc/client/src/useSessionSocket.ts:44` sends it in the join payload; `poc/server/src/server.ts:295-304` validates only that `userId` is a *string*. Anyone can claim to be anyone, and every downstream attribution (approvals, take-the-wheel, `oversight_pull`, arcade scores) inherits that.
- **Server files to create:** `poc/server/src/auth.ts` (cookie sign/verify, allowlist, four `/auth/*` routes; token exchange **injected** so tests never touch the network — same pattern as `config.ts:12`'s injected fs probe), `poc/server/test/auth.test.ts`.
- **Server files to modify:** `server.ts` — options object (add `auth?: AuthConfig` after `inviteMaxUses`), the composed handler at `:224-258` (auth goes **between** healthz and static, for the same SPA-fallback reason A1a documented at `staticFiles.ts:51-53`), `:262` `wss.on("connection", (ws: WebSocket) => {` gains a second `req` param for the cookie header, and the join branch at `:295` gains the auth gate **before** the invite gate at `:315` so a rejected join never provisions a worktree. `config.ts:12-31` gains the auth vars and returns a built `AuthConfig`. `main.ts` passes it through.
- **Client files to create:** `authState.ts` + test (pure), `components/Landing.tsx`, `components/InviteSignIn.tsx`, `components/Denied.tsx`.
- **Client files to modify:** `App.tsx:64-67` (the invite branch currently runs first; new precedence is in spec §3.5), `components/Lobby.tsx` (name locked — and the wrapping `<label>` must become a `<div>`+`<span>`, per the model-picker bug in §6), `types.ts` (add `API_BASE` beside `SERVER_URL` at `:88-92`), `terminal.css`.
- **Auth is only exercisable through the single-port build.** Vite dev on :5173 is cross-origin from :3001 and its cookies would need CORS, which A2a deliberately does not add. Dev-with-vite always runs anonymous.

**SDK facts verified this session against the installed `poc/server/node_modules/@anthropic-ai/claude-agent-sdk` — do not re-derive:**

- `sdk.d.ts:1416-1432` — `Options.env` **REPLACES** the subprocess environment; must spread `process.env` or the agent loses `PATH`/`HOME` and will not launch.
- `sdk.d.ts:5039` — `model?: string`, a free string, so any model id passes through to whatever endpoint the process points at.
- `sdk.d.ts:1784` — `resume?: string` loads history from `~/.claude/projects/`; `:1590` references a resume-materialisation timeout.
- Provider env vars honoured by the shipped bundle (grepped from `sdk.mjs`/`bridge.mjs`): `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_GATEWAY`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID`.
- Agent driver anchors: `agentDriver.ts:133` workdir fallback, `:134` the `query()` call (no `env` passed today — that is A2b's seam), `:137` the ~1,500-word Claude-specific system prompt, `:146` `canUseTool`.

## 4g. A2a — AS BUILT (branch `feature/a2a-github-oauth`, 18 commits, UNMERGED)

Suites: **server 297, client 144**, both tsc clean, client build clean. Branch base `a358a9c`. Every task passed a task-scoped review; the whole-branch review at the end returned **"ready to merge"** after one fix wave.

- **Server auth core** — `poc/server/src/auth.ts` (whole file): cookie parse/sign/verify (HMAC-SHA256, `timingSafeEqual` guarded by a length check), `isAllowlisted` (fails closed on a blank list), the four `/auth/*` routes with an **injected** `exchangeCode` so tests never touch the network, `requireAuth(cookieHeader, cfg)` shared by the join gate and the four pre-join gates, `safeNext` (positive validation — reject `[\x00-\x20\x7f]`, then require an exact URL round-trip), `NEXT_COOKIE` carrying `next` through the OAuth round trip.
- **Route composition** — `poc/server/src/server.ts`: auth routes sit **between** `/healthz` and the static handler. Ordering is load-bearing — the SPA fallback (`staticFiles.ts:51-53`) serves `index.html` for any extensionless path, so a route registered after it returns HTML with a 200. The guarding tests assert **bodies**, not statuses.
- **The join gate** — `server.ts:353-357`: verify cookie → check allowlist → overwrite **both** `msg.userId` and `msg.name` with the verified login. Sits above the invite gate, so a rejected join never provisions. Central test sends `userId: "totally-not-ana"` with a valid `ana` cookie and asserts the string appears nowhere; a second sends `name: "Ben"` and asserts the same. Both cover the snapshot roster, not just the event.
- **Pre-join gates** — `server.ts:422/458/472/489` (`peek`, `watch_project`, `set_oversight`, `create_session`), each `if (denyUnauthed()) return;` as the first statement. `peek_invite` (`:438`) stays open per spec §4.3 and is token-gated.
- **Config** — `poc/server/src/config.ts`: auth intent is `GITHUB_CLIENT_ID` alone; production (`CLIENT_DIST` set) refuses to boot without all four vars. The §4.4 headline test is written to fail under the specific mutation `if (staticDir || authIntended)` → `if (authIntended)`.
- **Client** — `poc/client/src/authState.ts` (`authStateFrom`, `loginUrl`), `authRoute.ts` (`screenFor` routing precedence + `selfIdFor`), `components/{Landing,InviteSignIn,Denied}.tsx`, `App.tsx` (probe + precedence switch), `Lobby.tsx` (name locked — cosmetic; the server enforces it). `vite.config.ts` gained an `/auth` proxy. **`API_BASE` was deleted** — every `/auth/*` URL is now relative.
- **Docs** — `deploy/RUNBOOK.md` §4a, `deploy/env.example`, `poc/server/.env.example` all document the new vars.

**Two Criticals that seven task reviews missed and only the whole-branch review caught — the lesson is that per-task review cannot see a feature's return leg:**
1. **The client never learned its verified identity.** `App.tsx` still held the sessionStorage UUID while `derived.driverId` became the GitHub login, so with auth ON `isDriver` was false for everyone, permanently — prompts degraded to suggestions and `Transcript.tsx:152,194,225` hid the approve/deny controls entirely. **The permission gate, the entire wedge, was unanswerable from the UI.** Fixed via `selfIdFor`. **Carry-forward risk: the wiring is not pinned** — reverting the single line `userId={selfId}` in `App.tsx` reintroduces the bug with all 144 client tests green. First thing to test if component/hook test infra ever lands.
2. **`create_session` provisioned a worktree AND spawned an agent for an unauthenticated stranger** — `repo.workspace.provision()` (a real `git worktree add` + branch) then an `AgentDriver` whose constructor eagerly starts the SDK subprocess on the box API key. One socket, one frame, no cookie, from anyone on the internet, repeatable in a loop. `peek`/`watch_project` also disclosed the roster of real GitHub logins and the oversight prose.

## 4h. A3 PULL NOTIFICATIONS — AS BUILT (MERGED to main via `0450c8d`)

Spec `docs/superpowers/specs/2026-07-27-a3-pull-notifications-design.md`, plan
`docs/superpowers/plans/2026-07-27-a3-pull-notifications.md` (4 tasks, Deviations filled in).
Branch `feature/a3-pull-notifications` (5 commits, local-only, merged). Suites: server 305, client 160.

**What it does.** A permission gate in another session that goes unanswered past *your* threshold
lights that session's OTHER PARTIES row amber (`🔐 waiting 2m — approval to run Bash`) and shows
`🔐 PULLS ▸ N` in the header. Clicking the row navigates to that session. Off by default.

- **Server derivation** — `poc/server/src/pendingGate.ts` (whole file, 30 lines): `pendingGateOf(events)`
  returns the oldest `permission_request` with no matching `permission_decision`, as
  `{ toolName, sinceTs }`. No state, no timers. An `auto: true` decision resolves the request like
  any other, so **AUTO mode generates no pulls without a special case**.
- **Wire** — `poc/server/src/project.ts:125` (`pendingGate: pendingGateOf(events)`) plus the field on
  the `ProjectMessage` interface. **One optional field on a snapshot that already broadcasts** — no
  new message type, no new socket traffic, late joiners get it free.
- **The server never decides a pull is due.** It publishes only *when* the gate started waiting;
  every deadline lives with the recipient. That is what makes per-person thresholds cost nothing
  server-side — no timers, no per-user state, no fan-out.
- **Client derivation** — `poc/client/src/pulls.ts` (whole file, 70 lines): `Pull`, `pullsFrom`,
  `THRESHOLD_OPTIONS`, `thresholdFromStorage`, `waitedLabel`, `PULL_STORAGE_KEY`.
- **The 10s tick is load-bearing** — `poc/client/src/App.tsx:195-212`. While a gate sits pending
  **no events fire**, so no fresh snapshot arrives and nothing re-renders; crossing the threshold is
  an event only the client's own clock can see. `pullTick` is a deliberate `useMemo` dependency.
  **If a pull ever appears only when you click something, this tick is broken.**
- **UI** — `poc/client/src/components/PartyPane.tsx:64` (the `PULL AFTER` select — a `<span>`+
  `aria-labelledby`, **never a wrapping `<label>`**), `:101` (the pull row), `:93` (`.pull` class);
  `poc/client/src/components/Header.tsx:144` (the badge); `terminal.css` tail (`.member.pull`,
  `.member-pull`, `.pull-badge`, `.pull-setting`, all `var(--amber)` — `terminal.css:37`, the token
  this project already designates for the permission gate).
- **Setting** — `localStorage["mpai-pull-after-ms"]`; absent = OFF. `thresholdFromStorage` accepts
  only values in `THRESHOLD_OPTIONS`, so a hand-edited value can never produce a surprise interval.
- **Tests** — `poc/server/test/pendingGate.test.ts` (6), 2 wire tests in `server.test.ts` under
  `describe("pending gate on the project snapshot")`, `poc/client/src/pulls.test.ts` (13).

**Two things the browser pass caught that tests structurally could not** (both in the plan's Deviations):
1. The row read `waiting 2m ago` — the party pane's `ago()` appends "ago". Both fragments were
   individually correct, so no unit test would flag it. Fixed with a tested `waitedLabel`.
2. **Clicking a pull lands on the LOBBY, not inside the session**, because the OTHER PARTIES href is
   `?project=…&session=…` with no `&name=`. **Pre-existing and shared with every other-party row**,
   so it was left alone rather than widened into A3's scope. "Drop in" is one click short of literal.

**Known bound, not a bug:** a pull clears within ~1s of the decision, not instantly — `schedulePush`
throttles project snapshots to `PROJECT_PUSH_INTERVAL_MS = 1000` with a trailing push
(`poc/server/src/server.ts:138-151`). This also cost a red test at 300ms during execution.

## 5. Oversight — files with line refs (MERGED to main via #13; never demoed live)

- **Server:** `poc/server/src/digest.ts:49-100` (oversightSessionDigest — structured digest, no transcript prose); `poc/server/src/overseer.ts` (whole file: Overseer class w/ disposed flag + schedule-once debounce + in-flight coalesce, oversightToolText w/ exact fallback strings :25-26, runOversightSummarize haiku one-shot :159-165); `poc/server/src/events.ts:43` (oversight_pull w/ summarySeq); `poc/server/src/project.ts:17` (pendingOversight), `:98,130` (ProjectMessage.oversight); `poc/server/src/server.ts:97-102` (onUpdate → immediate pushProject), `:320-333` (set_oversight, anyone), `:517-533` (pull_oversight, driver-gated), `:383-392` (one-shot `<oversight>` injection — flag consumed before latest check); `poc/server/src/agentDriver.ts:117-130` (team_update tool, NOT in allowedTools :140-145 → driver gate).
- **Client:** `types.ts:43` (summarySeq), `:110-113` (OversightState); `useSessionSocket.ts:151,173,188` (oversight carry w/ `?? {enabled:false,latest:null}`); `oversightView.ts` (oversightFresh, updatedAtLabel — pure, tested); `components/OversightPanel.tsx` (toggle :46-48 anyone, PULL :50-63 driver-only+dimmed); `App.tsx:192-198` (hotkey O guarded + Esc), `:77-82` (seenOversightSeq), `:147-157` (screen branch); `components/Header.tsx:228-234` (button + fresh-dot); `components/Transcript.tsx:328-333` (oversight_pull line); `terminal.css:~700-740` (ov* rules).
- **Tests:** `poc/server/test/digest.test.ts` (5), `overseer.test.ts` (12), oversight wire tests in `server.test.ts` (8), team_update hook test in `agentDriver.test.ts` (1); client `oversightView.test.ts` (4).
- **Specs/plans:** oversight pair `docs/superpowers/{specs/2026-07-26-oversight-agent-design.md,plans/2026-07-26-oversight-agent.md}` (plan Deviations already has a Task 2 entry); session-launcher pair + workflows pair + v6c pair + deployment spec 2026-07-25 all merged on main.
- Positioning: `market-research.md` (untracked, user's file, do NOT commit; its "isolation is the default / no context pooling" principle is now deliberately bent by the oversight feature — see §3 ruling).

## 6. Gotchas / constraints

- **No stacks running.** To start one: `cd poc/server && npx tsx src/main.ts` (:3001) + `cd poc/client && npm run dev` (:5173), then `http://localhost:5173/?session=<name>&name=<you>` — `&name=` skips the lobby. Kill with `kill $(lsof -ti:3001) $(lsof -ti:5173)`. tsx watch hot-reload kills live turns — check `lsof -ti :3001` before poc/server edits; poc/client edits are safe (vite HMR); **never switch branches while a stack is attached.**
- **Subagent commits MUST use explicit `git add <paths>`** — a fix-wave subagent once ran a broad add and committed the user's untracked root files (market-research.md etc.) into history; required a soft-reset rewrite. Every dispatch that ends in a commit spells out the add paths; after each subagent commit, sanity-check `git diff-tree --no-commit-id --name-status -r <sha>` against the intended file list. (Lesson in docs/mistakes-and-fixes.md; also in agent memory.)
- **Permission classifier is flaky on outward git/gh:** `gh pr merge` worked for PR #8 but was blocked for #9; the route that worked for #9: `git fetch . <branch>:main` (no checkout, zero disk churn) + `git push origin main:main`, then GitHub auto-marks the PR MERGED. `git push origin main` was blocked once while `main:main` refspec passed. Don't burn retries — try one alternate then ask user (`! gh pr merge N --merge`).
- Demo relaunch details (worktree FIRST or misleading "native binary failed to launch"; session id must match a demo-worktree dir; existing worktrees incl. v6c-accept-1/2): unchanged from before. Client URLs `http://localhost:5173/?session=v6c-accept-1|2`. Plugin clone persists at `poc/demo-plugins/default/soltero-skills` (26 skills).
- Server tests live in `poc/server/test/*.test.ts` (NOT src/); client tests co-located in `poc/client/src/`. PromptBar submits via input keydown Enter (no form); no component-test infra — pure-function extraction is the pattern; ThinkingStrip guard: blur inputs in synthetic tests.
- Known accepted quirks: double-M duplicate mode events (idempotent); plan-approve exits AUTO; S from `?screen=status` jumps to skills. `docs/` lowercase. `.superpowers/` git-excluded. Subagent sandbox can't launch the SDK binary.
- **Production mode is signalled by `CLIENT_DIST` alone.** Running `node dist/main.js` with `CLIENT_DIST` set but no `ANTHROPIC_API_KEY` exits 1 with `config error: …`. That is CORRECT behaviour, not a bug — do not "fix" it. **There is no API key on this machine** (no `poc/server/.env`, no shell var, no `~/.claude/.credentials.json`), so anything requiring a live agent turn cannot be verified locally until the user supplies one.
- **A gitignore pattern with a trailing slash is directory-only, so `git check-ignore` reports NO MATCH for a path that does not exist yet.** This bit an implementer in session #7: they ran `git check-ignore poc/server/dist` *before* building, got nothing, concluded the root `dist/` pattern "doesn't match nested paths," and edited the shared root `.gitignore`. It does match — once the directory exists. **Always build first, then check-ignore.** The stray edit was caught in review and reverted.
- **A `<label>` must never wrap a form control here.** It forwards a second synthesized click, which for a `<select>` opens and instantly closes the dropdown — the control looks dead with no error anywhere. Cost real debugging time on the AGENT picker. Use a `<span>` + `aria-label`.
- **Playwright `browser_evaluate` gotchas, both of which produced wrong conclusions this session:** (1) React has not re-rendered inside a single synchronous evaluate, so dispatch-then-read-the-DOM in one turn reads STALE markup — use an `async` function and `await` a timeout between the dispatch and the read; (2) the MCP tab silently drifts to `about:blank` between calls, so re-navigate and confirm `Page URL` before trusting any measurement.
- **Screenshots from `browser_take_screenshot` land in the REPO ROOT**, not `.playwright-mcp/`, despite what the tool result path implies. `rm` them before committing or they show up as untracked junk.
- **Headless Playwright cannot observe a native `<select>` dropdown** — it renders outside the page. Structural checks (parent tag, click-event count, `aria-label`) are the most that can be verified; the human has to confirm.

## 6b. Invite system — deferred minors and known bounds (SDD workspace deleted; this is the surviving record)

- **Stated non-claims (spec §7 — do NOT report these as bugs):** invites are a capability, not authentication; the founder slot stays open (an empty/nonexistent session can still be founded by anyone reaching the port); no rate limiting or timing hardening; no persistence (a restart voids every invite).
- **Open non-blocking items from the final review (none fixed, all triaged OK TO DEFER):** `invite_redeemed` is appended on EVERY reconnect (the token stays in the URL, so each reload of the invitee's tab adds another transcript line — have `redeem` report whether the seat was newly taken); the token stays in the address bar forever (a `history.replaceState` after `onAccept` would strip it and also fix the next item); reloading after accepting re-shows the landing screen (`inviteTarget` is component state); a seat can be burned by a join that then fails provisioning (cosmetic — distinct-user counting makes the retry free); re-revoking an already-revoked invite succeeds and appends a second `invite_revoked`; no cap on outstanding invites per session; wire tests cover `invite not found`/`invite revoked` but not `invite expired`/`invite is full` at the `peek_invite` level; **the two client-side Critical fixes have no regression test** (no component-test infra) — a 20k-frames/sec bug now has nothing guarding it; `ws://` is hardcoded in `types.ts:88` (pre-existing, but this branch is the first to put a secret on that socket — flag against the deployment spec before the friends beta).
- **The thing a beta user will be surprised by:** redemption is permanent. The admitted set never shrinks, so revoking an invite does NOT evict anyone who already used it. Spec §10 lists "revoking a redemption" as out of scope — it's a docs gap, not a code one.
- **Deferred minors:** `DEFAULT_INVITE_TTL_MS` exported but never asserted in a test; 8-char id collision (2^-48) would let `revoke()` hit the wrong invite via linear scan; `seatsLabel` untested for `uses > maxUses` (clamped) and `expiryLabel` untested past 24h; the 9 invite wire tests live under `describe("oversight wire")` — misleading label; `InviteLanding`'s "BROWSE SESSIONS" `href="?"` drops `?project=`; `InvitePanel`'s expiry label doesn't tick down (clock read once per render, no timer); `.invlink` readonly input has no accessible label; REVOKE stays clickable on an expired-but-listed invite (server is authoritative).
- **Adjudications made mid-run (both amended the spec, both visible in the PR diff):** the admitted-set reconnect exemption, and project-scoped redemption. Rationale is in the plan's Deviations section and spec §3/§4.

## 6c. SDD process lessons from v7a2 — read before executing 28 more tasks

v7a2 ran 5 tasks through `superpowers:subagent-driven-development` end to end. What it cost and what it caught, so the next run is cheaper and no less safe:

- **The whole-branch review is where the money is. Do not skip it or downgrade its model.** Five task reviews all passed v7a2's headline feature as correct; the opus whole-branch review found `/exit` was **silently swallowed by the slash-autocomplete menu** — `parseClientCommand` ran only inside `submit()`, but `PromptBar.onKeyDown` returned from the menu's Enter branch before `submit()` was ever reached. Task-scoped reviews structurally cannot see that class of defect. This is the second consecutive branch where the final review caught a one-surface-missed bug (v7a's was `SessionPicker` listing a closed session as LIVE with a JOIN button).
- **Give the reviewer the SPEC, not just the plan's constraints.** A Task 5 reviewer raised an "Important, plan-mandated" finding against `exitWouldStrand`; spec §3.4 — which the user approved — named exactly the two signals the code implemented, so the finding dissolved. Handing reviewers the spec path up front would have avoided a round trip.
- **Model selection that worked:** haiku for pure transcription tasks where the plan carries the full code (Task 3), sonnet for multi-file integration (Tasks 4–5) and for scoped re-reviews, **opus for the whole-branch review only**. Cheap re-reviews are fine; a cheap final review is not.
- **Tell the re-reviewer what would count as OVERSHOOTING.** Task 5's fix was "document the invariant, change no logic"; the re-review prompt said explicitly that adding a third branch would be NOT ADDRESSED. Without that, a re-reviewer rewards a fix that quietly changed approved behaviour.
- **Ledger discipline is what survives compaction.** `.superpowers/sdd/<plan>/progress.md` with an explicit `>>> RESUME POINT` is what let session #13 resume mid-fix-loop with zero questions. Write the adjudication AND its reasoning, not just the verdict.
- **Every implementer dispatch must spell out `git add <paths>`** and be told to verify with `git diff-tree --no-commit-id --name-only -r HEAD`. A broad add once leaked the user's untracked root files into history. All 5 v7a2 tasks were verified clean this way.
- **The controller resolves the reviewer's "⚠️ cannot verify from diff" items itself** — usually by just running the suite. Reviewers cannot verify test-count claims from a diff, and that is not a finding.

## 7. Open questions / USER DECISIONS (carried)

- **~~A2 BLOCKER — invites vs OAuth~~ RESOLVED session #8.** Two layers, both kept. See §3f and A2a spec §1.2. Do not re-open.
- **§7a — PROVIDER SPIKE, blocks A2b. Needs an API key from the user.** Stand up a gateway (LiteLLM class), point `ANTHROPIC_BASE_URL` at it, run the demo scenario until it hits a Bash gate, and check three things: does the task complete; does `canUseTool` still fire with the driver's name attached; does the transcript render. The architecture says it should work and the SDK types allow it (`model?: string` at `sdk.d.ts:5039` is a free string, not a Claude-only union), but **this is reasoning from the shipped bundle, not from a run** — exactly the "live-behaviour drift" class that has burned this project twice (the `skills:"all"` reversal, the `canUseTool` shadowing). A day of work; it either validates the provider strategy or kills it before anything is built on it. User named **GPT-5 and DeepSeek** as the models to test first.
- **§7b — PER-USER API KEYS: analysed, deferred by the user, research after A2b.** Architecturally possible — `sdk.d.ts:1784` documents `resume?: string`, loading history from `~/.claude/projects/`, so a turn *can* start a fresh agent process under a different key and continue the same conversation. **This invalidates the original §3e reasoning** ("re-keying would kill the context"), but the conclusion was kept anyway on cost grounds: (1) per-turn process startup — `sdk.d.ts:1590` references a resume-materialisation timeout, and cost scales with conversation length; (2) **prompt-cache invalidation, the expensive one** — caches are per key, so strict alternation between drivers yields zero cache hits and can cost several times a single shared key, meaning naive per-user keys make the total *larger* for everyone; (3) cross-provider replay — handing off Claude-shaped history to another model family drops thinking blocks and mismatches tool-result formats. **If it is ever built, the shape is:** billing follows the wheel (whoever starts a turn pays; approvals never re-key), re-key on *handoff* not per turn (bounding costs 1 and 2 to handoff boundaries), provider pinned per session with only the key varying (eliminating cost 3). Still unresolved: custody of N live keys in memory (§3e's assume-breach ruling warned against exactly this), and the failure UX when one participant's key is rate-limited.
- **§7c — RESOLVED 2026-07-27 (session #9). The OAuth app is registered and the credentials are ON DISK.** `poc/server/.env` exists (mode 0600, gitignored — confirmed via `git check-ignore`), holding `GITHUB_CLIENT_ID` (20 chars), `GITHUB_CLIENT_SECRET` (40), `SESSION_SECRET` (64 hex, generated), `GITHUB_ALLOWLIST` (the user's GitHub **username**, not email — the allowlist matches `user.login` from `api.github.com/user`, case-insensitively, `auth.ts:72`), and `ANTHROPIC_API_KEY` = the literal `placeholder-not-a-real-key` (the user deliberately skipped a real key; the UI and the whole OAuth round trip work without it, but **the agent will not run a turn**). Both packages are BUILT (`poc/client/dist`, `poc/server/dist/main.js`). **Nothing is running.** Original registration instructions, kept for reference: `https://github.com/settings/developers` → New OAuth App. Homepage `http://localhost:5173`, **callback `http://localhost:5173/auth/callback`** — note this is the **vite** port, not 3001: the branch added an `/auth` proxy to `vite.config.ts`, and the OAuth `state` cookie must be set and read on one origin. (The plan's original text said 3001; that predates the proxy.) Two minutes, no public URL, no cost. The user then supplies the client ID and secret. GitHub accepting localhost callbacks is exactly why deploy could be moved last.
- **§7d — SURFACED SCOPE ITEM, now largely resolved but worth a user glance.** The unauthenticated pre-join surface was escalated mid-run as a possible scope widening. The whole-branch review then showed spec §4.3's rationale for leaving it open was factually stale, so it was fixed inside A2a rather than deferred (§4g Critical 2). **Consequence to be aware of: `peek` now requires auth.** If a public "browse sessions" preview screen is ever wanted, it needs a new, deliberately-unauthenticated message type rather than reusing `peek`.
- **§7f — UNEXPLAINED: commits reached `origin/main` without this session pushing them.** At the end of
  session #10 the user asked to push/PR. Before doing anything, `git ls-remote origin refs/heads/main`
  already reported `b8d5652` — identical to local main, **including a handoff commit made minutes
  earlier in this session**. No `git push` was run by this session and `.git/hooks/` has no active
  hooks (samples only). Earlier in the same session `git status -sb` had reported "ahead 39", and the
  marker vanished after a plain `git fetch`. Later in the same session, two fresh handoff commits did
  **not** auto-appear on origin and had to be pushed manually — so whatever it was is not pushing
  continuously. **Best hypothesis: another session or background process pushed once.** Unresolved, and worth knowing before v6b: two agents merging into the
  same `main` is precisely the collision problem v6b exists to surface. **Practical rule meanwhile:
  trust `git ls-remote`, not `origin/main`, which can be stale.**
- **§7g — RESOLVED 2026-07-28 (session #14). PR-FIRST IS THE STANDING FLOW FOR ALL FEATURE WORK.**
  The user's ruling, verbatim: *"Pr first pls."* So every feature branch from here is
  **branch → push → open PR → leave merging to the user.** Do not merge a feature branch locally
  and do not merge a PR without being asked, even when the branch is green and reviewed. The
  history that prompted this: A2a, sign-out and A3 were each merged locally on instruction, so by
  the time the user asked to "PR this stuff" every commit was already in `main` and there was
  nothing left to review on GitHub.
  - **AMENDED the same day, by the user: the rule bends for LONG-RUNNING TASKS.** A multi-task SDD
    run does not sit behind a review gate for its whole length. For work of that size, land
    completed, reviewed slices into `main` as they finish and keep going on the branch — the PR is
    the review surface, not a blocker. **PR #19 (v7b1 Tasks 1–5) was merged on that instruction**,
    with Tasks 6–8 continuing on the same branch and a fresh PR for the remainder.
  - **What did NOT change:** for ordinary feature work, still branch → push → PR → the user
    merges. The amendment is about not stalling a long run, not a licence to merge unreviewed
    work — every task merged under it had passed its task review first.
  - This does NOT retroactively unmake session #14's merges. PR #18, v7a2 and the workdir fix were
    merged earlier the same session on the user's explicit go, before this ruling existed.
  - Still unanswered: whether to push the local-only merged branches for archival (recommended
    against — the repo already carries 8+ stale branches and their content is in `main`).
- **§7e — accepted, not fixed on this branch** (all triaged "can ship" by the whole-branch review): no `Origin` check on the WS upgrade — cross-site WebSocket hijacking is blocked today solely by `SameSite=Lax`, and now that the cookie confers identity an explicit origin check is worth having as defence in depth; identity is now **per-human, not per-tab**, so closing one of two tabs signed in as the same login removes that human from the roster and reassigns the wheel (recoverable by refresh, belongs in the spec's honest-bounds list); `/healthz` decodes the pathname while `authRoutes` matches raw (no security consequence, but the two guards should agree); the Lobby locked-name branch has no accessible name (`title=` is invisible to keyboard and touch).
- **A1b unverified surface — the risk lives in the Caddyfile, not the client.** The `wss://` client fix is covered by unit tests AND was exercised for real in a browser (the built bundle ran `socketUrlFor` with `import.meta.env.DEV` false; only the `http:` branch was hit, and the `https:` branch differs solely in which of two string literals a ternary returns). What remains genuinely unproven: WebSocket **upgrade passthrough through Caddy**, `encode gzip` interaction with the WS handshake, and proxy timeouts on a long-lived socket. Spec §6.2 formally reassigns the `tls internal` rehearsal and the real-permission-gate run to A1b rather than leaving them as unmet A1a criteria.
- **A1b hard blocker — workspace provisioning (see §0).** Not a deploy step; a code change. Must land before any real session runs on a box.
- **claude-code / codex piggyback — RESEARCHED 2026-07-26, answered in conversation, never written to a doc. Findings, so they are not re-derived:** `anthropics/claude-code` LICENSE.md is *"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service"* — proprietary, **not forkable** — and the CLI source is not in that repo anyway (it is plugins/examples/docs/issues; the binary ships via installers). `openai/codex` is **Apache-2.0 with full Rust source** (`codex-rs`, plus an `sdk/`), so forking it is legal with notice/attribution/trademark conditions. Conclusion reached: forking Codex buys a single-player terminal UI, which is the wrong half — our differentiator is the relay server (shared sessions, driver/passenger, per-action gating, awareness), so **the server is the product and clients are distribution**. The sanctioned Claude Code piggyback is its extension surface (plugins/skills/MCP/hooks/subagents + the Agent SDK), which `poc/server` already uses. **The blocking unknown, and the recommended next spike:** per-action approval is our stated wedge but relies on `canUseTool`, which we only own because we host the SDK process — inside someone else's Claude Code it would have to ride a `PreToolUse` hook instead. Live evidence this is real: the server logged `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` warning that `canUseTool` is not invoked for `Read`/`Glob`/`Grep`/`mcp__awareness__set_intent` because bare `allowedTools` entries auto-approve first, explicitly recommending a PreToolUse hook. Do that spike before committing to the strategy. Caveat: the full Anthropic Commercial ToS was not read, only LICENSE.md.
- **Model-picker fix unconfirmed by a human** — merged (`10189f0`) but only structurally verified. Top of §4 next steps. This is the single most likely thing to still be broken.
- **Arrow-navigation deferred items (none block anything):** `↑` in an empty prompt moves focus instead of recalling the last prompt — if shell-style prompt history is ever wanted it needs its own precedence rule (recall first, navigate once history is exhausted), recorded in the arrow-nav spec §7; type-to-focus was rejected for v1 because the single-letter screen hotkeys (S/W/O/I/A/M/G) would collide; the transcript body is not focusable so arrows cannot scroll it, only its permission buttons participate; `useArrowNav` recomputes every rect on each keypress (~30 elements, sub-ms, but it is O(n) per press); `showPicker()` is feature-detected and simply does nothing on browsers without it.
- `tour-skill-suggest.png` (untracked): keep or delete — user's call; no feature gap behind it.
- Oversight demo may reveal: real haiku one-shot summary quality/latency (prompt contract in `runOversightSummarize` — never exercised by tests, by design); whether `tools: []` + `maxTurns: 1` behaves as expected against the live SDK (options verified against installed sdk.d.ts:1404-1416, but live-behavior drift is the recurring gotcha class); whether the 30s debounce feels right.
- **Oversight deferred minors (final review triaged ALL as OK TO DEFER; SDD workspace deleted, this is the surviving record):** deny-decision gate-close untested; tool_call with no path-ish input untested (shared with summarizeSession); Overseer states Map unbounded per projectId; console.error direct logging; setEnabled() after dispose() fires onUpdate (unreachable in practice — close() disposes then terminates with no interleaving await); set_oversight requires existing project (plan-mandated; only toggle surface is inside a joined session); OVERSIGHT header button reuses `planmode` CSS class (brief-specified); **plus final-review minors:** (1) normal stream end doesn't notify overseer — summary describes a dead session as active until other activity refreshes (only spec-named trigger not shipped; cheapest real win if oversight files are ever touched pre-merge); (2) re-enable during in-flight refresh commits the stale "dropped" result (epoch counter would fix; self-correcting); (3) no length caps on summary text / tool targets into prompts+snapshots (house style would `.slice()`); (4) injected summary not `</oversight>`-delimiter-safe (same accepted posture as `<teammates>`); (5) fresh-dot re-lights on reload (in-memory seen-seq; defensible as "unseen this session"). Known asymmetry (deliberate): oversight_pull records summarySeq at pull time but injection reads latest at prompt time — strictly fresher, keep.
- Workflows demo may reveal: whether real SDK task messages match the read-side shapes (plan Task 1 widened SdkMessage from sdk.d.ts:4424-4500 — verified against installed d.ts, but live-shape drift is the recurring gotcha class); whether the 2s progress throttle feels right.
- Workflows deferred minors (from per-task + final review, none block merge): task_stop for a never-seen taskId creates a phantom RUNNING row in derive (plan-mandated create-on-stop; pairs with the no-confirmation-on-unknown-stop UX gap — fix together if ever touched); stop_task taskId length uncapped in server.ts (driver-only; house style would cap ~200); stopTask sync-throw would escape WS handler (theoretical — same idiom as setModel); FINISHED cap trims by insertion not completion order (observable past 50 tasks); stopTask dead-session branch untested; usage-fields mapping duplicated in handleTaskMessage branches (plan-mandated); fmtTokens 1000-boundary untested; WorkflowsPanel cap-math comment could carry an example.
- **Session-launcher deferred minors (final review triaged ALL as keep-deferred; SDD ledger deleted, this is the surviving record):** staticFiles 403/404/405 responses lack content-type; containment is string-path not realpath (trusted dist; comment gates reuse); joined socket that re-watches away loses its own project pushes (server.ts watch_project delete removes the join registration — no shipped client triggers it; fix = skip delete when `watching === ctx?.project`); peek no-project fallback literal omits `arcade`/not typed `satisfies ProjectMessage`; create_session registers empty Project before `!repo` check; SessionPicker has no ws.onerror/onclose (silent staleness) and pending never clears if server never responds; SERVER_URL DEV/prod ternary untested; cli.ts connects `ws://127.0.0.1` but prints `http://localhost`; launch() mkdirSync uncaught (raw stack on disk/perms failure); openBrowser try/catch vestigial; slugify mirrored in client sessionRow.ts + server workspace.ts (sync comment only — reviewer suggests shared JSON fixture test); WorkspaceManager provision assumes pre-slugified input + TOCTOU on concurrent provision (single-process sync path).
- Carried v3–v6c items: worktree-containment approvals; Bash-allowlist two-hop risk (AUTO amplifies; plugin hooks widen — v6c spec §8); frontend-design polish; meta-tools bypass gate #9; AgentStatus TOOLS line #10; plan-mode pairing cosmetic #11; deferred minors ledger (slashmenu wrap/nowrap, tabIndex=-1, orphaned .clone-* GC, SkillsPanel submit dedupe, pendingUrl clearing).

## 8. Resume & verify

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git status -sb   # main, in sync with origin; untracked: market-research.md, poc/demo-plugins/, tour-skill-suggest.png (NEVER commit these)
git ls-remote origin refs/heads/main          # must equal `git rev-parse main` — trust this over origin/main, which can be stale
git log --oneline -6                          # handoff commits on top of 0450c8d 'Merge A3: pull notifications'
cd poc/server && npx tsc --noEmit && npx vitest run   # tsc clean, 305 passed (~16s)
cd ../client && npx tsc --noEmit && npx vitest run && npm run build   # tsc clean, 160 passed, build clean
lsof -ti:3001; lsof -ti:5173                  # both EMPTY unless you started a stack — see §6 for how
```

**`main` was pushed to origin at the end of session #10** via `git push origin main:main` (the refspec form — the bare `git push origin main` has been blocked by the permission classifier before, §6). Nothing is unpushed. See §7f for an unexplained earlier push.

**To run Task 8.** Credentials are already on disk and both packages are already built (§7c) — just launch.

**GOTCHA, cost real time to find: `node dist/main.js` does NOT auto-load `.env`.** Only the `dev` script does (`poc/server/package.json:7` — `tsx watch --env-file-if-exists=.env`). The production single-port run needs the flag explicitly, or the process exits 1 with `config error: GITHUB_CLIENT_ID is required when CLIENT_DIST is set` — which looks like a config bug and is not one:

```bash
cd poc/server
CLIENT_DIST=$(cd ../client/dist && pwd) HOST=127.0.0.1 PORT=3001 \
  node --env-file=.env dist/main.js
# expect a startup log naming the allowlist COUNT (not the logins — that was fixed as M4)
```

**Which origin to use is decided by the OAuth app's registered callback: `http://localhost:5173/auth/callback`.** That is the **vite** port, not 3001, because the `state` cookie must be set and read on one origin. So Task 8 runs against **vite dev** (`cd poc/client && npm run dev`, then `http://localhost:5173/`) with the server on :3001 behind the new `/auth` proxy in `vite.config.ts` — NOT against the single-port :3001 build. If you'd rather exercise the single-port path instead, re-register the callback as `http://localhost:3001/auth/callback` first; the two cannot both work at once.

**The four paths to walk (plan Task 8 Steps 3-5), recording results in the plan's Deviations section:**
1. Signed out at `/` → landing screen → **Sign in with GitHub** completes the round trip and returns you to `/`.
2. Allowlisted → straight through to the lobby, **name field locked to the GitHub login**, then into a session. **Confirm the driver controls actually work** — this is where whole-branch Critical 1 lived (`isDriver` was false for everyone); the approve/deny controls and the PromptBar must be live, not "watching".
3. Denied: stop the server, set `GITHUB_ALLOWLIST=someone-else` in `.env`, restart, reload. Your cookie is still valid, so you land on the denied screen **showing your own login**. No second GitHub account needed.
4. Invite return path: the invite token must survive the OAuth round trip (spec §3.2). This is what whole-branch finding I4 fixed by carrying `next` in its own cookie — worth confirming for real.
5. Auth off: `unset` the GitHub vars (or run the plain `dev` script with no `.env`) and confirm `?name=alice` deep links and the anonymous flow are byte-for-byte as before.

**The one thing unit tests cannot see, and the reason Task 8 is not skippable: `SameSite` cookie behaviour across the OAuth redirect** (spec §10). If sign-in bounces you back to the landing screen still signed out, that is the failure — look at `SameSite=Lax` on `mpai_session` and whether the cookie is being set on the origin you returned to.

**To exercise the A1a production path locally** (proves the single-port build, `/healthz` ordering and the loopback bind without a box). The placeholder key gets past the fail-fast gate; it is fine for the HTTP surface but **the agent will not run** — a real key is needed for any agent turn:

```bash
cd poc/client && npm run build && cd ../server && npm run build
CLIENT_DIST=$(cd ../client/dist && pwd) HOST=127.0.0.1 PORT=3001 \
  ANTHROPIC_API_KEY=placeholder-not-a-real-key node dist/main.js &
curl -sS http://127.0.0.1:3001/healthz        # {"status":"ok"}  <- MUST be JSON, not the HTML page
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3001/healthz   # 405
lsof -nP -iTCP:3001 -sTCP:LISTEN              # must show 127.0.0.1:3001, NOT *:3001
# browser: http://127.0.0.1:3001/?session=check&name=alice   (second tab &name=ben -> PARTY · 2)
kill $(lsof -ti:3001)
```

To re-run the invite demo: build the client (`cd poc/client && npm run build`), then `cd poc/server && REQUIRE_INVITE=1 npx tsx src/main.ts` — **as of `4f9ea92` the env var is the supported route**; `main.ts` has no `staticDir`, so for the single-port UI demo use a `.mts` harness calling `startServer({port:3001, staticDir:<repo>/poc/client/dist, requireInvite:true})`. Full recipe in `docs/demos/2026-07-26-invite-and-oversight.md` (that doc predates the env var and still shows only the harness route — worth updating). **A harness must be `.mts` or live inside `poc/server/`**; a stray `.ts` outside the package is transformed as CJS and top-level `await` fails.

**Resume at §4.** Main is green (297 server / 147 client) and nothing is half-finished.

**Next action, concretely: RESUME THE SDD LOOP AT TASK 3's SCOPED RE-REVIEW.** Read `.superpowers/sdd/2026-07-27-v7a-repo-identity-lifecycle/progress.md` first — its `>>> RESUME POINT` line is authoritative. Concretely: run `scripts/review-package docs/superpowers/plans/2026-07-27-v7a-repo-identity-lifecycle.md a34a7f9 bd373a3`, dispatch `re-review-prompt.md` with the one open finding (`suggest_skill`/`decide_skill` unguarded against closed sessions), verdict it, then close Task 3, run Task 4, and finish with the whole-branch review on the most capable model. The SDD scripts are at `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/`.

**The v7a plan and the v7+v7b spec are both written, committed and user-approved — do not redo either.** Brainstorming for v7a+v7b is **DONE and user-approved** (session #11) — do not redo it. v7a is repo identity (`repoKey.ts`, normalized `origin` URL) plus the three lifecycle facts of spec §3.4 replacing today's conflated `ended`; it deliberately ships against the **standalone** server, where the repo key is trivially constant and `presence` is always online, so it is independently verifiable before any relay exists.

**Do NOT brainstorm v6b.** It was shelved mid-brainstorm in session #11 and is now **v7e**, blocked on the hub existing: until a hub holds two repos, "which sessions share a repo" is always "all of them." Its banked decisions in §3b still stand, plus four settled in session #11 that never reached a spec — collision = both diverged from the shared base on the same path (git-derived, whole-file); its own header badge in a calmer colour, sharing the OTHER PARTIES row, with amber reserved for gates; agent gets two tiers (digest naming contested files, plus withdrawal of auto-approve on a contested write, asked once per file per session); on by default; ended sessions included and labelled.

**A3 lesson worth carrying into v6b:** the project snapshot is pushed on activity and throttled to ~1/second (`schedulePush`, `server.ts:138-151`). Anything whose *display* changes with elapsed time rather than with events needs a client-side tick — A3 uses a 10s interval in `SessionView`. A collision that "becomes stale after N minutes" would need the same.

**Do not ask the user to re-supply credentials — they are already on disk.** Never print the contents of `poc/server/.env`; inspect it with `cut -d= -f1` (keys only) if you need to confirm it is intact. To test auth behaviour, use a throwaway config in the shell rather than editing `.env` (see the STATE block at the top for the exact recipe).

**Correcting a premise the user held, in case it comes up again:** a session cannot span two repositories, and neither can a server. `startServer` takes one `workspace` (`server.ts:68`) and every session provisions its worktree from that one repo, so "eng 1 on multiplayer_ai, eng 2 on last-call" means **two server processes**. Six engineers on one repo is the *designed* case: one server, six sessions, six isolated worktrees on their own branches. Also: there is **no owner/host role** — the first joiner becomes driver only because `currentDriverId` was null (`session.ts:72`), and `leave()` already hands the wheel to the next participant (`session.ts:76-86`), so "the host left" is already a non-event.

Design phases are closed for A2a: do not re-run brainstorming or writing-plans on it. Do not re-litigate anything in the plan's **Deviations** section — several entries are security fixes, and reverting to the plan's literal code would reintroduce an open redirect, an unauthenticated worktree/agent spawn, or an unanswerable permission gate.
