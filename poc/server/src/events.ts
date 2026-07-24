export type SessionEvent =
  | { type: "user_message"; userId: string; text: string }
  | { type: "agent_text_delta"; text: string }
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; output: string }
  | { type: "control_change"; userId: string }
  | { type: "presence_join"; userId: string; name: string }
  | { type: "presence_leave"; userId: string }
  | { type: "agent_error"; message: string }
  | { type: "intent_update"; text: string };

export type LoggedEvent = SessionEvent & { seq: number; ts: string };
