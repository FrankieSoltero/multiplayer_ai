# v6c — Plugin import + full Claude Code skills

*Design spec, approved 2026-07-25 (late night). From the user's ask: "I want the skills and functionality we can get in Claude Code in this project… and a way to import a user's own skills, like bringing soltero-skills into it." Approach A (managed plugin store + live roster) chosen over env-only (B) and hot-reload (C). Numbered v6c because v6b is reserved for the banked interrupt-rail cycle; build order is the user's call, but v6c's client work depends on v6a's skills screen — **v6a (PR #5) must merge first**.*

## 1. Scope decisions (locked in brainstorm)

| Decision | Choice | Why |
|---|---|---|
| Feature scope | Built-in CC skills + imported plugin skills; design around skills, other plugin content (commands/agents/hooks) comes along only as the SDK bundles it | User wants Claude Code parity; skills are the product surface, the rest is carry-through. |
| Import scope | Project-scoped: a registered plugin applies to every session in the project | Co-op framing, one shared roster. Rejected per-session loadouts (rosters diverge) and server-env-only (user can't self-serve). |
| Import form | Git URL; server shallow-clones into a managed directory | User picked the nicer story over path-pasting. https:// only. |
| Governance | Anyone in the project can add/remove; every change attributed on the wire | Trusted-team PoC stance; accountability by visibility, same as gates and mode changes. Rejected driver-only (driver is session-scoped, plugins are project-scoped — bad fit). |
| Effect timing | New sessions only; live sessions keep their loadout | SDK loads plugins at stream start. Honest, cheap; hot reload (Approach C) banked as follow-up — stream restarts are where known SDK gotchas live. |
| Built-ins | `skills: "all"` — deliberate reversal of the harness-capabilities-era "hide built-ins" decision | Built-in CC skills are now a chosen feature, not an isolation leak. `AGENT_SKILLS` env retires as the mechanism. |

## 2. Plugin store (server)

New module `poc/server/src/pluginStore.ts`. Clones live under **`AGENT_PLUGINS_ROOT`** (env, same pattern as `AGENT_WORKDIR_ROOT`), laid out `<root>/<projectId>/<pluginName>/`. Env unset ⇒ feature off (see §6).

- `addPlugin(projectId, url)`:
  - Accept `https://` git URLs only (TLS enforced, no ssh-key surprises).
  - Shallow-clone `git clone --depth 1` spawned as **argv, no shell** — the URL cannot inject.
  - Validate the clone is a plugin: `.claude-plugin/plugin.json`, or a `skills/` dir containing ≥1 `SKILL.md`. Otherwise delete the clone and error.
  - Plugin name: `plugin.json` `name`, else repo basename; sanitized to `[a-z0-9-]` (kills path traversal). Duplicate name in the project ⇒ delete the fresh clone and error.
  - Returns `PluginInfo` incl. skills scanned from `skills/*/SKILL.md` frontmatter (name + description — real descriptions, unlike today's `plugin:` empty fallback in `skillRoster.ts`).
- `removePlugin(projectId, name)`: delete the clone dir.
- **Boot rescan:** on server start, walk `<root>/*/*` and rebuild each project's registry from disk. Registrations survive restarts; no database.
- Clone is async; tests inject a fake clone function (no network in tests).

## 3. Wire & server

Follows the v5b pattern exactly: session event for the moment, project snapshot for the state.

```ts
// events.ts — additions
| { type: "plugin_change"; action: "add" | "remove"; name: string; skillCount: number; userId: string }
// ProjectMessage gains:
plugins: PluginInfo[]   // { name, url, skills: SkillInfo[], addedBy }
```

- Client → server: `add_plugin { url }`, `remove_plugin { name }`.
  - Validation/clone failures ⇒ existing `sendError` path to the requester only; nothing appended.
  - Success ⇒ `plugin_change` appended to the **acting user's session** (attributed, replayable for late joiners) + snapshot push carries the updated registry to the whole project.
- Session creation (`server.ts` `getOrCreateSession`): pass the project's current plugin paths into `AgentDriver`; sessions created before an add simply don't have it.

## 4. Session integration (agentDriver)

- `AgentDriver` gains `pluginPaths: string[]`; `runQuery` options add
  `plugins: pluginPaths.map(p => ({ type: "local", path: p }))` (SDK ≥0.3.218, `SdkPluginConfig` type `local`).
- `skills` option: `"all"` (reversal recorded in §1). `settingSources: []` isolation otherwise unchanged.
- **Roster becomes truthful in two layers**, no client protocol change (derive already takes the latest `skill_roster`):
  1. At session creation: `skill_roster` from the pluginStore scan — instant, accurate for plugin skills (namespaced `soltero-skills:agent-handoff`).
  2. Once the SDK stream initializes: query the live session for its actual skill list (the SDK reports names + descriptions incl. built-ins) and append a refreshed `skill_roster` that supersedes the first.
- `AGENT_SKILLS` retired: parsing may remain harmless, but it is no longer the mechanism; docs/demo scripts drop it.

## 5. Client

- **SkillsPanel — PLUGINS section** (above the skill-suite union): one row per registered plugin (name, short URL, skill count, "added by <name>", remove `[x]`), plus an add row (git-URL input + `ADD` button). In-flight add shows `cloning…` until the snapshot lands or `sendError` returns. Standing note: `plugins apply to sessions started from now — this session keeps its loadout`.
- **Suite & palette:** zero extra plumbing — the union renders whatever rosters carry; namespaced plugin skills arrive with real descriptions; `/name args` palette insertion works unchanged.
- **Transcript:** `plugin_change` renders as a standard decision line — `✦ frankie added plugin soltero-skills (14 skills) — applies to sessions started from now` / `✦ frankie removed plugin soltero-skills`. No new styling.
- **derive.ts / types.ts / App.tsx:** carry `plugin_change`; `ProjectMessage.plugins` flows into App state alongside `arcade`, passed to SkillsPanel as a prop.
- No new hotkeys, no header change — the v6a SKILLS screen is the front door.

## 6. Errors & edge cases

- Non-https URL, clone failure, not-a-plugin, duplicate name, remove-unknown-name ⇒ `sendError` to requester; nothing on the wire.
- `AGENT_PLUGINS_ROOT` unset ⇒ SkillsPanel shows `plugin import is off — set AGENT_PLUGINS_ROOT on the server` instead of the add row; socket `add_plugin` errors cleanly.
- Concurrent adds of the same repo: second hits the duplicate-name check post-clone and deletes its own dir.
- Late joiners: `plugin_change` replays from the session log; registry state arrives via the snapshot — same as arcade records.

## 7. Testing

Baselines entering this cycle: server 103, client 43 (on the v6a branch).

- **pluginStore unit tests** (fixture dirs, injected clone fn): shape validation, name sanitization, duplicate rejection, boot rescan, https-only.
- **Server e2e over the socket:** add ⇒ `plugin_change` on the wire + snapshot carries the plugin; a session created **afterwards** passes the plugin path and `skills: "all"` into `runQuery` (assert via captured options — established fake-query pattern) while a pre-existing session doesn't; remove ⇒ registry shrinks; error paths append nothing.
- **Client:** derive handles `plugin_change` + plugins-in-snapshot; SkillsPanel add/remove/pending/feature-off states.
- **Manual demo:** paste the real soltero-skills GitHub URL, watch the PLUGINS row and roster fill, start a fresh session, have the agent invoke one of its skills via the Skill tool.

## 8. Risks (named deliberately)

- **Hooks widen the trust boundary further than AUTO did.** A cloned plugin can carry hooks — shell execution inside sessions — imported by *any* project member. PoC stance stays "trusted team"; mitigations are visibility (attributed wire events, registry on the skills screen) and https-only clones. Expect this question from anyone technical; there is no sandbox answer in this cycle.
- **`skills: "all"` re-exposes host built-ins.** Previously recorded as an isolation leak, now a chosen feature — the reversal is deliberate and recorded in §1.
- **Network enters the server's job.** Cloning is the first outbound network the PoC server does; failures are user-visible via `sendError`, and tests never touch the network.

## 9. Carried / explicitly out of scope

- Hot reload of plugins into live/idle sessions (Approach C) — banked.
- Git-URL auth (private repos), plugin updates/re-pull, version pinning — banked.
- Plugin commands/agents/hooks as first-class UI surfaces — only skills get UI this cycle.
- v6b interrupt-rail cycle unchanged and still banked (v6a spec §8).
