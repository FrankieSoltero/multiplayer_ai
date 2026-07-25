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

  it("emits a turn_end per result when queued prompts each get their own cycle", async () => {
    // A driver can queue prompt B while prompt A is in flight. When the SDK
    // runs them as two cycles (one result each), each result marks a turn
    // boundary — the client's busy signal re-raises from cycle B's first
    // activity event, so per-result turn_end never strands the strip.
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
      expect(types.filter((t) => t === "turn_end")).toHaveLength(2);
    });
  });

  it("still ends the turn when the SDK folds two queued prompts into ONE cycle (live-repro regression)", async () => {
    // Reproduced live 2026-07-25: the SDK answered a queued prompt inside the
    // active cycle — TWO user_messages, ONE result. A per-prompt countdown
    // left pendingTurns stuck at 1 forever: busy signal never cleared and
    // setModel stayed blocked. Every result must therefore reset the counter
    // and emit turn_end.
    const session = new Session("s");
    const foldedRun: RunQuery = async function* (prompts) {
      let consumed = 0;
      for await (const _prompt of prompts) {
        consumed++;
        if (consumed < 2) continue; // swallow prompt A, reply once for both
        if (consumed === 2) {
          yield { type: "assistant", content: [{ type: "text", text: "did both" }] };
          yield { type: "result" };
        }
        // keep the stream open (a live query stays connected between turns)
      }
    };
    const driver = new AgentDriver(session, foldedRun);
    driver.sendPrompt("u1", "prompt A");
    driver.sendPrompt("u1", "prompt B");

    await vi.waitFor(() =>
      expect(session.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true),
    );
    // The gate must be open again: a model switch after the folded cycle
    // is "between turns" and must not be rejected as mid-turn.
    const res = driver.setModel("sonnet", "u1");
    expect(res).toEqual({ ok: false, error: "model switching not supported by this agent" });
    // (foldedRun has no setModel — the point is it got PAST the mid-turn
    // check, which returns a different error.)
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

const subagentRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    // Main agent spawns a subagent via Task
    yield {
      type: "assistant",
      content: [{ type: "tool_use", id: "task-1", name: "Task", input: { description: "audit deps" } }],
    };
    // Subagent traffic arrives tagged with parent_tool_use_id
    yield {
      type: "assistant",
      parent_tool_use_id: "task-1",
      content: [
        { type: "text", text: "scanning lockfile" },
        { type: "tool_use", id: "t-sub", name: "Read", input: { file: "package.json" } },
      ],
    };
    yield {
      type: "user",
      parent_tool_use_id: "task-1",
      content: [{ type: "tool_result", tool_use_id: "t-sub", content: "lockfile ok" }],
    };
    // Task completes: parent-level tool_result for task-1
    yield {
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "task-1", content: "audit done" }],
    };
    return;
  }
};

describe("subagent lineage", () => {
  it("threads parent_tool_use_id and block ids onto emitted events", async () => {
    const session = new Session("s-lineage");
    const events: any[] = [];
    session.subscribe((e) => events.push(e));
    const driver = new AgentDriver(session, subagentRun);
    driver.sendPrompt("u1", "audit");
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === "tool_result").length).toBe(2);
    });
    const spawn = events.find((e) => e.type === "tool_call" && e.toolName === "Task");
    expect(spawn.toolUseId).toBe("task-1");
    expect(spawn.parentToolUseId).toBeUndefined();
    const subText = events.find((e) => e.type === "agent_text_delta" && e.text === "scanning lockfile");
    expect(subText.parentToolUseId).toBe("task-1");
    const subCall = events.find((e) => e.type === "tool_call" && e.toolName === "Read");
    expect(subCall.parentToolUseId).toBe("task-1");
    expect(subCall.toolUseId).toBe("t-sub");
    const subResult = events.find((e) => e.type === "tool_result" && e.output === "lockfile ok");
    expect(subResult.parentToolUseId).toBe("task-1");
    expect(subResult.toolUseId).toBe("t-sub");
    const done = events.find((e) => e.type === "tool_result" && e.output === "audit done");
    expect(done.parentToolUseId).toBeUndefined();
    expect(done.toolUseId).toBe("task-1");
  });
});

const todoRun: RunQuery = async function* (prompts) {
  for await (const _prompt of prompts) {
    yield {
      type: "assistant",
      content: [
        {
          type: "tool_use",
          id: "td-1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "write tests", status: "completed", activeForm: "writing tests" },
              { content: "implement", status: "in_progress", activeForm: "implementing" },
              { content: 42, status: "pending" },              // invalid content — dropped
              { content: "ship", status: "someday" },          // invalid status — dropped
            ],
          },
        },
      ],
    };
    // Subagent TodoWrite must NOT mirror to the panel
    yield {
      type: "assistant",
      parent_tool_use_id: "task-9",
      content: [
        { type: "tool_use", id: "td-2", name: "TodoWrite", input: { todos: [{ content: "sub", status: "pending" }] } },
      ],
    };
    return;
  }
};

describe("todo mirror", () => {
  it("emits todo_update from main-agent TodoWrite only, dropping invalid entries", async () => {
    const session = new Session("s-todo");
    const events: any[] = [];
    session.subscribe((e) => events.push(e));
    const driver = new AgentDriver(session, todoRun);
    driver.sendPrompt("u1", "plan it");
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === "tool_call" && e.toolName === "TodoWrite").length).toBe(2);
    });
    const updates = events.filter((e) => e.type === "todo_update");
    expect(updates.length).toBe(1);
    expect(updates[0].todos).toEqual([
      { text: "write tests", status: "completed" },
      { text: "implement", status: "in_progress" },
    ]);
  });
});
