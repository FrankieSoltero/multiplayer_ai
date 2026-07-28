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
export const RELAY_PROTOCOL_VERSION = 1;

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

/** Laptop → hub. */
export type UpFrame =
  | { t: "hello"; v: number; uplinkId: string; projectId: string; repoKey: string }
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

export function parseUpFrame(raw: unknown): UpFrame | null {
  const f = obj(raw);
  if (!f) return null;
  if (f.t === "hello") {
    if (f.v !== RELAY_PROTOCOL_VERSION) return null;
    const uplinkId = str(f.uplinkId, ID);
    const projectId = str(f.projectId, SLUG);
    if (!uplinkId || !projectId || typeof f.repoKey !== "string" || f.repoKey.length > 200) {
      return null;
    }
    return { t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId, projectId, repoKey: f.repoKey };
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
