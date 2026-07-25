import { MODEL_LABELS } from "./Header";

/** ?screen=status — DESIGN SCREEN. HP/MP bars render "—" and empty until a
 *  usage wire event exists (spec §4, out of scope for v5c). What IS real: the
 *  model, the class-swap grid (driver-gated, same rules as the header select),
 *  the roster count, and the static harness facts in the tool grid. */
const TOOLS: { name: string; note: string; gated?: boolean; ok?: boolean }[] = [
  { name: "Read", note: "free" },
  { name: "Grep", note: "free" },
  { name: "Edit", note: "in worktree", ok: true },
  { name: "Write", note: "in worktree", ok: true },
  { name: "Bash", note: "gated 🔐", gated: true },
  { name: "WebFetch", note: "gated 🔐", gated: true },
  { name: "Agent", note: "spawns subagents" },
  { name: "Skill", note: "roster below" },
];

export function AgentStatus(props: {
  model: string;
  canSetModel: boolean;
  onSetModel: (key: string) => void;
  rosterCount: number;
}) {
  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix xl" style={{ color: "var(--gold)" }}>AGENT STATUS</span>
        <span className="rule" />
        <span style={{ color: "var(--dim)" }}>design screen — bars await usage wiring</span>
      </div>

      <div className="row">
        <div className="agentcard panel gold raised">
          <div className="id">
            <span className="sprite lg" style={{ color: "var(--gold)" }}>✦</span>
            <div>
              <div className="name">{(MODEL_LABELS[props.model] ?? props.model).toUpperCase()}</div>
              <div className="class">class: driver&apos;s agent · LV.—</div>
            </div>
          </div>

          <div>
            <div className="bar-label"><span>HP · CONTEXT LEFT</span><span style={{ color: "var(--green)" }}>—</span></div>
            <div className="seg lg"><div className="seg-fill" style={{ width: "0%" }} /></div>
          </div>
          <div>
            <div className="bar-label"><span>MP · TOKEN BUDGET</span><span style={{ color: "var(--gold)" }}>—</span></div>
            <div className="seg lg"><div className="seg-fill gold" style={{ width: "0%" }} /></div>
          </div>

          <div className="fx">
            <div className="pix sm" style={{ color: "var(--dim)" }}>STATUS EFFECTS</div>
            <div style={{ color: "var(--green)" }}>✓ worktree-locked writes</div>
            <div style={{ color: "var(--gold)" }}>✦ {props.rosterCount} skill{props.rosterCount === 1 ? "" : "s"} equipped</div>
            <div style={{ color: "var(--amber)" }}>🔐 Bash gated except tests &amp; read-only git</div>
          </div>
        </div>

        <div className="col grow">
          <div className="panel">
            <div className="pix" style={{ color: "var(--dim)", marginBottom: 10 }}>
              SWAP CLASS ▸ DRIVER ONLY, BETWEEN TURNS
            </div>
            <div className="classpick">
              {Object.entries(MODEL_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  className={key === props.model ? "opt on" : "opt"}
                  style={{ background: "transparent", cursor: props.canSetModel ? "pointer" : "default", textAlign: "left" }}
                  disabled={!props.canSetModel}
                  onClick={() => props.onSetModel(key)}
                >
                  <div className="title">{label.toUpperCase()}</div>
                  <div className="meta">
                    {key === "opus" ? "slow · deep · costly" : key === "sonnet" ? "fast · balanced" : "instant · cheap"}
                  </div>
                  <div className="meta" style={key === props.model ? { color: "var(--green)" } : undefined}>
                    {key === props.model ? "▸ equipped" : ""}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="panel scroll">
            <div className="pix" style={{ color: "var(--dim)" }}>EQUIPPED TOOLS</div>
            <div className="toolgrid" style={{ marginTop: 8 }}>
              {TOOLS.map((t) => (
                <div key={t.name} className={t.gated ? "tool gated" : "tool"}>
                  {t.name} <span className={t.ok ? "ok" : "free"}>· {t.note}</span>
                </div>
              ))}
            </div>
            <div className="note top">auto-approved: npm test, npx vitest, npx tsc, git status/diff/log</div>
          </div>
        </div>
      </div>
    </div>
  );
}
