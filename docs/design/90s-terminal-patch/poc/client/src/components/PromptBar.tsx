import { useState } from "react";

export function PromptBar(props: {
  isDriver: boolean; agentBusy: boolean; watcherNames: string[];
  onPrompt: (text: string) => void; onTakeWheel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  gatesPending?: number;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    props.onPrompt(t);
    setText("");
  };
  return (
    <div className="promptbar">
      {props.isDriver ? (
        <div className="inputbox">
          <span className="caret">▸</span>
          <input
            ref={props.inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="you're driving — prompt the agent…"
            maxLength={4000}
          />
          <span className="keys">⏎ send</span>
        </div>
      ) : (
        <button className="btn gold dashed wide" onClick={props.onTakeWheel}>
          🛞 TAKE THE WHEEL — PRESS W
        </button>
      )}
      <div className="statusline">
        <span className={props.isDriver ? "driving" : ""}>
          {props.isDriver ? "🛞 you are driving" : "watching"}
        </span>
        {props.agentBusy && <span>✦ agent working</span>}
        {props.watcherNames.length > 0 && <span>{props.watcherNames.join(", ")} watching</span>}
        {props.gatesPending ? (
          <span className="gate">🔐 {props.gatesPending} gate{props.gatesPending > 1 ? "s" : ""} pending</span>
        ) : null}
      </div>
    </div>
  );
}
