import { socketUrlFor } from "./socketUrl";

export type LoggedEvent = {
  seq: number;
  ts: string;
  type: string;
  userId?: string;
  name?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
  message?: string;
  requestId?: string;
  decision?: string;
  model?: string;
  glyph?: string;
  color?: string;
  toolUseId?: string;
  parentToolUseId?: string;
  skills?: { name: string; description: string }[];
  suggestId?: string;
  skill?: string;
  args?: string;
  todos?: { text: string; status: string }[];
  plan?: string;
  mode?: string;
  auto?: boolean;
  /** Why this permission gate was opened, e.g. `contested with session alpha`
   *  (spec §6b). Optional so an event from an older server still parses. */
  reason?: string | null;
  game?: string;
  score?: number;
  action?: string;
  skillCount?: number;
  taskId?: string;
  subtype?: string;
  subagentType?: string;
  workflowName?: string;
  description?: string;
  status?: string;
  summary?: string;
  error?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastTool?: string;
  summarySeq?: number;
  inviteId?: string;
  expiresAt?: number;
  maxUses?: number;
};

export type InviteView = {
  id: string;
  token: string;
  sessionId: string;
  createdByName: string;
  expiresAt: number;
  uses: number;
  maxUses: number;
};

export type ProjectSessionInfo = {
  id: string;
  participants: string[];
  driverName: string | null;
  intent: string | null;
  lastActivityTs: string | null;
  ended: boolean;
  /** The oldest permission request nobody has answered, or null. Mirrors the
   *  server's ProjectMessage. Optional so a snapshot from an older server does
   *  not break the client. */
  pendingGate?: { toolName: string; sinceTs: string; reason?: string | null } | null;
  skills?: { name: string; description: string }[];
  /** Stable cross-machine repo identity. Optional so a snapshot from an older
   *  server does not break the client — same posture as pendingGate. */
  repoKey?: string | null;
  /** Which machine runs this session. Optional so a snapshot from a
   *  standalone server, which has exactly one machine and never sends it,
   *  still parses. */
  machineId?: string;
  /** Spec §3.4. Optional so an older server's snapshot still renders. */
  presence?: "online" | "offline";
  lifecycle?: "open" | "closed";
  /** Repo-relative paths this session has changed (spec §3.3). Optional so a
   *  snapshot from an older server still parses — same posture as `repoKey`. */
  touched?: string[] | null;
};

export type ProjectLifecycle = "active" | "closed" | "archived";

/** One repo a machine knows about: `attached` ones serve sessions, the rest
 *  are candidates a member can ATTACH. `defaultBranch` is only known for
 *  attached repos (spec §5.1), hence nullable. */
export type RepoDecl = { key: string; label: string; attached: boolean; defaultBranch: string | null };

export type MachineInfo = { machineId: string; name: string; repos: RepoDecl[]; online: boolean };

export type ProjectSummary = {
  id: string;
  name: string;
  lifecycle: ProjectLifecycle;
  /** The roster — REAL only when `isMember`; the hub redacts it to `[]` for a
   *  non-member (spec A5). Read membership through `isProjectMember` and the
   *  count through `projectMemberCount`, never off `.length` directly. */
  members: string[];
  /** True project size, sent even when `members` is redacted. Optional so an
   *  old server that doesn't send it still parses — `projectMemberCount` then
   *  falls back to `members.length`. */
  memberCount?: number;
  /** Whether the viewer belongs to this project. Optional so an old server
   *  that doesn't send it still parses — `isProjectMember` then falls back to
   *  scanning `members`. */
  isMember?: boolean;
  sessionCount: number;
  liveSessionCount: number;
  machines: MachineInfo[];
};

/** Membership of a project summary, redaction-safe (spec A5). Prefers the
 *  server's `isMember` flag; falls back to scanning the roster for an old
 *  server that doesn't send the flag. `??` (not `||`) so an explicit
 *  `isMember: false` is honoured rather than treated as absent. */
export function isProjectMember(project: ProjectSummary, userId: string): boolean {
  return project.isMember ?? project.members.includes(userId);
}

/** True member count, redaction-safe (spec A5): `memberCount` when present, so
 *  a redacted project still shows its real size; else the length of the
 *  (possibly redacted) roster for an old server. `??` so a real `0` stands. */
export function projectMemberCount(project: ProjectSummary): number {
  return project.memberCount ?? project.members.length;
}

export type ArcadeRecord = {
  game: string;
  score: number;
  userId: string;
  name: string;
  glyph?: string;
  color?: string;
};

export type PluginInfo = {
  name: string;
  url: string;
  skills: { name: string; description: string }[];
  addedBy: string;
};

/** In vite dev the server runs separately on 3001; in a built bundle the
 *  page is served BY the server (spec §5), so the socket targets the same
 *  host. The DEV short-circuit also keeps window untouched under vitest. */
export const SERVER_URL = import.meta.env.DEV
  ? "ws://localhost:3001"
  : socketUrlFor(window.location.protocol, window.location.host);

/** There is deliberately no API_BASE for /auth/*.
 *
 *  It used to mirror SERVER_URL (http://localhost:3001 under vite dev), which
 *  made `fetch("/auth/me", {credentials:"include"})` cross-origin. The server
 *  sends no CORS headers — A2a avoids CORS on purpose — so the fetch rejected,
 *  landed in App.tsx's `.catch(() => anonymous)`, and the client silently
 *  concluded auth was OFF: it rendered the pre-auth flow and the join was then
 *  refused with "authentication required". The whole auth UI was untestable
 *  under `vite dev`.
 *
 *  Every /auth/* URL is now same-origin and relative — served by the server in
 *  a built bundle, forwarded by the `/auth` proxy in vite.config.ts in dev.
 *  One convention, no CORS, and cookies work in both. */

export type OversightState = {
  enabled: boolean;
  latest: { text: string; ts: string; seq: number } | null;
};
