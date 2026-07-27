import { loginUrl } from "../authState";

/** Signed-out landing for a plain visit (no invite token). Sign-in is the only
 *  control: with auth on, nothing else is reachable until a session exists. */
export function Landing() {
  return (
    <div className="authscreen">
      <div className="authhero">MULTIPLAYER AI</div>
      <div className="authsub">
        ONE AGENT. YOUR WHOLE TEAM. EVERY DECISION SIGNED BY THE HUMAN WHO MADE IT.
      </div>
      <a className="authbtn" href={loginUrl(window.location.pathname + window.location.search)}>
        SIGN IN WITH GITHUB
      </a>
    </div>
  );
}
