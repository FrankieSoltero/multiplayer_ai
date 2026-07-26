import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODELS } from "./models.js";
import type { OversightSessionDigest } from "./digest.js";

export interface OversightSummary {
  text: string;
  ts: string;
  seq: number;
}

export interface OversightInput {
  projectId: string;
  previousSummary: string | null;
  sessions: OversightSessionDigest[];
}

export type Summarize = (input: OversightInput) => Promise<string>;

/** What the team_update tool (and any read of the stored summary) should
 *  say. Exact strings are spec §6 locked. */
export function oversightToolText(
  enabled: boolean,
  latest: OversightSummary | null,
): string {
  if (!enabled) return "team oversight is disabled";
  return latest?.text ?? "no team summary yet";
}

interface ProjectOversight {
  enabled: boolean;
  latest: OversightSummary | null;
  seq: number;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  pending: boolean;
}

/** Per-project oversight state machine (spec §3): activity-driven debounce,
 *  single in-flight refresh with coalescing, failure keeps the previous
 *  summary. Not a session — one stateless summarize call per refresh. */
export class Overseer {
  private states = new Map<string, ProjectOversight>();

  constructor(
    private summarize: Summarize,
    private digestsFor: (projectId: string) => OversightSessionDigest[],
    private onUpdate: (projectId: string) => void,
    private debounceMs = 30_000,
  ) {}

  private state(projectId: string): ProjectOversight {
    let s = this.states.get(projectId);
    if (!s) {
      s = { enabled: false, latest: null, seq: 0, timer: null, inFlight: false, pending: false };
      this.states.set(projectId, s);
    }
    return s;
  }

  isEnabled(projectId: string): boolean {
    return this.states.get(projectId)?.enabled ?? false;
  }

  latest(projectId: string): OversightSummary | null {
    return this.states.get(projectId)?.latest ?? null;
  }

  setEnabled(projectId: string, enabled: boolean): void {
    const s = this.state(projectId);
    if (s.enabled === enabled) return;
    s.enabled = enabled;
    if (!enabled && s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    this.onUpdate(projectId); // broadcast the toggle itself
    if (enabled) void this.refresh(projectId);
  }

  /** Schedule-once debounce (same shape as server.ts schedulePush): a queued
   *  refresh absorbs further notifies, so steady activity still summarizes
   *  every debounceMs instead of being postponed forever. */
  notify(projectId: string): void {
    const s = this.states.get(projectId);
    if (!s?.enabled) return;
    if (s.inFlight) {
      s.pending = true;
      return;
    }
    if (s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      void this.refresh(projectId);
    }, this.debounceMs);
  }

  private async refresh(projectId: string): Promise<void> {
    const s = this.state(projectId);
    if (s.inFlight) {
      s.pending = true;
      return;
    }
    s.inFlight = true;
    try {
      const text = await this.summarize({
        projectId,
        previousSummary: s.latest?.text ?? null,
        sessions: this.digestsFor(projectId),
      });
      if (s.enabled) {
        s.seq += 1;
        s.latest = { text, ts: new Date().toISOString(), seq: s.seq };
        this.onUpdate(projectId);
      }
    } catch (err) {
      // Keep the previous summary; the next activity retries naturally.
      console.error(
        `oversight refresh failed for ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      s.inFlight = false;
      if (s.pending) {
        s.pending = false;
        this.notify(projectId);
      }
    }
  }

  dispose(): void {
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
  }
}

/** Production summarizer: one stateless haiku call, no tools (spec §3).
 *  Throws on SDK error results — Overseer.refresh handles it. */
export const runOversightSummarize: Summarize = async (input) => {
  const lines = input.sessions.map(
    (s) =>
      `- ${s.id}${s.ended ? " (ended)" : ""}: intent=${s.intent ?? "none"}; driver=${s.driverName ?? "none"}; people=[${s.participants.join(", ")}]; prompts=${s.promptCount}; pendingGates=${s.pendingGates}; errors=${s.errorCount}; recentTools=[${s.recentToolCalls.map((c) => `${c.toolName}(${c.target})`).join(", ")}]`,
  );
  const prompt = [
    `Summarize what the team is doing in project "${input.projectId}".`,
    `Output: a 2-3 sentence narrative of overall team activity, then one line per active session in the form "<session-id>: <what's happening>". Under 150 words total. No preamble, no markdown headers.`,
    input.previousSummary ? `Previous summary (for continuity):\n${input.previousSummary}` : "",
    `Current structured activity digests (metadata only, no transcript content):\n${lines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const stream = query({
    prompt,
    options: {
      model: MODELS.haiku.id,
      systemPrompt:
        "You are the oversight summarizer for a multiplayer AI dev server. Output only the summary text.",
      tools: [],
      maxTurns: 1,
      strictMcpConfig: true,
      settingSources: [],
    },
  });
  for await (const message of stream as AsyncIterable<{
    type: string;
    subtype?: string;
    result?: string;
  }>) {
    if (message.type === "result") {
      if (message.subtype === "success" && typeof message.result === "string") {
        return message.result;
      }
      throw new Error(`summarize failed: ${message.subtype ?? "unknown"}`);
    }
  }
  throw new Error("summarize stream ended without a result");
};
