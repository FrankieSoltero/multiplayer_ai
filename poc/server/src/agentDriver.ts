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
      // `allowedTools` only auto-approves these tools without a permission
      // prompt — it does NOT limit which tools are available to the model
      // (see sdk.d.ts: "To restrict which tools are available, use the
      // `tools` option instead."). `tools` is the knob that actually
      // restricts the base tool set to exactly these three; both are needed
      // so Read/Glob/Grep run unprompted and everything else (Bash, Write,
      // Edit, ...) is unavailable rather than merely un-approved.
      allowedTools: ["Read", "Glob", "Grep"],
      tools: ["Read", "Glob", "Grep"],
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
    } catch (err) {
      // Fatal errors on the stream itself (e.g. the iterable throws) still
      // need to be surfaced, but at this point the stream is done for good.
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
