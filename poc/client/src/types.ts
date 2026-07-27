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
  skills?: { name: string; description: string }[];
};

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

export type RepoInfo = { defaultBranch: string };

export type OversightState = {
  enabled: boolean;
  latest: { text: string; ts: string; seq: number } | null;
};
