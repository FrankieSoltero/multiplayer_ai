import { browserSignOut } from "../signOut";
import { contestedCountFor } from "../collisionView";
import type { Collision } from "multiplayer-ai-server/collisions";
import type { Theme } from "../theme";
import type { ModelRosterEntry } from "../types";

/** Fallback option labels for an OLD server whose skill_roster carries no
 *  `models` field yet (local-models plan §1.2) — same old-server tolerance
 *  posture as every other additive wire field. When the roster arrives the
 *  picker reads it instead and this constant is unused for options. */
export const MODEL_LABELS: Record<string, string> = {
  opus: "opus 5", sonnet: "sonnet 5", haiku: "haiku 4.5", fable: "fable 5",
};

/** Every hud field is optional. turn/toolsUsed/gated are derived client-side
 *  in App; elapsed/contextUsed/contextMax/partyXp are fed by the turn_end
 *  usage payload (agent-surface §1, derive.ts). Truthful-UI rule (plan §2.4):
 *  a segment with no feed yet renders NOTHING, not an em dash. */
export interface HudData {
  turn?: number;
  elapsed?: string;
  contextUsed?: number;
  contextMax?: number;
  toolsUsed?: number;
  gated?: number;
  partyXp?: number;
}

/** Turn elapsed for the TURN cell: "12.3s" under a minute, "2m05s" past it. */
export function formatDurationMs(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

const dash = (v: unknown) => (v === undefined || v === null ? "—" : String(v));
const k = (n?: number) => (n === undefined ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function Header(props: {
  projectId: string; sessionId: string; model: string; connected: boolean;
  /** Whether the server's `joined` success ack has arrived (PRD §10.4b).
   *  Optional so a caller that has not wired it renders byte-identical to today
   *  — undefined/false is the still-connecting state, shown with today's exact
   *  `● ONLINE` idiom; only a true value promotes it to the distinct `● JOINED`.
   *  An old server never sends the ack, so it stays false there and the header
   *  reads exactly as before. */
  joined?: boolean;
  objective: string | null; canSetModel: boolean; onSetModel: (key: string) => void;
  permissionMode: string; canCycleMode: boolean; onCycleMode: () => void;
  arcadeOpen: boolean; canToggleArcade: boolean; onToggleArcade: () => void;
  /** The active presentation look and a toggle that flips it. Present in BOTH
   *  themes (parity, constraint 2) — a theme changes how the app reads, never
   *  whether the switch is there. `useTheme` (App) owns the state; this button
   *  only fires the flip. */
  theme: Theme; onThemeToggle: () => void;
  onOpenSkills: () => void;
  onOpenWorkflows: () => void; runningTasks: number;
  onOpenOversight: () => void; oversightFresh: boolean;
  onExit: () => void;
  /** The verified GitHub login, or null when auth is off / anonymous. Absent
   *  means no sign-out control renders at all — there is nothing to sign out
   *  of, and a dead button would be worse than none. */
  signedInAs?: string | null;
  /** How many other sessions are waiting on an approval past this viewer's
   *  threshold. 0 renders nothing — an always-present PULLS ▸ 0 would train
   *  people to ignore the one place this feature speaks. */
  pulls?: number;
  /** §8.5 pull click-through: jumps to the oldest-waiting pull's session.
   *  Optional so a caller that has not wired navigation renders the badge
   *  exactly as before — a plain, non-interactive `<span>` (regression
   *  floor). Present, the badge becomes a real `<button>` so it is
   *  keyboard-operable, not just clickable. */
  onPullsClick?: () => void;
  /** Contested paths across the project, derived once in `App` from the shared
   *  `collisionsFrom` (spec §5). Optional so a caller that has not computed
   *  them renders no badge rather than crashing — and so no other call site
   *  has to change. */
  contested?: Collision[];
  /** The server's model roster (skill_roster's additive `models` field,
   *  local-models plan §1.2). Absent/empty = an old server: the picker falls
   *  back to MODEL_LABELS, byte-identical to today. Local entries are tagged
   *  `· LOCAL` in the option text (theme-independent, T14) and carry their
   *  `degradedNote` on the option's title — honest at the point of choice,
   *  not discovered later. */
  models?: ModelRosterEntry[];
  hud?: HudData;
}) {
  const hud = props.hud ?? {};
  // How many contested paths involve THIS session — not the project's total.
  // 0 renders nothing, for the same reason PULLS does: a badge that is always
  // on screen is a badge nobody reads.
  const contestedCount = contestedCountFor(props.sessionId, props.contested ?? []);
  const pct =
    hud.contextUsed !== undefined && hud.contextMax
      ? Math.min(100, Math.round((hud.contextUsed / hud.contextMax) * 100))
      : 0;

  return (
    <>
      <div className="term-header term-frame">
        <span className="crumb">
          multiplayer_ai <span className="sep">▸</span> <b>{props.projectId}</b>{" "}
          <span className="sep">▸</span> session <b>{props.sessionId}</b>
        </span>
        <span className="rule" />
        {/* NOT a <label> wrapper: a label that wraps its control forwards a
          * second, synthesized click to it, so the native dropdown opened and
          * instantly closed again — clicking the model picker looked dead.
          * The accessible name comes from aria-label instead. */}
        <span className="pix">
          AGENT{" "}
          <select
            aria-label="agent model"
            value={props.model}
            disabled={!props.canSetModel}
            onChange={(e) => props.onSetModel(e.target.value)}
            title={props.canSetModel ? "switch model (applies next turn)" : "only the driver can switch, between turns"}
          >
            {(props.models && props.models.length > 0
              ? props.models
              : Object.entries(MODEL_LABELS).map(
                  ([key, label]): ModelRosterEntry => ({ key, id: key, label }),
                )
            ).map((m) => (
              <option key={m.key} value={m.key} title={m.degradedNote}>
                {m.local ? `${m.label} · LOCAL` : m.label}
              </option>
            ))}
          </select>
        </span>
        <button
          className={
            props.permissionMode === "auto"
              ? "planmode auto on"
              : props.permissionMode === "plan"
                ? "planmode on"
                : "planmode"
          }
          disabled={!props.canCycleMode}
          onClick={props.onCycleMode}
          title={
            props.canCycleMode
              ? props.permissionMode === "auto"
                ? "AUTO: permission gates self-approve — every decision still lands on the wire. Click or press M to cycle."
                : props.permissionMode === "plan"
                  ? "PLAN: the agent must present a plan for approval before acting. Click or press M to cycle."
                  : "DEFAULT: gates ask the driver. Click or press M to cycle."
              : "only the driver can change the permission mode — take the wheel first"
          }
        >
          {props.permissionMode === "auto"
            ? "⚡ MODE: AUTO"
            : props.permissionMode === "plan"
              ? "◉ MODE: PLAN"
              : "▢ MODE: DEFAULT"}
        </button>
        <button
          className={props.arcadeOpen ? "planmode on" : "planmode"}
          disabled={!props.canToggleArcade}
          onClick={props.onToggleArcade}
          title={
            props.canToggleArcade
              ? "open the arcade while you wait (A)"
              : "the agent is thinking — the arcade is already on screen"
          }
        >
          {props.arcadeOpen ? "◉ ARCADE" : "▢ ARCADE"}
        </button>
        <button
          className="planmode"
          onClick={props.onThemeToggle}
          title="switch the presentation theme (Arcade / Clean)"
        >
          {props.theme === "clean" ? "THEME ▸ CLEAN" : "THEME ▸ ARCADE"}
        </button>
        <button
          className="planmode"
          onClick={props.onOpenSkills}
          title="skills (S)"
        >
          ▢ SKILLS
        </button>
        <button
          className={props.runningTasks > 0 ? "planmode on" : "planmode"}
          onClick={props.onOpenWorkflows}
          title="live subagent workflows (W)"
        >
          {props.runningTasks > 0 ? `▸ WORKFLOWS ▸ ${props.runningTasks}` : "▢ WORKFLOWS"}
        </button>
        <button
          className={props.oversightFresh ? "planmode on" : "planmode"}
          onClick={props.onOpenOversight}
          title="team oversight (O)"
        >
          {props.oversightFresh ? "▸ OVERSIGHT ●" : "▢ OVERSIGHT"}
        </button>
        <button
          className="planmode"
          onClick={props.onExit}
          title="leave this session (/exit)"
        >
          ▢ EXIT
        </button>
        <span className={props.connected ? "conn" : "conn off"}>
          {props.connected
            ? props.joined
              ? "● JOINED"
              : "● ONLINE"
            : "○ OFFLINE"}
        </span>
        {(props.pulls ?? 0) > 0 &&
          (props.onPullsClick ? (
            <button
              type="button"
              className="conn pull-badge"
              title="sessions waiting on an approval — click to jump to the oldest"
              onClick={props.onPullsClick}
            >
              🔐 PULLS ▸ {props.pulls}
            </button>
          ) : (
            <span className="conn pull-badge" title="sessions waiting on an approval">
              🔐 PULLS ▸ {props.pulls}
            </span>
          ))}
        {contestedCount > 0 && (
          <span
            className="conn contested-calm"
            title="files this session is changing that another session is changing too"
          >
            {`⚠ CONTESTED ▸ ${contestedCount}`}
          </span>
        )}
        {props.signedInAs && (
          <button
            className="planmode"
            onClick={() => void browserSignOut()}
            title={`signed in as ${props.signedInAs} — sign out`}
            aria-label={`signed in as ${props.signedInAs} — sign out`}
          >
            ⏻ {props.signedInAs}
          </button>
        )}
      </div>

      <div className="hud">
        <div className="hud-cell panel">
          <div className="hud-label pix sm"><span>TURN</span></div>
          <div className="hud-val">
            {dash(hud.turn)} <span className="sub">· {hud.elapsed ?? "—"}</span>
          </div>
        </div>
        {hud.contextUsed !== undefined && (
          <div className="hud-cell wide panel">
            <div className="hud-label pix sm">
              <span>CONTEXT</span>
              <span style={{ color: "var(--green)" }}>
                {k(hud.contextUsed)}
                {hud.contextMax !== undefined && ` / ${k(hud.contextMax)}`}
              </span>
            </div>
            <div className="seg">
              <div className="seg-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        <div className="hud-cell panel">
          <div className="hud-label pix sm"><span>TOOLS USED</span></div>
          <div className="hud-val">
            {dash(hud.toolsUsed)}{" "}
            <span className="sub">· {hud.gated ?? 0} gated</span>
          </div>
        </div>
        {hud.partyXp !== undefined && (
          <div className="hud-cell panel">
            <div className="hud-label pix sm"><span>PARTY XP</span></div>
            <div className="hud-val" style={{ color: "var(--gold)" }}>
              +{k(hud.partyXp)} <span className="sub">session</span>
            </div>
          </div>
        )}
      </div>

      {props.objective && (
        <div className="quest">
          <span className="label pix">✦ QUEST</span>
          <span>{props.objective}</span>
          <span className="spacer" />
        </div>
      )}
    </>
  );
}
