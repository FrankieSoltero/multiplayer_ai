import { useEffect, useState } from "react";
import type { PluginInfo, ProjectSessionInfo } from "../types";
import { suiteFromSessions } from "../skillSuite";

/** ?screen=skills — the party's skill surface. Real data everywhere it exists:
 *  suite = union of session rosters (Task 10 wire), palette = this session's
 *  roster, sub-quests = this session's real subagent groups. The patch's
 *  background-tasks section is dropped (nothing behind it — spec §4). */
export function SkillsPanel(props: {
  sessions: ProjectSessionInfo[];
  sessionId: string;
  roster: { name: string; description: string }[];
  subruns: { label: string; status: "running" | "done"; rows: number }[];
  plugins: PluginInfo[];
  pluginsEnabled: boolean;
  errors: string[];
  onAddPlugin: (url: string) => void;
  onRemovePlugin: (name: string) => void;
  onBack?: () => void;
}) {
  const suite = suiteFromSessions(props.sessions);
  const [selected, setSelected] = useState<string | null>(null);
  const active = suite.find((s) => s.name === selected) ?? suite[0];

  const [url, setUrl] = useState("");
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  // A registry change or a fresh server error both mean the in-flight add
  // has resolved — clear the cloning row.
  useEffect(() => setPendingUrl(null), [props.plugins.length, props.errors.length]);

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix xl" style={{ color: "var(--gold)" }}>SKILLS &amp; WORKFLOWS</span>
        <span className="rule" />
        <span style={{ color: "var(--dim)" }}>every skill the party&apos;s sessions bring</span>
        {props.onBack && (
          <button className="btn" onClick={props.onBack} title="back to the session (S or Esc)">
            ⮐ BACK [S]
          </button>
        )}
      </div>

      <div className="row">
        <div className="spellbook panel">
          <div className="pix" style={{ color: "var(--dim)" }}>PLUGINS · {props.plugins.length}</div>
          {props.plugins.map((p) => (
            <div key={p.name} className="cmd">
              <b>{p.name}</b>{" "}
              <span className="meta">
                {p.skills.length} skills · added by {p.addedBy}
              </span>
              <button
                className="btn"
                onClick={() => props.onRemovePlugin(p.name)}
                title={`remove ${p.name} (${p.url})`}
              >
                ✕
              </button>
            </div>
          ))}
          {pendingUrl && <div className="note">cloning {pendingUrl}…</div>}
          {props.pluginsEnabled ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https:// git url — import a skills plugin"
                style={{ flex: 1 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && url) {
                    props.onAddPlugin(url);
                    setPendingUrl(url);
                    setUrl("");
                  }
                }}
              />
              <button
                className="btn"
                disabled={!url}
                onClick={() => {
                  props.onAddPlugin(url);
                  setPendingUrl(url);
                  setUrl("");
                }}
              >
                ADD
              </button>
            </div>
          ) : (
            <div className="note">plugin import is off — set AGENT_PLUGINS_ROOT on the server</div>
          )}
          <div className="note">plugins apply to sessions started from now — this session keeps its loadout</div>
          <div className="pix top" style={{ color: "var(--dim)" }}>SKILL SUITE · {suite.length}</div>
          {suite.map((s) => (
            <button
              key={s.name}
              className={"skill" + (s.name === active?.name ? " on" : "")}
              onClick={() => setSelected(s.name)}
              style={{ textAlign: "left", background: "transparent" }}
            >
              <div><b>{s.name}</b></div>
              <div className="meta">{s.sources.map((src) => src.sessionId).join(" · ")}</div>
            </button>
          ))}
          {suite.length === 0 && <div className="note">no skills in any session yet</div>}
          <div className="note top">union of every session&apos;s roster · tagged by session</div>
        </div>

        <div className="col grow">
          <div className="panel">
            <div className="screen-head" style={{ marginBottom: 8, flexWrap: "wrap" }}>
              <span className="pix lg" style={{ color: "var(--gold)" }}>{active?.name ?? "—"}</span>
              <span className="rule" />
            </div>
            {active && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                {active.sources.map((src) => (
                  <span key={src.sessionId} className="chip gold">
                    {src.sessionId}{src.driverName ? ` · 🛞 ${src.driverName}` : ""}
                  </span>
                ))}
              </div>
            )}
            {active?.description
              ? <div>&ldquo;{active.description}&rdquo;</div>
              : <div className="note">no description in this skill&apos;s SKILL.md</div>}
          </div>

          <div className="panel col grow scroll">
            <div className="screen-head">
              <span className="pix" style={{ color: "var(--gold)" }}>✦ SUB-QUESTS THIS SESSION</span>
              <span className="rule" />
              <span className="note">
                {props.subruns.length} spawned · {props.subruns.filter((r) => r.status === "running").length} running
              </span>
            </div>
            <div className="runtree">
              {props.subruns.map((n, i) => (
                <div key={i} className={`node ${n.status}`}>
                  <span
                    className="sprite sm"
                    style={{ color: n.status === "done" ? "var(--green)" : "var(--gold)" }}
                  >
                    {n.status === "done" ? "●" : "✦"}
                  </span>
                  <div className="body">
                    <div><b>{n.label}</b></div>
                    <div className="meta">{n.rows} transcript rows</div>
                  </div>
                  <span className="state">{n.status.toUpperCase()}</span>
                </div>
              ))}
              {props.subruns.length === 0 && <div className="note">no subagents spawned yet</div>}
            </div>
          </div>
        </div>

        <div className="col" style={{ width: 300 }}>
          <div className="panel accent palette">
            <div className="pix" style={{ color: "var(--accent)" }}>COMMAND PALETTE · /</div>
            {props.roster.map((s) => (
              <div key={s.name} className="cmd">
                <b>/{s.name}</b> <span className="meta">{s.description}</span>
              </div>
            ))}
            {props.roster.length === 0 && <div className="note">this session has no skills equipped</div>}
            <div className="note top">passenger / suggests · driver / runs</div>
          </div>
        </div>
      </div>
      {props.errors.length > 0 && <div className="line red">⚠ {props.errors.at(-1)}</div>}
    </div>
  );
}
