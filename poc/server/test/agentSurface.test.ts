import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import {
  AgentDriver,
  runAgentQuery,
  type RunQuery,
  type SdkMessage,
} from "../src/agentDriver.js";

// The SDK module is mocked so runAgentQuery's query() options can be captured
// without spawning the native binary. Only the options-capture test uses
// runAgentQuery; every other test injects a fake RunQuery and never touches
// the SDK, so the mock is inert for them.
const mocks = vi.hoisted(() => ({
  query: vi.fn((_args?: unknown) => (async function* () {})()),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mocks.query,
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn(() => ({})),
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("agentProgressSummaries option (T5)", () => {
  it("runAgentQuery sets agentProgressSummaries so task_event.summary flows", () => {
    runAgentQuery((async function* () {})(), {
      onIntent: () => {},
      onPermissionRequest: async () => "allow",
      onPlanRequest: async () => "approve",
      workdir: process.cwd(),
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const options = (
      mocks.query.mock.calls[0][0] as { options: Record<string, unknown> }
    ).options;
    expect(options.agentProgressSummaries).toBe(true);
  });
});

describe("turn_end usage/cost payload (T1)", () => {
  const successRun: RunQuery = async function* (prompts) {
    for await (const _p of prompts) {
      yield { type: "assistant", content: [{ type: "text", text: "done" }] } as SdkMessage;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.042,
        num_turns: 3,
        duration_ms: 1200,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
        modelUsage: {
          "claude-opus-4-7": { inputTokens: 100, outputTokens: 50, costUSD: 0.042, contextWindow: 200000 },
        },
      } as SdkMessage;
      return;
    }
  };

  it("carries outcome, cost, usage, modelUsage, duration and turns on turn_end", async () => {
    const s = new Session("pay1");
    const driver = new AgentDriver(s, successRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "turn_end") as any;
    expect(ev).toMatchObject({
      outcome: "success",
      total_cost_usd: 0.042,
      num_turns: 3,
      duration_ms: 1200,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
      modelUsage: {
        "claude-opus-4-7": { inputTokens: 100, outputTokens: 50, costUSD: 0.042, contextWindow: 200000 },
      },
    });
    // a success turn carries no error fields and logs no agent_error
    expect("errorSubtype" in ev).toBe(false);
    expect("errorReason" in ev).toBe(false);
    expect(s.eventsFrom(0).some((e) => e.type === "agent_error")).toBe(false);
  });

  it("keeps the bare-shape fields absent when the result carries nothing", async () => {
    const bareRun: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield { type: "result" } as SdkMessage;
        return;
      }
    };
    const s = new Session("pay2");
    const driver = new AgentDriver(s, bareRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "turn_end") as any;
    expect(ev.outcome).toBe("success");
    expect("total_cost_usd" in ev).toBe(false);
    expect("usage" in ev).toBe(false);
    expect("modelUsage" in ev).toBe(false);
    expect("duration_ms" in ev).toBe(false);
    expect("num_turns" in ev).toBe(false);
  });
});

describe("error truth (T3)", () => {
  const errorRun =
    (result: Record<string, unknown>): RunQuery =>
    async function* (prompts) {
      for await (const _p of prompts) {
        yield { type: "assistant", content: [{ type: "text", text: "trying" }] } as SdkMessage;
        yield { type: "result", ...result } as SdkMessage;
        return;
      }
    };

  it("error_max_turns maps to outcome error with the terminal_reason as the reason", async () => {
    const s = new Session("err1");
    const driver = new AgentDriver(
      s,
      errorRun({
        subtype: "error_max_turns",
        is_error: true,
        terminal_reason: "max_turns",
        duration_ms: 900,
        errors: [],
        total_cost_usd: 0.01,
      }),
    );
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "turn_end") as any;
    expect(ev).toMatchObject({
      outcome: "error",
      errorSubtype: "error_max_turns",
      errorReason: "max_turns",
      total_cost_usd: 0.01,
    });
    const err = s.eventsFrom(0).find((e) => e.type === "agent_error") as any;
    expect(err.message).toContain("error_max_turns");
    expect(err.message).toContain("max_turns");
    // the error lands BEFORE its turn_end so record.ts groups it with this turn
    const types = s.eventsFrom(0).map((e) => e.type);
    expect(types.indexOf("agent_error")).toBeLessThan(types.indexOf("turn_end"));
  });

  it("error_max_budget_usd falls back to the first errors[] entry as the reason", async () => {
    const s = new Session("err2");
    const driver = new AgentDriver(
      s,
      errorRun({
        subtype: "error_max_budget_usd",
        is_error: true,
        errors: ["budget of $1.00 exceeded"],
      }),
    );
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "turn_end") as any;
    expect(ev).toMatchObject({
      outcome: "error",
      errorSubtype: "error_max_budget_usd",
      errorReason: "budget of $1.00 exceeded",
    });
    const err = s.eventsFrom(0).find((e) => e.type === "agent_error") as any;
    expect(err.message).toContain("budget of $1.00 exceeded");
  });

  it("error_during_execution with no reason fields uses the subtype itself", async () => {
    const s = new Session("err3");
    const driver = new AgentDriver(
      s,
      errorRun({ subtype: "error_during_execution", is_error: true }),
    );
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "turn_end") as any;
    expect(ev).toMatchObject({
      outcome: "error",
      errorSubtype: "error_during_execution",
      errorReason: "error_during_execution",
    });
    const err = s.eventsFrom(0).find((e) => e.type === "agent_error") as any;
    // subtype is not duplicated into the message's reason half
    expect(err.message).toBe("turn failed (error_during_execution)");
  });

  it("an API-level failure arrives as subtype \"success\" + is_error + terminal_reason — no \"turn failed (success)\" nonsense (live-found, 2026-08-03)", async () => {
    // The weekly-limit/api_error shape the SDK really emits: subtype stays
    // "success", is_error is true, terminal_reason carries the cause. The
    // subtype must NOT be stamped or rendered as an errorSubtype — only
    // error_* values are subtypes; the reason carries everything else.
    const s = new Session("err4");
    const driver = new AgentDriver(
      s,
      errorRun({ subtype: "success", is_error: true, terminal_reason: "api_error" }),
    );
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "turn_end") as any;
    expect(ev.outcome).toBe("error");
    expect(ev.errorReason).toBe("api_error");
    expect("errorSubtype" in ev).toBe(false);
    const err = s.eventsFrom(0).find((e) => e.type === "agent_error") as any;
    expect(err.message).toBe("turn failed: api_error");
  });

  it("carries supersedes/aborted as additive flags on agent_text_delta", async () => {
    const flagRun: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield {
          type: "assistant",
          supersedes: ["uuid-refused-1"],
          content: [{ type: "text", text: "replacement text" }],
        } as SdkMessage;
        yield {
          type: "assistant",
          aborted: true,
          content: [{ type: "text", text: "truncated" }],
        } as SdkMessage;
        yield {
          type: "assistant",
          content: [{ type: "text", text: "ordinary" }],
        } as SdkMessage;
        return;
      }
    };
    const s = new Session("err4");
    const driver = new AgentDriver(s, flagRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).filter((e) => e.type === "agent_text_delta").length).toBe(3);
    });
    const deltas = s.eventsFrom(0).filter((e) => e.type === "agent_text_delta") as any[];
    expect(deltas[0]).toMatchObject({ text: "replacement text", supersedes: true });
    expect("aborted" in deltas[0]).toBe(false);
    expect(deltas[1]).toMatchObject({ text: "truncated", aborted: true });
    expect("supersedes" in deltas[1]).toBe(false);
    // ordinary deltas are byte-identical to before: no new keys at all
    expect("supersedes" in deltas[2]).toBe(false);
    expect("aborted" in deltas[2]).toBe(false);
  });

  it("maps system/api_retry to an agent_status retrying event with the counters", async () => {
    const retryRun: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield {
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 5,
          retry_delay_ms: 1500,
          error_status: 529,
          error: "overloaded",
        } as SdkMessage;
        return;
      }
    };
    const s = new Session("err5");
    const driver = new AgentDriver(s, retryRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "agent_status")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "agent_status") as any;
    expect(ev).toMatchObject({
      status: "retrying",
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 1500,
      errorStatus: 529,
      detail: "overloaded",
    });
  });

  it("maps system/model_refusal_fallback to an agent_status with the notice text", async () => {
    const refusalRun: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield {
          type: "system",
          subtype: "model_refusal_fallback",
          content: "The model refused; retried on a fallback model.",
        } as unknown as SdkMessage;
        return;
      }
    };
    const s = new Session("err6");
    const driver = new AgentDriver(s, refusalRun);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "agent_status")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "agent_status") as any;
    expect(ev).toMatchObject({
      status: "refusal_fallback",
      detail: "The model refused; retried on a fallback model.",
    });
  });
});

describe("turn interrupt (T2)", () => {
  // A stream whose turn stays open until interrupt() is called, then ends
  // with the SDK's real interrupted-result shape (error_during_execution).
  const interruptibleRun = (onInterrupt: () => void): RunQuery => (prompts) => {
    let release!: () => void;
    const interrupted = new Promise<void>((r) => {
      release = r;
    });
    const gen = (async function* () {
      for await (const _p of prompts) {
        yield { type: "assistant", content: [{ type: "text", text: "working" }] } as SdkMessage;
        await interrupted;
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          duration_ms: 10,
          errors: [],
        } as SdkMessage;
        return;
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        onInterrupt();
        release();
      },
    });
  };

  it("interrupts the running turn and stamps the turn_end outcome interrupted", async () => {
    const calls: number[] = [];
    const s = new Session("int1");
    const driver = new AgentDriver(s, interruptibleRun(() => calls.push(1)));
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "agent_text_delta")).toBe(true);
    });
    const res = driver.stopTurn("u1");
    expect(res).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "turn_end")).toBe(true);
    });
    expect(calls).toHaveLength(1);
    const stop = s.eventsFrom(0).find((e) => e.type === "turn_stop") as any;
    expect(stop).toMatchObject({ userId: "u1" });
    // the request lands before the outcome
    const types = s.eventsFrom(0).map((e) => e.type);
    expect(types.indexOf("turn_stop")).toBeLessThan(types.indexOf("turn_end"));
    const end = s.eventsFrom(0).find((e) => e.type === "turn_end") as any;
    // distinguishable from BOTH a success and an ordinary error: the SDK's
    // error_during_execution subtype must NOT leak through as outcome "error"
    expect(end.outcome).toBe("interrupted");
    expect("errorSubtype" in end).toBe(false);
    expect(s.eventsFrom(0).some((e) => e.type === "agent_error")).toBe(false);
  });

  it("is a no-op (ok, no event, no SDK call) when no turn is running", async () => {
    const calls: number[] = [];
    const s = new Session("int2");
    const driver = new AgentDriver(s, interruptibleRun(() => calls.push(1)));
    const res = driver.stopTurn("u1");
    expect(res).toEqual({ ok: true });
    await wait(30);
    expect(calls).toHaveLength(0);
    expect(s.eventsFrom(0).some((e) => e.type === "turn_stop")).toBe(false);
  });

  it("refuses when the stream has no interrupt (plain fakes), appending nothing", async () => {
    const openRun: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield { type: "assistant", content: [{ type: "text", text: "working" }] } as SdkMessage;
        await wait(50); // turn stays open briefly
        return;
      }
    };
    const s = new Session("int3");
    const driver = new AgentDriver(s, openRun);
    driver.sendPrompt("u1", "go");
    const res = driver.stopTurn("u1");
    expect(res).toEqual({ ok: false, error: "interrupt not supported by this agent" });
    expect(s.eventsFrom(0).some((e) => e.type === "turn_stop")).toBe(false);
  });

  it("surfaces an interrupt() rejection as agent_error, not a throw", async () => {
    const s = new Session("int4");
    const run: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) {
          yield { type: "assistant", content: [{ type: "text", text: "working" }] } as SdkMessage;
          await wait(50);
          return;
        }
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          throw new Error("no interrupt mid-compact");
        },
      });
    };
    const driver = new AgentDriver(s, run);
    driver.sendPrompt("u1", "go");
    expect(driver.stopTurn("u1")).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(
        s.eventsFrom(0).some(
          (e) => e.type === "agent_error" && /no interrupt mid-compact/.test((e as any).message),
        ),
      ).toBe(true);
    });
  });
});

describe("rate_limit events (T1)", () => {
  it("maps rate_limit_event to rate_limit, throttled to one per window", async () => {
    const run: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8, resetsAt: 123 },
        } as SdkMessage;
        // inside the window: dropped
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected" },
        } as SdkMessage;
        await wait(60);
        // past the window: emitted
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed" },
        } as SdkMessage;
        return;
      }
    };
    const s = new Session("rl1");
    const driver = new AgentDriver(
      s, run,
      undefined, [], undefined, 2000,
      undefined, undefined, undefined, undefined, undefined, undefined,
      40, // rateLimitThrottleMs
    );
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).filter((e) => e.type === "rate_limit").length).toBe(2);
    });
    const evs = s.eventsFrom(0).filter((e) => e.type === "rate_limit") as any[];
    expect(evs[0]).toMatchObject({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.8,
      resetsAt: 123,
    });
    expect(evs[1]).toMatchObject({ status: "allowed" });
    // the throttled middle event never landed
    expect(evs.some((e) => e.status === "rejected")).toBe(false);
  });

  it("drops a rate_limit_event with no usable info", async () => {
    const run: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield { type: "rate_limit_event" } as SdkMessage;
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed" },
        } as SdkMessage;
        return;
      }
    };
    const s = new Session("rl2");
    const driver = new AgentDriver(s, run);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "rate_limit")).toBe(true);
    });
    expect(s.eventsFrom(0).filter((e) => e.type === "rate_limit").length).toBe(1);
  });
});

describe("compaction + status (T4)", () => {
  it("maps compact_boundary to a compaction event with pre/post tokens", async () => {
    const run: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 60000, duration_ms: 3000 },
        } as SdkMessage;
        return;
      }
    };
    const s = new Session("cmp1");
    const driver = new AgentDriver(s, run);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "compaction")).toBe(true);
    });
    const ev = s.eventsFrom(0).find((e) => e.type === "compaction") as any;
    expect(ev).toMatchObject({
      trigger: "auto",
      preTokens: 150000,
      postTokens: 60000,
      durationMs: 3000,
    });
  });

  it("maps system/status compacting and the null clear to agent_status", async () => {
    const run: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield { type: "system", subtype: "status", status: "compacting" } as SdkMessage;
        yield { type: "system", subtype: "status", status: "requesting" } as SdkMessage;
        yield { type: "system", subtype: "status", status: null } as SdkMessage;
        return;
      }
    };
    const s = new Session("cmp2");
    const driver = new AgentDriver(s, run);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).filter((e) => e.type === "agent_status").length).toBe(3);
    });
    const statuses = s
      .eventsFrom(0)
      .filter((e) => e.type === "agent_status")
      .map((e: any) => e.status);
    expect(statuses).toEqual(["compacting", "requesting", "idle"]);
  });
});

describe("summaries + roster freshness (T5)", () => {
  it("carries task_notification.output_file on the done event", async () => {
    const run: RunQuery = async function* (prompts) {
      for await (const _p of prompts) {
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "T7",
          status: "completed",
          summary: "shipped it",
          output_file: "/tmp/session/subagents/T7.jsonl",
          usage: { total_tokens: 100, tool_uses: 2, duration_ms: 50 },
        } as SdkMessage;
        return;
      }
    };
    const s = new Session("ros1");
    const driver = new AgentDriver(s, run);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "task_event")).toBe(true);
    });
    const done = s.eventsFrom(0).find((e) => e.type === "task_event") as any;
    expect(done).toMatchObject({
      subtype: "done",
      status: "completed",
      outputFile: "/tmp/session/subagents/T7.jsonl",
    });
  });

  it("system/commands_changed re-fetches supportedCommands and emits a fresh skill_roster", async () => {
    const commands = [{ name: "alpha", description: "first" }];
    const fetches: number[] = [];
    const run: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) {
          commands.push({ name: "beta", description: "second" });
          yield { type: "system", subtype: "commands_changed" } as SdkMessage;
          return;
        }
      })();
      return Object.assign(gen, {
        supportedCommands: async () => {
          fetches.push(1);
          return commands;
        },
      });
    };
    const s = new Session("ros2");
    const driver = new AgentDriver(s, run);
    driver.sendPrompt("u1", "go");
    await vi.waitFor(() => {
      const rosters = s.eventsFrom(0).filter((e) => e.type === "skill_roster") as any[];
      expect(rosters.length).toBeGreaterThanOrEqual(2);
      expect(rosters.at(-1).skills.map((sk: any) => sk.name)).toEqual(["alpha", "beta"]);
    });
    // one fetch at startup, one for the commands_changed push
    expect(fetches.length).toBe(2);
  });

  it("reloadPlugins calls the stream's reload methods and emits a fresh roster", async () => {
    const calls: string[] = [];
    const run: RunQuery = (prompts) => {
      const gen = (async function* () {
        for await (const _p of prompts) return;
      })();
      return Object.assign(gen, {
        reloadSkills: async () => {
          calls.push("skills");
        },
        reloadPlugins: async () => {
          calls.push("plugins");
        },
        supportedCommands: async () => [{ name: "gamma", description: "third" }],
      });
    };
    const s = new Session("ros3");
    const driver = new AgentDriver(s, run);
    await vi.waitFor(() => {
      expect(s.eventsFrom(0).some((e) => e.type === "skill_roster")).toBe(true);
    });
    driver.reloadPlugins();
    await vi.waitFor(() => {
      expect(calls.sort()).toEqual(["plugins", "skills"]);
      expect(s.eventsFrom(0).filter((e) => e.type === "skill_roster").length).toBe(2);
    });
  });
});
