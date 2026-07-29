import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, findRepoRoot, localUrlFor, sessionUrlFor } from "../src/cli.js";

describe("parseArgs", () => {
  it("defaults to launch on port 3001, project default, open", () => {
    expect(parseArgs([])).toEqual({
      cmd: "launch",
      port: 3001,
      project: "default",
      open: true,
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
