import type { ProjectRecord } from "multiplayer-ai-server/record";
import type { MachineInfo } from "../types";
import { rollupLines, sessionBlocks } from "../recordView";

/** The project screen's RECORD panel (spec §5): who drove what, what changed,
 *  what was approved and by whom, for one project.
 *
 *  The panel renders `recordView.ts`'s lines UNMODIFIED and adds no text of its
 *  own — the line formats are that module's contract (Task 11), and a panel
 *  that reformatted them would move the contract somewhere untested. The only
 *  string here is the pre-arrival line below.
 *
 *  Styling is the siblings' (`MachinesPanel`): one `.panel`, one `.line` per
 *  row, `.dim` for the secondary layer. No pixel face on any of these rows —
 *  they carry real information (session ids, machine names, prompts, file
 *  paths) and `terminal.css:11-16` reserves the pixel face for chrome that
 *  duplicates nothing. Nothing here is carried by a decorative element. */
export function RecordPanel(props: { record: ProjectRecord | null; machines: MachineInfo[] }) {
  if (props.record === null) {
    return (
      <div className="panel">
        <div className="line dim">{RECORD_LOADING_LINE}</div>
      </div>
    );
  }
  const blocks = sessionBlocks(props.record, props.machines);
  return (
    <div className="panel">
      {rollupLines(props.record).map((line, i) => (
        <div className="line" key={`rollup-${i}`}>{line}</div>
      ))}
      {blocks.map((block, i) => (
        <div key={`session-${i}`}>
          <div className="line">{block.header}</div>
          {block.turnLines.map((line, j) => (
            <div className="line dim" key={`turn-${j}`}>{line}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Shown between opening the panel and the first `record` reply. Distinct from
 *  `recordView.ts`'s "nothing recorded yet": one means "not answered yet", the
 *  other means "answered, and the answer is empty" — collapsing them would tell
 *  a user their project has no history when the fetch is merely in flight. */
export const RECORD_LOADING_LINE = "loading the record…";

/** ------------------------------------------------------------------ wiring
 *
 *  The picker's RECORD state and the messages it puts on the wire, as a pure
 *  reducer with the sends RETURNED rather than performed.
 *
 *  Why a reducer and not `useState` calls scattered through the picker's
 *  dispatch: this repo has no component-test infrastructure and adds none
 *  (`docs/tech-debt.md:215`), so a decision that lives in a `.tsx` handler is a
 *  decision no test can see. Everything worth pinning — when a fetch is sent,
 *  which replies are accepted, what a push does while open — lives here and is
 *  tested directly; `SessionPicker` keeps only the one call site that performs
 *  the sends. */

export type RecordState = { open: boolean; record: ProjectRecord | null };

/** The picker's starting state, and the shape a closed panel keeps. */
export const RECORD_CLOSED: RecordState = { open: false, record: null };

export type GetRecord = { type: "get_record"; projectId: string };

export type RecordEvent =
  /** The RECORD toggle was clicked. */
  | { kind: "toggle" }
  /** A message arrived on the picker's socket — ANY message, unparsed. */
  | { kind: "message"; msg: unknown };

export type RecordStep = { state: RecordState; send: GetRecord[] };

/** Everything reaching this is untrusted network input (v7b1 identity is
 *  self-asserted), and the panel would throw mid-render on a malformed record,
 *  so the payload is shape-checked before it is ever accepted. Shallow on
 *  purpose: `sessions`/`rollup.perUser` are what the view-model walks. */
function isProjectRecord(value: unknown): value is ProjectRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { sessions?: unknown; rollup?: unknown };
  if (!Array.isArray(candidate.sessions)) return false;
  const rollup = candidate.rollup as { perUser?: unknown } | null | undefined;
  if (typeof rollup !== "object" || rollup === null) return false;
  return Array.isArray(rollup.perUser);
}

function messageType(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const type = (msg as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

const fetchFor = (projectId: string): GetRecord[] => [{ type: "get_record", projectId }];

/** One step of the RECORD panel's state.
 *
 *  - `toggle` opens (fetching immediately) or closes; a closed panel KEEPS the
 *    record it last saw, so re-opening shows it instead of flashing the loading
 *    line while the refetch is in flight.
 *  - a `record` reply is accepted only when its `projectId` is this project's
 *    and its payload is record-shaped; anything else is ignored, never
 *    rendered.
 *  - a `project` push refetches WHILE OPEN only — the record is request/reply
 *    (spec §6.6, no streaming), and those pushes are already 1s-throttled
 *    upstream, so no extra throttle lives here. A closed panel fetches nothing.
 *  - every other message, `error` included, leaves this state alone: the picker
 *    has one error line and it already shows any `{type:"error"}` (spec §12.1
 *    posture — one error surface, not one per panel). */
export function recordStep(state: RecordState, event: RecordEvent, projectId: string): RecordStep {
  if (event.kind === "toggle") {
    const open = !state.open;
    return {
      state: { open, record: state.record },
      send: open ? fetchFor(projectId) : [],
    };
  }

  const type = messageType(event.msg);
  if (type === "record") {
    const msg = event.msg as { projectId?: unknown; record?: unknown };
    if (msg.projectId !== projectId || !isProjectRecord(msg.record)) return { state, send: [] };
    return { state: { open: state.open, record: msg.record }, send: [] };
  }
  if (type === "project" && state.open) return { state, send: fetchFor(projectId) };
  return { state, send: [] };
}
