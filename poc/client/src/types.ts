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

export const SERVER_URL = "ws://localhost:3001";
