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
  permissionDecisions: Map<string, { decision: string; userId: string; auto?: boolean }>;
  model: string;
  agentBusy: boolean;
  skills: { name: string; description: string }[];
  todos: { text: string; status: string }[];
  suggestDecisions: Map<string, { decision: string; userId: string }>;
  planDecisions: Map<string, { decision: string; userId: string }>;
  permissionMode: string;
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
    skills: [],
    todos: [],
    suggestDecisions: new Map(),
    planDecisions: new Map(),
    permissionMode: "default",
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
            ...(ev.auto ? { auto: true } : {}),
          });
        break;
      case "model_change":
        if (ev.model) s.model = ev.model;
        break;
      case "skill_roster":
        s.skills = ev.skills ?? [];
        break;
      case "todo_update":
        s.todos = ev.todos ?? [];
        break;
      case "skill_decision":
        if (ev.suggestId && ev.decision && ev.userId)
          s.suggestDecisions.set(ev.suggestId, { decision: ev.decision, userId: ev.userId });
        break;
      case "plan_decision":
        if (ev.requestId && ev.decision && ev.userId)
          s.planDecisions.set(ev.requestId, { decision: ev.decision, userId: ev.userId });
        break;
      case "permission_mode_change":
        s.permissionMode = ev.mode ?? "default";
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

export type TranscriptGroup =
  | { kind: "main"; events: LoggedEvent[] }
  | {
      kind: "subagent";
      parentId: string;
      label: string;
      status: "running" | "done";
      events: LoggedEvent[];
    };

/**
 * Split the flat event log into consecutive main/subagent runs for nested
 * rendering. A subagent is keyed by the tool_use id of its spawning Task/Agent
 * call (the SDK's subagent-spawning tool is named `Agent`, not `Task`, in the
 * installed live SDK — verified 2026-07-25; both names are accepted); its
 * label comes from that call's input.description, its status flips to done
 * when the parent-level Task/Agent tool_result for that id appears. Orphan
 * parent ids (spawning call not in view) get a generic label — replay always
 * includes the spawn, but a malformed stream must degrade, not crash.
 */
export function deriveTranscriptGroups(events: LoggedEvent[]): TranscriptGroup[] {
  const labels = new Map<string, string>();
  const done = new Set<string>();
  for (const ev of events) {
    if (
      ev.type === "tool_call" &&
      (ev.toolName === "Task" || ev.toolName === "Agent") &&
      ev.toolUseId &&
      !ev.parentToolUseId
    ) {
      const desc = (ev.input as { description?: unknown } | undefined)?.description;
      labels.set(ev.toolUseId, typeof desc === "string" && desc ? desc : "subagent");
    }
    if (ev.type === "tool_result" && ev.toolUseId && !ev.parentToolUseId && labels.has(ev.toolUseId)) {
      done.add(ev.toolUseId);
    }
  }
  const groups: TranscriptGroup[] = [];
  for (const ev of events) {
    const parentId = ev.parentToolUseId;
    const last = groups.at(-1);
    if (parentId) {
      if (last?.kind === "subagent" && last.parentId === parentId) {
        last.events.push(ev);
      } else {
        groups.push({
          kind: "subagent",
          parentId,
          label: labels.get(parentId) ?? "subagent",
          status: done.has(parentId) ? "done" : "running",
          events: [ev],
        });
      }
    } else {
      if (last?.kind === "main") {
        last.events.push(ev);
      } else {
        groups.push({ kind: "main", events: [ev] });
      }
    }
  }
  return groups;
}
