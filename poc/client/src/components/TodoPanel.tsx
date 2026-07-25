const GLYPHS: Record<string, string> = {
  completed: "☒",
  in_progress: "◐",
  pending: "☐",
};

export function TodoPanel(props: { todos: { text: string; status: string }[] }) {
  if (props.todos.length === 0) return null;
  return (
    <aside className="todopanel term-frame">
      <div className="party-title">AGENT TODOS</div>
      {props.todos.map((t, i) => (
        <div key={i} className={`todo ${t.status}`}>
          {GLYPHS[t.status] ?? "☐"} {t.text}
        </div>
      ))}
    </aside>
  );
}
