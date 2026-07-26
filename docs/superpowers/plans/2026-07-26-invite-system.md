# Invite System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shareable, revocable, session-scoped invite links — mint one from inside a session, send `?invite=<token>`, and the recipient lands on a screen naming the inviter before joining, with an opt-in server mode where occupied sessions can't be joined without one.

**Architecture:** A self-contained `InviteStore` (`poc/server/src/invites.ts`) owns mint/peek/redeem/list/revoke with an injected clock and lazy pruning — no timers, no I/O. `server.ts` wires it into one new pre-join command (`peek_invite`), three post-join commands (`create_invite`, `list_invites`, `revoke_invite`), and an invite gate inside `join` that runs before any worktree provisioning. Tokens reach clients only via a direct `invite_list` reply, never the replayed session log. The client gets a pure `inviteLink.ts` helper, an `InviteLanding` screen ahead of the Lobby, and an `INVITE` screen on hotkey I.

**Tech Stack:** Node 22 / TypeScript server (`ws`, `node:crypto` — no new deps), React 18 client, Vitest both sides, plain CSS (`terminal.css`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-invite-system-design.md`. Deviations get recorded in this plan's Deviations section at the end.
- Branch: `feature/invite-system`, stacked on `feature/oversight-agent`. **Never merge without the user.**
- **The token never enters the session log.** `invite_created` / `invite_revoked` / `invite_redeemed` carry `inviteId` only. The only message carrying `token` is `invite_list`, sent directly to the requesting socket.
- **Invites are off-by-default as a gate:** `requireInvite` defaults to `false`, so every existing URL, test, and demo keeps working unchanged.
- The invite gate in `join` runs **before** `getOrCreateProject`/`getOrCreateSession` so a rejected join never provisions a git worktree.
- Error strings from spec §6 are exact: `"peek_invite requires a token"`, `"invite not found"`, `"invite expired"`, `"invite revoked"`, `"invite is full"`, `"this session requires an invite"`, `"revoke_invite requires an inviteId"`, `"unknown invite: <id>"`.
- Uses are counted by **distinct `userId`** — a user already holding a seat may always rejoin.
- Tokens come from `randomBytes(24).toString("base64url")` (32 chars); public ids from a **separate** `randomBytes(6).toString("base64url")` (8 chars). Never derive the id from the token. Never log a token.
- Server commands run from `poc/server/`: `npx vitest run <file>`, full `npx vitest run`, `npx tsc --noEmit`. Client from `poc/client/`: `npm test`, `npm run build`.
- Baselines going in: **server 187 passing, client 76 passing**, both builds clean.
- Commit trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- `git add` explicit paths only — never `git add .` / `-A` (untracked user files sit at the repo root).

## File Structure

| File | Responsibility |
|---|---|
| `poc/server/src/invites.ts` (new) | `InviteStore` — the whole invite lifecycle. No I/O, no timers, injected clock. |
| `poc/server/test/invites.test.ts` (new) | Unit tests for the store against a fake clock. |
| `poc/server/src/events.ts` (modify) | Three new attributed `SessionEvent` arms. |
| `poc/server/src/server.ts` (modify) | Options, store construction, `peek_invite`, join gate, three post-join commands. |
| `poc/server/test/server.test.ts` (modify) | Wire-level invite tests. |
| `poc/client/src/inviteLink.ts` (new) | Pure helpers: build link, parse `?invite=`, format expiry/seats. |
| `poc/client/src/inviteLink.test.ts` (new) | Tests for the above. |
| `poc/client/src/types.ts` (modify) | `InviteView` type, new `LoggedEvent` fields. |
| `poc/client/src/useSessionSocket.ts` (modify) | Carry the token into `join`; hold `invites` state from `invite_list`. |
| `poc/client/src/components/InviteLanding.tsx` (new) | Pre-join landing screen for `?invite=`. |
| `poc/client/src/components/InvitePanel.tsx` (new) | In-session INVITE screen. |
| `poc/client/src/App.tsx` (modify) | Landing branch, hotkey I, screen branch, Header props. |
| `poc/client/src/components/Header.tsx` (modify) | INVITE button. |
| `poc/client/src/components/Transcript.tsx` (modify) | Three new event lines. |
| `poc/client/src/terminal.css` (modify) | `inv*` rules. |

---

### Task 1: InviteStore module

**Files:**
- Create: `poc/server/src/invites.ts`
- Test: `poc/server/test/invites.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `InviteStore` class with `mint(args) → Invite`, `peek(token) → {ok:true,invite} | {ok:false,error}`, `redeem(token, userId, sessionId) → {ok:true,invite} | {ok:false,error}`, `listFor(sessionId) → InviteView[]`, `revoke(id, sessionId) → boolean`. Types `Invite`, `InviteView`, `InviteFailure`. Constants `DEFAULT_INVITE_TTL_MS`, `DEFAULT_INVITE_MAX_USES`.

- [ ] **Step 1: Write the failing tests**

Create `poc/server/test/invites.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_INVITE_MAX_USES, InviteStore } from "../src/invites.js";

const mintArgs = {
  projectId: "default",
  sessionId: "alpha",
  createdBy: "u1",
  createdByName: "ana",
};

describe("InviteStore", () => {
  it("mints a 32-char token and a distinct 8-char id", () => {
    const store = new InviteStore();
    const a = store.mint(mintArgs);
    const b = store.mint(mintArgs);
    expect(a.token).toHaveLength(32);
    expect(a.id).toHaveLength(8);
    expect(a.token).not.toBe(a.id);
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });

  it("peeks a live invite without consuming a seat", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    const res = store.peek(inv.token);
    expect(res).toMatchObject({ ok: true });
    expect(store.listFor("alpha")[0].uses).toBe(0);
  });

  it("rejects unknown, non-string, and wrong-length tokens as not found", () => {
    const store = new InviteStore();
    expect(store.peek("x".repeat(32))).toEqual({ ok: false, error: "invite not found" });
    expect(store.peek("short")).toEqual({ ok: false, error: "invite not found" });
    expect(store.peek(undefined)).toEqual({ ok: false, error: "invite not found" });
  });

  it("reports expiry at the boundary", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const inv = store.mint(mintArgs);
    now = 1_099;
    expect(store.peek(inv.token)).toMatchObject({ ok: true });
    now = 1_100;
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite expired" });
  });

  it("reports revocation and only for the owning session", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    expect(store.revoke(inv.id, "other")).toBe(false);
    expect(store.revoke(inv.id, "alpha")).toBe(true);
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite revoked" });
  });

  it("counts seats by distinct user and rejects when full", () => {
    const store = new InviteStore({ maxUses: 2 });
    const inv = store.mint(mintArgs);
    expect(store.redeem(inv.token, "u2", "alpha")).toMatchObject({ ok: true });
    expect(store.redeem(inv.token, "u2", "alpha")).toMatchObject({ ok: true });
    expect(store.listFor("alpha")[0].uses).toBe(1);
    expect(store.redeem(inv.token, "u3", "alpha")).toMatchObject({ ok: true });
    expect(store.redeem(inv.token, "u4", "alpha")).toEqual({ ok: false, error: "invite is full" });
    expect(store.redeem(inv.token, "u2", "alpha")).toMatchObject({ ok: true });
  });

  it("refuses to redeem an invite against a different session", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    expect(store.redeem(inv.token, "u2", "beta")).toEqual({ ok: false, error: "invite not found" });
  });

  it("lists only live invites for the session, soonest expiry first", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const first = store.mint(mintArgs);
    now = 1_050;
    const second = store.mint(mintArgs);
    const other = store.mint({ ...mintArgs, sessionId: "beta" });
    const list = store.listFor("alpha");
    expect(list.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(list.map((i) => i.token)).toContain(first.token);
    expect(list.some((i) => i.id === other.id)).toBe(false);
    store.revoke(first.id, "alpha");
    expect(store.listFor("alpha").map((i) => i.id)).toEqual([second.id]);
  });

  it("prunes only well after expiry, so the reason stays reportable", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const inv = store.mint(mintArgs);
    now = 1_200;
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite expired" });
    now = 1_100 + 60 * 60 * 1000 + 1;
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite not found" });
  });

  it("defaults to a 10-seat cap", () => {
    const store = new InviteStore();
    expect(store.mint(mintArgs).maxUses).toBe(DEFAULT_INVITE_MAX_USES);
    expect(DEFAULT_INVITE_MAX_USES).toBe(10);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd poc/server && npx vitest run test/invites.test.ts`
Expected: FAIL — `Failed to resolve import "../src/invites.js"`.

- [ ] **Step 3: Write the implementation**

Create `poc/server/src/invites.ts`:

```ts
import { randomBytes } from "node:crypto";

/** A session-scoped join capability. In-memory only: invites die with the
 *  process, like every other piece of server state in this POC. */
export interface Invite {
  /** Public, safe for the wire and the transcript. */
  id: string;
  /** Secret. Only ever leaves the server in an `invite_list` reply to the
   *  socket that asked — never in the replayed session log. */
  token: string;
  projectId: string;
  sessionId: string;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  /** Distinct userIds. A reload mints a fresh sessionStorage identity, so
   *  counting raw joins would burn seats on the same human. */
  redeemedBy: Set<string>;
  revoked: boolean;
}

/** What a participant sees. Carries the token, which is why this shape only
 *  ever goes to the requesting socket. */
export interface InviteView {
  id: string;
  token: string;
  sessionId: string;
  createdByName: string;
  expiresAt: number;
  uses: number;
  maxUses: number;
}

export type InviteFailure =
  | "invite not found"
  | "invite expired"
  | "invite revoked"
  | "invite is full";

export type InviteResult =
  | { ok: true; invite: Invite }
  | { ok: false; error: InviteFailure };

export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INVITE_MAX_USES = 10;

/** base64url of 24 bytes is always exactly 32 chars. Anything else is
 *  rejected before it reaches the map. */
const TOKEN_LEN = 32;
/** Dead invites linger this long past expiry so failures can still say *why*
 *  rather than collapsing to "not found". */
const PRUNE_GRACE_MS = 60 * 60 * 1000;

export class InviteStore {
  private byToken = new Map<string, Invite>();

  constructor(
    private opts: { ttlMs?: number; maxUses?: number; now?: () => number } = {},
  ) {}

  mint(args: {
    projectId: string;
    sessionId: string;
    createdBy: string;
    createdByName: string;
  }): Invite {
    this.prune();
    const now = this.now();
    const invite: Invite = {
      // Separate draws: a public id must never be derived from a secret.
      id: randomBytes(6).toString("base64url"),
      token: randomBytes(24).toString("base64url"),
      projectId: args.projectId,
      sessionId: args.sessionId,
      createdBy: args.createdBy,
      createdByName: args.createdByName,
      createdAt: now,
      expiresAt: now + (this.opts.ttlMs ?? DEFAULT_INVITE_TTL_MS),
      maxUses: this.opts.maxUses ?? DEFAULT_INVITE_MAX_USES,
      redeemedBy: new Set(),
      revoked: false,
    };
    this.byToken.set(invite.token, invite);
    return invite;
  }

  /** Non-consuming preview. */
  peek(token: unknown): InviteResult {
    this.prune();
    const invite = this.lookup(token);
    const failure = this.classify(invite);
    return failure ? { ok: false, error: failure } : { ok: true, invite: invite! };
  }

  /** Consuming check. Takes a seat unless this user already holds one. */
  redeem(token: unknown, userId: string, sessionId: string): InviteResult {
    this.prune();
    const invite = this.lookup(token);
    const failure = this.classify(invite, userId);
    if (failure) return { ok: false, error: failure };
    // A token that exists but belongs elsewhere reports "not found" rather
    // than confirming it is real for some other session.
    if (invite!.sessionId !== sessionId) return { ok: false, error: "invite not found" };
    invite!.redeemedBy.add(userId);
    return { ok: true, invite: invite! };
  }

  listFor(sessionId: string): InviteView[] {
    this.prune();
    const live: InviteView[] = [];
    for (const invite of this.byToken.values()) {
      if (invite.sessionId !== sessionId) continue;
      if (this.classify(invite)) continue;
      live.push({
        id: invite.id,
        token: invite.token,
        sessionId: invite.sessionId,
        createdByName: invite.createdByName,
        expiresAt: invite.expiresAt,
        uses: invite.redeemedBy.size,
        maxUses: invite.maxUses,
      });
    }
    live.sort((a, b) => a.expiresAt - b.expiresAt);
    return live;
  }

  revoke(id: string, sessionId: string): boolean {
    this.prune();
    for (const invite of this.byToken.values()) {
      if (invite.id === id && invite.sessionId === sessionId) {
        invite.revoked = true;
        return true;
      }
    }
    return false;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private lookup(token: unknown): Invite | undefined {
    if (typeof token !== "string" || token.length !== TOKEN_LEN) return undefined;
    return this.byToken.get(token);
  }

  /** Revoked is checked before expired: a human action is the more useful
   *  explanation when both are true. */
  private classify(invite: Invite | undefined, userId?: string): InviteFailure | null {
    if (!invite) return "invite not found";
    if (invite.revoked) return "invite revoked";
    if (invite.expiresAt <= this.now()) return "invite expired";
    if (userId !== undefined && invite.redeemedBy.has(userId)) return null;
    if (invite.redeemedBy.size >= invite.maxUses) return "invite is full";
    return null;
  }

  /** Called from every public entry point, so the store needs no sweep timer
   *  — and therefore has no teardown path to get wrong. */
  private prune(): void {
    const cutoff = this.now() - PRUNE_GRACE_MS;
    for (const [token, invite] of this.byToken) {
      if (invite.expiresAt <= cutoff) this.byToken.delete(token);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd poc/server && npx vitest run test/invites.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Full suite + typecheck**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 197 passing (187 + 10), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add poc/server/src/invites.ts poc/server/test/invites.test.ts
git commit -m "feat(server): InviteStore — session-scoped join capabilities with lazy pruning"
```

---

### Task 2: Wire events + peek_invite + the join gate

**Files:**
- Modify: `poc/server/src/events.ts:43` (append after the `oversight_pull` arm)
- Modify: `poc/server/src/server.ts:60-68` (options), `:76-78` (store construction), `:242-289` (join), `:291-305` (beside `peek`)
- Test: `poc/server/test/server.test.ts`

**Interfaces:**
- Consumes: `InviteStore`, `InviteFailure` from Task 1.
- Produces: wire commands `peek_invite`, reply `invite_info`; `join` accepts optional `invite`; server options `requireInvite`, `inviteTtlMs`, `inviteMaxUses`; events `invite_created`, `invite_revoked`, `invite_redeemed`.

- [ ] **Step 1: Add the event arms**

In `poc/server/src/events.ts`, replace the final union line (currently ending `oversight_pull`) so it reads:

```ts
  | { type: "oversight_pull"; userId: string; summarySeq: number }
  | { type: "invite_created"; userId: string; inviteId: string; expiresAt: number; maxUses: number }
  | { type: "invite_revoked"; userId: string; inviteId: string }
  | { type: "invite_redeemed"; userId: string; inviteId: string };
```

Note the semicolon moves to the last arm.

- [ ] **Step 2: Write the failing tests**

Append to `poc/server/test/server.test.ts` (inside the top-level `describe`, following the existing oversight tests). These use the file's existing `connect`, `collect`, `wait`, `echoRun`, and `fakeWorkspace` helpers:

```ts
  it("mints an invite, keeps the token off the wire, and previews it", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await connect(server.port);
    const sinkA: any[] = [];
    collect(a, sinkA);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    a.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);

    const list = sinkA.find((m) => m.type === "invite_list");
    expect(list.invites).toHaveLength(1);
    const token = list.invites[0].token;
    expect(token).toHaveLength(32);

    const created = sinkA.find((m) => m.event?.type === "invite_created")?.event;
    expect(created).toMatchObject({ userId: "u1", inviteId: list.invites[0].id, maxUses: 10 });
    expect(JSON.stringify(created)).not.toContain(token);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "peek_invite", token }));
    await wait(30);
    expect(sinkB.find((m) => m.type === "invite_info")).toMatchObject({
      projectId: "default",
      sessionId: "alpha",
      inviterName: "ana",
      remaining: 10,
    });
    a.close();
    b.close();
  });

  it("rejects a missing token and an unknown token with the exact strings", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const ws = await connect(server.port);
    const sink: any[] = [];
    collect(ws, sink);
    ws.send(JSON.stringify({ type: "peek_invite" }));
    ws.send(JSON.stringify({ type: "peek_invite", token: "x".repeat(32) }));
    await wait(30);
    const errors = sink.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toContain("peek_invite requires a token");
    expect(errors).toContain("invite not found");
    ws.close();
  });

  it("attributes a redeemed invite on the wire and counts one seat per user", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await connect(server.port);
    const sinkA: any[] = [];
    collect(a, sinkA);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    a.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);
    const invite = sinkA.find((m) => m.type === "invite_list").invites[0];

    const b = await connect(server.port);
    b.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u2", name: "bob", invite: invite.token }));
    await wait(30);
    const redeemed = sinkA.find((m) => m.event?.type === "invite_redeemed")?.event;
    expect(redeemed).toMatchObject({ userId: "u2", inviteId: invite.id });

    a.send(JSON.stringify({ type: "list_invites" }));
    await wait(30);
    const lists = sinkA.filter((m) => m.type === "invite_list");
    expect(lists[lists.length - 1].invites[0].uses).toBe(1);
    a.close();
    b.close();
  });

  it("revokes an invite and reports the exact reason afterwards", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;
    const a = await connect(server.port);
    const sinkA: any[] = [];
    collect(a, sinkA);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);
    a.send(JSON.stringify({ type: "create_invite" }));
    await wait(30);
    const invite = sinkA.find((m) => m.type === "invite_list").invites[0];

    a.send(JSON.stringify({ type: "revoke_invite" }));
    a.send(JSON.stringify({ type: "revoke_invite", inviteId: "nope1234" }));
    a.send(JSON.stringify({ type: "revoke_invite", inviteId: invite.id }));
    await wait(30);
    const errors = sinkA.filter((m) => m.type === "error").map((m) => m.message);
    expect(errors).toContain("revoke_invite requires an inviteId");
    expect(errors).toContain("unknown invite: nope1234");
    expect(sinkA.find((m) => m.event?.type === "invite_revoked")?.event).toMatchObject({
      userId: "u1",
      inviteId: invite.id,
    });
    const lists = sinkA.filter((m) => m.type === "invite_list");
    expect(lists[lists.length - 1].invites).toHaveLength(0);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "peek_invite", token: invite.token }));
    await wait(30);
    expect(sinkB.find((m) => m.type === "error")?.message).toBe("invite revoked");
    a.close();
    b.close();
  });

  it("requireInvite blocks an uninvited join of an occupied session without provisioning", async () => {
    const workspace = fakeWorkspace();
    const server = await startServer({ port: 0, runQuery: echoRun, workspace, requireInvite: true });
    close = server.close;
    const a = await connect(server.port);
    a.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u1", name: "ana" }));
    await wait(30);

    const b = await connect(server.port);
    const sinkB: any[] = [];
    collect(b, sinkB);
    b.send(JSON.stringify({ type: "join", sessionId: "alpha", userId: "u2", name: "bob" }));
    await wait(30);
    expect(sinkB.find((m) => m.type === "error")?.message).toBe("this session requires an invite");
    expect(sinkB.some((m) => m.type === "project")).toBe(false);

    const c = await connect(server.port);
    const sinkC: any[] = [];
    collect(c, sinkC);
    c.send(JSON.stringify({ type: "join", sessionId: "bravo", userId: "u3", name: "cal" }));
    await wait(30);
    expect(sinkC.some((m) => m.type === "error")).toBe(false);
    expect(sinkC.some((m) => m.type === "project")).toBe(true);
    a.close();
    b.close();
    c.close();
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: FAIL — `invite_list` undefined, `unknown message type` errors.

- [ ] **Step 4: Extend the server options and construct the store**

In `poc/server/src/server.ts`, add the import beside the other src imports:

```ts
import { InviteStore } from "./invites.js";
```

Extend the `startServer` options object (currently ending `oversightDebounceMs?: number;`) with:

```ts
  requireInvite?: boolean;
  inviteTtlMs?: number;
  inviteMaxUses?: number;
```

After the `pushTimers` declaration, add:

```ts
  const invites = new InviteStore({
    ttlMs: opts.inviteTtlMs,
    maxUses: opts.inviteMaxUses,
  });
```

- [ ] **Step 5: Add the invite gate to `join`**

In the `join` handler, immediately after the SLUG validation block and **before** `const project = getOrCreateProject(projectId);`, insert:

```ts
        // Invite gate (spec §4). Sits before getOrCreateProject/Session so a
        // rejected join never provisions a git worktree.
        let redeemedId: string | null = null;
        if (typeof msg.invite === "string" && msg.invite) {
          const result = invites.redeem(msg.invite, msg.userId, msg.sessionId);
          if (!result.ok) return sendError(result.error);
          redeemedId = result.invite.id;
        } else if (opts.requireInvite) {
          // The founder slot stays open: an empty room can be opened by
          // whoever arrives first (spec §7 states this bound explicitly).
          const occupied = projects.get(projectId)?.sessions.get(msg.sessionId);
          if (occupied && occupied.session.participantList().length > 0) {
            return sendError("this session requires an invite");
          }
        }
```

Then, immediately after the existing `entry.session.join(...)` line and before the snapshot send, insert:

```ts
        if (redeemedId) {
          entry.session.append({
            type: "invite_redeemed",
            userId: msg.userId,
            inviteId: redeemedId,
          });
        }
```

- [ ] **Step 6: Add `peek_invite`**

Immediately after the closing brace of the `peek` handler, add:

```ts
      if (msg.type === "peek_invite") {
        if (typeof msg.token !== "string" || !msg.token) {
          return sendError("peek_invite requires a token");
        }
        const result = invites.peek(msg.token);
        if (!result.ok) return sendError(result.error);
        ws.send(
          JSON.stringify({
            type: "invite_info",
            projectId: result.invite.projectId,
            sessionId: result.invite.sessionId,
            inviterName: result.invite.createdByName,
            expiresAt: result.invite.expiresAt,
            remaining: result.invite.maxUses - result.invite.redeemedBy.size,
          }),
        );
        return;
      }
```

- [ ] **Step 7: Add the three post-join commands**

Below the `ctx` gate (`if (!ctx) return sendError("join a session first");`), immediately after the `pull_oversight` handler, add:

```ts
      // Inviting is team infrastructure, not a driver capability (spec §9.3):
      // any participant may mint, list, or revoke. Every action is attributed.
      if (msg.type === "create_invite") {
        const invite = invites.mint({
          projectId: ctx.project.id,
          sessionId: ctx.entry.session.id,
          createdBy: ctx.userId,
          createdByName: ctx.entry.session.nameOf(ctx.userId) ?? ctx.userId,
        });
        ctx.entry.session.append({
          type: "invite_created",
          userId: ctx.userId,
          inviteId: invite.id,
          expiresAt: invite.expiresAt,
          maxUses: invite.maxUses,
        });
        sendInviteList(ctx);
        return;
      }

      if (msg.type === "list_invites") {
        sendInviteList(ctx);
        return;
      }

      if (msg.type === "revoke_invite") {
        if (typeof msg.inviteId !== "string" || !msg.inviteId) {
          return sendError("revoke_invite requires an inviteId");
        }
        const id = msg.inviteId.slice(0, 40);
        if (!invites.revoke(id, ctx.entry.session.id)) {
          return sendError(`unknown invite: ${id}`);
        }
        ctx.entry.session.append({
          type: "invite_revoked",
          userId: ctx.userId,
          inviteId: id,
        });
        sendInviteList(ctx);
        return;
      }
```

Add the `sendInviteList` helper inside the connection closure, beside `sendError`:

```ts
    // The token rides this reply and nothing else — never the session log,
    // which is replayed to every late joiner and cannot be un-replayed.
    const sendInviteList = (c: ClientContext) =>
      ws.send(
        JSON.stringify({
          type: "invite_list",
          invites: invites.listFor(c.entry.session.id),
        }),
      );
```

- [ ] **Step 8: Add `Session.nameOf`**

`create_invite` needs the inviter's display name. In `poc/server/src/session.ts`, add beside `participantList()`:

```ts
  nameOf(userId: string): string | undefined {
    return this.participants.get(userId);
  }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd poc/server && npx vitest run test/server.test.ts`
Expected: PASS, including the 5 new invite tests.

- [ ] **Step 10: Full suite + typecheck**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: 202 passing (197 + 5), tsc clean.

- [ ] **Step 11: Commit**

```bash
git add poc/server/src/events.ts poc/server/src/server.ts poc/server/src/session.ts poc/server/test/server.test.ts
git commit -m "feat(server): invite wire — peek_invite, join gate, create/list/revoke"
```

---

### Task 3: Client data layer — inviteLink helpers, types, socket carry

**Files:**
- Create: `poc/client/src/inviteLink.ts`, `poc/client/src/inviteLink.test.ts`
- Modify: `poc/client/src/types.ts` (LoggedEvent fields + `InviteView`), `poc/client/src/useSessionSocket.ts:6-20,35-68`

**Interfaces:**
- Consumes: the `invite_list` / `invite_info` message shapes from Task 2.
- Produces: `InviteView` type; `inviteLinkFor(token, origin) → string`, `inviteTokenFrom(search) → string | null`, `seatsLabel(view) → string`, `expiryLabel(expiresAt, now) → string`; `useSessionSocket` returns `invites: InviteView[]` and accepts an `invite?: string` option.

- [ ] **Step 1: Write the failing tests**

Create `poc/client/src/inviteLink.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expiryLabel, inviteLinkFor, inviteTokenFrom, seatsLabel } from "./inviteLink";

describe("inviteTokenFrom", () => {
  it("reads the invite param", () => {
    expect(inviteTokenFrom("?invite=abc123")).toBe("abc123");
    expect(inviteTokenFrom("?session=alpha&invite=abc123")).toBe("abc123");
  });
  it("returns null when absent or empty", () => {
    expect(inviteTokenFrom("")).toBeNull();
    expect(inviteTokenFrom("?session=alpha")).toBeNull();
    expect(inviteTokenFrom("?invite=")).toBeNull();
  });
});

describe("inviteLinkFor", () => {
  it("builds a link carrying only the token", () => {
    expect(inviteLinkFor("tok", "http://localhost:3001")).toBe("http://localhost:3001/?invite=tok");
  });
  it("tolerates a trailing slash on the origin", () => {
    expect(inviteLinkFor("tok", "http://localhost:3001/")).toBe("http://localhost:3001/?invite=tok");
  });
});

describe("seatsLabel", () => {
  it("reports remaining seats", () => {
    expect(seatsLabel({ uses: 0, maxUses: 10 })).toBe("10 SEATS LEFT");
    expect(seatsLabel({ uses: 9, maxUses: 10 })).toBe("1 SEAT LEFT");
    expect(seatsLabel({ uses: 10, maxUses: 10 })).toBe("NO SEATS LEFT");
  });
});

describe("expiryLabel", () => {
  const now = 1_000_000;
  it("reports hours then minutes", () => {
    expect(expiryLabel(now + 5 * 3600_000, now)).toBe("EXPIRES IN 5H");
    expect(expiryLabel(now + 3600_000, now)).toBe("EXPIRES IN 1H");
    expect(expiryLabel(now + 59 * 60_000, now)).toBe("EXPIRES IN 59M");
    expect(expiryLabel(now + 60_000, now)).toBe("EXPIRES IN 1M");
  });
  it("collapses the past and the last minute", () => {
    expect(expiryLabel(now, now)).toBe("EXPIRED");
    expect(expiryLabel(now - 1, now)).toBe("EXPIRED");
    expect(expiryLabel(now + 59_000, now)).toBe("EXPIRES IN <1M");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd poc/client && npm test -- inviteLink`
Expected: FAIL — cannot resolve `./inviteLink`.

- [ ] **Step 3: Write the implementation**

Create `poc/client/src/inviteLink.ts`:

```ts
/** Pure helpers for invite links (no component-test infra in this repo —
 *  recorded pattern, see sessionRow.ts). */

/** The link carries the token and nothing else: the server resolves project
 *  and session from it, so ids never appear in a shared URL. */
export function inviteLinkFor(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/?invite=${encodeURIComponent(token)}`;
}

export function inviteTokenFrom(search: string): string | null {
  const token = new URLSearchParams(search).get("invite");
  return token ? token : null;
}

export function seatsLabel(view: { uses: number; maxUses: number }): string {
  const left = Math.max(0, view.maxUses - view.uses);
  if (left === 0) return "NO SEATS LEFT";
  return `${left} SEAT${left === 1 ? "" : "S"} LEFT`;
}

export function expiryLabel(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "EXPIRED";
  if (ms < 60_000) return "EXPIRES IN <1M";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `EXPIRES IN ${minutes}M`;
  return `EXPIRES IN ${Math.floor(minutes / 60)}H`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd poc/client && npm test -- inviteLink`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the client types**

In `poc/client/src/types.ts`, add to the `LoggedEvent` bag (after `summarySeq?: number;`):

```ts
  inviteId?: string;
  expiresAt?: number;
  maxUses?: number;
```

And after the `LoggedEvent` type, add:

```ts
export type InviteView = {
  id: string;
  token: string;
  sessionId: string;
  createdByName: string;
  expiresAt: number;
  uses: number;
  maxUses: number;
};
```

- [ ] **Step 6: Carry the token and the list through the socket**

In `poc/client/src/useSessionSocket.ts`:

Add `InviteView` to the type import from `./types`.

Add `invite?: string;` to the options object, and `invites: InviteView[];` to the return type.

Destructure it: `const { sessionId, projectId, userId, profile, invite } = opts;`

Add state beside the `oversight` state:

```ts
  const [invites, setInvites] = useState<InviteView[]>([]);
```

In the `ws.onopen` join payload, add after `lastSeq: 0,`:

```ts
          ...(invite ? { invite } : {}),
```

In `ws.onmessage`, beside the other message-type branches, add:

```ts
        if (msg.type === "invite_list") setInvites(msg.invites ?? []);
```

Add `invites` to the returned object, and `invite` to the effect's dependency array alongside `sessionId`/`projectId`/`userId`.

- [ ] **Step 7: Verify the client builds and the suite passes**

Run: `cd poc/client && npm test && npm run build`
Expected: 83 passing (76 + 7), build clean.

- [ ] **Step 8: Commit**

```bash
git add poc/client/src/inviteLink.ts poc/client/src/inviteLink.test.ts poc/client/src/types.ts poc/client/src/useSessionSocket.ts
git commit -m "feat(client): invite link helpers, types, and socket carry"
```

---

### Task 4: InviteLanding screen

**Files:**
- Create: `poc/client/src/components/InviteLanding.tsx`
- Modify: `poc/client/src/App.tsx:26-70`

**Interfaces:**
- Consumes: `inviteTokenFrom`, `expiryLabel` (Task 3); the `invite_info` message (Task 2).
- Produces: `<InviteLanding token onAccept({projectId, sessionId}) />`; App state `inviteToken` threaded into `SessionView`.

- [ ] **Step 1: Write the landing component**

Create `poc/client/src/components/InviteLanding.tsx`:

```tsx
import { useEffect, useState } from "react";
import { SERVER_URL } from "../types";
import { expiryLabel } from "../inviteLink";

type Info = {
  projectId: string;
  sessionId: string;
  inviterName: string;
  expiresAt: number;
  remaining: number;
};

/** Shown when a `?invite=` link is opened, before the lobby. Uses its own
 *  throwaway socket for the preview — same idiom as Lobby's `peek`. */
export function InviteLanding(props: {
  token: string;
  onAccept: (target: { projectId: string; sessionId: string }) => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "peek_invite", token: props.token }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "invite_info") setInfo(m);
        if (m.type === "error") setError(m.message);
      } catch { /* ignore */ }
    };
    ws.onerror = () => setError("could not reach the server");
    return () => ws.close();
  }, [props.token]);

  if (error) {
    return (
      <div className="screen invland">
        <div className="panel">
          <div className="pix lg">INVITE UNAVAILABLE</div>
          <div className="line dim">{error}</div>
          <a className="btn" href="?">◂ BROWSE SESSIONS</a>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="screen invland">
        <div className="panel"><div className="line dim">CHECKING INVITE…</div></div>
      </div>
    );
  }

  return (
    <div className="screen invland">
      <div className="panel">
        <div className="pix lg invhero">{info.inviterName.toUpperCase()} INVITED YOU</div>
        <div className="line">{info.projectId} / {info.sessionId}</div>
        <div className="line dim">
          {expiryLabel(info.expiresAt, Date.now())} · {info.remaining} SEAT
          {info.remaining === 1 ? "" : "S"} LEFT
        </div>
        <button
          className="btn"
          onClick={() => props.onAccept({ projectId: info.projectId, sessionId: info.sessionId })}
        >
          PRESS START
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into App**

In `poc/client/src/App.tsx`:

Add imports:

```tsx
import { InviteLanding } from "./components/InviteLanding";
import { inviteTokenFrom } from "./inviteLink";
```

After the `screen` state declaration, add:

```tsx
  // An invite link carries only the token; the landing screen resolves it to a
  // project/session and hands them back here (spec §5).
  const inviteToken = useMemo(() => inviteTokenFrom(window.location.search), []);
  const [inviteTarget, setInviteTarget] = useState<{ projectId: string; sessionId: string } | null>(null);
```

Replace the top-level render ternary so the invite branch comes first:

```tsx
  const activeSessionId = inviteTarget?.sessionId ?? sessionId;
  const activeProjectId = inviteTarget?.projectId ?? projectId;

  return (
    <Cabinet legend={LEGEND}>
      <Crt>
        {inviteToken && !inviteTarget ? (
          <InviteLanding token={inviteToken} onAccept={setInviteTarget} />
        ) : activeSessionId === null ? (
          <SessionPicker projectId={activeProjectId} />
        ) : profile === null ? (
          <Lobby
            projectId={activeProjectId}
            sessionId={activeSessionId}
            defaultName={`user-${userId.slice(0, 4)}`}
            onEnter={(p) => {
              saveProfile(p);
              setProfile(p);
            }}
          />
        ) : (
          <SessionView
            userId={userId}
            sessionId={activeSessionId}
            projectId={activeProjectId}
            profile={profile}
            screen={screen}
            onScreenChange={setScreen}
            invite={inviteToken ?? undefined}
          />
        )}
      </Crt>
    </Cabinet>
  );
```

Add `invite?: string;` to `SessionView`'s props type, and pass it through to the socket hook: `useSessionSocket({ sessionId, projectId, userId, profile, invite: props.invite })`.

- [ ] **Step 3: Add the landing CSS**

Append to `poc/client/src/terminal.css`:

```css
/* invite landing + panel (spec §5) */
.invland { align-items: center; justify-content: center; display: flex; }
.invland .panel { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; max-width: 520px; }
.invhero { color: var(--gold); }
```

- [ ] **Step 4: Verify build and suite**

Run: `cd poc/client && npm test && npm run build`
Expected: 83 passing, build clean.

- [ ] **Step 5: Commit**

```bash
git add poc/client/src/components/InviteLanding.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): invite landing screen ahead of the lobby"
```

---

### Task 5: INVITE screen, hotkey, header, transcript

**Files:**
- Create: `poc/client/src/components/InvitePanel.tsx`
- Modify: `poc/client/src/App.tsx` (hotkey I, screen branch, header props), `poc/client/src/components/Header.tsx`, `poc/client/src/components/Transcript.tsx`, `poc/client/src/terminal.css`

**Interfaces:**
- Consumes: `InviteView` (Task 3), `inviteLinkFor`/`seatsLabel`/`expiryLabel` (Task 3), the `invites` array from `useSessionSocket` (Task 3).
- Produces: `<InvitePanel invites onCreate onRevoke onBack />`.

- [ ] **Step 1: Write the panel**

Create `poc/client/src/components/InvitePanel.tsx`:

```tsx
import type { InviteView } from "../types";
import { expiryLabel, inviteLinkFor, seatsLabel } from "../inviteLink";

/** In-session invite screen (spec §5). Any participant may mint or revoke —
 *  inviting is team infrastructure, not a driver capability. */
export function InvitePanel(props: {
  invites: InviteView[];
  onCreate: () => void;
  onRevoke: (id: string) => void;
  onBack: () => void;
}) {
  const now = Date.now();
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={props.onBack}>◂ BACK</button>
        <span className="pix lg">INVITE</span>
        <span className="rule" />
        <button className="btn" onClick={props.onCreate}>[ CREATE INVITE ]</button>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          {props.invites.length === 0 ? (
            <div className="line dim">NO ACTIVE INVITES</div>
          ) : (
            props.invites.map((inv) => (
              <div key={inv.id} className="invrow">
                <div className="line">
                  <span className="dim">{inv.id}</span> · from {inv.createdByName}
                </div>
                <input className="invlink" readOnly value={inviteLinkFor(inv.token, window.location.origin)} />
                <div className="line dim">
                  {seatsLabel(inv)} · {expiryLabel(inv.expiresAt, now)}
                </div>
                <button className="btn" onClick={() => props.onRevoke(inv.id)}>[ REVOKE ]</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the screen, hotkey, and header into App**

In `poc/client/src/App.tsx`:

Import: `import { InvitePanel } from "./components/InvitePanel";`

Pull `invites` out of the socket hook's return alongside `oversight`.

In the S/W/O hotkey effect, add an I branch after the O branch:

```tsx
      if ((e.key === "i" || e.key === "I") && !arcadeCapturing) {
        e.preventDefault();
        props.onScreenChange(props.screen === "invite" ? null : "invite");
      }
```

and extend the Escape condition to include `|| props.screen === "invite"`.

Add the screen branch after the `oversight` branch:

```tsx
  if (props.screen === "invite") {
    return (
      <InvitePanel
        invites={invites}
        onCreate={() => send({ type: "create_invite" })}
        onRevoke={(id) => send({ type: "revoke_invite", inviteId: id })}
        onBack={() => props.onScreenChange(null)}
      />
    );
  }
```

The panel needs a list as soon as it opens: add an effect beside the other screen effects:

```tsx
  useEffect(() => {
    if (props.screen === "invite") send({ type: "list_invites" });
  }, [props.screen, send]);
```

Pass the header prop where `onOpenOversight` is passed: `onOpenInvite={() => props.onScreenChange("invite")}`.

- [ ] **Step 3: Add the header button**

In `poc/client/src/components/Header.tsx`, add to the props type beside `onOpenOversight`:

```ts
  onOpenInvite: () => void;
```

And immediately after the OVERSIGHT button, add:

```tsx
        <button
          className="planmode"
          onClick={props.onOpenInvite}
          title="invite a teammate (I)"
        >
          ▢ INVITE
        </button>
```

- [ ] **Step 4: Add the transcript lines**

In `poc/client/src/components/Transcript.tsx`, after the `oversight_pull` case:

```tsx
      case "invite_created":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} created invite {ev.inviteId}
          </div>
        );
      case "invite_revoked":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} revoked invite {ev.inviteId}
          </div>
        );
      case "invite_redeemed":
        return (
          <div key={ev.seq} className="line gold">
            ✦ {nameOf(ev.userId)} joined via invite {ev.inviteId}
          </div>
        );
```

- [ ] **Step 5: Add the panel CSS**

Append to `poc/client/src/terminal.css`:

```css
.invrow { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--frame); }
.invlink { width: 100%; background: #000; color: var(--fg); border: 1px solid var(--frame); font: inherit; padding: 4px 6px; }
```

- [ ] **Step 6: Verify build and suite**

Run: `cd poc/client && npm test && npm run build`
Expected: 83 passing, build clean.

- [ ] **Step 7: Commit**

```bash
git add poc/client/src/components/InvitePanel.tsx poc/client/src/components/Header.tsx poc/client/src/components/Transcript.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): INVITE screen, hotkey I, header button, transcript lines"
```

---

### Task 6: Verification sweep and demo prep

**Files:** none created; read-only against the spec plus full runs, then a demo note.

- [ ] **Step 1: Full suites and builds**

Run: `cd poc/server && npx vitest run && npx tsc --noEmit`
Expected: **202 passing** (187 baseline + 10 store + 5 wire), tsc clean. If the count differs, find out why and record the arithmetic in Deviations.

Run: `cd poc/client && npm test && npm run build`
Expected: **83 passing** (76 + 7), build clean.

- [ ] **Step 2: Spec re-read**

Re-read `docs/superpowers/specs/2026-07-26-invite-system-design.md` §3–§7 against `git diff feature/oversight-agent --stat` and the shipped code. Every locked requirement (token never on the session log; separate id/token draws; distinct-user seat counting; gate before provisioning; `requireInvite` off by default with the founder slot open; exact §6 strings; landing screen before the lobby; hotkey I; any participant may invite) maps to shipped code with file:line, or gets a recorded deviation.

- [ ] **Step 3: Write the demo script**

Create `docs/demos/2026-07-26-invite-and-oversight.md` capturing the combined stacked-branch demo (both features, one run) so it can be replayed without re-deriving it:

- terminal 1: `cd poc/client && npm run build` then `node poc/server/dist/... ` — or, simpler, the dev stack: `cd poc/server && npx tsx watch src/main.ts` and `cd poc/client && npm run dev`
- browser A: `http://localhost:5173/?session=invite-demo&name=ana` → founds the session, takes the wheel
- browser A: press **I** → CREATE INVITE → copy the link
- browser B (private window): paste the link → landing shows "ANA INVITED YOU · default / invite-demo" → PRESS START → lobby → join
- browser A transcript: `✦ bob joined via invite <id>`
- browser A: press **O** → ENABLE oversight → prompt in one session → summary appears, fresh-dot lights in the other
- browser A: press **I** → REVOKE → browser C pasting the same link gets "invite revoked"

- [ ] **Step 4: Commit**

```bash
git add docs/demos/2026-07-26-invite-and-oversight.md docs/superpowers/plans/2026-07-26-invite-system.md
git commit -m "docs: invite demo script and plan deviations"
```

- [ ] **Step 5: Stop**

Stop for the user's review. Push the branch and open a PR **stacked on `feature/oversight-agent`** (base = `feature/oversight-agent`, not `main`). Do not merge either PR.

---

## Deviations (recorded during execution)

_None yet._
