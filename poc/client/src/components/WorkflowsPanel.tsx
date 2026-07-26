import type { TaskInfo, Participant } from "../derive";
import { statusGlyph, usageLine } from "../taskLine";

const RENDER_CAP = 50;

/** Session-scoped live view of the agent's fanned-out tasks (spec §6).
 *  Running rows first with a driver-only STOP; finished rows below with
 *  summary + stop attribution. Names resolve via the participants map and
 *  fall back to the raw id (a stopper may have left the session). */
export function WorkflowsPanel(props: {
  tasks: Map<string, TaskInfo>;
  participants: Map<string, Participant>;
  isDriver: boolean;
  onStopTask: (taskId: string) => void;
  onBack: () => void;
}) {
  const all = [...props.tasks.values()];
  const running = all.filter((t) => t.status === "running");
  const finishedAll = all.filter((t) => t.status !== "running");
  // Cap trims the OLDEST finished rows; running rows always render.
  const finished = finishedAll.slice(Math.max(0, finishedAll.length - (RENDER_CAP - running.length)));
  const name = (id: string) => props.participants.get(id)?.name ?? id;

  const tagLine = (t: TaskInfo) =>
    [t.subagentType, t.workflowName && `workflow: ${t.workflowName}`]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn" onClick={props.onBack}>◂ BACK</button>
        <span className="pix lg">WORKFLOWS</span>
        <span className="rule" />
        <span className="pix">{running.length} RUNNING</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel">
          <div className="pix">RUNNING</div>
          {running.length === 0 && (
            <div className="line dim">no workflows this session — the agent spawns them when work fans out.</div>
          )}
          {running.map((t) => (
            <div className="wfrow" key={t.id}>
              <span className="wfglyph run">{statusGlyph(t.status)}</span>
              <div className="wfbody">
                <div className="wfdesc">{t.description || t.id}</div>
                {tagLine(t) && <div className="wftag pix sm">{tagLine(t)}</div>}
                <div className="wfusage dim">{usageLine(t)}</div>
                {t.stoppedBy && (
                  <div className="wfstop">stop requested by {name(t.stoppedBy)}…</div>
                )}
              </div>
              {props.isDriver && (
                <button className="btn red" onClick={() => props.onStopTask(t.id)} title="stop this task">
                  ■ STOP
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="panel pix top">FINISHED</div>
        <div className="panel">
          {finished.length === 0 && <div className="line dim">nothing finished yet.</div>}
          {[...finished].reverse().map((t) => (
            <div className="wfrow" key={t.id}>
              <span className={`wfglyph ${t.status}`}>{statusGlyph(t.status)}</span>
              <div className="wfbody">
                <div className="wfdesc">{t.description || t.id}</div>
                {tagLine(t) && <div className="wftag pix sm">{tagLine(t)}</div>}
                {t.summary && <div className="wfsummary">{t.summary}</div>}
                {t.error && <div className="wfsummary red">{t.error}</div>}
                <div className="wfusage dim">
                  {usageLine(t)}
                  {t.status === "stopped" && t.stoppedBy ? ` · stopped by ${name(t.stoppedBy)}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
