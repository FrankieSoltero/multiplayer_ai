import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AsyncQueue } from "./asyncQueue.js";
import { MODELS, DEFAULT_MODEL, type ModelKey } from "./models.js";
import { buildCanUseTool, contestedWriteReason, FILE_WRITE_TOOLS } from "./permissions.js";
import type { Session } from "./session.js";
import type { ModelUsageInfo, SessionEvent, SkillInfo, TodoItem } from "./events.js";

/**
 * Message pushed into the SDK's streaming-input queue.
 *
 * The Agent SDK docs suggest a flat `{type:"user", content:[...]}` shape,
 * but the installed SDK's exported `SDKUserMessage` type (see
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) nests content one
 * level deeper as `message: { role: "user", content: [...] }` (an Anthropic
 * `MessageParam`), and additionally requires `parent_tool_use_id`. This type
 * matches the installed SDK's actual shape so `runAgentQuery` can pass
 * prompts straight through to `query()` with no cast needed.
 */
export interface SdkUserMessage {
  type: "user";
  message: {
    role: "user";
    content: { type: "text"; text: string }[];
  };
  parent_tool_use_id: null;
}

export interface SdkMessage {
  type: string;
  subtype?: string;
  content?: unknown[];
  message?: { content?: unknown[] };
  parent_tool_use_id?: string | null;
  // system task messages (task_started/task_progress/task_updated/task_notification)
  task_id?: string;
  // The Task tool call that spawned this sub-session (task_started only,
  // sdk.d.ts:4466-4468). Pinned onto the started task_event as the join field.
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  workflow_name?: string;
  // task_notification terminal status, system/status busy state ('compacting'
  // | 'requesting' | null, sdk.d.ts:4367), or an assistant/api_retry error
  // category — one loose field, each reader validates the values it accepts.
  status?: string | null;
  summary?: string;
  last_tool_name?: string;
  usage?: {
    total_tokens?: number; tool_uses?: number; duration_ms?: number;
    input_tokens?: number; output_tokens?: number;
    cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
  };
  patch?: { status?: string; description?: string; error?: string };
  // task_notification (sdk.d.ts:4430): path to the subagent's transcript.
  output_file?: string;
  // result payloads (SDKResultSuccess/SDKResultError, sdk.d.ts:4239-4290).
  is_error?: boolean;
  errors?: string[];
  terminal_reason?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  modelUsage?: Record<string, ModelUsageInfo>;
  // assistant refusal-fallback signals (sdk.d.ts:2848, 2852): this frame
  // replaces the named earlier frames / was truncated by an interrupt.
  supersedes?: string[];
  aborted?: true;
  // rate_limit_event (SDKRateLimitEvent/SDKRateLimitInfo, sdk.d.ts:4207-4237).
  rate_limit_info?: {
    status?: string;
    rateLimitType?: string;
    utilization?: number;
    resetsAt?: number;
  };
  // system/compact_boundary (SDKCompactBoundaryMessage, sdk.d.ts:2922).
  compact_metadata?: {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
    duration_ms?: number;
  };
  // system/api_retry (SDKAPIRetryMessage, sdk.d.ts:2821); `error` doubles as
  // the assistant-frame error category (sdk.d.ts:2837) — both are strings.
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
}

export interface DriverHooks {
  onIntent: (text: string) => void;
  /**
   * Ask the session's current driver to approve a tool call. Resolves when
   * a driver decides via AgentDriver.resolvePermission — possibly a
   * DIFFERENT user than when the request was raised (wheel handoffs are a
   * feature: a teammate can drop in specifically to approve something).
   * The promise intentionally has no timeout; the agent waits.
   */
  onPermissionRequest: (
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
    meta?: { toolUseId?: string; agentId?: string },
  ) => Promise<"allow" | "deny">;
  /** Surface a permission-flow failure into the session log (agent_error). */
  onPermissionError?: (message: string) => void;
  /**
   * Ask the session's current driver to approve the agent's plan (the
   * ExitPlanMode tool call, held at canUseTool). Same lifetime semantics as
   * onPermissionRequest: no timeout, resolvable by whoever is driving at
   * decision time, abort-safe.
   */
  onPlanRequest: (
    plan: string,
    signal?: AbortSignal,
  ) => Promise<"approve" | "reject">;
  workdir?: string;
  /** Absolute paths of the project's registered plugin clones (v6c). */
  pluginPaths?: string[];
  /** Latest team oversight summary text, or the spec §6 fallback strings.
   *  Absent on drivers constructed without oversight wiring. */
  getOversight?: () => string;
  /** Recompute this session's touched set NOW, synchronously, before a write-tool
   *  permission decision is made (spec §3.2 pre-gate freshness, Task 4).
   *  Absent on drivers constructed without collision wiring — then no recompute
   *  runs and the decision sites judge the last turn-boundary set. */
  recomputeTouched?: () => void;
  /** The reading session's currently-contested repo-relative paths (Task 7a).
   *  Absent on drivers constructed without collision wiring — treat as empty. */
  getContested?: () => ReadonlySet<string>;
  /** Paths this session has already asked a human about (Task 8b bookkeeping).
   *  Absent = empty; membership means "do not withdraw again". */
  contestedAsked?: () => ReadonlySet<string>;
  /** Peer session ids colliding on a path, for the reason line (Task 7a). */
  contestedSessions?: (path: string) => string[];
  /** Record that a human answered a contested gate for this path. */
  onContestedAnswered?: (path: string) => void;
}

export type RunQueryResult = AsyncIterable<SdkMessage> & {
  /** Present on the real SDK Query (sdk.d.ts Query.setModel); absent on plain test fakes. */
  setModel?(model: string): Promise<void>;
  /** Present on the real SDK Query (sdk.d.ts Query.setPermissionMode); absent on plain test fakes. */
  setPermissionMode?(mode: string): Promise<void>;
  /** Present on the real SDK Query (sdk.d.ts Query.stopTask); absent on plain test fakes. */
  stopTask?(taskId: string): Promise<void>;
  /** Present on the real SDK Query (sdk.d.ts:2274 Query.interrupt); absent on plain test fakes. */
  interrupt?(): Promise<unknown>;
  /** Present on the real SDK Query (sdk.d.ts:2446/2452); absent on plain test fakes. */
  reloadPlugins?(): Promise<unknown>;
  reloadSkills?(): Promise<unknown>;
  /** Present on the real SDK Query; returns the live skill list (name + description). */
  supportedCommands?(): Promise<{ name: string; description: string }[]>;
};

export type RunQuery = (
  prompts: AsyncIterable<SdkUserMessage>,
  hooks: DriverHooks,
) => RunQueryResult;

/**
 * Why this guard exists, so nobody removes it as redundant:
 *
 * The SDK spawns its native binary with `cwd: workdir`. If that directory
 * does not exist the spawn fails with ENOENT, and the SDK reports it as
 * "Claude Code native binary ... exists but failed to launch. This usually
 * means the binary does not match this system's libc" — pointing at the
 * architecture of the binary, which is fine, instead of at the cwd, which is
 * not. That red herring cost a full session: the conclusion recorded at the
 * time was "agent turns do not run on this machine."
 *
 * The workdir is missing whenever the server was started WITHOUT a workspace
 * (`node dist/main.js` / `npx tsx src/main.ts` rather than the `mpai` CLI):
 * `server.ts` then derives `AGENT_WORKDIR_ROOT/<sessionId>` and nothing ever
 * creates it. Deliberately NOT auto-created here — an empty non-git directory
 * would let the agent appear to work while operating in an empty folder.
 * Failing loudly, naming the path, is the recorded decision (see the
 * workspace-provisioning entry in HANDOFF §0 and deploy/RUNBOOK.md §0).
 *
 * Returns a human-readable reason, or null when the workdir is usable.
 */
export function describeUnusableWorkdir(workdir: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workdir);
  } catch {
    return (
      `session workspace does not exist: ${workdir} — nothing provisioned it. ` +
      `Start the server from inside a git repo with the \`mpai\` CLI (or pass ` +
      `startServer({ workspace }) ) so each session gets a real worktree.`
    );
  }
  if (!stat.isDirectory()) {
    return `session workspace is not a directory: ${workdir}`;
  }
  return null;
}

/** A stream that fails immediately, so `AgentDriver.consume` surfaces the
 *  reason as a single agent_error and marks the driver dead — the same path
 *  any other fatal stream error takes. */
function failedStream(message: string): RunQueryResult {
  return (async function* (): AsyncGenerator<SdkMessage> {
    throw new Error(message);
  })();
}

export const runAgentQuery: RunQuery = (prompts, hooks) => {
  const awareness = createSdkMcpServer({
    name: "awareness",
    tools: [
      tool(
        "set_intent",
        "Declare or update the one-sentence summary of what you are currently working on, so teammates and their agents stay aware of it. Call this when you start a task and whenever your direction changes.",
        { text: z.string() },
        async ({ text }) => {
          try {
            hooks.onIntent(text);
            return { content: [{ type: "text", text: "intent recorded" }] };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `intent not recorded: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      ),
      tool(
        "team_update",
        "Get the latest team oversight summary: what other sessions in this project are working on right now. Only call this when the driver asks you to bring in team context.",
        {},
        async () => {
          const text = hooks.getOversight?.() ?? "team oversight is disabled";
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });
  const workdir = hooks.workdir ?? process.env.AGENT_WORKDIR ?? process.cwd();
  const workdirProblem = describeUnusableWorkdir(workdir);
  if (workdirProblem) return failedStream(workdirProblem);
  return query({
    prompt: prompts,
    options: {
      model: MODELS[DEFAULT_MODEL].id,
      systemPrompt:
        `You are a shared agent in a multiplayer project. Multiple teammates watch this session live and may hand control between them mid-task; other teammates run their own sessions in the same project. Keep responses focused. The FIRST thing you do when given a new task — before any other tool call — is call the set_intent tool with one short sentence describing what you are about to work on. Update it whenever your direction changes. Do this without being asked. Your working directory is your own git worktree on your own branch — you may implement changes directly with Write/Edit when asked to build; your edits never touch teammates' worktrees, but overlapping changes will collide later at merge time. A <teammates> block in a prompt describes what other sessions in the project are doing — take it into account: avoid conflicting with in-flight work, keep your footprint on shared files minimal when a teammate is mid-change there, and say so when a merge conflict looks likely. You have the full tool set including Bash, subagents, and web tools. Most Bash commands and other powerful tools pause until the teammate currently driving approves them in the UI — the whole session sees each request and decision, so prefer batching related commands and say briefly what a command is for before running it. Test/type-check/read-only-git commands run without approval. If a request is denied, adapt your approach or explain what you need instead of retrying the same call. If the project provides skills, use the Skill tool when one clearly matches the task. Your worktree root is ${workdir} — create and edit files ONLY inside it, using relative paths or absolute paths under that root. File edits inside your worktree run without approval; writes outside it require driver approval.`,
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "mcp__awareness__set_intent",
      ],
      // Full Claude Code built-in tool set. `allowedTools` above auto-approves
      // only the READ-ONLY file tools + set_intent; Write/Edit/NotebookEdit
      // are deliberately NOT here — a live incident had the agent
      // Write-ing outside its worktree, auto-run because Write was
      // blanket-allowed here with no path check. They now route through
      // canUseTool, which auto-approves only when the path resolves inside
      // hooks.workdir (see permissions.ts) and otherwise asks the driver.
      // Every other call (Bash, Task, WebSearch, WebFetch, TodoWrite, ...)
      // also routes through canUseTool = the driver approval gate, except
      // allowlisted Bash prefixes (see permissions.ts).
      tools: { type: "preset", preset: "claude_code" },
      canUseTool: buildCanUseTool(hooks),
      // v6c: full Claude Code skill surface, deliberately. The
      // harness-capabilities-era decision hid built-ins ("skills: 'all'
      // leaked host skills"); built-ins are now a chosen feature (spec §1),
      // and plugin skills arrive via the plugins option below. AGENT_SKILLS
      // is retired.
      skills: "all",
      plugins: (hooks.pluginPaths ?? []).map((p) => ({
        type: "local" as const,
        path: p,
      })),
      permissionMode: "default",
      mcpServers: { awareness },
      // Isolate this demo agent from the operator's local Claude Code config:
      // it must see only the awareness MCP server passed above, never any
      // user/project/local MCP servers or settings (e.g. Google Drive,
      // Playwright, sqlite) that happen to be configured on this machine.
      // `settingSources: []` also intentionally suppresses CLAUDE.md loading
      // (project/user/local) — full isolation, not just MCP.
      strictMcpConfig: true,
      settingSources: [],
      // Forward subagent text/thinking as messages tagged with
      // parent_tool_use_id so the client can render a nested transcript.
      // Default (false) only forwards subagent tool_use/tool_result blocks.
      forwardSubagentText: true,
      // agent-surface §5: populate task_progress/task_notification summaries
      // (the task_event.summary path is already wired end to end; without
      // this flag the SDK leaves it empty).
      agentProgressSummaries: true,
      cwd: workdir,
    },
    // Cast at the SDK boundary only — see Global Constraints. The real
    // `query()` return type (`Query`, an AsyncGenerator over a 30+ member
    // `SDKMessage` union) structurally over-specifies our minimal read-side
    // `SdkMessage` type, so a direct assignment doesn't typecheck even
    // though every member we care about (assistant/user/result) is
    // compatible at runtime.
  }) as unknown as RunQueryResult;
};

export class AgentDriver {
  private prompts = new AsyncQueue<SdkUserMessage>();
  private toolNamesById = new Map<string, string>();
  // Sub-session gate attribution (§2.2): inner toolUseId → its parentToolUseId.
  // Populated when a streamed tool_call carries BOTH its own id and a parentId
  // (a sub-agent's call), read when that call's permission gate arrives (keyed
  // by the SDK's canUseTool toolUseID via `meta.toolUseId`), and deleted when the
  // matching tool_result forwards. DISPLAY metadata only: SDK tool_use ids are
  // unique, so a stale key (tool_result never forwarded on abort/crash) is never
  // looked up again and cannot misattribute (constraint 2). Bounded by tool-call
  // volume for the driver instance's lifetime.
  private subCallParents = new Map<string, string>();
  // The tool name rides alongside the resolver because entering auto mode has
  // to know whether ANY pending request is a file write before it decides to
  // recompute the touched set (decision site 2, Task 4). Kept in the same map
  // rather than a parallel one so a request can never be deleted from one and
  // leak in the other.
  // `input` rides alongside for the same reason `toolName` does: decision site
  // 2 re-judges every pending request against the set that is fresh AT SWEEP
  // TIME (Task 4's single pre-sweep recompute), not against the one that was
  // current when each was queued — so it needs the tool call itself, not a
  // decision cached at queue time.
  // `contestedPath` is the path this request's gate is asking about, or null for
  // an ordinary gate. It exists so `resolvePermission` can record the human's
  // answer against the right file without re-deriving it from a contested set
  // that may have moved since the question was asked.
  // `parentToolUseId` is the sub-session this gate belongs to, or absent for a
  // main-agent gate. Resolved once at request time and stored so every decision
  // path (driver resolve, auto sweep, stream-death/abort deny) inherits the same
  // attribution the request event carried.
  private pendingPermissions = new Map<
    string,
    {
      toolName: string;
      input: unknown;
      contestedPath: string | null;
      parentToolUseId?: string;
      resolve: (d: "allow" | "deny") => void;
    }
  >();
  private pendingPlans = new Map<string, (d: "approve" | "reject") => void>();
  private dead = false;
  // Relay-level permission mode. "auto" is enforced HERE, not in the SDK:
  // the SDK keeps streaming permission_requests and this driver answers
  // them itself, so every gate still lands on the wire (spec §2). The SDK's
  // own mode is only ever set to "plan" or "default".
  private permissionMode: "default" | "plan" | "auto" = "default";
  // Count of turns sent but not yet resolved by a matching "result" message.
  // A boolean here would be wrong: drivers can queue prompt B while prompt A
  // is still mid-turn (input isn't disabled), so result(A) must not flip
  // busy/mid-turn state off while B is still outstanding — only when the
  // count returns to zero.
  private pendingTurns = 0;
  private stream: RunQueryResult;
  // Mirror of the agent's TaskCreate/TaskUpdate bookkeeping (the live SDK's
  // replacement for TodoWrite), used to emit todo_update snapshots. Ids are
  // assigned sequentially from 1 to mirror the SDK's own numbering.
  private taskPanel: { id: string; text: string; status: "pending" | "in_progress" | "completed" }[] = [];
  // Next id to assign on TaskCreate. MUST be its own monotonic counter, not
  // derived from taskPanel.length: the SDK never reuses ids, but a plain
  // length-based id would (create a(1), create b(2), delete a, create c
  // would rederive c's id as 2 — colliding with b's still-live id — and a
  // later TaskUpdate("2") would then corrupt b instead of targeting c).
  // Incremented on every accepted main-agent TaskCreate regardless of the
  // 50-item cap, so ids assigned after the cap kicks in stay aligned with
  // the SDK's own numbering (which keeps counting past 50).
  private nextTaskId = 1;
  // Per-task progress throttle (spec §3): leading append + trailing flush of
  // the latest pending progress. done supersedes and clears. Timers are
  // cleared when the stream dies so nothing appends after teardown.
  private pendingProgress = new Map<string, SessionEvent & { type: "task_event" }>();
  private progressTimers = new Map<string, NodeJS.Timeout>();
  // Set when a driver stop_turn request is issued (agent-surface §2) and
  // consumed by the NEXT result message, whose turn_end is then stamped
  // outcome "interrupted". Query.interrupt() emits no wire message of its
  // own, so without this flag an interrupted turn would be indistinguishable
  // from a finished one — and the record rule (§0 constraint 2) forbids that.
  private interruptPending = false;
  // Leading-edge throttle for rate_limit events (agent-surface §1): the SDK
  // re-emits rate_limit_event on every info change (potentially per request);
  // the wire gets at most one per rateLimitThrottleMs window per session.
  private lastRateLimitAt = 0;

  constructor(
    private session: Session,
    run: RunQuery = runAgentQuery,
    private workdir?: string,
    pluginPaths: string[] = [],
    private onRoster?: (skills: SkillInfo[]) => void,
    private progressThrottleMs = 2000,
    private getOversight?: () => string,
    private recomputeTouched?: () => void,
    private getContested?: () => ReadonlySet<string>,
    private contestedAsked?: () => ReadonlySet<string>,
    private contestedSessions?: (path: string) => string[],
    private onContestedAnswered?: (path: string) => void,
    private rateLimitThrottleMs = 30_000,
  ) {
    this.stream = run(this.prompts, {
      onIntent: (text) =>
        this.session.append({ type: "intent_update", text: text.slice(0, 200) }),
      onPermissionRequest: (toolName, input, signal, meta) => {
        // Decision site 1 (spec §3.2, Task 4). FIRST statement, so the touched
        // set is fresh before the auto branch below resolves the gate — a
        // recompute hung off the appended `permission_request` event would run
        // strictly too late. Write tools only: a Read/Grep/Bash gate must not
        // shell out to git.
        if (FILE_WRITE_TOOLS.has(toolName)) this.recomputeTouched?.();
        const requestId = randomUUID();
        // Sub-session attribution (§2.2). The SDK's own toolUseID for THIS gate
        // (via `meta.toolUseId`) is the key the streaming handler mapped to its
        // parent when the sub-agent's tool_call was appended. Resolved once here
        // so the request event and every decision path share one attribution.
        // Never load-bearing: a miss (main-agent call, meta absent, or entry
        // already deleted) yields `undefined` → no key, byte-identical to today.
        const parentToolUseId = meta?.toolUseId
          ? this.subCallParents.get(meta.toolUseId)
          : undefined;
        // Decision site 1 (spec §6b, Task 8b). Evaluated for EVERY gate, not
        // just the auto branch: a request that reached here from site 3's
        // withdrawal is in `default` mode, and it is this line that puts the
        // reason on its `permission_request` event. `null` = nothing changes.
        const contested = contestedWriteReason(toolName, input, this.contestedHooks());
        if (this.permissionMode === "auto" && contested === null) {
          this.session.append({
            type: "permission_request",
            requestId,
            toolName,
            input,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
          this.session.append({
            type: "permission_decision",
            requestId,
            decision: "allow",
            userId: this.session.driverId ?? "system",
            auto: true,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
          return Promise.resolve("allow" as const);
        }
        let resolve!: (d: "allow" | "deny") => void;
        const pending = new Promise<"allow" | "deny">((res) => {
          resolve = res;
        });
        // Register the resolver BEFORE appending, so a subscriber that
        // decides synchronously on seeing the event still finds it.
        this.pendingPermissions.set(requestId, {
          toolName,
          input,
          contestedPath: contested?.path ?? null,
          ...(parentToolUseId ? { parentToolUseId } : {}),
          resolve,
        });
        this.session.append({
          type: "permission_request",
          requestId,
          toolName,
          input,
          // Spread, not `reason: undefined`: an ordinary gate's event must be
          // byte-identical to the one today's code appends — no `reason` KEY at
          // all, which is what `pendingGateOf` reads as "ordinary".
          ...(contested === null ? {} : { reason: contested.reason }),
          // Same conditional-spread discipline for attribution: absent → no key.
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
        // The SDK aborts canUseTool calls (e.g. the underlying tool_use
        // was interrupted/superseded) independently of any driver
        // decision. Without this, an abort leaves the entry in
        // pendingPermissions forever: resolvePermission would still
        // "succeed" against a request nothing is listening to anymore,
        // and the UI would show a stale, dead approval card.
        if (signal) {
          const denyOnAbort = () => {
            // delete() returns false if resolvePermission (or a prior
            // abort) already closed this request out — don't double-log
            // or double-resolve.
            if (!this.pendingPermissions.delete(requestId)) return;
            this.session.append({
              type: "permission_decision",
              requestId,
              decision: "deny",
              userId: "system",
              ...(parentToolUseId ? { parentToolUseId } : {}),
            });
            resolve("deny");
          };
          if (signal.aborted) denyOnAbort();
          else signal.addEventListener("abort", denyOnAbort, { once: true });
        }
        return pending;
      },
      onPermissionError: (message) =>
        this.session.append({ type: "agent_error", message }),
      onPlanRequest: (plan, signal) => {
        const requestId = randomUUID();
        let resolve!: (d: "approve" | "reject") => void;
        const pending = new Promise<"approve" | "reject">((res) => {
          resolve = res;
        });
        this.pendingPlans.set(requestId, resolve);
        this.session.append({
          type: "plan_request",
          requestId,
          plan: plan.slice(0, 20000),
        });
        if (signal) {
          const rejectOnAbort = () => {
            if (!this.pendingPlans.delete(requestId)) return;
            this.session.append({
              type: "plan_decision",
              requestId,
              decision: "reject",
              userId: "system",
            });
            resolve("reject");
          };
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        }
        return pending;
      },
      workdir,
      pluginPaths,
      getOversight: this.getOversight,
      // Site 3 (`buildCanUseTool`) reads it off THIS object; sites 1 and 2 call
      // `this.recomputeTouched` — the same closure either way.
      recomputeTouched: this.recomputeTouched,
      // Same arrangement for the contested wiring (Task 8b): site 3 reads these
      // four off THIS object, sites 1 and 2 read the identical closures off
      // `this`. One source of truth, three readers.
      getContested: this.getContested,
      contestedAsked: this.contestedAsked,
      contestedSessions: this.contestedSessions,
      onContestedAnswered: this.onContestedAnswered,
    });
    void this.consume(this.stream);
    void this.refreshRoster();
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** The four contested closures in the shape `contestedWriteReason` takes —
   *  the SAME functions that ride on the hooks object site 3 reads, so all
   *  three decision sites are looking at one source of truth. Built per
   *  decision rather than stored, because the driver's own fields are the
   *  authority and a cached object is one refactor away from going stale. */
  private contestedHooks(): Pick<
    DriverHooks,
    "workdir" | "getContested" | "contestedAsked" | "contestedSessions"
  > {
    return {
      workdir: this.workdir,
      getContested: this.getContested,
      contestedAsked: this.contestedAsked,
      contestedSessions: this.contestedSessions,
    };
  }

  /**
   * v6c: replace the static plugin-scan roster with the SDK's own skill list
   * once the stream is up. Optional-chained: test fakes without
   * supportedCommands keep the static roster; failures degrade silently for
   * the same reason (roster is a UI nicety, not a correctness surface).
   */
  private async refreshRoster(): Promise<void> {
    const fetchSkills = this.stream.supportedCommands?.bind(this.stream);
    if (!fetchSkills) return;
    try {
      const commands = await fetchSkills();
      const skills = commands.map((c) => ({
        name: c.name,
        description: (c.description ?? "").slice(0, 200),
      }));
      this.session.append({ type: "skill_roster", skills });
      this.onRoster?.(skills);
    } catch {
      // stream died or predates the control request — static roster stands
    }
  }

  sendPrompt(userId: string, text: string, contextBlock?: string): void {
    if (this.dead) {
      this.session.append({
        type: "agent_error",
        message: "agent session has ended — restart the server to continue",
      });
      return;
    }
    this.pendingTurns++;
    this.session.append({ type: "user_message", userId, text });
    const promptText = contextBlock ? `${contextBlock}\n\n${text}` : text;
    this.prompts.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: promptText }] },
      parent_tool_use_id: null,
    });
  }

  /**
   * Enqueue a driver-approved skill invocation. Unlike sendPrompt this appends
   * NO user_message — the skill_suggest/skill_decision pair (appended by the
   * server) is the transcript record; a synthetic user row would double-log it.
   */
  runSkill(skill: string, args: string): void {
    if (this.dead) {
      this.session.append({
        type: "agent_error",
        message: "agent session has ended — restart the server to continue",
      });
      return;
    }
    this.pendingTurns++;
    const argText = args ? ` with these arguments: ${args}` : "";
    this.prompts.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `Invoke the project skill "${skill}" using the Skill tool${argText}, then follow the skill's instructions.`,
          },
        ],
      },
      parent_tool_use_id: null,
    });
  }

  /**
   * Resolve a pending permission request. Validated by the caller (server)
   * to be the session's CURRENT driver — which may be a different user than
   * when the request was raised. Returns false for unknown or
   * already-decided requestIds.
   */
  resolvePermission(
    requestId: string,
    decision: "allow" | "deny",
    userId: string,
  ): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    this.session.append({
      type: "permission_decision",
      requestId,
      decision,
      userId,
      // Inherit the request's sub-session attribution (§2.2); absent → no key.
      ...(pending.parentToolUseId ? { parentToolUseId: pending.parentToolUseId } : {}),
    });
    // A HUMAN answered this contested gate — allow and deny are both answers
    // (spec §6b), so the file is not asked about again for the rest of this
    // session. Deliberately NOT done in `denyAllPending` or the abort path:
    // those are system-attributed, nobody saw the question, and treating them
    // as answers would spend the one interruption this file gets on nothing.
    // Recorded BEFORE resolving, so the agent's very next write to the same
    // file already sees the path in `contestedAsked`.
    if (pending.contestedPath !== null) this.onContestedAnswered?.(pending.contestedPath);
    pending.resolve(decision);
    return true;
  }

  /**
   * Resolve a pending plan request. Driver-validated by the server at
   * DECISION time (wheel handoffs mid-plan are a feature). On approve, also
   * switch the SDK back to default permission mode — plan mode's job is done
   * once a plan is accepted; without this the agent would present plans
   * forever. The switch is fire-and-forget like setModel: mode-change is
   * logged optimistically and a trailing agent_error means it may not have
   * taken.
   */
  resolvePlan(
    requestId: string,
    decision: "approve" | "reject",
    userId: string,
  ): boolean {
    const resolve = this.pendingPlans.get(requestId);
    if (!resolve) return false;
    this.pendingPlans.delete(requestId);
    this.session.append({ type: "plan_decision", requestId, decision, userId });
    if (decision === "approve") {
      this.permissionMode = "default";
      void this.stream.setPermissionMode?.("default").catch((err) =>
        this.session.append({
          type: "agent_error",
          message: `permission mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      this.session.append({ type: "permission_mode_change", mode: "default", userId });
    }
    resolve(decision);
    return true;
  }

  setPermissionMode(
    mode: "plan" | "default" | "auto",
    userId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    // v6a: no mid-turn guard — flipping to auto mid-turn is how a driver
    // rescues a turn stuck on gates, and the SDK accepts setPermissionMode
    // control requests mid-turn.
    if (mode !== "auto" && !this.stream.setPermissionMode)
      return { ok: false, error: "plan mode not supported by this agent" };
    // auto maps to SDK "default": gates keep flowing, the relay answers them.
    const sdkMode = mode === "auto" ? "default" : mode;
    void this.stream.setPermissionMode?.(sdkMode).catch((err) =>
      this.session.append({
        type: "agent_error",
        message: `permission mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    this.permissionMode = mode;
    this.session.append({ type: "permission_mode_change", mode, userId });
    if (mode === "auto") {
      // Decision site 2 (spec §3.2, Task 4). ONE recompute for the whole batch,
      // immediately before `allowAllPending` decides them — never one per
      // pending request, and never at all unless a file write is among them.
      if (
        [...this.pendingPermissions.values()].some((p) =>
          FILE_WRITE_TOOLS.has(p.toolName),
        )
      ) {
        this.recomputeTouched?.();
      }
      this.allowAllPending(userId);
    }
    return { ok: true };
  }

  setModel(
    key: ModelKey,
    userId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    if (this.pendingTurns > 0)
      return { ok: false, error: "agent is mid-turn — wait for it to finish" };
    if (!this.stream.setModel)
      return { ok: false, error: "model switching not supported by this agent" };
    // Fire-and-forget: the SDK call is a control request; failures surface as
    // agent_error rather than blocking the wire handler.
    void this.stream.setModel(MODELS[key].id).catch((err) =>
      this.session.append({
        type: "agent_error",
        message: `model switch failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    this.session.append({ type: "model_change", model: key, userId });
    return { ok: true };
  }

  /**
   * Human-requested stop of a running SDK task (spec §4). The attributed
   * task_stop lands on the wire BEFORE the SDK call — the request is a fact
   * even if the task finishes first. Confirmation is never synthesized: the
   * SDK's own task_notification (status "stopped") flows back via
   * handleTaskMessage. Fire-and-forget like setModel: SDK rejection surfaces
   * as agent_error, an absent stopTask (fakes/old streams) is a no-op.
   */
  stopTask(
    taskId: string,
    userId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    this.session.append({ type: "task_stop", taskId, userId });
    void this.stream.stopTask?.(taskId).catch((err) =>
      this.session.append({
        type: "agent_error",
        message: `task stop failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return { ok: true };
  }

  /**
   * Human-requested interrupt of the running turn (agent-surface §2). Driver-
   * gated by the server exactly like stopTask. The attributed turn_stop lands
   * on the wire BEFORE the SDK call — the request is a fact even if the turn
   * finishes first. The interrupted OUTCOME is not synthesized here: the next
   * result's turn_end carries `outcome: "interrupted"` via interruptPending
   * (Query.interrupt() emits no wire message of its own, sdk.d.ts:2274).
   * No-op (ok, nothing appended) when no turn is running — there is nothing
   * to interrupt and an event would claim otherwise. Fire-and-forget like
   * setModel: SDK rejection surfaces as agent_error.
   */
  stopTurn(userId: string): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    if (this.pendingTurns === 0) return { ok: true }; // no turn running: no-op
    if (!this.stream.interrupt)
      return { ok: false, error: "interrupt not supported by this agent" };
    this.interruptPending = true;
    this.session.append({ type: "turn_stop", userId });
    void this.stream.interrupt().catch((err) => {
      this.interruptPending = false;
      this.session.append({
        type: "agent_error",
        message: `turn interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    return { ok: true };
  }

  /**
   * A plugin_change (add/remove) landed in the project registry: ask the live
   * query to reload skills/plugins (sdk.d.ts:2446/2452) and re-fetch the
   * roster so a fresh skill_roster event follows the change. Caveat, recorded
   * per the plan's "document why" clause: the query's plugin PATHS were frozen
   * at session start, so a newly ADDED plugin is only picked up by sessions
   * created after the add (server.test.ts pins this) — reload refreshes the
   * skills/commands of plugins the live query already knows and drops removed
   * ones where the CLI supports it. Fire-and-forget: failures surface as
   * agent_error, absent methods (fakes/old streams) degrade to the refetch.
   */
  reloadPlugins(): void {
    if (this.dead) return;
    const fail = (what: string) => (err: unknown) =>
      this.session.append({
        type: "agent_error",
        message: `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    void this.stream.reloadSkills?.().catch(fail("skill reload"));
    void this.stream.reloadPlugins?.().catch(fail("plugin reload"));
    void this.refreshRoster();
  }

  private async consume(messages: AsyncIterable<SdkMessage>): Promise<void> {
    try {
      for await (const message of messages) {
        try {
          this.handleMessage(message);
        } catch (err) {
          // Contain the failure to this one message so a single malformed
          // message (e.g. an unexpected shape from the live SDK) doesn't
          // kill the driver's ability to keep consuming the stream.
          this.session.append({
            type: "agent_error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // The stream ended normally (the SDK query completed/closed) — the
      // driver can no longer accept prompts.
      this.dead = true;
      this.clearProgressTimers(true);
      this.denyAllPending("stream ended");
    } catch (err) {
      // Fatal errors on the stream itself (e.g. the iterable throws) still
      // need to be surfaced, but at this point the stream is done for good.
      this.dead = true;
      this.clearProgressTimers(false);
      this.denyAllPending("stream failed");
      this.session.append({
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Flush every still-pending permission request when the driver's stream
   * dies (normal end or fatal error), so none is left "waiting" forever.
   * Without this, a request pending at stream death stays in
   * `pendingPermissions` indefinitely: nothing is listening to it anymore,
   * yet a later `resolvePermission` call would still "succeed" against it
   * and log a false audit event for a decision that reached no live agent.
   * Mirrors the abort-cleanup shape in the `onPermissionRequest` hook below
   * (system-attributed deny + permission_decision event) so the audit trail
   * is consistent regardless of why a pending request never got a real
   * decision.
   */
  private denyAllPending(_reason: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      this.session.append({
        type: "permission_decision",
        requestId,
        decision: "deny",
        userId: "system",
        ...(pending.parentToolUseId ? { parentToolUseId: pending.parentToolUseId } : {}),
      });
      pending.resolve("deny");
    }
    for (const [requestId, resolve] of this.pendingPlans) {
      this.pendingPlans.delete(requestId);
      this.session.append({
        type: "plan_decision",
        requestId,
        decision: "reject",
        userId: "system",
      });
      resolve("reject");
    }
  }

  /**
   * Entering auto mode: allow every still-pending permission request,
   * attributed to the driver who set the mode (server-validated). Mirrors
   * denyAllPending's delete-first shape so the abort listeners registered in
   * onPermissionRequest can never double-log (their delete() returns false).
   * Plan requests are deliberately NOT touched — plan review is a human
   * checkpoint, not a tool gate.
   */
  private allowAllPending(userId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      // Decision site 2 (spec §6b, Task 8b). Re-judged HERE, against the set
      // Task 4's single pre-sweep recompute just wrote — not against whatever
      // was contested when this request was queued. A contested write is
      // LEFT PENDING: not resolved, not denied, still answerable by a human,
      // and its path is stamped on the entry so that answer records against the
      // right file.
      const contested = contestedWriteReason(
        pending.toolName,
        pending.input,
        this.contestedHooks(),
      );
      if (contested !== null) {
        pending.contestedPath = contested.path;
        continue;
      }
      this.pendingPermissions.delete(requestId);
      this.session.append({
        type: "permission_decision",
        requestId,
        decision: "allow",
        userId,
        auto: true,
        ...(pending.parentToolUseId ? { parentToolUseId: pending.parentToolUseId } : {}),
      });
      pending.resolve("allow");
    }
  }

  private handleMessage(message: SdkMessage): void {
    if (message.type === "system") {
      this.handleSystemMessage(message);
      return;
    }
    if (message.type === "rate_limit_event") {
      this.handleRateLimit(message);
      return;
    }
    // Docs show content on the message; some SDK versions nest it under .message
    const blocks = (message.content ?? message.message?.content ?? []) as {
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: string | { type: string; text?: string }[];
    }[];
    const parentId = message.parent_tool_use_id ?? undefined;
    // Refusal-fallback signals on the assistant frame (agent-surface §3,
    // sdk.d.ts:2848/2852): carried through as additive flags on this frame's
    // deltas so the client can mark retracted/truncated content later.
    const supersedes = Array.isArray(message.supersedes) && message.supersedes.length > 0;
    const aborted = message.aborted === true;
    if (message.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          this.session.append({
            type: "agent_text_delta",
            text: block.text,
            ...(parentId ? { parentToolUseId: parentId } : {}),
            ...(supersedes ? { supersedes: true as const } : {}),
            ...(aborted ? { aborted: true as const } : {}),
          });
        } else if (block.type === "tool_use" && block.name) {
          if (block.id) this.toolNamesById.set(block.id, block.name);
          // Sub-session attribution (§2.2): a call carrying BOTH its own id and a
          // parentId is a sub-agent's tool call — map its id to its parent so the
          // permission gate it later raises can be attributed. Same guard as the
          // conditional spreads on this event, so the index only ever holds real
          // (id, parent) pairs.
          if (block.id && parentId) this.subCallParents.set(block.id, parentId);
          this.session.append({
            type: "tool_call",
            toolName: block.name,
            input: block.input,
            ...(block.id ? { toolUseId: block.id } : {}),
            ...(parentId ? { parentToolUseId: parentId } : {}),
          });
          if (block.name === "TodoWrite" && !parentId) {
            const todos = this.todosFrom(block.input);
            if (todos) this.session.append({ type: "todo_update", todos });
          } else if (block.name === "TaskCreate" && !parentId) {
            const subject = (block.input as { subject?: unknown } | undefined)
              ?.subject;
            if (typeof subject === "string" && subject.length > 0) {
              // Assign the id and advance the counter regardless of the cap
              // below, so ids stay aligned with the SDK's own monotonic
              // numbering even once the panel itself stops growing.
              const id = String(this.nextTaskId++);
              if (this.taskPanel.length < 50) {
                this.taskPanel.push({ id, text: subject.slice(0, 200), status: "pending" });
                this.session.append({
                  type: "todo_update",
                  todos: this.taskPanel.map(({ text, status }) => ({ text, status })),
                });
              }
            }
          } else if (block.name === "TaskUpdate" && !parentId) {
            const { taskId, status, subject } = (block.input ?? {}) as {
              taskId?: unknown;
              status?: unknown;
              subject?: unknown;
            };
            const entry = this.taskPanel.find((t) => t.id === taskId);
            if (entry) {
              if (status === "deleted") {
                this.taskPanel = this.taskPanel.filter((t) => t !== entry);
              } else {
                const validStatuses = new Set(["pending", "in_progress", "completed"]);
                if (typeof status === "string" && validStatuses.has(status)) {
                  entry.status = status as "pending" | "in_progress" | "completed";
                }
                if (typeof subject === "string" && subject.length > 0) {
                  entry.text = subject.slice(0, 200);
                }
              }
              this.session.append({
                type: "todo_update",
                todos: this.taskPanel.map(({ text, status }) => ({ text, status })),
              });
            }
          }
        }
      }
    } else if (message.type === "result" || message.type === "user") {
      if (message.type === "result") {
        // A result ends the SDK's current response cycle. The SDK may fold
        // prompts queued mid-turn into ONE cycle (one result for N prompts),
        // so counting down per-result can leave the counter — and the
        // client's busy signal, and the setModel gate — stuck above zero
        // forever (reproduced live). Treat every result as end-of-turn; if
        // a genuinely queued cycle follows, the client re-raises busy from
        // that cycle's first activity event.
        this.pendingTurns = 0;
        // Outcome classification (agent-surface §2/§3). A stop_turn interrupt
        // wins over the SDK's own error subtype: an interrupted turn is a
        // deliberate human act, not a failure — no agent_error, no error
        // fields, just the distinct outcome on the turn_end.
        const interrupted = this.interruptPending;
        this.interruptPending = false;
        const subtype =
          typeof message.subtype === "string" ? message.subtype : undefined;
        // An error SUBTYPE is one of the SDK's error_* values. Live proof
        // (2026-08-03): an API-level failure arrives as subtype "success"
        // with is_error true and terminal_reason set — composing "turn failed
        // (success)" from that is nonsense, so only error_* subtypes are
        // rendered/stamped as subtypes; the reason carries everything else.
        const isErrorSubtype = subtype?.startsWith("error") === true;
        const isError =
          !interrupted &&
          (message.is_error === true || isErrorSubtype);
        const outcome = interrupted ? "interrupted" : isError ? "error" : "success";
        const errorReason = isError
          ? message.terminal_reason ??
            message.errors?.[0] ??
            (isErrorSubtype ? subtype : undefined)
          : undefined;
        if (isError) {
          // Appended BEFORE the turn_end so record.ts groups the failure with
          // the turn that produced it, not the next one. The reason is real:
          // terminal_reason, else the first errors[] entry, else the subtype.
          this.session.append({
            type: "agent_error",
            message:
              "turn failed" +
              (isErrorSubtype ? ` (${subtype})` : "") +
              (errorReason && errorReason !== subtype ? `: ${errorReason}` : ""),
          });
        }
        this.session.append({
          type: "turn_end",
          outcome,
          ...(typeof message.total_cost_usd === "number"
            ? { total_cost_usd: message.total_cost_usd }
            : {}),
          ...(message.usage ? { usage: message.usage } : {}),
          ...(message.modelUsage ? { modelUsage: message.modelUsage } : {}),
          ...(typeof message.duration_ms === "number"
            ? { duration_ms: message.duration_ms }
            : {}),
          ...(typeof message.num_turns === "number" ? { num_turns: message.num_turns } : {}),
          ...(isError && isErrorSubtype ? { errorSubtype: subtype } : {}),
          ...(errorReason ? { errorReason } : {}),
        });
      }
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const text = this.extractToolResultText(block.content);
          const toolName =
            (block.tool_use_id && this.toolNamesById.get(block.tool_use_id)) ??
            "tool";
          // Sub-session attribution (§2.2): the call is done, so drop its parent
          // mapping. A later gate that reuses this id (SDK ids are unique, so it
          // won't) would be unattributed — the correct default.
          if (block.tool_use_id) this.subCallParents.delete(block.tool_use_id);
          this.session.append({
            type: "tool_result",
            toolName,
            output: text.slice(0, 2000),
            ...(block.tool_use_id ? { toolUseId: block.tool_use_id } : {}),
            ...(parentId ? { parentToolUseId: parentId } : {}),
          });
        }
      }
    }
  }

  /**
   * Live SDK `tool_result` blocks may carry `content` as a plain string
   * instead of the documented array of content blocks. Accept either shape;
   * anything else is genuinely malformed and is surfaced as an error so it
   * gets logged as `agent_error` (by the per-message try/catch in `consume`)
   * rather than silently dropped, while the driver keeps consuming the
   * stream.
   */
  private extractToolResultText(
    content: string | { type: string; text?: string }[] | undefined,
  ): string {
    if (content === undefined) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
    }
    throw new Error(
      `tool_result content has unsupported shape: ${typeof content}`,
    );
  }

  /**
   * Parse a TodoWrite input into wire TodoItems. The SDK's TodoWrite input is
   * { todos: [{ content, status, activeForm }] }; we keep content/status only,
   * drop malformed entries, and cap list size and text length for wire hygiene.
   */
  private todosFrom(input: unknown): TodoItem[] | null {
    const todos = (input as { todos?: unknown }).todos;
    if (!Array.isArray(todos)) return null;
    const valid = new Set(["pending", "in_progress", "completed"]);
    return todos.slice(0, 50).flatMap((t) => {
      const { content, status } = t as { content?: unknown; status?: unknown };
      if (typeof content !== "string" || typeof status !== "string" || !valid.has(status)) return [];
      return [{ text: content.slice(0, 200), status: status as TodoItem["status"] }];
    });
  }

  /** Dispatch system messages (agent-surface §3/§4/§6). Task lifecycle
   *  subtypes fall through to handleTaskMessage; everything else is mapped
   *  here or ignored (unknown subtypes die quietly, same as before). */
  private handleSystemMessage(message: SdkMessage): void {
    switch (message.subtype) {
      case "compact_boundary": {
        const meta = message.compact_metadata ?? {};
        this.session.append({
          type: "compaction",
          ...(meta.trigger ? { trigger: meta.trigger } : {}),
          ...(meta.pre_tokens !== undefined ? { preTokens: meta.pre_tokens } : {}),
          ...(meta.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {}),
          ...(meta.duration_ms !== undefined ? { durationMs: meta.duration_ms } : {}),
        });
        return;
      }
      case "status":
        // SDKStatus: 'compacting' | 'requesting' | null (sdk.d.ts:4367). null
        // means the busy state cleared — surfaced as "idle" so clients can
        // drop the indicator without waiting for the turn_end.
        this.session.append({
          type: "agent_status",
          status:
            message.status === "compacting" || message.status === "requesting"
              ? message.status
              : "idle",
        });
        return;
      case "api_retry":
        // Folded into the agent_status path (plan §3 "your call"): it IS a
        // busy-state signal — the agent is mid-turn but stalled on a retry.
        this.session.append({
          type: "agent_status",
          status: "retrying",
          ...(typeof message.attempt === "number" ? { attempt: message.attempt } : {}),
          ...(typeof message.max_retries === "number" ? { maxRetries: message.max_retries } : {}),
          ...(typeof message.retry_delay_ms === "number" ? { retryDelayMs: message.retry_delay_ms } : {}),
          ...(message.error_status !== undefined ? { errorStatus: message.error_status } : {}),
          ...(message.error ? { detail: String(message.error) } : {}),
        });
        return;
      case "commands_changed":
        // The SDK pushed a fresh slash-command list mid-session (sdk.d.ts:2914);
        // supportedCommands() tracks the push, so re-fetching through the one
        // roster path emits a fresh skill_roster with the new skills.
        void this.refreshRoster();
        return;
      case "model_refusal_fallback": {
        // The refused leg's content was already retracted via the supersedes
        // flags on the replacement frame's deltas; this carries the SDK's
        // notice so the transcript can show WHY content was retracted.
        const content = (message as { content?: unknown }).content;
        this.session.append({
          type: "agent_status",
          status: "refusal_fallback",
          ...(typeof content === "string" && content
            ? { detail: content.slice(0, 500) }
            : {}),
        });
        return;
      }
      default:
        this.handleTaskMessage(message);
    }
  }

  /** rate_limit_event → rate_limit (agent-surface §1), leading-edge
   *  throttled to one event per rateLimitThrottleMs window. Malformed info
   *  (no status string) is dropped — the per-message try/catch in consume
   *  stays the backstop for genuinely broken shapes. */
  private handleRateLimit(message: SdkMessage): void {
    const info = message.rate_limit_info;
    if (!info || typeof info.status !== "string") return;
    const now = Date.now();
    if (now - this.lastRateLimitAt < this.rateLimitThrottleMs) return;
    this.lastRateLimitAt = now;
    this.session.append({
      type: "rate_limit",
      status: info.status,
      ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}),
      ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
      ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
    });
  }

  /** Forward the SDK's task lifecycle onto the wire as task_event (spec §3).
   *  Non-task system subtypes are ignored. */
  private handleTaskMessage(message: SdkMessage): void {
    const taskId = message.task_id;
    if (typeof taskId !== "string" || taskId.length === 0) return;
    const usage = message.usage ?? {};
    if (message.subtype === "task_started") {
      this.session.append({
        type: "task_event", taskId, subtype: "started",
        // Task join (§2.1): pin the spawning Task tool call so the client can
        // join this sub-session's transcript to its parent gate. started only;
        // absent leaves the event byte-identical to today.
        ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
        ...(message.description ? { description: message.description } : {}),
        ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
        ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
      });
    } else if (message.subtype === "task_progress") {
      const ev: SessionEvent & { type: "task_event" } = {
        type: "task_event", taskId, subtype: "progress",
        ...(message.description ? { description: message.description } : {}),
        ...(message.summary ? { summary: message.summary } : {}),
        ...(message.last_tool_name ? { lastTool: message.last_tool_name } : {}),
        ...(usage.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
        ...(usage.tool_uses !== undefined ? { toolUses: usage.tool_uses } : {}),
        ...(usage.duration_ms !== undefined ? { durationMs: usage.duration_ms } : {}),
      };
      this.throttleProgress(taskId, ev);
    } else if (message.subtype === "task_updated") {
      const patch = message.patch ?? {};
      this.session.append({
        type: "task_event", taskId, subtype: "updated",
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(patch.error ? { error: patch.error } : {}),
      });
    } else if (message.subtype === "task_notification") {
      // Terminal: supersedes any pending progress for this task.
      const timer = this.progressTimers.get(taskId);
      if (timer) clearTimeout(timer);
      this.progressTimers.delete(taskId);
      this.pendingProgress.delete(taskId);
      this.session.append({
        type: "task_event", taskId, subtype: "done",
        ...(message.status ? { status: message.status } : {}),
        ...(message.summary ? { summary: message.summary } : {}),
        ...(message.output_file ? { outputFile: message.output_file } : {}),
        ...(usage.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
        ...(usage.tool_uses !== undefined ? { toolUses: usage.tool_uses } : {}),
        ...(usage.duration_ms !== undefined ? { durationMs: usage.duration_ms } : {}),
      });
    }
  }

  /** Leading append + trailing latest-wins flush, one window per task. */
  private throttleProgress(taskId: string, ev: SessionEvent & { type: "task_event" }): void {
    if (this.progressTimers.has(taskId)) {
      this.pendingProgress.set(taskId, ev); // latest wins
      return;
    }
    this.session.append(ev);
    this.progressTimers.set(
      taskId,
      setTimeout(() => {
        this.progressTimers.delete(taskId);
        const pending = this.pendingProgress.get(taskId);
        this.pendingProgress.delete(taskId);
        // Re-enter so the flush opens a fresh window (a follow-up burst
        // throttles again instead of appending unthrottled).
        if (pending) this.throttleProgress(taskId, pending);
      }, this.progressThrottleMs),
    );
  }

  /**
   * Stream teardown. On a normal end the pending trailing progress is real
   * data that would otherwise be silently dropped — flush it before clearing.
   * On a fatal stream error, discard: appending task telemetry after an
   * error event would misrepresent the failure order on the wire.
   */
  private clearProgressTimers(flushPending: boolean): void {
    for (const timer of this.progressTimers.values()) clearTimeout(timer);
    this.progressTimers.clear();
    if (flushPending) {
      for (const pending of this.pendingProgress.values()) this.session.append(pending);
    }
    this.pendingProgress.clear();
  }
}
