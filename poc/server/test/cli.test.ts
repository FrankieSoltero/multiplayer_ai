import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  findRepoRoot,
  localUrlFor,
  sessionUrlFor,
  resolveRoots,
  finalizeCandidates,
  prepareHubAuth,
  normalizeHubUrl,
  hubDialingLine,
  hubAttachedLine,
  hubNoWelcomeLines,
} from "../src/cli.js";
import { loadHubToken, saveHubToken } from "../src/hubPairing.js";
import type { RepoCandidate } from "../src/machineRepos.js";

describe("parseArgs", () => {
  it("defaults to launch on port 3001, project default, open, no roots", () => {
    expect(parseArgs([])).toEqual({
      cmd: "launch",
      port: 3001,
      project: "default",
      open: true,
      roots: [],
    });
  });

  it("parses --port and --no-open", () => {
    const args = parseArgs(["--port", "4000", "--no-open"]);
    expect(args.port).toBe(4000);
    expect(args.open).toBe(false);
    expect(args.error).toBeUndefined();
  });

  it("parses new with name, base, and project", () => {
    const args = parseArgs(["new", "Fix Auth", "--base", "dev", "--project", "p1"]);
    expect(args.cmd).toBe("new");
    expect(args.name).toBe("Fix Auth");
    expect(args.base).toBe("dev");
    expect(args.project).toBe("p1");
    expect(args.error).toBeUndefined();
  });

  it("rejects a --project id the hub's frame parser would refuse", () => {
    // Without this the failure is invisible: `hello` carries the projectId,
    // `parseUpFrame` rejects anything outside SLUG, the hub answers with a
    // 1008 close, and the relay swallows it and reconnects every 2s — forever,
    // after `launch()` has already printed "attached to hub".
    expect(parseArgs(["--hub", "ws://hub.test", "--project", "MyProject"]).error).toMatch(
      /--project requires 1-40 chars/,
    );
    expect(parseArgs(["--project", "a b"]).error).toMatch(/--project requires 1-40 chars/);
    expect(parseArgs(["--project", "team-api-2"]).error).toBeUndefined();
  });

  it("errors when new has no name", () => {
    expect(parseArgs(["new"]).error).toMatch(/requires a session name/);
  });

  it("errors on unknown flags and bad ports", () => {
    expect(parseArgs(["--bogus"]).error).toMatch(/unknown argument/);
    expect(parseArgs(["--port", "nope"]).error).toMatch(/--port/);
  });

  it("accumulates repeated --root flags in order", () => {
    const args = parseArgs(["--root", "/repos/a", "--root", "/repos/b"]);
    expect(args.roots).toEqual(["/repos/a", "/repos/b"]);
    expect(args.error).toBeUndefined();
  });

  it("--root requires a path", () => {
    expect(parseArgs(["--root"]).error).toBe("--root requires a path");
  });

  it("slices --machine-name to 40 chars", () => {
    const long = "m".repeat(50);
    expect(parseArgs(["--machine-name", long]).machineName).toBe("m".repeat(40));
    expect(parseArgs(["--machine-name", "franks-mbp"]).machineName).toBe("franks-mbp");
  });

  it("--machine-name requires a value", () => {
    expect(parseArgs(["--machine-name"]).error).toBe("--machine-name requires a name");
  });
});

describe("resolveRoots", () => {
  // Spec §4: "allowlisted roots via repeatable --root flag or roots in
  // machine.json; flag wins." This is the precedence rule cli.ts's launch()
  // relies on — pinned here as a pure function so it doesn't need a real
  // identity file on disk.
  it("prefers the --root flag's roots over machine.json's persisted roots", () => {
    expect(resolveRoots({ roots: ["/flag-root"] }, { roots: ["/config-root"] })).toEqual([
      "/flag-root",
    ]);
  });

  it("falls back to identity.roots when no --root flag was passed", () => {
    expect(resolveRoots({ roots: [] }, { roots: ["/config-root"] })).toEqual(["/config-root"]);
  });
});

describe("finalizeCandidates", () => {
  const candidate = (key: string): RepoCandidate => ({
    key,
    label: key,
    root: `/repos/${key}`,
  });

  it("drops the scanned candidate that collides with the cwd repo's key", () => {
    const scanned = [candidate("a"), candidate("cwd-key"), candidate("b")];
    const result = finalizeCandidates(scanned, "cwd-key");
    expect(result).toEqual({ candidates: [candidate("a"), candidate("b")] });
  });

  it("allows exactly 100 total repo declarations (99 candidates + the cwd repo)", () => {
    const scanned = Array.from({ length: 99 }, (_, i) => candidate(`repo-${i}`));
    const result = finalizeCandidates(scanned, "cwd-key-not-in-list");
    expect("candidates" in result).toBe(true);
    expect((result as { candidates: RepoCandidate[] }).candidates).toHaveLength(99);
  });

  it("refuses launch when candidates-after-filter + the cwd repo exceeds the 100 cap", () => {
    // scanRepoRoots's own >100 throw only covers the scan itself, keyed on
    // byKey.size. The cwd repo enters pre-attached inside startServer on TOP
    // of the scan, so the machine's final repo declarations are
    // candidates.length + 1. A scan of exactly 100 (none colliding with the
    // cwd key) slips past scanRepoRoots's own cap and would produce a 101-repo
    // hello, which the hub's parseUpFrame rejects with a misleading "versions
    // may not match" diagnosis while the relay reconnects forever. This must
    // be refused here instead, before startServer is ever called.
    const scanned = Array.from({ length: 100 }, (_, i) => candidate(`repo-${i}`));
    const result = finalizeCandidates(scanned, "cwd-key-not-in-list");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/100/);
  });
});

describe("localUrlFor", () => {
  // Solo-mode fix: a non-hub launch must not depend on the hub-shaped
  // entrance (ProjectPicker) to reach a working session picker.
  it("carries the launch's own project for a non-hub launch, so it never lands on the entrance", () => {
    expect(localUrlFor(3001, { project: "default", hub: undefined })).toBe(
      "http://localhost:3001/?project=default",
    );
  });

  it("carries a custom --project value, not a hardcoded 'default'", () => {
    expect(localUrlFor(3001, { project: "team-api-2", hub: undefined })).toBe(
      "http://localhost:3001/?project=team-api-2",
    );
  });

  it("omits the project param for a hub-attached launch — the hub is where the team is", () => {
    expect(localUrlFor(3001, { project: "default", hub: "ws://hub.test" })).toBe(
      "http://localhost:3001/",
    );
  });
});

describe("sessionUrlFor", () => {
  // Omitting project exactly when it is "default" is the same special-case
  // the client's builders (joinSession/pickerUrlFrom) had to shed: it holds
  // up only through pickerUrl.ts's legacy `?session=` fallback, which is a
  // convention, not a contract.
  it("always appends project, including for 'default'", () => {
    expect(sessionUrlFor(3001, "fix-login", "default")).toBe(
      "http://localhost:3001/?session=fix-login&project=default",
    );
  });

  it("carries a custom project", () => {
    expect(sessionUrlFor(3001, "fix-login", "team-api-2")).toBe(
      "http://localhost:3001/?session=fix-login&project=team-api-2",
    );
  });
});

describe("findRepoRoot", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("finds the repo root from a subdirectory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-cli-"));
    tmpDirs.push(dir);
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    expect(findRepoRoot(sub)).toBe(fs.realpathSync(dir));
  });

  it("returns null outside a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-nogit-"));
    tmpDirs.push(dir);
    expect(findRepoRoot(dir)).toBe(null);
  });
});

describe("--hub", () => {
  it("parses a hub url", () => {
    expect(parseArgs(["--hub", "ws://hub.example:4000/uplink"])).toMatchObject({
      cmd: "launch",
      hub: "ws://hub.example:4000/uplink",
    });
  });

  it("requires a value", () => {
    expect(parseArgs(["--hub"]).error).toBe("--hub requires a url");
  });

  it("rejects a non-websocket scheme, so a typo cannot silently do nothing", () => {
    // A wrong scheme fails deep inside `ws` with an opaque error; the laptop
    // would look attached and never be.
    expect(parseArgs(["--hub", "https://hub.example"]).error).toBe(
      "--hub requires a ws:// or wss:// url",
    );
  });

  // Names what it asserts, and no more: `parseArgs` leaves `hub` unset. The
  // additive invariant itself — that no `--hub` means `startServer` receives no
  // `hub` key at all, so `relay` is null — lives in `launch` (cli.ts's
  // conditional spread and the `args.open && !args.hub` guard), which has no
  // test here or anywhere: it is not exported and calls the real `startServer`.
  // What this case does buy is real: it fails the day someone initialises `hub`
  // eagerly, which is what would make that spread emit a key unconditionally.
  it("leaves hub undefined when the flag is absent", () => {
    expect(parseArgs([]).hub).toBeUndefined();
  });
});

describe("normalizeHubUrl", () => {
  // PRD §10.4a, Global Constraint 6: a bare origin is the hub's uplink endpoint
  // with the conventional `/uplink` path appended; anything already carrying a
  // path is dialed verbatim. This is what makes `mpai --hub wss://hub.example`
  // reach the uplink instead of opening a socket to `/` that never welcomes.
  it("appends /uplink to a bare origin", () => {
    expect(normalizeHubUrl("ws://h:4000")).toBe("ws://h:4000/uplink");
  });

  it("appends /uplink to an origin with only a trailing slash", () => {
    expect(normalizeHubUrl("wss://h/")).toBe("wss://h/uplink");
  });

  it("leaves an explicit non-/uplink path untouched (dialed verbatim)", () => {
    expect(normalizeHubUrl("wss://h/proxy/up")).toBe("wss://h/proxy/up");
  });

  it("does not double-append when the path is already /uplink", () => {
    expect(normalizeHubUrl("ws://h/uplink")).toBe("ws://h/uplink");
  });

  it("preserves a query string while appending /uplink to a bare origin", () => {
    expect(normalizeHubUrl("ws://h:4000?x=1")).toBe("ws://h:4000/uplink?x=1");
  });

  it("preserves a query string on a verbatim custom path", () => {
    expect(normalizeHubUrl("wss://h/proxy/up?x=1&y=2")).toBe("wss://h/proxy/up?x=1&y=2");
  });

  it("is only ever fed a ws(s):// value — parseArgs refuses anything else BEFORE it is called", () => {
    // The order pin: `--hub` validation (ws:// or wss:// only) runs in parseArgs
    // and leaves `hub` UNSET on a bad value, so a scheme-less or garbage URL can
    // never reach normalizeHubUrl (which `new URL` would throw on). This is the
    // "malformed --hub refused before normalization" row of the behavior table.
    expect(parseArgs(["--hub", "garbage"]).hub).toBeUndefined();
    expect(parseArgs(["--hub", "garbage"]).error).toBe("--hub requires a ws:// or wss:// url");
    expect(parseArgs(["--hub", "http://h"]).hub).toBeUndefined();
    // And the one value that DOES pass is exactly the shape normalizeHubUrl handles.
    expect(parseArgs(["--hub", "ws://h:4000"]).hub).toBe("ws://h:4000");
    expect(() => normalizeHubUrl(parseArgs(["--hub", "ws://h:4000"]).hub!)).not.toThrow();
  });
});

describe("hub report lines", () => {
  // Exact-string contracts (Global Constraint 4). The launch/attach/no-welcome
  // lines are the whole point of the truthful-reporting cycle, so they are
  // pinned here rather than left to a launch() path that calls the real server.
  it("the dialing line names the normalized URL that is actually dialed", () => {
    expect(hubDialingLine("ws://h:4000/uplink")).toBe("dialing hub ws://h:4000/uplink …");
  });

  it("the attach line carries the dialed URL and repo root", () => {
    expect(hubAttachedLine("ws://h:4000/uplink", "/repos/api")).toBe(
      "multiplayer-ai attached to hub ws://h:4000/uplink (repo: /repos/api)",
    );
  });

  it("the no-welcome warning is two lines, naming the timeout and the endpoint shape", () => {
    expect(hubNoWelcomeLines(5000)).toEqual([
      "hub never welcomed this machine after 5000ms — the socket is open but this is not an uplink handshake",
      "check the URL: the hub's uplink endpoint is ws(s)://host:port/uplink (bare origins are normalized; a custom path is dialed verbatim), and confirm the hub is running",
    ]);
  });

  it("interpolates whatever timeout the relay waited", () => {
    expect(hubNoWelcomeLines(3000)[0]).toBe(
      "hub never welcomed this machine after 3000ms — the socket is open but this is not an uplink handshake",
    );
  });
});

describe("prepareHubAuth", () => {
  const tmpDirs: string[] = [];
  function freshHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-hubauth-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  const identity = { machineId: "machine-1", name: "franks-mbp" };

  /** Queue-per-route fetch stub, same shape as hubPairing's. */
  function stubFetch(routes: Record<string, Array<{ status: number; body?: unknown } | "reject">>) {
    const cursor: Record<string, number> = {};
    return (async (input: unknown) => {
      const url = String(input);
      const key = Object.keys(routes).find((s) => url.endsWith(s));
      if (!key) throw new Error(`unexpected fetch: ${url}`);
      const i = cursor[key] ?? 0;
      cursor[key] = i + 1;
      const step = routes[key][Math.min(i, routes[key].length - 1)];
      if (step === "reject") throw new Error("ECONNREFUSED");
      return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
        status: step.status,
      });
    }) as unknown as typeof fetch;
  }

  it("uses a stored token and never touches the network", async () => {
    const home = freshHome();
    saveHubToken(home, "ws://hub.test", "tok-stored");
    const boom = (() => {
      throw new Error("network must not be called when a token is stored");
    }) as unknown as typeof fetch;
    const result = await prepareHubAuth("ws://hub.test", home, identity, { fetchImpl: boom });
    expect(result).toMatchObject({ ok: true, headers: { authorization: "Bearer tok-stored" } });
  });

  it("pairs when no token is stored, then persists the issued token as the bearer", async () => {
    const home = freshHome();
    const fetchImpl = stubFetch({
      "/pair/request": [{ status: 200, body: { code: "ABCD1234" } }],
      "/pair/poll": [
        { status: 200, body: { status: "pending" } },
        { status: 200, body: { token: "tok-new" } },
      ],
    });
    const result = await prepareHubAuth("ws://hub.test", home, identity, {
      fetchImpl,
      print: () => {},
      pollIntervalMs: 0,
    });
    expect(result).toMatchObject({ ok: true, headers: { authorization: "Bearer tok-new" } });
    // Persisted, so the next launch skips pairing.
    expect(loadHubToken(home, "ws://hub.test")).toBe("tok-new");
  });

  it("proceeds without a header and saves nothing when the hub is auth-off (404)", async () => {
    const home = freshHome();
    const fetchImpl = stubFetch({ "/pair/request": [{ status: 404 }] });
    const result = await prepareHubAuth("ws://hub.test", home, identity, {
      fetchImpl,
      print: () => {},
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) expect(result.headers).toBeUndefined();
    expect(loadHubToken(home, "ws://hub.test")).toBeNull();
  });

  it("fails with the pairing error when the hub is unreachable", async () => {
    const home = freshHome();
    const fetchImpl = stubFetch({ "/pair/request": ["reject"] });
    const result = await prepareHubAuth("ws://hub.test", home, identity, {
      fetchImpl,
      print: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("http://hub.test");
  });

  it("exposes an onUnauthorized that drops the stored token, threaded into the relay's own 4401 path", async () => {
    // The relay fires `onUnauthorized` ONLY on a 4401 credential refusal (its
    // close handler already discriminates the code), so this callback is
    // unconditional: invoking it drops the token so the next launch re-pairs
    // instead of re-presenting a bearer the hub rejects. This replaces the old
    // `hubConnect` conduit — the bearer now rides `headers` and the token-drop
    // rides `onUnauthorized`, both handed straight to `startServer`'s hub option.
    const home = freshHome();
    saveHubToken(home, "ws://hub.test", "tok-stored");
    const boom = (() => {
      throw new Error("no network");
    }) as unknown as typeof fetch;
    const result = await prepareHubAuth("ws://hub.test", home, identity, { fetchImpl: boom });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bearer is carried as a header (spec §10.1), never a query string.
    expect(result.headers).toEqual({ authorization: "Bearer tok-stored" });
    // Token still on file until the refusal fires.
    expect(loadHubToken(home, "ws://hub.test")).toBe("tok-stored");
    result.onUnauthorized();
    expect(loadHubToken(home, "ws://hub.test")).toBeNull();
  });
});
