import { useEffect, useRef, useState } from "react";
import { settleRun, type GameEngine, type RunLedger } from "../game/engine";
import { dinoEngine } from "../game/dino";
import { snakeEngine } from "../game/snake";
import { tetrisEngine } from "../game/tetris";
import { doodleEngine } from "../game/doodle";

const LEAVE_MS = 600;

/** Client-local arcade footprint preference (constraint 6). The stored value is
 *  a lane font-size multiplier of the mono base token `--fs` (13px); Task 13
 *  owns the resize control that WRITES it. */
export const ARCADE_SIZE_KEY = "mpai-arcade-size";
export const ARCADE_SCALE = { min: 0.5, max: 1.0, default: 0.65, step: 0.05 } as const;

/** Pure: parse a stored scale, clamp to [min,max]; NaN/absent → default. */
export function readStoredScale(raw: string | null): number {
  if (raw == null) return ARCADE_SCALE.default;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return ARCADE_SCALE.default;
  return Math.min(ARCADE_SCALE.max, Math.max(ARCADE_SCALE.min, n));
}

/** The initial lane scale. The READ is try/catch-wrapped so a blocked-storage
 *  sandbox (getItem throws) falls back silently to the default, never a crash
 *  (constraint 6). This task adds the READ path only. */
function readInitialScale(): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ARCADE_SIZE_KEY);
  } catch {
    raw = null;
  }
  return readStoredScale(raw);
}

const bestKey = (game: string) => `mpai-${game}-high`;
const readBest = (game: string) => {
  const n = Number(localStorage.getItem(bestKey(game)) ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const timeSeed = () => (Date.now() % 100000) | 1;
/** FNV-1a — stable 32-bit hash of a session identity string. */
const hashSeed = (s: string) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** v5b: a slot with an `engine` is playable; the rest render an honest empty
 *  cartridge. Adding a game = adding one pure GameEngine module here. */
const ROSTER: { key: string; label: string; engine?: GameEngine<any> }[] = [
  { key: "dino", label: "DINO RUN", engine: dinoEngine },
  { key: "snake", label: "SNAKE", engine: snakeEngine },
  { key: "tetris", label: "TETRIS", engine: tetrisEngine },
  { key: "doodlejump", label: "DOODLE JUMP", engine: doodleEngine },
];

export interface PartyBest {
  name: string;
  glyph: string;
  color: string;
  score: number;
  game?: string;
}

export function ThinkingStrip(props: {
  busy: boolean;
  /** v5b idle arcade: mounts the strip with no agent thinking */
  open?: boolean;
  onClose?: () => void;
  modelLabel: string;
  partyBests?: Record<string, PartyBest>;
  currentTool?: string;
  onScore?: (game: string, score: number) => void;
  /** v5b final-review: notified whenever a run's key-capturing status
   *  changes (including unmount) so the transcript can mute its a/d
   *  permission hotkeys while game letters are live. */
  onPlayingChange?: (capturing: boolean) => void;
  /** Stable session identity (e.g. `${project}/${session}`). When present,
   *  seeds are derived from it per game, so every player in the session gets
   *  the same world (fair party-score runs — doodle consumes its seed; the
   *  others ignore it by design, spec §3.4). Absent → time-based seeds. */
  sessionKey?: string;
}) {
  const active = props.busy || (props.open ?? false);

  const [game, setGame] = useState("dino");
  const mkSeed = (gameKey: string) =>
    props.sessionKey != null
      ? hashSeed(`${props.sessionKey}:${gameKey}`) | 1
      : timeSeed();
  const slot = ROSTER.find((g) => g.key === game)!;
  const engine = slot.engine;

  const [state, setState] = useState<unknown>(() => dinoEngine.init(mkSeed("dino")));
  const [playing, setPlaying] = useState(false);
  // state must be re-initialized in the SAME render pass that switches
  // engines — an effect runs after render, and the new engine would render
  // the old game's state shape (live-crash found in v5b acceptance).
  // The setters schedule a re-render, but THIS pass still runs to the
  // bottom, so it must render from the freshly-initialized local value.
  const [renderedGame, setRenderedGame] = useState(game);
  let runState = state;
  if (renderedGame !== game) {
    setRenderedGame(game);
    setPlaying(false);
    if (engine) {
      runState = engine.init(mkSeed(game));
      setState(runState);
    }
  }
  // arcade footprint scale — read once on mount (constraint 6); Task 13 adds
  // the resize control that writes it.
  const [scale] = useState(readInitialScale);
  const laneStyle = { fontSize: `calc(var(--fs) * ${scale})` };
  const [high, setHigh] = useState(() => readBest("dino"));
  const ledgerRef = useRef<RunLedger>({ submitted: false, localBest: readBest("dino") });
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

  const [mounted, setMounted] = useState(active);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (active) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const t = setTimeout(() => { setMounted(false); setLeaving(false); }, LEAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // v5b final-review: any live run captures the keyboard (game letters
  // overlap the a/d permission hotkeys) — tell the transcript so it can
  // mute those hotkeys for the duration. Conservative on purpose: any
  // mounted+playing run mutes, dino included; permission cards' on-screen
  // buttons remain clickable throughout.
  const capturing = mounted && playing && !!engine;
  useEffect(() => {
    props.onPlayingChange?.(capturing);
    return () => props.onPlayingChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  // thinking timer — busy turns only; the idle arcade has no timer
  useEffect(() => {
    if (!props.busy) return;
    startRef.current = performance.now();
    const t = setInterval(
      () => setElapsed(Math.floor((performance.now() - startRef.current) / 1000)),
      1000,
    );
    setElapsed(0);
    return () => clearInterval(t);
  }, [props.busy]);

  // fresh run + ledger on mount and on cartridge swap — NOT on busy flips,
  // so a run keeps going when the agent starts thinking mid-play
  useEffect(() => {
    if (!mounted) return;
    setPlaying(false);
    const b = readBest(game);
    setHigh(b);
    ledgerRef.current = { submitted: false, localBest: b };
    if (engine) setState(engine.init(mkSeed(game)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, game]);

  useEffect(() => {
    if (!active || !playing || !engine) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      setState((s: any) => (engine.over(s) ? s : engine.tick(s, dt)));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, playing, engine]);

  // settle a finished run exactly once: personal best + party submission
  useEffect(() => {
    if (!engine || !engine.over(state)) return;
    setPlaying(false);
    const score = engine.score(state);
    const { ledger, submit } = settleRun(ledgerRef.current, true, score);
    if (ledger === ledgerRef.current) return;
    ledgerRef.current = ledger;
    if (ledger.localBest > high) {
      setHigh(ledger.localBest);
      localStorage.setItem(bestKey(game), String(ledger.localBest));
    }
    if (submit && score > 0) props.onScore?.(game, score);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const start = () => {
    if (!engine) return;
    setState(engine.init(mkSeed(game)));
    ledgerRef.current = { submitted: false, localBest: ledgerRef.current.localBest };
    setPlaying(true);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Escape" && !props.busy && props.open) {
        props.onClose?.();
        return;
      }
      const textLive = playing && engine?.capturesText;
      if ((e.key === "g" || e.key === "G") && !e.metaKey && !e.ctrlKey && !e.altKey && !textLive) {
        e.preventDefault();
        const i = ROSTER.findIndex((g) => g.key === game);
        setGame(ROSTER[(i + 1) % ROSTER.length].key);
        return;
      }
      if (!engine) return;
      if (e.key === " " && !playing) {
        e.preventDefault();
        start();
        return;
      }
      if (!playing) return;
      if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault();
      setState((s: any) => engine.input(s, e.key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playing, game, engine, props.busy, props.open, props.onClose]);

  if (!mounted) return null;
  const pad = (n: number) => String(n).padStart(4, "0");
  const best = props.partyBests?.[game];
  const score = engine ? engine.score(runState) : 0;
  const over = engine ? engine.over(runState) : false;

  return (
    <div className={"thinking panel" + (leaving ? " leaving" : "")}>
      <div className="thinking-head">
        {props.busy ? (
          <span className="who">
            ✦ {props.modelLabel.toUpperCase()} IS THINKING… {String(elapsed).padStart(2, "0")}S
          </span>
        ) : (
          <span className="who">▪ ARCADE — INSERT COIN</span>
        )}
        {props.busy && props.currentTool && <span className="tool">tool · {props.currentTool}</span>}
        <span className="rule" />
        <span className="thinking-score">SCORE {pad(score)}</span>
        {best ? (
          <span className="thinking-best">
            PARTY BEST {pad(best.score)} <span style={{ color: best.color }}>{best.glyph}</span> {best.name}
          </span>
        ) : (
          <span className="thinking-best">YOUR BEST {pad(high)}</span>
        )}
      </div>

      {engine ? (
        <pre
          className="lane"
          style={laneStyle}
          onClick={() => {
            if (!playing) start();
            else setState((s: any) => engine.input(s, "click"));
          }}
        >
          {engine.render(runState).join("\n")}
        </pre>
      ) : (
        <pre className="lane" style={{ ...laneStyle, color: "var(--dim)" }}>
          {"  cartridge not inserted — " + game + " has no engine yet\n" + "▁".repeat(40)}
        </pre>
      )}

      <div className="roster">
        <span className="pix sm">GAME ▸</span>
        {ROSTER.map((g) => (
          <button
            key={g.key}
            className={g.key === game ? "roster-item on" : "roster-item"}
            onClick={() => setGame(g.key)}
            title={g.engine ? "" : "no engine yet"}
          >
            {g.label}
          </button>
        ))}
        <span className="hint">
          {!engine
            ? "G swaps game"
            : playing
              ? engine.hint(runState, true)
              : over
                ? "RUN COMPLETE — SPACE to play again"
                : engine.hint(runState, false) + " · G swaps game"}
          {!props.busy && " · ESC closes"}
        </span>
      </div>
    </div>
  );
}
