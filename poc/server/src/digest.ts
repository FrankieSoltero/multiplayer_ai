import type { LoggedEvent } from "./events.js";

export interface TeammateSummary {
  id: string;
  intent: string | null;
  recentToolCalls: { toolName: string; target: string }[];
  ended: boolean;
}

export function summarizeSession(
  id: string,
  events: LoggedEvent[],
  ended: boolean,
): TeammateSummary {
  let intent: string | null = null;
  const toolCalls: { toolName: string; target: string }[] = [];
  for (const ev of events) {
    if (ev.type === "intent_update") intent = ev.text;
    if (ev.type === "tool_call") {
      const input = (ev.input ?? {}) as Record<string, unknown>;
      const target = String(
        input.file_path ?? input.pattern ?? input.path ?? "",
      );
      toolCalls.push({ toolName: ev.toolName, target });
    }
  }
  return { id, intent, recentToolCalls: toolCalls.slice(-5), ended };
}

export function buildTeammateDigest(others: TeammateSummary[]): string {
  if (others.length === 0) return "";
  const lines: string[] = ["<teammates>"];
  for (const o of others) {
    const status = o.ended ? " (ended)" : "";
    lines.push(
      `- session "${o.id}"${status}: ${o.intent ?? "no declared intent yet"}`,
    );
    if (o.recentToolCalls.length > 0) {
      const activity = o.recentToolCalls
        .map((c) => `${c.toolName}(${c.target})`)
        .join(", ");
      lines.push(`  recent activity: ${activity}`);
    }
  }
  lines.push("</teammates>");
  return lines.join("\n");
}

export interface OversightSessionDigest {
  id: string;
  intent: string | null;
  driverName: string | null;
  participants: string[];
  recentToolCalls: { toolName: string; target: string }[];
  promptCount: number;
  pendingGates: number;
  errorCount: number;
  ended: boolean;
}

/** Structured per-session digest for the oversight summarizer (spec §3).
 *  Reads event metadata only — never agent_text_delta/tool_result content:
 *  the overseer must not see transcript prose. */
export function oversightSessionDigest(
  id: string,
  events: LoggedEvent[],
  ended: boolean,
  driverName: string | null,
  participants: string[],
): OversightSessionDigest {
  let intent: string | null = null;
  const toolCalls: { toolName: string; target: string }[] = [];
  let promptCount = 0;
  let errorCount = 0;
  const openGates = new Set<string>();
  for (const ev of events) {
    if (ev.type === "intent_update") intent = ev.text;
    if (ev.type === "tool_call") {
      const input = (ev.input ?? {}) as Record<string, unknown>;
      toolCalls.push({
        toolName: ev.toolName,
        target: String(input.file_path ?? input.pattern ?? input.path ?? ""),
      });
    }
    if (ev.type === "user_message") promptCount++;
    if (ev.type === "agent_error") errorCount++;
    if (ev.type === "permission_request") openGates.add(ev.requestId);
    if (ev.type === "permission_decision") openGates.delete(ev.requestId);
  }
  return {
    id,
    intent,
    driverName,
    participants,
    recentToolCalls: toolCalls.slice(-5),
    promptCount,
    pendingGates: openGates.size,
    errorCount,
    ended,
  };
}
