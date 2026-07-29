import type { LoggedEvent, SkillInfo } from "./events.js";
import type { PendingGate } from "./pendingGate.js";
import type { Lifecycle } from "./lifecycle.js";
/** `SLUG` is the canonical regex for session and project IDs; imported from
 *  `project.ts` to ensure the relay parser accepts exactly what `server.ts`
 *  enforces, keeping the shape in one place. */
import { SLUG } from "./project.js";

/** Bumped whenever a frame's meaning changes. A mismatch is rejected at the
 *  frame boundary (see parseUpFrame/parseDownFrame) rather than tolerated:
 *  a half-understood uplink misbehaves later, in a place with no context. */
export const RELAY_PROTOCOL_VERSION = 2;

/** Applied as `maxPayload` on both the hub's browser-facing and uplink-facing
 *  sockets, and on the laptop's uplink. `ws` defaults to 100MB, which lets a
 *  peer push 100MB into JSON.parse before any gate runs (spec §10.2). The
 *  largest legitimate frame is a full event replay batch, which is orders of
 *  magnitude under this. */
export const MAX_FRAME_BYTES = 1_000_000;

/** The per-session facts a laptop declares and the hub assembles snapshots
 *  from (spec §3.2). Deliberately identical to `ProjectMessage.sessions[]`
 *  minus `presence` — `presence` is the one field only the hub can know, and
 *  keeping the rest identical means `sessionFactsOf` (Task 2) is the single
 *  producer for both the standalone snapshot path and the relay. */
export interface SessionFacts {
  id: string;
  participants: string[];
  driverName: string | null;
  intent: string | null;
  lastActivityTs: string | null;
  ended: boolean;
  pendingGate: PendingGate | null;
  skills: SkillInfo[];
  repoKey: string | null;
  lifecycle: Lifecycle;
}

/** One repo a machine offers (spec §5.1). `attached` is the whole point of the
 *  shape: a candidate is a repo this machine COULD work in — discovered by the
 *  launch-time scan, selectable in the UI — while an attached repo is one it
 *  currently CAN host sessions in. Only an attached repo has a workspace, which
 *  is why `defaultBranch` is null for a candidate: there is nothing to read it
 *  from yet, and inventing "main" would seed the create form with a branch the
 *  repo may not have.
 *
 *  On the wire as of v2, in `hello` and in the `repos` frame. Every bound
 *  below is enforced by `repoList` at the frame boundary, not trusted. */
export interface RepoDecl {
  key: string;
  label: string;
  attached: boolean;
  defaultBranch: string | null;
}

/** How many repos one machine may declare (spec §5.1). Enforced three times and
 *  never silently: here at the frame boundary, at launch by the scan that
 *  builds the list (`cli.ts`'s `finalizeCandidates`), and at `startServer`'s
 *  own construction (a direct-API caller bypasses both of those). Truncating
 *  instead would misrepresent the machine — the browser would offer a repo
 *  picker missing entries nobody can see are missing — and a set this large is
 *  a config error, not a big machine. Exported so `server.ts` enforces the
 *  identical number rather than a second magic constant that could drift. */
export const MAX_REPOS = 100;

/** Laptop → hub. */
export type UpFrame =
  /** `uplinkId` IS the machine id (spec §5.2), and `name` is what a person
   *  reads on the project screen. `repos` is everything this machine offers,
   *  attached and candidate alike — the picker needs both. */
  | { t: "hello"; v: number; uplinkId: string; name: string; projectId: string; repos: RepoDecl[] }
  /** The machine's repo set changed (an attach or detach landed). Always the
   *  FULL authoritative list, replacing the hub's record — never a diff. That
   *  is what makes a re-attach safe: the hub's record is only ever overwritten
   *  wholesale from the machine's own view, so there is no single-key rewrite
   *  path for the two to drift through. */
  | { t: "repos"; repos: RepoDecl[] }
  /** Events for ONE session, published once regardless of how many browsers are
   *  watching (spec §3.2). `runId` changes every time the laptop starts the
   *  session process, so the hub appends a new run instead of letting a
   *  restarted `seq` overwrite stored history. */
  | { t: "publish"; sessionId: string; runId: string; events: LoggedEvent[] }
  | { t: "facts"; sessionId: string; runId: string; facts: SessionFacts }
  /** A narrowcast reply to one tunnelled command, on the channel it arrived on. */
  | { t: "reply"; channelId: string; payload: unknown };

/** Hub → laptop. */
export type DownFrame =
  | { t: "welcome"; v: number; have: Record<string, { runId: string; lastSeq: number }> }
  /** `payload` is the ORIGINAL client message, untouched — the hub is a router
   *  here and nothing more (spec §3.2). `identity` is stamped by the hub;
   *  `channelId` is assigned by the hub and never accepted from a browser
   *  (spec §10.4), which is why it appears only on this side of the protocol. */
  | { t: "tunnel"; channelId: string; identity: { userId: string; name: string }; payload: unknown }
  /** This channel's browser is gone. The laptop tears down the connection,
   *  which runs the same leave path a closed direct socket runs — otherwise
   *  `presence_leave` never fires and the roster keeps a ghost forever. */
  | { t: "detach"; channelId: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function obj(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function str(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
}

/** Structural check only. The laptop still validates every tunnelled payload
 *  through its own handler exactly as it does for a direct socket — trusting
 *  the hub for identity does not mean trusting it for shape (spec §10.4). */
function isFacts(raw: unknown): raw is SessionFacts {
  const f = obj(raw);
  if (!f) return false;
  return (
    typeof f.id === "string" &&
    Array.isArray(f.participants) &&
    (f.driverName === null || typeof f.driverName === "string") &&
    (f.intent === null || typeof f.intent === "string") &&
    (f.lastActivityTs === null || typeof f.lastActivityTs === "string") &&
    typeof f.ended === "boolean" &&
    (f.pendingGate === null || typeof f.pendingGate === "object") &&
    Array.isArray(f.skills) &&
    (f.repoKey === null || typeof f.repoKey === "string") &&
    (f.lifecycle === "open" || f.lifecycle === "closed")
  );
}

/** The one validator for a declared repo set, shared by `hello` and `repos` so
 *  the two can never drift apart. Returns null — never a partial list — for
 *  anything out of bounds: a machine that declares one malformed entry has a
 *  bug or is not what it claims to be, and silently dropping the entry would
 *  leave the hub and the machine disagreeing about what is on offer, which is
 *  precisely the disagreement `attached` exists to prevent. */
function repoList(raw: unknown): RepoDecl[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_REPOS) return null;
  const out: RepoDecl[] = [];
  for (const item of raw) {
    const d = obj(item);
    if (!d) return null;
    if (typeof d.key !== "string" || d.key.length < 1 || d.key.length > 200) return null;
    if (typeof d.label !== "string" || d.label.length < 1 || d.label.length > 100) return null;
    if (typeof d.attached !== "boolean") return null;
    // Null is the ORDINARY case, not a fault: a candidate has no workspace to
    // read a branch from, and inventing "main" would seed the create form with
    // a branch the repo may not have.
    const branch = d.defaultBranch;
    if (branch !== null && (typeof branch !== "string" || branch.length > 100)) return null;
    out.push({ key: d.key, label: d.label, attached: d.attached, defaultBranch: branch });
  }
  return out;
}

/** Bounds a single `RepoDecl` to what `repoList` above accepts, so the ONE
 *  choke point that builds every outgoing decl (`server.ts`'s `repoDecls()`)
 *  can never produce a hello or `repos` frame this same file's own parser
 *  rejects. A laptop's real label/key/branch is not bounded anywhere upstream
 *  — a repo directory name, a git remote path, a branch name can all be
 *  arbitrarily long, and a root-path repo's basename can be empty — so this
 *  is the last line before the wire, not a redundant check.
 *
 *  Total: every input maps to SOME valid `RepoDecl`, never throws. An empty
 *  label (root-path repo) falls back to the key rather than shipping a decl
 *  `repoList` would itself reject on the receiving end. */
export function clampRepoDecl(d: RepoDecl): RepoDecl {
  const key = d.key.slice(0, 200);
  const label = d.label.slice(0, 100) || key.slice(0, 100) || "repo";
  const defaultBranch = d.defaultBranch === null ? null : d.defaultBranch.slice(0, 100);
  return { key, label, attached: d.attached, defaultBranch };
}

export function parseUpFrame(raw: unknown): UpFrame | null {
  const f = obj(raw);
  if (!f) return null;
  if (f.t === "hello") {
    if (f.v !== RELAY_PROTOCOL_VERSION) return null;
    const uplinkId = str(f.uplinkId, ID);
    const projectId = str(f.projectId, SLUG);
    // `name` is truncated rather than refused, matching the browser identity
    // the hub already stamps (hub.ts's identify/join both `slice(0, 40)`) —
    // an over-long machine name is a display problem, not a protocol fault.
    if (!uplinkId || !projectId || typeof f.name !== "string") return null;
    const repos = repoList(f.repos);
    if (!repos) return null;
    return {
      t: "hello",
      v: RELAY_PROTOCOL_VERSION,
      uplinkId,
      name: f.name.slice(0, 40),
      projectId,
      repos,
    };
  }
  if (f.t === "repos") {
    const repos = repoList(f.repos);
    return repos ? { t: "repos", repos } : null;
  }
  if (f.t === "publish") {
    const sessionId = str(f.sessionId, SLUG);
    const runId = str(f.runId, ID);
    if (!sessionId || !runId || !Array.isArray(f.events)) return null;
    return { t: "publish", sessionId, runId, events: f.events as LoggedEvent[] };
  }
  if (f.t === "facts") {
    const sessionId = str(f.sessionId, SLUG);
    const runId = str(f.runId, ID);
    if (!sessionId || !runId || !isFacts(f.facts)) return null;
    return { t: "facts", sessionId, runId, facts: f.facts };
  }
  if (f.t === "reply") {
    const channelId = str(f.channelId, ID);
    if (!channelId) return null;
    return { t: "reply", channelId, payload: f.payload };
  }
  return null;
}

export function parseDownFrame(raw: unknown): DownFrame | null {
  const f = obj(raw);
  if (!f) return null;
  if (f.t === "welcome") {
    if (f.v !== RELAY_PROTOCOL_VERSION) return null;
    const have = obj(f.have);
    if (!have) return null;
    const out: Record<string, { runId: string; lastSeq: number }> = {};
    for (const [sessionId, value] of Object.entries(have)) {
      const entry = obj(value);
      if (!str(sessionId, SLUG) || !entry) return null;
      const runId = str(entry.runId, ID);
      if (!runId || !Number.isInteger(entry.lastSeq) || (entry.lastSeq as number) < -1) return null;
      out[sessionId] = { runId, lastSeq: entry.lastSeq as number };
    }
    return { t: "welcome", v: RELAY_PROTOCOL_VERSION, have: out };
  }
  if (f.t === "tunnel") {
    const channelId = str(f.channelId, ID);
    const identity = obj(f.identity);
    if (!channelId || !identity) return null;
    if (typeof identity.userId !== "string" || typeof identity.name !== "string") return null;
    if (identity.userId.length === 0 || identity.userId.length > 64) return null;
    return {
      t: "tunnel",
      channelId,
      identity: { userId: identity.userId, name: identity.name.slice(0, 40) },
      payload: f.payload,
    };
  }
  if (f.t === "detach") {
    const channelId = str(f.channelId, ID);
    return channelId ? { t: "detach", channelId } : null;
  }
  return null;
}
