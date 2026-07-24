import { query } from "@anthropic-ai/claude-agent-sdk";
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

export type RunQuery = (
  prompts: AsyncIterable<SdkUserMessage>,
) => AsyncIterable<SdkMessage>;

export const runAgentQuery: RunQuery = (prompts) =>
  query({
    prompt: prompts,
    options: {
      model: "claude-opus-4-8",
      systemPrompt:
        "You are a shared agent in a multiplayer session. Multiple teammates watch this session live and may hand control between them mid-task. Keep responses focused.",
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "default",
      cwd: process.env.AGENT_WORKDIR ?? process.cwd(),
    },
    // Cast at the SDK boundary only — see Global Constraints. The real
    // `query()` return type (`Query`, an AsyncGenerator over a 30+ member
    // `SDKMessage` union) structurally over-specifies our minimal read-side
    // `SdkMessage` type, so a direct assignment doesn't typecheck even
    // though every member we care about (assistant/user/result) is
    // compatible at runtime.
  }) as unknown as AsyncIterable<SdkMessage>;

export class AgentDriver {
  private prompts = new AsyncQueue<SdkUserMessage>();
  private toolNamesById = new Map<string, string>();

  constructor(
    private session: Session,
    run: RunQuery = runAgentQuery,
  ) {
    void this.consume(run(this.prompts));
  }

  sendPrompt(userId: string, text: string): void {
    this.session.append({ type: "user_message", userId, text });
    this.prompts.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    });
  }

  private async consume(messages: AsyncIterable<SdkMessage>): Promise<void> {
    try {
      for await (const message of messages) {
        // Docs show content on the message; some SDK versions nest it under .message
        const blocks = (message.content ?? message.message?.content ?? []) as {
          type: string;
          text?: string;
          name?: string;
          id?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: { type: string; text?: string }[];
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
              const text = (block.content ?? [])
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text)
                .join("\n");
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
    } catch (err) {
      this.session.append({
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
