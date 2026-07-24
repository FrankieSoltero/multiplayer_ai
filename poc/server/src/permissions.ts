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
