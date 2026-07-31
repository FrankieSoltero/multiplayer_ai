import { type JSX } from "react";
import type { SubSessionInfo } from "../derive";

interface SubSessionRailProps {
  subSessions: SubSessionInfo[];
  view: string | null;
  onSelect: (key: string | null) => void; // null = MAIN
}

/**
 * The sub-session rail (spec §2.3/§2.5): a `MAIN` chip plus one `⚒ <label>`
 * chip per sub-session, in spawn order. The active chip carries `active`, a
 * gate-pending chip `gated` (with a `!` badge), a finished one `done`. Clicking
 * a chip asks App to swap the projected view via `onSelect` — view state is
 * client-local (constraint 5), so this component is stateless.
 *
 * Renders `null` when there are no sub-sessions: today's layout is untouched
 * for every session without sub-agents, which is what keeps the whole change
 * inert (no feature flag needed). No chip cap — the rail scrolls horizontally
 * rather than wrapping into the transcript area (spec §2.5).
 */
export function SubSessionRail(props: SubSessionRailProps): JSX.Element | null {
  if (props.subSessions.length === 0) return null;
  return (
    <div className="subsession-rail" style={{ overflowX: "auto" }}>
      <button
        className={props.view === null ? "subsession-chip active" : "subsession-chip"}
        onClick={() => props.onSelect(null)}
      >
        MAIN
      </button>
      {props.subSessions.map((s) => {
        const cls = ["subsession-chip"];
        if (props.view === s.key) cls.push("active");
        if (s.gatePending) cls.push("gated");
        if (s.status === "done") cls.push("done");
        return (
          <button key={s.key} className={cls.join(" ")} onClick={() => props.onSelect(s.key)}>
            ⚒ {s.label}
            {s.gatePending ? <span className="badge">!</span> : null}
          </button>
        );
      })}
    </div>
  );
}
