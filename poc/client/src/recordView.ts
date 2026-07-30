import type {
  ProjectRecord,
  SessionRecord,
  TurnRecord,
  UserRollup,
} from "multiplayer-ai-server/record";
import type { MachineInfo } from "./types";

/** The RECORD panel's view-model: a `ProjectRecord` in, rendered lines out.
 *
 *  Pure and React-free on purpose — the line formats are the contract the panel
 *  renders unmodified, so they are asserted here in a plain unit suite instead
 *  of through a component (the house pattern: component-test infra doesn't
 *  exist in this repo). */

/** Shown instead of a rollup when nothing has been recorded yet. A record with
 *  no sessions has no turns and therefore nothing truthful to roll up, even if
 *  a stale `rollup.perUser` still carries rows. */
const EMPTY_LINE = "nothing recorded yet";

function rollupLine(row: UserRollup): string {
  return `${row.userId} — ${row.turnsDriven} driven · ${row.approvalsGiven} approved · ${row.denialsGiven} denied`;
}

/** A machine is named when the project knows it, raw-id'd when it doesn't (the
 *  session outlives the machine's registration), and `unknown machine` when the
 *  record carries no machineId at all — e.g. a standalone server's session. */
function machineLabel(machineId: string | null, machines: MachineInfo[]): string {
  if (machineId === null) return "unknown machine";
  return machines.find((m) => m.machineId === machineId)?.name ?? machineId;
}

function sessionHeader(session: SessionRecord, machines: MachineInfo[]): string {
  const label = machineLabel(session.machineId, machines);
  const closer = session.closedBy ? ` · closed by ${session.closedBy}` : "";
  return `${session.sessionId} — ${label} · ${session.repoKey ?? "no repo"} · ${session.lifecycle}${closer}`;
}

/** `none` rather than an empty segment: a fixed segment count keeps the lines
 *  scannable in a column, and an absent tool list is information. */
function orNone(parts: string[], separator: string): string {
  return parts.length > 0 ? parts.join(separator) : "none";
}

function turnLine(turn: TurnRecord): string {
  const toolsSeg = orNone(
    Object.entries(turn.toolCounts).map(([name, count]) => `${name}×${count}`),
    " ",
  );
  const filesSeg = orNone(turn.filesChanged, ", ");
  const approvalsSeg = orNone(
    turn.approvals.map(
      (a) => `${a.decision} ${a.toolName ?? a.kind} by ${a.userId}${a.auto ? " (auto)" : ""}`,
    ),
    ", ",
  );
  const errorsSeg = turn.errors > 0 ? ` · errors: ${turn.errors}` : "";
  const progressSeg = turn.inProgress ? " · IN PROGRESS" : "";
  return `#${turn.turn} ${turn.driver ?? "system"} · ${turn.startTs} · ${turn.prompt ?? "(no prompt)"} · tools: ${toolsSeg} · files: ${filesSeg} · approvals: ${approvalsSeg}${errorsSeg}${progressSeg}`;
}

/** One line per user who appears in the rollup, in the record's order. */
export function rollupLines(record: ProjectRecord): string[] {
  if (record.sessions.length === 0) return [EMPTY_LINE];
  return record.rollup.perUser.map(rollupLine);
}

/** One block per session, in the record's order: its header plus one line per
 *  turn. Empty for a record with no sessions — `rollupLines` carries the whole
 *  empty state, so the panel renders exactly one line. */
export function sessionBlocks(
  record: ProjectRecord,
  machines: MachineInfo[],
): { header: string; turnLines: string[] }[] {
  return record.sessions.map((session) => ({
    header: sessionHeader(session, machines),
    turnLines: session.turns.map(turnLine),
  }));
}
