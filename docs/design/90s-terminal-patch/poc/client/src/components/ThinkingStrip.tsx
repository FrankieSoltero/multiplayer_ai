import { useEffect, useRef, useState } from "react";
import { initialState, jump, tick, renderLane, type DinoState } from "../game/dino";

const HIGH_KEY = "mpai-dino-high";
const LEAVE_MS = 600;

/** v5: a roster instead of one game. Only `dino` has an engine today
 *  (`game/dino.ts`); the rest render an empty-slot lane until they get one.
 *  A new game needs the same three exports: initialState / tick / renderLane. */
const GAMES = [
  { key: "dino", label: "DINO RUN", ready: true },
  { key: "snake", label: "SNAKE", ready: false },
  { key: "breakout", label: "BREAKOUT", ready: false },
  { key: "typerace", label: "TYPE RACE", ready: false },
] as const;

export interface PartyBest {
  name: string;
  glyph: string;
  color: string;
  score: number;
  game?: string;
}

export function ThinkingStrip(props: {
  busy: boolean;
  modelLabel: string;
  /** v5 party-wide high score. Needs a game_score event + a per-session vs
   *  per-project decision (HANDOFF §0.3); the local high score works without it. */
  partyBest?: PartyBest;
  currentTool?: string;
}) {
  const [state, setState] = useState<DinoState>(() => initialState(Date.now() % 100000 | 1));
  const [high, setHigh] = useState(() => Number(localStorage.getItem(HIGH_KEY) ?? 0));
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [game, setGame] = useState<string>("dino");
  const startRef = useRef(0);

  const [mounted, setMounted] = useState(props.busy);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (props.busy) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const t = setTimeout(() => { setMounted(false); setLeaving(false); }, LEAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.busy]);

  useEffect(() => {
    if (!props.busy) return;
    startRef.current = performance.now();
    setState(initialState((Date.now() % 100000) | 1));
    setPlaying(false);
    const t = setInterval(
      () => setElapsed(Math.floor((performance.now() - startRef.current) / 1000)),
      1000,
    );
    setElapsed(0);
    return () => clearInterval(t);
  }, [props.busy]);

  const playable = game === "dino";

  useEffect(() => {
    if (!props.busy || !playing || !playable) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      setState((s) => (s.alive ? tick(s, dt) : s));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [props.busy, playing, playable]);

  useEffect(() => {
    if (state.alive) return;
    setPlaying(false);
    if (state.score > high) {
      setHigh(state.score);
      localStorage.setItem(HIGH_KEY, String(state.score));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.alive]);

  const play = () => {
    if (!playable) return;
    if (!playing) {
      setState((s) => (s.alive ? s : initialState((s.rng % 100000) | 1)));
      setPlaying(true);
      return;
    }
    setState((s) => jump(s));
  };

  useEffect(() => {
    if (!props.busy) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space") { e.preventDefault(); play(); }
      if (e.key === "g") {
        e.preventDefault();
        const i = GAMES.findIndex((g) => g.key === game);
        setGame(GAMES[(i + 1) % GAMES.length].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.busy, playing, game]);

  if (!mounted) return null;
  const [air, ground] = renderLane(state);
  const pad = (n: number) => String(n).padStart(4, "0");
  const best = props.partyBest;

  return (
    <div className={"thinking panel" + (leaving ? " leaving" : "")}>
      <div className="thinking-head">
        <span className="who">✦ {props.modelLabel.toUpperCase()} IS THINKING… {pad(elapsed).slice(2)}S</span>
        {props.currentTool && <span className="tool">tool · {props.currentTool}</span>}
        <span className="rule" />
        <span className="thinking-score">SCORE {pad(state.score)}</span>
        {best ? (
          <span className="thinking-best">
            PARTY BEST {pad(best.score)} <span style={{ color: best.color }}>{best.glyph}</span> {best.name}
          </span>
        ) : (
          <span className="thinking-best">YOUR BEST {pad(high)}</span>
        )}
      </div>

      {playable ? (
        <pre className="lane" onClick={play}>{air + "\n" + ground}</pre>
      ) : (
        <pre className="lane" style={{ color: "var(--dim)" }}>
          {"  cartridge not inserted — " + game + " has no engine yet\n" + "▁".repeat(40)}
        </pre>
      )}

      <div className="roster">
        <span className="pix sm">GAME ▸</span>
        {GAMES.map((g) => (
          <button
            key={g.key}
            className={g.key === game ? "roster-item on" : "roster-item"}
            onClick={() => setGame(g.key)}
            title={g.ready ? "" : "no engine yet"}
          >
            {g.label}
          </button>
        ))}
        <span className="hint">
          {playing
            ? "SPACE jump · click the prompt to type instead"
            : playable && state.alive && state.t === 0
              ? "SPACE (or click the lane) to play while you wait · G swaps game"
              : playable
                ? "GAME OVER — SPACE to play again"
                : "G swaps game"}
        </span>
      </div>
    </div>
  );
}
