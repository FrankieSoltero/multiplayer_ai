# v7a — Repo Identity and Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every session a stable cross-machine repo identity and split today's conflated `ended` flag into the three orthogonal lifecycle facts the hub will need.

**Architecture:** Two pure modules (`repoKey.ts`, `lifecycle.ts`) following the established extract-pure-then-test pattern, each surfaced as one additional field on the project snapshot that already broadcasts. No new message types on the publish side; one new command (`close_session`) and one new event (`session_closed`). Everything ships against **today's standalone server**, where `repoKey` is the same for every session and `presence` is a constant — v7b makes both vary without the client changing.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest, React 18, `ws`.

## Global Constraints

- Spec authority: `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md`. Read §3.3 and §3.4 before starting.
- **Server imports use `.js` specifiers** even for `.ts` sources (NodeNext). Client imports do not.
- Server tests live in `poc/server/test/*.test.ts`; client tests are co-located in `poc/client/src/`.
- **There is no client component-test infrastructure.** Client logic is extracted into pure modules and tested there. Do not add a component test framework in this plan.
- **A `<label>` must never wrap a form control** in this codebase (it forwards a second synthesized click and kills `<select>` dropdowns). Not exercised by this plan, but it applies if you touch markup.
- Baselines before starting: **server 305 tests, client 160 tests**, both `tsc --noEmit` clean, client build clean.
- Do not run `git add -A`. Every commit spells out its paths.
- Never commit `market-research.md`, `poc/demo-plugins/`, or `tour-skill-suggest.png` — they are permanently-untracked user files.
- **Out of scope, do not build:** the hub, `relay.ts`, device pairing, persistence, handoff continuity, collision detection. Also do not fix anything in `docs/tech-debt.md` — that is a deliberately separate pass.

---

### Task 1: `repoKey.ts` — pure repo-identity normalization

**Files:**
- Create: `poc/server/src/repoKey.ts`
- Test: `poc/server/test/repoKey.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeRemote(raw: string): string | null`, `localRepoKey(hostname: string, repoRoot: string): string`, `repoKeyFor(remoteUrl: string | null, ctx: { hostname: string; repoRoot: string }): string`. Task 2 calls `repoKeyFor`.

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/repoKey.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { normalizeRemote, localRepoKey, repoKeyFor } from "../src/repoKey.js";

describe("normalizeRemote", () => {
  test("collapses the three forms of the same GitHub repo to one key", () => {
    expect(normalizeRemote("git@github.com:acme/api.git")).toBe("github.com/acme/api");
    expect(normalizeRemote("https://github.com/acme/api")).toBe("github.com/acme/api");
    expect(normalizeRemote("https://github.com/acme/api.git")).toBe("github.com/acme/api");
  });

  test("strips embedded credentials so a token never reaches the key", () => {
    expect(normalizeRemote("https://user:ghp_secret@github.com/acme/api.git")).toBe(
      "github.com/acme/api",
    );
  });

  test("lowercases the host but preserves path case", () => {
    // GitHub paths are case-insensitive in practice but not canonicalised by
    // git; lowercasing them would merge genuinely distinct repos on
    // case-sensitive hosts.
    expect(normalizeRemote("https://GitHub.COM/Acme/API.git")).toBe("github.com/Acme/API");
  });

  test("strips ports, ssh:// scheme, and trailing slashes", () => {
    expect(normalizeRemote("ssh://git@git.example.com:2222/acme/api.git")).toBe(
      "git.example.com/acme/api",
    );
    expect(normalizeRemote("https://github.com/acme/api/")).toBe("github.com/acme/api");
  });

  test("returns null for things that are not remote URLs", () => {
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("   ")).toBeNull();
    expect(normalizeRemote("file:///Users/me/code/api")).toBeNull();
    expect(normalizeRemote("/Users/me/code/api")).toBeNull();
    expect(normalizeRemote("https://github.com")).toBeNull();
  });
});

describe("localRepoKey", () => {
  test("is stable for one path and different for another", () => {
    const a = localRepoKey("laptop", "/Users/me/code/api");
    expect(a).toBe(localRepoKey("laptop", "/Users/me/code/api"));
    expect(a).not.toBe(localRepoKey("laptop", "/Users/me/code/web"));
  });

  test("differs across machines so two laptops never falsely match", () => {
    expect(localRepoKey("laptop-a", "/src/api")).not.toBe(localRepoKey("laptop-b", "/src/api"));
  });

  test("is prefixed local: so the wire never confuses it with a real remote", () => {
    expect(localRepoKey("laptop", "/src/api").startsWith("local:")).toBe(true);
  });

  test("does not leak the absolute path", () => {
    expect(localRepoKey("laptop", "/Users/secret-name/code/api")).not.toContain("secret-name");
  });
});

describe("repoKeyFor", () => {
  const ctx = { hostname: "laptop", repoRoot: "/src/api" };

  test("prefers the normalized remote when there is one", () => {
    expect(repoKeyFor("git@github.com:acme/api.git", ctx)).toBe("github.com/acme/api");
  });

  test("falls back to a machine-local key when there is no remote", () => {
    expect(repoKeyFor(null, ctx)).toBe(localRepoKey("laptop", "/src/api"));
  });

  test("falls back when the remote is unrecognisable rather than guessing", () => {
    expect(repoKeyFor("not-a-url", ctx)).toBe(localRepoKey("laptop", "/src/api"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/server && npx vitest run test/repoKey.test.ts`
Expected: FAIL — cannot resolve `../src/repoKey.js`.

- [ ] **Step 3: Write minimal implementation**

Create `poc/server/src/repoKey.ts`:

```ts
import { createHash } from "node:crypto";

/** Normalize a git remote URL into a key that is byte-identical across
 *  machines and protocols, so two engineers who cloned the same repo group
 *  together with zero configuration (spec §3.3).
 *
 *      git@github.com:acme/api.git      ─┐
 *      https://github.com/acme/api       ─┼──→  github.com/acme/api
 *      https://github.com/acme/api.git   ─┘
 *
 *  Returns null for anything not recognisably a remote URL — callers fall back
 *  to a machine-local key rather than guessing, because a wrong match is worse
 *  than no match. */
export function normalizeRemote(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0) return null;

  let host: string;
  let rest: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme) {
    // Scheme form: https://, ssh://, git://. Must be checked BEFORE the
    // scp-like branch, whose pattern would otherwise read "https" as a host.
    let after = url.slice(scheme[0].length);
    const at = after.lastIndexOf("@"); // strip user:password@
    if (at !== -1) after = after.slice(at + 1);
    const slash = after.indexOf("/");
    if (slash === -1) return null; // a host with no path is not a repo
    host = after.slice(0, slash);
    rest = after.slice(slash + 1);
  } else {
    // scp-like form: [user@]host:path — git's default for SSH remotes.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (!scp) return null;
    host = scp[1];
    rest = scp[2];
  }

  host = host.replace(/:\d+$/, "").toLowerCase(); // drop port; hosts are case-insensitive
  // Paths are NOT lowercased: on a case-sensitive host, acme/API and acme/api
  // are genuinely different repos and merging them would be a false match.
  rest = rest
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");

  if (host.length === 0 || rest.length === 0) return null;
  return `${host}/${rest}`;
}

/** A key for a repo with no usable remote. Deliberately bound to the machine
 *  so it can NEVER collide with another laptop's copy — silence beats a wrong
 *  match (spec §3.3). The path is hashed rather than embedded so the key does
 *  not leak a user's directory layout onto a shared surface. */
export function localRepoKey(hostname: string, repoRoot: string): string {
  const digest = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  return `local:${hostname.toLowerCase()}:${digest}`;
}

/** The repo key for a session: the normalized remote when there is one,
 *  otherwise a machine-local key. */
export function repoKeyFor(
  remoteUrl: string | null,
  ctx: { hostname: string; repoRoot: string },
): string {
  const normalized = remoteUrl === null ? null : normalizeRemote(remoteUrl);
  return normalized ?? localRepoKey(ctx.hostname, ctx.repoRoot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd poc/server && npx vitest run test/repoKey.test.ts && npx tsc --noEmit`
Expected: 12 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/repoKey.ts poc/server/test/repoKey.test.ts
git commit -m "feat(server): repo identity normalization (v7a)"
```

---

### Task 2: Put the repo key on the wire

**Files:**
- Modify: `poc/server/src/workspace.ts` (add `repoKey()` to `WorkspaceLike` and `WorkspaceManager`)
- Modify: `poc/server/src/server.ts:80-83` (repo object), `:432` (peek fallback literal)
- Modify: `poc/server/src/project.ts:96-104` (`ProjectMessage`), `:106-128` (`projectSnapshot`)
- Modify: `poc/server/test/server.test.ts:42-52` (`fakeWorkspace`)
- Modify: `poc/client/src/types.ts:61-73` (`ProjectSessionInfo`)
- Test: `poc/server/test/workspace.test.ts`, `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `repoKeyFor` from Task 1.
- Produces: `WorkspaceLike.repoKey(): string`; `ProjectMessage.repo` becomes `{ defaultBranch: string; key: string } | null`; each snapshot session gains `repoKey: string | null`. Tasks 3 and 4 add sibling fields to the same session object.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/workspace.test.ts`:

```ts
describe("WorkspaceManager.repoKey", () => {
  it("normalizes the origin remote when one is configured", () => {
    const dir = makeRepo();
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/api.git"], { cwd: dir });
    const wm = new WorkspaceManager(dir, path.join(dir, ".mpai", "worktrees"));
    expect(wm.repoKey()).toBe("github.com/acme/api");
  });

  it("falls back to a machine-local key when there is no origin", () => {
    const dir = makeRepo();
    const wm = new WorkspaceManager(dir, path.join(dir, ".mpai", "worktrees"));
    // No remote configured — must never produce a key another machine could match.
    expect(wm.repoKey().startsWith("local:")).toBe(true);
  });

  it("is stable across calls", () => {
    const dir = makeRepo();
    const wm = new WorkspaceManager(dir, path.join(dir, ".mpai", "worktrees"));
    expect(wm.repoKey()).toBe(wm.repoKey());
  });
});
```

Append to `poc/server/test/server.test.ts`:

```ts
describe("repo identity on the project snapshot", () => {
  const lastProject = (seen: any[]) => [...seen].reverse().find((m) => m.type === "project");

  it("stamps every session with the repo key", async () => {
    const server = await startServer({
      port: 0,
      runQuery: echoRun,
      workspace: { ...fakeWorkspace(), repoKey: () => "github.com/acme/api" },
    });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);

    const snap = lastProject(seen);
    expect(snap.repo).toEqual({ defaultBranch: "main", key: "github.com/acme/api" });
    expect(snap.sessions.find((s: any) => s.id === "ana").repoKey).toBe("github.com/acme/api");

    ws.close();
  });

  it("reports a null repo key when the server has no workspace", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);

    const snap = lastProject(seen);
    expect(snap.repo).toBeNull();
    expect(snap.sessions.find((s: any) => s.id === "ana").repoKey).toBeNull();

    ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/workspace.test.ts test/server.test.ts`
Expected: FAIL — `wm.repoKey is not a function`, and `repoKey`/`repo.key` undefined on the snapshot.

- [ ] **Step 3: Implement**

In `poc/server/src/workspace.ts`, add imports and the method. At the top:

```ts
import os from "node:os";
import { repoKeyFor } from "./repoKey.js";
```

Add to the `WorkspaceLike` interface (after `defaultBranch(): string;`):

```ts
  /** Stable cross-machine identity for this repo (spec §3.3). */
  repoKey(): string;
```

Add to `WorkspaceManager`, after `defaultBranch()`:

```ts
  /** Stable identity for this repo, shared by every machine that cloned it.
   *  A repo with no `origin` gets a machine-local key that can never match
   *  another laptop's copy — silence beats a wrong match (spec §3.3). */
  repoKey(): string {
    let remote: string | null = null;
    try {
      remote = this.git(["remote", "get-url", "origin"]);
    } catch {
      remote = null;
    }
    return repoKeyFor(remote, { hostname: os.hostname(), repoRoot: this.repoRoot });
  }
```

In `poc/server/src/server.ts`, change the `repo` constant at `:80-83`:

```ts
  const repo = opts.workspace
    ? {
        workspace: opts.workspace,
        defaultBranch: opts.workspace.defaultBranch(),
        // Cached at startup like defaultBranch: a repo's origin changing
        // mid-run is not a case worth re-reading git for on every push.
        key: opts.workspace.repoKey(),
      }
    : null;
```

Then update **both** places that build the repo field. At `:120` (inside `snapshotFor`) and at `:432` (the peek fallback literal), replace `repo && { defaultBranch: repo.defaultBranch }` with:

```ts
repo && { defaultBranch: repo.defaultBranch, key: repo.key }
```

In `poc/server/src/project.ts`, change the `ProjectMessage` interface: add to the session object type, after `pendingGate`:

```ts
    /** Stable cross-machine repo identity (spec §3.3). Null when the server
     *  was launched outside a repo. Every session on a standalone server
     *  carries the SAME key — it is per-session because v7b's hub holds
     *  sessions from many repos at once. */
    repoKey: string | null;
```

and change the `repo` field:

```ts
  repo: { defaultBranch: string; key: string } | null;
```

Then in `projectSnapshot`, widen the `repo` parameter and stamp each session. Change the signature's third parameter to:

```ts
  repo?: { defaultBranch: string; key: string } | null,
```

and add to the object returned inside the `sessions` map, after `pendingGate`:

```ts
      repoKey: repo?.key ?? null,
```

In `poc/server/test/server.test.ts`, update `fakeWorkspace()` so it still satisfies `WorkspaceLike`:

```ts
    defaultBranch: () => "main",
    repoKey: () => "local:test:000000000000",
```

In `poc/client/src/types.ts`, add to `ProjectSessionInfo` after `pendingGate`:

```ts
  /** Stable cross-machine repo identity. Optional so a snapshot from an older
   *  server does not break the client — same posture as pendingGate. */
  repoKey?: string | null;
```

and widen `RepoInfo` at `:112` (consumed by `SessionPicker.tsx:44`) so the client type matches
what the server now sends:

```ts
export type RepoInfo = { defaultBranch: string; key?: string };
```

`key` is optional because `SessionPicker` neither needs nor reads it — this keeps the type
honest without inventing a consumer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit && cd ../client && npx tsc --noEmit`
Expected: **server 322 passed** (305 baseline + 12 from Task 1 + 3 workspace + 2 wire), tsc
clean both. If the count differs, stop and find out why before continuing — a silently skipped
suite has bitten this project before.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/workspace.ts poc/server/src/server.ts poc/server/src/project.ts \
        poc/server/test/workspace.test.ts poc/server/test/server.test.ts \
        poc/client/src/types.ts
git commit -m "feat(server): stamp sessions with a repo key (v7a)"
```

---

### Task 3: Session lifecycle — `close_session`

**Files:**
- Create: `poc/server/src/lifecycle.ts`
- Modify: `poc/server/src/events.ts:46` (add `session_closed`)
- Modify: `poc/server/src/server.ts` (prompt guard + new `close_session` handler), `poc/server/src/project.ts` (`lifecycle` field)
- Test: `poc/server/test/lifecycle.test.ts`, `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `ProjectMessage` session shape from Task 2.
- Produces: `lifecycleOf(events: LoggedEvent[]): "open" | "closed"`; snapshot session gains `lifecycle: "open" | "closed"`; new event `{ type: "session_closed"; userId: string }`; new client→server message `{ type: "close_session" }`. Task 4 reads `lifecycle` in the client.

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/lifecycle.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { lifecycleOf } from "../src/lifecycle.js";
import type { LoggedEvent } from "../src/events.js";

const ev = (e: Partial<LoggedEvent> & { type: string }, seq = 0): LoggedEvent =>
  ({ seq, ts: "2026-07-27T00:00:00.000Z", ...e }) as LoggedEvent;

describe("lifecycleOf", () => {
  test("an empty log is open", () => {
    expect(lifecycleOf([])).toBe("open");
  });

  test("ordinary activity leaves it open", () => {
    expect(lifecycleOf([ev({ type: "user_message", userId: "u1", text: "hi" })])).toBe("open");
  });

  test("a session_closed event closes it", () => {
    expect(lifecycleOf([ev({ type: "session_closed", userId: "u1" })])).toBe("closed");
  });

  test("closing is one-way — later events do not reopen it", () => {
    expect(
      lifecycleOf([
        ev({ type: "session_closed", userId: "u1" }, 0),
        ev({ type: "user_message", userId: "u2", text: "still here" }, 1),
      ]),
    ).toBe("closed");
  });
});
```

Append to `poc/server/test/server.test.ts`:

```ts
describe("session lifecycle", () => {
  const lastProject = (seen: any[]) => [...seen].reverse().find((m) => m.type === "project");

  it("reports open by default and closed after close_session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);
    expect(lastProject(seen).sessions.find((s: any) => s.id === "ana").lifecycle).toBe("open");

    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    expect(lastProject(seen).sessions.find((s: any) => s.id === "ana").lifecycle).toBe("closed");

    ws.close();
  });

  it("attributes the close on the wire so history says who did it", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);

    const closed = seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].event.userId).toBe("u1");

    ws.close();
  });

  it("lets any participant close, not only the driver", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    collect(wsAna, []);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(100);

    // Ben joins second, so Ana holds the wheel and Ben is a passenger.
    const wsBen = await connect(server.port);
    const seenBen: any[] = [];
    collect(wsBen, seenBen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(100);
    wsBen.send(JSON.stringify({ type: "close_session" }));
    await wait(200);

    expect(lastProject(seenBen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("closed");

    wsAna.close();
    wsBen.close();
  });

  it("refuses a prompt to a closed session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    ws.send(JSON.stringify({ type: "prompt", text: "keep going" }));
    await wait(200);

    const errors = seen.filter((m: any) => m.type === "error");
    expect(errors.some((e: any) => /closed/i.test(e.message))).toBe(true);

    ws.close();
  });

  it("refuses a second close rather than appending a duplicate event", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    ws.send(JSON.stringify({ type: "close_session" }));
    await wait(200);

    expect(
      seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed"),
    ).toHaveLength(1);

    ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/lifecycle.test.ts test/server.test.ts`
Expected: FAIL — cannot resolve `../src/lifecycle.js`; `lifecycle` undefined on snapshot sessions.

- [ ] **Step 3: Implement**

Create `poc/server/src/lifecycle.ts`:

```ts
import type { LoggedEvent } from "./events.js";

export type Lifecycle = "open" | "closed";

/** Has someone deliberately ended this session (spec §3.4)?
 *
 *  Distinct from `ended`, which means the agent PROCESS died, and from
 *  `presence`, which means the owning machine is unreachable. Today those
 *  three render identically; splitting them is the point of v7a.
 *
 *  Closing is one-way: reopening would need its own event and its own
 *  decision about what happens to the dead agent process. */
export function lifecycleOf(events: LoggedEvent[]): Lifecycle {
  for (const ev of events) {
    if (ev.type === "session_closed") return "closed";
  }
  return "open";
}
```

In `poc/server/src/events.ts`, the union currently ends:

```ts
  | { type: "invite_revoked"; userId: string; inviteId: string }
  | { type: "invite_redeemed"; userId: string; inviteId: string };
```

Replace those two lines with three, moving the terminating semicolon to the new last arm:

```ts
  | { type: "invite_revoked"; userId: string; inviteId: string }
  | { type: "invite_redeemed"; userId: string; inviteId: string }
  | { type: "session_closed"; userId: string };
```

In `poc/server/src/project.ts`, import it:

```ts
import { lifecycleOf, type Lifecycle } from "./lifecycle.js";
```

Add to the `ProjectMessage` session object type, after `repoKey`:

```ts
    /** Has someone deliberately ended this session (spec §3.4)? Orthogonal to
     *  `ended`, which is about the agent process. */
    lifecycle: Lifecycle;
```

and inside `projectSnapshot`'s session map, after `repoKey`:

```ts
      lifecycle: lifecycleOf(events),
```

In `poc/server/src/server.ts`, import at the top:

```ts
import { lifecycleOf } from "./lifecycle.js";
```

Add the guard as the **first** statement inside the `prompt` handler at `:524`, before the existing `typeof msg.text` check:

```ts
        if (lifecycleOf(ctx.entry.session.eventsFrom(0)) === "closed") {
          return sendError("this session has been closed");
        }
```

Add a new handler immediately after the `take_wheel` handler (which ends at `:553`):

```ts
      if (msg.type === "close_session") {
        // Any participant may close, attributed on the wire — session scope,
        // matching the standing no-owner-role precedent and the task_stop /
        // oversight_pull posture of attributing rather than restricting
        // (spec §3.4). Hub-wide close by the host is v7b.
        if (lifecycleOf(ctx.entry.session.eventsFrom(0)) === "closed") {
          return sendError("session already closed");
        }
        ctx.entry.session.append({ type: "session_closed", userId: ctx.userId });
        schedulePush(ctx.project);
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: **server 331 passed** (322 after Task 2 + 4 pure + 5 wire), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/lifecycle.ts poc/server/src/events.ts poc/server/src/project.ts \
        poc/server/src/server.ts poc/server/test/lifecycle.test.ts poc/server/test/server.test.ts
git commit -m "feat(server): session close as a lifecycle fact (v7a)"
```

---

### Task 4: `presence` on the wire, and the client renders all three facts

**Files:**
- Modify: `poc/server/src/project.ts` (`presence` field)
- Create: `poc/client/src/sessionState.ts`
- Test: `poc/client/src/sessionState.test.ts`
- Modify: `poc/client/src/types.ts` (`presence`, `lifecycle`), `poc/client/src/components/PartyPane.tsx:93-98`, `poc/client/src/terminal.css`
- Test: `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `repoKey` (Task 2), `lifecycle` (Task 3).
- Produces: snapshot session gains `presence: "online" | "offline"`; client exports `sessionStateLabel` and `sessionStateClass`.

- [ ] **Step 1: Write the failing tests**

Create `poc/client/src/sessionState.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { sessionStateLabel, sessionStateClass } from "./sessionState";

const base = { presence: "online" as const, lifecycle: "open" as const, ended: false };

describe("sessionStateLabel", () => {
  test("a healthy live session has no label", () => {
    expect(sessionStateLabel(base)).toBeNull();
  });

  test("a dead agent on a reachable machine says so", () => {
    expect(sessionStateLabel({ ...base, ended: true })).toBe("agent stopped");
  });

  test("an unreachable machine outranks the agent state, which we cannot know", () => {
    // The last `ended` we heard is stale the moment the machine goes away —
    // reporting it as fact would be a claim we cannot support.
    expect(sessionStateLabel({ ...base, presence: "offline", ended: false })).toBe("offline");
    expect(sessionStateLabel({ ...base, presence: "offline", ended: true })).toBe("offline");
  });

  test("a deliberate close outranks everything", () => {
    expect(sessionStateLabel({ presence: "offline", lifecycle: "closed", ended: true })).toBe("closed");
  });

  test("treats a snapshot from an older server as online and open", () => {
    expect(sessionStateLabel({ ended: false })).toBeNull();
    expect(sessionStateLabel({ ended: true })).toBe("agent stopped");
  });
});

describe("sessionStateClass", () => {
  test("returns an empty string for a healthy session so no class is added", () => {
    expect(sessionStateClass(base)).toBe("");
  });

  test("names each degraded state distinctly", () => {
    expect(sessionStateClass({ ...base, ended: true })).toBe("ended");
    expect(sessionStateClass({ ...base, presence: "offline" })).toBe("offline");
    expect(sessionStateClass({ ...base, lifecycle: "closed" })).toBe("closed");
  });
});
```

Append to `poc/server/test/server.test.ts`, inside the existing `describe("session lifecycle", ...)` block:

```ts
  it("reports presence online on a standalone server, which owns every session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const ws = await connect(server.port);
    const seen: any[] = [];
    collect(ws, seen);
    ws.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "ana", userId: "u1", name: "Ana" }));
    await wait(200);

    expect(lastProject(seen).sessions.find((s: any) => s.id === "ana").presence).toBe("online");

    ws.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npx vitest run src/sessionState.test.ts` — FAIL, module not found.
Run: `cd poc/server && npx vitest run test/server.test.ts` — FAIL, `presence` undefined.

- [ ] **Step 3: Implement**

In `poc/server/src/project.ts`, add to the `ProjectMessage` session object type after `lifecycle`:

```ts
    /** Is the machine that owns this session reachable (spec §3.4)? Always
     *  "online" on a standalone server, which owns every session it reports.
     *  v7b derives it from the hub uplink and it becomes a real signal — the
     *  field exists now so the client learns the shape before the hub does. */
    presence: "online" | "offline";
```

and inside `projectSnapshot`'s session map, after `lifecycle`:

```ts
      presence: "online" as const,
```

Create `poc/client/src/sessionState.ts`:

```ts
export type SessionPresence = "online" | "offline";
export type SessionLifecycle = "open" | "closed";

/** The three orthogonal facts of spec §3.4. `presence` and `lifecycle` are
 *  optional so a snapshot from an older server degrades to today's behaviour
 *  rather than rendering blank — same posture as `pendingGate`. */
export interface SessionStateFacts {
  presence?: SessionPresence;
  lifecycle?: SessionLifecycle;
  ended: boolean;
}

/** Precedence is load-bearing, not cosmetic.
 *
 *  `closed` wins because it is a deliberate human act — it stays true whatever
 *  the machine is doing. `offline` then outranks `ended` because once the
 *  owning machine is unreachable, the last `ended` we heard is stale: showing
 *  it would state as fact something we can no longer observe. Today all three
 *  render as "ended", which is exactly the conflation v7a removes. */
export function sessionStateLabel(s: SessionStateFacts): string | null {
  if (s.lifecycle === "closed") return "closed";
  if (s.presence === "offline") return "offline";
  if (s.ended) return "agent stopped";
  return null;
}

/** CSS modifier for the party row. Empty string means "add no class". */
export function sessionStateClass(s: SessionStateFacts): string {
  if (s.lifecycle === "closed") return "closed";
  if (s.presence === "offline") return "offline";
  if (s.ended) return "ended";
  return "";
}
```

In `poc/client/src/types.ts`, add to `ProjectSessionInfo` after `repoKey`:

```ts
  /** Spec §3.4. Optional so an older server's snapshot still renders. */
  presence?: "online" | "offline";
  lifecycle?: "open" | "closed";
```

In `poc/client/src/components/PartyPane.tsx`, add the import beside the existing ones:

```tsx
import { sessionStateLabel, sessionStateClass } from "../sessionState";
```

Three edits inside the `others.map(...)` callback.

**(a)** Directly after the existing `const pull = pullBySession.get(s.id);`, add:

```tsx
        const stateClass = sessionStateClass(s);
        const stateLabel = sessionStateLabel(s);
```

**(b)** Replace the `className` line at `:93`, which currently reads:

```tsx
            className={(s.ended ? "member ended" : "member") + (pull ? " pull" : "")}
```

with:

```tsx
            className={["member", stateClass, pull ? "pull" : ""].filter(Boolean).join(" ")}
```

`filter(Boolean)` is what keeps a healthy session's class list as exactly `"member"` — both
helpers return `""` for the healthy case, and joining without filtering would emit stray
spaces.

**(c)** Replace the `ended` span at `:98`, which currently reads:

```tsx
              {s.ended && <span className="here"> · ended</span>}
```

with:

```tsx
              {stateLabel && <span className="here"> · {stateLabel}</span>}
```

In `poc/client/src/terminal.css`, replace the two `.member.ended` rules at `:379-380`:

```css
.member.ended { opacity: 0.75; border-style: dashed; }
.member.ended:hover { opacity: 1; }
```

with rules covering all three degraded states:

```css
/* Three orthogonal degraded states (spec §3.4) — deliberately distinguishable:
   `ended` is a dead agent on a reachable machine, `offline` is a machine we
   cannot see, `closed` is a human ending it on purpose. */
.member.ended,
.member.offline,
.member.closed { opacity: 0.75; border-style: dashed; }
.member.ended:hover,
.member.offline:hover,
.member.closed:hover { opacity: 1; }
.member.offline { border-style: dotted; }
.member.closed { opacity: 0.55; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/client && npx vitest run && npx tsc --noEmit && npm run build`
Expected: **client 167 passed** (160 baseline + 7), tsc clean, build clean.
Run: `cd ../server && npx vitest run && npx tsc --noEmit`
Expected: **server 332 passed** (322 after Task 2 + 9 from Task 3 + 1 here), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add poc/server/src/project.ts poc/server/test/server.test.ts \
        poc/client/src/sessionState.ts poc/client/src/sessionState.test.ts \
        poc/client/src/types.ts poc/client/src/components/PartyPane.tsx \
        poc/client/src/terminal.css
git commit -m "feat(client): render presence, lifecycle and agent state separately (v7a)"
```

---

## Verification before calling v7a done

Run the full gates, then drive the real UI once. The arcade lesson in
`docs/mistakes-and-fixes.md:9-14` is that pure tests plus a clean build cannot catch a
rendering bug — and `PartyPane.tsx` has no component tests.

```bash
cd poc/server && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc --noEmit && npx vitest run && npm run build
```

Then, with two browser tabs on one session (`§6` of HANDOFF.md has the stack recipe):

1. Confirm an ordinary session shows **no** state suffix on its OTHER PARTIES row.
2. Send `close_session` from the passenger tab; confirm the row reads `· closed`, and that
   prompting that session returns the "this session has been closed" error rather than
   silently doing nothing.
3. Confirm the repo key appears on the snapshot (`repo.key` in the `project` message) and is
   the same for every session — on a standalone server that is correct, not a bug.

## Deviations

Record every divergence from this plan here as you go, with the reason. This section is part
of the deliverable — later sessions read it to understand why the shipped code differs from
the listings above.
