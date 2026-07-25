import { MODEL_LABELS } from "./Header";

/**
 * DESIGN-ONLY. Nothing on the server produces these numbers yet — the props
 * carry defaults so the screen renders standalone, and every field is the
 * shape it would take if wired:
 *   HP = context remaining, MP = token budget, status effects = the containment
 *   rules already enforced server-side (worktree lock, Bash allowlist, skills).
 */
export interface AgentStatusData {
  model: string;
  level?: number;
  contextPct?: number;
  tokenPct?: number;
  worktree?: string;
  skillsEquipped?: number;
  subagentsAllowed?: number;
  turn?: { tools: number; files: number; gates: number; denied: number; redirects: number; elapsed: string };
  modelUsage?: Record<string, string>;
}

const TOOLS: { name: string; note: string; gated?: boolean; ok?: boolean }[] = [
  { name: "Read", note: "free" },
  { name: "Grep", note: "free" },
  { name: "Edit", note: "in worktree", ok: true },
  { name: "Write", note: "in worktree", ok: true },
  { name: "Bash", note: "gated 🔐", gated: true },
  { name: "Task", note: "gated 🔐", gated: true },
  { name: "WebFetch", note: "gated 🔐", gated: true },
  { name: "Skill", note: "1 loaded" },
];

export function AgentStatus(props: { data?: AgentStatusData; onSetModel?: (key: string) => void; canSetModel?: boolean }) {
  const d: AgentStatusData = props.data ?? {
    model: "opus",
    level: 12,
    contextPct: 81,
    tokenPct: 64,
    worktree: "demo-worktrees/ana",
    skillsEquipped: 1,
    subagentsAllowed: 3,
    turn: { tools: 7, files: 4, gates: 3, denied: 1, redirects: 2, elapsed: "04:12" },
    modelUsage: { sonnet: "used 2× today", haiku: "subagents use this" },
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix xl" style={{ color: "var(--gold)" }}>AGENT STATUS</span>
        <span className="rule" />
        <span style={{ color: "var(--dim)" }}>the agent is a party member, not a chat box</span>
      </div>

      <div className="row">
        <div className="agentcard panel gold raised">
          <div className="id">
            <span className="sprite lg" style={{ color: "var(--gold)" }}>✦</span>
            <div>
              <div className="name">{(MODEL_LABELS[d.model] ?? d.model).toUpperCase()}</div>
              <div className="class">class: driver&#39;s agent · LV.{d.level ?? "—"}</div>
            </div>
          </div>

          <div>
            <div className="bar-label"><span>HP · CONTEXT LEFT</span><span style={{ color: "var(--green)" }}>{d.contextPct ?? "—"}%</span></div>
            <div className="seg lg"><div className="seg-fill" style={{ width: `${d.contextPct ?? 0}%` }} /></div>
          </div>
          <div>
            <div className="bar-label"><span>MP · TOKEN BUDGET</span><span style={{ color: "var(--gold)" }}>{d.tokenPct ?? "—"}%</span></div>
            <div className="seg lg"><div className="seg-fill gold" style={{ width: `${d.tokenPct ?? 0}%` }} /></div>
          </div>

          <div className="fx">
            <div className="pix sm" style={{ color: "var(--dim)" }}>STATUS EFFECTS</div>
            <div style={{ color: "var(--green)" }}>✓ worktree-locked · {d.worktree}</div>
            <div style={{ color: "var(--gold)" }}>✦ {d.skillsEquipped} skill equipped</div>
            <div style={{ color: "var(--amber)" }}>🔐 Bash gated except tests &amp; read-only git</div>
            <div style={{ color: "var(--dim)" }}>⏺ {d.subagentsAllowed} subagents allowed</div>
          </div>

          <div className="note top">
            switching class mid-turn is refused — it applies on the next turn, and the whole party sees the swap.
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
                  className={key === d.model ? "opt on" : "opt"}
                  style={{ background: "transparent", cursor: props.canSetModel ? "pointer" : "default", textAlign: "left" }}
                  disabled={!props.canSetModel}
                  onClick={() => props.onSetModel?.(key)}
                >
                  <div className="title">{label.toUpperCase()}</div>
                  <div className="meta">
                    {key === "opus" ? "slow · deep · costly" : key === "sonnet" ? "fast · balanced" : "instant · cheap"}
                  </div>
                  <div className="meta" style={key === d.model ? { color: "var(--green)" } : undefined}>
                    {key === d.model ? "▸ equipped" : (d.modelUsage?.[key] ?? "")}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="row">
            <div className="col grow panel scroll">
              <div className="pix" style={{ color: "var(--dim)" }}>EQUIPPED TOOLS</div>
              <div className="toolgrid">
                {TOOLS.map((t) => (
                  <div key={t.name} className={t.gated ? "tool gated" : "tool"}>
                    {t.name}{" "}
                    <span className={t.ok ? "ok" : "free"}>· {t.note}</span>
                  </div>
                ))}
              </div>
              <div className="note top">
                auto-approved: npm test, npx vitest, npx tsc, git status/diff/log
              </div>
            </div>

            <div className="panel scroll" style={{ width: 290, display: "flex", flexDirection: "column", gap: 7 }}>
              <div className="pix" style={{ color: "var(--dim)" }}>THIS TURN</div>
              <div className="kv"><span className="k">tools called</span><span>{d.turn?.tools ?? "—"}</span></div>
              <div className="kv"><span className="k">files touched</span><span>{d.turn?.files ?? "—"}</span></div>
              <div className="kv"><span className="k">gates raised</span><span style={{ color: "var(--amber)" }}>{d.turn?.gates ?? "—"}</span></div>
              <div className="kv"><span className="k">denied</span><span style={{ color: "var(--red)" }}>{d.turn?.denied ?? "—"}</span></div>
              <div className="kv"><span className="k">redirects</span><span style={{ color: "var(--gold)" }}>{d.turn?.redirects ?? "—"}</span></div>
              <div className="kv"><span className="k">elapsed</span><span>{d.turn?.elapsed ?? "—"}</span></div>
              <div className="note top">every number here is party-visible — nobody debugs alone.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
