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

// Shell metacharacters (chaining `;` `&` `|`, redirection `<` `>`, command
// substitution/backtick/variable-expansion `` ` `` `$` — covers `$(...)`,
// `${...}`, `$VAR` — line continuation/escaping `\`, and embedded newlines).
// Allowlisting a prefix means "this exact simple command", never "any
// pipeline or composite command that starts with it" — a command containing
// any of these always falls through to driver approval, even if it starts
// with an allowlisted prefix (e.g. `git status && rm -rf /`).
const SHELL_METACHARACTERS = /[;&|<>`$\\]|\n/;

export function isAutoApprovedBash(command: string): boolean {
  if (SHELL_METACHARACTERS.test(command)) return false;
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
        hooks.onPermissionRequest(toolName, input, options.signal),
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
