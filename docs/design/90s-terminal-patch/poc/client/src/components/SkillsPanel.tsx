import { useState } from "react";

/**
 * DESIGN-ONLY — the v5 harness screen. Nothing behind it yet.
 *
 * Wiring notes:
 *  - the spellbook is the AGENT_SKILLS context filter made visible; "equipped"
 *    is a listing-level fact, not a sandbox (README v3 residual-risk section).
 *  - the run tree maps 1:1 onto subagent Task calls — emit a subagent_start /
 *    subagent_end event family and this renders straight off the log.
 *  - the palette is client-only until slash commands exist server-side.
 */
export interface Skill {
  name: string;
  source: string;
  state: "equipped" | "available" | "muted" | "needs-permission";
  uses?: number;
  path?: string;
  summary?: string;
  tools?: { name: string; gated?: boolean }[];
}

export interface RunNode {
  name: string;
  what: string;
  state: "done" | "running" | "queued";
  meta?: string;
  progress?: number;
  gate?: string;
  xp?: number;
}

const SKILLS: Skill[] = [
  {
    name: "auth-migration-guide", source: "project", state: "equipped", uses: 3,
    path: ".claude/skills/auth-migration-guide/SKILL.md · 214 lines · 2 references",
    summary: "Migrate cookie-session auth to JWT without breaking existing sessions: shim first, rotate second, delete last.",
    tools: [{ name: "Read" }, { name: "Edit" }, { name: "Bash", gated: true }, { name: "Task" }],
  },
  { name: "writing-plans", source: "plugin", state: "available" },
  { name: "code-review", source: "plugin", state: "available" },
  { name: "brainstorming", source: "plugin", state: "available" },
  { name: "web-research", source: "plugin", state: "needs-permission" },
  { name: "frontend-design", source: "plugin", state: "muted" },
];

const RUN: RunNode[] = [
  { name: "scout", what: "map the call sites", state: "done", meta: "haiku 4.5 · 11 files · 38s", xp: 40 },
  { name: "patch", what: "write jwt.ts + shim", state: "running", progress: 55 },
  { name: "verify", what: "run the auth suite", state: "queued", gate: "will need a Bash gate" },
];

const CMDS = [
  { cmd: "/skill", meta: "equip & invoke" },
  { cmd: "/plan", meta: "propose, party votes" },
  { cmd: "/handoff", meta: "pass the wheel" },
  { cmd: "/quest", meta: "restate the objective" },
  { cmd: "/bg", meta: "send to background" },
];

export function SkillsPanel(props: { skills?: Skill[]; run?: RunNode[] }) {
  const skills = props.skills ?? SKILLS;
  const run = props.run ?? RUN;
  const [selected, setSelected] = useState(skills[0]?.name);
  const active = skills.find((s) => s.name === selected) ?? skills[0];

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix xl" style={{ color: "var(--gold)" }}>SKILLS &amp; WORKFLOWS</span>
        <span className="rule" />
        <span style={{ color: "var(--dim)" }}>what the agent may equip this turn</span>
      </div>

      <div className="row">
        <div className="spellbook panel">
          <div className="pix" style={{ color: "var(--dim)" }}>SPELLBOOK · {skills.length}</div>
          {skills.map((s) => (
            <button
              key={s.name}
              className={
                "skill" +
                (s.name === active?.name ? " on" : "") +
                (s.state === "muted" ? " muted" : "")
              }
              onClick={() => setSelected(s.name)}
              style={{ textAlign: "left", background: "transparent" }}
            >
              <div><b>{s.name}</b></div>
              <div className="meta">
                {s.source}
                {s.state === "equipped" && ` · equipped · used ${s.uses ?? 0}×`}
                {s.state === "available" && " · available"}
                {s.state === "needs-permission" && " · needs WebFetch 🔐"}
                {s.state === "muted" && " · muted by the party"}
              </div>
            </button>
          ))}
          <div className="note top">any player can equip · only the driver invokes</div>
        </div>

        <div className="col grow">
          <div className="panel">
            <div className="screen-head" style={{ marginBottom: 8, flexWrap: "wrap" }}>
              <span className="pix lg" style={{ color: "var(--gold)" }}>{active?.name}</span>
              {active?.state === "equipped" && <span className="chip green pix sm">EQUIPPED</span>}
              <span className="rule" />
              <button className="btn accent">INVOKE NOW</button>
            </div>
            <div className="note" style={{ marginBottom: 8 }}>{active?.path ?? "no SKILL.md read yet"}</div>
            {active?.tools && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                {active.tools.map((t) => (
                  <span key={t.name} className={t.gated ? "chip amber" : "chip"}>
                    {t.name}{t.gated ? " 🔐" : ""}
                  </span>
                ))}
              </div>
            )}
            {active?.summary && <div>&ldquo;{active.summary}&rdquo;</div>}
          </div>

          <div className="panel col grow scroll">
            <div className="screen-head">
              <span className="pix" style={{ color: "var(--gold)" }}>✦ WORKFLOW RUN ▸ QUEST CHAIN</span>
              <span className="rule" />
              <span className="note">{run.length} subagents · {run.filter((r) => r.state === "running").length} running</span>
            </div>
            <div className="runtree">
              {run.map((n) => (
                <div key={n.name} className={`node ${n.state}`}>
                  <span
                    className="sprite sm"
                    style={{ color: n.state === "done" ? "var(--green)" : n.state === "running" ? "var(--gold)" : "var(--dim)" }}
                  >
                    {n.state === "done" ? "●" : n.state === "running" ? "✦" : "⏺"}
                  </span>
                  <div className="body">
                    <div><b>{n.name}</b> <span className="meta">· {n.what}</span></div>
                    {n.meta && <div className="meta">{n.meta}</div>}
                    {n.gate && <div className="meta" style={{ color: "var(--amber)" }}>🔐 {n.gate}</div>}
                    {n.progress !== undefined && (
                      <div className="seg" style={{ height: 8, marginTop: 5 }}>
                        <div className="seg-fill gold" style={{ width: `${n.progress}%` }} />
                      </div>
                    )}
                  </div>
                  <span className="state">
                    {n.state === "done" ? `DONE +${n.xp ?? 0}` : n.state.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
            <div className="note top">
              the whole party sees this tree · anyone can request a rerun · only the driver confirms
            </div>
          </div>
        </div>

        <div className="col" style={{ width: 300 }}>
          <div className="panel accent palette">
            <div className="pix" style={{ color: "var(--accent)" }}>COMMAND PALETTE · /</div>
            <div className="field">/skill <span className="cursor">█</span></div>
            {CMDS.map((c, i) => (
              <div key={c.cmd} className={i === 0 ? "cmd on" : "cmd"}>
                <b>{c.cmd}</b> <span className="meta">{c.meta}</span>
              </div>
            ))}
          </div>
          <div className="panel col grow">
            <div className="pix" style={{ color: "var(--dim)" }}>BACKGROUND TASKS</div>
            <div className="task"><div>⏺ typecheck watch</div><div className="ok">clean · 12s ago</div></div>
            <div className="task"><div>⏺ auth suite</div><div className="bad">2 failing · rotation.test.ts</div></div>
            <div className="task"><div>⏺ dev server :5173</div><div className="meta">up 41m</div></div>
            <div className="note top">failures interrupt the driver, not the party</div>
          </div>
        </div>
      </div>
    </div>
  );
}
