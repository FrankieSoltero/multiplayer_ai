import { describe, it, expect, vi } from "vitest";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODELS,
  DEFAULT_MODEL,
  isModelKey,
  modelRoster,
  parseExtraModels,
  type ModelEntry,
} from "../src/models.js";
import { startServer } from "../src/server.js";
import type { RunQuery } from "../src/agentDriver.js";

/** Local-models plan §1.1 / Task 1: models.ts is the single-source registry.
 *  Pins: the Claude trio's ids are byte-identical (LiteLLM pass-through
 *  routes on them), the registry gains the {contextWindow, local,
 *  degradedNote} shape, MPAI_EXTRA_MODELS merges operator entries (bad input
 *  warns and skips, never crashes), and the roster reaches the client as the
 *  additive `models` field on the existing skill_roster frame. */

describe("model registry — the Claude trio is byte-identical (plan constraint 3)", () => {
  it("keeps the exact pass-through ids and labels", () => {
    expect(MODELS.opus).toEqual({ id: "claude-opus-4-8", label: "opus 4.8", contextWindow: 200000 });
    expect(MODELS.sonnet).toEqual({ id: "claude-sonnet-5", label: "sonnet 5", contextWindow: 200000 });
    expect(MODELS.haiku).toEqual({ id: "claude-haiku-4-5-20251001", label: "haiku 4.5", contextWindow: 200000 });
    expect(DEFAULT_MODEL).toBe("opus");
  });

  it("is the ONLY module in src that hardcodes the trio (grep-pin)", () => {
    // The registry derives everything (set_model validation, the wire roster,
    // labels) — a second hardcoded trio anywhere else would fork the truth.
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offenders: string[] = [];
    for (const file of fs.readdirSync(srcDir)) {
      if (!file.endsWith(".ts")) continue;
      const text = fs.readFileSync(path.join(srcDir, file), "utf8");
      if (/claude-(opus-4-8|sonnet-5|haiku-4-5)/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual(["models.ts"]);
  });
});

describe("parseExtraModels — the operator env seam (MPAI_EXTRA_MODELS)", () => {
  const noWarn = vi.fn();

  it("absent or empty input registers nothing and never warns", () => {
    expect(parseExtraModels(undefined, noWarn)).toEqual({});
    expect(parseExtraModels("", noWarn)).toEqual({});
    expect(noWarn).not.toHaveBeenCalled();
  });

  it("valid JSON appends entries keyed by id, keeping optional fields", () => {
    const warn = vi.fn();
    const extra = parseExtraModels(
      JSON.stringify([
        {
          id: "qwen3-32b",
          label: "QWEN3 32B (LOCAL)",
          contextWindow: 32768,
          local: true,
          degradedNote: "local model — no cost/rate-limit reporting; gates may be noisier",
        },
        { id: "qwen3-30b-a3b", label: "QWEN3 30B-A3B (LOCAL)", contextWindow: 32768 },
      ]),
      warn,
    );
    expect(extra).toEqual({
      "qwen3-32b": {
        id: "qwen3-32b",
        label: "QWEN3 32B (LOCAL)",
        contextWindow: 32768,
        local: true,
        degradedNote: "local model — no cost/rate-limit reporting; gates may be noisier",
      },
      "qwen3-30b-a3b": { id: "qwen3-30b-a3b", label: "QWEN3 30B-A3B (LOCAL)", contextWindow: 32768 },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("invalid JSON warns once and registers nothing — never a boot crash", () => {
    const warn = vi.fn();
    expect(parseExtraModels("{not json", warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/MPAI_EXTRA_MODELS/);
  });

  it("a non-array warns and registers nothing", () => {
    const warn = vi.fn();
    expect(parseExtraModels('{"id":"qwen3-32b"}', warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("malformed entries warn and are skipped; the valid ones still land", () => {
    const warn = vi.fn();
    const extra = parseExtraModels(
      JSON.stringify([
        { label: "NO ID", contextWindow: 32768 }, // missing id
        { id: "x", label: "NO WINDOW" }, // missing contextWindow
        { id: "y", label: "BAD LOCAL", contextWindow: 1, local: "yes" }, // non-boolean local
        null,
        { id: "ok-7b", label: "OK 7B", contextWindow: 8192 },
      ]),
      warn,
    );
    expect(Object.keys(extra)).toEqual(["ok-7b"]);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("never shadows a built-in or an earlier extra", () => {
    const warn = vi.fn();
    const extra = parseExtraModels(
      JSON.stringify([
        { id: "opus", label: "IMPOSTOR", contextWindow: 1 },
        { id: "dup-7b", label: "FIRST", contextWindow: 1 },
        { id: "dup-7b", label: "SECOND", contextWindow: 2 },
      ]),
      warn,
    );
    expect(extra).toEqual({ "dup-7b": { id: "dup-7b", label: "FIRST", contextWindow: 1 } });
    expect(warn).toHaveBeenCalledTimes(2);
    // The built-in registry itself is untouched by the parse attempt.
    expect(MODELS.opus.label).toBe("opus 4.8");
  });
});

describe("modelRoster — the additive `models` field shape", () => {
  it("carries key/id/label for every registry entry, optional fields omitted not nulled", () => {
    const roster = modelRoster();
    expect(roster).toEqual([
      { key: "opus", id: "claude-opus-4-8", label: "opus 4.8" },
      { key: "sonnet", id: "claude-sonnet-5", label: "sonnet 5" },
      { key: "haiku", id: "claude-haiku-4-5-20251001", label: "haiku 4.5" },
    ]);
    for (const entry of roster) {
      expect("local" in entry).toBe(false);
      expect("degradedNote" in entry).toBe(false);
    }
  });

  it("every roster key validates as a model key (set_model round-trips)", () => {
    for (const entry of modelRoster()) expect(isModelKey(entry.key)).toBe(true);
  });
});

describe("roster on the wire — skill_roster carries `models`", () => {
  const echoRun: RunQuery = async function* (prompts) {
    for await (const prompt of prompts) {
      yield {
        type: "assistant",
        content: [{ type: "text", text: `echo: ${prompt.message.content[0].text}` }],
      } as never;
    }
  };

  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  it("a joiner replays the creation-time skill_roster with the full registry roster", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    try {
      const ws = await connect(server.port);
      const sink: { type: string; event?: { type: string; models?: unknown } }[] = [];
      ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ type: "join", sessionId: "mr1", userId: "u1", name: "ana", lastSeq: 0 }));
      await vi.waitFor(() => {
        const frame = sink.find((m) => m.type === "event" && m.event?.type === "skill_roster");
        expect(frame).toBeTruthy();
        expect(frame!.event!.models).toEqual(modelRoster());
        // And the trio is really in it — not vacuous against an empty roster.
        const keys = (frame!.event!.models as { key: string }[]).map((m) => m.key);
        expect(keys).toEqual(["opus", "sonnet", "haiku"]);
      });
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("set_model still rejects unknown keys, listing the registry's keys", async () => {
    const server = await startServer({ port: 0, runQuery: echoRun });
    try {
      const ws = await connect(server.port);
      const sink: { type: string; message?: string }[] = [];
      ws.on("message", (raw) => sink.push(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ type: "join", sessionId: "mr2", userId: "u1", name: "ana", lastSeq: 0 }));
      await vi.waitFor(() =>
        expect(sink.some((m) => m.type === "event")).toBe(true),
      );
      ws.send(JSON.stringify({ type: "set_model", model: "qwen3-32b" })); // not registered in this boot
      await vi.waitFor(() => {
        const err = sink.find((m) => m.type === "error" && /set_model requires model/.test(m.message ?? ""));
        expect(err).toBeTruthy();
        expect(err!.message).toContain("opus|sonnet|haiku");
      });
      ws.close();
    } finally {
      await server.close();
    }
  });
});

/** Type-level pin: the registry entry shape is the plan's §1.1 contract. */
describe("ModelEntry shape", () => {
  it("accepts the full local-model shape", () => {
    const local: ModelEntry = {
      id: "qwen3-32b",
      label: "QWEN3 32B (LOCAL)",
      contextWindow: 32768,
      local: true,
      degradedNote: "local model — no cost/rate-limit reporting; gates may be noisier",
    };
    expect(local.local).toBe(true);
  });
});
