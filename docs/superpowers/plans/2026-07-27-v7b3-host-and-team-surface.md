# v7b3 — Host Role and Team Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hub an owner — a host who configures the surface, can close any session on it, and can hand the whole thing to someone else — and finish the team view by surfacing what a multi-repo hub can show that four separate servers never could.

**Architecture:** Host is an **attribute of a person**, not a mode: the host joins sessions, takes the wheel and is attributed by name exactly like anyone else, and hosting does not mean the hub runs their agent. Most of what the host owns already exists as environment variables, so this is largely a *move* from boot-time env into a live settings object the hub owns and enforces. The one genuinely new capability is hub-wide session close. The one stated non-capability — a host can never drive or approve in a session they have not joined — gets a test that pins it, not a paragraph that describes it.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `ws`, vitest, React 19. No new runtime dependencies.

## Global Constraints

- **Prerequisite: v7b1 and v7b2 are merged.** Baselines before Task 1: **server 396, hub 74, client 195**, all typechecks clean, client build clean.
- Spec authority: `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md`. Read §3.4, §3.6, §3.7 and §11 before starting.
- **`mpai` with no `--hub` still behaves exactly as today.** Same invariant as v7b1 and v7b2.
- **Server imports use `.js` specifiers**; client imports do not. Server tests in `poc/server/test/`, hub tests in `poc/hub/test/`, client tests co-located.
- **There is no client component-test infrastructure.** Extract logic into pure modules and test there.
- **A `<label>` must never wrap a form control.** This plan adds a settings screen full of controls, so it matters more here than anywhere else in v7. Use a `<span>` + `aria-labelledby`.
- **Never log or return the oversight API key**, in any form, including a prefix or a length. The settings API reports `apiKeySet: boolean` and nothing else.
- Do not run `git add -A`. Never commit `market-research.md`, `poc/demo-plugins/`, or `tour-skill-suggest.png`.

### Two scope interpretations this plan makes, flagged so they can be rejected in one place

1. **Oversight runs on the hub here (Task 6).** Spec §7 lists "oversight running on the hub *beyond the configuration decision in §3.7*" as out of scope, which reads two ways. Shipping only the configuration would mean shipping an inert setting: a key field and a toggle that do nothing, with the "oversight reads empty when hub-attached" bound from v7b1 still open. So this plan ships the working thing — host-configured, host's own key, `tools: []`, `maxTurns: 1`, exactly the shape `overseer.ts` already has. If a reviewer prefers the literal reading, cut Task 6 whole; nothing else depends on it.
2. **The invite system stays laptop-side.** Spec §4 lists `invites.ts` as moving to the hub. It is not moved here, and `REQUIRE_INVITE` stays a laptop env var rather than becoming a host setting. Reason: an invite governs who may enter a *session*, and sessions are laptop-owned (spec §3.1) — moving the store to the hub while the authority stays on the laptop would split one decision across two machines. It belongs with v7c, once the hub has persistence to hold invites across a restart. Recorded as a known bound below.

### Out of scope, do not build

SQLite persistence (v7c) — host settings, seats and the event log are all in memory here, so **a hub restart resets every setting and un-pairs every laptop**. Handoff continuity (v7d). Collision detection (v7e). The paid oversight tier (spec §3.7's "we supply one" arm) — that means reselling inference and needs a read of Anthropic's commercial terms, which is a business precondition, not a code blocker. Audit logging. Billing or payment of any kind: seats are **counted**, never charged.

---

### Task 1: `hostSettings.ts` — the host, the settings, and the seats

Everything the host owns, as pure data with pure rules. Bootstrapping, transfer, defaults, validation and seat counting all live here so that every enforcement point downstream is a one-line question rather than a policy re-derived in place.

**Files:**
- Create: `poc/hub/src/hostSettings.ts`
- Test: `poc/hub/test/hostSettings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface HostSettings { allowlist: string[]; membersMayAddPlugins: boolean; autoModeAllowed: boolean; retentionDays: number; oversight: { enabled: boolean; apiKey: string | null } }`
  - `interface PublicSettings` — the same minus `oversight.apiKey`, plus `oversight.apiKeySet: boolean`
  - `class HostState` — `host()`, `claim(login)`, `transfer(from, to)`, `isHost(login)`, `settings()`, `publicSettings()`, `update(login, patch)`, `mayAddPlugins(login)`, `allowlistCsv()`, `seatSeen(login)`, `seats()`
  - `DEFAULT_RETENTION_DAYS`, `MAX_RETENTION_DAYS`
  - Tasks 2–7 all consume `HostState`.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/hostSettings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_RETENTION_DAYS, HostState, MAX_RETENTION_DAYS } from "../src/hostSettings.js";

const seeded = () => new HostState({ allowlist: "frankie,ana,ben", host: "frankie" });

describe("who the host is", () => {
  it("takes the bootstrap host from configuration", () => {
    expect(seeded().host()).toBe("frankie");
    expect(seeded().isHost("frankie")).toBe(true);
    expect(seeded().isHost("ana")).toBe(false);
  });

  it("lets the first allowlisted arrival claim an unclaimed hub", () => {
    // A hub with no configured host must not be permanently ownerless; the
    // first person through the door takes it, exactly as the first joiner
    // becomes driver because currentDriverId was null (session.ts:72).
    const state = new HostState({ allowlist: "frankie,ana" });
    expect(state.host()).toBeNull();
    expect(state.claim("ana")).toEqual({ ok: true });
    expect(state.host()).toBe("ana");
  });

  it("refuses a second claim once the hub has a host", () => {
    const state = seeded();
    expect(state.claim("ana")).toEqual({ ok: false, error: "this hub already has a host" });
    expect(state.host()).toBe("frankie");
  });

  it("refuses a claim from someone not on the allowlist", () => {
    const state = new HostState({ allowlist: "frankie" });
    expect(state.claim("mallory")).toEqual({ ok: false, error: "not on the allowlist" });
    expect(state.host()).toBeNull();
  });

  it("transfers ownership, because a hub must not die when its host leaves", () => {
    // Spec §3.6, designed in from the start rather than bolted on later.
    const state = seeded();
    expect(state.transfer("frankie", "ana")).toEqual({ ok: true });
    expect(state.host()).toBe("ana");
    expect(state.isHost("frankie")).toBe(false);
  });

  it("only the current host may transfer, and only to someone allowlisted", () => {
    const state = seeded();
    expect(state.transfer("ana", "ben")).toEqual({ ok: false, error: "only the host can do that" });
    expect(state.transfer("frankie", "mallory")).toEqual({
      ok: false,
      error: "mallory is not on the allowlist",
    });
    expect(state.host()).toBe("frankie");
  });
});

describe("settings", () => {
  it("starts from sane defaults", () => {
    const s = seeded().settings();
    expect(s.membersMayAddPlugins).toBe(true);
    expect(s.autoModeAllowed).toBe(true);
    expect(s.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(s.oversight).toEqual({ enabled: false, apiKey: null });
  });

  it("never exposes the oversight key, only whether one is set", () => {
    // Not a prefix, not a length. The public shape simply has no field it
    // could leak through.
    const state = seeded();
    state.update("frankie", { oversight: { enabled: true, apiKey: "sk-ant-secret" } });
    const pub = state.publicSettings();
    expect(pub.oversight).toEqual({ enabled: true, apiKeySet: true });
    expect(JSON.stringify(pub)).not.toContain("sk-ant-secret");
  });

  it("only the host may change settings", () => {
    const state = seeded();
    expect(state.update("ana", { autoModeAllowed: false })).toEqual({
      ok: false,
      error: "only the host can do that",
    });
    expect(state.settings().autoModeAllowed).toBe(true);
  });

  it("applies a partial patch without disturbing the rest", () => {
    const state = seeded();
    state.update("frankie", { autoModeAllowed: false });
    expect(state.settings().autoModeAllowed).toBe(false);
    expect(state.settings().membersMayAddPlugins).toBe(true);
  });

  it("clamps retention rather than accepting a nonsense value", () => {
    const state = seeded();
    expect(state.update("frankie", { retentionDays: 0 })).toEqual({
      ok: false,
      error: `retentionDays must be between 1 and ${MAX_RETENTION_DAYS}`,
    });
    expect(state.update("frankie", { retentionDays: 9999 }).ok).toBe(false);
    expect(state.update("frankie", { retentionDays: 30 })).toEqual({ ok: true });
  });

  it("keeps the allowlist as a live list and as the csv requireAuth wants", () => {
    const state = seeded();
    expect(state.allowlistCsv()).toBe("frankie,ana,ben");
    state.update("frankie", { allowlist: ["frankie", "ana"] });
    expect(state.allowlistCsv()).toBe("frankie,ana");
  });

  it("will not let the host remove themselves from the allowlist", () => {
    // Otherwise one click locks everyone out of a hub nobody can now
    // reconfigure — including the person who did it.
    const state = seeded();
    expect(state.update("frankie", { allowlist: ["ana", "ben"] })).toEqual({
      ok: false,
      error: "the host cannot be removed from the allowlist",
    });
    expect(state.allowlistCsv()).toBe("frankie,ana,ben");
  });

  it("normalizes allowlist entries the way GitHub logins compare", () => {
    const state = seeded();
    state.update("frankie", { allowlist: [" Frankie ", "ANA", "ana", ""] });
    expect(state.allowlistCsv()).toBe("frankie,ana");
  });
});

describe("seats", () => {
  it("counts distinct humans, not connections", () => {
    // Countable from day one whether or not they are charged for (spec §3.6):
    // it keeps per-seat a PRICING change later rather than an architecture one.
    const state = seeded();
    state.seatSeen("frankie");
    state.seatSeen("ana");
    state.seatSeen("frankie");
    expect(state.seats()).toBe(2);
  });

  it("counts case-insensitively, because GitHub logins do", () => {
    const state = seeded();
    state.seatSeen("Frankie");
    state.seatSeen("frankie");
    expect(state.seats()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/hostSettings.test.ts`
Expected: FAIL — `Failed to resolve import "../src/hostSettings.js"`.

- [ ] **Step 3: Write the implementation**

Create `poc/hub/src/hostSettings.ts`:

```ts
/** Two weeks. Long enough that a team never notices it during a beta, short
 *  enough that an unattended hub is not accumulating transcripts forever. */
export const DEFAULT_RETENTION_DAYS = 14;
export const MAX_RETENTION_DAYS = 365;

export interface HostSettings {
  allowlist: string[];
  membersMayAddPlugins: boolean;
  autoModeAllowed: boolean;
  retentionDays: number;
  oversight: { enabled: boolean; apiKey: string | null };
}

/** What leaves the hub. Structurally incapable of carrying the key. */
export interface PublicSettings {
  allowlist: string[];
  membersMayAddPlugins: boolean;
  autoModeAllowed: boolean;
  retentionDays: number;
  oversight: { enabled: boolean; apiKeySet: boolean };
  host: string | null;
  seats: number;
}

export type SettingsPatch = Partial<
  Omit<HostSettings, "oversight"> & { oversight: { enabled?: boolean; apiKey?: string | null } }
>;

export type Ok = { ok: true } | { ok: false; error: string };

/** GitHub logins are case-insensitive, so every comparison in this file goes
 *  through here. Doing it anywhere else is how "Frankie" and "frankie" become
 *  two seats and one lockout. */
const norm = (login: string): string => login.trim().toLowerCase();

export class HostState {
  private hostLogin: string | null;
  private state: HostSettings;
  private seatsSeen = new Set<string>();

  constructor(seed: { allowlist: string; host?: string }) {
    this.hostLogin = seed.host ? norm(seed.host) : null;
    this.state = {
      allowlist: dedupe(seed.allowlist.split(",")),
      membersMayAddPlugins: true,
      autoModeAllowed: true,
      retentionDays: DEFAULT_RETENTION_DAYS,
      oversight: { enabled: false, apiKey: null },
    };
  }

  host(): string | null {
    return this.hostLogin;
  }

  isHost(login: string): boolean {
    return this.hostLogin !== null && this.hostLogin === norm(login);
  }

  /** An unclaimed hub is taken by the first allowlisted arrival — the same
   *  shape as the first joiner becoming driver because currentDriverId was
   *  null (session.ts:72). A hub with no owner is not a safe steady state. */
  claim(login: string): Ok {
    if (this.hostLogin !== null) return { ok: false, error: "this hub already has a host" };
    if (!this.state.allowlist.includes(norm(login))) {
      return { ok: false, error: "not on the allowlist" };
    }
    this.hostLogin = norm(login);
    return { ok: true };
  }

  /** Designed in from the start: a hub must not die because its host leaves
   *  the company (spec §3.6). */
  transfer(from: string, to: string): Ok {
    if (!this.isHost(from)) return { ok: false, error: "only the host can do that" };
    if (!this.state.allowlist.includes(norm(to))) {
      return { ok: false, error: `${to} is not on the allowlist` };
    }
    this.hostLogin = norm(to);
    return { ok: true };
  }

  settings(): HostSettings {
    return this.state;
  }

  publicSettings(): PublicSettings {
    return {
      allowlist: [...this.state.allowlist],
      membersMayAddPlugins: this.state.membersMayAddPlugins,
      autoModeAllowed: this.state.autoModeAllowed,
      retentionDays: this.state.retentionDays,
      oversight: { enabled: this.state.oversight.enabled, apiKeySet: this.state.oversight.apiKey !== null },
      host: this.hostLogin,
      seats: this.seats(),
    };
  }

  update(login: string, patch: SettingsPatch): Ok {
    if (!this.isHost(login)) return { ok: false, error: "only the host can do that" };

    if (patch.retentionDays !== undefined) {
      const days = patch.retentionDays;
      if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
        return { ok: false, error: `retentionDays must be between 1 and ${MAX_RETENTION_DAYS}` };
      }
    }

    let nextAllowlist = this.state.allowlist;
    if (patch.allowlist !== undefined) {
      nextAllowlist = dedupe(patch.allowlist);
      // One click must not be able to lock everyone out of a hub that nobody
      // can then reconfigure — including the person who did it.
      if (this.hostLogin !== null && !nextAllowlist.includes(this.hostLogin)) {
        return { ok: false, error: "the host cannot be removed from the allowlist" };
      }
      if (nextAllowlist.length === 0) {
        return { ok: false, error: "the allowlist cannot be empty" };
      }
    }

    this.state = {
      allowlist: nextAllowlist,
      membersMayAddPlugins: patch.membersMayAddPlugins ?? this.state.membersMayAddPlugins,
      autoModeAllowed: patch.autoModeAllowed ?? this.state.autoModeAllowed,
      retentionDays: patch.retentionDays ?? this.state.retentionDays,
      oversight: {
        enabled: patch.oversight?.enabled ?? this.state.oversight.enabled,
        // `undefined` leaves the key alone; an explicit null clears it. The
        // settings screen never round-trips the key, so without this
        // distinction every save would wipe it.
        apiKey:
          patch.oversight === undefined || patch.oversight.apiKey === undefined
            ? this.state.oversight.apiKey
            : patch.oversight.apiKey,
      },
    };
    return { ok: true };
  }

  mayAddPlugins(login: string): boolean {
    return this.state.membersMayAddPlugins || this.isHost(login);
  }

  /** requireAuth takes a csv allowlist, so this is the adapter between the
   *  live list and A2a's existing check — which stays untouched. */
  allowlistCsv(): string {
    return this.state.allowlist.join(",");
  }

  seatSeen(login: string): void {
    this.seatsSeen.add(norm(login));
  }

  seats(): number {
    return this.seatsSeen.size;
  }
}

function dedupe(entries: string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const login = norm(raw);
    if (login && !out.includes(login)) out.push(login);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run test/hostSettings.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and full suite**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: clean, **89 passed** (74 + 15).

- [ ] **Step 6: Commit**

```bash
git add poc/hub/src/hostSettings.ts poc/hub/test/hostSettings.test.ts
git commit -m "feat(hub): host role, settings and seat counting as pure state (v7b3)"
```

---

### Task 2: Settings routes, and the allowlist as live state

The allowlist stops being a boot-time env var and becomes something the host edits while the hub runs. `requireAuth` is untouched — it takes a csv allowlist and `HostState.allowlistCsv()` supplies one, so A2a's checked-and-reviewed auth code keeps working exactly as it does today.

**Files:**
- Create: `poc/hub/src/settingsRoutes.ts`
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/hubConfig.ts`, `poc/hub/src/main.ts`
- Test: `poc/hub/test/settingsRoutes.test.ts`

**Interfaces:**
- Consumes: `HostState` (Task 1), `requireAuth` from `multiplayer-ai-server/auth`.
- Produces:
  - `settingsRoutes(deps): (req, res) => boolean` — `GET /settings`, `POST /settings`, `POST /host/claim`, `POST /host/transfer`
  - `HubOptions` gains `hostLogin?: string`; `validateHubConfig` returns `hostLogin` from `HUB_HOST`.
  - Tasks 3–7 read the shared `HostState` instance.

Route table:

| Route | Who | Body | Answers |
|---|---|---|---|
| `GET /settings` | any allowlisted login | — | `PublicSettings` |
| `POST /settings` | **host only** | `SettingsPatch` | `{ ok: true }` or `{ ok: false, error }` |
| `POST /host/claim` | any allowlisted login | — | `{ ok: true }` when the hub is unclaimed |
| `POST /host/transfer` | host only | `{ to }` | `{ ok: true }` |

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/settingsRoutes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startHub } from "../src/hub.js";
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const authCfg = { clientId: "id", clientSecret: "s", sessionSecret: "testsecret", allowlist: "frankie,ana" };
const cookieFor = (login: string) => `${SESSION_COOKIE}=${signSession(login, "testsecret")}`;

const get = async (port: number, path: string, login?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: login ? { cookie: cookieFor(login) } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const post = async (port: number, path: string, body: unknown, login?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(login ? { cookie: cookieFor(login) } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const hosted = () => startHub({ port: 0, host: "127.0.0.1", auth: authCfg, hostLogin: "frankie" });

describe("reading settings", () => {
  it("lets any allowlisted member read them, including who the host is", async () => {
    // Members need to know the rules they are operating under — which is not
    // the same as being able to change them.
    const hub = await hosted();
    close = hub.close;
    const { body } = await get(hub.port, "/settings", "ana");
    expect(body).toMatchObject({
      host: "frankie",
      autoModeAllowed: true,
      membersMayAddPlugins: true,
      oversight: { enabled: false, apiKeySet: false },
    });
  });

  it("refuses a signed-out reader", async () => {
    const hub = await hosted();
    close = hub.close;
    expect((await get(hub.port, "/settings")).status).toBe(401);
  });

  it("never includes the oversight key in the response", async () => {
    const hub = await hosted();
    close = hub.close;
    await post(hub.port, "/settings", { oversight: { enabled: true, apiKey: "sk-ant-secret" } }, "frankie");
    const { body } = await get(hub.port, "/settings", "ana");
    expect(JSON.stringify(body)).not.toContain("sk-ant-secret");
    expect(body.oversight).toEqual({ enabled: true, apiKeySet: true });
  });
});

describe("writing settings", () => {
  it("lets the host change a setting", async () => {
    const hub = await hosted();
    close = hub.close;
    expect((await post(hub.port, "/settings", { autoModeAllowed: false }, "frankie")).body).toEqual({ ok: true });
    expect((await get(hub.port, "/settings", "frankie")).body.autoModeAllowed).toBe(false);
  });

  it("refuses a non-host with 403, not 401 — they are signed in, just not permitted", async () => {
    const hub = await hosted();
    close = hub.close;
    const res = await post(hub.port, "/settings", { autoModeAllowed: false }, "ana");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: "only the host can do that" });
  });

  it("leaves the stored oversight key alone when a save omits it", async () => {
    // The settings screen never round-trips the key, so without this every
    // unrelated save would silently wipe it and oversight would stop working
    // with no error anywhere.
    const hub = await hosted();
    close = hub.close;
    await post(hub.port, "/settings", { oversight: { enabled: true, apiKey: "sk-ant-secret" } }, "frankie");
    await post(hub.port, "/settings", { retentionDays: 30 }, "frankie");
    expect((await get(hub.port, "/settings", "frankie")).body.oversight.apiKeySet).toBe(true);
  });
});

describe("the live allowlist", () => {
  it("admits someone the host has just added, with no restart", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg, hostLogin: "frankie" });
    close = hub.close;
    expect((await get(hub.port, "/settings", "ben")).status).toBe(403);

    await post(hub.port, "/settings", { allowlist: ["frankie", "ana", "ben"] }, "frankie");
    expect((await get(hub.port, "/settings", "ben")).status).toBe(200);
  });

  it("locks out someone the host has just removed", async () => {
    const hub = await hosted();
    close = hub.close;
    expect((await get(hub.port, "/settings", "ana")).status).toBe(200);
    await post(hub.port, "/settings", { allowlist: ["frankie"] }, "frankie");
    expect((await get(hub.port, "/settings", "ana")).status).toBe(403);
  });
});

describe("host claim and transfer", () => {
  it("lets the first allowlisted arrival claim an unclaimed hub", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    expect((await get(hub.port, "/settings", "ana")).body.host).toBeNull();
    expect((await post(hub.port, "/host/claim", {}, "ana")).body).toEqual({ ok: true });
    expect((await get(hub.port, "/settings", "ana")).body.host).toBe("ana");
  });

  it("transfers ownership and takes it away from the previous host", async () => {
    const hub = await hosted();
    close = hub.close;
    expect((await post(hub.port, "/host/transfer", { to: "ana" }, "frankie")).body).toEqual({ ok: true });
    expect((await post(hub.port, "/settings", { autoModeAllowed: false }, "frankie")).status).toBe(403);
    expect((await post(hub.port, "/settings", { autoModeAllowed: false }, "ana")).body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/settingsRoutes.test.ts`
Expected: FAIL — every route falls through to the 404 handler.

- [ ] **Step 3: Write `settingsRoutes.ts`**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAuth, type AuthConfig } from "multiplayer-ai-server/auth";
import type { HostState, SettingsPatch } from "./hostSettings.js";

const MAX_BODY_BYTES = 8192;

export interface SettingsRouteDeps {
  hosts: HostState;
  auth: AuthConfig | undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "Cookie",
  });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export function settingsRoutes(
  deps: SettingsRouteDeps,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/$/, "") || "/";
    } catch {
      return false;
    }
    if (path !== "/settings" && !path.startsWith("/host/")) return false;

    // The allowlist comes from LIVE settings, not from the boot-time env: the
    // whole point of this task is that the host can add someone without a
    // restart. requireAuth itself is untouched — it takes a csv and this
    // supplies a fresh one on every request.
    const cfg = deps.auth ? { ...deps.auth, allowlist: deps.hosts.allowlistCsv() } : undefined;
    const check = requireAuth(req.headers.cookie, cfg);
    if (!check.ok) {
      // 401 "sign in" vs 403 "signed in, not permitted" — the client renders
      // two genuinely different screens for these.
      json(res, check.error === "authentication required" ? 401 : 403, { ok: false, error: check.error });
      return true;
    }
    const login = check.login;
    if (login === null) {
      // Host settings without identity would be a control anyone can operate.
      json(res, 403, { ok: false, error: "host settings require authentication" });
      return true;
    }

    if (path === "/settings" && req.method === "GET") {
      json(res, 200, deps.hosts.publicSettings());
      return true;
    }

    if (path === "/settings" && req.method === "POST") {
      void readJson(req).then((body) => {
        const result = deps.hosts.update(login, (body ?? {}) as SettingsPatch);
        json(res, result.ok ? 200 : 403, result);
      });
      return true;
    }

    if (path === "/host/claim" && req.method === "POST") {
      const result = deps.hosts.claim(login);
      json(res, result.ok ? 200 : 409, result);
      return true;
    }

    if (path === "/host/transfer" && req.method === "POST") {
      void readJson(req).then((body) => {
        const to = typeof body?.to === "string" ? body.to.slice(0, 64) : "";
        const result = deps.hosts.transfer(login, to);
        json(res, result.ok ? 200 : 403, result);
      });
      return true;
    }

    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return true;
  };
}
```

- [ ] **Step 4: Wire it, and make the WebSocket path use the live allowlist too**

In `poc/hub/src/hubConfig.ts`, carry `HUB_HOST` through:

```ts
  return {
    ok: true,
    staticDir,
    auth: { /* unchanged */ },
    origin: env.HUB_ORIGIN?.trim() || undefined,
    /** Bootstrap host. Optional: an unclaimed hub is taken by the first
     *  allowlisted arrival (spec §3.6). */
    hostLogin: env.HUB_HOST?.trim() || undefined,
  };
```

In `poc/hub/src/hub.ts`, construct the shared state, register the routes, and — importantly — route **every** existing `requireAuth` call through the live allowlist:

```ts
  const hosts = new HostState({
    allowlist: opts.auth?.allowlist ?? "",
    host: opts.hostLogin,
  });
  const handleSettings = settingsRoutes({ hosts, auth: opts.auth });
```

```ts
  /** The one place the live allowlist is spliced into A2a's auth config. Every
   *  requireAuth call in this file goes through it, or the host adding a
   *  teammate would work for HTTP and silently not for WebSockets. */
  const liveAuth = () => (opts.auth ? { ...opts.auth, allowlist: hosts.allowlistCsv() } : undefined);
```

Replace `requireAuth(cookieHeader, opts.auth)` in `handleBrowser` with `requireAuth(cookieHeader, liveAuth())`, and the same inside `pairRoutes` — pass `liveAuth` rather than a fixed `auth` in `PairRouteDeps`, changing its type to `auth: () => AuthConfig | undefined`.

Register after `/pair/*` and before the static handler:

```ts
    if (handleSettings(req, res)) return;
```

Record seats where identity is first known, in `handleBrowser`'s verified branch:

```ts
      if (auth.login) hosts.seatSeen(auth.login);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **99 passed** (89 + 10).

- [ ] **Step 6: Commit**

```bash
git add poc/hub/src/settingsRoutes.ts poc/hub/src/hub.ts poc/hub/src/hubConfig.ts \
        poc/hub/src/main.ts poc/hub/src/pairRoutes.ts poc/hub/test/settingsRoutes.test.ts
git commit -m "feat(hub): host settings routes and a live allowlist (v7b3)"
```

---

### Task 3: What the host can and cannot do

Two enforcement points, and one non-capability that gets a test rather than a paragraph.

**The non-capability, stated as the spec states it (§3.6):** the host can never drive or approve in a session they have not joined. A decision attributed to someone who was not present is exactly what this product exists to eliminate, and a host bypass would recreate the credential-confusion villain in the project's own positioning. This needs a test because it is the kind of thing a later "convenience" change breaks silently.

**Files:**
- Modify: `poc/hub/src/hub.ts` (`handleBrowser`'s tunnel path)
- Test: `poc/hub/test/hostPowers.test.ts`

**Interfaces:**
- Consumes: `HostState.isHost`, `HostState.mayAddPlugins`, `HostState.settings()`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/hostPowers.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHub } from "../src/hub.js";
import { RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authCfg = { clientId: "id", clientSecret: "s", sessionSecret: "testsecret", allowlist: "frankie,ana" };
const cookieFor = (login: string) => `${SESSION_COOKIE}=${signSession(login, "testsecret")}`;

const facts = (id: string) => ({
  id, participants: [], driverName: null, intent: null, lastActivityTs: null,
  ended: false, pendingGate: null, skills: [], repoKey: "k", lifecycle: "open",
});

async function hubWithLaptop() {
  const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg, hostLogin: "frankie" });
  const up = new WebSocket(`ws://127.0.0.1:${hub.port}/uplink`);
  await new Promise<void>((r) => up.on("open", () => r()));
  const upSeen: any[] = [];
  up.on("message", (raw) => upSeen.push(JSON.parse(raw.toString())));
  up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", projectId: "default", repoKey: "k" }));
  up.send(JSON.stringify({ t: "facts", sessionId: "auth", runId: "run-a", facts: facts("auth") }));
  await wait(40);
  return { hub, up, upSeen };
}

function browserAs(port: number, login: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie: cookieFor(login) } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("the host's stated non-capability", () => {
  it("cannot prompt or approve in a session they have not joined", async () => {
    // Spec §3.6. Approval authority comes from PRESENCE, not from role
    // (spec §2.9) — and the host is a person on the hub, not a mode.
    const { hub, up, upSeen } = await hubWithLaptop();
    close = hub.close;

    const host = await browserAs(hub.port, "frankie");
    const seen: any[] = [];
    host.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    host.send(JSON.stringify({ type: "prompt", text: "do a thing" }));
    host.send(JSON.stringify({ type: "permission", requestId: "r1", decision: "allow" }));
    await wait(50);

    expect(seen.every((m) => m.type === "error" && m.message === "join a session first")).toBe(true);
    // Nothing reached the laptop, so nothing could have been attributed to a
    // human who was not there.
    expect(upSeen.filter((f) => f.t === "tunnel")).toHaveLength(0);
    host.close(); up.close();
  });

  it("becomes an ordinary participant once they DO join", async () => {
    // The host is not locked out — they are just not special. They join, take
    // the wheel and are attributed by name exactly like anyone else.
    const { hub, up, upSeen } = await hubWithLaptop();
    close = hub.close;
    const host = await browserAs(hub.port, "frankie");
    host.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "frankie", name: "frankie" }));
    await wait(30);
    host.send(JSON.stringify({ type: "prompt", text: "now this is fine" }));
    await wait(50);

    const tunnels = upSeen.filter((f) => f.t === "tunnel");
    expect(tunnels.map((f) => f.payload.type)).toEqual(["join", "prompt"]);
    expect(tunnels[1].identity).toEqual({ userId: "frankie", name: "frankie" });
    host.close(); up.close();
  });
});

describe("host-configured permissions", () => {
  it("blocks AUTO mode for everyone when the host disallows it", async () => {
    // AUTO is relay-enforced so every gate still reaches the wire, but a host
    // running a cautious team may not want it available at all.
    const { hub, up, upSeen } = await hubWithLaptop();
    close = hub.close;
    await fetch(`http://127.0.0.1:${hub.port}/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieFor("frankie") },
      body: JSON.stringify({ autoModeAllowed: false }),
    });

    const member = await browserAs(hub.port, "ana");
    const seen: any[] = [];
    member.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    member.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(30);
    upSeen.length = 0;
    member.send(JSON.stringify({ type: "set_permission_mode", mode: "auto" }));
    await wait(50);

    expect(seen.some((m) => m.type === "error" && /AUTO mode is disabled/.test(m.message))).toBe(true);
    expect(upSeen.filter((f) => f.t === "tunnel")).toHaveLength(0);

    // plan and default still work — the setting bans one mode, not the control.
    member.send(JSON.stringify({ type: "set_permission_mode", mode: "plan" }));
    await wait(50);
    expect(upSeen.filter((f) => f.t === "tunnel")).toHaveLength(1);
    member.close(); up.close();
  });

  it("blocks plugin registration for members but never for the host", async () => {
    const { hub, up, upSeen } = await hubWithLaptop();
    close = hub.close;
    await fetch(`http://127.0.0.1:${hub.port}/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieFor("frankie") },
      body: JSON.stringify({ membersMayAddPlugins: false }),
    });

    const member = await browserAs(hub.port, "ana");
    const memberSeen: any[] = [];
    member.on("message", (raw) => memberSeen.push(JSON.parse(raw.toString())));
    member.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(30);
    member.send(JSON.stringify({ type: "add_plugin", url: "https://example.com/p.git" }));
    await wait(50);
    expect(memberSeen.some((m) => m.type === "error" && /host has disabled/.test(m.message))).toBe(true);

    const host = await browserAs(hub.port, "frankie");
    host.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "frankie", name: "frankie" }));
    await wait(30);
    upSeen.length = 0;
    host.send(JSON.stringify({ type: "add_plugin", url: "https://example.com/p.git" }));
    await wait(50);
    expect(upSeen.filter((f) => f.t === "tunnel" && f.payload.type === "add_plugin")).toHaveLength(1);

    member.close(); host.close(); up.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/hostPowers.test.ts`
Expected: FAIL — AUTO and `add_plugin` tunnel straight through.

- [ ] **Step 3: Write the implementation**

In `poc/hub/src/hub.ts`, add the two checks in `handleBrowser`, immediately before the final `tunnel(msg)` fallthrough:

```ts
      // Host-configured limits. Enforced at the hub because the setting lives
      // here — a laptop has no way to know what this hub's host decided, and
      // asking it to would put the policy in two places.
      if (msg.type === "set_permission_mode" && msg.mode === "auto" && !hosts.settings().autoModeAllowed) {
        return error("AUTO mode is disabled on this hub");
      }
      if (msg.type === "add_plugin" && !hosts.mayAddPlugins(channel.identity?.userId ?? "")) {
        return error("the host has disabled plugin registration for members");
      }

      tunnel(msg);
```

**Nothing else is needed for the non-capability.** `tunnel()` already refuses with `"join a session first"` when the channel has no joined session, and the host's channel is an ordinary channel. That is the point: the host has no special path to refuse them on, because there is no special path at all. The test exists to keep it that way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **103 passed** (99 + 4).

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/hub.ts poc/hub/test/hostPowers.test.ts
git commit -m "feat(hub): enforce host-configured limits, and pin the host's non-capability (v7b3)"
```

---

### Task 4: Protocol v2 — hub-initiated close, digests, and plugin rosters

Three frames, added together so there is **one** version bump and one round of laptop/hub coordination rather than three. `close` lets the host end a session they are not in; `digest` lets Task 6's overseer see across machines; `plugins` closes v7b1's "plugins read empty when hub-attached" bound in Task 5. The laptop publishes digests and plugin rosters from this task onward whether or not anything consumes them yet — a frame nobody reads is cheap, and extra version bumps are not.

`RELAY_PROTOCOL_VERSION` goes to **2**. A laptop and hub on different versions refuse each other at `hello` with a 1008 close, which is the designed behaviour (v7b1 Task 1) and the reason the version exists.

**Files:**
- Modify: `poc/server/src/relayProtocol.ts`, `poc/server/src/relay.ts`, `poc/server/src/server.ts`
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/hubStore.ts`
- Test: `poc/server/test/relayProtocol.test.ts`, `poc/server/test/relay.test.ts`, `poc/hub/test/hostClose.test.ts`

**Interfaces:**
- Produces:
  - `RELAY_PROTOCOL_VERSION = 2`
  - `DownFrame` gains `{ t: "close"; sessionId: string; userId: string }`
  - `UpFrame` gains `{ t: "digest"; sessionId: string; digest: OversightSessionDigest }` and `{ t: "plugins"; plugins: PluginInfo[]; enabled: boolean }`
  - `welcome` gains `closed: string[]` — sessions the hub has recorded as closed, so a returning laptop learns about a close that happened while it was away (spec §11).
  - `HubStore` gains `markClosed(projectId, sessionId)`, `closedIn(projectId)`, `setDigest(uplinkId, sessionId, digest)`, `digestsFor(projectId)`, `setPlugins(uplinkId, plugins, enabled)`.
  - `Relay` gains `publishDigest(sessionId, digest)` and `publishPlugins(plugins, enabled)`, both built on the existing private `emit`, so they buffer-before-open and flush exactly like `publishFacts`.

- [ ] **Step 1: Write the failing tests**

Append to `poc/server/test/relayProtocol.test.ts`:

```ts
describe("protocol v2 frames", () => {
  test("the version is 2, and v1 peers are refused at the frame boundary", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(2);
    expect(parseUpFrame({ t: "hello", v: 1, uplinkId: "l", projectId: "default", repoKey: "k" })).toBeNull();
  });

  test("accepts a hub-initiated close carrying the human who did it", () => {
    // Attribution is not optional. A session_closed with no name would be the
    // one event on the wire that does not say who caused it.
    expect(parseDownFrame({ t: "close", sessionId: "auth", userId: "frankie" })).toEqual({
      t: "close", sessionId: "auth", userId: "frankie",
    });
    expect(parseDownFrame({ t: "close", sessionId: "auth" })).toBeNull();
  });

  test("accepts a digest frame", () => {
    const digest = { sessionId: "auth", intent: null, ended: false, driverName: "ana", participants: ["ana"], recentTools: [], gatesPending: 0 };
    expect(parseUpFrame({ t: "digest", sessionId: "auth", digest })?.t).toBe("digest");
    expect(parseUpFrame({ t: "digest", sessionId: "auth", digest: "nope" })).toBeNull();
  });

  test("welcome carries the sessions the hub knows are closed", () => {
    // Spec §11: a laptop that was offline when the host closed a session must
    // learn about it on return. The proposed answer — accept and surface — is
    // only possible if the close reaches the laptop at all.
    const frame = parseDownFrame({ t: "welcome", v: 2, have: {}, closed: ["auth"] });
    expect(frame).toEqual({ t: "welcome", v: 2, have: {}, closed: ["auth"] });
  });

  test("welcome without `closed` degrades to an empty list rather than failing", () => {
    expect(parseDownFrame({ t: "welcome", v: 2, have: {} })).toEqual({ t: "welcome", v: 2, have: {}, closed: [] });
  });
});
```

Append to `poc/server/test/relay.test.ts`:

```ts
describe("Relay protocol v2", () => {
  it("closes a session the hub says the host closed, attributed to them", () => {
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {}, closed: [] });

    fake.deliver({ t: "close", sessionId: "auth", userId: "frankie" });
    const closed = session.eventsFrom(0).filter((e) => e.type === "session_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].userId).toBe("frankie");
  });

  it("is idempotent — a repeated close does not write a second event", () => {
    // The log is append-only and replayed to every late joiner, so a duplicate
    // is permanent and visible.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {}, closed: [] });
    fake.deliver({ t: "close", sessionId: "auth", userId: "frankie" });
    fake.deliver({ t: "close", sessionId: "auth", userId: "frankie" });
    expect(session.eventsFrom(0).filter((e) => e.type === "session_closed")).toHaveLength(1);
  });

  it("accepts a close that happened while it was away, from the welcome frame", () => {
    // Spec §11's answer: accept, and surface it to the returning user. It does
    // NOT resurrect the session.
    const fake = fakeSocket();
    const relay = relayWith(fake);
    const session = new Session("auth");
    relay.trackSession("auth", session);
    relay.start();
    fake.open();
    fake.deliver({ t: "welcome", v: RELAY_PROTOCOL_VERSION, have: {}, closed: ["auth"] });
    expect(session.eventsFrom(0).filter((e) => e.type === "session_closed")).toHaveLength(1);
  });
});
```

Create `poc/hub/test/hostClose.test.ts` covering: the host closing a session they have not joined succeeds and sends a `close` frame; a non-host member gets `"only the host can close another session"`; the hub records it so a later `welcome` carries it in `closed`; and the snapshot's `lifecycle` flips to `"closed"`. Use the `hubWithLaptop` helper shape from Task 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/relayProtocol.test.ts test/relay.test.ts` and `cd poc/hub && npx vitest run test/hostClose.test.ts`
Expected: FAIL on both — the version is 1 and neither frame parses.

- [ ] **Step 3: Extend the protocol**

In `poc/server/src/relayProtocol.ts`, first add the two type imports the new frames need — both modules stay laptop-side, so this is a type-only dependency and adds no runtime import:

```ts
import type { OversightSessionDigest } from "./digest.js";
import type { PluginInfo } from "./pluginStore.js";
```

then:

```ts
/** 2: adds the hub-initiated `close` down-frame, the `digest` and `plugins`
 *  up-frames, and `closed` on `welcome`. Bumped once for all of them, so
 *  laptop and hub need one round of coordination rather than three. A
 *  mismatched peer is refused at `hello` with a 1008 close — which is exactly
 *  what this constant is for. */
export const RELAY_PROTOCOL_VERSION = 2;
```

Add to `UpFrame`:

```ts
  /** The structured digest this session would contribute to a team summary.
   *  Produced laptop-side by digest.ts, which stays where it is (spec §4) —
   *  the hub assembles, it does not derive. */
  | { t: "digest"; sessionId: string; digest: OversightSessionDigest }
  /** This laptop's plugin registry. Plugins are local files the agent loads
   *  (spec §4), so they are per-machine and the hub can only report what each
   *  laptop tells it. Sent per uplink, not per session — one registry serves
   *  every session on that machine. */
  | { t: "plugins"; plugins: PluginInfo[]; enabled: boolean };
```

Add to `DownFrame`:

```ts
  /** The host ended this session from the hub. Carries the human who did it,
   *  because attribution is not optional — a session_closed with no name
   *  would be the one event on the wire that does not say who caused it. */
  | { t: "close"; sessionId: string; userId: string };
```

Change `welcome` to carry `closed: string[]`, defaulting to `[]` when absent, and add the two parse branches mirroring the existing ones (slug-checked `sessionId`, bounded `userId`, structural check on `digest` in the same style as `isFacts`).

- [ ] **Step 4: Handle the frames on the laptop**

In `poc/server/src/relay.ts`, in the `welcome` branch after the replay loop:

```ts
      // A close that happened while this laptop was offline. Spec §11's
      // answer is accept-and-surface, not resurrect: the work is over, and
      // pretending otherwise would let two people disagree about whether it is.
      for (const sessionId of frame.closed) this.applyClose(sessionId, "the host");
```

and a new branch:

```ts
    if (frame.t === "close") {
      this.applyClose(frame.sessionId, frame.userId);
      return;
    }
```

with:

```ts
  /** Idempotent by construction: the log is append-only and replayed to every
   *  late joiner, so a duplicate session_closed is permanent and visible. */
  private applyClose(sessionId: string, userId: string): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    const already = tracked.session.eventsFrom(0).some((e) => e.type === "session_closed");
    if (already) return;
    tracked.session.append({ type: "session_closed", userId });
  }
```

Publish digests wherever facts are published. In `poc/server/src/server.ts`'s `pushProject`, beside the existing `relay.publishFacts(...)`:

```ts
      if (relay) {
        for (const [id, entry] of project.sessions) {
          relay.publishFacts(id, sessionFactsOf(id, entry, repo?.key ?? null));
          // digest.ts stays laptop-side as a fact producer (spec §4); the hub
          // assembles rather than derives.
          const participants = entry.session.participantList;
          relay.publishDigest(
            id,
            oversightSessionDigest(
              id,
              entry.session.eventsFrom(0),
              entry.driver.isDead,
              participants.find((p) => p.userId === entry.session.driverId)?.name ?? null,
              participants.map((p) => p.name),
            ),
          );
        }
        // Per uplink, not per session: one registry serves every session on
        // this machine. Published on the same throttle so a plugin added
        // mid-session shows up without its own timer.
        relay.publishPlugins(pluginStore.list(project.id), pluginStore.enabled);
      }
```

- [ ] **Step 5: Handle them on the hub**

`HubStore` gains `markClosed`/`closedIn` (a `Set<string>` per project, folded into `snapshot` so `lifecycle` reads `"closed"` even before the laptop's own `session_closed` arrives) and `setDigest`/`digestsFor`. `handleUplink` stores digests; `welcome` carries `closed: store.closedIn(projectId)`.

In `handleBrowser`, `close_session` gains a host path **before** the tunnel fallthrough:

```ts
      if (msg.type === "close_session" && typeof msg.sessionId === "string") {
        // Hub scope, and part of why the role exists (spec §3.4). Closing a
        // session you ARE in stays session-scoped and tunnels as before — any
        // participant may do that, attributed on the wire.
        const target = String(msg.sessionId);
        if (target !== channel.sessionId) {
          if (!hosts.isHost(channel.identity?.userId ?? "")) {
            return error("only the host can close another session");
          }
          const owner = store.ownerOf(channel.projectId ?? "default", target);
          const uplink = owner ? uplinks.get(owner) : undefined;
          if (!uplink) return error(`no machine is running session "${target}" right now`);
          store.markClosed(channel.projectId ?? "default", target);
          down(uplink, { t: "close", sessionId: target, userId: channel.identity!.userId });
          schedulePush(channel.projectId ?? "default");
          return;
        }
      }
```

- [ ] **Step 6: Run everything**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: **404 passed** (396 + 5 protocol + 3 relay).

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **107 passed** (103 + 4).

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/relayProtocol.ts poc/server/src/relay.ts poc/server/src/server.ts \
        poc/hub/src/hub.ts poc/hub/src/hubStore.ts \
        poc/server/test/relayProtocol.test.ts poc/server/test/relay.test.ts poc/hub/test/hostClose.test.ts
git commit -m "feat: protocol v2 — hub-initiated close and session digests (v7b3)"
```

---

### Task 5: Plugins on the team snapshot, and retention

Closes the "plugins read empty when hub-attached" bound v7b1 shipped with, and gives the host's `retentionDays` setting something real to do.

**Files:**
- Modify: `poc/hub/src/hubStore.ts`, `poc/hub/src/hub.ts`
- Test: `poc/hub/test/hubStore.test.ts` (add cases; do not edit existing ones)

**Interfaces:**
- Consumes: the `plugins` up-frame (Task 4), `HostState.settings().retentionDays`.
- Produces: `HubStore.sweepRetention(days, now): number`. The snapshot's `plugins` / `pluginsEnabled` stop being hardcoded empty.

- [ ] **Step 1: Write the failing test**

Append to `poc/hub/test/hubStore.test.ts`:

```ts
describe("plugins across machines", () => {
  it("unions every attached laptop's registry, deduped by name", () => {
    // Two engineers who both registered the same plugin should see it once,
    // not twice — the roster is a team view, not a concatenation.
    const store = new HubStore();
    store.attach("lap-1", "default", "github.com/acme/api");
    store.attach("lap-2", "default", "github.com/acme/web");
    store.setPlugins("lap-1", [
      { name: "soltero-skills", url: "https://x/y.git", skills: [], addedBy: "ana" },
    ], true);
    store.setPlugins("lap-2", [
      { name: "soltero-skills", url: "https://x/y.git", skills: [], addedBy: "ben" },
      { name: "other", url: "https://x/z.git", skills: [], addedBy: "ben" },
    ], true);

    const snap = store.snapshot("default");
    expect(snap.plugins.map((p) => p.name).sort()).toEqual(["other", "soltero-skills"]);
    expect(snap.pluginsEnabled).toBe(true);
  });

  it("reports plugins enabled when ANY laptop has them enabled", () => {
    // A member whose own machine has plugins off still needs to see that the
    // party's sessions carry skills, or the SKILL SUITE screen lies.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.attach("lap-2", "default", "k2");
    store.setPlugins("lap-1", [], false);
    store.setPlugins("lap-2", [], true);
    expect(store.snapshot("default").pluginsEnabled).toBe(true);
  });

  it("drops a detached laptop's plugins from the roster", () => {
    // Unlike sessions, a plugin roster from an unreachable machine is not
    // useful information — nothing can load those skills right now.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.setPlugins("lap-1", [{ name: "p", url: "u", skills: [], addedBy: "ana" }], true);
    expect(store.snapshot("default").plugins).toHaveLength(1);
    store.detach("lap-1");
    expect(store.snapshot("default").plugins).toHaveLength(0);
  });
});

describe("retention", () => {
  it("drops events older than the retention window and reports how many", () => {
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    const day = 24 * 60 * 60 * 1000;
    const at = (ms: number, seq: number) =>
      ({ type: "intent_update", text: "x", seq, ts: new Date(ms).toISOString() }) as any;
    store.publish("lap-1", "auth", "run-a", [at(0, 0), at(day * 10, 1), at(day * 20, 2)]);

    expect(store.sweepRetention(14, day * 20)).toBe(1); // only the day-0 event is older than 14 days
    expect(store.eventsFor("default", "auth", 0)).toHaveLength(2);
  });

  it("never drops the newest event, even past the window", () => {
    // A session whose whole history aged out would render as an empty
    // transcript with no explanation. Keeping the last event keeps the row
    // honest until the session itself is removed.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [
      { type: "intent_update", text: "ancient", seq: 0, ts: new Date(0).toISOString() } as any,
    ]);
    store.sweepRetention(1, 90 * 24 * 60 * 60 * 1000);
    expect(store.eventsFor("default", "auth", 0)).toHaveLength(1);
  });

  it("leaves an unparseable timestamp alone rather than deleting it", () => {
    // Degrade, don't destroy: the append-only log is the product's memory.
    const store = new HubStore();
    store.attach("lap-1", "default", "k");
    store.publish("lap-1", "auth", "run-a", [
      { type: "intent_update", text: "a", seq: 0, ts: "not-a-date" } as any,
      { type: "intent_update", text: "b", seq: 1, ts: new Date(0).toISOString() } as any,
    ]);
    store.sweepRetention(1, 90 * 24 * 60 * 60 * 1000);
    expect(store.eventsFor("default", "auth", 0).map((e) => e.event.text)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/hubStore.test.ts`
Expected: FAIL — `setPlugins` and `sweepRetention` are not functions, and the snapshot's plugins are hardcoded empty.

- [ ] **Step 3: Write the implementation**

In `poc/hub/src/hubStore.ts`, add plugin state to the `Uplink` record:

```ts
interface Uplink {
  uplinkId: string;
  projectId: string;
  repoKey: string;
  online: boolean;
  /** Plugins are local files the agent loads (spec §4), so this is per-machine
   *  and the hub can only report what each laptop tells it. */
  plugins: PluginInfo[];
  pluginsEnabled: boolean;
}
```

```ts
  setPlugins(uplinkId: string, plugins: PluginInfo[], enabled: boolean): void {
    const uplink = this.uplinks.get(uplinkId);
    if (!uplink) return;
    uplink.plugins = plugins;
    uplink.pluginsEnabled = enabled;
  }
```

and replace the hardcoded `plugins: []` / `pluginsEnabled: false` in `snapshot`:

```ts
    // Only ONLINE laptops contribute. Unlike sessions — which stay listed
    // because "Ana's work exists but her laptop is asleep" is useful — a
    // plugin roster from an unreachable machine is not: nothing can load
    // those skills right now.
    const live = [...this.uplinks.values()].filter(
      (u) => u.projectId === projectId && u.online,
    );
    const byName = new Map<string, PluginInfo>();
    for (const uplink of live) {
      for (const plugin of uplink.plugins) {
        // First writer wins: two engineers with the same plugin see it once.
        if (!byName.has(plugin.name)) byName.set(plugin.name, plugin);
      }
    }
```

```ts
      plugins: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      pluginsEnabled: live.some((u) => u.pluginsEnabled),
```

Add the sweep:

```ts
  /** Drops stored events older than the host's retention window.
   *
   *  Never drops a session's newest event: a session whose whole history aged
   *  out would render as an empty transcript with no explanation, and the row
   *  is more honest with one stale line than with none. An unparseable
   *  timestamp is left alone — degrade, don't destroy; this log is the
   *  product's memory. Returns how many were removed so the caller can log it. */
  sweepRetention(days: number, now: number): number {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const sessions of this.projects.values()) {
      for (const session of sessions.values()) {
        if (session.events.length <= 1) continue;
        const keep = session.events.filter((stored, index) => {
          if (index === session.events.length - 1) return true;
          const ts = Date.parse(stored.event.ts);
          if (Number.isNaN(ts)) return true;
          return ts >= cutoff;
        });
        removed += session.events.length - keep.length;
        session.events = keep;
      }
    }
    return removed;
  }
```

`HubSession.events` must become mutable (`events: StoredEvent[]` already is; just ensure it is not `readonly`).

In `poc/hub/src/hub.ts`, store the frame and run the sweep on the existing throttled push rather than on a new timer:

```ts
      if (frame.t === "plugins") {
        store.setPlugins(uplinkId, frame.plugins, frame.enabled);
        schedulePush(projectId);
        return;
      }
```

```ts
  function pushProject(projectId: string): void {
    /* ... existing timer clearing ... */
    // Piggybacked on a push that already happens rather than given its own
    // interval: retention is a slow-moving bound, not a hot loop.
    const dropped = store.sweepRetention(hosts.settings().retentionDays, Date.now());
    if (dropped > 0) console.log(`retention: dropped ${dropped} event(s)`);
    const payload = store.snapshot(projectId);
    /* ... unchanged ... */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **113 passed** (107 + 6). The three v7b1 snapshot tests that assert `plugins: []` still pass — with no uplink reporting plugins, the union is empty.

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/hubStore.ts poc/hub/src/hub.ts poc/hub/test/hubStore.test.ts
git commit -m "feat(hub): union plugin rosters across laptops, and enforce retention (v7b3)"
```

---

### Task 6: Oversight on the hub, on the host's own key

`overseer.ts` already takes its summarizer and its digest source as constructor injections, so putting it on the hub is a wiring job rather than a rewrite. The key comes from host settings and nowhere else — this is the **one scoped exception** to "the hub holds no key" (spec §3.7), and it is scoped by construction: `tools: []`, `maxTurns: 1`, so the hub summarizes and never executes a tool.

**Files:**
- Modify: `poc/server/package.json` (export `./overseer`, `./digest`, `./models`), `poc/hub/src/hub.ts`
- Test: `poc/hub/test/hubOversight.test.ts`

**Interfaces:**
- Consumes: `Overseer`, `type Summarize` from `multiplayer-ai-server/overseer`; `HubStore.digestsFor`; `HostState.settings().oversight`.
- Produces: `HubOptions` gains `summarize?: Summarize` (injected in tests, exactly as `startServer` does) and `oversightDebounceMs?: number`. The snapshot's `oversight` field stops being hardcoded.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/hubOversight.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startHub } from "../src/hub.js";
import { RELAY_PROTOCOL_VERSION } from "multiplayer-ai-server/relayProtocol";
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authCfg = { clientId: "id", clientSecret: "s", sessionSecret: "testsecret", allowlist: "frankie" };
const cookieFor = (login: string) => `${SESSION_COOKIE}=${signSession(login, "testsecret")}`;

const digest = (sessionId: string) => ({
  sessionId, intent: `working on ${sessionId}`, ended: false,
  driverName: "ana", participants: ["ana"], recentTools: [], gatesPending: 0,
});

async function hubWithTwoLaptops(summarize: any) {
  const hub = await startHub({
    port: 0, host: "127.0.0.1", auth: authCfg, hostLogin: "frankie",
    summarize, oversightDebounceMs: 10,
  });
  const ups: WebSocket[] = [];
  for (const [id, repo, session] of [["lap-1", "github.com/acme/api", "auth"], ["lap-2", "github.com/acme/web", "ui"]] as const) {
    const up = new WebSocket(`ws://127.0.0.1:${hub.port}/uplink`);
    await new Promise<void>((r) => up.on("open", () => r()));
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: id, projectId: "default", repoKey: repo }));
    up.send(JSON.stringify({ t: "digest", sessionId: session, digest: digest(session) }));
    ups.push(up);
  }
  await wait(40);
  return { hub, ups };
}

async function setOversight(port: number, body: unknown) {
  await fetch(`http://127.0.0.1:${port}/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor("frankie") },
    body: JSON.stringify(body),
  });
}

describe("hub oversight", () => {
  it("summarizes across machines — the thing four separate servers could never do", async () => {
    const summarize = vi.fn(async (input: any) => `saw ${input.sessions.length} sessions`);
    const { hub, ups } = await hubWithTwoLaptops(summarize);
    close = hub.close;
    await setOversight(hub.port, { oversight: { enabled: true, apiKey: "sk-ant-test" } });
    await wait(120);

    expect(summarize).toHaveBeenCalled();
    // Two sessions from two different repos on two different laptops.
    expect(summarize.mock.calls[0][0].sessions.map((d: any) => d.sessionId).sort()).toEqual(["auth", "ui"]);
    for (const up of ups) up.close();
  });

  it("does nothing at all while the host has it switched off", async () => {
    // Off by default, and idle costs nothing — the same posture the local
    // overseer has always had.
    const summarize = vi.fn(async () => "should not happen");
    const { hub, ups } = await hubWithTwoLaptops(summarize);
    close = hub.close;
    await wait(120);
    expect(summarize).not.toHaveBeenCalled();
    for (const up of ups) up.close();
  });

  it("refuses to run with no key configured, and says so rather than failing silently", async () => {
    const summarize = vi.fn(async () => "nope");
    const { hub, ups } = await hubWithTwoLaptops(summarize);
    close = hub.close;
    await setOversight(hub.port, { oversight: { enabled: true } }); // enabled, no key
    await wait(120);
    expect(summarize).not.toHaveBeenCalled();

    const res = await fetch(`http://127.0.0.1:${hub.port}/settings`, { headers: { cookie: cookieFor("frankie") } });
    expect((await res.json()).oversight).toEqual({ enabled: true, apiKeySet: false });
    for (const up of ups) up.close();
  });

  it("puts the summary on the project snapshot for every watcher", async () => {
    const { hub, ups } = await hubWithTwoLaptops(async () => "the team is doing two things");
    close = hub.close;
    await setOversight(hub.port, { oversight: { enabled: true, apiKey: "sk-ant-test" } });

    const browser = new WebSocket(`ws://127.0.0.1:${hub.port}/`, { headers: { cookie: cookieFor("frankie") } });
    await new Promise<void>((r) => browser.on("open", () => r()));
    const seen: any[] = [];
    browser.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(250);

    const latest = seen.filter((m) => m.type === "project").at(-1);
    expect(latest.oversight.enabled).toBe(true);
    expect(latest.oversight.latest.text).toBe("the team is doing two things");
    browser.close();
    for (const up of ups) up.close();
  });

  it("never puts the key on the wire", async () => {
    const { hub, ups } = await hubWithTwoLaptops(async () => "summary");
    close = hub.close;
    await setOversight(hub.port, { oversight: { enabled: true, apiKey: "sk-ant-VERYSECRET" } });
    const browser = new WebSocket(`ws://127.0.0.1:${hub.port}/`, { headers: { cookie: cookieFor("frankie") } });
    await new Promise<void>((r) => browser.on("open", () => r()));
    const seen: any[] = [];
    browser.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(250);
    expect(JSON.stringify(seen)).not.toContain("sk-ant-VERYSECRET");
    browser.close();
    for (const up of ups) up.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/hubOversight.test.ts`
Expected: FAIL — `startHub` has no `summarize` option and the snapshot's oversight is hardcoded.

- [ ] **Step 3: Extend the export seam**

Add to `poc/server/package.json`'s `exports`:

```json
    "./overseer": { "types": "./dist/overseer.d.ts", "default": "./dist/overseer.js" },
    "./digest": { "types": "./dist/digest.d.ts", "default": "./dist/digest.js" },
    "./models": { "types": "./dist/models.d.ts", "default": "./dist/models.js" },
```

- [ ] **Step 4: Wire the overseer into the hub**

In `poc/hub/src/hub.ts`:

```ts
  /** The one scoped exception to "the hub holds no key" (spec §3.7). Scoped by
   *  construction, not by promise: the summarizer runs with `tools: []` and
   *  `maxTurns: 1`, so the hub summarizes and never executes a tool. The key is
   *  read from host settings at call time — a host who clears it stops the next
   *  refresh, not the one after that. */
  const summarize: Summarize = opts.summarize ?? (async (input) => {
    const key = hosts.settings().oversight.apiKey;
    if (!key) throw new Error("no oversight key configured");
    return runOversightSummarize(input, {
      // Options.env REPLACES the subprocess environment rather than extending
      // it (sdk.d.ts:1416-1432), so PATH and HOME must be spread back in or
      // the process will not launch at all.
      env: { ...process.env, ANTHROPIC_API_KEY: key },
    });
  });

  const overseer = new Overseer(
    summarize,
    (projectId) => store.digestsFor(projectId),
    (projectId) => pushProject(projectId), // deliberate refresh — immediate push
    opts.oversightDebounceMs,
  );
```

Gate it on host settings rather than on the per-project toggle the local server uses — on a hub, oversight is host-configured (spec §3.7):

```ts
  /** Enabled only when the host has both switched it on AND supplied a key.
   *  Enabled-without-a-key is a real state a host can reach through the
   *  settings screen, and it must read as "not running" rather than throwing
   *  once per debounce. */
  const oversightLive = () =>
    hosts.settings().oversight.enabled && hosts.settings().oversight.apiKey !== null;
```

Notify on every stored digest and publish on the snapshot:

```ts
      if (frame.t === "digest") {
        store.setDigest(uplinkId, frame.sessionId, frame.digest);
        if (oversightLive()) overseer.setEnabled(projectId, true), overseer.notify(projectId);
        schedulePush(projectId);
        return;
      }
```

In `snapshot`'s caller, replace the hardcoded oversight field — `HubStore.snapshot` gains an optional `oversight` argument, mirroring how `projectSnapshot` already takes one:

```ts
    const payload = store.snapshot(projectId, {
      enabled: oversightLive(),
      latest: oversightLive() ? overseer.latest(projectId) : null,
    });
```

Dispose it in `close()`, before terminating clients:

```ts
        overseer.dispose();
```

`runOversightSummarize` needs to accept per-call options. It currently closes over the ambient environment; add an optional second parameter threaded into the SDK `query()` call, defaulting to today's behaviour so the local server is untouched.

- [ ] **Step 5: Run everything**

Run: `cd poc/server && npm run build && npx vitest run`
Expected: **404 passed**, unchanged — the `runOversightSummarize` signature change is additive.

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **118 passed** (113 + 5).

- [ ] **Step 6: Commit**

```bash
git add poc/server/package.json poc/server/src/overseer.ts poc/hub/src/hub.ts \
        poc/hub/src/hubStore.ts poc/hub/test/hubOversight.test.ts
git commit -m "feat(hub): host-configured oversight across machines, on the host's own key (v7b3)"
```

---

### Task 7: The client — host settings, and a picker that spans repos

Two pieces of client work. The settings screen is the host's control panel; the picker change is the first place a user actually *sees* that this is a hub and not a server.

**Files:**
- Create: `poc/client/src/repoGroup.ts`, `poc/client/src/components/HostSettings.tsx`
- Modify: `poc/client/src/components/SessionPicker.tsx`, `poc/client/src/authRoute.ts`, `poc/client/src/App.tsx`, `poc/client/src/terminal.css`
- Test: `poc/client/src/repoGroup.test.ts`, `poc/client/src/authRoute.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `repoLabel(key: string | null | undefined): string`
  - `groupByRepo<T extends { repoKey?: string | null }>(rows: T[]): { key: string; label: string; rows: T[] }[]`
  - `Screen` gains `"settings"`; `RouteInput` gains `wantsSettings: boolean`.

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/repoGroup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupByRepo, repoLabel } from "./repoGroup";

describe("repoLabel", () => {
  it("drops the host so the eye lands on the repo, not the forge", () => {
    // Every row on a typical hub starts "github.com/", so leading with it
    // wastes the most valuable characters in the line.
    expect(repoLabel("github.com/acme/api")).toBe("acme/api");
    expect(repoLabel("gitlab.example.com/team/thing")).toBe("team/thing");
  });

  it("keeps a bare key that has no path", () => {
    expect(repoLabel("weird-key")).toBe("weird-key");
  });

  it("renders a machine-local key as what it actually means", () => {
    // local:<host>:<hash> means "this repo has no origin", and the hash is
    // noise to a human. Say the true thing instead.
    expect(repoLabel("local:frankies-mac:a1b2c3d4e5f6")).toBe("no remote · frankies-mac");
  });

  it("has an honest label for a session with no repo key at all", () => {
    expect(repoLabel(null)).toBe("unknown repo");
    expect(repoLabel(undefined)).toBe("unknown repo");
  });
});

describe("groupByRepo", () => {
  it("groups sessions by repo and sorts groups by label", () => {
    const rows = [
      { id: "ui", repoKey: "github.com/acme/web" },
      { id: "auth", repoKey: "github.com/acme/api" },
      { id: "tokens", repoKey: "github.com/acme/api" },
    ];
    expect(groupByRepo(rows)).toEqual([
      { key: "github.com/acme/api", label: "acme/api", rows: [rows[1], rows[2]] },
      { key: "github.com/acme/web", label: "acme/web", rows: [rows[0]] },
    ]);
  });

  it("preserves the incoming order of rows within a group", () => {
    // The picker's own ordering is meaningful; grouping must not reshuffle it.
    const rows = [
      { id: "b", repoKey: "github.com/acme/api" },
      { id: "a", repoKey: "github.com/acme/api" },
    ];
    expect(groupByRepo(rows)[0].rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("puts everything in one group when they all share a repo", () => {
    // Which is exactly the standalone-server case, where the repo key is
    // constant — the picker must not sprout a pointless header there.
    const rows = [{ id: "a", repoKey: "k" }, { id: "b", repoKey: "k" }];
    expect(groupByRepo(rows)).toHaveLength(1);
  });

  it("collects missing keys under one honest bucket rather than dropping them", () => {
    const rows = [{ id: "a", repoKey: null }, { id: "b" }];
    const groups = groupByRepo(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("unknown repo");
    expect(groups[0].rows).toHaveLength(2);
  });
});
```

Append to `poc/client/src/authRoute.test.ts`:

```ts
describe("settings routing", () => {
  const signedIn = { status: "signed-in" as const, login: "frankie" };
  const base = {
    inviteToken: null, inviteTarget: null, activeSessionId: null, profile: null,
    pairCode: null, wantsDevices: false, wantsSettings: false,
  };

  it("shows settings on request", () => {
    expect(screenFor({ ...base, auth: signedIn, wantsSettings: true })).toBe("settings");
  });

  it("never shows settings to a signed-out or denied visitor", () => {
    expect(screenFor({ ...base, auth: { status: "signed-out" }, wantsSettings: true })).toBe("landing");
    expect(screenFor({ ...base, auth: { status: "denied", login: "m" }, wantsSettings: true })).toBe("denied");
  });

  it("keeps pairing ahead of settings — pairing is the one-shot action", () => {
    expect(screenFor({ ...base, auth: signedIn, wantsSettings: true, pairCode: "K7QM-3F2P" })).toBe("pair");
  });
});
```

As in v7b2 Task 7, **every pre-existing `RouteInput` literal in `authRoute.test.ts` gains `wantsSettings: false`** — a mechanical addition that changes no expectation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npx vitest run src/repoGroup.test.ts src/authRoute.test.ts`
Expected: FAIL — `repoGroup` does not resolve; `screenFor` returns `picker` for the settings cases.

- [ ] **Step 3: Write `repoGroup.ts`**

```ts
/** A repo key rendered for a human.
 *
 *  Every row on a typical hub starts "github.com/", so leading with the host
 *  wastes the most valuable characters in the line. A machine-local key
 *  (local:<host>:<hash>, produced when a repo has no origin — repoKey.ts) says
 *  what it actually means instead of showing a hash nobody can act on. */
export function repoLabel(key: string | null | undefined): string {
  if (!key) return "unknown repo";
  if (key.startsWith("local:")) {
    const [, host] = key.split(":");
    return host ? `no remote · ${host}` : "no remote";
  }
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

export interface RepoGroup<T> {
  key: string;
  label: string;
  rows: T[];
}

/** Groups rows by repo key, sorted by label. Order WITHIN a group is
 *  preserved: the picker's own ordering is meaningful and grouping must not
 *  reshuffle it. Rows with no key land in one honest bucket rather than
 *  vanishing — a session you cannot categorise is still a session. */
export function groupByRepo<T extends { repoKey?: string | null }>(rows: T[]): RepoGroup<T>[] {
  const groups = new Map<string, RepoGroup<T>>();
  for (const row of rows) {
    const key = row.repoKey ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: repoLabel(row.repoKey), rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
```

- [ ] **Step 4: Group the picker**

In `poc/client/src/components/SessionPicker.tsx`, wrap the existing row list in `groupByRepo(...)` and render a group header per repo — but **only when there is more than one group**. On a standalone server every session shares a repo key, so a single-group picker must look exactly as it does today rather than sprouting a pointless header:

```tsx
  const groups = groupByRepo(sessions);
  const showHeaders = groups.length > 1;
```

The header uses the pixel face at 9px, `--dim`, and a dashed rule — the same treatment `.roster` and `.thinking-head` already use, so it reads as part of the existing chrome rather than a new idea.

- [ ] **Step 5: Write the settings screen**

Create `poc/client/src/components/HostSettings.tsx`. It fetches `GET /settings`, renders the current values, and `POST`s a patch. Rules that are not optional:

- **No `<label>` wraps any control.** Every field is a `<span id="…">` plus `aria-labelledby` on the input. This screen has more form controls than anywhere else in the product, so it is where the rule earns its keep.
- **Non-hosts see the settings read-only**, with every control `disabled` and one line saying who the host is. The server enforces it anyway; the UI should not offer an action that will be refused.
- **The oversight key field renders empty with a placeholder of `key set` or `no key set`.** It is never populated from the server, because the server never sends it. Submitting an empty key field omits `apiKey` from the patch entirely rather than sending `null` — otherwise every unrelated save would silently wipe the key.
- **`TRANSFER HOST` asks for confirmation in a second click** ("this cannot be undone by you"), because it is the one control on the screen that removes the operator's own ability to use the screen.
- The allowlist is edited as one login per line in a `<textarea>`, split and trimmed on save.

- [ ] **Step 6: Wire `App.tsx`**

Add `wantsSettings` from `?screen=settings`, thread it into `screenFor` and add the branch. Add a `SETTINGS` control to the picker's chrome, visible to everyone (non-hosts get the read-only view).

- [ ] **Step 7: Run tests and build**

Run: `cd poc/client && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc clean, **206 passed** (195 + 8 repoGroup + 3 authRoute), build clean.

- [ ] **Step 8: Commit**

```bash
git add poc/client/src/repoGroup.ts poc/client/src/repoGroup.test.ts \
        poc/client/src/components/HostSettings.tsx poc/client/src/components/SessionPicker.tsx \
        poc/client/src/authRoute.ts poc/client/src/authRoute.test.ts \
        poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): host settings screen and a repo-grouped picker (v7b3)"
```

---

## Verification before calling v7b3 done

```bash
cd poc/server && npx tsc --noEmit && npx vitest run    # 404 passed
cd ../hub    && npx tsc --noEmit && npx vitest run     # 118 passed
cd ../client && npx tsc --noEmit && npx vitest run && npm run build   # 206 passed, build clean
```

- [ ] All three suites green, all typechecks clean, client build clean.
- [ ] `mpai` with **no** `--hub` still launches and runs a turn exactly as before.
- [ ] **The multi-repo walk, by hand — this is the first time the product does the thing v7 exists for.** Two repos on one machine is enough to prove it; two machines is better:
  1. `mpai --hub http://127.0.0.1:4000` in repo A, and again in repo B (different ports).
  2. One browser at the hub shows **both** sessions, grouped by repo, with the right labels.
  3. Take the wheel in each. Both work, both attributed correctly.
  4. Turn oversight on in SETTINGS with a real key. The summary mentions **both** repos — that is the thing four separate servers could never do.
  5. As host, close the session in repo B **without joining it**. It goes `closed` in the picker and repo B's `mpai` records `session_closed` attributed to you.
  6. As a non-host member, try the same. Refused.
  7. Turn `autoModeAllowed` off and confirm `M` cycling to AUTO is refused with the hub's message.
- [ ] **The non-capability, by hand:** as host, without joining a session, confirm there is no UI path and no socket message that prompts or approves in it. If you find one, that is a bug at the level of the product's central claim.
- [ ] **Grep for the key** after the oversight walk: `grep -riE "sk-ant" <captured output and any snapshot payload>` returns nothing.
- [ ] Transfer the host to a second account, confirm the first can no longer edit settings and the second can.
- [ ] `deploy/RUNBOOK.md` gains `HUB_HOST` and a short "first boot: claim the hub" note.

## Known bounds this plan ships with

- **Everything is in memory.** Host settings, seats, device records, the event log. A hub restart resets the lot and un-pairs every laptop. v7c is the fix and should land before any real beta.
- **Invites stay laptop-side** and `REQUIRE_INVITE` stays a laptop env var, which is a deliberate departure from spec §4 — see the scope note at the top.
- **`pull_oversight` still answers from the laptop's own overseer**, which sees only that machine's sessions. The hub's cross-machine summary is human-facing on the OVERSIGHT screen only. Wiring the hub summary into the agent's `<oversight>` injection needs a `summary` down-frame and is a protocol v3 item.
- **Seats are counted, never charged**, and the count is of distinct logins seen since boot — so it resets with the hub.
- **No audit log.** Who changed a setting, transferred the host role, closed a session or revoked a device is not recorded anywhere. Reading B work, and the first thing a real customer will ask for.
- **Retention deletes on a push**, so a completely idle hub never sweeps. Harmless (nothing is arriving either), but it means retention is a ceiling on active projects rather than a guarantee.
- **The host can lock out every member except themselves** by emptying the allowlist down to one name. Deliberate: it is their hub. The one thing they cannot do is lock out *themselves*.

## Deviations

*Fill this in during execution. Every divergence from the listings above, with the reason.*
