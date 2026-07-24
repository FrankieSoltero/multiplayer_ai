import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { DriverHooks } from "./agentDriver.js";

/**
 * Driver approval gate — pure logic (no AgentDriver instance needed).
 *
 * `allowedTools` auto-approves the read/write file tools and set_intent;
 * every OTHER tool call reaches the SDK's `canUseTool` callback. Bash
 * commands matching one of these prefixes are trivially safe (tests, type
 * checks, read-only git) and auto-approve so agents can verify their own
 * work without pausing the session; everything else asks the driver.
 */
export const AUTO_APPROVED_BASH_PREFIXES = [
  "npx vitest",
  "npx tsc",
  "npm test",
  "git status",
  "git diff",
  "git log",
];

export function isAutoApprovedBash(command: string): boolean {
  return AUTO_APPROVED_BASH_PREFIXES.some(
    (prefix) =>
      command === prefix ||
      (command.startsWith(prefix) && command[prefix.length] === " "),
  );
}

/**
 * Bridge the SDK's canUseTool callback to the driver-approval hook.
 * MUST always resolve to a PermissionResult — returning null tells the SDK
 * "the response was sent out-of-band" and blocks the tool forever
 * (fail-closed; see sdk.d.ts CanUseTool docs). Abort or hook failure
 * therefore maps to an explicit deny.
 */
export function buildCanUseTool(hooks: DriverHooks): CanUseTool {
  return async (toolName, input, options) => {
    const command = (input as { command?: unknown }).command;
    if (toolName === "Bash" && typeof command === "string" && isAutoApprovedBash(command)) {
      return { behavior: "allow" };
    }
    try {
      const decision = await Promise.race([
        hooks.onPermissionRequest(toolName, input),
        abortsToDeny(options.signal),
      ]);
      if (decision === "allow") return { behavior: "allow" };
      return {
        behavior: "deny",
        message:
          "The driving teammate denied this tool call. Adapt your approach, or explain in your reply what you need and why.",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hooks.onPermissionError?.(`permission flow failed: ${message}`);
      return { behavior: "deny", message: `permission flow failed: ${message}` };
    }
  };
}

function abortsToDeny(signal: AbortSignal): Promise<"deny"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("deny");
    signal.addEventListener("abort", () => resolve("deny"), { once: true });
  });
}
