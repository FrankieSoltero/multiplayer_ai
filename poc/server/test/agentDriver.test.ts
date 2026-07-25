import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery, type SdkMessage } from "../src/agentDriver.js";

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

describe("driver approval gate", () => {
  const permissionRun: RunQuery = async function* (prompts, hooks) {
    for await (const _prompt of prompts) {
      const decision = await hooks.onPermissionRequest("Bash", {
        command: "rm -rf build",
      });
      yield {
        type: "assistant",
        content: [{ type: "text", text: `decision: ${decision}` }],
      };
    }
  };

  async function waitForEvent(
    session: Session,
    type: string,
    tries = 40,
  ): Promise<any> {
    for (let i = 0; i < tries; i++) {
      const ev = session.eventsFrom(0).find((e) => e.type === type);
      if (ev) return ev;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${type}`);
  }

  it("logs permission_request, resolves allow, and logs the decision", async () => {
    const session = new Session("s-perm-1");
    const driver = new AgentDriver(session, permissionRun);
    driver.sendPrompt("u1", "clean the build dir");

    const request = await waitForEvent(session, "permission_request");
    expect(request.toolName).toBe("Bash");
    expect(request.input).toEqual({ command: "rm -rf build" });
    expect(typeof request.requestId).toBe("string");

    expect(driver.resolvePermission(request.requestId, "allow", "u1")).toBe(true);

    const decision = await waitForEvent(session, "permission_decision");
    expect(decision).toMatchObject({
      requestId: request.requestId,
      decision: "allow",
      userId: "u1",
    });
    const echoed = await waitForEvent(session, "agent_text_delta");
    expect(echoed.text).toBe("decision: allow");
  });

  it("passes deny through to the waiting query", async () => {
    const session = new Session("s-perm-2");
    const driver = new AgentDriver(session, permissionRun);
    driver.sendPrompt("u1", "clean the build dir");
    const request = await waitForEvent(session, "permission_request");
    expect(driver.resolvePermission(request.requestId, "deny", "u2")).toBe(true);
    const echoed = await waitForEvent(session, "agent_text_delta");
    expect(echoed.text).toBe("decision: deny");
  });

  it("rejects unknown and already-decided requestIds", async () => {
    const session = new Session("s-perm-3");
    const driver = new AgentDriver(session, permissionRun);
    expect(driver.resolvePermission("nope", "allow", "u1")).toBe(false);

    driver.sendPrompt("u1", "go");
    const request = await waitForEvent(session, "permission_request");
    expect(driver.resolvePermission(request.requestId, "allow", "u1")).toBe(true);
    expect(driver.resolvePermission(request.requestId, "deny", "u1")).toBe(false);
    // exactly one decision event
    const decisions = session
      .eventsFrom(0)
      .filter((e) => e.type === "permission_decision");
    expect(decisions.length).toBe(1);
  });

  it("closes out a pending request when the SDK aborts it, denying it and marking the audit trail as system", async () => {
    const controller = new AbortController();
    const abortRun: RunQuery = async function* (prompts, hooks) {
      for await (const _prompt of prompts) {
        const decision = await hooks.onPermissionRequest(
          "Bash",
          { command: "rm -rf x" },
          controller.signal,
        );
        yield {
          type: "assistant",
          content: [{ type: "text", text: `decision: ${decision}` }],
        };
      }
    };
    const session = new Session("s-perm-abort");
    const driver = new AgentDriver(session, abortRun);
    driver.sendPrompt("u1", "clean the build dir");

    const request = await waitForEvent(session, "permission_request");
    controller.abort();

    const decision = await waitForEvent(session, "permission_decision");
    expect(decision).toMatchObject({
      requestId: request.requestId,
      decision: "deny",
      userId: "system",
    });
    const echoed = await waitForEvent(session, "agent_text_delta");
    expect(echoed.text).toBe("decision: deny");

    expect(driver.resolvePermission(request.requestId, "allow", "u1")).toBe(false);
  });

  it("flushes a still-pending permission request as a system deny when the stream ends without deciding it", async () => {
    let capturedDecision: Promise<"allow" | "deny"> | undefined;
    const streamDiesWhilePendingRun: RunQuery = async function* (prompts, hooks) {
      for await (const _prompt of prompts) {
        capturedDecision = hooks.onPermissionRequest("Bash", {
          command: "rm -rf x",
        });
        // The stream ends (e.g. the SDK query completes/closes) WITHOUT the
        // driver ever resolving this permission request.
        return;
      }
    };
    const session = new Session("s-perm-stream-death");
    const driver = new AgentDriver(session, streamDiesWhilePendingRun);
    driver.sendPrompt("u1", "clean the build dir");

    const request = await waitForEvent(session, "permission_request");
    expect(capturedDecision).toBeDefined();
    await expect(capturedDecision).resolves.toBe("deny");

    const decision = await waitForEvent(session, "permission_decision");
    expect(decision).toMatchObject({
      requestId: request.requestId,
      decision: "deny",
      userId: "system",
    });

    expect(driver.resolvePermission(request.requestId, "allow", "u1")).toBe(false);
  });
});

const resultRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield { type: "assistant", content: [{ type: "text", text: "done" }] };
    yield { type: "result" };
    // keep the stream open for the next prompt (do NOT return)
  }
};

describe("turn lifecycle", () => {
  it("appends turn_end when the SDK emits a result message", async () => {
    const session = new Session("s");
    const driver = new AgentDriver(session, resultRun);
    driver.sendPrompt("u1", "hi");
    await vi.waitFor(() =>
      expect(session.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true),
    );
  });

  it("emits exactly one turn_end, only after the SECOND result, when two prompts are queued back-to-back mid-turn", async () => {
    // Simulates a driver queuing prompt B while prompt A is still in flight
    // (input isn't disabled mid-turn). Each prompt yielded gets its own
    // "result" message from the fake, one per iteration of the prompts loop.
    const session = new Session("s");
    let resultsYielded = 0;
    const twoPromptRun: RunQuery = async function* (prompts) {
      for await (const _prompt of prompts) {
        yield { type: "assistant", content: [{ type: "text", text: "ok" }] };
        yield { type: "result" };
        resultsYielded++;
        if (resultsYielded >= 2) return;
      }
    };
    const driver = new AgentDriver(session, twoPromptRun);
    driver.sendPrompt("u1", "prompt A");
    driver.sendPrompt("u1", "prompt B");

    await vi.waitFor(() => expect(resultsYielded).toBe(2));
    await vi.waitFor(() => {
      const types = session.eventsFrom(0).map((e) => e.type);
      const turnEndCount = types.filter((t) => t === "turn_end").length;
      expect(turnEndCount).toBe(1);
    });
    // turn_end must appear strictly after both user_message events and both
    // results have been processed — i.e. only once no turn remains outstanding.
    const types = session.eventsFrom(0).map((e) => e.type);
    const turnEndIndex = types.indexOf("turn_end");
    const userMessageIndices = types
      .map((t, i) => (t === "user_message" ? i : -1))
      .filter((i) => i >= 0);
    expect(userMessageIndices).toHaveLength(2);
    expect(turnEndIndex).toBeGreaterThan(Math.max(...userMessageIndices));
  });
});

describe("setModel", () => {
  const makeRunWithSetModel = (spy: (m: string) => Promise<void>): RunQuery =>
    (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) {
          yield { type: "assistant", content: [{ type: "text", text: "ok" }] } as SdkMessage;
          yield { type: "result" } as SdkMessage;
        }
      })();
      return Object.assign(gen, { setModel: spy });
    };

  it("switches between turns: calls SDK setModel with the mapped id and logs model_change", async () => {
    const spy = vi.fn(async (_m: string) => {});
    const session = new Session("s");
    const driver = new AgentDriver(session, makeRunWithSetModel(spy));
    driver.sendPrompt("u1", "hi");
    await vi.waitFor(() =>
      expect(session.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true),
    );
    const res = driver.setModel("sonnet", "u1");
    expect(res).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith("claude-sonnet-5");
    const ev = session.eventsFrom(0).find((e) => e.type === "model_change");
    expect(ev).toMatchObject({ model: "sonnet", userId: "u1" });
  });

  it("rejects a switch mid-turn", async () => {
    const spy = vi.fn(async (_m: string) => {});
    const session = new Session("s");
    const driver = new AgentDriver(session, makeRunWithSetModel(spy));
    driver.sendPrompt("u1", "hi"); // turn active until result consumed…
    const res = driver.setModel("haiku", "u1"); // …but call synchronously before waitFor
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports unsupported when the stream has no setModel (plain fakes)", () => {
    const session = new Session("s");
    const driver = new AgentDriver(session, fakeRun);
    const res = driver.setModel("sonnet", "u1");
    expect(res.ok).toBe(false);
  });
});
