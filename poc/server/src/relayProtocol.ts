import type { LoggedEvent, SkillInfo } from "./events.js";
import type { PendingGate } from "./pendingGate.js";
import type { Lifecycle } from "./lifecycle.js";
/** `SLUG` is the canonical regex for session and project IDs; imported from
 *  `project.ts` to ensure the relay parser accepts exactly what `server.ts`
 *  enforces, keeping the shape in one place. */
import { SLUG } from "./project.js";
/** The two wire bounds for `touched`. Imported, never re-declared: `collisions.ts`
 *  is the single canonical home for both (it is the isomorphic module, so the
 *  browser and this parser agree on the same numbers by construction). */
import { GATE_REASON_CAP, PATH_WIRE_CAP, TOUCH_CAP } from "./collisions.js";

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
  /** Repo-relative paths this session's worktree has changed (spec §3.3), or
   *  null when it has never been measured — null and `[]` are different claims
   *  and the difference is load-bearing on the project screen.
   *
   *  ADDITIVE on the wire, which is why `RELAY_PROTOCOL_VERSION` is NOT bumped:
   *  the validator normalizes an absent field to null, so a v2 peer built before
   *  this field keeps validating unchanged.
   *
   *  EXPOSURE (spec §8a ruling 5 — accepted, do not re-litigate): this is a
   *  session's FULL changed-path list, and it rides the existing project push to
   *  ALL members of that project on every laptop, and is journaled hub-side under
   *  the journal's existing retention policy. Deliberately broader than the
   *  `contested` down-frame, which minimizes to intersecting paths only. Same
   *  exposure class as the record's `filesChanged`, swept together with v7b2
   *  auth (PRD §8.1): the bound is project membership, and it is now ENFORCED —
   *  `hub.ts`'s `isMember` gates `join`/`watch_project`/`peek`/`get_record` and
   *  the project-push fan-out this field rides on, not merely assumed. */
  touched: string[] | null;
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
  | { t: "detach"; channelId: string }
  /** The paths this session shares with OTHER sessions in its project, pushed
   *  whenever the hub's collision set for it changes (spec §6a as amended by
   *  §8a ruling 6). In hub mode a laptop cannot see other machines' sessions,
   *  so this frame is the only way `digestFor` and the gate can name a peer.
   *
   *  Keyed on `t`, like every other frame in both unions (owner ruling on spec
   *  §8a ruling 6, amended for consistency: the ruling's substance was the
   *  `collisions[]` payload, not the discriminator's name). One discriminator
   *  across the whole union is what lets a consumer switch on `frame.t` and get
   *  exhaustiveness from the compiler.
   *
   *  `RELAY_PROTOCOL_VERSION` is NOT bumped for it: a laptop built before the
   *  type existed drops the frame on the unknown-frame path (`parseDownFrame`
   *  returns null and `relay.ts`'s `onMessage` returns), so the uplink stays up
   *  and nothing surfaces — the same additive argument spec §3.3 makes for an
   *  optional field, extended to a whole frame type by exactly that ignore path.
   *
   *  `collisions` carries the colliding peers per path so the laptop can NAME
   *  them (spec §6); `sessionIds` excludes nothing, so the recipient's own id is
   *  present, matching `collisionsFrom`'s output shape. `paths` is the distinct
   *  path set of `collisions`, sorted, PLUS a trailing `TOUCH_SENTINEL` when the
   *  producer truncated — which is why the validator bounds the two lists
   *  independently instead of asserting one is derivable from the other: the
   *  over-cap frame is legitimate and a derivation check would reject it.
   *
   *  Thesis bound (§1.1): a session id, paths, and peer session ids. No
   *  transcript content, no prompts, no participant names. */
  | {
      t: "contested";
      sessionId: string;
      paths: string[];
      collisions: { path: string; sessionIds: string[] }[];
    };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function obj(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function str(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
}

/** C0 controls plus DEL. No legitimate repo-relative path carries one — git's
 *  own porcelain output escapes them — while a newline is exactly the character
 *  needed to forge a line boundary inside the agent's `<teammates>` block or a
 *  human-read gate reason, both of which render these strings verbatim. Bounding
 *  the CHARACTERS as well as the length is the untrusted-peer-strings rule.
 *
 *  EXPORTED as a source string, not as this RegExp: `digest.ts` strips the same
 *  class with a `/g` variant, and a shared `/g` instance carries `lastIndex`
 *  between calls, which would make the `.test` calls below answer differently on
 *  alternate invocations. One class, spelled once; each consumer owns its
 *  flags. */
export const CONTROL_CHARS_SOURCE = "[\\u0000-\\u001f\\u007f]";
const CONTROL_CHARS = new RegExp(CONTROL_CHARS_SOURCE);

/** `touched` on a facts frame (spec §3.3). Absent and null both yield null: the
 *  field is additive, so a peer that predates it must validate rather than be
 *  cut off, and normalizing here means no consumer downstream has to spell
 *  `?? null` again. Anything present-but-malformed returns `null` for the whole
 *  facts object, rejecting the frame exactly like every other malformed field —
 *  never a filtered subset, which would leave the two ends disagreeing about
 *  what this session touched. The two length bounds come from `collisions.ts`;
 *  `TOUCH_CAP + 1` admits the producer's own worst case, a full cap plus the
 *  "…and more" sentinel. */
function touchedList(raw: unknown): { ok: true; value: string[] | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const paths = pathList(raw);
  return paths ? { ok: true, value: paths } : { ok: false };
}

/** `pendingGate.reason` on a facts frame (spec §6b). Additive and OPTIONAL, the
 *  same posture as `touched`: absent and null both yield null, so a peer built
 *  before the field validates unchanged and no consumer downstream has to spell
 *  `?? null` again. A present-but-malformed reason rejects the WHOLE frame
 *  rather than being stripped — a gate applied without the line explaining it is
 *  a worse outcome than no frame, and partial application would leave the two
 *  ends disagreeing about what the gate says.
 *
 *  Bounded in characters as well as length for the same untrusted-peer-strings
 *  reason `CONTROL_CHARS` exists: this string is rendered verbatim in a
 *  human-read gate line, where a newline forges a line boundary. */
function gateReason(raw: unknown): { ok: true; value: PendingGate | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const g = obj(raw);
  if (!g) return { ok: false };
  const r = g.reason;
  if (r === undefined || r === null) {
    return { ok: true, value: { ...(g as unknown as PendingGate), reason: null } };
  }
  if (typeof r !== "string" || r.length > GATE_REASON_CAP || CONTROL_CHARS.test(r)) {
    return { ok: false };
  }
  // Spread rather than rebuild, matching `parseFacts`: unknown keys have always
  // ridden through this parser untouched, and only `reason` is normalized.
  return { ok: true, value: { ...(g as unknown as PendingGate), reason: r } };
}

/** The one bounded path-list check, shared by the facts frame's `touched` and
 *  the `contested` frame's `paths` so the two can never drift apart: both carry
 *  the same kind of untrusted repo-relative paths to the same consumers. Null
 *  for anything out of bounds — never a filtered subset, which would leave the
 *  two ends disagreeing about what is contested. `TOUCH_CAP + 1` admits the
 *  producer's own worst case, a full cap plus the "…and more" sentinel. */
function pathList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > TOUCH_CAP + 1) return null;
  for (const p of raw) {
    if (typeof p !== "string" || p.length > PATH_WIRE_CAP || CONTROL_CHARS.test(p)) return null;
  }
  return raw as string[];
}

/** The `contested` frame's per-path peer lists. Every id gets the SAME
 *  `str(id, SLUG)` treatment as the frame's own `sessionId` — these are session
 *  ids of one universe, and bounding them two different ways in one frame would
 *  be an internal contradiction. It also puts the 512-char gate-reason cap out
 *  of reach by construction: Task 8b renders `contested with session ${id}`,
 *  and SLUG admits at most 40 characters and no newline or control character.
 *
 *  Rejects the whole frame — never a partial list — on one bad entry, for the
 *  same reason `repoList` does: a hub that sends one malformed entry has a bug
 *  or is not what it claims to be, and a silently dropped peer would surface
 *  later as a gate that cannot say who it is contesting with. */
function collisionList(raw: unknown): { path: string; sessionIds: string[] }[] | null {
  if (!Array.isArray(raw) || raw.length > TOUCH_CAP + 1) return null;
  const out: { path: string; sessionIds: string[] }[] = [];
  for (const item of raw) {
    const c = obj(item);
    if (!c) return null;
    if (typeof c.path !== "string" || c.path.length > PATH_WIRE_CAP) return null;
    if (CONTROL_CHARS.test(c.path)) return null;
    // Non-empty: an entry naming a path with nobody to contest it with says
    // nothing a consumer can act on. 100 is the peer ceiling — one project's
    // sessions, the same order as `MAX_REPOS` above.
    if (!Array.isArray(c.sessionIds) || c.sessionIds.length < 1 || c.sessionIds.length > 100) {
      return null;
    }
    const sessionIds: string[] = [];
    for (const id of c.sessionIds) {
      const slug = str(id, SLUG);
      if (!slug) return null;
      sessionIds.push(slug);
    }
    out.push({ path: c.path, sessionIds });
  }
  return out;
}

/** Structural check only. The laptop still validates every tunnelled payload
 *  through its own handler exactly as it does for a direct socket — trusting
 *  the hub for identity does not mean trusting it for shape (spec §10.4).
 *
 *  Returns the facts rather than a boolean because `touched` is NORMALIZED (an
 *  absent field becomes null) and a type guard cannot rewrite what it guards. */
function parseFacts(raw: unknown): SessionFacts | null {
  const f = obj(raw);
  if (!f) return null;
  const structural =
    typeof f.id === "string" &&
    Array.isArray(f.participants) &&
    (f.driverName === null || typeof f.driverName === "string") &&
    (f.intent === null || typeof f.intent === "string") &&
    (f.lastActivityTs === null || typeof f.lastActivityTs === "string") &&
    typeof f.ended === "boolean" &&
    (f.pendingGate === null || typeof f.pendingGate === "object") &&
    Array.isArray(f.skills) &&
    (f.repoKey === null || typeof f.repoKey === "string") &&
    (f.lifecycle === "open" || f.lifecycle === "closed");
  if (!structural) return null;
  const touched = touchedList(f.touched);
  if (!touched.ok) return null;
  const gate = gateReason(f.pendingGate);
  if (!gate.ok) return null;
  // Spread rather than rebuild: unknown keys have always ridden through this
  // parser untouched (that is what makes a newer peer's extra field harmless to
  // an older one), and only `touched` and the gate's `reason` are rewritten.
  return {
    ...(f as unknown as SessionFacts),
    touched: touched.value,
    pendingGate: gate.value,
  };
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
    const facts = parseFacts(f.facts);
    if (!sessionId || !runId || !facts) return null;
    return { t: "facts", sessionId, runId, facts };
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
  if (f.t === "contested") {
    const sessionId = str(f.sessionId, SLUG);
    const paths = pathList(f.paths);
    const collisions = collisionList(f.collisions);
    // Rebuilt field by field rather than spread: unlike `facts`, nothing here is
    // meant to ride through unread, and the thesis bound (§1.1) is that this
    // frame carries a session id, paths and peer ids — nothing else.
    if (!sessionId || !paths || !collisions) return null;
    return { t: "contested", sessionId, paths, collisions };
  }
  return null;
}
