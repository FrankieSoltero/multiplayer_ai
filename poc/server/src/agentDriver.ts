import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AsyncQueue } from "./asyncQueue.js";
import { MODELS, DEFAULT_MODEL, type ModelKey } from "./models.js";
import { buildCanUseTool } from "./permissions.js";
import type { Session } from "./session.js";
import type { TodoItem } from "./events.js";

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
  content?: unknown[];
  message?: { content?: unknown[] };
  parent_tool_use_id?: string | null;
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
}

export type RunQueryResult = AsyncIterable<SdkMessage> & {
  /** Present on the real SDK Query (sdk.d.ts Query.setModel); absent on plain test fakes. */
  setModel?(model: string): Promise<void>;
  /** Present on the real SDK Query (sdk.d.ts Query.setPermissionMode); absent on plain test fakes. */
  setPermissionMode?(mode: string): Promise<void>;
};

export type RunQuery = (
  prompts: AsyncIterable<SdkUserMessage>,
  hooks: DriverHooks,
) => RunQueryResult;

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
    ],
  });
  const workdir = hooks.workdir ?? process.env.AGENT_WORKDIR ?? process.cwd();
  // Env-driven skill allowlist: `skills: "all"` previously exposed the host
  // CLI's own BUILT-IN skills (dataviz, update-config, loop, schedule, ...)
  // to the agent — an isolation leak reproduced live. An empty array hides
  // every skill by default (matching the settingSources: [] isolation
  // below); ops opt specific project skills in per-demo via
  // AGENT_SKILLS=comma,separated,names (matching SKILL.md name/dir, or
  // plugin:skill).
  const skillNames = (process.env.AGENT_SKILLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
      // Skills come from the project the agent works in (its worktree cwd
      // has .claude/skills/ checked in) — the single, explicit re-opening of
      // the settingSources isolation below. This option also enables the
      // Skill tool; do not add 'Skill' to allowedTools. Default is an empty
      // allowlist (no skills visible) — see the isolation-leak note above
      // skillNames; set AGENT_SKILLS to opt specific project skills in.
      skills: skillNames,
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
  private pendingPermissions = new Map<string, (d: "allow" | "deny") => void>();
  private pendingPlans = new Map<string, (d: "approve" | "reject") => void>();
  private dead = false;
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

  constructor(
    private session: Session,
    run: RunQuery = runAgentQuery,
    workdir?: string,
  ) {
    this.stream = run(this.prompts, {
      onIntent: (text) =>
        this.session.append({ type: "intent_update", text: text.slice(0, 200) }),
      onPermissionRequest: (toolName, input, signal) => {
        const requestId = randomUUID();
        let resolve!: (d: "allow" | "deny") => void;
        const pending = new Promise<"allow" | "deny">((res) => {
          resolve = res;
        });
        // Register the resolver BEFORE appending, so a subscriber that
        // decides synchronously on seeing the event still finds it.
        this.pendingPermissions.set(requestId, resolve);
        this.session.append({
          type: "permission_request",
          requestId,
          toolName,
          input,
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
    });
    void this.consume(this.stream);
  }

  get isDead(): boolean {
    return this.dead;
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
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    this.session.append({ type: "permission_decision", requestId, decision, userId });
    resolve(decision);
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
    mode: "plan" | "default",
    userId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.dead) return { ok: false, error: "agent session has ended" };
    if (this.pendingTurns > 0)
      return { ok: false, error: "agent is mid-turn — wait for it to finish" };
    if (!this.stream.setPermissionMode)
      return { ok: false, error: "plan mode not supported by this agent" };
    void this.stream.setPermissionMode(mode).catch((err) =>
      this.session.append({
        type: "agent_error",
        message: `permission mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    this.session.append({ type: "permission_mode_change", mode, userId });
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
      this.denyAllPending("stream ended");
    } catch (err) {
      // Fatal errors on the stream itself (e.g. the iterable throws) still
      // need to be surfaced, but at this point the stream is done for good.
      this.dead = true;
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
    for (const [requestId, resolve] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      this.session.append({
        type: "permission_decision",
        requestId,
        decision: "deny",
        userId: "system",
      });
      resolve("deny");
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

  private handleMessage(message: SdkMessage): void {
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
    if (message.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          this.session.append({
            type: "agent_text_delta",
            text: block.text,
            ...(parentId ? { parentToolUseId: parentId } : {}),
          });
        } else if (block.type === "tool_use" && block.name) {
          if (block.id) this.toolNamesById.set(block.id, block.name);
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
            if (typeof subject === "string" && subject.length > 0 && this.taskPanel.length < 50) {
              this.taskPanel.push({
                id: String(this.taskPanel.length + 1),
                text: subject.slice(0, 200),
                status: "pending",
              });
              this.session.append({
                type: "todo_update",
                todos: this.taskPanel.map(({ text, status }) => ({ text, status })),
              });
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
        this.session.append({ type: "turn_end" });
      }
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const text = this.extractToolResultText(block.content);
          const toolName =
            (block.tool_use_id && this.toolNamesById.get(block.tool_use_id)) ??
            "tool";
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
}
