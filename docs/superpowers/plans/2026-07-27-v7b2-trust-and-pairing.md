# v7b2 — Trust, Device Pairing and the Security Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hub safe to put on the public internet — every browser authenticated by the hub, every laptop uplink provably owned by a known human and revocable, and the security requirements of spec §10 satisfied before anything is exposed.

**Architecture:** A2a's `auth.ts` moves to the hub through the export seam v7b1 built, so browsers sign in with GitHub at the hub and the hub — not the laptop — stamps every tunnelled command with a verified login. Laptops cannot do a cookie round trip, so they pair once: `mpai --hub <url>` prints a short code, a signed-in browser approves it, and the hub issues an opaque bearer whose **hash** it stores against a revocable device record. The bearer travels in the `Authorization` header, never a query string. The laptop's own gate logic, path containment and driver rules stay local and unchanged — trusting the hub for *identity* is not trusting it for *shape*.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `ws`, vitest, React 19. No new runtime dependencies.

## Global Constraints

- **Prerequisite: v7b1 is merged.** This plan starts from `poc/hub` existing, the relay working, and the export seam in `poc/server/package.json`. Baselines before Task 1: **server 385, hub 25, client 179**, all typechecks clean, client build clean.
- Spec authority: `docs/superpowers/specs/2026-07-27-v7-hub-architecture-design.md`. Read §3.5 (trust inversion), §10 (security requirements) and §11 (open questions) before starting.
- **`mpai` with no `--hub` still behaves exactly as today**, and no existing server test may be edited. Same invariant as v7b1, same reason (spec §6).
- **Server imports use `.js` specifiers** even for `.ts` sources (NodeNext). Client imports do not.
- Server tests in `poc/server/test/`, hub tests in `poc/hub/test/`, client tests co-located in `poc/client/src/`.
- **There is no client component-test infrastructure.** Extract client logic into pure modules and test there. Do not add a component test framework.
- **A `<label>` must never wrap a form control** — it forwards a second synthesized click and kills `<select>` dropdowns. Use a `<span>` + `aria-label`. This plan adds two screens, so it applies.
- **Never log a bearer token, a pairing code, or a cookie value.** Not at info, not at debug, not in an error path. Log the device id or the login instead.
- Do not run `git add -A`. Every commit spells out its paths.
- Never commit `market-research.md`, `poc/demo-plugins/`, or `tour-skill-suggest.png`.

### Decisions this plan makes, because the spec left them open

The spec's §11 leaves three questions unanswered and §3.7 has a business precondition. Rather than block, each is resolved here with its reasoning, so a reviewer can reject the *decision* in one place instead of finding it implied across eight tasks.

1. **Uplink token revocation (§11) → per-device records with an explicit revoke.** The hub stores one record per paired device (`id`, `login`, `label`, `createdAt`, `lastSeenAt`, `revokedAt`, `tokenHash`) and checks it on every uplink connect. Revoking also closes any live uplink immediately.
   *Why not short-lived tokens with refresh:* the requirement is "revoke a lost laptop," and expiry alone cannot do that before the expiry lands — you still need a revocation check, so refresh adds a flow without removing the list. Device records also give the human a screen worth looking at ("last seen 2m ago"), which a token blob does not.
   *Consequence accepted:* the hub holds a list of device records. It holds only a **hash** of each bearer, so a hub database leak does not yield usable uplink tokens.
2. **Revocation is self-service in v7b2.** You may list and revoke devices bound to **your own** GitHub login. Host-wide revoke needs the host role, which is v7b3. This keeps v7b2 free of a role that does not exist yet.
3. **Session close on reconnect (§11) → accept the close and surface it**, which is the spec's own proposed answer. A laptop returning to find its session closed does not resurrect it; the returning user is told. Implemented in v7b3 with hub-wide close; recorded here so the two plans do not answer it differently.
4. **Oversight's paid tier (§3.7) is not built.** The host-supplies-their-own-key arm is v7b3. The "we supply one" arm means reselling inference and needs a read of Anthropic's commercial terms — a business precondition, not a code blocker.

### Out of scope, do not build

The host role and host settings (v7b3) — the allowlist stays the `GITHUB_ALLOWLIST` env var in this plan and *moves* to host settings in v7b3. Hub-wide session close, per-laptop plugin rosters, oversight, seats (all v7b3). SQLite persistence (v7c) — device records and pairings live in memory here, which means **a hub restart un-pairs every laptop**; that is a stated bound below, and v7c fixes it. Handoff continuity (v7d). Collision detection (v7e).

---

### Task 1: `pairing.ts` — codes, devices and revocation, as pure logic

Everything security-relevant about pairing, with no sockets and no HTTP: code generation, the single-use TTL'd pairing record, brute-force resistance, token minting, hashed storage, and revocation. Clock and randomness are injected so every expiry and every collision is a test rather than a hope.

**Files:**
- Create: `poc/hub/src/pairing.ts`
- Test: `poc/hub/test/pairing.test.ts`

**Interfaces:**
- Consumes: `node:crypto` only.
- Produces:
  - `PAIRING_TTL_MS`, `MAX_CODE_ATTEMPTS`, `newPairingCode(random)`, `normalizeCode(raw)`
  - `class PairingStore` — `start(label)`, `claim(code, login)`, `poll(pairingId)`, `sweep()`
  - `class DeviceStore` — `issue(login, label)`, `verify(token)`, `listFor(login)`, `revoke(deviceId, login)`, `touch(deviceId, now)`
  - `interface Device { id, login, label, createdAt, lastSeenAt, revokedAt }` (note: **no token field** — only a hash is held internally)
  - Tasks 4, 5 and 7 consume these.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/pairing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DeviceStore,
  MAX_CODE_ATTEMPTS,
  PAIRING_TTL_MS,
  PairingStore,
  newPairingCode,
  normalizeCode,
} from "../src/pairing.js";

/** A deterministic byte source so code generation is testable. */
const bytes = (fill: number) => (n: number) => Buffer.alloc(n, fill);

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("pairing codes", () => {
  it("is 8 characters in two groups, from an alphabet with no lookalikes", () => {
    // A human transcribes this from a terminal into a browser. O/0 and I/1/L
    // in the same alphabet guarantee support tickets.
    const code = newPairingCode(bytes(7));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(code).not.toMatch(/[ILOU]/); // the four lookalikes, excluded by construction
  });

  it("normalizes case, spaces and a missing dash, because humans retype it", () => {
    expect(normalizeCode(" k7qm 3f2p ")).toBe("K7QM-3F2P");
    expect(normalizeCode("k7qm3f2p")).toBe("K7QM-3F2P");
    expect(normalizeCode("K7QM-3F2P")).toBe("K7QM-3F2P");
  });

  it("rejects anything that is not a code rather than guessing", () => {
    expect(normalizeCode("nope")).toBeNull();
    expect(normalizeCode("K7QM-3F2P-EXTRA")).toBeNull();
    expect(normalizeCode("KIQM-3F2P")).toBeNull(); // I is not in the alphabet
    expect(normalizeCode("")).toBeNull();
  });
});

describe("PairingStore", () => {
  it("issues a pending pairing that a signed-in human can claim once", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    const started = store.start("frankie-macbook");
    expect(store.poll(started.pairingId)).toEqual({ status: "pending" });

    expect(store.claim(started.code, "frankie")).toEqual({ ok: true, label: "frankie-macbook" });
    expect(store.poll(started.pairingId)).toEqual({ status: "approved", login: "frankie" });

    // Single use (spec §10.5): a replayed code must not approve a second device.
    expect(store.claim(started.code, "mallory")).toEqual({ ok: false, error: "unknown or expired code" });
  });

  it("expires a pairing after its TTL", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    const started = store.start("laptop");
    c.advance(PAIRING_TTL_MS + 1);
    expect(store.claim(started.code, "frankie")).toEqual({ ok: false, error: "unknown or expired code" });
    expect(store.poll(started.pairingId)).toEqual({ status: "expired" });
  });

  it("burns a code after too many wrong guesses", () => {
    // Short human-transcribed secrets are brute-forceable by construction
    // (spec §10.5). The per-code attempt cap is what makes 32^8 actually hold.
    const c = clock();
    const store = new PairingStore({ now: c.now });
    const started = store.start("laptop");
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      expect(store.claim("AAAA-BBBB", "mallory").ok).toBe(false);
    }
    // The real code is now refused too — the store stopped accepting guesses
    // at all, rather than only refusing the wrong ones.
    expect(store.claim(started.code, "frankie")).toEqual({ ok: false, error: "too many attempts — start again" });
  });

  it("reports an unknown pairingId as expired rather than leaking that it never existed", () => {
    const store = new PairingStore({ now: () => 0 });
    expect(store.poll("no-such-id")).toEqual({ status: "expired" });
  });

  it("sweeps expired pairings so the map does not grow without bound", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    store.start("a");
    store.start("b");
    c.advance(PAIRING_TTL_MS + 1);
    expect(store.sweep()).toBe(2);
    expect(store.sweep()).toBe(0);
  });
});

describe("DeviceStore", () => {
  it("issues a bearer that verifies, and never stores the bearer itself", () => {
    const c = clock();
    const store = new DeviceStore({ now: c.now });
    const { token, device } = store.issue("frankie", "frankie-macbook");

    expect(store.verify(token)).toEqual({ ok: true, device: expect.objectContaining({ login: "frankie" }) });
    // A hub database leak must not yield usable uplink tokens.
    expect(JSON.stringify(store.listFor("frankie"))).not.toContain(token);
    expect(Object.values(device)).not.toContain(token);
  });

  it("refuses a token it never issued, and a token for a revoked device", () => {
    const store = new DeviceStore({ now: () => 0 });
    const { token, device } = store.issue("frankie", "laptop");
    expect(store.verify("not-a-real-token")).toEqual({ ok: false, error: "unknown device token" });

    expect(store.revoke(device.id, "frankie")).toEqual({ ok: true });
    expect(store.verify(token)).toEqual({ ok: false, error: "this device has been revoked" });
  });

  it("will not let one login revoke another's device", () => {
    // Self-service revocation in v7b2 (host-wide revoke is v7b3). Without this
    // check the devices screen is an attack surface, not a control.
    const store = new DeviceStore({ now: () => 0 });
    const { device } = store.issue("frankie", "laptop");
    expect(store.revoke(device.id, "mallory")).toEqual({ ok: false, error: "unknown device" });
    expect(store.listFor("mallory")).toEqual([]);
  });

  it("lists only your own devices, newest first, with revoked ones still visible", () => {
    const c = clock();
    const store = new DeviceStore({ now: c.now });
    const first = store.issue("frankie", "old-laptop");
    c.advance(1000);
    store.issue("frankie", "new-laptop");
    store.issue("someone-else", "theirs");
    store.revoke(first.device.id, "frankie");

    const mine = store.listFor("frankie");
    expect(mine.map((d) => d.label)).toEqual(["new-laptop", "old-laptop"]);
    // Revoked devices stay listed: "I revoked that" is information the human
    // needs, and hiding it looks like the revoke failed.
    expect(mine[1].revokedAt).not.toBeNull();
  });

  it("records last-seen so a human can tell which laptop is which", () => {
    const c = clock();
    const store = new DeviceStore({ now: c.now });
    const { device } = store.issue("frankie", "laptop");
    c.advance(5000);
    store.touch(device.id, c.now());
    expect(store.listFor("frankie")[0].lastSeenAt).toBe(1_005_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/pairing.test.ts`
Expected: FAIL — `Failed to resolve import "../src/pairing.js"`.

- [ ] **Step 3: Write the implementation**

Create `poc/hub/src/pairing.ts`:

```ts
import crypto from "node:crypto";

/** Five minutes. Long enough to alt-tab and paste, short enough that an
 *  abandoned code is not sitting there tomorrow (spec §10.5). */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Wrong guesses before a code is burned outright. A short human-transcribed
 *  secret is brute-forceable by construction; the alphabet gives 32^8 ≈ 1.1e12
 *  and this cap is what stops that from being ground down. */
export const MAX_CODE_ATTEMPTS = 5;

/** Crockford-style: no I, L, O or U. A human retypes this from a terminal into
 *  a browser, and O/0 plus I/1/L in one alphabet guarantees support tickets. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export type RandomBytes = (n: number) => Buffer;

export function newPairingCode(random: RandomBytes = crypto.randomBytes): string {
  const raw = random(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[raw[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accepts what a human actually types — any case, stray spaces, no dash —
 *  and rejects everything else rather than guessing at a near-miss. */
export function normalizeCode(raw: string): string | null {
  const stripped = raw.replace(/[\s-]/g, "").toUpperCase();
  if (stripped.length !== 8) return null;
  const code = `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
  return CODE_RE.test(code) ? code : null;
}

interface Pairing {
  pairingId: string;
  code: string;
  label: string;
  createdAt: number;
  attempts: number;
  burned: boolean;
  approvedLogin: string | null;
}

export type ClaimResult = { ok: true; label: string } | { ok: false; error: string };
export type PollResult =
  | { status: "pending" }
  | { status: "approved"; login: string }
  | { status: "expired" };

export class PairingStore {
  private byId = new Map<string, Pairing>();
  private byCode = new Map<string, string>();
  private now: () => number;
  private random: RandomBytes;

  constructor(deps: { now?: () => number; random?: RandomBytes } = {}) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? crypto.randomBytes;
  }

  start(label: string): { pairingId: string; code: string; expiresAt: number } {
    this.sweep();
    // Retry on the astronomically unlikely collision rather than silently
    // handing two laptops the same code.
    let code = newPairingCode(this.random);
    while (this.byCode.has(code)) code = newPairingCode(this.random);
    const pairingId = this.random(24).toString("base64url");
    const createdAt = this.now();
    this.byId.set(pairingId, {
      pairingId,
      code,
      label: label.slice(0, 60),
      createdAt,
      attempts: 0,
      burned: false,
      approvedLogin: null,
    });
    this.byCode.set(code, pairingId);
    return { pairingId, code, expiresAt: createdAt + PAIRING_TTL_MS };
  }

  /** Called by a browser whose GitHub login is already verified. */
  claim(rawCode: string, login: string): ClaimResult {
    this.sweep();
    const code = normalizeCode(rawCode);
    // Count a malformed code as an attempt too: otherwise an attacker gets
    // unlimited free probes by sending garbage between real guesses.
    if (!code) {
      this.chargeAll();
      return { ok: false, error: "unknown or expired code" };
    }
    const pairingId = this.byCode.get(code);
    const pairing = pairingId ? this.byId.get(pairingId) : undefined;
    if (!pairing) {
      this.chargeAll();
      return { ok: false, error: "unknown or expired code" };
    }
    if (pairing.burned || pairing.attempts >= MAX_CODE_ATTEMPTS) {
      return { ok: false, error: "too many attempts — start again" };
    }
    if (pairing.approvedLogin !== null) {
      return { ok: false, error: "unknown or expired code" }; // single use
    }
    pairing.approvedLogin = login;
    // The code is spent the moment it is claimed; only the pairingId, which
    // the laptop holds privately, can still collect the token.
    this.byCode.delete(code);
    return { ok: true, label: pairing.label };
  }

  /** Wrong guesses are charged against every live pairing, because the guesser
   *  does not know which one they are attacking and neither do we. This is the
   *  per-hub rate limit spec §10.5 asks for, expressed where the state is. */
  private chargeAll(): void {
    for (const pairing of this.byId.values()) {
      pairing.attempts += 1;
      if (pairing.attempts >= MAX_CODE_ATTEMPTS) pairing.burned = true;
    }
  }

  poll(pairingId: string): PollResult {
    this.sweep();
    const pairing = this.byId.get(pairingId);
    // An unknown id reports "expired", not "no such pairing" — there is
    // nothing useful to learn from the difference.
    if (!pairing) return { status: "expired" };
    if (pairing.burned) return { status: "expired" };
    if (pairing.approvedLogin === null) return { status: "pending" };
    const login = pairing.approvedLogin;
    // Collected once. The laptop has its token now; the record is spent.
    this.byId.delete(pairingId);
    return { status: "approved", login };
  }

  /** Returns how many were removed, so a caller can log it. Lazy, no timers —
   *  same posture as invites.ts. */
  sweep(): number {
    const cutoff = this.now() - PAIRING_TTL_MS;
    let removed = 0;
    for (const [pairingId, pairing] of this.byId) {
      if (pairing.createdAt > cutoff) continue;
      this.byId.delete(pairingId);
      this.byCode.delete(pairing.code);
      removed += 1;
    }
    return removed;
  }
}

/** What a human sees on the devices screen. Deliberately carries no secret. */
export interface Device {
  id: string;
  login: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export type VerifyResult = { ok: true; device: Device } | { ok: false; error: string };

export class DeviceStore {
  private devices = new Map<string, Device>();
  /** sha256(token) → deviceId. The bearer itself is never stored, so a leak of
   *  this map does not yield a usable uplink token. */
  private byTokenHash = new Map<string, string>();
  private now: () => number;
  private random: RandomBytes;

  constructor(deps: { now?: () => number; random?: RandomBytes } = {}) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? crypto.randomBytes;
  }

  issue(login: string, label: string): { token: string; device: Device } {
    const token = this.random(32).toString("base64url");
    const device: Device = {
      id: this.random(8).toString("hex"),
      login,
      label: label.slice(0, 60),
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(device.id, device);
    this.byTokenHash.set(hash(token), device.id);
    return { token, device };
  }

  verify(token: string): VerifyResult {
    const deviceId = this.byTokenHash.get(hash(token));
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    if (!device) return { ok: false, error: "unknown device token" };
    if (device.revokedAt !== null) return { ok: false, error: "this device has been revoked" };
    return { ok: true, device };
  }

  /** Newest first. Revoked devices stay listed — "I revoked that" is
   *  information the human needs, and hiding it reads as a failed revoke. */
  listFor(login: string): Device[] {
    return [...this.devices.values()]
      .filter((d) => d.login === login)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Scoped to the owning login: without this the devices screen is an attack
   *  surface rather than a control. Host-wide revoke is v7b3. */
  revoke(deviceId: string, login: string): { ok: true } | { ok: false; error: string } {
    const device = this.devices.get(deviceId);
    // Same message for "not yours" and "does not exist" — a distinct error
    // would confirm the existence of another user's device id.
    if (!device || device.login !== login) return { ok: false, error: "unknown device" };
    if (device.revokedAt === null) device.revokedAt = this.now();
    return { ok: true };
  }

  touch(deviceId: string, now: number): void {
    const device = this.devices.get(deviceId);
    if (device) device.lastSeenAt = now;
  }
}

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run test/pairing.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Typecheck**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: clean, **38 passed** (25 + 13).

- [ ] **Step 6: Commit**

```bash
git add poc/hub/src/pairing.ts poc/hub/test/pairing.test.ts
git commit -m "feat(hub): pairing codes, device records and revocation as pure logic (v7b2)"
```

---

### Task 2: Hub configuration and the `/auth/*` routes

`auth.ts` is transport-agnostic and already exported through v7b1's seam, so this is wiring, not a rewrite (spec §3.5). The hub also gains a fail-fast config validator, modelled on `config.ts`'s injected-probe pattern, because a hub that boots half-configured and silently runs anonymous is the worst outcome available.

**Files:**
- Create: `poc/hub/src/hubConfig.ts`
- Modify: `poc/hub/src/hub.ts`, `poc/hub/src/main.ts`
- Test: `poc/hub/test/hubConfig.test.ts`, `poc/hub/test/httpSurface.test.ts` (add cases)

**Interfaces:**
- Consumes: `authRoutes`, `type AuthConfig` from `multiplayer-ai-server/auth`.
- Produces:
  - `validateHubConfig(env, hasIndexHtml): { ok: true; staticDir?: string; auth?: AuthConfig; origin?: string } | { ok: false; error: string }`
  - `HubOptions` gains `auth?: AuthConfig` and `origin?: string`.
  - Tasks 3, 4 and 8 read `opts.auth` and `opts.origin`.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/hubConfig.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateHubConfig } from "../src/hubConfig.js";

const hasIndex = () => true;
const full = {
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  SESSION_SECRET: "s".repeat(32),
  GITHUB_ALLOWLIST: "frankie",
};

describe("validateHubConfig", () => {
  it("builds an auth config from a complete environment", () => {
    const result = validateHubConfig({ ...full }, hasIndex);
    expect(result).toMatchObject({
      ok: true,
      auth: { clientId: "id", allowlist: "frankie" },
    });
  });

  it("refuses to boot a hub with no auth at all", () => {
    // This is the difference between the hub and the local server. `mpai` may
    // legitimately run anonymous on localhost; a hub is a shared surface on
    // the public internet and anonymous is never a valid state for it.
    const result = validateHubConfig({}, hasIndex);
    expect(result).toEqual({
      ok: false,
      error: "GITHUB_CLIENT_ID is required — a hub never runs without authentication",
    });
  });

  it("names the single missing variable rather than failing vaguely", () => {
    const { GITHUB_ALLOWLIST, ...partial } = full;
    expect(validateHubConfig(partial, hasIndex)).toEqual({
      ok: false,
      error: "GITHUB_ALLOWLIST is required — a hub never runs without authentication",
    });
  });

  it("trims values, because SECRET=$(cat file) leaves a newline", () => {
    // This exact failure cost real time on A2a: it passed validation and then
    // failed opaquely at GitHub as an invalid client_secret.
    const result = validateHubConfig({ ...full, GITHUB_CLIENT_SECRET: "secret\n" }, hasIndex);
    expect(result.ok && result.auth?.clientSecret).toBe("secret");
  });

  it("rejects a CLIENT_DIST with no index.html", () => {
    const result = validateHubConfig({ ...full, CLIENT_DIST: "/nope" }, () => false);
    expect(result).toEqual({
      ok: false,
      error: "CLIENT_DIST=/nope has no index.html — build the client first (cd poc/client && npm run build)",
    });
  });

  it("carries HUB_ORIGIN through for the Origin check in Task 8", () => {
    const result = validateHubConfig({ ...full, HUB_ORIGIN: "https://team.example.com " }, hasIndex);
    expect(result.ok && result.origin).toBe("https://team.example.com");
  });

  it("does not require an ANTHROPIC_API_KEY — the hub runs no agent", () => {
    // Spec §1. If this ever starts failing, someone has put an agent on the
    // hub and the whole security argument for v7 changed.
    expect(validateHubConfig({ ...full, CLIENT_DIST: "/dist" }, hasIndex).ok).toBe(true);
  });
});
```

Append to `poc/hub/test/httpSurface.test.ts`:

```ts
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

const authCfg = {
  clientId: "id",
  clientSecret: "secret",
  sessionSecret: "testsecret",
  allowlist: "frankie",
};

describe("hub auth routes", () => {
  it("answers /auth/me with the signed-in login", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const cookie = `${SESSION_COOKIE}=${signSession("frankie", "testsecret")}`;
    const res = await fetch(`http://127.0.0.1:${hub.port}/auth/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, login: "frankie", allowlisted: true });
  });

  it("answers /auth/me with 401 for a visitor with no cookie", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/auth/me`);
    expect(res.status).toBe(401);
  });

  it("serves /auth/me as JSON even with a client dist configured", async () => {
    // The SPA fallback returns index.html with a 200 for any extensionless
    // path, so an auth route registered after the static handler would leave
    // the client unable to tell "signed out" from "auth is broken". Assert the
    // BODY, not the status — this is the same trap A1a documented for
    // /healthz and A2a documented for /auth/*.
    const hub = await startHub({
      port: 0, host: "127.0.0.1", auth: authCfg,
      staticDir: new URL("./fixtures/dist", import.meta.url).pathname,
    });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/auth/me`);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).not.toContain("<html");
  });
});
```

Create the fixture the last test needs — `poc/hub/test/fixtures/dist/index.html`:

```html
<!doctype html><html><body>fixture spa</body></html>
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/hub && npx vitest run`
Expected: FAIL — `Failed to resolve import "../src/hubConfig.js"`, and `startHub` rejects the unknown `auth` option at type level.

- [ ] **Step 3: Write the implementation**

Create `poc/hub/src/hubConfig.ts`:

```ts
import type { AuthConfig } from "multiplayer-ai-server/auth";

export type HubConfigResult =
  | { ok: true; staticDir: string | undefined; auth: AuthConfig; origin: string | undefined }
  | { ok: false; error: string };

const AUTH_VARS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "GITHUB_ALLOWLIST",
] as const;

/** Validates a hub's configuration at boot.
 *
 *  The one place this deliberately differs from the local server's
 *  `validateProductionConfig`: auth is **not optional**. `mpai` may
 *  legitimately run anonymous on localhost, but a hub is a shared surface
 *  reachable from the internet and anonymous is never a valid state for it.
 *
 *  There is deliberately no ANTHROPIC_API_KEY check: the hub runs no agent and
 *  holds no key (spec §1). If that check ever becomes necessary, the security
 *  argument for the whole v7 topology has changed and the spec needs revisiting.
 *
 *  The filesystem probe is injected so this stays a pure function, testable
 *  without a temp dir or process.exit — same pattern as config.ts:12. */
export function validateHubConfig(
  env: Record<string, string | undefined>,
  hasIndexHtml: (dir: string) => boolean,
): HubConfigResult {
  for (const name of AUTH_VARS) {
    if (!(env[name] ?? "").trim()) {
      return {
        ok: false,
        error: `${name} is required — a hub never runs without authentication`,
      };
    }
  }

  const staticDir = env.CLIENT_DIST;
  if (staticDir && !hasIndexHtml(staticDir)) {
    return {
      ok: false,
      error: `CLIENT_DIST=${staticDir} has no index.html — build the client first (cd poc/client && npm run build)`,
    };
  }

  // Trimmed on assignment, not just in the check above: `SECRET=$(cat file)`
  // in an env file leaves a trailing newline, which passes validation and then
  // fails opaquely at GitHub as an invalid client_secret (A2a, cost real time).
  return {
    ok: true,
    staticDir,
    auth: {
      clientId: env.GITHUB_CLIENT_ID!.trim(),
      clientSecret: env.GITHUB_CLIENT_SECRET!.trim(),
      sessionSecret: env.SESSION_SECRET!.trim(),
      allowlist: env.GITHUB_ALLOWLIST!.trim(),
      callbackUrl: env.OAUTH_CALLBACK_URL?.trim() || undefined,
    },
    origin: env.HUB_ORIGIN?.trim() || undefined,
  };
}
```

In `poc/hub/src/hub.ts`, extend `HubOptions` and register the auth routes **between** `/healthz` and the static handler:

```ts
export interface HubOptions {
  port: number;
  host?: string;
  staticDir?: string;
  /** Always set in production. Optional here only so v7b1's transport tests,
   *  which predate auth, keep running unedited. */
  auth?: AuthConfig;
  /** The exact origin browsers are served from, e.g. "https://team.example.com".
   *  Task 8's WebSocket Origin check compares against it. */
  origin?: string;
}
```

and inside `startHub`, beside `serveStatic`:

```ts
  // Registered unconditionally so /auth/me can report {enabled:false} rather
  // than falling through to the SPA fallback, which would return index.html
  // with a 200 and leave the client unable to tell "auth is off" from "auth is
  // broken" (A2a spec §4.2).
  const handleAuth = authRoutes(opts.auth);
```

then in the request handler, immediately after the `/healthz` block and **before** `if (serveStatic)`:

```ts
    // Between healthz and static, for the same ordering reason: the SPA
    // fallback (staticFiles.ts:51-53) would otherwise swallow every /auth/*
    // path and answer it with HTML.
    if (handleAuth(req, res)) return;
```

Rewrite `poc/hub/src/main.ts` to fail fast:

```ts
import fs from "node:fs";
import path from "node:path";
import { startHub } from "./hub.js";
import { validateHubConfig } from "./hubConfig.js";

const config = validateHubConfig(process.env, (dir) =>
  fs.existsSync(path.join(dir, "index.html")),
);
if (!config.ok) {
  console.error(`config error: ${config.error}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 4000);
// Loopback by default so the deployed port is reachable only through the
// reverse proxy. Set HOST=0.0.0.0 for LAN access.
const host = process.env.HOST ?? "127.0.0.1";

const { port: actual } = await startHub({
  port,
  host,
  staticDir: config.staticDir,
  auth: config.auth,
  origin: config.origin,
});

console.log(`multiplayer-ai hub listening on http://${host}:${actual}`);
if (config.staticDir) console.log(`serving client from ${config.staticDir}`);
// Count, not contents: the journal is readable by anyone with box access and
// the roster of who can sign in is not something to print on every boot.
const listed = config.auth.allowlist.split(",").filter((e) => e.trim()).length;
console.log(`GitHub auth ON — ${listed} login(s) on the allowlist`);
if (!config.origin) {
  console.warn("HUB_ORIGIN not set — WebSocket Origin checking is DISABLED (see spec §10.6)");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run`
Expected: PASS, **48 passed** (38 + 7 config + 3 auth routes).

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/hubConfig.ts poc/hub/src/hub.ts poc/hub/src/main.ts \
        poc/hub/test/hubConfig.test.ts poc/hub/test/httpSurface.test.ts \
        poc/hub/test/fixtures/dist/index.html
git commit -m "feat(hub): fail-fast config and GitHub sign-in on the hub (v7b2)"
```

---

### Task 3: The trust inversion, made real

v7b1's hub stamped whatever identity the browser claimed. This replaces it with the cookie-verified GitHub login — and that one change is the difference between a seam and a control. It is the direct hub-side equivalent of `server.ts:353-357`, which is what closed A2a's whole-branch Critical 1.

**Files:**
- Modify: `poc/hub/src/hub.ts` (`handleBrowser`)
- Test: `poc/hub/test/routing.test.ts` (add a `describe`; do not edit existing cases)

**Interfaces:**
- Consumes: `requireAuth` from `multiplayer-ai-server/auth`.
- Produces: no new exports. The browser-facing protocol is unchanged; what changes is whose name is on it.

- [ ] **Step 1: Write the failing test**

Append to `poc/hub/test/routing.test.ts`:

```ts
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

const authCfg = {
  clientId: "id",
  clientSecret: "secret",
  sessionSecret: "testsecret",
  allowlist: "ana,ben",
};

function connectAs(url: string, login: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { cookie: `${SESSION_COOKIE}=${signSession(login, "testsecret")}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("hub identity stamping", () => {
  it("stamps the cookie-verified login and discards what the browser claimed", async () => {
    // Spec §3.5 rule 1, and the hub-side twin of server.ts:353-357. A browser
    // that claims to be someone else must have that claim thrown away, or the
    // product's central promise — every decision on the wire carries the name
    // of the human who made it — is false.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);

    const browser = await connectAs(`ws://127.0.0.1:${hub.port}/`, "ana");
    browser.send(JSON.stringify({
      type: "join", sessionId: "auth", projectId: "default",
      userId: "totally-not-ana", name: "Mallory",
    }));
    await wait(50);

    const tunnel = upSeen.find((f) => f.t === "tunnel");
    expect(tunnel.identity).toEqual({ userId: "ana", name: "ana" });
    expect(JSON.stringify(upSeen)).not.toContain("totally-not-ana");
    browser.close(); up.close();
  });

  it("refuses every message from a browser with no cookie", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    browser.send(JSON.stringify({ type: "peek", projectId: "default" }));
    await wait(50);

    expect(seen.every((m) => m.type === "error")).toBe(true);
    expect(seen[0].message).toBe("authentication required");
    // Nothing leaked: no snapshot, no replayed event, no roster of real logins.
    expect(seen.some((m) => m.type === "project" || m.type === "event")).toBe(false);
    browser.close(); up.close();
  });

  it("refuses a valid cookie for a login that is not on the allowlist", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const { up } = await attachedUplink(hub.port);
    const browser = await connectAs(`ws://127.0.0.1:${hub.port}/`, "mallory");
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "mallory", name: "m" }));
    await wait(50);
    expect(seen[0]).toEqual({ type: "error", message: "not on the allowlist" });
    browser.close(); up.close();
  });

  it("leaves the transport tests' anonymous behaviour intact when auth is unset", async () => {
    // v7b1's suite runs startHub with no auth. That path must keep working, or
    // 10 routing tests would have to be edited — which would mean this task
    // changed transport behaviour rather than adding a gate.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const { up, seen: upSeen } = await attachedUplink(hub.port);
    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    browser.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana" }));
    await wait(50);
    expect(upSeen.find((f) => f.t === "tunnel").identity).toEqual({ userId: "ana", name: "ana" });
    browser.close(); up.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/hub && npx vitest run test/routing.test.ts`
Expected: FAIL — the first test sees `totally-not-ana` stamped; the second gets a snapshot instead of an error.

- [ ] **Step 3: Write the implementation**

In `poc/hub/src/hub.ts`, add the import:

```ts
import { requireAuth } from "multiplayer-ai-server/auth";
```

Change `wss.on("connection")` to pass the cookie header down to `handleBrowser`:

```ts
  wss.on("connection", (socket: WebSocket, req) => {
    socket.on("error", () => {});
    if ((req.url ?? "/").startsWith("/uplink")) handleUplink(socket);
    // Captured once: the cookie cannot change for the life of this socket.
    else handleBrowser(socket, req.headers.cookie);
  });
```

Change `handleBrowser`'s signature and gate every message:

```ts
  function handleBrowser(socket: WebSocket, cookieHeader: string | undefined): void {
    const channelId = randomUUID();
    const channel: BrowserChannel = { channelId, socket, projectId: null, sessionId: null, identity: null };
    channels.set(channelId, channel);

    const error = (message: string) => send(socket, { type: "error", message });

    /** The one place a browser message is checked against the session cookie.
     *  With `opts.auth` undefined every request is admitted and the login is
     *  null, so the client-asserted identity is kept exactly as v7b1 did —
     *  which is what keeps the transport tests running unedited. With auth on,
     *  only a verified AND allowlisted login gets through. */
    const verified = (): { ok: true; login: string | null } | { ok: false } => {
      const check = requireAuth(cookieHeader, opts.auth);
      if (!check.ok) {
        error(check.error);
        return { ok: false };
      }
      return { ok: true, login: check.login };
    };

    const tunnel = (payload: unknown): void => { /* unchanged from v7b1 */ };

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return error("invalid JSON");
      }

      // Applied to EVERY message type, including the hub-handled ones. peek
      // and watch_project disclose the roster of real GitHub logins and every
      // session's intent line; leaving them open was A2a's whole-branch
      // Critical 2, and the hub is a bigger version of the same surface.
      const auth = verified();
      if (!auth.ok) return;

      if (msg.type === "join") {
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "default";
        if (!SLUG.test(projectId) || !SLUG.test(String(msg.sessionId ?? ""))) {
          return error("projectId and sessionId must be 1-40 chars of a-z, 0-9, -");
        }
        // The trust inversion (spec §3.5 rule 1). With auth on, the browser's
        // claimed userId and name are DISCARDED and replaced by the verified
        // GitHub login — the hub-side twin of server.ts:353-357. The display
        // name is locked to the same login because it is the string humans
        // actually read, so leaving it client-chosen would relocate the
        // impersonation rather than remove it.
        const userId = auth.login ?? String(msg.userId ?? "").slice(0, 64);
        const name = auth.login ?? String(msg.name ?? userId).slice(0, 40);
        if (!userId) return error("join requires userId");

        const owner = store.ownerOf(projectId, msg.sessionId);
        if (!owner || !uplinks.has(owner)) {
          return error(`no machine is running session "${msg.sessionId}" right now`);
        }
        channel.projectId = projectId;
        channel.sessionId = msg.sessionId;
        channel.identity = { userId, name };

        for (const stored of store.eventsFor(projectId, msg.sessionId, 0)) {
          send(socket, { type: "event", event: stored.event });
        }
        send(socket, store.snapshot(projectId));
        tunnel(msg);
        return;
      }

      /* HUB_HANDLED and the tunnel fallthrough are unchanged from v7b1 */
    });

    socket.on("close", () => { /* unchanged from v7b1 */ });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run`
Expected: PASS, **52 passed** (48 + 4). **The ten v7b1 routing tests must be unedited** — they call `startHub` with no `auth`, which `requireAuth` admits.

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/hub.ts poc/hub/test/routing.test.ts
git commit -m "feat(hub): stamp the cookie-verified login on every browser command (v7b2)"
```

---

### Task 4: Pairing and device HTTP routes

Four routes and their rules. `mpai` is not a browser and has no cookie round trip, so it exchanges a short code — approved in an already-signed-in browser tab — for a long-lived bearer (spec §3.5).

**The rule that shapes every route below: no secret ever travels in a query string** (spec §10.1). Query strings land in browser history, screen shares, `Referer` headers and any access log the operator later enables. That is why `/pair/poll` is a POST with a JSON body rather than the `GET /pair/poll?pairingId=…` it would obviously otherwise be.

**Files:**
- Create: `poc/hub/src/pairRoutes.ts`
- Modify: `poc/hub/src/hub.ts`
- Test: `poc/hub/test/pairRoutes.test.ts`

**Interfaces:**
- Consumes: `PairingStore`, `DeviceStore` (Task 1); `requireAuth` from `multiplayer-ai-server/auth`.
- Produces: `pairRoutes(deps): (req, res) => boolean` — the same "did I consume this request" shape as `authRoutes`. Task 5 (uplink auth) shares the `DeviceStore` instance; Task 7 (client screens) calls these routes.

Route table:

| Route | Auth | Body | Answers |
|---|---|---|---|
| `POST /pair/start` | none — the laptop has no credential yet | `{ label }` | `{ pairingId, code, expiresAt }` |
| `POST /pair/poll` | none — the `pairingId` is the credential | `{ pairingId }` | `{ status: "pending" \| "expired" }` or `{ status: "approved", token, deviceId }` |
| `POST /pair/claim` | **verified login required** | `{ code }` | `{ ok: true, label }` |
| `GET /devices` | verified login required | — | `{ devices: Device[] }` (yours only) |
| `POST /devices/revoke` | verified login required | `{ deviceId }` | `{ ok: true }` |

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/pairRoutes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startHub } from "../src/hub.js";
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const authCfg = {
  clientId: "id", clientSecret: "secret",
  sessionSecret: "testsecret", allowlist: "frankie,ana",
};

const cookieFor = (login: string) => `${SESSION_COOKIE}=${signSession(login, "testsecret")}`;

async function post(port: number, path: string, body: unknown, login?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(login ? { cookie: cookieFor(login) } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("pairing round trip", () => {
  it("turns a code approved in a browser into a bearer the laptop collects", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;

    // 1. The laptop asks for a code. No credential yet — that is the point.
    const started = await post(hub.port, "/pair/start", { label: "frankie-macbook" });
    expect(started.status).toBe(200);
    expect(started.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    // 2. Polling before approval says pending and hands out nothing.
    const pending = await post(hub.port, "/pair/poll", { pairingId: started.body.pairingId });
    expect(pending.body).toEqual({ status: "pending" });

    // 3. A signed-in human approves it.
    const claimed = await post(hub.port, "/pair/claim", { code: started.body.code }, "frankie");
    expect(claimed.body).toEqual({ ok: true, label: "frankie-macbook" });

    // 4. The laptop's next poll collects the bearer, once.
    const approved = await post(hub.port, "/pair/poll", { pairingId: started.body.pairingId });
    expect(approved.body.status).toBe("approved");
    expect(typeof approved.body.token).toBe("string");
    expect(approved.body.token.length).toBeGreaterThan(20);

    const again = await post(hub.port, "/pair/poll", { pairingId: started.body.pairingId });
    expect(again.body).toEqual({ status: "expired" });
  });

  it("refuses to claim a code without a verified login", async () => {
    // Anyone reaching the port could otherwise approve their own laptop.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const started = await post(hub.port, "/pair/start", { label: "laptop" });
    const claimed = await post(hub.port, "/pair/claim", { code: started.body.code });
    expect(claimed.status).toBe(401);
  });

  it("refuses to claim a code for a login that is not allowlisted", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const started = await post(hub.port, "/pair/start", { label: "laptop" });
    const claimed = await post(hub.port, "/pair/claim", { code: started.body.code }, "mallory");
    expect(claimed.status).toBe(403);
  });

  it("caps the number of pending pairings so an open route cannot grow memory", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    let last = { status: 200, body: null as any };
    for (let i = 0; i < 40; i++) last = await post(hub.port, "/pair/start", { label: `l${i}` });
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/too many pending/i);
  });

  it("never accepts a pairingId from the query string", async () => {
    // Spec §10.1. If this ever becomes a GET, the pairingId lands in history,
    // screen shares and every access log the operator later enables.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const res = await fetch(`http://127.0.0.1:${hub.port}/pair/poll?pairingId=anything`);
    expect(res.status).toBe(405);
  });
});

describe("device management", () => {
  it("lists only your own devices and revokes one", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const started = await post(hub.port, "/pair/start", { label: "frankie-macbook" });
    await post(hub.port, "/pair/claim", { code: started.body.code }, "frankie");
    const approved = await post(hub.port, "/pair/poll", { pairingId: started.body.pairingId });

    const mine = await fetch(`http://127.0.0.1:${hub.port}/devices`, { headers: { cookie: cookieFor("frankie") } });
    const listed = await mine.json();
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0].label).toBe("frankie-macbook");
    // The bearer is never handed back out after the one collection.
    expect(JSON.stringify(listed)).not.toContain(approved.body.token);

    const theirs = await fetch(`http://127.0.0.1:${hub.port}/devices`, { headers: { cookie: cookieFor("ana") } });
    expect((await theirs.json()).devices).toEqual([]);

    const revoked = await post(hub.port, "/devices/revoke", { deviceId: approved.body.deviceId }, "frankie");
    expect(revoked.body).toEqual({ ok: true });
  });

  it("will not let one login revoke another's device", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const started = await post(hub.port, "/pair/start", { label: "laptop" });
    await post(hub.port, "/pair/claim", { code: started.body.code }, "frankie");
    const approved = await post(hub.port, "/pair/poll", { pairingId: started.body.pairingId });

    const attempt = await post(hub.port, "/devices/revoke", { deviceId: approved.body.deviceId }, "ana");
    expect(attempt.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/hub && npx vitest run test/pairRoutes.test.ts`
Expected: FAIL — every route 404s through to the not-found handler.

- [ ] **Step 3: Write the implementation**

Create `poc/hub/src/pairRoutes.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAuth, type AuthConfig } from "multiplayer-ai-server/auth";
import type { DeviceStore, PairingStore } from "./pairing.js";

/** An unauthenticated route that allocates state needs a ceiling, or it is a
 *  memory-growth primitive for anyone who can reach the port. Expired records
 *  are swept first, so this only ever bites on genuinely concurrent pairings —
 *  and 32 concurrent pairings is far past any real team. */
export const MAX_PENDING_PAIRINGS = 32;

/** Bodies here are tiny; anything larger is not a pairing request. */
const MAX_BODY_BYTES = 4096;

export interface PairRouteDeps {
  pairings: PairingStore;
  devices: DeviceStore;
  auth: AuthConfig | undefined;
  now: () => number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  // Per-cookie and per-secret responses must never be reused for another
  // visitor — a shared cache without these could hand one user's device list,
  // or worse a bearer, to the next.
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "Cookie",
  });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
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

export function pairRoutes(
  deps: PairRouteDeps,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/$/, "") || "/";
    } catch {
      return false;
    }
    if (path !== "/devices" && !path.startsWith("/pair/") && path !== "/devices/revoke") {
      return false;
    }

    /** Returns the verified login, or answers the request and returns null. */
    const login = (): string | null => {
      const check = requireAuth(req.headers.cookie, deps.auth);
      if (!check.ok) {
        // 401 "sign in" vs 403 "signed in, not permitted" — the client renders
        // two genuinely different screens for these.
        json(res, check.error === "authentication required" ? 401 : 403, { error: check.error });
        return null;
      }
      // With auth off there is no login to scope devices by, and a device list
      // that is not scoped to a person is not a control.
      if (check.login === null) {
        json(res, 403, { error: "device pairing requires authentication" });
        return null;
      }
      return check.login;
    };

    if (path === "/pair/start") {
      if (req.method !== "POST") return methodNotAllowed(res);
      void readJson(req).then((body) => {
        const label = typeof (body as any)?.label === "string" ? (body as any).label : "unnamed device";
        if (pendingCount(deps) >= MAX_PENDING_PAIRINGS) {
          return json(res, 429, { error: "too many pending pairings — try again shortly" });
        }
        json(res, 200, deps.pairings.start(label));
      });
      return true;
    }

    if (path === "/pair/poll") {
      // POST, not GET, because the pairingId is a bearer and secrets never
      // travel in a query string (spec §10.1).
      if (req.method !== "POST") return methodNotAllowed(res);
      void readJson(req).then((body) => {
        const pairingId = typeof (body as any)?.pairingId === "string" ? (body as any).pairingId : "";
        const result = deps.pairings.poll(pairingId.slice(0, 64));
        if (result.status !== "approved") return json(res, 200, result);
        // Minted at collection, not at claim: the token exists for exactly as
        // long as it takes to reach the laptop that asked for it.
        const { token, device } = deps.devices.issue(result.login, labelOf(deps, pairingId));
        json(res, 200, { status: "approved", token, deviceId: device.id, login: result.login });
      });
      return true;
    }

    if (path === "/pair/claim") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const who = login();
      if (!who) return true;
      void readJson(req).then((body) => {
        const code = typeof (body as any)?.code === "string" ? (body as any).code : "";
        const result = deps.pairings.claim(code.slice(0, 32), who);
        json(res, result.ok ? 200 : 400, result);
      });
      return true;
    }

    if (path === "/devices") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const who = login();
      if (!who) return true;
      json(res, 200, { devices: deps.devices.listFor(who) });
      return true;
    }

    if (path === "/devices/revoke") {
      if (req.method !== "POST") return methodNotAllowed(res);
      const who = login();
      if (!who) return true;
      void readJson(req).then((body) => {
        const deviceId = typeof (body as any)?.deviceId === "string" ? (body as any).deviceId : "";
        const result = deps.devices.revoke(deviceId.slice(0, 64), who);
        json(res, result.ok ? 200 : 404, result);
      });
      return true;
    }

    json(res, 404, { error: "unknown route" });
    return true;
  };
}

function methodNotAllowed(res: ServerResponse): boolean {
  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  res.end("method not allowed");
  return true;
}
```

`pendingCount` and `labelOf` need state the `PairingStore` owns, so add two small accessors to `poc/hub/src/pairing.ts` rather than reaching into private fields:

```ts
  /** Live, unexpired pairings. Sweeps first so the count is honest. */
  pendingCount(): number {
    this.sweep();
    return this.byId.size;
  }

  /** The label declared at start(), for stamping onto the device record. */
  labelOf(pairingId: string): string {
    return this.byId.get(pairingId)?.label ?? "unnamed device";
  }
```

**`labelOf` must be read BEFORE `poll` deletes the record.** Reorder the `/pair/poll` handler accordingly:

```ts
        const label = deps.pairings.labelOf(pairingId.slice(0, 64));
        const result = deps.pairings.poll(pairingId.slice(0, 64));
        if (result.status !== "approved") return json(res, 200, result);
        const { token, device } = deps.devices.issue(result.login, label);
```

and drop the module-level `pendingCount`/`labelOf` helpers in favour of `deps.pairings.pendingCount()` / `deps.pairings.labelOf(...)`.

Wire it into `poc/hub/src/hub.ts`, constructing the stores once and registering the routes **after** `/auth/*` and **before** the static handler:

```ts
  const pairings = new PairingStore();
  const devices = new DeviceStore();
  const handlePair = pairRoutes({ pairings, devices, auth: opts.auth, now: Date.now });
```

```ts
    if (handleAuth(req, res)) return;
    // Before the static handler, same SPA-fallback reason as every route above.
    if (handlePair(req, res)) return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run`
Expected: PASS, **59 passed** (52 + 7).

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/pairRoutes.ts poc/hub/src/pairing.ts poc/hub/src/hub.ts \
        poc/hub/test/pairRoutes.test.ts
git commit -m "feat(hub): device pairing and revocation routes (v7b2)"
```

---

### Task 5: Authenticate the uplink, and make revocation bite

Every uplink must be provably owned by a known human, and revoking a lost laptop must kick it off *now*, not at some expiry. This is also where a subtle v7b1 hole closes: `hello` carries a client-chosen `uplinkId`, so two laptops could claim the same one. With auth on, the hub derives the uplink identity from the **device record** and ignores what the frame claimed (spec §3.5 rule 2).

**Files:**
- Modify: `poc/hub/src/hub.ts` (`handleUplink`), `poc/hub/src/pairRoutes.ts` (revoke callback)
- Test: `poc/hub/test/uplinkAuth.test.ts`

**Interfaces:**
- Consumes: `DeviceStore.verify` / `.touch` (Task 1).
- Produces: `PairRouteDeps` gains `onRevoke: (deviceId: string) => void`. No other new exports.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/uplinkAuth.test.ts`:

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
const authCfg = { clientId: "id", clientSecret: "s", sessionSecret: "testsecret", allowlist: "frankie" };
const cookieFor = (login: string) => `${SESSION_COOKIE}=${signSession(login, "testsecret")}`;

async function post(port: number, path: string, body: unknown, login?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(login ? { cookie: cookieFor(login) } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Complete the whole pairing dance and return the bearer. */
async function pair(port: number, label = "frankie-macbook") {
  const started: any = await post(port, "/pair/start", { label });
  await post(port, "/pair/claim", { code: started.code }, "frankie");
  return (await post(port, "/pair/poll", { pairingId: started.pairingId })) as any;
}

function uplink(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/uplink`, {
      // Authorization header, never a query string (spec §10.1).
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("uplink authentication", () => {
  it("accepts a paired device's bearer", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const { token } = await pair(hub.port);

    const up = await uplink(hub.port, token);
    const seen: any[] = [];
    up.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "whatever", projectId: "default", repoKey: "k" }));
    await wait(50);
    expect(seen[0].t).toBe("welcome");
    up.close();
  });

  it("closes an uplink with no bearer at all", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const up = await uplink(hub.port);
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    expect(await closed).toBe(1008);
  });

  it("closes an uplink whose bearer it never issued", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const up = await uplink(hub.port, "made-up-token");
    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    expect(await closed).toBe(1008);
  });

  it("ignores the uplinkId in the frame and uses the device's own id", async () => {
    // Otherwise two laptops could both claim "lap-1" and each would be able to
    // publish for the other's sessions (spec §3.5 rule 2).
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const a = await pair(hub.port, "laptop-a");
    const b = await pair(hub.port, "laptop-b");

    const upA = await uplink(hub.port, a.token);
    const upB = await uplink(hub.port, b.token);
    upA.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "same", projectId: "default", repoKey: "k" }));
    upB.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "same", projectId: "default", repoKey: "k" }));
    await wait(40);

    const facts = (id: string) => ({
      id, participants: [], driverName: null, intent: null, lastActivityTs: null,
      ended: false, pendingGate: null, skills: [], repoKey: "k", lifecycle: "open",
    });
    upA.send(JSON.stringify({ t: "facts", sessionId: "auth", runId: "r", facts: facts("auth") }));
    await wait(40);

    // If both were "same", B would now own A's session and this publish would
    // be accepted. It must not be.
    const closedB = new Promise<number>((r) => upB.on("close", (code) => r(code)));
    upB.send(JSON.stringify({ t: "facts", sessionId: "auth", runId: "r", facts: facts("auth") }));
    expect(await closedB).toBe(1008);
    upA.close();
  });

  it("records last-seen on the device when its uplink says hello", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const { token } = await pair(hub.port);
    const up = await uplink(hub.port, token);
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "x", projectId: "default", repoKey: "k" }));
    await wait(50);

    const res = await fetch(`http://127.0.0.1:${hub.port}/devices`, { headers: { cookie: cookieFor("frankie") } });
    const { devices } = (await res.json()) as any;
    expect(devices[0].lastSeenAt).not.toBeNull();
    up.close();
  });

  it("kicks a live uplink off the moment its device is revoked", async () => {
    // A revocation that only takes effect on the next reconnect is not a
    // control — the lost laptop is connected right now.
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const { token, deviceId } = await pair(hub.port);
    const up = await uplink(hub.port, token);
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "x", projectId: "default", repoKey: "k" }));
    await wait(40);

    const closed = new Promise<number>((r) => up.on("close", (code) => r(code)));
    await post(hub.port, "/devices/revoke", { deviceId }, "frankie");
    expect(await closed).toBe(1008);

    // And it cannot come back.
    await expect(uplink(hub.port, token).then((ws) => new Promise((r, j) => {
      ws.on("close", (code) => j(code));
      setTimeout(() => r("stayed open"), 100);
    }))).rejects.toBe(1008);
  });

  it("still accepts an unauthenticated uplink when the hub has no auth configured", async () => {
    // Keeps v7b1's transport suite running unedited.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const up = await uplink(hub.port);
    const seen: any[] = [];
    up.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    up.send(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-1", projectId: "default", repoKey: "k" }));
    await wait(50);
    expect(seen[0].t).toBe("welcome");
    up.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd poc/hub && npx vitest run test/uplinkAuth.test.ts`
Expected: FAIL — unauthenticated uplinks are welcomed and revocation does not close anything.

- [ ] **Step 3: Write the implementation**

In `poc/hub/src/hub.ts`, keep a device→socket map and change `handleUplink` to take the upgrade request:

```ts
  /** deviceId → its live uplink socket, so a revoke can close it immediately. */
  const socketsByDevice = new Map<string, WebSocket>();
```

```ts
  wss.on("connection", (socket: WebSocket, req) => {
    socket.on("error", () => {});
    if ((req.url ?? "/").startsWith("/uplink")) handleUplink(socket, req.headers.authorization);
    else handleBrowser(socket, req.headers.cookie);
  });
```

```ts
  function handleUplink(socket: WebSocket, authorization: string | undefined): void {
    let uplinkId: string | null = null;
    let projectId: string | null = null;
    let deviceId: string | null = null;

    // Authenticated at connect, before a single frame is read. With no auth
    // configured this is a no-op and v7b1's transport tests are untouched.
    if (opts.auth) {
      const match = /^Bearer (.+)$/i.exec(authorization ?? "");
      const check = match ? devices.verify(match[1]) : { ok: false as const, error: "device not paired" };
      if (!check.ok) {
        // Never echo the token, not even a prefix of it.
        socket.close(1008, check.error);
        return;
      }
      deviceId = check.device.id;
      // The frame's uplinkId is IGNORED and the device's own id is used
      // instead. Otherwise two laptops could both claim "lap-1", and each
      // could then publish for the other's sessions (spec §3.5 rule 2).
      uplinkId = check.device.id;
      devices.touch(check.device.id, Date.now());
      socketsByDevice.set(check.device.id, socket);
    }

    socket.on("message", (raw) => {
      /* ... parse and validate as in v7b1 ... */
      if (frame.t === "hello") {
        // With auth on, uplinkId was fixed at connect. With auth off it comes
        // from the frame, exactly as in v7b1.
        uplinkId = uplinkId ?? frame.uplinkId;
        projectId = frame.projectId;
        uplinks.set(uplinkId, socket);
        store.attach(uplinkId, frame.projectId, frame.repoKey);
        down(socket, { t: "welcome", v: RELAY_PROTOCOL_VERSION, have: store.resumeOffsets(uplinkId) });
        schedulePush(frame.projectId);
        return;
      }
      /* ... publish / facts / reply unchanged, except: ... */
      if (frame.t === "facts") {
        const result = store.setFacts(uplinkId, frame.sessionId, frame.runId, frame.facts);
        if (!result.ok) {
          // Log the uplink id, never a token.
          console.error(`uplink ${uplinkId}: ${result.error}`);
          socket.close(1008, result.error.slice(0, 100));
          return;
        }
        schedulePush(projectId);
        return;
      }
    });

    socket.on("close", () => {
      if (deviceId) socketsByDevice.delete(deviceId);
      if (!uplinkId) return;
      uplinks.delete(uplinkId);
      store.detach(uplinkId);
      if (projectId) schedulePush(projectId);
    });
  }
```

Wire the revoke callback where `pairRoutes` is constructed:

```ts
  const handlePair = pairRoutes({
    pairings,
    devices,
    auth: opts.auth,
    now: Date.now,
    // A revocation that only takes effect on the next reconnect is not a
    // control: the lost laptop is connected right now.
    onRevoke: (deviceId) => {
      socketsByDevice.get(deviceId)?.close(1008, "device revoked");
      socketsByDevice.delete(deviceId);
    },
  });
```

In `poc/hub/src/pairRoutes.ts`, add `onRevoke: (deviceId: string) => void;` to `PairRouteDeps` and call it on success:

```ts
        const result = deps.devices.revoke(deviceId.slice(0, 64), who);
        if (result.ok) deps.onRevoke(deviceId.slice(0, 64));
        json(res, result.ok ? 200 : 404, result);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd poc/hub && npx vitest run`
Expected: PASS, **66 passed** (59 + 7). v7b1's routing tests unedited.

- [ ] **Step 5: Commit**

```bash
git add poc/hub/src/hub.ts poc/hub/src/pairRoutes.ts poc/hub/test/uplinkAuth.test.ts
git commit -m "feat(hub): authenticate uplinks by device bearer and make revocation immediate (v7b2)"
```

---

### Task 6: The laptop side — pair once, then attach with a bearer

`mpai --hub` changes shape here, and the change is deliberate: v7b1 took a `ws://` URL because there was nothing but a socket. Pairing needs HTTP too, so the flag now takes the hub's **base URL** and both the REST base and the `wss://…/uplink` socket are derived from it. **This edits the four `--hub` tests v7b1 added** — that is expected and is the one place in this plan where an existing test legitimately changes, because the flag's contract changed.

**Files:**
- Create: `poc/server/src/hubToken.ts`, `poc/server/src/pairClient.ts`
- Modify: `poc/server/src/cli.ts`, `poc/server/src/relay.ts` (bearer on connect)
- Test: `poc/server/test/hubToken.test.ts`, `poc/server/test/pairClient.test.ts`, `poc/server/test/cli.test.ts` (edit the four `--hub` cases)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `hubUrls(base: string): { api: string; uplink: string } | null`
  - `readToken(origin, deps)`, `writeToken(origin, token, deps)` over `~/.mpai/hub.json`
  - `pairWithHub(api, label, deps): Promise<{ ok: true; token: string } | { ok: false; error: string }>`
  - `RelayOptions` gains `token?: string`.

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/hubToken.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hubUrls, readToken, writeToken } from "../src/hubToken.js";

/** In-memory fs so no test writes to a real home directory. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const modes: Record<string, number> = {};
  return {
    files,
    modes,
    deps: {
      home: "/home/frankie",
      readFileSync: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      writeFileSync: (p: string, data: string, opts?: { mode?: number }) => {
        files.set(p, data);
        if (opts?.mode !== undefined) modes[p] = opts.mode;
      },
      mkdirSync: () => {},
    },
  };
}

describe("hubUrls", () => {
  it("derives the api base and the uplink socket from one https base", () => {
    expect(hubUrls("https://team.example.com")).toEqual({
      api: "https://team.example.com",
      uplink: "wss://team.example.com/uplink",
    });
  });

  it("derives ws:// from http:// so localhost development works", () => {
    expect(hubUrls("http://127.0.0.1:4000")).toEqual({
      api: "http://127.0.0.1:4000",
      uplink: "ws://127.0.0.1:4000/uplink",
    });
  });

  it("tolerates a trailing slash and a path, keeping the path as a prefix", () => {
    expect(hubUrls("https://example.com/hub/")).toEqual({
      api: "https://example.com/hub",
      uplink: "wss://example.com/hub/uplink",
    });
  });

  it("rejects anything that is not an http(s) url", () => {
    // A ws:// url was v7b1's form and is now wrong; failing loudly beats
    // half-working, where the socket attaches and pairing silently cannot.
    expect(hubUrls("ws://team.example.com")).toBeNull();
    expect(hubUrls("team.example.com")).toBeNull();
    expect(hubUrls("")).toBeNull();
  });
});

describe("token storage", () => {
  it("round-trips a token keyed by hub origin", () => {
    const fs = fakeFs();
    writeToken("https://team.example.com", "tok-1", fs.deps);
    writeToken("http://127.0.0.1:4000", "tok-2", fs.deps);
    expect(readToken("https://team.example.com", fs.deps)).toBe("tok-1");
    expect(readToken("http://127.0.0.1:4000", fs.deps)).toBe("tok-2");
  });

  it("writes the store 0600 — it holds bearer tokens", () => {
    const fs = fakeFs();
    writeToken("https://team.example.com", "tok", fs.deps);
    expect(fs.modes["/home/frankie/.mpai/hub.json"]).toBe(0o600);
  });

  it("returns null for an unknown hub and for a corrupt store", () => {
    // A hand-mangled file must mean "pair again", not a crash on startup.
    expect(readToken("https://nope.example.com", fakeFs().deps)).toBeNull();
    const corrupt = fakeFs({ "/home/frankie/.mpai/hub.json": "{not json" });
    expect(readToken("https://team.example.com", corrupt.deps)).toBeNull();
  });
});
```

Create `poc/server/test/pairClient.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { pairWithHub } from "../src/pairClient.js";

describe("pairWithHub", () => {
  it("prints the code, polls, and returns the token once approved", async () => {
    const printed: string[] = [];
    const responses = [
      { pairingId: "pid", code: "K7QM-3F2P", expiresAt: 0 },
      { status: "pending" },
      { status: "approved", token: "the-bearer", deviceId: "d1", login: "frankie" },
    ];
    const post = vi.fn(async () => responses.shift());

    const result = await pairWithHub("https://team.example.com", "frankie-macbook", {
      post: post as any,
      print: (line) => printed.push(line),
      sleep: async () => {},
    });

    expect(result).toEqual({ ok: true, token: "the-bearer" });
    // The human has to read this off the terminal, so it must actually appear.
    expect(printed.join("\n")).toContain("K7QM-3F2P");
    expect(printed.join("\n")).toContain("/?pair=K7QM-3F2P");
    // Never print the bearer.
    expect(printed.join("\n")).not.toContain("the-bearer");
  });

  it("gives up with a clear message when the code expires", async () => {
    const post = vi.fn(async (path: string) =>
      path === "/pair/start"
        ? { pairingId: "pid", code: "AAAA-BBBB", expiresAt: 0 }
        : { status: "expired" },
    );
    const result = await pairWithHub("https://h", "l", {
      post: post as any,
      print: () => {},
      sleep: async () => {},
    });
    expect(result).toEqual({ ok: false, error: "pairing code expired — run mpai --hub again" });
  });

  it("reports a hub that cannot be reached rather than throwing", async () => {
    const post = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await pairWithHub("https://h", "l", {
      post: post as any,
      print: () => {},
      sleep: async () => {},
    });
    expect(result).toEqual({ ok: false, error: "could not reach the hub at https://h" });
  });
});
```

Append to `poc/server/test/relay.test.ts`:

```ts
describe("Relay rejection", () => {
  it("stops reconnecting when the hub closes with 1008, instead of hammering it", () => {
    // 1008 is the hub saying "this device is not welcome" — a revoked or
    // unknown bearer. Reconnecting on a timer would never succeed and would
    // pound the hub forever; the human has to run `mpai --hub` and re-pair.
    vi.useFakeTimers();
    const fake = fakeSocket();
    let connects = 0;
    const relay = relayWith(fake, {
      connect: () => { connects++; return fake.socket; },
      reconnectDelayMs: 500,
    });
    relay.start();
    fake.open();
    expect(connects).toBe(1);
    fake.dropWith(1008);
    vi.advanceTimersByTime(5000);
    expect(connects).toBe(1);
    vi.useRealTimers();
  });
});
```

This needs `fakeSocket` to be able to deliver a close code. Extend the helper already in this file:

```ts
    drop: () => handlers.get("close")?.(),
    dropWith: (code: number) => handlers.get("close")?.(code),
```

Edit the four `--hub` cases in `poc/server/test/cli.test.ts` to the new contract:

```ts
describe("--hub", () => {
  it("parses a hub base url", () => {
    expect(parseArgs(["--hub", "https://team.example.com"])).toMatchObject({
      cmd: "launch",
      hub: "https://team.example.com",
    });
  });

  it("requires a value", () => {
    expect(parseArgs(["--hub"]).error).toBe("--hub requires a url");
  });

  it("rejects a ws:// url — the flag takes the hub's base URL, not its socket", () => {
    // v7b1 took ws://; pairing needs HTTP as well, so the flag now takes the
    // base and derives both. Failing loudly beats attaching without pairing.
    expect(parseArgs(["--hub", "ws://team.example.com"]).error).toBe(
      "--hub requires an http:// or https:// url (the hub's address, e.g. https://team.example.com)",
    );
  });

  it("defaults to no hub, which is today's standalone behaviour", () => {
    expect(parseArgs([]).hub).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/server && npx vitest run test/hubToken.test.ts test/pairClient.test.ts test/cli.test.ts`
Expected: FAIL — the two new modules do not resolve, and the `--hub` error string does not match.

- [ ] **Step 3: Write `hubToken.ts`**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TokenDeps {
  home: string;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string, opts?: { mode?: number }) => void;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
}

/** Real filesystem, injected everywhere else so tests never touch a home dir. */
export const realTokenDeps: TokenDeps = {
  home: os.homedir(),
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, { encoding: "utf8", ...opts }),
  mkdirSync: (p, opts) => void fs.mkdirSync(p, opts),
};

/** One base URL in, both the REST base and the uplink socket out.
 *
 *  v7b1's --hub took a ws:// url because a socket was all there was. Pairing
 *  needs HTTP too, so the flag now takes the hub's address and this derives
 *  the rest — one thing for a human to know, and no way to point the two
 *  halves at different places. */
export function hubUrls(base: string): { api: string; uplink: string } | null {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const prefix = url.pathname.replace(/\/+$/, "");
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    api: `${url.protocol}//${url.host}${prefix}`,
    uplink: `${scheme}//${url.host}${prefix}/uplink`,
  };
}

function storePath(deps: TokenDeps): string {
  return path.join(deps.home, ".mpai", "hub.json");
}

function readAll(deps: TokenDeps): Record<string, string> {
  try {
    const parsed = JSON.parse(deps.readFileSync(storePath(deps)));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    // Missing or hand-mangled means "pair again", never a crash on startup.
    return {};
  }
}

export function readToken(origin: string, deps: TokenDeps = realTokenDeps): string | null {
  const value = readAll(deps)[origin];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function writeToken(origin: string, token: string, deps: TokenDeps = realTokenDeps): void {
  const all = readAll(deps);
  all[origin] = token;
  deps.mkdirSync(path.dirname(storePath(deps)), { recursive: true });
  // 0600: this file holds bearer tokens that attach a machine to a team's hub.
  deps.writeFileSync(storePath(deps), JSON.stringify(all, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 4: Write `pairClient.ts`**

```ts
/** How long to keep polling before giving up. Comfortably inside the hub's
 *  5-minute pairing TTL, so the hub's expiry is what a user actually hits. */
const POLL_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

export interface PairDeps {
  post: (path: string, body: unknown) => Promise<any>;
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export const realPairDeps = (api: string): PairDeps => ({
  post: async (path, body) => {
    const res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },
  print: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

export type PairResult = { ok: true; token: string } | { ok: false; error: string };

/** The whole pairing dance from the laptop's side.
 *
 *  No secret is ever pasted into a terminal (spec §3.5): the human carries a
 *  short code FROM the terminal TO an already-signed-in browser, and the
 *  bearer comes back over the wire to the process that asked for it. */
export async function pairWithHub(api: string, label: string, deps: PairDeps): Promise<PairResult> {
  let started: { pairingId?: string; code?: string };
  try {
    started = await deps.post("/pair/start", { label });
  } catch {
    return { ok: false, error: `could not reach the hub at ${api}` };
  }
  if (!started?.pairingId || !started?.code) {
    return { ok: false, error: "the hub refused to start a pairing — is it full?" };
  }

  deps.print("");
  deps.print(`  pair this machine — open ${api}/?pair=${started.code}`);
  deps.print(`  or go to ${api} and enter this code:`);
  deps.print("");
  deps.print(`      ${started.code}`);
  deps.print("");
  deps.print("  waiting for approval…");

  const deadline = POLL_TIMEOUT_MS / POLL_INTERVAL_MS;
  for (let i = 0; i < deadline; i++) {
    await deps.sleep(POLL_INTERVAL_MS);
    let polled: { status?: string; token?: string };
    try {
      polled = await deps.post("/pair/poll", { pairingId: started.pairingId });
    } catch {
      return { ok: false, error: `could not reach the hub at ${api}` };
    }
    if (polled?.status === "approved" && typeof polled.token === "string") {
      // Deliberately does NOT print the token.
      deps.print("  paired.");
      return { ok: true, token: polled.token };
    }
    if (polled?.status === "expired") {
      return { ok: false, error: "pairing code expired — run mpai --hub again" };
    }
  }
  return { ok: false, error: "pairing code expired — run mpai --hub again" };
}
```

- [ ] **Step 5: Wire the CLI and the relay**

In `poc/server/src/cli.ts`, change the `--hub` validation:

```ts
    } else if (flag === "--hub") {
      const value = rest.shift();
      if (!value) return { ...args, error: "--hub requires a url" };
      if (!/^https?:\/\//i.test(value)) {
        return {
          ...args,
          error: "--hub requires an http:// or https:// url (the hub's address, e.g. https://team.example.com)",
        };
      }
      args.hub = value;
```

and in `launch`, resolve the token before starting the server:

```ts
  let hub: { url: string; projectId: string; token: string } | undefined;
  if (args.hub) {
    const urls = hubUrls(args.hub);
    if (!urls) {
      console.error(`not a usable hub url: ${args.hub}`);
      return 1;
    }
    let token = readToken(urls.api);
    if (!token) {
      const paired = await pairWithHub(urls.api, `${os.hostname()} · ${path.basename(repoRoot)}`, realPairDeps(urls.api));
      if (!paired.ok) {
        console.error(paired.error);
        return 1;
      }
      writeToken(urls.api, paired.token);
      token = paired.token;
    }
    hub = { url: urls.uplink, projectId: args.project, token };
  }
```

then pass `hub` into `startServer` as before. Thread the token through `startServer`'s `hub` option into `RelayOptions`, and send it on connect in `relay.ts`'s `defaultConnect`:

```ts
export interface RelayOptions {
  hubUrl: string;
  projectId: string;
  repoKey: string;
  uplinkId: string;
  /** Device bearer from pairing. Sent as an Authorization header — never a
   *  query string, which would land in logs and screen shares (spec §10.1). */
  token?: string;
  connect?: ConnectFn;
  reconnectDelayMs?: number;
  newRunId?: () => string;
}
```

```ts
  private connect(): void {
    const connect = this.opts.connect ?? defaultConnect;
    const socket = connect(this.opts.hubUrl, this.opts.token);
    /* ... unchanged ... */
```

```ts
export type ConnectFn = (url: string, token?: string) => RelaySocket;

const defaultConnect: ConnectFn = (url, token) => {
  const socket = new WebSocket(url, {
    maxPayload: MAX_FRAME_BYTES,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    on: (event, fn) => void socket.on(event, fn as (...args: unknown[]) => void),
  };
};
```

**A revoked device must re-pair, not spin.** In `relay.ts`'s close handler, stop reconnecting when the hub closed with 1008:

```ts
    socket.on("close", (code) => {
      this.open = false;
      this.socket = null;
      for (const conn of this.channels.values()) conn.close();
      this.channels.clear();
      // 1008 is the hub saying "this device is not welcome" — not a network
      // blip. Reconnecting in a loop would hammer the hub and never succeed;
      // the human needs to run `mpai --hub` again and re-pair.
      if (code === 1008) {
        this.stopped = true;
        console.error("hub rejected this machine — run `mpai --hub <url>` to pair again");
        return;
      }
      this.scheduleReconnect();
    });
```

This requires `RelaySocket.on`'s callback to receive the close code; widen it to `(arg?: unknown) => void` calls with the code passed through, which the `ws` adapter already does.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, **396 passed** (385 + 7 hubToken + 3 pairClient + 1 relay-close, with the four `--hub` cases edited in place rather than added).

- [ ] **Step 7: Commit**

```bash
git add poc/server/src/hubToken.ts poc/server/src/pairClient.ts poc/server/src/cli.ts \
        poc/server/src/relay.ts poc/server/src/server.ts \
        poc/server/test/hubToken.test.ts poc/server/test/pairClient.test.ts poc/server/test/cli.test.ts
git commit -m "feat(cli): pair once with the hub and attach with a device bearer (v7b2)"
```

---

### Task 7: The client — approve a pairing, manage your devices

Two screens. Both are small, and both follow the house rule that logic lives in a tested pure module because there is no component-test infrastructure.

**Files:**
- Create: `poc/client/src/pairView.ts`, `poc/client/src/components/PairApprove.tsx`, `poc/client/src/components/Devices.tsx`
- Modify: `poc/client/src/authRoute.ts`, `poc/client/src/App.tsx`, `poc/client/src/terminal.css`
- Test: `poc/client/src/pairView.test.ts`, `poc/client/src/authRoute.test.ts` (add cases)

**Interfaces:**
- Consumes: `AuthState` from `./authState`.
- Produces:
  - `formatCodeInput(raw): string`, `isCompleteCode(raw): boolean`, `deviceLabel(device, now): string`
  - `Screen` gains `"pair"` and `"devices"`; `RouteInput` gains `pairCode: string | null` and `wantsDevices: boolean`.

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/pairView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deviceLabel, formatCodeInput, isCompleteCode } from "./pairView";

describe("formatCodeInput", () => {
  it("upper-cases and inserts the dash as the human types", () => {
    expect(formatCodeInput("k7qm3")).toBe("K7QM-3");
    expect(formatCodeInput("k7qm")).toBe("K7QM");
    expect(formatCodeInput("k7qm-3f2p")).toBe("K7QM-3F2P");
  });

  it("drops characters that are not in the alphabet instead of rejecting the keystroke", () => {
    // Rejecting mid-typing makes the field feel broken; silently dropping the
    // impossible characters is what every good code input does.
    expect(formatCodeInput("k7!qm 3f2p")).toBe("K7QM-3F2P");
    expect(formatCodeInput("IIII")).toBe("");
  });

  it("stops at eight characters", () => {
    expect(formatCodeInput("k7qm3f2pEXTRA")).toBe("K7QM-3F2P");
  });
});

describe("isCompleteCode", () => {
  it("is true only at a full eight characters", () => {
    expect(isCompleteCode("K7QM-3F2P")).toBe(true);
    expect(isCompleteCode("K7QM-3F2")).toBe(false);
    expect(isCompleteCode("")).toBe(false);
  });
});

describe("deviceLabel", () => {
  const base = { id: "d1", login: "frankie", label: "frankie-macbook", createdAt: 0, lastSeenAt: null, revokedAt: null };

  it("says never connected when it has not been seen", () => {
    expect(deviceLabel(base, 60_000)).toBe("frankie-macbook · never connected");
  });

  it("reads last seen in human units", () => {
    expect(deviceLabel({ ...base, lastSeenAt: 55_000 }, 60_000)).toBe("frankie-macbook · last seen 5s ago");
    expect(deviceLabel({ ...base, lastSeenAt: 0 }, 300_000)).toBe("frankie-macbook · last seen 5m ago");
  });

  it("says revoked, and says nothing else — the state that matters wins", () => {
    expect(deviceLabel({ ...base, lastSeenAt: 0, revokedAt: 1 }, 60_000)).toBe("frankie-macbook · REVOKED");
  });
});
```

Append to `poc/client/src/authRoute.test.ts`:

```ts
describe("pairing and devices routing", () => {
  const signedIn = { status: "signed-in" as const, login: "frankie" };
  const base = { inviteToken: null, inviteTarget: null, activeSessionId: null, profile: null, pairCode: null, wantsDevices: false };

  it("shows the pair screen to a signed-in visitor carrying a code", () => {
    expect(screenFor({ ...base, auth: signedIn, pairCode: "K7QM-3F2P" })).toBe("pair");
  });

  it("sends a signed-out visitor with a code to sign in first", () => {
    // Approving a pairing binds a laptop to YOUR identity, so it can only
    // happen from a verified session. The `next` round trip brings them back.
    expect(screenFor({ ...base, auth: { status: "signed-out" }, pairCode: "K7QM-3F2P" })).toBe("landing");
  });

  it("never shows the pair screen to a denied visitor", () => {
    expect(screenFor({ ...base, auth: { status: "denied", login: "m" }, pairCode: "K7QM-3F2P" })).toBe("denied");
  });

  it("shows devices on request, below pairing in precedence", () => {
    expect(screenFor({ ...base, auth: signedIn, wantsDevices: true })).toBe("devices");
    expect(screenFor({ ...base, auth: signedIn, wantsDevices: true, pairCode: "K7QM-3F2P" })).toBe("pair");
  });

  it("leaves every pre-existing route unchanged when neither is present", () => {
    expect(screenFor({ ...base, auth: signedIn })).toBe("picker");
    expect(screenFor({ ...base, auth: signedIn, activeSessionId: "auth" })).toBe("lobby");
  });
});
```

**Every pre-existing case in `authRoute.test.ts` must be updated to include the two new `RouteInput` fields**, because `RouteInput` is a required-field interface. That is a mechanical addition of `pairCode: null, wantsDevices: false` to each existing input literal — it changes no expectation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/client && npx vitest run src/pairView.test.ts src/authRoute.test.ts`
Expected: FAIL — `pairView` does not resolve; `screenFor` returns `picker` for the pair cases.

- [ ] **Step 3: Write `pairView.ts`**

```ts
/** Must match the hub's alphabet exactly (poc/hub/src/pairing.ts). Crockford
 *  style: no I, L, O or U, because a human is retyping this from a terminal. */
const ALPHABET = /[0-9A-HJKMNP-TV-Z]/;

/** Formats as the human types: upper-cases, drops impossible characters, and
 *  inserts the dash. Dropping beats rejecting the keystroke — a field that
 *  refuses input feels broken, and the dropped characters were never valid. */
export function formatCodeInput(raw: string): string {
  const kept = raw
    .toUpperCase()
    .split("")
    .filter((c) => ALPHABET.test(c))
    .slice(0, 8)
    .join("");
  return kept.length > 4 ? `${kept.slice(0, 4)}-${kept.slice(4)}` : kept;
}

export function isCompleteCode(raw: string): boolean {
  return formatCodeInput(raw).replace("-", "").length === 8;
}

export interface DeviceView {
  id: string;
  login: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

/** One line per device. Revoked wins outright: it is the only state where the
 *  rest of the line would be actively misleading. */
export function deviceLabel(device: DeviceView, now: number): string {
  if (device.revokedAt !== null) return `${device.label} · REVOKED`;
  if (device.lastSeenAt === null) return `${device.label} · never connected`;
  const ago = Math.max(0, now - device.lastSeenAt);
  const s = Math.floor(ago / 1000);
  if (s < 60) return `${device.label} · last seen ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${device.label} · last seen ${m}m ago`;
  return `${device.label} · last seen ${Math.floor(m / 60)}h ago`;
}
```

- [ ] **Step 4: Extend the router**

In `poc/client/src/authRoute.ts`:

```ts
export type Screen =
  | "checking"
  | "invite-signin"
  | "landing"
  | "denied"
  | "invite-landing"
  | "pair"
  | "devices"
  | "picker"
  | "lobby"
  | "session";

export interface RouteInput {
  auth: AuthState | null;
  inviteToken: string | null;
  inviteTarget: { projectId: string; sessionId: string } | null;
  activeSessionId: string | null;
  profile: Profile | null;
  /** From ?pair=CODE. Approving a pairing binds a laptop to the signed-in
   *  identity, so it sits BELOW the auth arms in precedence. */
  pairCode: string | null;
  wantsDevices: boolean;
}
```

and in `screenFor`, immediately after the `denied` arm and before the invite arm:

```ts
  // Below the auth arms and above everything else: a pairing must be approved
  // by a verified human, and it is a deliberate, one-shot action that should
  // not be buried under a session someone happens to have open.
  if (pairCode) return "pair";
  if (wantsDevices) return "devices";
```

- [ ] **Step 5: Write the two screens**

Create `poc/client/src/components/PairApprove.tsx`:

```tsx
import { useState } from "react";
import { formatCodeInput, isCompleteCode } from "../pairView";

/** Approves a laptop's pairing request under the signed-in identity.
 *
 *  No `<label>` wrapping the input: a wrapping label forwards a second
 *  synthesized click, which is what killed the AGENT model picker. A `<span>`
 *  plus aria-labelledby carries the accessible name instead. */
export function PairApprove(props: {
  login: string;
  initialCode: string | null;
  onDone: () => void;
}) {
  const [code, setCode] = useState(formatCodeInput(props.initialCode ?? ""));
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setState("sending");
    setError(null);
    try {
      const res = await fetch("/pair/claim", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok !== true) {
        setState("idle");
        setError(body.error ?? "that code was not accepted");
        return;
      }
      setState("done");
    } catch {
      setState("idle");
      setError("could not reach the hub");
    }
  };

  if (state === "done") {
    return (
      <div className="pairscreen">
        <h1 className="pairhead">MACHINE PAIRED</h1>
        <p className="pairbody">
          It is attached to this hub as <strong>{props.login}</strong>. Its terminal should say so too.
        </p>
        <button type="button" onClick={props.onDone}>CONTINUE</button>
      </div>
    );
  }

  return (
    <div className="pairscreen">
      <h1 className="pairhead">PAIR A MACHINE</h1>
      <p className="pairbody">
        Enter the code shown in the terminal running <code>mpai --hub</code>. It will be
        attached to this hub as <strong>{props.login}</strong>.
      </p>
      <span id="paircode-label" className="pairlabel">pairing code</span>
      <input
        aria-labelledby="paircode-label"
        className="paircode"
        value={code}
        autoFocus
        spellCheck={false}
        onChange={(e) => setCode(formatCodeInput(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isCompleteCode(code) && state === "idle") void approve();
        }}
      />
      {error && <p className="pairerror">{error}</p>}
      <button
        type="button"
        disabled={!isCompleteCode(code) || state === "sending"}
        onClick={() => void approve()}
      >
        {state === "sending" ? "APPROVING…" : "APPROVE"}
      </button>
      <button type="button" onClick={props.onDone}>CANCEL</button>
    </div>
  );
}
```

Create `poc/client/src/components/Devices.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { deviceLabel, type DeviceView } from "../pairView";

/** Your paired machines, and the one control that matters: revoke.
 *
 *  Revoked devices stay listed. "I revoked that" is information the human
 *  needs, and hiding the row reads as a failed revoke. */
export function Devices(props: { onDone: () => void }) {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/devices", { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "could not load your devices");
        return;
      }
      setDevices(body.devices ?? []);
    } catch {
      setError("could not reach the hub");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (deviceId: string) => {
    await fetch("/devices/revoke", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    void load();
  };

  return (
    <div className="devscreen">
      <h1 className="devhead">YOUR MACHINES</h1>
      {error && <p className="deverror">{error}</p>}
      {devices === null && !error && <p className="devbody">loading…</p>}
      {devices?.length === 0 && (
        <p className="devbody">
          No machines paired yet. Run <code>mpai --hub</code> in a repo to attach one.
        </p>
      )}
      <ul className="devlist">
        {devices?.map((device) => (
          <li key={device.id} className={device.revokedAt ? "devrow revoked" : "devrow"}>
            <span>{deviceLabel(device, Date.now())}</span>
            {device.revokedAt === null && (
              <button type="button" onClick={() => void revoke(device.id)}>REVOKE</button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={props.onDone}>BACK</button>
    </div>
  );
}
```

- [ ] **Step 6: Wire `App.tsx`**

Read `?pair=` alongside the existing `?invite=` parse, add `wantsDevices` from `?screen=devices`, pass both into `screenFor` (`App.tsx:107`), and add the two branches beside the existing screen branches (`App.tsx:107-130`). On `onDone`, clear the query parameter with `history.replaceState` so a reload does not re-show the screen — the same mechanism Task 8 uses for the invite token.

- [ ] **Step 7: Add the CSS**

Append to `poc/client/src/terminal.css`, reusing the existing tokens — `--panel` for the card, `--frame` for the 2px border, `--chunk` for the hard offset shadow, `--gold` for the heading, `--red` for `.deverror` and `.devrow.revoked`, `--accent` only on APPROVE, which is the one "you can act here" control on the screen. The `.paircode` input uses the pixel face at 24px with `letter-spacing: 0.2em` — the code is chrome, and this is the one place in the product where a large pixel-face string is the content a human is working with.

- [ ] **Step 8: Run tests and build**

Run: `cd poc/client && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc clean, **191 passed** (179 + 7 pairView + 5 authRoute), build clean.

- [ ] **Step 9: Commit**

```bash
git add poc/client/src/pairView.ts poc/client/src/pairView.test.ts \
        poc/client/src/authRoute.ts poc/client/src/authRoute.test.ts \
        poc/client/src/components/PairApprove.tsx poc/client/src/components/Devices.tsx \
        poc/client/src/App.tsx poc/client/src/terminal.css
git commit -m "feat(client): pairing approval and device management screens (v7b2)"
```

---

### Task 8: The §10 sweep

The remaining security requirements, done together because each is small and leaving any one out means the hub still cannot be exposed.

**Files:**
- Modify: `poc/hub/src/hub.ts` (Origin check, field bounds, per-IP rate limit), `poc/client/src/authState.ts` + `poc/client/src/components/InviteSignIn.tsx` + `poc/client/src/App.tsx` (invite token hygiene)
- Test: `poc/hub/test/securityFloor.test.ts`, `poc/client/src/authState.test.ts` (add cases)

**Interfaces:**
- Produces: `stripSecrets(next: string): string` in `authState.ts`. No other new exports.

- [ ] **Step 1: Write the failing test**

Create `poc/hub/test/securityFloor.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHub } from "../src/hub.js";
import { signSession, SESSION_COOKIE } from "multiplayer-ai-server/auth";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authCfg = { clientId: "id", clientSecret: "s", sessionSecret: "testsecret", allowlist: "ana" };
const cookie = () => `${SESSION_COOKIE}=${signSession("ana", "testsecret")}`;

describe("Origin checking", () => {
  it("refuses a browser socket from another origin", async () => {
    // Cross-site WebSocket hijacking is blocked today by SameSite=Lax alone.
    // Once the cookie confers identity across a whole team, an explicit origin
    // check stops being defence in depth and becomes a control (spec §10.6).
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg, origin: "https://team.example.com" });
    close = hub.close;
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/`, {
      headers: { cookie: cookie(), origin: "https://evil.example.com" },
    });
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1008);
  });

  it("accepts a browser socket from the configured origin", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg, origin: "https://team.example.com" });
    close = hub.close;
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/`, {
      headers: { cookie: cookie(), origin: "https://team.example.com" },
    });
    await new Promise<void>((r) => ws.on("open", () => r()));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("does not apply the origin check to uplinks, which are not browsers", async () => {
    // `mpai` sends no Origin. Requiring one would break every laptop while
    // protecting nothing — an uplink is gated by its bearer, not by CORS.
    const hub = await startHub({ port: 0, host: "127.0.0.1", origin: "https://team.example.com" });
    close = hub.close;
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/uplink`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("skips the check entirely when no origin is configured", async () => {
    // Local development has no fixed origin; failing closed here would make
    // the hub unusable on a laptop. main.ts warns loudly instead.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/`, { headers: { origin: "http://anywhere" } });
    await new Promise<void>((r) => ws.on("open", () => r()));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe("field bounds", () => {
  it("rejects an over-long field instead of letting it into the event log", async () => {
    // server.ts type-checks userId and stops there. With auth on it is
    // overwritten, but every OTHER field flows onward into snapshots and
    // digests unbounded (spec §10.3).
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/`, { headers: { cookie: cookie() } });
    await new Promise<void>((r) => ws.on("open", () => r()));
    const seen: any[] = [];
    ws.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({ type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana", stray: "x".repeat(200_000) }));
    await wait(50);
    expect(seen[0]).toEqual({ type: "error", message: "message too large" });
    ws.close();
  });

  it("rejects a frame over maxPayload before any gate runs", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/`, { headers: { cookie: cookie() } });
    await new Promise<void>((r) => ws.on("open", () => r()));
    const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
    ws.send(JSON.stringify({ type: "join", pad: "x".repeat(2_000_000) }));
    // 1009 = message too big. The `ws` default of 100MB would have accepted it.
    expect(await closed).toBe(1009);
  });
});

describe("pair route rate limiting", () => {
  it("throttles repeated claim attempts from one peer", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", auth: authCfg });
    close = hub.close;
    let last = 0;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`http://127.0.0.1:${hub.port}/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie() },
        body: JSON.stringify({ code: "AAAA-BBBB" }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
```

Append to `poc/client/src/authState.test.ts`:

```ts
import { stripSecrets } from "./authState";

describe("stripSecrets", () => {
  it("removes an invite token from a post-login destination", () => {
    // The token rides ?invite= and is propagated into /auth/login?next=…,
    // so it lands in browser history and any Referer header (spec §10.1).
    expect(stripSecrets("/?session=auth&invite=abc123&name=ana")).toBe("/?session=auth&name=ana");
  });

  it("removes a pairing code too", () => {
    expect(stripSecrets("/?pair=K7QM-3F2P")).toBe("/");
  });

  it("leaves an ordinary destination alone", () => {
    expect(stripSecrets("/?session=auth&project=p")).toBe("/?session=auth&project=p");
    expect(stripSecrets("/")).toBe("/");
  });

  it("degrades to / rather than throwing on something unparseable", () => {
    expect(stripSecrets("%%%")).toBe("/");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd poc/hub && npx vitest run test/securityFloor.test.ts` and `cd poc/client && npx vitest run src/authState.test.ts`
Expected: FAIL on both — no origin check, no bounds, no rate limit, `stripSecrets` does not resolve.

- [ ] **Step 3: Implement the Origin check and payload bounds**

In `poc/hub/src/hub.ts`:

```ts
/** The largest browser command worth accepting. MAX_PROMPT_LENGTH is 4000, so
 *  this is generous by three orders of magnitude and still refuses the kind of
 *  frame that exists only to be expensive. */
const MAX_BROWSER_MESSAGE_BYTES = 64 * 1024;
```

```ts
  wss.on("connection", (socket: WebSocket, req) => {
    socket.on("error", () => {});
    const isUplink = (req.url ?? "/").startsWith("/uplink");
    // Applied to browsers only. `mpai` sends no Origin, and requiring one
    // would break every laptop while protecting nothing — an uplink is gated
    // by its bearer, not by CORS (spec §10.6).
    if (!isUplink && opts.origin) {
      const origin = req.headers.origin;
      if (origin !== opts.origin) {
        socket.close(1008, "origin not allowed");
        return;
      }
    }
    if (isUplink) handleUplink(socket, req.headers.authorization);
    else handleBrowser(socket, req.headers.cookie);
  });
```

and at the top of `handleBrowser`'s message handler, before `JSON.parse`:

```ts
    socket.on("message", (raw) => {
      // Bounded before parsing, not after: the cost of an oversized frame is
      // paid in JSON.parse, so a check that runs afterwards has already lost.
      if ((raw as Buffer).length > MAX_BROWSER_MESSAGE_BYTES) {
        return error("message too large");
      }
      let msg: any;
      /* ... unchanged ... */
```

The `maxPayload: MAX_FRAME_BYTES` on the `WebSocketServer` — already set in v7b1 — is what produces the 1009 close in the second test. Confirm it is still there; do not remove it.

- [ ] **Step 4: Implement per-peer rate limiting on the pair routes**

In `poc/hub/src/pairRoutes.ts`:

```ts
/** Fixed-window counter, keyed by remote address. Deliberately simple: the
 *  goal is to make a short human-transcribed code unguessable in practice
 *  (spec §10.5), not to build a rate-limiting framework. Behind a proxy every
 *  peer looks like the proxy, which is why PairingStore ALSO charges attempts
 *  against every live pairing — belt and braces, since neither alone is
 *  sufficient. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

function rateLimiter(now: () => number) {
  const hits = new Map<string, { count: number; windowStart: number }>();
  return (key: string): boolean => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.windowStart >= RATE_WINDOW_MS) {
      hits.set(key, { count: 1, windowStart: t });
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE_MAX;
  };
}
```

Construct one per `pairRoutes` call and apply it as the first thing in every `/pair/*` branch:

```ts
    if (path.startsWith("/pair/")) {
      const peer = req.socket.remoteAddress ?? "unknown";
      if (!allow(peer)) {
        json(res, 429, { error: "too many attempts — try again in a minute" });
        return true;
      }
    }
```

- [ ] **Step 5: Implement `stripSecrets` and use it**

In `poc/client/src/authState.ts`:

```ts
/** Removes secrets from a post-login destination.
 *
 *  The invite token rides `?invite=` and is propagated into
 *  `/auth/login?next=<…&invite=token>`, so without this it lands in browser
 *  history, screen shares and any Referer header — and today's `Referrer-Policy:
 *  no-referrer` in deploy/Caddyfile is one ops change away from evaporating
 *  (spec §10.1). The token is still sent on the join, where it belongs; it just
 *  no longer rides the URL through an OAuth round trip. */
export function stripSecrets(next: string): string {
  let url: URL;
  try {
    url = new URL(next, "http://x");
  } catch {
    return "/";
  }
  url.searchParams.delete("invite");
  url.searchParams.delete("pair");
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}
```

and apply it in `loginUrl`:

```ts
export function loginUrl(next: string): string {
  return `/auth/login?next=${encodeURIComponent(stripSecrets(next))}`;
}
```

In `poc/client/src/App.tsx`, after an invite is redeemed and after a pairing is approved, drop the parameter from the address bar so a reload does not re-show the screen and the secret does not linger:

```ts
  // The client keeps the token in memory for the join; the address bar does
  // not need it, and leaving it there means it survives in history forever.
  history.replaceState(null, "", stripSecrets(location.pathname + location.search));
```

- [ ] **Step 6: Run everything**

Run: `cd poc/hub && npx tsc --noEmit && npx vitest run`
Expected: **74 passed** (66 + 8).

Run: `cd poc/client && npx tsc --noEmit && npx vitest run && npm run build`
Expected: **195 passed** (191 + 4), build clean.

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: **396 passed**, unchanged by this task.

- [ ] **Step 7: Commit**

```bash
git add poc/hub/src/hub.ts poc/hub/src/pairRoutes.ts poc/hub/test/securityFloor.test.ts \
        poc/client/src/authState.ts poc/client/src/authState.test.ts poc/client/src/App.tsx
git commit -m "feat: origin checks, payload bounds, rate limiting and URL secret hygiene (v7b2)"
```

---

## Verification before calling v7b2 done

```bash
cd poc/server && npx tsc --noEmit && npx vitest run    # 396 passed
cd ../hub    && npx tsc --noEmit && npx vitest run     # 74 passed
cd ../client && npx tsc --noEmit && npx vitest run && npm run build   # 195 passed, build clean
```

- [ ] All three suites green, all typechecks clean, client build clean.
- [ ] `mpai` with **no** `--hub` still launches and runs a turn exactly as before.
- [ ] **The full pairing walk, by hand**, on two machines or two accounts:
  1. `mpai --hub http://127.0.0.1:4000` in a fresh repo prints a code and waits.
  2. A signed-in browser at `/?pair=<code>` approves it; the terminal says "paired."
  3. `mpai` attaches and the session appears on the hub.
  4. Killing and re-running `mpai --hub` does **not** ask to pair again — the token was stored.
  5. `~/.mpai/hub.json` is mode `0600` (`ls -l`).
  6. Revoking the device from the DEVICES screen **closes the live uplink immediately**, and `mpai` prints the re-pair instruction rather than reconnecting in a loop.
- [ ] **Grep the logs for secrets** after that walk: no bearer, no pairing code, no cookie value in any output. `grep -riE "bearer|mpai_session=" <captured output>` returns nothing but the literal header name.
- [ ] Sign in as a non-allowlisted GitHub user and confirm the denied screen, and that no snapshot or event ever reached that socket.
- [ ] `deploy/RUNBOOK.md` gains a hub section: the five hub env vars, `HUB_ORIGIN`, and the pairing walk.

## Known bounds this plan ships with

- **Device records and pairings are in memory.** A hub restart un-pairs every laptop and everyone runs `mpai --hub` again. v7c's SQLite work fixes this and should be sequenced before any real beta.
- **Rate limiting is per remote address**, so behind a proxy every peer looks like the proxy. `PairingStore` also charges attempts against every live pairing, which is what actually bounds brute force; the per-IP limiter is a second layer, not the primary one.
- **The allowlist is still `GITHUB_ALLOWLIST`.** It moves to host settings in v7b3.
- **Revocation is self-service.** You can revoke your own devices; nobody can revoke someone else's. Host-wide revoke is v7b3.
- **The hub sees everything relayed through it** — transcripts, tool calls, file paths, prompts. Inherent to being the shared surface (spec §8), not an oversight.
- **No audit log.** Who revoked what, and when, is not recorded anywhere. Reading B work.

## Deviations

*Fill this in during execution. Every divergence from the listings above, with the reason.*
