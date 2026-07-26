import { useEffect, useRef, useState } from "react";
import { settleRun, type GameEngine, type RunLedger } from "../game/engine";
import { dinoEngine } from "../game/dino";
import { snakeEngine } from "../game/snake";
import { typeRaceEngine } from "../game/typerace";

const LEAVE_MS = 600;
const bestKey = (game: string) => `mpai-${game}-high`;
const readBest = (game: string) => Number(localStorage.getItem(bestKey(game)) ?? 0);
const seed = () => (Date.now() % 100000) | 1;

/** v5b: a slot with an `engine` is playable; the rest render an honest empty
 *  cartridge. Adding a game = adding one pure GameEngine module here. */
const ROSTER: { key: string; label: string; engine?: GameEngine<any> }[] = [
  { key: "dino", label: "DINO RUN", engine: dinoEngine },
  { key: "snake", label: "SNAKE", engine: snakeEngine },
  { key: "breakout", label: "BREAKOUT" },
  { key: "typerace", label: "TYPE RACE", engine: typeRaceEngine },
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
}) {
  const active = props.busy || (props.open ?? false);

  const [game, setGame] = useState("dino");
  const slot = ROSTER.find((g) => g.key === game)!;
  const engine = slot.engine;

  const [state, setState] = useState<unknown>(() => dinoEngine.init(seed()));
  const [playing, setPlaying] = useState(false);
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
    if (!mounted || !engine) return;
    setState(engine.init(seed()));
    setPlaying(false);
    const b = readBest(game);
    setHigh(b);
    ledgerRef.current = { submitted: false, localBest: b };
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
    setState(engine.init(seed()));
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
  }, [active, playing, game, engine, props.busy, props.open]);

  if (!mounted) return null;
  const pad = (n: number) => String(n).padStart(4, "0");
  const best = props.partyBests?.[game];
  const score = engine ? engine.score(state) : 0;
  const over = engine ? engine.over(state) : false;

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
          onClick={() => {
            if (!playing) start();
            else setState((s: any) => engine.input(s, "click"));
          }}
        >
          {engine.render(state).join("\n")}
        </pre>
      ) : (
        <pre className="lane" style={{ color: "var(--dim)" }}>
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
              ? engine.hint(state, true)
              : over
                ? "RUN COMPLETE — SPACE to play again"
                : engine.hint(state, false) + " · G swaps game"}
          {!props.busy && " · ESC closes"}
        </span>
      </div>
    </div>
  );
}
