import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import type { DriverHooks } from "./agentDriver.js";

/**
 * Driver approval gate — pure logic (no AgentDriver instance needed).
 *
 * `allowedTools` auto-approves only the READ-ONLY file tools (Read, Glob,
 * Grep) plus set_intent; every OTHER tool call reaches the SDK's
 * `canUseTool` callback below. Bash commands matching one of these prefixes
 * are trivially safe (tests, type checks, read-only git) and auto-approve so
 * agents can verify their own work without pausing the session; Write/Edit/
 * NotebookEdit auto-approve only when the target path resolves inside the
 * agent's own worktree (see `isContainedWrite` below); everything else asks
 * the driver.
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
 * File-writing tools eligible for worktree-containment auto-approval.
 * Live incident: an agent issued Write({file_path:"/Users/.../auth.ts"})
 * OUTSIDE its worktree, into the operator's home directory, and it ran
 * without any approval because Write/Edit were blanket-auto-approved via
 * `allowedTools` (no path check at all). Write/Edit are no longer in
 * `allowedTools` (see agentDriver.ts); this containment check is what lets
 * in-worktree edits stay fast (no driver round-trip) while anything that
 * would touch the operator's filesystem outside the worktree still requires
 * explicit driver approval.
 */
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * True if the write target — `input.file_path` for Write/Edit, or
 * `input.notebook_path` for NotebookEdit (the SDK's NotebookEdit input uses
 * a different field name) — is a string that resolves (relative to
 * `workdir`, or as-is if already absolute) to a path inside `workdir`.
 * Fails toward `false` (→ ask the driver) for any ambiguous case: no
 * workdir, missing/non-string path, or a resolved path outside the worktree
 * (including `../` traversal).
 */
function isContainedWrite(workdir: string | undefined, input: unknown): boolean {
  if (!workdir) return false;
  const { file_path, notebook_path } = input as {
    file_path?: unknown;
    notebook_path?: unknown;
  };
  const filePath = file_path ?? notebook_path;
  if (typeof filePath !== "string") return false;
  const workdirResolved = path.resolve(workdir);
  const resolved = path.resolve(workdir, filePath);
  return (
    resolved === workdirResolved || resolved.startsWith(workdirResolved + path.sep)
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
    if (FILE_WRITE_TOOLS.has(toolName) && isContainedWrite(hooks.workdir, input)) {
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
