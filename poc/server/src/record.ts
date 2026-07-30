import type { LoggedEvent } from "./events.js";
import type { SessionFacts } from "./relayProtocol.js";

/** One session's raw material: the facts row the snapshot already publishes,
 *  which machine owns it, and its whole event log (spec §4.1). */
export interface RecordSessionInput {
  facts: SessionFacts;
  machineId: string | null;
  events: LoggedEvent[];
}

/** One human decision on a turn. `requestId` is deliberately absent: it is a
 *  join key used only to resolve `toolName` from the matching
 *  `permission_request`, and is not part of the record (spec §8a ruling 4). */
export interface TurnApproval {
  kind: "permission" | "plan";
  decision: "allow" | "deny" | "approve" | "reject";
  userId: string;
  toolName: string | null;
  auto: boolean;
}

export interface TurnRecord {
  /** 1-based within its session. */
  turn: number;
  driver: string | null;
  /** First `user_message` text of the turn, sliced to PROMPT_CAP. */
  prompt: string | null;
  /** The turn's first and last event timestamps — `null` only when NO event in
   *  the turn carries one, which a hand-written or older log can do. Not
   *  `undefined`: JSON drops that, and a field the browser never receives
   *  renders as "undefined" in the turn line. */
  startTs: string | null;
  endTs: string | null;
  inProgress: boolean;
  toolCounts: Record<string, number>;
  filesChanged: string[];
  approvals: TurnApproval[];
  /** Count of `agent_error`. */
  errors: number;
}

export interface SessionRecord {
  sessionId: string;
  machineId: string | null;
  repoKey: string | null;
  lifecycle: SessionFacts["lifecycle"];
  intent: string | null;
  closedBy: string | null;
  turns: TurnRecord[];
}

export interface UserRollup {
  userId: string;
  turnsDriven: number;
  approvalsGiven: number;
  denialsGiven: number;
}

export interface ProjectRecord {
  projectId: string;
  sessions: SessionRecord[];
  rollup: { perUser: UserRollup[]; totalTurns: number; totalSessions: number };
}

/** How much of a turn's opening prompt the record keeps. */
export const PROMPT_CAP = 200;

/** Tools whose `input.file_path` counts as a file this turn changed. A Bash
 *  `mv` is invisible to this list and that is accepted for v1 (spec §4.1:
 *  best-effort, stated). */
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function filePathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const path = (input as Record<string, unknown>).file_path;
  return typeof path === "string" ? path : null;
}

/** Splits a log into turn groups: each group runs from the event after the
 *  previous `turn_end` up to AND INCLUDING its own `turn_end`; a trailing
 *  unclosed group is the in-progress turn (spec §4.1). */
function turnGroups(events: LoggedEvent[]): LoggedEvent[][] {
  const groups: LoggedEvent[][] = [];
  let current: LoggedEvent[] = [];
  for (const ev of events) {
    current.push(ev);
    if (ev.type === "turn_end") {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function turnRecordOf(
  group: LoggedEvent[],
  turn: number,
  /** Who held control at the moment this turn opened — the fallback driver.
   *  A `control_change` inside the group is deliberately not visible here: it
   *  feeds LATER turns only (spec §4.1 "at that point"). */
  controllerAtStart: string | null,
  toolNameByRequest: Map<string, string>,
): TurnRecord {
  // The turn's FIRST `user_message`, wherever it sits: real logs open every
  // turn with system bookkeeping (presence_join, skill_roster), and reading
  // "opening user_message" as "literal first event" would null the driver on
  // nearly every real turn and gut `turnsDriven` (spec §8a ruling 9). A later
  // second message in the same turn never overrides it.
  //
  // `text` is nullable here on purpose. Every event below is read as data off
  // disk, not as the `LoggedEvent` the types promise: this derivation runs over
  // a journal written by older builds and by laptops this process does not
  // control, and the hub calls it OUTSIDE its fatal seam, so one unusable field
  // must cost that field and nothing more.
  let opening: { userId: string; text: string | null } | null = null;
  // Null prototype: `toolName` is whatever named a tool call, and on a plain
  // object `"constructor"` reads back as `Object`'s constructor (counted as a
  // function plus one) while `"__proto__"` hits the prototype setter and is
  // never stored at all.
  const toolCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const filesChanged: string[] = [];
  const approvals: TurnApproval[] = [];
  let errors = 0;

  for (const ev of group) {
    switch (ev.type) {
      case "user_message":
        // A message that names nobody cannot answer "who drove this turn", so it
        // does not get to claim the turn's opening either — the next one does.
        // One that names somebody but carries unusable text keeps the opening
        // (the driver is the point) and simply has no prompt.
        if (opening === null && typeof ev.userId === "string") {
          opening = { userId: ev.userId, text: typeof ev.text === "string" ? ev.text : null };
        }
        break;
      case "tool_call": {
        toolCounts[ev.toolName] = (toolCounts[ev.toolName] ?? 0) + 1;
        if (!FILE_TOOLS.has(ev.toolName)) break;
        const path = filePathOf(ev.input);
        if (path !== null && !filesChanged.includes(path)) filesChanged.push(path);
        break;
      }
      case "permission_decision":
        approvals.push({
          kind: "permission",
          decision: ev.decision,
          userId: ev.userId,
          toolName: toolNameByRequest.get(ev.requestId) ?? null,
          auto: ev.auto === true,
        });
        break;
      case "plan_decision":
        approvals.push({
          kind: "plan",
          decision: ev.decision,
          userId: ev.userId,
          toolName: null,
          auto: false,
        });
        break;
      case "agent_error":
        errors += 1;
        break;
    }
  }

  // Only the stamps that ARE stamps: an event with no `ts` is still part of the
  // turn, it just cannot be the one that dates it. First and last of what is
  // left, which for a well-formed log is the first and last event as before.
  const stamps = group.map((ev) => ev.ts).filter((t): t is string => typeof t === "string");

  return {
    turn,
    driver: opening?.userId ?? controllerAtStart,
    prompt: opening?.text == null ? null : opening.text.slice(0, PROMPT_CAP),
    startTs: stamps[0] ?? null,
    endTs: stamps[stamps.length - 1] ?? null,
    inProgress: group[group.length - 1].type !== "turn_end",
    toolCounts,
    filesChanged,
    approvals,
    errors,
  };
}

function sessionRecordOf(session: RecordSessionInput): SessionRecord {
  // requestId → toolName across the WHOLE session: a request and its decision
  // routinely land in different turns, and an unmatched decision still belongs
  // in the record with a null toolName.
  const toolNameByRequest = new Map<string, string>();
  let closedBy: string | null = null;
  for (const ev of session.events) {
    if (ev.type === "permission_request") toolNameByRequest.set(ev.requestId, ev.toolName);
    else if (ev.type === "session_closed") closedBy = ev.userId; // last one wins
  }

  const turns: TurnRecord[] = [];
  let controller: string | null = null;
  for (const group of turnGroups(session.events)) {
    turns.push(turnRecordOf(group, turns.length + 1, controller, toolNameByRequest));
    for (const ev of group) {
      if (ev.type === "control_change") controller = ev.userId;
    }
  }

  return {
    sessionId: session.facts.id,
    machineId: session.machineId,
    repoKey: session.facts.repoKey,
    lifecycle: session.facts.lifecycle,
    intent: session.facts.intent,
    closedBy,
    turns,
  };
}

function rollupOf(sessions: SessionRecord[]): UserRollup[] {
  const byUser = new Map<string, UserRollup>();
  const rowFor = (userId: string): UserRollup => {
    let row = byUser.get(userId);
    if (!row) {
      row = { userId, turnsDriven: 0, approvalsGiven: 0, denialsGiven: 0 };
      byUser.set(userId, row);
    }
    return row;
  };
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.driver !== null) rowFor(turn.driver).turnsDriven += 1;
      for (const approval of turn.approvals) {
        // An auto decision is the system's act, not the user's, so it counts
        // for nobody here — it still appears on its turn (spec §8a ruling 8).
        if (approval.auto) continue;
        const row = rowFor(approval.userId);
        if (approval.decision === "allow" || approval.decision === "approve") row.approvalsGiven += 1;
        else row.denialsGiven += 1;
      }
    }
  }
  return [...byUser.values()].sort(
    (a, b) => b.turnsDriven - a.turnsDriven || a.userId.localeCompare(b.userId),
  );
}

/** The whole record for one project, derived from event logs and nothing else
 *  (spec §4.2). Pure: no input is mutated and the same input always yields a
 *  deep-equal result, which is what lets the hub answer `get_record` from
 *  memory without keeping a second, drift-prone copy of the truth. */
export function projectRecordFrom(
  projectId: string,
  sessions: RecordSessionInput[],
): ProjectRecord {
  const records = sessions
    .map(sessionRecordOf)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return {
    projectId,
    sessions: records,
    rollup: {
      perUser: rollupOf(records),
      totalTurns: records.reduce((n, s) => n + s.turns.length, 0),
      totalSessions: records.length,
    },
  };
}
