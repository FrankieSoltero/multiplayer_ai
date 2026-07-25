import { useEffect, useRef, useState } from "react";
import { initialState, jump, tick, renderLane, type DinoState } from "../game/dino";

const HIGH_KEY = "mpai-dino-high";
const LEAVE_MS = 600;

export function ThinkingStrip(props: { busy: boolean; modelLabel: string }) {
  const [state, setState] = useState<DinoState>(() => initialState(Date.now() % 100000 | 1));
  const [high, setHigh] = useState(() => Number(localStorage.getItem(HIGH_KEY) ?? 0));
  const [elapsed, setElapsed] = useState(0);
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

  // game loop while busy
  useEffect(() => {
    if (!props.busy) return;
    startRef.current = performance.now();
    setState(initialState((Date.now() % 100000) | 1));
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      setElapsed(Math.floor((now - startRef.current) / 1000));
      setState((s) => {
        if (!s.alive) return s;
        return tick(s, dt);
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [props.busy]);

  // dead → auto-restart after a beat; persist high score
  useEffect(() => {
    if (state.alive) return;
    if (state.score > high) {
      setHigh(state.score);
      localStorage.setItem(HIGH_KEY, String(state.score));
    }
    const t = setTimeout(() => setState(initialState((state.rng % 100000) | 1)), 1000);
    return () => clearTimeout(t);
  }, [state.alive]);

  // space to jump when not typing
  useEffect(() => {
    if (!props.busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      e.preventDefault();
      setState((s) => jump(s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.busy]);

  if (!mounted) return null;
  const [air, ground] = renderLane(state);
  const pad = (n: number) => String(n).padStart(4, "0");
  return (
    <div className={"thinking term-frame" + (leaving ? " leaving" : "")}>
      <div className="thinking-head">
        <span className="pulse">✦</span> {props.modelLabel} is thinking… ({elapsed}s)
        <span className="thinking-score">score {pad(state.score)} · high {pad(high)}</span>
      </div>
      <pre className="lane">{air + "\n" + ground}</pre>
      <div className="thinking-hint">space to jump · click the prompt to type instead</div>
    </div>
  );
}
