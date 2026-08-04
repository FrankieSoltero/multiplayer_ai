import { useEffect, useRef, useState } from "react";
import { SERVER_URL, isProjectMember } from "../types";
import type { ProjectSummary } from "../types";
import { expiryLabel, seatsLeftLabel } from "../inviteLink";

/** What `peek_invite` answers with (plan §1.3): the project, its display name,
 *  and who invited — no session, because invites are project-scoped now. */
export type InviteInfo = {
  projectId: string;
  projectName: string;
  inviterName: string;
  expiresAt: number;
  remaining: number;
};

/** Shown when a `?invite=` link is opened, before the picker. Uses its own
 *  throwaway socket for the preview AND the accept (plan §1.6): PRESS START is
 *  a real `join_project` carrying the token on THIS socket, not a route hop —
 *  the redeem is consuming, so routing away first and joining later would
 *  spend the token on a screen that has no way to report the failure. */
export function InviteLanding(props: {
  token: string;
  userId: string;
  name: string;
  onAccept: (target: { projectId: string }) => void;
}) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Mirrors for the socket handler, installed once per token — the same ref
  // discipline as SessionPicker's membershipRef: the handler reads the refs,
  // never the render closure that installed it.
  const infoRef = useRef<InviteInfo | null>(null);
  const acceptingRef = useRef(false);
  const acceptedRef = useRef(false);

  useEffect(() => {
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      // identify FIRST, and unconditionally: the hub refuses join_project with
      // "identify first" otherwise, and the standalone server tolerates the
      // frame — one client speaks one protocol (plan §2.1). With auth on, the
      // hub overwrites both fields with the verified GitHub login, so the
      // local id and a best-effort name are all this needs to assert.
      ws.send(JSON.stringify({ type: "identify", userId: props.userId, name: props.name }));
      ws.send(JSON.stringify({ type: "peek_invite", token: props.token }));
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "invite_info") {
          infoRef.current = m;
          setInfo(m);
        }
        if (m.type === "error") {
          // An error after PRESS START is the redeem refusal: render it inline
          // and STAY on the landing — a failed token admits no one (plan §1.3).
          if (acceptingRef.current) {
            acceptingRef.current = false;
            setAccepting(false);
            setAcceptError(m.message);
          } else {
            setError(m.message);
          }
        }
        if (m.type === "projects" && acceptingRef.current && !acceptedRef.current) {
          const projectId = infoRef.current?.projectId;
          // join_project's ack is a `projects` frame on both answerers — but
          // the hub also narrowcasts one to every channel on ANY directory
          // change, so only a frame showing THIS user a member of THIS project
          // is the accept; anything else is someone else's push. Keep waiting.
          const joined =
            projectId !== undefined &&
            ((m.projects ?? []) as ProjectSummary[]).some(
              (p) => p.id === projectId && isProjectMember(p, props.userId),
            );
          if (!joined) return;
          acceptedRef.current = true;
          // The token did its work — strip it from the address bar so a
          // refresh or a copied URL cannot replay a spent invite (tech-debt
          // §1.2, second half). The `project` param stays: it IS the route.
          window.history.replaceState({}, "", `?project=${encodeURIComponent(projectId)}`);
          props.onAccept({ projectId });
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => setError("could not reach the server");
    return () => ws.close();
  }, [props.token, props.userId, props.name, props.onAccept]);

  const accept = () => {
    const target = infoRef.current;
    if (target === null || acceptingRef.current) return;
    const ws = wsRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      setAcceptError("not connected — try again");
      return;
    }
    acceptingRef.current = true;
    setAccepting(true);
    setAcceptError(null);
    ws.send(JSON.stringify({ type: "join_project", projectId: target.projectId, invite: props.token }));
  };

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
    <InviteHero info={info} accepting={accepting} acceptError={acceptError} onAccept={accept} />
  );
}

/** The loaded landing, props-only so the no-DOM render tests can pin the
 *  project-scoped copy — effects never run under this repo's static render
 *  (docs/tech-debt.md), so the info state is unreachable there unless it is a
 *  prop. Same seam SessionGroups provides for SessionPicker. */
export function InviteHero(props: {
  info: InviteInfo;
  accepting: boolean;
  acceptError: string | null;
  onAccept: () => void;
}) {
  const { info } = props;
  return (
    <div className="screen invland">
      <div className="panel">
        <div className="pix lg invhero">{info.inviterName.toUpperCase()} INVITED YOU</div>
        <div className="line">{info.projectName}</div>
        <div className="line dim">
          {expiryLabel(info.expiresAt, Date.now())} · {seatsLeftLabel(info.remaining)}
        </div>
        {props.acceptError && <div className="line red">{props.acceptError}</div>}
        <button className="btn" disabled={props.accepting} onClick={props.onAccept}>
          {props.accepting ? "JOINING…" : "PRESS START"}
        </button>
      </div>
    </div>
  );
}
