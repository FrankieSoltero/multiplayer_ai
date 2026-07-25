import { useEffect, useRef, useState } from "react";
import { initialState, jump, tick, renderLane, type DinoState } from "../game/dino";

const HIGH_KEY = "mpai-dino-high";
const LEAVE_MS = 600;

export function ThinkingStrip(props: { busy: boolean; modelLabel: string }) {
  const [state, setState] = useState<DinoState>(() => initialState(Date.now() % 100000 | 1));
  const [high, setHigh] = useState(() => Number(localStorage.getItem(HIGH_KEY) ?? 0));
  const [elapsed, setElapsed] = useState(0);
  // opt-in play: the lane sits idle until the viewer starts it (space or a
  // click on the strip); death stops the run instead of auto-restarting.
  const [playing, setPlaying] = useState(false);
  const startRef = useRef(0);

  // delayed unmount: stay mounted (with .leaving) for LEAVE_MS after busy
  // flips false, so the strip can fade out instead of vanishing instantly.
  // If busy flips true again mid-fade, the pending unmount is cancelled.
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

  // fresh strip per turn: reset to an idle lane; the timer always ticks
  // (it's the thinking indicator) but the game only runs once started.
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

  // game loop only while the viewer is playing
  useEffect(() => {
    if (!props.busy || !playing) return;
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
  }, [props.busy, playing]);

  // dead → stop the run and persist the high score; space starts a new run
  useEffect(() => {
    if (state.alive) return;
    setPlaying(false);
    if (state.score > high) {
      setHigh(state.score);
      localStorage.setItem(HIGH_KEY, String(state.score));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.alive]);

  // start / restart / jump — shared by the space key and clicks on the strip
  const play = () => {
    if (!playing) {
      setState((s) => (s.alive ? s : initialState((s.rng % 100000) | 1)));
      setPlaying(true);
      return;
    }
    setState((s) => jump(s));
  };

  // space plays when not typing
  useEffect(() => {
    if (!props.busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      e.preventDefault();
      play();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.busy, playing]);

  if (!mounted) return null;
  const [air, ground] = renderLane(state);
  const pad = (n: number) => String(n).padStart(4, "0");
  return (
    <div className={"thinking term-frame" + (leaving ? " leaving" : "")}>
      <div className="thinking-head">
        <span className="pulse">✦</span> {props.modelLabel} is thinking… ({elapsed}s)
        <span className="thinking-score">score {pad(state.score)} · high {pad(high)}</span>
      </div>
      <pre className="lane" onClick={play}>{air + "\n" + ground}</pre>
      <div className="thinking-hint">
        {playing
          ? "space to jump · click the prompt to type instead"
          : state.alive && state.t === 0
            ? "space (or click the lane) to play while you wait"
            : "game over — space to play again"}
      </div>
    </div>
  );
}
