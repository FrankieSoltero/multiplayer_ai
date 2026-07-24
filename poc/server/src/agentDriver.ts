import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AsyncQueue } from "./asyncQueue.js";
import type { Session } from "./session.js";

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
}

export interface DriverHooks {
  onIntent: (text: string) => void;
  workdir?: string;
}

export type RunQuery = (
  prompts: AsyncIterable<SdkUserMessage>,
  hooks: DriverHooks,
) => AsyncIterable<SdkMessage>;

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
  return query({
    prompt: prompts,
    options: {
      model: "claude-opus-4-8",
      systemPrompt:
        "You are a shared agent in a multiplayer project. Multiple teammates watch this session live and may hand control between them mid-task; other teammates run their own sessions in the same project. Keep responses focused. The FIRST thing you do when given a new task — before any other tool call — is call the set_intent tool with one short sentence describing what you are about to work on. Update it whenever your direction changes. Do this without being asked. Your working directory is your own git worktree on your own branch — you may implement changes directly with Write/Edit when asked to build; your edits never touch teammates' worktrees, but overlapping changes will collide later at merge time. A <teammates> block in a prompt describes what other sessions in the project are doing — take it into account: avoid conflicting with in-flight work, keep your footprint on shared files minimal when a teammate is mid-change there, and say so when a merge conflict looks likely.",
      // `tools` restricts BUILT-IN tools only; the MCP set_intent tool arrives
      // via mcpServers and is auto-approved through allowedTools.
      // Write/Edit enabled so agents can build in their own worktrees; Bash
      // stays off (no command execution) until sandboxing gets a real pass.
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        "mcp__awareness__set_intent",
      ],
      tools: ["Read", "Glob", "Grep", "Write", "Edit"],
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
      cwd: hooks.workdir ?? process.env.AGENT_WORKDIR ?? process.cwd(),
    },
    // Cast at the SDK boundary only — see Global Constraints. The real
    // `query()` return type (`Query`, an AsyncGenerator over a 30+ member
    // `SDKMessage` union) structurally over-specifies our minimal read-side
    // `SdkMessage` type, so a direct assignment doesn't typecheck even
    // though every member we care about (assistant/user/result) is
    // compatible at runtime.
  }) as unknown as AsyncIterable<SdkMessage>;
};

export class AgentDriver {
  private prompts = new AsyncQueue<SdkUserMessage>();
  private toolNamesById = new Map<string, string>();
  private dead = false;

  constructor(
    private session: Session,
    run: RunQuery = runAgentQuery,
    workdir?: string,
  ) {
    void this.consume(
      run(this.prompts, {
        onIntent: (text) =>
          this.session.append({ type: "intent_update", text: text.slice(0, 200) }),
        workdir,
      }),
    );
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
    this.session.append({ type: "user_message", userId, text });
    const promptText = contextBlock ? `${contextBlock}\n\n${text}` : text;
    this.prompts.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: promptText }] },
      parent_tool_use_id: null,
    });
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
    } catch (err) {
      // Fatal errors on the stream itself (e.g. the iterable throws) still
      // need to be surfaced, but at this point the stream is done for good.
      this.dead = true;
      this.session.append({
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      });
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
    if (message.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          this.session.append({ type: "agent_text_delta", text: block.text });
        } else if (block.type === "tool_use" && block.name) {
          if (block.id) this.toolNamesById.set(block.id, block.name);
          this.session.append({
            type: "tool_call",
            toolName: block.name,
            input: block.input,
          });
        }
      }
    } else if (message.type === "result" || message.type === "user") {
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
}
