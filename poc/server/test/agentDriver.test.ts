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

// Throws before ever consuming a prompt, simulating an SDK query that dies
// on its very first iteration (e.g. auth failure on connect).
const immediatelyFailingRun: RunQuery = async function* () {
  throw new Error("connection refused");
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

const stringToolResultRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "assistant",
      content: [
        { type: "tool_use", id: "t3", name: "Read", input: { file: "b.ts" } },
      ],
    };
    yield {
      type: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t3",
          content: "plain string tool output",
        },
      ],
    };
    return;
  }
};

const malformedThenNormalRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t-missing",
          content: 42,
        },
      ],
    };
    yield {
      type: "assistant",
      content: [{ type: "text", text: "still here" }],
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

  it("accepts tool_result content as a plain string (live SDK shape)", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, stringToolResultRun);
    driver.sendPrompt("u1", "read the file");
    await vi.waitFor(() => {
      const last = s.eventsFrom(0).at(-1);
      expect(last?.type).toBe("tool_result");
      expect(last).toMatchObject({
        type: "tool_result",
        toolName: "Read",
        output: "plain string tool output",
      });
    });
  });

  it("logs an agent_error for a malformed message but keeps consuming the stream", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, malformedThenNormalRun);
    driver.sendPrompt("u1", "do the thing");
    await vi.waitFor(() => {
      const types = s.eventsFrom(0).map((e) => e.type);
      expect(types).toContain("agent_error");
      expect(types).toContain("agent_text_delta");
      // The error from the malformed message must not stop the driver from
      // handling the subsequent normal message.
      expect(types.indexOf("agent_text_delta")).toBeGreaterThan(
        types.indexOf("agent_error"),
      );
    });
  });

  it("marks itself dead after the stream ends fatally, and refuses further prompts", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, immediatelyFailingRun);
    await vi.waitFor(() => {
      const last = s.eventsFrom(0).at(-1);
      expect(last?.type).toBe("agent_error");
    });

    driver.sendPrompt("u1", "are you still there?");

    await vi.waitFor(() => {
      const types = s.eventsFrom(0).map((e) => e.type);
      expect(types.filter((t) => t === "agent_error").length).toBe(2);
    });
    const types = s.eventsFrom(0).map((e) => e.type);
    expect(types).not.toContain("user_message");
    const last = s.eventsFrom(0).at(-1);
    expect(last).toMatchObject({
      type: "agent_error",
      message: "agent session has ended — restart the server to continue",
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

describe("intent updates", () => {
  it("appends intent_update (truncated to 200 chars) when the SDK layer reports intent", async () => {
    const s = new Session("s1");
    const longIntent = "x".repeat(250);
    const intentRun: RunQuery = async function* (prompts, hooks) {
      for await (const _prompt of prompts) {
        hooks.onIntent("Migrating auth middleware to JWT");
        hooks.onIntent(longIntent);
        yield { type: "assistant", content: [{ type: "text", text: "done" }] };
        return;
      }
    };
    const driver = new AgentDriver(s, intentRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      const intents = s
        .eventsFrom(0)
        .filter((e) => e.type === "intent_update") as { text: string }[];
      expect(intents).toHaveLength(2);
      expect(intents[0].text).toBe("Migrating auth middleware to JWT");
      expect(intents[1].text).toHaveLength(200);
    });
  });

  it("exposes liveness via isDead", async () => {
    const s = new Session("s1");
    const driver = new AgentDriver(s, fakeRun);
    expect(driver.isDead).toBe(false);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => expect(driver.isDead).toBe(true)); // fakeRun returns after one prompt
  });
});

describe("digest injection", () => {
  it("prefixes the SDK prompt with the context block but logs raw text only", async () => {
    const s = new Session("s1");
    const echoPrompt: RunQuery = async function* (prompts) {
      for await (const prompt of prompts) {
        yield {
          type: "assistant",
          content: [
            { type: "text", text: `SDK saw: ${prompt.message.content[0].text}` },
          ],
        };
        return;
      }
    };
    const driver = new AgentDriver(s, echoPrompt);
    driver.sendPrompt("u1", "add rate limiting", "<teammates>\n- session \"ana\": Migrating auth\n</teammates>");
    await vi.waitFor(() => {
      const events = s.eventsFrom(0);
      const userMsg = events.find((e) => e.type === "user_message") as { text: string };
      const agentText = events.find((e) => e.type === "agent_text_delta") as { text: string };
      expect(userMsg.text).toBe("add rate limiting");
      expect(agentText.text).toContain("<teammates>");
      expect(agentText.text).toContain("add rate limiting");
    });
  });
});
