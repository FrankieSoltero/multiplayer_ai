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

/** C0 controls plus DEL — the SAME class `relayProtocol.ts`'s `CONTROL_CHARS`
 *  rejects paths and gate reasons on. Spelled here rather than imported to keep
 *  this module a leaf (it value-imports nothing), and applied as a STRIP rather
 *  than a rejection: this is a render boundary, and a digest that threw or
 *  vanished because a teammate typed a tab into their name would be worse than
 *  one that shows the name without it. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** The spec §6a line: `session X (driven by Y) has also changed: a, b`.
 *
 *  WHAT IS BOUNDED, AND WHERE. Peer ids and paths are interpolated VERBATIM and
 *  never re-parsed, re-split or escaped, because the validators already bound
 *  their characters upstream: `relayProtocol`'s frame check rejects any path
 *  carrying a control character or newline, and every peer id is `SLUG`-bounded
 *  (`str(f.sessionId, SLUG)`). Escaping either here would corrupt a real path
 *  without buying anything those validators do not already guarantee.
 *
 *  The driver NAME is the exception, which is why it alone is filtered on the
 *  way in. Every producer of it truncates LENGTH and nothing else —
 *  `server.ts`'s `join` (`msg.name.slice(0, 40)`), `relayProtocol`'s `hello`
 *  name and its facts `driverName` (`typeof === "string"`, no character class).
 *  A newline therefore reaches this line intact, and one is all it takes to
 *  forge a second `<teammates>` entry in the agent's prompt. */
function contestedLineFor(o: TeammateSummary): string {
  const driverName = o.driverName?.replace(CONTROL_CHARS, "");
  // Falsy, not `=== null`: an empty participant name must degrade to the bare
  // form too, a name left as nothing but control characters degrades with it,
  // and a caller reaching this from untyped JS must never render the word
  // `undefined` at a teammate's name.
  const who = driverName
    ? `session ${o.id} (driven by ${driverName})`
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
