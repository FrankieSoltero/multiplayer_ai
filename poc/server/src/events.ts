import type { ModelRosterEntry } from "./models.js";

export interface SkillInfo {
  name: string;
  description: string;
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** Turn-level token usage carried on `turn_end` (agent-surface §1). Field
 *  names mirror the SDK result's `usage` (sdk.d.ts NonNullableUsage)
 *  verbatim — the record is a faithful passthrough, not a rename. All
 *  optional: events logged before this payload existed carry none of it. */
export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Per-model usage breakdown carried on `turn_end` (agent-surface §1),
 *  mirrored from the SDK result's `modelUsage` values (sdk.d.ts ModelUsage).
 *  All optional: partial results may omit any field. */
export interface ModelUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
}

export const ARCADE_GAMES = ["dino", "snake", "tetris", "doodlejump"] as const;
export type ArcadeGame = (typeof ARCADE_GAMES)[number];

export type SessionEvent =
  | { type: "user_message"; userId: string; text: string }
  /** `supersedes`/`aborted` (agent-surface §3): additive refusal-fallback
   *  signals from the assistant frame this delta came from (sdk.d.ts:2848,
   *  2852). `supersedes` means the frame replaced earlier refused content —
   *  the client may mark prior deltas retracted; `aborted` means the frame
   *  was truncated by an interrupt. Both absent on ordinary deltas. */
  | { type: "agent_text_delta"; text: string; parentToolUseId?: string; supersedes?: true; aborted?: true }
  | { type: "tool_call"; toolName: string; input: unknown; toolUseId?: string; parentToolUseId?: string }
  | { type: "tool_result"; toolName: string; output: string; toolUseId?: string; parentToolUseId?: string }
  | { type: "control_change"; userId: string }
  | { type: "presence_join"; userId: string; name: string; glyph?: string; color?: string }
  | { type: "presence_leave"; userId: string }
  | { type: "agent_error"; message: string }
  | { type: "intent_update"; text: string }
  /** `reason` names WHY this gate is worth someone's attention (spec §6b) — e.g.
   *  `contested with session alpha`. OPTIONAL and additive: absent is an
   *  ordinary gate, which is every gate today. It rides on the event rather than
   *  on `SessionFacts.pendingGate` alone because the event is what the client
   *  replays and renders (`Transcript.tsx`'s `case "permission_request"`);
   *  `pendingGateOf` derives `PendingGate.reason` from this same field, so there
   *  is one source behind both surfaces. */
  /** Gate enrichment text (§8.6 cycle 2, plan §1.1): the SDK's own rendering of
   *  WHY this call asks — `title` (the bridge's full prompt sentence),
   *  `displayName` (short action phrase), `description` (subtitle),
   *  `decisionReason`, `blockedPath`, and `matchedAskRule` (the user-configured
   *  ask rule that forced the prompt: source + optional ruleContent). All
   *  OPTIONAL and additive, passed through verbatim from canUseTool's options
   *  (sdk.d.ts:206-266); absent when the SDK provides nothing.
   *  `ruleSuggestion` is the compact display form of the first addRules
   *  suggestion (e.g. `Bash(npm test:*)`), derived SERVER-SIDE at gate
   *  creation — the client never re-derives it, and its presence is exactly
   *  what makes an ALWAYS answer possible for this gate. */
  | { type: "permission_request"; requestId: string; toolName: string; input: unknown; reason?: string; parentToolUseId?: string;
      title?: string; displayName?: string; description?: string; decisionReason?: string; blockedPath?: string;
      matchedAskRule?: { source: string; ruleContent?: string }; ruleSuggestion?: string }
  /** `decision: "always"` (§8.6 cycle 2) is a standing approval: the driver
   *  accepted the SDK's suggested rule session-scoped. `rule` carries the
   *  display form (the request's `ruleSuggestion`) — decider + rule + timestamp
   *  are the record of the standing approval (plan §0.3, D11). Only present on
   *  "always". */
  | { type: "permission_decision"; requestId: string; decision: "allow" | "deny" | "always"; userId: string; auto?: true; parentToolUseId?: string; rule?: string }
  | { type: "model_change"; model: string; userId: string }
  /** Turn boundary (agent-surface §1–§3). All fields optional and additive:
   *  events logged before this payload existed are the bare `{type}` shape.
   *  `outcome` distinguishes the three ways a turn can end — "success",
   *  "interrupted" (a driver stop_turn landed; §2), "error" (SDKResultError;
   *  §3) — so an error turn is distinguishable from success IN THE LOG.
   *  Usage/cost names mirror the SDK result verbatim (sdk.d.ts:4261-4290).
   *  `errorSubtype`/`errorReason` are present only when outcome is "error":
   *  the SDK's result subtype (error_max_turns, error_max_budget_usd,
   *  error_during_execution, error_max_structured_output_retries) and a
   *  human reason (terminal_reason ?? first errors[] entry ?? subtype). */
  | { type: "turn_end";
      outcome?: "success" | "interrupted" | "error";
      total_cost_usd?: number;
      usage?: TurnUsage;
      modelUsage?: Record<string, ModelUsageInfo>;
      duration_ms?: number;
      num_turns?: number;
      errorSubtype?: string;
      errorReason?: string }
  /** A driver asked to interrupt the running turn (agent-surface §2). The
   *  attributed request lands on the wire BEFORE Query.interrupt() is
   *  called — the request is a fact even if the turn finishes first. */
  | { type: "turn_stop"; userId: string }
  /** Rate-limit info from the SDK's rate_limit_event (sdk.d.ts:4207),
   *  throttled to at most one event per 30s per session (agent-surface §1). */
  | { type: "rate_limit"; status: string; rateLimitType?: string; utilization?: number; resetsAt?: number }
  /** Agent busy-state and retry signals (agent-surface §3/§4).
   *  "compacting"/"requesting" come from system/status (sdk.d.ts:4369);
   *  "idle" is system/status with status null (busy cleared); "retrying" is
   *  system/api_retry (sdk.d.ts:2821) and carries the retry counters;
   *  "refusal_fallback" is system/model_refusal_fallback (sdk.d.ts:4060)
   *  with the SDK's notice text in `detail`. */
  | { type: "agent_status";
      status: "compacting" | "requesting" | "idle" | "retrying" | "refusal_fallback";
      attempt?: number; maxRetries?: number; retryDelayMs?: number;
      errorStatus?: number | null; detail?: string }
  /** A compaction boundary in the transcript (system/compact_boundary,
   *  sdk.d.ts:2922; agent-surface §4). preTokens is the context size before
   *  compaction; postTokens is absent until the compacted size is known. */
  | { type: "compaction"; trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number }
  | { type: "skill_roster"; skills: SkillInfo[];
      /** Additive (local-models plan §1.2): the session's selectable-model
       *  roster, straight from the registry. The picker reads it instead of
       *  hardcoding labels; events logged before it existed carry none. */
      models?: ModelRosterEntry[] }
  | { type: "skill_suggest"; suggestId: string; userId: string; skill: string; args: string }
  | { type: "skill_decision"; suggestId: string; decision: "run" | "dismiss"; userId: string }
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "plan_request"; requestId: string; plan: string }
  | { type: "plan_decision"; requestId: string; decision: "approve" | "reject"; userId: string }
  | { type: "permission_mode_change"; mode: "plan" | "default" | "auto"; userId: string }
  | { type: "game_score"; userId: string; game: ArcadeGame; score: number }
  | { type: "plugin_change"; action: "add" | "remove"; name: string; skillCount: number; userId: string }
  | { type: "task_event"; taskId: string;
      subtype: "started" | "progress" | "updated" | "done";
      /** The `tool_use_id` of the Task tool call that spawned this sub-session,
       *  populated ONLY on `subtype: "started"` (§2.1 task join). Display
       *  metadata: absent leaves the started event byte-identical to today. */
      toolUseId?: string;
      description?: string; subagentType?: string; workflowName?: string;
      status?: string; summary?: string; error?: string;
      tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string;
      /** Path to the subagent's full transcript file (task_notification's
       *  output_file, sdk.d.ts:4430). Present only on `subtype: "done"`. */
      outputFile?: string }
  | { type: "task_stop"; taskId: string; userId: string }
  | { type: "oversight_pull"; userId: string; summarySeq: number }
  | { type: "invite_created"; userId: string; inviteId: string; expiresAt: number; maxUses: number }
  | { type: "invite_revoked"; userId: string; inviteId: string }
  | { type: "invite_redeemed"; userId: string; inviteId: string }
  | { type: "session_closed"; userId: string };

export type LoggedEvent = SessionEvent & { seq: number; ts: string };
