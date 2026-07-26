import type { ReactNode } from "react";

/**
 * The cabinet + the glass. Wraps the whole app so every screen inherits the
 * scanlines, vignette, roll and bezel instead of each one faking them.
 *
 * `intensity` is a design knob, not state: "full" is the demo look, "subtle"
 * keeps the tint/vignette but stops the flicker and the roll, "off" strips the
 * overlays and the curvature entirely (also what someone screen-recording for
 * a README wants).
 */
export function Crt(props: {
  intensity?: "off" | "subtle" | "full";
  height?: number | string;
  children: ReactNode;
}) {
  const intensity = props.intensity ?? "full";
  const vars =
    intensity === "off"
      ? { "--crt-op": 0, "--crt-flick": "none", "--crt-curve": "0px" }
      : intensity === "subtle"
        ? { "--crt-op": 0.4, "--crt-flick": "none", "--crt-curve": "18px" }
        : { "--crt-op": 1, "--crt-flick": "flick 6s steps(2,end) infinite", "--crt-curve": "18px" };

  return (
    <div className={intensity === "off" ? "crt off" : "crt"} style={vars as React.CSSProperties}>
      <div className="crt-screen" style={{ height: props.height ?? "100%" }}>
        {props.children}
      </div>
      <div className="crt-fx crt-scan" />
      <div className="crt-fx crt-vig" />
      <div className="crt-fx crt-tint" />
      <div className="crt-fx crt-roll" />
      <div className="crt-fx crt-bezel" />
    </div>
  );
}

/** Cabinet chrome around the CRT: marquee on top, legend underneath. */
export function Cabinet(props: { legend?: string[]; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="cabinet">
      <div className="cabinet-inner">
        <div className="marquee">
          <div>
            <div className="marquee-title">
              MULTIPLAYER<span>_</span>AI
            </div>
            <div className="marquee-sub">SHARED AGENT SESSIONS FOR TEAMS</div>
          </div>
          {props.right}
        </div>
        {props.children}
        {props.legend && props.legend.length > 0 && (
          <div className="lobby-foot" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            {props.legend.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
