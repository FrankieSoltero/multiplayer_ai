# Deployment Strategy — Friends Beta → Public Launch (v-launch)

**Date:** 2026-07-25
**Status:** Approved design (brainstormed with user; all six sections reviewed section-by-section)
**Type:** Go-to-market / deployment strategy, not a feature spec. Implementation items called out in §2 and §4 get their own plans.

---

## 0. Context and decision record

Fresh competitive research (2026-07-25, four parallel web-research passes; sources in Appendix A)
updated the picture in `market-research.md`:

- **Live shared viewing of agent runs is now table stakes** (GitHub Copilot cloud sessions are
  shared-by-default; Warp, Factory, Amp, Omnigent all show the run).
- **Coarse cross-person control is shipping**: Factory markets "take over" verbatim; Warp grants
  edit access to viewers; Cursor lets teammates steer another user's cloud agent — running under
  the *creator's* credentials, a publicly complained-about flaw.
- **Nobody ships identity-clean, per-action approval handoff** — dropping into someone else's
  live session under your own identity solely to resolve a pending tool-permission gate. That is
  this product's headline primitive, and it remains unclaimed.
- **The clock is real**: Zed's DeltaDB beta (promised "within weeks" of June 11) can land any
  day; YC's Multiplayer AI RFS describes this product nearly word-for-word, so F26 entrants are
  coming; Superconductor ships weekly with the "multiplayer" narrative already staked.

**Decisions made during brainstorming (user-approved):**

| Decision | Choice |
|---|---|
| Primary outcome | Public demo/launch moment (stake the narrative before DeltaDB / F26) |
| Demo form | Gated hosted demo + video for everyone else |
| Timeline | Blitz: ~2 weeks, launch target ~Aug 8 2026 |
| Success definition | All four: narrative staked, YC ammo, demo pipeline, credibility |
| Approach | B — friends-first week 1, public launch week 2 |
| Week-1 cohort | Friends (trusted team — matches the PoC security model) |
| Auth | GitHub OAuth + username allowlist (not secret URLs; not claude.ai login — disallowed, see §2) |
| Persistence | None for launch (host-attended sessions; restart acceptable). Production roadmap in §6. |
| Production-grade | Nothing built now may foreclose hardening; explicit post-launch roadmap in §6 |

---

## 1. Strategy shape & positioning

**The plan in one sentence:** spend week 1 running the real product with friends in genuine
multiplayer sessions, fold what they stumble on back into the product and the pitch, then launch
publicly in week 2 with a video, a Show HN post, and a gated demo signup — staking the
"approval handoff" narrative with evidence instead of just a claim.

**The message we stake:**

> *Your agent hit a permission gate and you're at lunch. A teammate drops in, approves it under
> their own name, and leaves. The agent never stopped.*

Everything — video, post, README, YC application — leads with that moment. Not "multiplayer AI
workspace" (Superconductor's crowded category), not "watch agents live" (commoditized).

**Language discipline** (extends `market-research.md`):

- Keep: **awareness** (not shared context), **driver**.
- New: **"take the wheel" is contested** — Superconductor uses it verbatim on their homepage.
  Keep the mechanic front and center; lead public copy with **"approval handoff"** as the
  category-defining term; "take the wheel" becomes in-product flavor, not the headline claim.
- The villain of the story is Cursor's credential confusion (teammates act under the creator's
  OAuth credentials; users are complaining on their forum). Our line: *every decision on the
  wire carries the name of the human who made it.* GitHub OAuth (§4) makes this demonstrably
  true rather than self-asserted.

**Why friends-first is cheaper, not just safer:** the PoC's security model explicitly assumes a
trusted team. Friends *are* one — week 1 needs almost no hardening, and the real gating work
lands only for the week-2 public surface.

---

## 2. Week 1 — the friends beta (days 1–7)

**Cohort:** 3–8 friends, in pairs or trios (the primitive needs ≥2 people in a session).
Recruit day 1; sessions days 3–7; ~30–45 min each, user hosts as driver. Scripted beat: the
friend's agent hits a 🔐 gate while the driver is "away," and the friend gets pulled in to
approve. Every friend personally experiences the handoff.

**Build scope (days 1–3, deliberately small):**

1. **Deploy the stack to a VPS** (details §4).
2. **GitHub OAuth + allowlist** (details §4) — replaces both the week-1 secret-URL idea and the
   week-2 invite-token idea.
3. **The pull notification** — the one feature addition: when a permission gate is pending and
   the driver is idle/away, other party members get a visible, clickable pull ("🔐 Ana's session
   needs an approval — drop in"). This is the lite interrupt rail from the v6b backlog and makes
   the demo moment self-explanatory.
4. **A canned demo scenario** (extend `poc/scripts/demo-setup.sh`): a task that reliably hits a
   legitimate-feeling permission gate ~2–3 min in (deploy-ish or migration-ish — something a
   sandbox couldn't neutralize).
5. Nothing else. No v6a modes, no reconnect, no persistence.

**Auth & billing for sessions:**

- Host's `ANTHROPIC_API_KEY` with a Console workspace spend cap; sessions default to Sonnet,
  Opus reserved for the demo beat.
- Optional **BYO Anthropic API key** field at session creation (friend's sessions bill to them).
- **No claude.ai account connect.** Anthropic's Agent SDK docs state: *"Unless previously
  approved, Anthropic does not allow third party developers to offer claude.ai login or rate
  limits for their products, including agents built on the Claude Agent SDK."* (Appendix A.14.)
  This also means competitors can't piggyback on user subscriptions either — BYO key is the
  standard cost model in this space.
- Per-session key plumbing needs verification against the installed SDK version during build
  (same lesson as v5a: check the real SDK, not the docs from memory).

**Feedback capture:** after each session, log three things in a running doc — where they got
confused, what they said the product *was* in their own words (launch-copy goldmine), and
whether the approval moment landed without explanation. Ask permission to quote.

**Week-1 exit criteria:**

- ≥5 friends have personally approved a gate in someone else's session.
- Demo beat runs clean twice consecutively without host intervention (on the real VPS, not
  localhost).
- ≥2 usable quotes and a refined one-liner.

---

## 3. Week 2 — the public launch (days 8–14)

**Days 8–9 — fold in the beta.** Fix top confusion points, update the one-liner to friends'
actual language, re-record the video if the beat changed. (This is the entire reason Approach B
spends week 1 privately: the launch copy ships pre-tested.)

**Launch assets (days 8–11):**

1. **Video, 60–90s, the centerpiece.** One take, real product, no narration-over-slides:
   Ana's agent mid-task hits a 🔐 gate → Ana's away → Ben gets the pull, drops in, takes the
   wheel, approves *under his own name and glyph* → hands back → agent never stopped; the wire
   shows who approved. End card: one-liner + gated signup link. The 90s arcade aesthetic is a
   distribution asset — instantly recognizable in a feed of identical dark-mode terminal demos.
2. **Show HN post.** Title shaped like: *"Show HN: Approval handoff for AI coding agents — a
   teammate can approve your agent's pending action, as themselves."* Body: the problem, the
   primitive, honest architecture notes (event-sourced relay, trusted-team security model, what
   it doesn't do), links to repo + video + signup. The known-risks section from
   `market-research.md` goes in verbatim — disclosed limitations read as maturity.
3. **X thread.** Video clip first; walk the moment frame by frame; one tweet contrasting with
   the credential-confusion failure mode ("every decision on the wire carries the name of the
   human who made it") without naming Cursor combatively.
4. **Repo public** with rewritten README: the moment first, architecture second, research
   report linked. The spec/plan/TDD process artifacts are credibility ammo.

**Gated signup (days 10–11):** simple form (email, team size, current agent tooling) → calendar
link for hosted 30-min sessions the user drives, same setup as the friends beta. Non-bookers get
the video + local-run instructions (BYO key). Bookings capped at what one person can host —
scarcity is acceptable at this stage. (Accepted trade: throughput is capped by the host's
calendar for launch week.)

**Launch day (~day 12, Tue–Thu morning US time):** HN + X within the same hour; repo flipped
public just before; demo slots open. Days 13–14: response duty (HN threads, especially the
security-model question — answer already written) and first booked demos.

**YC application:** assembled days 13–14 from the launch materials. Video = demo link; beta
quotes + booking count = traction; launch timestamp = shipping speed against their own RFS.

---

## 4. Technical deployment plan

**Infra (days 1–2):** one small VPS (Hetzner/DigitalOcean class, ~$10–20/mo); Node server under
systemd (restart=always) or pm2; Caddy in front for automatic HTTPS + static client + WebSocket
passthrough; one domain. No containers, no orchestration — one box, one process, matching the
existing single-process architecture.

**Auth — "Sign in with GitHub," not an account system:**

- GitHub OAuth authorization-code flow on the Node server: `/auth/login`, `/auth/callback`,
  signed session cookie; WS join handler validates the cookie.
- **Allowlist as the entire access-control system:** flat file/env list of GitHub usernames —
  friends in week 1, booked attendees added per-demo in week 2. Add = grant; remove = revoke.
- **Identity flows into the product:** GitHub username + avatar seed lobby identity (glyph/color
  still user-chosen — the co-op framing stays); `userId` on the wire becomes the GitHub login.
  Approvals, take-the-wheel, and arcade records carry verified identity. Demo line upgrades
  from "Ben approved it" to "*github.com/ben* approved it" — the identity-clean claim becomes
  demonstrable (§1).
- **Out of scope:** email/password, user database, roles, org management, other providers.
- Budget: ~+1 day in week 1 (net, since it replaces both token schemes).
- Production note: GitHub OAuth is a production-legitimate foundation (later: org membership as
  the allowlist — §6), not demo scaffolding.

**Spend control:** capped workspace key; Sonnet default / Opus for the beat; BYO-key option;
kill switch = process restart (in-memory state, no cleanup).

**Security posture — stated honestly rather than fixed:** known residual risks stay open and
documented: the Bash-allowlist two-hop escape and the trusted-driver boundary
(`market-research.md` → Known risks). Hosting mitigations are operational: throwaway demo repo
in a throwaway worktree on a throwaway box; sessions run only while hosted; box holds no secrets
beyond the capped API key. This "assume-breach box" framing is also the HN answer.

**Reliability floor (only two items):**

1. systemd restart policy — crash recovery in seconds; acceptable because every session is
   host-attended ("let me restart that").
2. Pull-notification + demo scenario verified end-to-end **on the VPS** before the first friend
   session.

**Explicitly not building for launch:** persistence across restarts, client auto-reconnect,
multi-tenancy, rate limiting. All appear in the §6 roadmap; none are blocked by launch choices.

---

## 5. Risks & contingencies

1. **DeltaDB (or an F26 competitor) launches mid-plan.** Likeliest disruption; their beta is
   overdue. Contingency: compress, don't restart — post teaser clip + public repo within 48h,
   copy positioned against what they shipped (shared-context CRDT vs isolation + awareness +
   identity-clean approvals). Full launch continues on schedule.
2. **Demo beat fails live.** Mitigations: exit criteria require two consecutive clean runs on
   the VPS; host-attended sessions allow restarts; the video exists so launch never depends on a
   live demo.
3. **HN security takedown.** Pre-empt, don't defend: known-risks section in the Show HN body
   verbatim (assume-breach box, trusted-team model, sandboxing scoped out, §6 roadmap linked).
   Disclosed limitation = maturity; discovered limitation = negligence.
4. **Launch lands flat.** Degrades gracefully: beta users + quotes exist, YC application doesn't
   require virality, video + repo are permanent assets. Contingency: shift days 13–14 to direct
   outreach — DM the ~20 most relevant agent-tooling people with the video.
5. **Cost blowout.** Capped key + Sonnet default + host-attended sessions → bounded at low
   hundreds of dollars. Accepted.
6. **Superconductor ships approval gates in response.** Post-launch; validates the category, and
   the launch timestamp establishes who defined it. Moat argument: their architecture deletes
   the approval moment (sandbox auto-approve + PR-stage review); retrofitting per-action human
   gates across 8 heterogeneous runtimes is structural work, not a sprint. (Appendix A.1.)

---

## 6. Success metrics, YC tie-in, production-grade roadmap

**Metrics at day 14** (mapped to the four chosen outcomes):

| Outcome | Metric | Floor / Good / Great |
|---|---|---|
| Narrative staked | Launch post visibility | Posted + indexed / HN front page ≥1h / newsletter pickup |
| Pipeline | Booked gated demos | 5 / 15 / 30+ with waitlist |
| Credibility | Inbound builder/investor conversations | 3 / 10 / term-sheet-adjacent |
| YC ammo | Application status | Drafted w/ demo link / submitted / submitted w/ usage + bookings |

**Leading indicator (week-1 tripwire):** the approval moment lands without explanation for ≥5
friends. If not, take 2–3 extra days on copy before launching.

**Production-grade roadmap (post-launch, in order real teams would hit each wall):**

1. **Persistence** — write-through of the append-only log to SQLite → Postgres; replay from disk
   on restart. Additive to the event-sourced design; no protocol change.
2. **Client auto-reconnect** with seq-based catch-up (the `seq` field exists for this).
3. **Real multi-tenancy** — org/project scoping on GitHub OAuth (org membership as allowlist);
   per-org or required-BYO API keys.
4. **Sandboxing the residual risks** — OS-level isolation per agent session (containers /
   firejail), closing the Bash-allowlist two-hop escape the PoC scoped out. Converts the §5.3
   disclosure into a solved problem.
5. **Observability & audit** — structured export + retention of every permission decision with
   actor identity (wire events already carry it). Doubles as the enterprise audit-trail story;
   aligns with corporate security standards (audit trails for security-relevant events).
6. **Rate limiting & abuse controls** on the WS server before any self-serve signup.

Sequencing principle: 1–2 unlock unattended demos; 3–4 unlock real teams; 5–6 unlock selling it.
Nothing built in the two-week blitz forecloses any of these.

---

## 7. Two-week calendar (summary)

| Days | Work |
|---|---|
| 1–2 | Recruit friends; VPS + Caddy + systemd deploy; GitHub OAuth + allowlist |
| 2–3 | Pull notification; canned demo scenario; end-to-end VPS verification |
| 3–7 | Friend sessions (3–8 people); feedback log; exit criteria |
| 8–9 | Fold in beta learnings; record final video |
| 8–11 | Show HN draft; X thread; README rewrite; gated signup form + calendar |
| ~12 | **Launch** (HN + X + repo public, Tue–Thu AM US) |
| 13–14 | Response duty; booked demos; YC application from launch materials |

---

## Appendix A — Sources & evidence

Every load-bearing competitive/platform claim in this strategy, linked to its primary source.
Verified 2026-07-25 via four parallel research passes; items marked (secondary) were not
verified against a primary source and deserve a hands-on check before being treated as ground
truth.

**A.1 Superconductor** (closest named competitor; "take the wheel" contested; no approval surface)
- Homepage — "multiplayer workspace… Jump in on a teammate's run anytime — take the wheel":
  https://www.superconductor.com/
- Chat mechanics (queued messages, everyone can participate; no control primitive):
  https://www.superconductor.com/docs/implementation/chat
- Workspaces launch (team layer, Jan 12 2026): https://www.superconductor.com/blog/workspaces
- Security model (sandbox auto-approve + PR-stage review; no approval workflow documented):
  https://www.superconductor.com/docs/security
- Pricing ($128/mo Pro): https://www.superconductor.com/pricing
- Team/funding ($7M, 7 people): https://www.superconductor.com/careers
- Network sandboxing (their guardrail-during-run answer):
  https://www.superconductor.com/blog/network-sandboxing

**A.2 Factory.ai** (closest shipped analog to control transfer)
- "Send a teammate a live session URL and they can watch the Droid work, leave comments, or
  take over…" (verbatim): https://factory.ai/product/web
- Cross-surface sessions: https://factory.ai/product/desktop

**A.3 Warp** (live multi-viewer sessions, grantable edit access)
- Agent session sharing docs (avatars/cursors, view vs edit roles, sharer approves edit
  requests): https://docs.warp.dev/agent-platform/local-agents/session-sharing/

**A.4 Cursor** (cross-person steering under creator's credentials — the "villain" evidence)
- Forum thread (staff-confirmed behavior, user security objections):
  https://forum.cursor.com/t/cursor-cloud-agent-sessions-are-shared-across-users-act-on-behalf/158866
- Docs ("a user can influence the execution of a cloud agent that runs with another user's
  secrets and credentials"): https://docs.cursor.com/en/slack

**A.5 GitHub Copilot cloud agent** (shared viewing default; steering initiator-only; no approvals)
- Manage/track docs ("shared by default… recipients can view… but cannot steer or modify"):
  https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents
- Agents tab in repos (Jan 26 2026):
  https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository/
- Mission control + real-time steering (Oct 28 2025):
  https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/
- Cloud agent autonomy (no approval pauses; firewall warns after block):
  https://docs.github.com/en/copilot/concepts/agents/coding-agent/mcp-and-coding-agent

**A.6 Zed / DeltaDB** (no shipped agent-session sharing; DeltaDB is the announced threat)
- DeltaDB announcement ("join while the work is still happening, talk to the agent that did
  the work"; waitlist): https://zed.dev/blog/introducing-deltadb
- Parallel Agents (single-developer, no collaboration): https://zed.dev/blog/parallel-agents
- Channels/follow-mode docs (editor-scoped, not agent-scoped):
  https://zed.dev/docs/collaboration/channels
- Agent Panel docs (no sharing features): https://zed.dev/docs/ai/agent-panel

**A.7 Databricks Omnigent** (open-source live session sharing)
- Announcement (URL-shared live sessions; view/comment/send commands):
  https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents

**A.8 oh-my-pi** (OSS `/collab` pairing + spectator links)
- Repo: https://github.com/can1357/oh-my-pi

**A.9 Claude ecosystem**
- Claude Code issue #60082 — open request for real-time cross-account session sharing ("VS Code
  Live Share for a Claude Code chat"); documents that share links are read-only:
  https://github.com/anthropics/claude-code/issues/60082
- Claude Tag / Slack (channel-shared Claude, shared-context architecture) (secondary):
  https://www.digitalapplied.com/blog/anthropic-claude-tag-slack-team-collaboration-2026

**A.10 Enterprise "multiplayer AI" cluster** (shared context, no live sessions)
- Dust $40M Series B, "multiplayer OS" framing:
  https://tech.eu/2026/05/18/dust-raises-40m-series-b-to-build-the-multiplayer-operating-system-for-enterprise-ai/
- Dust collaboration + steering docs (shared conversations; no presence/handoff):
  https://docs.dust.tt/docs/collaboration ·
  https://docs.dust.tt/docs/steering-conversations-that-keep-up-with-you
- elvex "Spaces" (persistence model, explicitly not real-time):
  https://www.elvex.com/blog/multiplayer-ai-enterprise-team-collaboration
- Replit multiplayer docs (per-person agent threads; presence for editing only):
  https://docs.replit.com/replit-workspace/workspace-features/multiplayer
- mixus legal pivot (async email/doc agents): https://www.mixus.ai/

**A.11 Approvals-as-a-category** (demand for (c), detached from live sessions)
- HumanLayer (`@require_approval`, Slack/email routing): https://github.com/humanlayer/humanlayer
- gotoHuman (team approval inbox): https://www.gotohuman.com/
- LangChain Agent Inbox: https://github.com/langchain-ai/agent-inbox
- Omnara (YC S25; single-user phone approvals): https://github.com/omnara-ai/omnara

**A.12 Market timing**
- YC Requests for Startups — Multiplayer AI ("Anyone on a team should be able to drop into the
  same live agent session to watch it work, redirect it, and hand it off"):
  https://www.ycombinator.com/rfs
- Stealth S26 team in the space (ex-Thena/ex-Branch) (secondary):
  https://medium.com/@govind_k/the-era-of-humans-and-agents-why-we-joined-yc-s26-11ca578a5889

**A.13 Adjacent / fleet tooling** (single-operator; no multi-user live sessions)
- Amp thread sharing (async visibility): https://ampcode.com/manual
- Devin session messaging API:
  https://docs.devin.ai/api-reference/v1/sessions/send-a-message-to-an-existing-devin-session
  (secondary re: live co-steering)
- OpenHands Cloud (multi-user claims, depth unverified): https://www.openhands.dev/ (secondary)

**A.14 Platform constraint — no claude.ai login for third-party products**
- Claude Agent SDK overview ("Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products…"):
  https://code.claude.com/docs/en/agent-sdk/overview

**A.15 Internal references**
- Positioning + known risks: `market-research.md` (repo root)
- v6b carried items incl. interrupt rail: `docs/superpowers/specs/2026-07-25-v6a-modes-skills-design.md` §8
- Trust-boundary and containment history: `docs/superpowers/specs/2026-07-24-full-capabilities-design.md`,
  `HANDOFF.md` carried open items
