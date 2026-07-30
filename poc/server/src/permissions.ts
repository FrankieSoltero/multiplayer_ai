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

/** Allocated once: every gate that is not a contested write reads an empty set,
 *  and a fresh `new Set()` per decision would be pure garbage. Never handed out
 *  — `contestedWrite` only reads it. */
const NO_CONTESTED: ReadonlySet<string> = new Set<string>();

/**
 * Why this write must stop being auto-approved, or `null` to leave every
 * existing auto-approval exactly as it was (spec §6b, §8a ruling 4).
 *
 * The ONE policy behind all three decision sites — `agentDriver.ts`'s auto
 * branch and `allowAllPending`, and `buildCanUseTool` below. Each site calls
 * this; none reimplements the membership test, so "the three sites consult the
 * same set" is true by construction rather than by three matching edits.
 *
 * Four gates, in order, each of which returns `null` (= behave exactly as
 * today):
 *
 *  1. `MPAI_CONTESTED_GATE === "0"` — the kill switch (spec §8a ruling 4).
 *     Read HERE, per decision, never cached at module load: that is what makes
 *     it honoured per-gate in tests and effective on the first gate after a
 *     relaunch. It does NOT make it flippable on a live process — `process.env`
 *     cannot be changed from outside a running node process, so a live laptop
 *     still needs a restart (and that restart costs every in-flight turn, every
 *     unanswered gate, and all three per-session in-memory sets, `contestedAsked`
 *     included). Tier (a) surfaces are deliberately NOT behind this switch.
 *  2. the write is not to a contested path — `contestedWrite`, which also
 *     absorbs the no-workdir, non-write-tool, non-object-input and
 *     outside-the-worktree cases and never throws.
 *  3. the human has already answered for this file in this session
 *     (`contestedAsked`) — the once-per-(file, session) promise.
 *  4. nothing is wired (`getContested` absent on older call sites and test
 *     fakes) — the optional chains below make that the empty set.
 *
 * ADVISORY, never blocking: the strongest thing a non-null answer causes is
 * auto-approve → ask a human, once. No caller may turn it into a deny.
 *
 * The peer id is interpolated VERBATIM — never re-parsed, escaped or truncated
 * here. Safe because Task 6a validates every peer id with `SLUG`
 * (`/^[a-z0-9-]{1,40}$/`) before it can reach a frame this laptop stores, which
 * also puts the 512-char gate-reason cap out of reach by construction:
 * `"contested with session "` (23) + ≤ 40.
 *
 * `contestedSessionsFor` answers `[]` for a path the hub listed in `paths` with
 * no matching `collisions` entry (the two lists are bounded independently, see
 * `contested.ts`). Withdrawal still applies — the path IS contested — but there
 * is no peer to name, so the reason degrades to the bare `"contested"` rather
 * than naming a session nobody reported.
 */
export function contestedWriteReason(
  toolName: string,
  input: unknown,
  hooks: Pick<DriverHooks, "workdir" | "getContested" | "contestedAsked" | "contestedSessions">,
): { path: string; reason: string } | null {
  if (process.env.MPAI_CONTESTED_GATE === "0") return null;
  const contestedPath = contestedWrite(
    toolName,
    input,
    hooks.workdir,
    hooks.getContested?.() ?? NO_CONTESTED,
  );
  if (contestedPath === null) return null;
  if (hooks.contestedAsked?.().has(contestedPath)) return null;
  const peers = hooks.contestedSessions?.(contestedPath) ?? [];
  const peer = peers[0];
  return {
    path: contestedPath,
    reason: peer === undefined ? "contested" : `contested with session ${peer}`,
  };
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
      // Decision site 3 (spec §6b, Task 8b). The contained-write early allow
      // fires regardless of permission mode, so it is the ONLY site that can
      // let a contested write through in `default` mode — and it runs BEFORE
      // any `permission_request` event exists, which is why the freshness
      // recompute above had to move here. A withdrawal falls straight through
      // to the driver ask below; that ask is site 1's hook, which re-derives
      // the same answer and puts the reason on the event.
      if (
        isContainedWrite(hooks.workdir, input) &&
        contestedWriteReason(toolName, input, hooks) === null
      ) {
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
