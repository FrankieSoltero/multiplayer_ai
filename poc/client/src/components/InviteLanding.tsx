import { useEffect, useState } from "react";
import { SERVER_URL } from "../types";
import { expiryLabel } from "../inviteLink";

type Info = {
  projectId: string;
  sessionId: string;
  inviterName: string;
  expiresAt: number;
  remaining: number;
};

/** Shown when a `?invite=` link is opened, before the lobby. Uses its own
 *  throwaway socket for the preview — same idiom as Lobby's `peek`. */
export function InviteLanding(props: {
  token: string;
  onAccept: (target: { projectId: string; sessionId: string }) => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "peek_invite", token: props.token }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "invite_info") setInfo(m);
        if (m.type === "error") setError(m.message);
      } catch { /* ignore */ }
    };
    ws.onerror = () => setError("could not reach the server");
    return () => ws.close();
  }, [props.token]);

  if (error) {
    return (
      <div className="screen invland">
        <div className="panel">
          <div className="pix lg">INVITE UNAVAILABLE</div>
          <div className="line dim">{error}</div>
          <a className="btn" href="?">◂ BROWSE SESSIONS</a>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="screen invland">
        <div className="panel"><div className="line dim">CHECKING INVITE…</div></div>
      </div>
    );
  }

  return (
    <div className="screen invland">
      <div className="panel">
        <div className="pix lg invhero">{info.inviterName.toUpperCase()} INVITED YOU</div>
        <div className="line">{info.projectId} / {info.sessionId}</div>
        <div className="line dim">
          {expiryLabel(info.expiresAt, Date.now())} · {info.remaining} SEAT
          {info.remaining === 1 ? "" : "S"} LEFT
        </div>
        <button
          className="btn"
          onClick={() => props.onAccept({ projectId: info.projectId, sessionId: info.sessionId })}
        >
          PRESS START
        </button>
      </div>
    </div>
  );
}
