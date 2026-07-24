import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery } from "../src/agentDriver.js";

const fakeRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "assistant",
      content: [
        { type: "text", text: "hi there" },
        { type: "tool_use", id: "t1", name: "Read", input: { file: "a.ts" } },
      ],
    };
    return; // end the session after one prompt so tests terminate
  }
};

const failingRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    throw new Error("api exploded");
  }
};

const toolResultRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file: "a.ts" } },
      ],
    };
    yield {
      type: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "file contents here" }],
        },
      ],
    };
    return;
  }
};

const longToolResultRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "assistant",
      content: [
        { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x" } },
      ],
    };
    yield {
      type: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "a".repeat(3000) }],
        },
      ],
    };
    return;
  }
};

describe("AgentDriver", () => {
  it("logs the user message, agent text, and tool calls", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, fakeRun);
    driver.sendPrompt("u1", "do the thing");
    await vi.waitFor(() => {
      const types = s.eventsFrom(0).map((e) => e.type);
      expect(types).toEqual(["user_message", "agent_text_delta", "tool_call"]);
    });
  });

  it("logs agent errors as agent_error events instead of crashing", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, failingRun);
    driver.sendPrompt("u1", "boom");
    await vi.waitFor(() => {
      const last = s.eventsFrom(0).at(-1);
      expect(last?.type).toBe("agent_error");
    });
  });

  it("resolves the real tool name on tool_result events via tool_use_id", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, toolResultRun);
    driver.sendPrompt("u1", "read the file");
    await vi.waitFor(() => {
      const last = s.eventsFrom(0).at(-1);
      expect(last?.type).toBe("tool_result");
      expect(last).toMatchObject({
        type: "tool_result",
        toolName: "Read",
        output: "file contents here",
      });
    });
  });

  it("truncates tool_result output to 2000 chars", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, longToolResultRun);
    driver.sendPrompt("u1", "grep something");
    await vi.waitFor(() => {
      const last = s.eventsFrom(0).at(-1);
      expect(last?.type).toBe("tool_result");
      expect(last).toMatchObject({ type: "tool_result", toolName: "Grep" });
      if (last?.type === "tool_result") {
        expect(last.output.length).toBe(2000);
      }
    });
  });
});
