import { useState } from "react";

const GLYPHS: Record<string, string> = {
  completed: "☒",
  in_progress: "◐",
  pending: "☐",
};

export function TodoPanel(props: { todos: { text: string; status: string }[] }) {
  const [open, setOpen] = useState(false);
  if (props.todos.length === 0) return null;
  const done = props.todos.filter((t) => t.status === "completed").length;
  const doing = props.todos.filter((t) => t.status === "in_progress").length;
  return (
    <aside className={"todopanel panel" + (open ? " open" : "")}>
      <button className="pane-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="pix sm">QUESTS</span>
        <span>{done}/{props.todos.length} ☒{doing ? ` · ${doing} ◐` : ""}</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      <div className="party-title pix">QUEST LOG</div>
      {props.todos.map((t, i) => (
        <div key={i} className={`todo ${t.status}`}>
          {GLYPHS[t.status] ?? "☐"} {t.text}
        </div>
      ))}
    </aside>
  );
}
