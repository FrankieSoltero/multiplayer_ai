# A1a Deployment Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the relay server runnable as a production process behind a TLS-terminating reverse proxy — single origin serving the built client and the WebSocket — with misconfiguration failing at startup instead of mid-demo.

**Architecture:** Node serves everything (client + WebSocket) on one loopback-bound port; Caddy is a pure TLS-terminating reverse proxy. Five small code changes plus committed-but-unverified ops artifacts. No box, domain, or DNS is involved — deployment is A1b.

**Tech Stack:** TypeScript (`module: NodeNext`), Node 22+, `ws`, vitest, React 19 + Vite on the client. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-27-a1a-deployment-wiring-design.md`

## Global Constraints

- **No new runtime dependencies.** Everything here uses the standard library or what is already installed.
- **`git add` must always name explicit paths.** Never `git add -A` or `git add .`. A previous subagent ran a broad add and committed the user's private untracked files into history, requiring a soft-reset rewrite.
- **Never commit these three untracked root files:** `market-research.md`, `poc/demo-plugins/`, `tour-skill-suggest.png`. They are the user's and are permanently untracked.
- **After every commit, verify with** `git diff-tree --no-commit-id --name-status -r HEAD` that only intended files landed.
- **Baselines that must never regress:** client 116 tests, server 215 tests, both `tsc --noEmit` clean, client `npm run build` clean.
- Server tests live in `poc/server/test/*.test.ts`. Client tests are co-located in `poc/client/src/`.
- The client has **no component-test infrastructure**. The established pattern is pure-function extraction plus vitest. Follow it; do not add a component-test framework.
- `poc/server` runs on `tsx` in development. Do not remove that; Task 5 adds a compiled path alongside it.
- **Do not run `npm run dev` in `poc/server` while editing** — `tsx watch` hot-reload kills live agent turns. Check `lsof -ti:3001` first.

---

### Task 1: Derive the WebSocket scheme from the page protocol

`types.ts` hardcodes `ws://` in its production branch. A browser **blocks** a `ws://` connection opened from an `https://` page, so once served over TLS the product cannot connect at all. This is a functional blocker, not only a confidentiality fix — though it is also that, since invite tokens travel on this socket.

**Files:**
- Create: `poc/client/src/socketUrl.ts`
- Create: `poc/client/src/socketUrl.test.ts`
- Modify: `poc/client/src/types.ts:86-90`

**Interfaces:**
- Consumes: nothing.
- Produces: `socketUrlFor(protocol: string, host: string): string`. Both arguments are taken verbatim from `window.location` — `protocol` includes its trailing colon (`"https:"`), `host` includes the port when non-default (`"example.com:8443"`).

All four existing `SERVER_URL` consumers (`useSessionSocket.ts:3`, `components/Lobby.tsx:3`, `components/SessionPicker.tsx:2`, `components/InviteLanding.tsx:2`) import from `types.ts` and **must not change** — `SERVER_URL` keeps its name and location and merely delegates.

- [ ] **Step 1: Write the failing test**

Create `poc/client/src/socketUrl.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { socketUrlFor } from "./socketUrl";

describe("socketUrlFor", () => {
  it("uses wss: for an https: page", () => {
    expect(socketUrlFor("https:", "mpai.example.com")).toBe("wss://mpai.example.com");
  });

  it("uses ws: for an http: page", () => {
    expect(socketUrlFor("http:", "localhost:3001")).toBe("ws://localhost:3001");
  });

  it("preserves an explicit port", () => {
    expect(socketUrlFor("https:", "mpai.example.com:8443")).toBe("wss://mpai.example.com:8443");
  });

  // Anything that is not https: is treated as insecure. Hardcoding wss: would
  // break the plain-HTTP single-port path the demo recipes and mpai CLI use.
  it("falls back to ws: for an unexpected protocol", () => {
    expect(socketUrlFor("file:", "localhost:3001")).toBe("ws://localhost:3001");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd poc/client && npx vitest run src/socketUrl.test.ts`
Expected: FAIL — cannot resolve `./socketUrl`.

- [ ] **Step 3: Write the implementation**

Create `poc/client/src/socketUrl.ts`:

```ts
/** Pure derivation of the WebSocket origin from the page location.
 *
 *  A ws:// socket opened from an https:// page is blocked outright by the
 *  browser, so the scheme must follow the page rather than be hardcoded
 *  (spec §3.3). Deriving it — rather than pinning wss: — is what keeps the
 *  plain-HTTP single-port path working locally.
 *
 *  `protocol` is window.location.protocol (trailing colon included);
 *  `host` is window.location.host (port included when non-default). */
export function socketUrlFor(protocol: string, host: string): string {
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd poc/client && npx vitest run src/socketUrl.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into `types.ts`**

In `poc/client/src/types.ts`, add the import at the top of the file:

```ts
import { socketUrlFor } from "./socketUrl";
```

Then replace lines 86-90 — the comment and the `SERVER_URL` constant — with:

```ts
/** In vite dev the server runs separately on 3001; in a built bundle the
 *  page is served BY the server (spec §5), so the socket targets the same
 *  host. The DEV short-circuit also keeps window untouched under vitest. */
export const SERVER_URL = import.meta.env.DEV
  ? "ws://localhost:3001"
  : socketUrlFor(window.location.protocol, window.location.host);
```

- [ ] **Step 6: Verify the whole client suite and the build**

Run: `cd poc/client && npx tsc --noEmit && npm test && npm run build`
Expected: tsc clean; **120 tests passing** (116 baseline + 4 new); build clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git add poc/client/src/socketUrl.ts poc/client/src/socketUrl.test.ts poc/client/src/types.ts
git commit -m "feat(client): derive ws scheme from page protocol

A ws:// socket opened from an https:// page is blocked by the browser, so
the hardcoded scheme made the product unable to connect once served over
TLS. Extracted as a pure socketUrlFor so it is testable; SERVER_URL keeps
its name and location so no consumer changes."
git diff-tree --no-commit-id --name-status -r HEAD
```

Expected: exactly the three files above.

---

### Task 2: Add `/healthz` ahead of the static handler

**Files:**
- Modify: `poc/server/src/server.ts:222-225`
- Create: `poc/server/test/httpSurface.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GET`/`HEAD /healthz` → 200, `content-type: application/json`, body `{"status":"ok"}`. Other methods → 405.

Two things make this more than a one-liner:

1. `createServer(opts.staticDir ? staticHandler(opts.staticDir) : undefined)` means that **with no `staticDir` there is no request listener at all**, so plain HTTP requests hang until the socket times out. The composed handler fixes that too, with a 404.
2. **Ordering is load-bearing.** `staticHandler`'s SPA fallback (`staticFiles.ts:51-53`) serves `index.html` for any extensionless path. Wire `/healthz` after it and the probe returns HTML with a 200 — passing forever while the app is broken. The test therefore asserts the **body**, not the status.

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/httpSurface.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

let stop: (() => Promise<void>) | null = null;

afterEach(async () => {
  await stop?.();
  stop = null;
});

/** A dist dir whose index.html is unmistakable, so an SPA-fallback
 *  regression is visible in the assertion rather than inferred. */
function fakeDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-dist-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html>SPA FALLBACK</html>");
  return dir;
}

describe("/healthz", () => {
  it("returns JSON and not the SPA fallback HTML", async () => {
    // staticDir IS configured — this is the exact case the ordering bug hides in.
    const srv = await startServer({ port: 0, staticDir: fakeDist() });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("is registered even with no staticDir", async () => {
    const srv = await startServer({ port: 0 });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);

    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects non-GET methods", async () => {
    const srv = await startServer({ port: 0 });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { method: "POST" });

    expect(res.status).toBe(405);
  });

  it("404s an unknown path when no staticDir is configured", async () => {
    const srv = await startServer({ port: 0 });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/nope`);

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd poc/server && npx vitest run test/httpSurface.test.ts`
Expected: FAIL. The first two tests fail on JSON parsing (they receive HTML, or the request hangs); the 404 test fails or times out.

- [ ] **Step 3: Write the implementation**

In `poc/server/src/server.ts`, replace lines 222-224:

```ts
  const httpServer = createServer(
    opts.staticDir ? staticHandler(opts.staticDir) : undefined,
  );
```

with:

```ts
  const serveStatic = opts.staticDir ? staticHandler(opts.staticDir) : null;
  const httpServer = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Registered unconditionally and BEFORE the static handler. That handler's
    // SPA fallback (staticFiles.ts:51-53) serves index.html for any
    // extensionless path, so wiring /healthz after it would return HTML with a
    // 200 — a probe that passes forever while the app is broken (spec §3.4).
    // Body carries no internal state: it is publicly reachable via the domain.
    if (pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      return;
    }
    if (serveStatic) {
      serveStatic(req, res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
```

Leave `const wss = new WebSocketServer({ server: httpServer });` on the following line unchanged — WebSocket upgrades never reach this handler.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd poc/server && npx vitest run test/httpSurface.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the full server suite has not regressed**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; **219 tests passing** (215 baseline + 4 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git add poc/server/src/server.ts poc/server/test/httpSurface.test.ts
git commit -m "feat(server): add /healthz ahead of the static handler

Composed request handler so /healthz is registered unconditionally and is
reached before staticHandler's SPA fallback, which would otherwise return
index.html with a 200 for an extensionless path. Also gives a real 404 when
no staticDir is configured, where previously there was no request listener
at all and plain HTTP requests simply hung."
git diff-tree --no-commit-id --name-status -r HEAD
```

Expected: exactly the two files above.

---

### Task 3: Bind host option

Today `httpServer.listen(opts.port)` binds every interface. On a public box that makes port 3001 directly reachable, letting anyone bypass Caddy and TLS entirely.

**Files:**
- Modify: `poc/server/src/server.ts:60` (options) and `:758` (listen call)
- Modify: `poc/server/test/httpSurface.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `startServer({ host?: string })`. Optional; omitting it preserves today's all-interfaces behaviour so the existing 215 tests are untouched.

- [ ] **Step 1: Write the failing test**

Append to `poc/server/test/httpSurface.test.ts`:

```ts
describe("host binding", () => {
  it("serves on the host it was given", async () => {
    const srv = await startServer({ port: 0, host: "127.0.0.1" });
    stop = srv.close;

    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);

    expect(res.status).toBe(200);
  });
});
```

Note for the implementer: this asserts the positive case only. That the port is *unreachable* on other interfaces is not portably testable in CI — it is verified by hand with `lsof` in Task 7, Step 5.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd poc/server && npx vitest run test/httpSurface.test.ts`
Expected: FAIL — `tsc`/vitest rejects `host` as an unknown property on the options object.

- [ ] **Step 3: Add the option**

In `poc/server/src/server.ts`, in the `startServer` options type (starting line 60), add `host` immediately after `port`:

```ts
export async function startServer(opts: {
  port: number;
  host?: string;
```

- [ ] **Step 4: Pass it to listen**

In the same file at line 758, change:

```ts
    httpServer.listen(opts.port);
```

to:

```ts
    httpServer.listen(opts.port, opts.host);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd poc/server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; **220 tests passing**.

- [ ] **Step 6: Commit**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git add poc/server/src/server.ts poc/server/test/httpSurface.test.ts
git commit -m "feat(server): optional host bind option

Lets the deployed process bind loopback only, so the app port is
unreachable except through the reverse proxy. Optional, defaulting to
today's all-interfaces behaviour."
git diff-tree --no-commit-id --name-status -r HEAD
```

---

### Task 4: Production config validation and `main.ts` wiring

Today a missing `ANTHROPIC_API_KEY` only warns (`main.ts:3-7`). On a box that means the server starts happily, a friend joins, and the demo dies three minutes later when the agent cannot authenticate. A missing or unbuilt `CLIENT_DIST` similarly yields a running server serving a blank page. Both must be boot failures.

**Production mode is signalled by `CLIENT_DIST` being set** — only the deployed box sets it, so local development behaviour is completely unchanged.

**Files:**
- Create: `poc/server/src/config.ts`
- Create: `poc/server/test/config.test.ts`
- Modify: `poc/server/src/main.ts` (whole file)

**Interfaces:**
- Consumes: `startServer({ port, host?, staticDir? })` from Tasks 2-3.
- Produces: `validateProductionConfig(env, hasIndexHtml)` returning `{ ok: true; staticDir: string | undefined } | { ok: false; error: string }`. The filesystem check is injected so the function is pure and testable without touching disk.

- [ ] **Step 1: Write the failing test**

Create `poc/server/test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateProductionConfig } from "../src/config.js";

const always = () => true;
const never = () => false;

describe("validateProductionConfig", () => {
  it("is a no-op in development, where CLIENT_DIST is unset", () => {
    // No key, no dist — dev must keep starting exactly as it does today.
    expect(validateProductionConfig({}, never)).toEqual({ ok: true, staticDir: undefined });
  });

  it("accepts a production config with a built client and a key", () => {
    const result = validateProductionConfig(
      { CLIENT_DIST: "/opt/app/dist", ANTHROPIC_API_KEY: "sk-test" },
      always,
    );
    expect(result).toEqual({ ok: true, staticDir: "/opt/app/dist" });
  });

  it("rejects a CLIENT_DIST with no index.html", () => {
    const result = validateProductionConfig(
      { CLIENT_DIST: "/opt/app/dist", ANTHROPIC_API_KEY: "sk-test" },
      never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("index.html");
  });

  it("rejects production with no API key", () => {
    const result = validateProductionConfig({ CLIENT_DIST: "/opt/app/dist" }, always);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  it("treats an empty API key as missing", () => {
    const result = validateProductionConfig(
      { CLIENT_DIST: "/opt/app/dist", ANTHROPIC_API_KEY: "" },
      always,
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd poc/server && npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write the implementation**

Create `poc/server/src/config.ts`:

```ts
export type ConfigResult =
  | { ok: true; staticDir: string | undefined }
  | { ok: false; error: string };

/** Validates the deployed process's configuration at boot.
 *
 *  Production mode is signalled by CLIENT_DIST being set — only the deployed
 *  box sets it, so local development behaviour is untouched (spec §3.2).
 *
 *  The filesystem probe is injected rather than called directly so this stays
 *  a pure function, testable without a temp dir or process.exit. */
export function validateProductionConfig(
  env: Record<string, string | undefined>,
  hasIndexHtml: (dir: string) => boolean,
): ConfigResult {
  const staticDir = env.CLIENT_DIST;
  if (!staticDir) return { ok: true, staticDir: undefined };

  if (!hasIndexHtml(staticDir)) {
    return {
      ok: false,
      error: `CLIENT_DIST=${staticDir} has no index.html — build the client first (cd poc/client && npm run build)`,
    };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY is required when CLIENT_DIST is set (production mode)",
    };
  }
  return { ok: true, staticDir };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd poc/server && npx vitest run test/config.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite `main.ts`**

Replace the entire contents of `poc/server/src/main.ts` with:

```ts
import fs from "node:fs";
import path from "node:path";
import { startServer } from "./server.js";
import { validateProductionConfig } from "./config.js";

const config = validateProductionConfig(process.env, (dir) =>
  fs.existsSync(path.join(dir, "index.html")),
);
if (!config.ok) {
  console.error(`config error: ${config.error}`);
  process.exit(1);
}

// Development keeps the old advisory warning: the Claude CLI's own
// credentials may be available even with no key in the environment.
if (!config.staticDir && !process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "ANTHROPIC_API_KEY not set — the agent will rely on Claude CLI credentials if available",
  );
}

/** A positive finite integer from the env, or undefined so the caller's
 *  default applies. Guards against NaN/negative values from a typo'd env var
 *  silently reaching the store. */
function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const port = Number(process.env.PORT ?? 3001);
// Loopback by default so the deployed port is reachable only through the
// reverse proxy. Set HOST=0.0.0.0 for LAN access, e.g. testing from a phone.
const host = process.env.HOST ?? "127.0.0.1";
// Off by default (spec §7's bound only applies once an operator opts in).
const requireInvite = process.env.REQUIRE_INVITE === "1";
const inviteTtlMs = positiveIntEnv("INVITE_TTL_MS");
const inviteMaxUses = positiveIntEnv("INVITE_MAX_USES");

const { port: actual } = await startServer({
  port,
  host,
  staticDir: config.staticDir,
  requireInvite,
  inviteTtlMs,
  inviteMaxUses,
});

console.log(`multiplayer-ai server listening on http://${host}:${actual}`);
if (config.staticDir) console.log(`serving client from ${config.staticDir}`);
if (requireInvite) console.log("REQUIRE_INVITE=1 — invite gate is ON");
```

Note: `process.exit(1)` returns `never`, so TypeScript narrows `config` to the `ok: true` branch afterwards and `config.staticDir` type-checks.

- [ ] **Step 6: Verify the suite and both startup paths by hand**

```bash
cd poc/server
npx tsc --noEmit && npx vitest run
```
Expected: tsc clean; **225 tests passing**.

Then confirm the fail-fast actually fires:

```bash
CLIENT_DIST=/tmp/definitely-not-built npx tsx src/main.ts; echo "exit=$?"
```
Expected: prints a `config error:` line naming `index.html`, and `exit=1`.

```bash
npx tsx src/main.ts
```
Expected: starts, logs `listening on http://127.0.0.1:3001`. Stop it with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git add poc/server/src/config.ts poc/server/test/config.test.ts poc/server/src/main.ts
git commit -m "feat(server): fail-fast production config and env wiring

Wires CLIENT_DIST and HOST, which had nowhere to land despite startServer
accepting staticDir all along. In production mode (signalled by CLIENT_DIST)
a missing key or unbuilt client is now a boot failure rather than a demo
that dies three minutes in. Validation extracted as a pure function so it is
testable without process.exit."
git diff-tree --no-commit-id --name-status -r HEAD
```

---

### Task 5: Compiled build output

Production should not run `tsx` — it is a dev dependency doing on-the-fly transformation at every start. This needs no source changes: the project is already `module: NodeNext` and its imports already carry `.js` extensions (`from "./server.js"`), so emitted ESM resolves correctly.

**Files:**
- Create: `poc/server/tsconfig.build.json`
- Modify: `poc/server/package.json` (scripts)

**Interfaces:**
- Consumes: `src/main.ts` from Task 4.
- Produces: `npm run build` → `poc/server/dist/main.js`, runnable as `node dist/main.js`. This is the `ExecStart` target in Task 6's systemd unit.

- [ ] **Step 1: Create the build config**

Create `poc/server/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src"]
}
```

`include` narrows to `src` so `test/` is not emitted. The base config's `noEmit: true` is overridden here only.

- [ ] **Step 2: Add the build script**

In `poc/server/package.json`, add a `build` entry to `scripts`, leaving the others untouched:

```json
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=.env src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
```

- [ ] **Step 3: Confirm the build output is already ignored**

Do **not** create a new `.gitignore`. The repository root already ignores `dist/`, `node_modules/` and `.env`, so `poc/server/dist/` is covered. Verify rather than assume:

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git check-ignore -v poc/server/dist
```
Expected: a line naming `.gitignore:2:dist/`. If it prints nothing, the path is **not** ignored — stop and fix that before building.

- [ ] **Step 4: Verify the build emits and runs**

```bash
cd poc/server
npm run build
node dist/main.js
```
Expected: `dist/main.js` exists; the process starts and logs `listening on http://127.0.0.1:3001`. Stop with Ctrl-C.

Then confirm the compiled binary honours fail-fast identically to the tsx path:

```bash
CLIENT_DIST=/tmp/definitely-not-built node dist/main.js; echo "exit=$?"
```
Expected: `config error:` line, `exit=1`.

- [ ] **Step 5: Confirm dist is not staged**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai && git status --short poc/server
```
Expected: `dist/` does **not** appear. If it does, Step 3's `.gitignore` is wrong — fix before committing.

- [ ] **Step 6: Commit**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git add poc/server/tsconfig.build.json poc/server/package.json
git commit -m "build(server): tsc emit so production runs node, not tsx

Needed no source changes: module NodeNext plus .js-extension imports means
emitted ESM resolves as-is. bin/mpai.js keeps using tsx — that is the local
CLI and is out of scope."
git diff-tree --no-commit-id --name-status -r HEAD
```

---

### Task 6: Ops artifacts

Committed now, unverified until A1b. They are already designed, they are text, and `env.example` must name exactly the variables Task 4 validates — writing them apart is how the two drift.

**Files:**
- Create: `deploy/Caddyfile`
- Create: `deploy/multiplayer-ai.service`
- Create: `deploy/env.example`
- Create: `deploy/RUNBOOK.md`

**Interfaces:**
- Consumes: `node dist/main.js` (Task 5); the env var names from Task 4.
- Produces: nothing code depends on.

- [ ] **Step 1: Create `deploy/Caddyfile`**

```
# NOT YET VERIFIED against a real box — written during A1a, executed in A1b.
# Replace <hostname> with the real domain before use.
#
# Caddy terminates TLS and reverse-proxies everything to the Node process,
# which serves both the built client and the WebSocket from one origin.
# reverse_proxy passes WebSocket upgrades through natively — no extra config.

<hostname> {
    encode gzip

    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        # Not boilerplate: this product's core interaction is a human clicking
        # "approve" on a privileged action. Without frame denial that UI can be
        # clickjacked via an invisible overlaid iframe to harvest a real approval.
        X-Frame-Options DENY
        Referrer-Policy no-referrer
    }

    reverse_proxy 127.0.0.1:3001
}
```

- [ ] **Step 2: Create `deploy/multiplayer-ai.service`**

```ini
# NOT YET VERIFIED against a real box — written during A1a, executed in A1b.
# Install to /etc/systemd/system/multiplayer-ai.service

[Unit]
Description=multiplayer-ai relay server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mpai
WorkingDirectory=/opt/multiplayer-ai/poc/server
# Secrets live here, never inline in this unit: unit files in
# /etc/systemd/system are world-readable.
EnvironmentFile=/etc/multiplayer-ai/env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

# Deliberately modest. ProtectSystem=strict and ProtectHome=yes are NOT set:
# the agent legitimately writes git worktrees, clones plugins, runs Bash that
# may install packages, and needs ~/.claude for its own config. Those
# directives would surface as mysterious agent failures rather than clean
# permission errors.
#
# Stated honestly: these two directives on a process whose purpose is spawning
# an unconstrained agent are close to theatre. They cost nothing so we take
# them, but they are not isolation. Real isolation is a Reading B item and
# means namespaces or containers per agent session.
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Create `deploy/env.example`**

```bash
# NOT YET VERIFIED against a real box — written during A1a, executed in A1b.
# Install to /etc/multiplayer-ai/env, then: chown mpai:mpai and chmod 0600.
# Never commit a filled-in copy of this file.

# Capped Anthropic Console workspace key. Required whenever CLIENT_DIST is set.
ANTHROPIC_API_KEY=

# Absolute path to the built client. Its presence is what signals production
# mode, which turns config problems into boot failures.
CLIENT_DIST=/opt/multiplayer-ai/poc/client/dist

# Loopback only: the port must be reachable solely through Caddy.
HOST=127.0.0.1
PORT=3001

# Agent working directories.
AGENT_WORKDIR_ROOT=/srv/mpai-work
AGENT_PLUGINS_ROOT=/srv/mpai-plugins

# Optional invite gate. Off unless set to 1. Invites are a capability, NOT
# authentication — real auth is A2.
# REQUIRE_INVITE=1
# INVITE_TTL_MS=86400000
# INVITE_MAX_USES=5
```

- [ ] **Step 4: Create `deploy/RUNBOOK.md`**

```markdown
# Deployment runbook (A1b)

**Status: NEVER EXECUTED.** Written during A1a alongside the code. Every step
is unverified until the first real deployment. Expect to correct this file as
you go — and correct it in place, so the second deployment is cheaper.

The operator runs these over SSH by hand.

## 0. Before you start

- A domain, with an **A record already pointing at the box**. Caddy issues its
  certificate at first start; if DNS is not live you get a confusing TLS error
  rather than a clear one.
- If using Cloudflare DNS, set the record to **"DNS only"** (grey cloud), not
  proxied.
- A Hetzner CX22-class box (2 vCPU / 4 GB / 40 GB). 4 GB is the floor, not a
  comfort margin: the Claude Code subprocess is itself a Node process.
- A capped Anthropic Console workspace key.

## 1. Base packages

    sudo apt update && sudo apt install -y git curl
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version    # expect v22.x or newer

## 2. Service user and directories

    sudo useradd --create-home --shell /usr/sbin/nologin mpai
    sudo mkdir -p /opt/multiplayer-ai /srv/mpai-work /srv/mpai-plugins /etc/multiplayer-ai
    sudo chown -R mpai:mpai /opt/multiplayer-ai /srv/mpai-work /srv/mpai-plugins

The user needs a real home directory: the agent subprocess uses `~/.claude`.

## 3. Checkout and build

    sudo -u mpai git clone https://github.com/FrankieSoltero/multiplayer_ai.git /opt/multiplayer-ai
    cd /opt/multiplayer-ai/poc/server && sudo -u mpai npm ci && sudo -u mpai npm run build
    cd /opt/multiplayer-ai/poc/client && sudo -u mpai npm ci && sudo -u mpai npm run build

## 4. Secrets

    sudo cp /opt/multiplayer-ai/deploy/env.example /etc/multiplayer-ai/env
    sudo chown mpai:mpai /etc/multiplayer-ai/env
    sudo chmod 0600 /etc/multiplayer-ai/env
    sudo -e /etc/multiplayer-ai/env      # fill in ANTHROPIC_API_KEY

## 5. Service

    sudo cp /opt/multiplayer-ai/deploy/multiplayer-ai.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now multiplayer-ai
    sudo systemctl status multiplayer-ai        # expect active (running)
    curl -s localhost:3001/healthz              # expect {"status":"ok"}

If `/healthz` returns HTML, the handler ordering regressed — see spec §3.4.

## 6. Caddy

    sudo apt install -y caddy
    sudo cp /opt/multiplayer-ai/deploy/Caddyfile /etc/caddy/Caddyfile
    sudo sed -i 's/<hostname>/YOUR.DOMAIN.HERE/' /etc/caddy/Caddyfile
    sudo systemctl restart caddy
    sudo journalctl -u caddy -n 50 --no-pager   # confirm certificate obtained

## 7. Firewall

    sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
    sudo ufw enable
    sudo ufw status

Port 3001 is never opened: the process binds loopback. This is defence in
depth, not the primary control.

## 8. Verification — A1b is not done until every line passes

- [ ] `https://<domain>` loads the client with a valid certificate
- [ ] `https://<domain>/healthz` returns JSON, not HTML
- [ ] DevTools → Network → WS shows an established **wss://** connection
- [ ] **Two people on two different networks run a session together**
- [ ] **A real permission gate is reached and approved**
- [ ] An agent turn completes end to end
- [ ] `sudo kill -9 <pid>` → systemd respawns within seconds
- [ ] `curl http://<public-ip>:3001` from outside is refused

The last four matter most. It is easy to stop at "the site loads" and call it
deployed while the product itself has never run on that machine.
```

- [ ] **Step 5: Commit**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai
git add deploy/Caddyfile deploy/multiplayer-ai.service deploy/env.example deploy/RUNBOOK.md
git commit -m "chore(deploy): ops artifacts for A1b, unverified

Caddyfile, systemd unit, env template and runbook. Committed during A1a so
env.example and main.ts's validation name the same variables; each file says
plainly that it has never been run against a real box."
git diff-tree --no-commit-id --name-status -r HEAD
```

Expected: exactly the four files above — no stray `dist/` and none of the three untracked root files.

---

### Task 7: Local verification gate

This is A1a's definition of done. It is manual and mostly a browser exercise; no commit unless a defect is found.

**Files:** none modified unless a defect surfaces.

- [ ] **Step 1: Build both halves**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai/poc/client && npm run build
cd ../server && npm run build
```

- [ ] **Step 2: Run in production mode**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai/poc/server
CLIENT_DIST=$(cd ../client/dist && pwd) HOST=127.0.0.1 PORT=3001 node dist/main.js
```
Expected: logs `listening on http://127.0.0.1:3001` and `serving client from …`. Leave it running; use a second terminal below.

- [ ] **Step 3: Confirm `/healthz` is JSON, not the SPA page**

```bash
curl -i http://127.0.0.1:3001/healthz
```
Expected: `200`, `content-type: application/json`, body `{"status":"ok"}`. **If the body is HTML, stop** — the handler ordering is wrong (spec §3.4).

- [ ] **Step 4: Load the product over plain HTTP**

Open `http://127.0.0.1:3001/?session=a1a-check&name=alice`.
Expected: the terminal UI renders from the built bundle. In DevTools → Network → WS, the connection is `ws://` (correct — the page is HTTP).

- [ ] **Step 5: Confirm the loopback bind**

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
```
Expected: the address column shows `127.0.0.1:3001`, **not** `*:3001`.

- [ ] **Step 6: Two participants and a real approval**

In a second browser profile or private window, open
`http://127.0.0.1:3001/?session=a1a-check&name=ben`.

Expected: both appear in the roster; one is driver, the other passenger. Send a prompt that triggers a tool permission gate, and approve it from the driver's side. Expected: the gate resolves and the transcript attributes the decision.

This is the step that proves the *product* works through the single-port path, not merely that a server responds. If the SDK will not launch locally, **stop and report it** rather than marking the task done — the spec names this as a real risk.

- [ ] **Step 7: TLS rehearsal — prove `wss://` before deploy day**

The highest-value step here, and the only way to prove the Task 1 fix end to end without a box.

```bash
brew install caddy
```

Create `/tmp/Caddyfile.local`:

```
localhost {
    tls internal
    encode gzip
    reverse_proxy 127.0.0.1:3001
}
```

Then, with the server from Step 2 still running:

```bash
sudo caddy run --config /tmp/Caddyfile.local
```

Caddy installs a local CA on first run (it will prompt for your password). Open
`https://localhost/?session=a1a-tls&name=alice`.

Expected: the page loads over HTTPS, and DevTools → Network → WS shows an established **`wss://`** connection. That is the assertion this whole step exists for.

If `tls internal` fights with your local setup, **report it rather than skipping** — shipping the scheme fix on a unit test plus an argument is exactly the class of thing that surprises you on deploy day.

- [ ] **Step 8: Full suite, final check**

```bash
cd /Users/franciscosoltero/Desktop/Code/multiplayer_ai/poc/server && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc --noEmit && npm test && npm run build
```
Expected: server tsc clean + **225 passing**; client tsc clean + **120 passing** + build clean.

- [ ] **Step 9: Stop everything**

```bash
kill $(lsof -ti:3001) 2>/dev/null; echo done
```
Stop the Caddy process with Ctrl-C.

---

## Done means

- Client 120 tests, server 225 tests, both `tsc --noEmit` clean, client build clean.
- `node dist/main.js` serves the built client and the WebSocket from one loopback-bound port.
- `/healthz` returns JSON ahead of the SPA fallback.
- Misconfiguration fails at boot with a clear message.
- An established `wss://` connection has been observed in a browser.
- `deploy/` holds the four artifacts, each marked unverified.

**Not** done here, by design: authentication (A2), the pull notification (A3), the demo scenario (A4), and the deployment itself (A1b).
