# Project lifecycle controls (§8.2 remainder) — implementation plan

**PRD of record:** `docs/PRD.md` §8.2 — "Known plan gap, disclosed in PR #22: `close_project`/
`archive_project` exist and are tested hub-side but have **no client surface** yet, so archived
state is unreachable from the UI." With project-scoped invites shipped (`feature/project-invites`),
this is the last open item in §8.2. Spec of record: `docs/superpowers/specs/2026-07-28-projects-design.md`
(:98-109 lifecycle semantics, :181 wire, :242 close-and-archive-only, :298 no auto-archive).

**Process note:** same as the invites plan — executed in Kimi Code CLI, no soltero council; this
plan carries its own design section.

**Goal:** a project member can close, reopen, archive, and un-archive a project from the UI, and
archived projects are reachable again — closing §8.2.

**Already true (do not rebuild):**
- Hub: `set_project_lifecycle {projectId, lifecycle}` member-gated, validates
  active/closed/archived, free transitions, `pushProjects` fan-out (`hub.ts:1238-1253`);
  `join_project` and `create_session` refuse non-active projects (`hub.ts:1216`, `:1378`).
- Client read side: `sortProjects` drops archived (`projectList.ts`), CLOSED badge
  (`ProjectPicker.tsx`), `canAct` → `"not-active"` → "this project is closed" (`projectAccess.ts`).
- Spec semantics: `closed` stops new sessions and new members, existing sessions stay readable;
  `archived` hides from the *default* entrance list. Member-only (hub landed membership-gated,
  not creator-only — the client gates visibility on the same signal).

**Stack / suites (baselines on this branch, from runs 2026-08-01):**
- client: `cd poc/client && npx tsc -b && npx vitest run` (509)
- server: `cd poc/server && npx tsc --noEmit && npx vitest run` (763)
- hub: `cd poc/hub && npm --prefix ../server run build >/dev/null && npx tsc --noEmit && npx vitest run` (368)
- Never predict post-change totals; read them from runs.

**Plan done gate (objective):**
1. Tasks 1–3 landed; all three suites fresh, exit 0, zero failures, tsc clean.
2. The archived round trip is provable end to end from the UI layer down: archive → project
   disappears from the default entrance → SHOW ARCHIVED reveals it → UNARCHIVE returns it.
   Pinned by client tests over the `sortProjects`/rows seam plus a hub round trip already
   covered hub-side.
3. Solo mode: `set_project_lifecycle` answered by the standalone server (no fall-through to an
   unrecognized-message error), with the same refusal strings as the hub.
4. `git diff --name-only main` touches only `poc/**`, `docs/**`, HANDOFF.md.

## §1 Design (the decisions, locked)

1. **One message, three transitions.** The client speaks only the landed
   `set_project_lifecycle` — the spec's `close_project`/`archive_project` names were never the
   shipped protocol. Exposed transitions: from **active**: CLOSE, ARCHIVE. From **closed**:
   REOPEN (→active), ARCHIVE. From **archived**: UNARCHIVE (→active). Delete does not exist
   (spec :242).
2. **Controls live on the project screen** (`SessionPicker`), member-only — same membership
   signal (`actable`/`isMember`) the INVITE section uses; a non-member never sees them and the
   hub's "join this project before changing it" refusal degrades quietly if raced. A two-step
   arm-and-confirm on the destructive two (CLOSE, ARCHIVE): first click arms ("SURE?"), second
   sends; REOPEN/UNARCHIVE send directly (they restore, they don't destroy).
3. **The entrance gains SHOW ARCHIVED** — a toggle row under the project list. Default off
   (spec: archived hides from the *default* list). On: archived projects render with an
   ARCHIVED badge (the CLOSED badge's sibling) and ENTER still works — closed/archived projects
   stay readable; `canAct` already refuses *acting* with truthful copy. `sortProjects` gains an
   `includeArchived` option rather than a second sort path.
4. **Standalone parity is in scope.** The server answers `set_project_lifecycle` over its
   in-memory solo project: same validation, same member-gate refusal strings as the hub
   ("join this project before changing it"), lifecycle carried in its project summary, and
   `join_project`/`create_session` refuse non-active with the hub's strings. It dies with the
   process like all solo state — parity of *protocol*, not of durability.
5. **Nothing changes for live sessions.** A project closing under an open session view changes
   nothing in that view (existing sessions stay readable; the hub already gates only *new*
   joins/sessions). Verified by the existing hub tests staying green, not by new machinery.
6. **Out of scope:** per-member notification toasts on lifecycle change (the projects push
   already repaints every screen); auto-archive on empty (spec :298 forbids); any hub/store work
   (already landed and tested).

## §2 Global constraints

1. **One protocol, two answerers** (carried from the invites plan): identical message, shapes,
   and refusal strings on hub and standalone server; the client never branches on which.
2. **Membership gates management; visibility stays hub-wide.** Same rule as invites.
3. **T14 parity** holds: any control added to a theme-executed surface keeps a theme-independent
   label; the picker control set stays identical across themes.
4. **No speculative transitions.** Only §1.1's five buttons; no delete, no bulk ops, no
   lifecycle for sessions.

## §3 Tasks

Order is dependency order; one writer per file at a time; each task lands green before the next.

1. **Server parity** — `poc/server/src/server.ts`: track the solo project's lifecycle (default
   `active`); handle `set_project_lifecycle` (validation + member-gate + refusal strings per
   §1.4); carry lifecycle in the project summary; refuse `join_project`/`create_session` when
   non-active with the hub's strings. Tests in `poc/server/test/server.test.ts`: round trip,
   bad-lifecycle string, non-member refusal, join/create refusals when closed.
2. **Client entrance** — `projectList.ts`: `sortProjects(projects, { includeArchived })`.
   `ProjectPicker.tsx`: SHOW ARCHIVED toggle row (default off), ARCHIVED badge beside CLOSED.
   Tests: `projectList.test.ts` gains the include arm; `ProjectPicker.test.tsx` pins the toggle's
   theme-independent label and the badge.
3. **Client project screen** — `SessionPicker.tsx`: lifecycle section (current state + §1.1
   buttons, arm-and-confirm on CLOSE/ARCHIVE), sends `set_project_lifecycle` over its own
   socket, member-gated visibility, quiet degrade on refusal. Tests over a props-only seam
   (house no-DOM pattern): button set per lifecycle state, arm-then-send sequence, member gate.
4. **Docs sweep** — PRD §8.2 final state (gap closed); HANDOFF wrap entry. Mechanical.

## §4 Verification per task

- T1: server suite green; the three refusal strings asserted verbatim.
- T2/T3: client suite green incl. T14 picker parity; no assertion weakened — retargeted only.
- Final: all three suites fresh; done gate §0 re-checked line by line.
