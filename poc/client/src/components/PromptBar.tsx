import { useEffect, useRef, useState } from "react";
import { matchSkills, moveHighlight } from "../slashMatch";
import { parseClientCommand, type ClientCommand } from "../clientCommands";

export function PromptBar(props: {
  isDriver: boolean; agentBusy: boolean; watcherNames: string[];
  skills: { name: string; description: string }[];
  gatesPending: number;
  onPrompt: (text: string) => void; onTakeWheel: () => void;
  onSuggestSkill: (skill: string, args: string) => void;
  onClientCommand: (command: ClientCommand) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false); // Esc closes until the text changes
  const listRef = useRef<HTMLDivElement | null>(null);

  const slash = text.match(/^\/(\S*)$/); // "/par" while still typing the name
  const matches = slash ? matchSkills(slash[1], props.skills) : [];
  const menuOpen = matches.length > 0 && !dismissed;

  // one rule: any change to the match list resets the highlight to the top
  const matchKey = matches.map((m) => m.name).join("\n");
  useEffect(() => { setHighlight(0); }, [matchKey]);

  // the 3-row window follows the keyboard highlight
  useEffect(() => {
    listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [highlight, matchKey]);

  const accept = (name: string) => {
    setText(`/${name} `); // trailing space ends the name token → menu closes itself
    setHint(null);
    props.inputRef.current?.focus();
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    // Before the skill router: `/exit` is ours, not the agent's. Also before
    // the isDriver check — leaving is not a driving privilege.
    const command = parseClientCommand(t);
    if (command) {
      setText("");
      setHint(null);
      props.onClientCommand(command);
      return;
    }
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

  const effectiveHighlight = Math.min(highlight, matches.length - 1);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (menuOpen) {
      // clamp: the reset-to-0 effect runs post-render, so guard a stale index
      const sel = matches[effectiveHighlight];
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => moveHighlight(h, 1, matches.length)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => moveHighlight(h, -1, matches.length)); return; }
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); accept(sel.name); return; } // Shift+Tab stays reverse focus traversal (accessibility floor, v6a ruling)
      if (e.key === "Enter") { accept(sel.name); return; }
      if (e.key === "Escape") { setDismissed(true); return; }
    }
    if (e.key === "Enter") submit();
  };

  const selName = matches[effectiveHighlight]?.name;

  return (
    <div className="promptbar">
      <div className="inputbox">
        <span className="caret">▸</span>
        <input
          ref={props.inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setHint(null); setDismissed(false); }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls="slashmenu-list"
          aria-autocomplete="list"
          aria-activedescendant={menuOpen && selName ? `slashopt-${selName}` : undefined}
          placeholder={
            props.isDriver
              ? "you're driving — prompt the agent, or /skill…"
              : "watching — suggest a skill with /name args…"
          }
          maxLength={4000}
        />
        <span className="keys">⏎ send</span>
        {menuOpen && (
          <div className="slashmenu" id="slashmenu-list" role="listbox" ref={listRef}>
            {matches.map((s, i) => (
              <button
                key={s.name}
                id={`slashopt-${s.name}`}
                role="option"
                aria-selected={i === effectiveHighlight}
                className={i === effectiveHighlight ? "sel" : undefined}
                onClick={() => accept(s.name)}
              >
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
