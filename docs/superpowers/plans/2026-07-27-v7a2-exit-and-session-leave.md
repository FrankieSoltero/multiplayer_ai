# v7a2 — Exit and Session Leave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a participant a way to leave a session — `/exit` and an EXIT control — and close a session automatically when its last participant leaves deliberately.

**Architecture:** One new wire command (`leave_session`) whose only reason to exist is letting the server tell a deliberate departure from a dropped connection. Two new pure client modules (`clientCommands.ts`, `pickerUrl.ts`) following the established extract-pure-then-test pattern, plus a fourth state (`empty`) folded into v7a's existing `degradedState()` seam. Ships against today's standalone server; no hub, no relay.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers server-side), vitest, React 18, `ws`.

## Global Constraints

- Spec authority: `docs/superpowers/specs/2026-07-27-exit-and-session-leave-design.md`. Read §2 (decisions) and §3 (architecture) before starting.
- **Server imports use `.js` specifiers** even for `.ts` sources (NodeNext). Client imports do not.
- Server tests live in `poc/server/test/*.test.ts`; client tests are co-located in `poc/client/src/`.
- **There is no client component-test infrastructure.** Client logic is extracted into pure modules and tested there. Do not add a component test framework in this plan.
- **A `<label>` must never wrap a form control** in this codebase (it forwards a second synthesized click and kills `<select>` dropdowns).
- **Only a deliberate `/exit` may auto-close a session. A socket close must never close one.** This is the design's load-bearing rule (spec §2): v7a made closing one-way with no reopen path, so an accidental disconnect closing a session would permanently strand the party's work.
- **`permission` and `decide_plan` remain unguarded on a closed session.** They resolve requests already in flight; guarding them would strand a live agent on a promise nobody can resolve. A test pins this. Do not touch it.
- Baselines before starting: **server 345 tests, client 179 tests**, both `tsc --noEmit` clean, client build clean.
- Do not run `git add -A`. Every commit spells out its paths.
- Never commit `market-research.md`, `poc/demo-plugins/`, or `tour-skill-suggest.png` — permanently-untracked user files.
- **Out of scope, do not build:** server shutdown, a host settings screen, host-initiated close, worktree teardown, agent interruption, a reopen path for closed sessions, any `/` command other than `/exit`. Do not fix anything in `docs/tech-debt.md`.

## File Structure

| File | Responsibility |
|---|---|
| `poc/server/src/session.ts` (modify) | `leave()` becomes idempotent — the source-level fix for the duplicate-event hazard |
| `poc/server/src/events.ts` (modify) | `session_closed` already exists; no new event type is needed |
| `poc/server/src/server.ts` (modify) | The `leave_session` handler and the last-leaver auto-close |
| `poc/client/src/clientCommands.ts` (create) | Parses client-side slash commands. Pure. |
| `poc/client/src/pickerUrl.ts` (create) | Derives the picker URL from the current query string. Pure. |
| `poc/client/src/sessionState.ts` (modify) | Adds the `empty` state to the existing precedence seam |
| `poc/client/src/components/PromptBar.tsx` (modify) | Intercepts a client command before the skill-suggest branch |
| `poc/client/src/components/Header.tsx` (modify) | The EXIT control |
| `poc/client/src/components/ExitConfirm.tsx` (create) | The inline confirm bar |
| `poc/client/src/App.tsx` (modify) | Wires the exit action together |
| `poc/client/src/types.ts` (modify) | `ProjectSessionInfo` already carries `participants`; no change expected — verify only |
| `poc/client/src/terminal.css` (modify) | `.spstate.empty`, `.spstate.offline`, `.exitconfirm` |

---

### Task 1: `Session.leave()` becomes idempotent

**Files:**
- Modify: `poc/server/src/session.ts:75-86`
- Test: `poc/server/test/session.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: nothing.
- Produces: `Session.leave(userId)` appends at most one `presence_leave` per membership. Task 2 depends on this — without it, every deliberate exit writes two `presence_leave` events and fires the auto-close twice.

**Why this is its own task:** the client sends `leave_session` and *then* reloads, so the server sees the command and, moments later, the socket close — and `server.ts:873`'s close handler also calls `session.leave()`. Fixing it in `Session.leave()` covers both callers and any future one.

- [ ] **Step 1: Check whether the test file exists**

```bash
ls poc/server/test/session.test.ts
```

If it exists, append the new `describe` block to it. If it does not, create it with the imports shown in Step 2.

- [ ] **Step 2: Write the failing test**

Create or append to `poc/server/test/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";

describe("Session.leave idempotency", () => {
  it("appends exactly one presence_leave when called twice for the same user", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.leave("u1");
    s.leave("u1");

    const leaves = s.eventsFrom(0).filter((e) => e.type === "presence_leave");
    expect(leaves).toHaveLength(1);
  });

  it("appends nothing when a user who never joined leaves", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    const before = s.eventsFrom(0).length;

    s.leave("someone-else");

    expect(s.eventsFrom(0).length).toBe(before);
  });

  it("still hands the wheel on for a real departure", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.join("u2", "Ben");
    expect(s.driverId).toBe("u1");

    s.leave("u1");

    expect(s.driverId).toBe("u2");
  });

  it("clears the driver when the last participant leaves", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.leave("u1");
    expect(s.driverId).toBeNull();
  });

  it("lets a user rejoin after leaving and leave again", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.leave("u1");
    s.join("u1", "Ana");
    s.leave("u1");

    const leaves = s.eventsFrom(0).filter((e) => e.type === "presence_leave");
    expect(leaves).toHaveLength(2);
  });
});
```

The last test matters: the guard must key off *current membership*, not "has ever left". A rejoin followed by a second leave is a real second departure.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd poc/server && npx vitest run test/session.test.ts
```

Expected: the first two tests FAIL (two `presence_leave` events, and one appended for a non-participant). The last three should already pass.

- [ ] **Step 4: Implement the guard**

In `poc/server/src/session.ts`, replace the `leave` method:

```ts
  /** Idempotent: a user who is not currently a participant produces no event.
   *
   *  Load-bearing, not defensive. A deliberate exit sends `leave_session` and
   *  then reloads the page, so the server sees the command AND the socket
   *  close — and the close handler also calls this. Without the guard every
   *  deliberate exit writes two `presence_leave` events into an append-only
   *  log that is replayed to late joiners, and fires the last-leaver
   *  auto-close twice. Guarding here rather than at the call site covers both
   *  callers and any future one.
   *
   *  Keyed on current membership, not on history: a user who leaves, rejoins
   *  and leaves again has genuinely departed twice. */
  leave(userId: string): void {
    if (!this.participants.has(userId)) return;
    this.participants.delete(userId);
    this.append({ type: "presence_leave", userId });
    if (this.currentDriverId === userId) {
      const nextDriverId = this.participants.keys().next().value;
      if (nextDriverId !== undefined) {
        this.takeWheel(nextDriverId);
      } else {
        this.currentDriverId = null;
      }
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd poc/server && npx vitest run test/session.test.ts
```

Expected: PASS, all five.

- [ ] **Step 6: Run the full server suite and typecheck**

```bash
cd poc/server && npx vitest run && npx tsc --noEmit
```

Expected: 345 baseline + 5 new = **350 passing**, tsc clean. If any pre-existing test fails, it is telling you something relied on the double-append — stop and report it rather than adjusting the test.

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/session.ts poc/server/test/session.test.ts
git commit -m "fix(server): make Session.leave idempotent (v7a2)"
```

---

### Task 2: `leave_session` and the last-leaver auto-close

**Files:**
- Modify: `poc/server/src/server.ts` (new handler beside the `close_session` handler at `:579-593`)
- Test: `poc/server/test/server.test.ts` (append to the existing `describe("session lifecycle", …)` block)

**Interfaces:**
- Consumes: `Session.leave(userId)` from Task 1 (idempotent); `isClosed(entry)` (`server.ts:243-245`); `pushProject(project)`.
- Produces: wire command `{ type: "leave_session" }`. Task 5's client sends it.

**Design rules this task must satisfy (spec §3.1):**
- `leave_session` appends `presence_leave`, then — **only if no participants remain** — appends `session_closed` attributed to the leaver.
- It is **not** lifecycle-guarded. A participant sitting in an already-closed session still needs a way out. If already closed, skip the `session_closed` append rather than adding a second one.
- A plain socket close must **never** close the session, even when it is the last participant.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("session lifecycle", () => { … })` block in `poc/server/test/server.test.ts`:

```ts
  it("removes the sender from the roster on leave_session", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    collect(wsBen, []);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    const row = lastProject(seen).sessions.find((s: any) => s.id === "s");
    expect(row.participants).toEqual(["Ana"]);

    wsAna.close();
    wsBen.close();
  });

  it("does NOT close the session when someone leaves and others remain", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    collect(wsBen, []);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    expect(lastProject(seen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("open");

    wsAna.close();
    wsBen.close();
  });

  it("closes the session when the LAST participant leaves deliberately", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsWatch = await connect(server.port);
    const seen: any[] = [];
    collect(wsWatch, seen);
    wsWatch.send(JSON.stringify({ type: "watch_project", projectId: "demo" }));

    const wsAna = await connect(server.port);
    collect(wsAna, []);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(200);

    wsAna.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    expect(lastProject(seen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("closed");

    wsWatch.close();
    wsAna.close();
  });

  it("attributes the auto-close to the participant who left last", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    wsAna.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    const closed = seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].event.userId).toBe("u1");

    wsAna.close();
  });

  it("a socket close does NOT close the session, even for the last participant", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsWatch = await connect(server.port);
    const seen: any[] = [];
    collect(wsWatch, seen);
    wsWatch.send(JSON.stringify({ type: "watch_project", projectId: "demo" }));

    const wsAna = await connect(server.port);
    collect(wsAna, []);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(200);

    wsAna.close();
    await wait(300);

    // The whole point of leave_session existing: a dropped connection is not
    // a statement of intent, and v7a made closing one-way.
    expect(lastProject(seen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("open");

    wsWatch.close();
  });

  it("writes exactly one presence_leave when leave_session is followed by the socket closing", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsWatch = await connect(server.port);
    collect(wsWatch, []);
    wsWatch.send(JSON.stringify({ type: "watch_project", projectId: "demo" }));

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    await wait(200);
    wsAna.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);
    wsAna.close();
    await wait(300);

    const rejoin = await connect(server.port);
    const replay: any[] = [];
    collect(rejoin, replay);
    rejoin.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(300);

    const leaves = replay.filter(
      (m: any) => m.type === "event" && m.event.type === "presence_leave" && m.event.userId === "u1",
    );
    expect(leaves).toHaveLength(1);

    rejoin.close();
    wsWatch.close();
  });

  it("still lets someone leave an already-closed session, without closing it twice", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsAna = await connect(server.port);
    const seen: any[] = [];
    collect(wsAna, seen);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    collect(wsBen, []);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    wsBen.send(JSON.stringify({ type: "close_session" }));
    await wait(200);
    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);

    const closed = seen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(1);
    const row = lastProject(seen).sessions.find((s: any) => s.id === "s");
    expect(row.participants).toEqual(["Ana"]);
    expect(row.lifecycle).toBe("closed");

    wsAna.close();
    wsBen.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd poc/server && npx vitest run test/server.test.ts -t "session lifecycle"
```

Expected: the `leave_session` tests FAIL with `unknown message type: leave_session`. The socket-close test should already PASS (nothing closes on disconnect today) — that is fine; it is a regression guard.

- [ ] **Step 3: Implement the handler**

In `poc/server/src/server.ts`, immediately **after** the `close_session` handler that ends at `:593`, add:

```ts
      if (msg.type === "leave_session") {
        // Deliberate departure. Deliberately NOT lifecycle-guarded: someone
        // sitting in an already-closed session still needs a way out.
        const departed = ctx.entry.session.leave(ctx.userId);
        // Auto-close only when THIS leave emptied the room. `departed` is
        // load-bearing, not defensive: leave() is idempotent, so a repeat
        // leave_session from someone who already left removes nobody — but
        // the room may have been emptied meanwhile by a SOCKET CLOSE. Keying
        // on emptiness alone would then close a session a disconnect ended,
        // which is the one thing spec §2 forbids (v7a made closing one-way,
        // so there is no way back), and would attribute it to a departure
        // that did not end it.
        //
        // A socket close runs `session.leave` too (see the "close" handler)
        // but never reaches here — that asymmetry IS the feature.
        if (departed && ctx.entry.session.participantList.length === 0 && !isClosed(ctx.entry)) {
          ctx.entry.session.append({ type: "session_closed", userId: ctx.userId });
        }
        // Deliberate user action, not a hot stream — immediate push.
        // `session_closed` is not in the INTERESTING set at all, and
        // `presence_leave` IS but goes through `schedulePush`, which throttles
        // by PROJECT_PUSH_INTERVAL_MS (1000). Without this push a watcher can
        // wait a second to see the roster empty, and would never see the
        // lifecycle flip.
        pushProject(ctx.project);
        return;
      }
```

This requires `Session.leave` to report whether it removed anyone. Change its signature in `poc/server/src/session.ts` — the return is `false` when the guard from Task 1 short-circuits, `true` otherwise:

```ts
  leave(userId: string): boolean {
    if (!this.participants.has(userId)) return false;
    // … body unchanged …
    return true;
  }
```

The other caller (`ws.on("close")`, `server.ts:893`) ignores the value and needs no change.

**Add this test** alongside the seven above — it is the only thing that pins the rule:

```ts
  it("a repeat leave_session does not close a session that a DISCONNECT emptied", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    close = server.close;

    const wsWatch = await connect(server.port);
    const seen: any[] = [];
    collect(wsWatch, seen);
    wsWatch.send(JSON.stringify({ type: "watch_project", projectId: "demo" }));

    const wsAna = await connect(server.port);
    collect(wsAna, []);
    wsAna.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u1", name: "Ana" }));
    const wsBen = await connect(server.port);
    const benSeen: any[] = [];
    collect(wsBen, benSeen);
    wsBen.send(JSON.stringify({ type: "join", projectId: "demo", sessionId: "s", userId: "u2", name: "Ben" }));
    await wait(200);

    wsBen.send(JSON.stringify({ type: "leave_session" }));
    await wait(200);
    wsAna.close(); // a DISCONNECT empties the room — must not close the session
    await wait(300);
    wsBen.send(JSON.stringify({ type: "leave_session" })); // stale repeat
    await wait(300);

    const closed = benSeen.filter((m: any) => m.type === "event" && m.event.type === "session_closed");
    expect(closed).toHaveLength(0);
    expect(lastProject(seen).sessions.find((s: any) => s.id === "s").lifecycle).toBe("open");

    wsBen.close();
    wsWatch.close();
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd poc/server && npx vitest run test/server.test.ts -t "session lifecycle"
```

Expected: PASS.

- [ ] **Step 5: Run the full server suite and typecheck**

```bash
cd poc/server && npx vitest run && npx tsc --noEmit
```

Expected: 350 + 7 = **357 passing**, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add poc/server/src/server.ts poc/server/test/server.test.ts
git commit -m "feat(server): leave_session, and auto-close on the last deliberate leave (v7a2)"
```

---

### Task 3: `clientCommands.ts` and the prompt-bar interception

**Files:**
- Create: `poc/client/src/clientCommands.ts`
- Test: `poc/client/src/clientCommands.test.ts`
- Modify: `poc/client/src/components/PromptBar.tsx:37-54` (the `submit` function)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseClientCommand(text: string): ClientCommand | null` where `ClientCommand = { type: "exit" }`. Task 5 handles the `exit` command.

**Context the implementer needs:** `PromptBar.submit()` currently routes **any** slash input to `props.onSuggestSkill` via the regex at `:40`. So `/exit` today becomes a skill suggestion. The client-command check must therefore come **before** that branch, and before the `isDriver` check — leaving is not a driving privilege.

**Naming collision, decided (spec §4):** the slash autocomplete matches substrings across all plugin skills, so if a plugin ever ships a skill named `exit`, the menu will offer it while the client intercepts the text first. **The client command wins. `/exit` is reserved.** Do not add a check for whether a real skill shadows it.

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/clientCommands.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { parseClientCommand } from "./clientCommands";

describe("parseClientCommand", () => {
  test("recognises /exit", () => {
    expect(parseClientCommand("/exit")).toEqual({ type: "exit" });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseClientCommand("  /exit  ")).toEqual({ type: "exit" });
  });

  test("is case-insensitive, because the prompt bar does not shout", () => {
    expect(parseClientCommand("/EXIT")).toEqual({ type: "exit" });
    expect(parseClientCommand("/Exit")).toEqual({ type: "exit" });
  });

  test("does not match a longer name that merely starts with exit", () => {
    // /exits must reach the skill router, not be swallowed as a client command.
    expect(parseClientCommand("/exits")).toBeNull();
    expect(parseClientCommand("/exit-plan")).toBeNull();
  });

  test("does not match a prefix of it", () => {
    expect(parseClientCommand("/ex")).toBeNull();
  });

  test("requires the leading slash", () => {
    expect(parseClientCommand("exit")).toBeNull();
  });

  test("ignores prose that merely contains the word", () => {
    expect(parseClientCommand("how do I exit this session?")).toBeNull();
    expect(parseClientCommand("please run /exit for me")).toBeNull();
  });

  test("takes no arguments — /exit now is the whole command", () => {
    expect(parseClientCommand("/exit now")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseClientCommand("")).toBeNull();
    expect(parseClientCommand("   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd poc/client && npx vitest run src/clientCommands.test.ts
```

Expected: FAIL — cannot resolve `./clientCommands`.

- [ ] **Step 3: Write the module**

Create `poc/client/src/clientCommands.ts`:

```ts
/** Commands the client handles itself, before anything reaches the server or
 *  the agent.
 *
 *  `PromptBar.submit` routes ANY slash input to the skill router, so a client
 *  command has to be recognised ahead of that branch — otherwise `/exit`
 *  becomes a skill suggestion.
 *
 *  Reserved names win over plugin skills. The slash autocomplete matches
 *  substrings across every installed skill, so a plugin could ship one called
 *  `exit`; if that ever happens the menu will offer it while this parser still
 *  intercepts the text. That is the decision, not an oversight (spec §4). */
export type ClientCommand = { type: "exit" };

/** Exact, argument-free match. `/exits` and `/exit now` deliberately fall
 *  through to the skill router: swallowing a longer name would silently
 *  shadow a real skill, and the failure would look like the skill is broken. */
export function parseClientCommand(text: string): ClientCommand | null {
  if (text.trim().toLowerCase() === "/exit") return { type: "exit" };
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd poc/client && npx vitest run src/clientCommands.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Wire it into the prompt bar**

In `poc/client/src/components/PromptBar.tsx`, add the import at the top, beside the existing `slashMatch` import:

```ts
import { parseClientCommand, type ClientCommand } from "../clientCommands";
```

Add one prop to the component's props type, after `onSuggestSkill`:

```ts
  onClientCommand: (command: ClientCommand) => void;
```

Use the exported type rather than restating `{ type: "exit" }` inline — when a second command is added, a duplicated literal here would silently narrow it.

Then replace the `submit` function (currently `:37-54`) with:

```ts
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    // Before the skill router: `/exit` is ours, not the agent's. Also before
    // the isDriver check — leaving is not a driving privilege.
    const command = parseClientCommand(t);
    if (command) {
      setText("");
      setHint(null);
      props.onClientCommand(command);
      return;
    }
    const cmd = t.match(/^\/(\S+)\s*(.*)$/);
    if (cmd) {
      props.onSuggestSkill(cmd[1], cmd[2]);
      setText("");
      setHint(null);
      return;
    }
    if (!props.isDriver) {
      setHint("watching — suggest a skill with /name, or take the wheel to prompt");
      return;
    }
    props.onPrompt(t);
    setText("");
    setHint(null);
  };
```

Note the ordering inside the `command` branch: the text is cleared **before** the callback fires, because the callback may navigate away.

- [ ] **Step 6: Satisfy the new prop at the call site**

`poc/client/src/App.tsx:529` renders `<PromptBar …>`. Add a temporary no-op so the build stays green until Task 5 wires the real action:

```tsx
        onClientCommand={() => {}}
```

Task 5 replaces this. Leaving it as a no-op for one task is deliberate — it keeps this task independently testable and reviewable.

- [ ] **Step 7: Typecheck and run the client suite**

```bash
cd poc/client && npx tsc --noEmit && npx vitest run
```

Expected: 179 + 9 = **188 passing**, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add poc/client/src/clientCommands.ts poc/client/src/clientCommands.test.ts poc/client/src/components/PromptBar.tsx poc/client/src/App.tsx
git commit -m "feat(client): parse client-side slash commands, starting with /exit (v7a2)"
```

---

### Task 4: The `empty` session state

**Files:**
- Modify: `poc/client/src/sessionState.ts`
- Test: `poc/client/src/sessionState.test.ts`
- Modify: `poc/client/src/components/SessionPicker.tsx:82-83`
- Modify: `poc/client/src/components/PartyPane.tsx` (the call site that builds the facts object)
- Modify: `poc/client/src/terminal.css:727-730`

**Interfaces:**
- Consumes: `SessionStateFacts`, `degradedState`, `sessionStateLabel`, `sessionStateClass`, `sessionBadgeLabel` (all v7a).
- Produces: `SessionStateFacts` gains `participantCount?: number`. Precedence becomes `closed > offline > ended > empty > healthy`.

**Why `empty` sits below `ended`:** a dead agent is a fact about the session itself; emptiness is a fact about who happens to be looking at it right now. It sits above healthy because a session nobody is in is not simply live.

**`participantCount` is optional** so a snapshot from an older server degrades to "not empty" rather than showing every session as empty — the same posture `presence`, `lifecycle` and `pendingGate` already take.

- [ ] **Step 1: Write the failing tests**

In `poc/client/src/sessionState.test.ts`, add a new `describe` block and extend the existing shared-fixture table. Add:

```ts
describe("the empty state", () => {
  const live = { presence: "online" as const, lifecycle: "open" as const, ended: false };

  test("a session nobody is in reads empty", () => {
    expect(sessionStateLabel({ ...live, participantCount: 0 })).toBe("empty");
    expect(sessionStateClass({ ...live, participantCount: 0 })).toBe("empty");
    expect(sessionBadgeLabel({ ...live, participantCount: 0 })).toBe("EMPTY");
  });

  test("a session with people in it is healthy", () => {
    expect(sessionStateLabel({ ...live, participantCount: 2 })).toBeNull();
    expect(sessionBadgeLabel({ ...live, participantCount: 2 })).toBe("LIVE");
  });

  test("an absent count degrades to not-empty, not to empty", () => {
    // An older server sends no participant list; showing every session as
    // empty would be worse than showing none.
    expect(sessionStateLabel(live)).toBeNull();
  });

  test("a stopped agent outranks emptiness", () => {
    expect(sessionStateLabel({ ...live, ended: true, participantCount: 0 })).toBe("agent stopped");
  });

  test("an unreachable machine outranks emptiness", () => {
    expect(sessionStateLabel({ ...live, presence: "offline", participantCount: 0 })).toBe("offline");
  });

  test("a deliberate close outranks emptiness", () => {
    expect(sessionStateLabel({ ...live, lifecycle: "closed", participantCount: 0 })).toBe("closed");
  });
});
```

Then add these two rows to the existing shared fixture table that drives the label/class agreement test (the table added in v7a's fix round), so the drift invariant covers the new state:

```ts
  { facts: { presence: "online", lifecycle: "open", ended: false, participantCount: 0 }, label: "empty", cls: "empty" },
  { facts: { presence: "online", lifecycle: "open", ended: false, participantCount: 3 }, label: null, cls: "" },
```

Match the exact property names the existing table uses — read it before editing rather than assuming.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd poc/client && npx vitest run src/sessionState.test.ts
```

Expected: FAIL — `participantCount` is not a known property, and no `empty` state exists.

- [ ] **Step 3: Extend the module**

In `poc/client/src/sessionState.ts`:

Add the field to the facts interface, after `ended`:

```ts
  /** How many participants are in the session right now. Optional so a
   *  snapshot from an older server degrades to "not empty" rather than
   *  reporting every session as abandoned — same posture as `presence`. */
  participantCount?: number;
```

Widen the state union:

```ts
type DegradedState = "closed" | "offline" | "ended" | "empty";
```

Add the branch to `degradedState`, **after** the `ended` branch and before the `return null`:

```ts
  if (s.participantCount === 0) return "empty";
```

And extend the doc comment above `degradedState` by appending this paragraph:

```
 *  `empty` ranks last because it is the weakest claim of the four: a dead
 *  agent or an unreachable machine is a fact about the session, while
 *  emptiness is only a fact about who happens to be looking at it. It still
 *  outranks healthy — a session nobody is in is not simply live.
```

Add the two table entries:

```ts
const LABEL_BY_STATE: Record<DegradedState, string> = {
  closed: "closed",
  offline: "offline",
  ended: "agent stopped",
  empty: "empty",
};
```

```ts
const CLASS_BY_STATE: Record<DegradedState, string> = {
  closed: "closed",
  offline: "offline",
  ended: "ended",
  empty: "empty",
};
```

Both tables are `Record<DegradedState, string>`, so omitting either key is a compile error — that is the drift guard v7a built, and it is why no other change is needed.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd poc/client && npx vitest run src/sessionState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Feed the count in at both call sites**

In `poc/client/src/components/SessionPicker.tsx`, the badge currently reads (around `:82-83`):

```tsx
                  <span className={`spstate pix sm ${sessionStateClass(s) || "live"}`}>
                    {sessionBadgeLabel(s)}
                  </span>
```

`s` is a `ProjectSessionInfo` and already carries `participants: string[]`, but not `participantCount`. Build the facts explicitly so the mapping is visible rather than relying on structural typing:

```tsx
                  <span className={`spstate pix sm ${sessionStateClass({ ...s, participantCount: s.participants.length }) || "live"}`}>
                    {sessionBadgeLabel({ ...s, participantCount: s.participants.length })}
                  </span>
```

If that reads too densely, hoist it above the `return` inside the `rows.map` callback:

```tsx
            const facts = { ...s, participantCount: s.participants.length };
```

and use `facts` in both calls. Either is acceptable; do not duplicate the spread expression more than twice.

Then apply the same mapping in `poc/client/src/components/PartyPane.tsx`. Inside the `others.map((s) => {` callback (currently `:88-92`), replace:

```tsx
        const stateClass = sessionStateClass(s);
        const stateLabel = sessionStateLabel(s);
```

with:

```tsx
        const facts = { ...s, participantCount: s.participants.length };
        const stateClass = sessionStateClass(facts);
        const stateLabel = sessionStateLabel(facts);
```

Both surfaces must agree — a session reading EMPTY in the picker and healthy in the party pane would be the same two-surface disagreement v7a's final review caught and fixed.

- [ ] **Step 6: Add the missing badge colours**

In `poc/client/src/terminal.css`, the picker badge rules are at `:727-730` and currently cover only `live`, `ended` and `closed`. Add:

```css
.spstate.offline { color: var(--amber); }
.spstate.empty { color: var(--dim); }
```

`.spstate.offline` was missing before this task — `sessionBadgeLabel` could already return `OFFLINE` with a class that had no colour rule. Fixing it here keeps the four states visually distinct.

Both custom properties are already defined at the top of the file: `--amber: #e0a458` (`:37`, contrast 8.91:1) and `--dim: #828c9b` (`:32`, 5.72:1). Do not introduce new colours — this stylesheet's palette is contrast-audited and the ratios are recorded inline.

- [ ] **Step 7: Typecheck, test and build**

```bash
cd poc/client && npx tsc --noEmit && npx vitest run && npm run build
```

Expected: 188 + 8 = **196 passing**, tsc clean, build clean.

- [ ] **Step 8: Commit**

```bash
git add poc/client/src/sessionState.ts poc/client/src/sessionState.test.ts poc/client/src/components/SessionPicker.tsx poc/client/src/components/PartyPane.tsx poc/client/src/terminal.css
git commit -m "feat(client): an abandoned session reads EMPTY, not LIVE (v7a2)"
```

---

### Task 5: The EXIT control, the confirm bar, and the exit action

**Files:**
- Create: `poc/client/src/pickerUrl.ts`
- Test: `poc/client/src/pickerUrl.test.ts`
- Create: `poc/client/src/components/ExitConfirm.tsx`
- Modify: `poc/client/src/components/Header.tsx` (props + the button row ending at the INVITE button)
- Modify: `poc/client/src/App.tsx` (the exit action, the confirm state, the `onClientCommand` wiring from Task 3)
- Modify: `poc/client/src/terminal.css`

**Interfaces:**
- Consumes: `parseClientCommand` (Task 3), `{ type: "leave_session" }` (Task 2).
- Produces: nothing later depends on this — it is the last task.

**How navigation works here:** `joinSession` (`SessionPicker.tsx:137`) navigates by assigning `window.location.search`, a full page reload, and `App.tsx:42` reads `sessionId` from the URL at mount. Leaving is symmetric: rebuild the query string without the session and assign it.

**Ordering is load-bearing:** send `leave_session` **before** navigating. A reload closes the socket, and any unsent frame is lost.

- [ ] **Step 1: Write the failing test for the URL helper**

Create `poc/client/src/pickerUrl.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { pickerUrlFrom } from "./pickerUrl";

describe("pickerUrlFrom", () => {
  test("drops the session so the app routes to the picker", () => {
    expect(pickerUrlFrom("?session=ana")).toBe("");
  });

  test("keeps a non-default project", () => {
    expect(pickerUrlFrom("?session=ana&project=api")).toBe("project=api");
  });

  test("drops project=default, matching how joinSession omits it", () => {
    expect(pickerUrlFrom("?session=ana&project=default")).toBe("");
  });

  test("drops the invite token so an invite link does not pull you straight back in", () => {
    expect(pickerUrlFrom("?session=ana&invite=tok123")).toBe("");
  });

  test("drops a screen param so you land on the picker, not a sub-screen", () => {
    expect(pickerUrlFrom("?session=ana&screen=skills")).toBe("");
  });

  test("tolerates a leading question mark being absent", () => {
    expect(pickerUrlFrom("session=ana&project=api")).toBe("project=api");
  });

  test("tolerates an empty query string", () => {
    expect(pickerUrlFrom("")).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd poc/client && npx vitest run src/pickerUrl.test.ts
```

Expected: FAIL — cannot resolve `./pickerUrl`.

- [ ] **Step 3: Write the helper**

Create `poc/client/src/pickerUrl.ts`:

```ts
/** The query string that routes back to the session picker.
 *
 *  Allow-list, not a delete-list: `project` is the only param worth carrying
 *  out of a session, so everything else is dropped by construction. A
 *  delete-list would silently carry any param added later — `invite` in
 *  particular would pull you straight back into the session you just left.
 *
 *  `project=default` is omitted to match `joinSession` (SessionPicker.tsx),
 *  which only sets the param when it is not the default. */
export function pickerUrlFrom(search: string): string {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  const project = current.get("project");
  if (project !== null && project !== "default") next.set("project", project);
  return next.toString();
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd poc/client && npx vitest run src/pickerUrl.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Build the confirm bar**

Create `poc/client/src/components/ExitConfirm.tsx`:

```tsx
/** Inline confirm, not a modal. The permission gate and plan-approval cards
 *  (Transcript.tsx) already answer "a decision is waiting on you" this way, so
 *  this reuses that idiom rather than introducing a modal system the codebase
 *  does not have.
 *
 *  Shown only when leaving would strand something — see `exitWouldStrand` in
 *  App.tsx. Purely local state: whether you hesitated is nobody else's
 *  business and nothing about it belongs on the wire. */
export function ExitConfirm(props: {
  reason: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="exitconfirm" role="alertdialog" aria-label="confirm leaving">
      <span className="exitwhy">{props.reason}</span>
      <button className="btn red" onClick={props.onConfirm}>
        LEAVE ANYWAY
      </button>
      <button className="btn" onClick={props.onCancel} autoFocus>
        STAY
      </button>
    </div>
  );
}
```

`autoFocus` goes on STAY: the safe option should be the one a stray Enter hits.

- [ ] **Step 6: Add the EXIT control to the header**

In `poc/client/src/components/Header.tsx`, add to the props type, after `onOpenInvite`:

```ts
  onExit: () => void;
```

Then add the button immediately **after** the INVITE button and before the `<span className={props.connected ? "conn" : "conn off"}>`:

```tsx
        <button
          className="planmode"
          onClick={props.onExit}
          title="leave this session (/exit)"
        >
          ▢ EXIT
        </button>
```

The `title` names the command so the two surfaces teach each other.

- [ ] **Step 7: Wire the action in App.tsx**

Add the imports beside the existing component imports:

```ts
import { ExitConfirm } from "./components/ExitConfirm";
import { pickerUrlFrom } from "./pickerUrl";
```

Inside `SessionView`, add the confirm state next to the other `useState` calls:

```ts
  const [exitReason, setExitReason] = useState<string | null>(null);
```

Add the action functions beside the other `onX` callbacks (near `onPrompt` at `:366`):

```ts
  /** Leaving strands something only in two cases: the agent is mid-run, or a
   *  gate is waiting and you are the one who can answer it. Everything else
   *  leaves silently — nothing is destroyed by leaving and you can rejoin. */
  function exitWouldStrand(): string | null {
    if (derived.agentBusy) return "the agent is still working";
    if (gatesPending > 0 && isDriver) return "a permission gate is waiting on you";
    return null;
  }

  function leaveNow() {
    // Send BEFORE navigating: the reload closes the socket and any unsent
    // frame is lost. This message is what tells the server the departure was
    // deliberate, which is what lets it auto-close a session the last person
    // left — a socket close deliberately never does that.
    send({ type: "leave_session" });
    window.location.search = pickerUrlFrom(window.location.search);
  }

  function onExit() {
    const reason = exitWouldStrand();
    if (reason) {
      setExitReason(reason);
      return;
    }
    leaveNow();
  }
```

Replace the temporary no-op from Task 3 at the `<PromptBar …>` call site:

```tsx
        onClientCommand={(command) => {
          if (command.type === "exit") onExit();
        }}
```

Pass the handler to the header, beside `onOpenInvite`:

```tsx
        onExit={onExit}
```

Render the confirm bar directly above `<PromptBar`:

```tsx
      {exitReason && (
        <ExitConfirm
          reason={exitReason}
          onConfirm={leaveNow}
          onCancel={() => setExitReason(null)}
        />
      )}
```

- [ ] **Step 8: Style the confirm bar**

In `poc/client/src/terminal.css`, append:

```css
.exitconfirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--red);
}
.exitconfirm .exitwhy { flex: 1; min-width: 0; }
```

`flex-wrap: wrap` is not optional — `.term-header` was silently clipping its tail for exactly this reason (see the header-clip fix in HANDOFF §4d), and every other row in this stylesheet wraps.

Both custom properties are already defined: `--sp-2: 8px` (`:56`) and `--red: #e0685f` (`:36`, contrast 5.85:1). Use them as written rather than introducing new values.

- [ ] **Step 9: Typecheck, test and build**

```bash
cd poc/client && npx tsc --noEmit && npx vitest run && npm run build
```

Expected: 196 + 7 = **203 passing**, tsc clean, build clean.

- [ ] **Step 10: Commit**

```bash
git add poc/client/src/pickerUrl.ts poc/client/src/pickerUrl.test.ts poc/client/src/components/ExitConfirm.tsx poc/client/src/components/Header.tsx poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): EXIT control and /exit leave the session (v7a2)"
```

---

## Verification before calling v7a2 done

Unit tests cannot see this feature work. The header wiring, the confirm bar and the reload path have no component tests, and `docs/mistakes-and-fixes.md:9-14` records that pure tests plus a clean build did not catch the arcade's swap crash. Drive it once.

```bash
cd poc/server && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc --noEmit && npx vitest run && npm run build
```

Expected at the end: **server 357, client 203**, both tsc clean, build clean.

Then, with two browser tabs on one session (HANDOFF §6 has the stack recipe):

1. In tab B, type `/exit` and press Enter. Tab B lands on the session picker. Tab A's roster loses that participant and the session still reads **LIVE**.
2. In tab A, click **▢ EXIT** in the header. Tab A lands on the picker. The session goes straight to **CLOSED** — the server appends `presence_leave` and `session_closed` and pushes once, so EMPTY is never actually observable on a deliberate last leave. (EMPTY is only reachable via the disconnect path — see step 5.)
3. Rejoin the closed session from the picker and confirm prompting returns "this session has been closed" — leaving must not have broken the v7a guards.
4. Start a fresh session, send a prompt, and hit EXIT while the agent is still working. Confirm the inline bar appears reading "the agent is still working", that **STAY** dismisses it and keeps you in the session, and that **LEAVE ANYWAY** leaves.
5. Join a session in two tabs and **close** one tab rather than exiting it. Confirm the session stays **open** — the design's central guarantee — but now reads **EMPTY** (no deliberate `leave_session` was sent, so no `session_closed` was appended). It should also sort to the **top** of the picker: `sortSessions` orders by `lastActivityTs`, and the `presence_leave` the disconnect just wrote is the newest event in the project — read it as correct, not as a bug. Then reopen it from the picker and confirm you can rejoin.

## Deviations

Record every divergence from this plan here as you go, with the reason. This section is part of the deliverable — later sessions read it to understand why the shipped code differs from the listings above, and HANDOFF instructs them to treat it as the authoritative record.

**Task 2 — the plan's own close condition was wrong, and Task 2's listing above has been corrected in place.** As originally written, the handler closed the session whenever `participantList.length === 0`. Because `Session.leave` is idempotent and returned `void`, the handler could not tell whether *this* call removed anyone — so a repeat `leave_session` from someone who had already left would see an empty room and close the session, **even when a socket close was what emptied it.** That is the exact outcome spec §2 calls the load-bearing decision of the design (v7a made closing one-way, so there is no way back), and it attributed the close to a departure that did not cause it. Found by the Task 2 review via mutation testing plus an empirical probe. Fixed by giving `Session.leave` a `boolean` return and gating on it, with a regression test reproducing the three-step sequence. The listing above now shows the corrected code; a future re-run of this task from the original text would have reintroduced the bug.

**Task 2 — a comment in the plan's listing stated something false.** It claimed `presence_leave` is not in the `INTERESTING` set. It is (`server.ts:42`); only `session_closed` is absent. The `pushProject` call is still correct, but the real reason is that `presence_leave`'s push goes through `schedulePush`, which throttles by `PROJECT_PUSH_INTERVAL_MS` (1000ms). Corrected in the listing above. This same false claim is what led the implementer to misdiagnose why three of its tests passed before the implementation existed.

**Task 4 — the two new shared-fixture rows in Step 1 would not have compiled.** The existing fixture table in `sessionState.test.ts` types its rows with a required `desc: string`, and the plan's snippet omitted it. The implementer added `desc` strings matching the table's existing tone. The plan's own instruction at that step — "Match the exact property names the existing table uses — read it before editing rather than assuming" — is what caught it.

**Task 4 — `.spstate.offline` was not missing from `terminal.css`, as Step 6 asserted.** It already existed as `var(--dim)`, added by an earlier fix. The step's stated goal was four visually distinct badge states, and leaving `offline` on `--dim` would have made it identical to the new `empty`. The implementer therefore moved `offline` to `var(--amber)` — which is exactly the CSS the step specified verbatim — and gave `empty` the freed `var(--dim)`. **This changes the rendered colour of the existing OFFLINE badge**, which is why it is recorded here rather than treated as a no-op. No new colours were introduced: `--amber` (8.91:1) and `--dim` (5.72:1) are both pre-existing and contrast-audited.

**Task 5 — `exitWouldStrand` gained a comment, not a third branch.** The Task 5 review found the function has no branch for a pending `plan_request` (the plan-approval gate), and labeled it plan-mandated. Adjudicated against spec §3.4, which the user approved and which names exactly two signals by variable — `derived.agentBusy` and `gatesPending`. The code implements the approved spec; widening it would change approved behaviour. What the review established that the spec did not is that a pending plan decision is covered only *incidentally*: `plan_request` fires mid-turn while `agentBusy` is still true, and an abort-signal path auto-rejects an orphaned request. Nothing recorded that reliance, so drift in either would silently reopen a stranding bug. The invariant is now documented at the function; the logic is unchanged. **If `plan_request` timing relative to `agentBusy` ever changes, this function needs a third branch.**

**Task 5 — `ExitConfirm` gained `aria-describedby`.** The listing's JSX set `role="alertdialog"` and `aria-label` but never linked `props.reason` as the dialog's description, so a screen reader landing on the auto-focused STAY button could announce "STAY, button" without reading why the bar appeared — the one thing the component exists to convey. Added `id="exit-why"` / `aria-describedby="exit-why"`. Purely additive, and consistent with this codebase's standing accessibility floor.
