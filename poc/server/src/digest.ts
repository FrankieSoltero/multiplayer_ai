import type { LoggedEvent } from "./events.js";

export interface TeammateSummary {
  id: string;
  intent: string | null;
  recentToolCalls: { toolName: string; target: string }[];
  ended: boolean;
  /** Repo-relative paths this peer has also changed that the READING session
   *  has changed too (spec §6a), ascending; `[]` when none. Supplied by the
   *  caller — `server.ts`'s `digestFor`, from the Task 7a accessors — because
   *  the event slice below is one session's log and collision is a fact about
   *  two. Order is the caller's contract: this module renders, never sorts. */
  contested: string[];
  /** Display name of this peer's current driver, or `null` when none resolves.
   *  Passed in for the same reason `oversightSessionDigest` takes it: live
   *  participant/driver state lives on `Session`, not in an event slice, and
   *  spec §6a resolves the digest line's `driven by Y` from participants. */
  driverName: string | null;
}

/** Paths named on one peer's contested line before ` +N more` takes over.
 *
 *  Plan-authored, not spec text — spec §6a gives the line form and sets no
 *  digest cap. It bounds prompt growth when a peer's touched set approaches
 *  `TOUCH_CAP` (500). Deliberately larger than the party row's cap of 3: a
 *  prompt line carries more without costing a human anything to read, while
 *  that row sits in a narrow fixed-width rail. */
const CONTESTED_PATH_CAP = 5;

/** The spec §6a line: `session X (driven by Y) has also changed: a, b`.
 *
 *  Peer ids, paths and driver names are interpolated VERBATIM and never
 *  re-parsed, re-split or escaped. That is safe only because the validators
 *  bound the characters upstream — the frame validator rejects control
 *  characters and newlines in paths, and every peer id is bounded by `SLUG` —
 *  so no wire-sourced string can break out of its line and forge a second
 *  `<teammates>` entry. Adding escaping here would corrupt real paths without
 *  buying anything those validators do not already guarantee. */
function contestedLineFor(o: TeammateSummary): string {
  // Falsy, not `=== null`: an empty participant name must degrade to the bare
  // form too, and a caller reaching this from untyped JS must never render the
  // word `undefined` at a teammate's name.
  const who = o.driverName
    ? `session ${o.id} (driven by ${o.driverName})`
    : `session ${o.id}`;
  const first = o.contested.slice(0, CONTESTED_PATH_CAP);
  const rest = o.contested.length - first.length;
  const overflow = rest > 0 ? ` +${rest} more` : "";
  return `${who} has also changed: ${first.join(", ")}${overflow}`;
}

export function summarizeSession(
  id: string,
  events: LoggedEvent[],
  ended: boolean,
  contested: string[] = [],
  driverName: string | null = null,
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
  return {
    id,
    intent,
    recentToolCalls: toolCalls.slice(-5),
    ended,
    // Copied, never aliased: the caller's array is live state assembled per
    // digest build, and the cap/overflow below is one refactor away from being
    // an in-place truncation of it.
    contested: [...contested],
    driverName,
  };
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
    // LAST line of this peer's block, indented like `recent activity:` — the
    // digest reads peer-by-peer and the contested fact belongs to the peer
    // whose block it sits in, not to a trailing group of its own. A peer with
    // nothing contested pushes nothing, so an uncontested project's block is
    // byte-identical to the pre-§6a one.
    if (o.contested.length > 0) {
      lines.push(`  ${contestedLineFor(o)}`);
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
