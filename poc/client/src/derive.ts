import { hashIdentity } from "./identity";
import type { LoggedEvent } from "./types";

export interface Participant {
  name: string;
  glyph: string;
  color: string;
}

export interface DerivedState {
  driverId: string | null;
  participants: Map<string, Participant>;
  objective: string | null;
  lastIntentSeq: number | null;
  permissionDecisions: Map<string, { decision: string; userId: string }>;
  model: string;
  agentBusy: boolean;
}

export function deriveState(events: LoggedEvent[]): DerivedState {
  const s: DerivedState = {
    driverId: null,
    participants: new Map(),
    objective: null,
    lastIntentSeq: null,
    permissionDecisions: new Map(),
    model: "opus",
    agentBusy: false,
  };
  for (const ev of events) {
    switch (ev.type) {
      case "presence_join":
        if (ev.userId && ev.name) {
          const fallback = hashIdentity(ev.userId);
          s.participants.set(ev.userId, {
            name: ev.name,
            glyph: ev.glyph ?? fallback.glyph,
            color: ev.color ?? fallback.color,
          });
        }
        break;
      case "presence_leave":
        if (ev.userId) s.participants.delete(ev.userId);
        break;
      case "control_change":
        if (ev.userId) s.driverId = ev.userId;
        break;
      case "intent_update":
        s.objective = ev.text ?? null;
        s.lastIntentSeq = ev.seq;
        break;
      case "permission_decision":
        if (ev.requestId && ev.decision && ev.userId)
          s.permissionDecisions.set(ev.requestId, {
            decision: ev.decision,
            userId: ev.userId,
          });
        break;
      case "model_change":
        if (ev.model) s.model = ev.model;
        break;
      case "user_message":
      case "tool_call":
      case "agent_text_delta":
        s.agentBusy = true;
        break;
      case "turn_end":
      case "agent_error":
        s.agentBusy = false;
        break;
    }
  }
  return s;
}
