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
export const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * The agent's own task-tracking bookkeeping — TodoWrite in the documented SDK
 * shape, or the installed live SDK's TaskCreate/TaskUpdate/TaskGet/TaskList
 * equivalents (verified live 2026-07-25: this SDK build has no TodoWrite tool
 * at all). All are mirrored to the party as todo_update events by the driver,
 * write no files, and run no commands — pausing the session to approve them
 * is pure noise.
 */
const AGENT_BOOKKEEPING_TOOLS = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
]);

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
 * The repo-relative path this tool call would write, IF that path is one the
 * session is contesting — otherwise `null` (spec §6b).
 *
 * Pure: no env, no filesystem, no gate state, and neither argument is
 * mutated. Path resolution is lexical, so a target that does not exist on disk
 * yet (the common case for Write) answers exactly like one that does.
 *
 * `contested` is the caller's set of repo-relative POSIX paths (Task 7a's
 * `contestedFor` output); the tool input is a path relative to `workdir` or an
 * absolute one, so the target is resolved and then relativized back before the
 * membership test. Containment is the EXISTING `isContainedWrite` rule, reused
 * unchanged: a target outside the worktree is never a match, so this predicate
 * cannot widen what may be written — it only reports on writes that were
 * already headed inside.
 *
 * `workdir` is `string | undefined` deliberately: every caller's workdir comes
 * from a session (`undefined` when the session has no repo) or from
 * `DriverHooks.workdir?`. Without a worktree root there is nothing to
 * relativize against, so the predicate simply never fires — the guard lives
 * here, once, rather than at each call site.
 */
export function contestedWrite(
  toolName: string,
  input: unknown,
  workdir: string | undefined,
  contested: ReadonlySet<string>,
): string | null {
  if (!FILE_WRITE_TOOLS.has(toolName)) return null;
  if (contested.size === 0) return null;
  if (!workdir) return null;
  // `isContainedWrite` destructures `input`, which throws on null/undefined —
  // this predicate's contract is "never throws", so non-objects stop here.
  if (typeof input !== "object" || input === null) return null;
  if (!isContainedWrite(workdir, input)) return null;

  const { file_path, notebook_path } = input as {
    file_path?: unknown;
    notebook_path?: unknown;
  };
  const filePath = file_path ?? notebook_path;
  // Already proved a string by the containment check; re-narrowed for the type.
  if (typeof filePath !== "string") return null;
  const relative = path.relative(path.resolve(workdir), path.resolve(workdir, filePath));
  // The worktree root itself relativizes to "" — not a file, and never a
  // contested path, even if an upstream list somehow carried an empty string.
  if (relative === "") return null;
  const repoRelative = relative.split(path.sep).join("/");
  return contested.has(repoRelative) ? repoRelative : null;
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
    // Agent bookkeeping tools (TodoWrite, or the live SDK's TaskCreate/
    // TaskUpdate/TaskGet/TaskList) are mirrored to the party as todo_update
    // events by the driver — pausing the session to approve them is pure
    // noise, and none of them write files or run commands.
    if (AGENT_BOOKKEEPING_TOOLS.has(toolName)) {
      return { behavior: "allow" };
    }
    // Plan mode's exit tool is the plan-approval gate: the plan rides the
    // tool input, the driver's decision rides the same held-promise machinery
    // as permission requests, but with its own event pair so the client can
    // render an approval card instead of a generic permission row.
    if (toolName === "ExitPlanMode") {
      const plan = (input as { plan?: unknown }).plan;
      const planText = typeof plan === "string" ? plan : "";
      try {
        const decision = await Promise.race([
          hooks.onPlanRequest(planText, options.signal),
          abortsToDeny(options.signal),
        ]);
        if (decision === "approve") return { behavior: "allow" };
        return {
          behavior: "deny",
          message:
            "The driving teammate asked for revisions. Revise the plan based on the conversation so far and present it again with ExitPlanMode.",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        hooks.onPermissionError?.(`plan flow failed: ${message}`);
        return { behavior: "deny", message: `plan flow failed: ${message}` };
      }
    }
    const command = (input as { command?: unknown }).command;
    if (toolName === "Bash" && typeof command === "string" && isAutoApprovedBash(command)) {
      return { behavior: "allow" };
    }
    if (FILE_WRITE_TOOLS.has(toolName)) {
      // Decision site 3 (spec §3.2, Task 4). The recompute is deliberately
      // INSIDE the write-tool test and BEFORE the containment test: whatever
      // judges this write next reads a touched set measured one statement ago,
      // and a Read/Grep/Bash decision never shells out to git. Synchronous —
      // it cannot race the early-allow below.
      hooks.recomputeTouched?.();
      if (isContainedWrite(hooks.workdir, input)) {
        return { behavior: "allow" };
      }
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
