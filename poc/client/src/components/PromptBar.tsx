import { useState } from "react";

export function PromptBar(props: {
  isDriver: boolean; agentBusy: boolean; watcherNames: string[];
  skills: { name: string; description: string }[];
  gatesPending: number;
  onPrompt: (text: string) => void; onTakeWheel: () => void;
  onSuggestSkill: (skill: string, args: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const slash = text.match(/^\/(\S*)$/); // "/par" while still typing the name
  const matches = slash
    ? props.skills.filter((s) => s.name.startsWith(slash[1]))
    : [];

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    const cmd = t.match(/^\/(\S+)\s*(.*)$/);
    if (cmd) {
      props.onSuggestSkill(cmd[1], cmd[2]);
      setText("");
      setHint(null);
      return;
    }
    if (!props.isDriver) {
      setHint("watching — suggest a skill with /name, or take the wheel to prompt");
      return;
    }
    props.onPrompt(t);
    setText("");
    setHint(null);
  };

  return (
    <div className="promptbar">
      <div className="inputbox">
        <span className="caret">▸</span>
        <input
          ref={props.inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setHint(null); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={
            props.isDriver
              ? "you're driving — prompt the agent, or /skill…"
              : "watching — suggest a skill with /name args…"
          }
          maxLength={4000}
        />
        <span className="keys">⏎ send</span>
        {matches.length > 0 && (
          <div className="slashmenu">
            {matches.map((s) => (
              <button key={s.name} onClick={() => { setText(`/${s.name} `); props.inputRef.current?.focus(); }}>
                <span className="tag">{props.isDriver ? "RUN" : "SUGGEST"}</span>
                <b>/{s.name}</b>{s.description && <span className="dim"> — {s.description}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {!props.isDriver && (
        <button className="btn gold dashed wide" onClick={props.onTakeWheel}>
          🛞 TAKE THE WHEEL
        </button>
      )}
      <div className="statusline">
        <span className={props.isDriver ? "driving" : ""}>
          {props.isDriver ? "🛞 you are driving" : "watching"}
        </span>
        {props.agentBusy && <span>✦ agent working…</span>}
        {hint && <span className="red">{hint}</span>}
        {props.watcherNames.length > 0 && (
          <span>{props.watcherNames.join(", ")} watching</span>
        )}
        {props.gatesPending > 0 && (
          <span className="gate">🔐 {props.gatesPending} gate{props.gatesPending > 1 ? "s" : ""} pending</span>
        )}
      </div>
    </div>
  );
}
