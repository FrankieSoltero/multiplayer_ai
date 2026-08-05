import { hashIdentity } from "./identity";
import { notRemoved } from "./slashMatch";
import type { LoggedEvent } from "./types";

export interface Participant {
  name: string;
  glyph: string;
  color: string;
}

export interface TaskInfo {
  id: string;
  description: string;
  subagentType?: string;
  workflowName?: string;
  status: string; // "running" until updated/done says otherwise; unknown statuses kept verbatim
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastTool?: string;
  summary?: string;
  error?: string;
  stoppedBy?: string;
}

export interface AgentStatusInfo {
  status: string; // "compacting" | "requesting" | "retrying" | "refusal_fallback" (never "idle" — idle clears)
  attempt?: number;
  maxRetries?: number;
  detail?: string;
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
  tasks: Map<string, TaskInfo>;
  /** Latest agent_status signal (agent-surface §3/§4); null when idle or after
   *  a turn boundary. undefined-fields stay undefined. */
  agentStatus: AgentStatusInfo | null;
  /** Latest turn_end's duration_ms, when the payload carried it (§1). */
  lastTurnDurationMs?: number;
  /** Prompt-side context footprint of the latest turn_end's `usage`
   *  (input + cache read + cache creation — the tokens that occupy the
   *  window; output tokens do not). undefined until a turn reports usage. */
  contextUsed?: number;
  /** Context window size from the latest turn_end's `modelUsage`, when any
   *  model entry carried `contextWindow`. */
  contextMax?: number;
  /** Running session totals over turn_end payloads (§1) — undefined until at
   *  least one turn_end carried the field, so an old log derives exactly as
   *  before (undefined, never 0). */
  sessionCostUsd?: number;
  sessionTokens?: number;
}

/** Total tokens a turn consumed: the `usage` total when present (it is the
 *  authoritative per-turn count), else the sum across `modelUsage` entries,
 *  else undefined — a turn with neither contributes nothing to the session
 *  total rather than a fabricated 0. */
function turnTokens(ev: LoggedEvent): number | undefined {
  const u = ev.usage;
  if (u) {
    return (
      (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0)
    );
  }
  if (ev.modelUsage) {
    let total = 0;
    let seen = false;
    for (const m of Object.values(ev.modelUsage)) {
      total +=
        (m.inputTokens ?? 0) + (m.outputTokens ?? 0) +
        (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
      seen = true;
    }
    if (seen) return total;
  }
  return undefined;
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
    tasks: new Map(),
    agentStatus: null,
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
        s.skills = (ev.skills ?? []).filter(notRemoved);
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
      case "task_event": {
        if (!ev.taskId) break;
        let t = s.tasks.get(ev.taskId);
        if (!t) {
          t = { id: ev.taskId, description: "", status: "running" };
          s.tasks.set(ev.taskId, t);
        }
        if (ev.description) t.description = ev.description;
        if (ev.subagentType) t.subagentType = ev.subagentType;
        if (ev.workflowName) t.workflowName = ev.workflowName;
        if (ev.status) t.status = ev.status;
        if (ev.subtype === "done" && !ev.status) t.status = "completed";
        if (ev.summary) t.summary = ev.summary;
        if (ev.error) t.error = ev.error;
        if (ev.tokens !== undefined) t.tokens = ev.tokens;
        if (ev.toolUses !== undefined) t.toolUses = ev.toolUses;
        if (ev.durationMs !== undefined) t.durationMs = ev.durationMs;
        if (ev.lastTool) t.lastTool = ev.lastTool;
        break;
      }
      case "task_stop": {
        if (!ev.taskId || !ev.userId) break;
        let t = s.tasks.get(ev.taskId);
        if (!t) {
          t = { id: ev.taskId, description: "", status: "running" };
          s.tasks.set(ev.taskId, t);
        }
        t.stoppedBy = ev.userId;
        break;
      }
      case "user_message":
      case "tool_call":
      case "agent_text_delta":
        s.agentBusy = true;
        break;
      case "turn_end": {
        s.agentBusy = false;
        // A finished turn supersedes any in-flight status signal.
        s.agentStatus = null;
        if (ev.duration_ms !== undefined) s.lastTurnDurationMs = ev.duration_ms;
        if (ev.usage) {
          const u = ev.usage;
          s.contextUsed =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
        }
        if (ev.modelUsage) {
          for (const m of Object.values(ev.modelUsage)) {
            if (m.contextWindow !== undefined) {
              s.contextMax = m.contextWindow;
              break;
            }
          }
        }
        if (ev.total_cost_usd !== undefined)
          s.sessionCostUsd = (s.sessionCostUsd ?? 0) + ev.total_cost_usd;
        const tokens = turnTokens(ev);
        if (tokens !== undefined) s.sessionTokens = (s.sessionTokens ?? 0) + tokens;
        break;
      }
      case "agent_error":
        s.agentBusy = false;
        break;
      case "agent_status":
        // "idle" (or a status-less event from a mid-upgrade server) clears;
        // everything else replaces the signal whole.
        if (!ev.status || ev.status === "idle") {
          s.agentStatus = null;
        } else {
          const info: AgentStatusInfo = { status: ev.status };
          if (ev.attempt !== undefined) info.attempt = ev.attempt;
          if (ev.maxRetries !== undefined) info.maxRetries = ev.maxRetries;
          if (ev.detail !== undefined) info.detail = ev.detail;
          s.agentStatus = info;
        }
        break;
    }
  }
  return s;
}

export interface SubSessionInfo {
  key: string; // spawning Task/Agent tool_use id
  label: string; // input.description ?? subagentType ?? key
  status: "running" | "done";
  gatePending: boolean; // undecided permission_request attributed to key
  taskId?: string; // joined via task_event started.toolUseId === key
}

/**
 * Summarise the sub-sessions present in a flat event log (spec §2.1/§2.5).
 * A sub-session is keyed by the tool_use id of its spawning top-level
 * Task/Agent call (`Agent` in the live SDK, `Task` accepted too — mirrors
 * `deriveTranscriptGroups`). Any event carrying a `parentToolUseId` also
 * surfaces that key: a heartbeat-only stream whose spawning call never
 * arrived still lists (degraded label, running), never dropped. Attribution
 * is display metadata — a log with none of the new fields derives to `[]`
 * and leaves existing derives untouched. Pure filter over `events`; nothing
 * here is not already in the shared log every participant holds (constraint 5).
 */
export function deriveSubSessions(events: LoggedEvent[]): SubSessionInfo[] {
  const order: string[] = [];
  const register = (key: string) => {
    if (!order.includes(key)) order.push(key);
  };

  const descriptions = new Map<string, string>(); // key -> spawning input.description
  const subagentTypes = new Map<string, string>(); // key -> joined task_event subagentType
  const taskIds = new Map<string, string>(); // key -> joined taskId
  const done = new Set<string>(); // keys whose top-level tool_result arrived
  const requestKey = new Map<string, string>(); // permission requestId -> attributed key
  const decided = new Set<string>(); // permission requestIds with a decision

  for (const ev of events) {
    if (
      ev.type === "tool_call" &&
      (ev.toolName === "Task" || ev.toolName === "Agent") &&
      ev.toolUseId &&
      !ev.parentToolUseId
    ) {
      register(ev.toolUseId);
      const desc = (ev.input as { description?: unknown } | undefined)?.description;
      if (typeof desc === "string" && desc) descriptions.set(ev.toolUseId, desc);
    }
    if (ev.type === "tool_result" && ev.toolUseId && !ev.parentToolUseId) {
      done.add(ev.toolUseId);
    }
    if (ev.type === "task_event" && ev.subtype === "started" && ev.toolUseId) {
      register(ev.toolUseId);
      if (ev.taskId) taskIds.set(ev.toolUseId, ev.taskId);
      if (ev.subagentType) subagentTypes.set(ev.toolUseId, ev.subagentType);
    }
    if (ev.parentToolUseId) register(ev.parentToolUseId);
    if (ev.type === "permission_request" && ev.parentToolUseId && ev.requestId) {
      requestKey.set(ev.requestId, ev.parentToolUseId);
    }
    if (ev.type === "permission_decision" && ev.requestId) {
      decided.add(ev.requestId);
    }
  }

  const gatePending = new Set<string>();
  for (const [requestId, key] of requestKey) {
    if (!decided.has(requestId)) gatePending.add(key);
  }

  return order.map((key) => {
    const info: SubSessionInfo = {
      key,
      label: descriptions.get(key) ?? subagentTypes.get(key) ?? key,
      status: done.has(key) ? "done" : "running",
      gatePending: gatePending.has(key),
    };
    const taskId = taskIds.get(key);
    if (taskId !== undefined) info.taskId = taskId;
    return info;
  });
}

/**
 * Project the flat log down to one sub-session's view (spec §2.3): every
 * event attributed to `key` via `parentToolUseId` (streaming AND attributed
 * gate events), plus the joined task's `task_event`/`task_stop` rows when the
 * sub-session has a `taskId`, all in log (seq) order. Main-agent events, other
 * sub-sessions' events, and unattributed gates are excluded. A pure filter —
 * projection is display filtering, never access control (constraint 5).
 */
export function subSessionEvents(events: LoggedEvent[], key: string): LoggedEvent[] {
  let taskId: string | undefined;
  for (const ev of events) {
    if (ev.type === "task_event" && ev.subtype === "started" && ev.toolUseId === key && ev.taskId) {
      taskId = ev.taskId;
      break;
    }
  }
  return events.filter((ev) => {
    if (ev.parentToolUseId === key) return true;
    if (
      taskId !== undefined &&
      (ev.type === "task_event" || ev.type === "task_stop") &&
      ev.taskId === taskId
    ) {
      return true;
    }
    return false;
  });
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
    // Gate events (permission_request/permission_decision) are excluded from
    // the subagent sweep ALWAYS, even when Task 1 attributes them with a
    // parentToolUseId — they render inline in the gate surface in EVERY view,
    // MAIN included (spec §2.3). Sweeping them into the collapsed subagent
    // group would hide the gate card (no tool name, no controls) from a driver
    // on MAIN. They stay projected into the sub-session view separately, via
    // subSessionEvents (a different, unchanged filter).
    const isGate =
      ev.type === "permission_request" || ev.type === "permission_decision";
    const parentId = isGate ? undefined : ev.parentToolUseId;
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
