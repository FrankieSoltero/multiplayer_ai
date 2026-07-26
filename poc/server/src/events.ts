export interface SkillInfo {
  name: string;
  description: string;
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export const ARCADE_GAMES = ["dino", "snake", "typerace"] as const;
export type ArcadeGame = (typeof ARCADE_GAMES)[number];

export type SessionEvent =
  | { type: "user_message"; userId: string; text: string }
  | { type: "agent_text_delta"; text: string; parentToolUseId?: string }
  | { type: "tool_call"; toolName: string; input: unknown; toolUseId?: string; parentToolUseId?: string }
  | { type: "tool_result"; toolName: string; output: string; toolUseId?: string; parentToolUseId?: string }
  | { type: "control_change"; userId: string }
  | { type: "presence_join"; userId: string; name: string; glyph?: string; color?: string }
  | { type: "presence_leave"; userId: string }
  | { type: "agent_error"; message: string }
  | { type: "intent_update"; text: string }
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown }
  | { type: "permission_decision"; requestId: string; decision: "allow" | "deny"; userId: string; auto?: true }
  | { type: "model_change"; model: string; userId: string }
  | { type: "turn_end" }
  | { type: "skill_roster"; skills: SkillInfo[] }
  | { type: "skill_suggest"; suggestId: string; userId: string; skill: string; args: string }
  | { type: "skill_decision"; suggestId: string; decision: "run" | "dismiss"; userId: string }
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "plan_request"; requestId: string; plan: string }
  | { type: "plan_decision"; requestId: string; decision: "approve" | "reject"; userId: string }
  | { type: "permission_mode_change"; mode: "plan" | "default" | "auto"; userId: string }
  | { type: "game_score"; userId: string; game: ArcadeGame; score: number }
  | { type: "plugin_change"; action: "add" | "remove"; name: string; skillCount: number; userId: string };

export type LoggedEvent = SessionEvent & { seq: number; ts: string };
