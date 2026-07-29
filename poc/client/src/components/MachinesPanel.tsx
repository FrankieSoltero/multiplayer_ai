import type { MachineInfo } from "../types";
import { machineRows } from "../machineRows";

/** The project screen's MACHINES panel (spec §8): every machine by name and
 *  online state, its attached repos each with DETACH, its remaining
 *  candidates each with ATTACH — the discoverability answer for a machine
 *  whose repos are all candidates (nothing but ATTACH buttons render for it).
 *
 *  The caller renders this ONLY when `refusal === null` (spec §8: absent, not
 *  disabled, for spectators — same rule as the create form, spec §4.4); this
 *  component itself carries no refusal check.
 *
 *  Buttons: `ATTACH ▸` per candidate, `DETACH ▸` per attached repo, disabled
 *  while `pending` — one in-flight routed command at a time (spec §12.1),
 *  same posture as the create form's CREATE button. An offline machine's row
 *  still renders — sessions outlive machines, so its attached repos still
 *  name real history (`machineRows` keeps the row) — but with no buttons:
 *  nothing can be routed to a machine that isn't there. */
export function MachinesPanel(props: {
  machines: MachineInfo[];
  onAttach: (machineId: string, repoKey: string) => void;
  onDetach: (machineId: string, repoKey: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const rows = machineRows(props.machines);

  return (
    <>
      <div className="panel pix top">MACHINES</div>
      <div className="panel">
        {rows.length === 0 && <div className="line dim">no machines have ever connected.</div>}
        {rows.map((row) => (
          <div key={row.machineId}>
            <div className="line pix sm dim">
              {row.name}{row.online ? "" : " (offline)"}
            </div>
            {row.attached.map((repo) => (
              <div className="sprow" key={repo.key}>
                <div className="spbody">
                  <div className="spname">{repo.label}</div>
                </div>
                {row.online && (
                  <button
                    className="btn"
                    disabled={props.pending}
                    onClick={() => props.onDetach(row.machineId, repo.key)}
                  >
                    DETACH ▸
                  </button>
                )}
              </div>
            ))}
            {row.candidates.map((repo) => (
              <div className="sprow" key={repo.key}>
                <div className="spbody">
                  <div className="spname">{repo.label}</div>
                </div>
                {row.online && (
                  <button
                    className="btn"
                    disabled={props.pending}
                    onClick={() => props.onAttach(row.machineId, repo.key)}
                  >
                    ATTACH ▸
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        {props.error && <div className="line red">{props.error}</div>}
      </div>
    </>
  );
}
