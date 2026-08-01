import { useEffect, useState } from "react";
import { SERVER_URL } from "../types";
import { loginUrl } from "../authState";
import { INVITE_STASH_KEY, loginNextFrom } from "../inviteLink";

/** Signed-out landing for an invite link. Resolves the invite via peek_invite
 *  — which never spends the token — so the invitee sees WHAT they were invited
 *  to before being asked to sign in (spec §3.2).
 *
 *  Same throwaway-socket idiom as InviteLanding, and the same wire shape: the
 *  server answers peek_invite with `invite_info`. */
export function InviteSignIn(props: { token: string }) {
  const [target, setTarget] = useState<{ projectName?: string; inviterName?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Stash the token BEFORE offering login: the OAuth `next` below strips the
    // `invite` param (tech-debt §1.2, first half), so the token crosses the
    // round trip in sessionStorage instead of in a URL the login flow — and
    // anything that logs it — can see. App reads it back once on return.
    sessionStorage.setItem(INVITE_STASH_KEY, props.token);
    const ws = new WebSocket(SERVER_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "peek_invite", token: props.token }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "invite_info") setTarget(m);
        else if (m.type === "error") setError(m.message);
      } catch { /* ignore */ }
    };
    ws.onerror = () => setError("could not reach the server");
    return () => ws.close();
  }, [props.token]);

  const next = loginNextFrom(window.location.pathname, window.location.search);

  return (
    <div className="authscreen">
      <div className="authhero">YOU'RE INVITED</div>
      {error ? (
        <div className="authsub">THIS INVITE IS NO LONGER VALID — {error.toUpperCase()}</div>
      ) : target ? (
        <div className="authsub">
          {(target.inviterName ?? "SOMEONE").toUpperCase()} INVITED YOU TO JOIN{" "}
          {(target.projectName ?? "A PROJECT").toUpperCase()}
        </div>
      ) : (
        <div className="authsub">RESOLVING INVITE…</div>
      )}
      <a className="authbtn" href={loginUrl(next)}>
        SIGN IN WITH GITHUB TO JOIN
      </a>
    </div>
  );
}
