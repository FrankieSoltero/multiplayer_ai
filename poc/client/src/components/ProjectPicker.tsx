import { useEffect, useRef, useState } from "react";
import { SERVER_URL, isProjectMember, projectMemberCount } from "../types";
import type { ProjectSummary } from "../types";
import { sortProjects, projectSummaryLine } from "../projectList";

/** Whether this screen's socket is up. `connecting` is the brief pre-open
 *  state and shows nothing — a failed connect lands in `down` via onerror. */
type LinkState = "connecting" | "live" | "down";

const DISCONNECTED_TEXT =
  "lost the hub — it may have restarted. this list is stale; reload to reconnect.";

/** The hub entrance (spec §4.1): every project on the hub, not only yours.
 *  The LIST is hub-wide — a non-member still SEES every project; depth is
 *  membership-gated, so what a non-member sees is redacted and acting is
 *  refused (spec A5). This screen therefore never filters the list by
 *  membership; the redaction shapes each row, not the roster's presence.
 *
 *  `signedInAs` is the verified GitHub login, or null when the viewer is
 *  anonymous / auth is off (App.tsx derives it from auth state, mirroring how
 *  SessionView is wired). The pair-a-machine affordance is gated on it: only a
 *  signed-in browser can approve a device, and the hub rejects the POST from
 *  anyone else — so it is never offered to a viewer who cannot use it. */
export function ProjectPicker(props: { userId: string; name: string; signedInAs: string | null }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");
  const [name, setName] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [pairResult, setPairResult] = useState<PairResult | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let mounted = true;
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      if (!mounted) return;
      setLink("live");
      setError(null);
      ws.send(JSON.stringify({ type: "identify", userId: props.userId, name: props.name }));
      ws.send(JSON.stringify({ type: "list_projects" }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "projects") setProjects(msg.projects ?? []);
        if (msg.type === "project_created") enterProject(msg.projectId);
        if (msg.type === "error") setError(msg.message);
      } catch {
        return;
      }
    };
    // A dev hub gets restarted often, so losing the socket is the EXPECTED
    // case, not an exotic one — what a restart no longer costs is the projects
    // themselves, only this tab's connection to them.
    // Without these handlers the list went silently stale and `send()` threw
    // InvalidStateError inside the click handler — CREATE did nothing, with no
    // feedback. `mounted` guards the close our own cleanup causes.
    const drop = () => { if (mounted) setLink("down"); };
    ws.onclose = drop;
    ws.onerror = drop;
    return () => {
      mounted = false;
      ws.close();
    };
  }, [props.userId, props.name]);

  const create = () => {
    if (!name.trim()) return;
    const ws = wsRef.current;
    // readyState, not null: a socket that has closed is still a non-null
    // object, and sending on it throws rather than failing quietly. No
    // reconnect loop — this screen's whole state is one `list_projects` reply,
    // so a reload is a cheaper and more honest recovery than a retry ladder.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setLink("down");
      setError(DISCONNECTED_TEXT);
      return;
    }
    setError(null);
    ws.send(JSON.stringify({ type: "create_project", name: name.trim() }));
  };

  const approve = async () => {
    if (!pairCode.trim()) return;
    const result = await browserApprovePairing(pairCode);
    setPairResult(result);
    // Clear only on success — a rejected code stays put so it can be corrected
    // and retried without retyping.
    if (result.ok) setPairCode("");
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="pix lg">PROJECTS</span>
        <span className="rule" />
        <span className="pix">{props.name}</span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {link === "down" && (
          <div className="panel">
            <div className="line red">{DISCONNECTED_TEXT}</div>
          </div>
        )}
        <div className="panel">
          <ProjectRows projects={projects} userId={props.userId} />
        </div>
        <div className="panel pix top">NEW PROJECT</div>
        <div className="panel">
          <div className="spform">
            <input
              className="spinput"
              placeholder="project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button className="btn" disabled={!name.trim() || link === "down"} onClick={create}>
              CREATE ▸
            </button>
          </div>
          <div className="line dim">
            projects and their records persist in the hub's store (HUB_DB).
          </div>
          {error && <div className="line red">{error}</div>}
        </div>
        {props.signedInAs !== null && (
          <>
            <div className="panel pix top">PAIR A MACHINE</div>
            <div className="panel">
              <div className="spform">
                <input
                  className="spinput"
                  placeholder="pairing code"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") approve();
                  }}
                />
                <button className="btn" disabled={!pairCode.trim()} onClick={approve}>
                  APPROVE ▸
                </button>
              </div>
              <div className="line dim">
                approve a machine you started with `cli pair` — the code is shown on that machine.
              </div>
              {pairResult && (
                <div className={pairResult.ok ? "line" : "line red"}>{pairMessage(pairResult)}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The pairing-approval core, kept pure and fetch-injected (same seam as
 *  `signOut.ts`) so the wire contract and both outcomes are testable in a
 *  project with no DOM test environment. */
export type PairResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** Canonicalize a typed code the way the hub's own `normalizeCode` does —
 *  uppercase and strip dashes — so any grouping/casing the user types still
 *  matches the code the hub minted. */
export function normalizePairCode(raw: string): string {
  return raw.toUpperCase().replace(/-/g, "");
}

/** POST a pairing code to `/pair/approve` and reduce the response to a result.
 *
 *  Same-origin and relative: the URL is not prefixed with any API origin so
 *  the session cookie (which authorizes the approval) rides on the request and
 *  is read back on the origin it was set for. On 200 the hub returns the paired
 *  machine's name; any non-200 carries an `error` string this surfaces verbatim
 *  (401 authentication required / 403 not on the allowlist / 404 unknown or
 *  expired code — spec A2). */
export async function approvePairing(
  fetchImpl: (url: string, init: RequestInit) => Promise<{ status: number; json: () => Promise<unknown> }>,
  rawCode: string,
): Promise<PairResult> {
  const code = normalizePairCode(rawCode);
  // A rejected fetch (the browser is offline, the hub is unreachable) must not
  // escape as an unhandled rejection that leaves the approve handler's panel
  // silently stuck — mirror signOut.ts and turn it into an inline result the
  // component renders. Only the transport is wrapped; a non-200 the hub DID
  // answer still flows through the verbatim-error path below.
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl("/pair/approve", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { ok: false, error: "could not reach the hub" };
  }
  const body = (await res.json().catch(() => null)) as
    | { machineId?: unknown; name?: unknown; error?: unknown }
    | null;
  if (res.status === 200 && body && typeof body.name === "string") {
    return { ok: true, name: body.name };
  }
  const error =
    body && typeof body.error === "string" ? body.error : "pairing failed — try again";
  return { ok: false, error };
}

/** The browser-wired default, beside the pure core so the component does not
 *  re-derive it (mirrors `browserSignOut`). */
export const browserApprovePairing = (rawCode: string): Promise<PairResult> =>
  approvePairing((url, init) => globalThis.fetch(url, init), rawCode);

/** The one line the entrance shows for a pairing result: the paired machine's
 *  name on success, or the hub's error text inline on failure. */
export function pairMessage(result: PairResult): string {
  return result.ok ? `paired: ${result.name}` : result.error;
}

/** The entrance's project list, taken as a prop.
 *
 *  Exported and props-only for the same reason as `SessionGroups`: the picker
 *  fills `projects` from a socket in `useEffect`, static rendering never runs
 *  effects, so the picker itself can only ever draw an EMPTY list in a test.
 *  This seam is what lets `ProjectPicker.test.tsx` assert the redaction-safe
 *  count and the isMember-driven SPECTATING badge against real fixtures.
 *
 *  Both read through the `types.ts` helpers, never off `members` directly: a
 *  redacted non-member sees `members: []` but a true `memberCount`, and its
 *  membership is `isMember: false` — so the count stays honest and the badge
 *  no longer flips on an empty roster (spec A5). */
export function ProjectRows(props: { projects: ProjectSummary[]; userId: string }) {
  const rows = sortProjects(props.projects);
  return (
    <>
      {rows.length === 0 && (
        <div className="line dim">no projects yet — create one below.</div>
      )}
      {rows.map((p) => {
        const count = projectMemberCount(p);
        return (
          <div className="sprow" key={p.id}>
            <div className="spbody">
              <div className="spname">
                {p.name}
                {p.lifecycle === "closed" && (
                  <span className="spstate pix sm closed">CLOSED</span>
                )}
                {!isProjectMember(p, props.userId) && (
                  <span className="spstate pix sm">SPECTATING</span>
                )}
              </div>
              <div className="spwho pix sm">
                {count} {count === 1 ? "member" : "members"} ·{" "}
                {projectSummaryLine(p)}
              </div>
            </div>
            <button className="btn" onClick={() => enterProject(p.id)}>
              ENTER ▸
            </button>
          </div>
        );
      })}
    </>
  );
}

function enterProject(projectId: string): void {
  const params = new URLSearchParams();
  params.set("project", projectId);
  window.location.search = params.toString();
}
