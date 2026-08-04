/** The model registry — the SINGLE source for every selectable model
 *  (local-models plan §1.1). `set_model` validation, the client roster, and
 *  labels all derive from this module; nothing else in src may hardcode the
 *  Claude trio (pinned by test/models.test.ts).
 *
 *  `id` is the routing key the LiteLLM proxy sees. The three Claude ids are
 *  BYTE-IDENTICAL pass-through ids (`claude-*` routes to Anthropic) — change
 *  one and cloud routing breaks. Local entries are never hardcoded here:
 *  operators add them through MPAI_EXTRA_MODELS (see parseExtraModels), keyed
 *  by their id (e.g. "qwen3-32b"). */
export interface ModelEntry {
  id: string;
  label: string;
  contextWindow: number;
  /** Local backends report no cost/rate-limit; the picker marks them. */
  local?: boolean;
  /** Honest degradation note, surfaced where the model is picked. */
  degradedNote?: string;
}

/** The roster slice carried on the skill_roster frame (additive `models`
 *  field). `key` is the wire-level set_model/model_change key — the client
 *  sends it back verbatim; `id` is what the proxy routes on. */
export interface ModelRosterEntry {
  key: string;
  id: string;
  label: string;
  local?: boolean;
  degradedNote?: string;
}

const BUILTIN_MODELS: Record<string, ModelEntry> = {
  opus: { id: "claude-opus-4-8", label: "opus 4.8", contextWindow: 200000 },
  sonnet: { id: "claude-sonnet-5", label: "sonnet 5", contextWindow: 200000 },
  haiku: { id: "claude-haiku-4-5-20251001", label: "haiku 4.5", contextWindow: 200000 },
};

/** Parse MPAI_EXTRA_MODELS (JSON array of ModelEntry-shaped objects, e.g.
 *  [{"id":"qwen3-32b","label":"QWEN3 32B (LOCAL)","contextWindow":32768,
 *   "local":true,"degradedNote":"local model — no cost/rate-limit reporting;
 *   gates may be noisier"}]). Each entry is keyed by its id. Anything malformed
 *  — bad JSON, a non-array, an entry missing id/label/contextWindow, a key
 *  colliding with a built-in or an earlier extra — warns and is SKIPPED;
 *  operator config must never crash boot. Exported so tests can drive it
 *  without process.env; module load wires it to the real env var. */
export function parseExtraModels(
  json: string | undefined,
  warn: (message: string) => void,
): Record<string, ModelEntry> {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    warn(`MPAI_EXTRA_MODELS is not valid JSON — ignoring (${err instanceof Error ? err.message : String(err)})`);
    return {};
  }
  if (!Array.isArray(parsed)) {
    warn("MPAI_EXTRA_MODELS must be a JSON array — ignoring");
    return {};
  }
  const extra: Record<string, ModelEntry> = {};
  for (const raw of parsed) {
    const e = raw as Partial<ModelEntry> | null;
    if (
      !e ||
      typeof e.id !== "string" ||
      e.id.length === 0 ||
      typeof e.label !== "string" ||
      typeof e.contextWindow !== "number" ||
      !Number.isFinite(e.contextWindow)
    ) {
      warn(`MPAI_EXTRA_MODELS entry skipped — needs string id, string label, numeric contextWindow: ${JSON.stringify(raw)}`);
      continue;
    }
    if (e.local !== undefined && typeof e.local !== "boolean") {
      warn(`MPAI_EXTRA_MODELS entry "${e.id}" skipped — local must be a boolean`);
      continue;
    }
    if (e.degradedNote !== undefined && typeof e.degradedNote !== "string") {
      warn(`MPAI_EXTRA_MODELS entry "${e.id}" skipped — degradedNote must be a string`);
      continue;
    }
    // An extra may never shadow a built-in or an earlier extra: silently
    // re-keying "opus" would reroute cloud traffic.
    if (Object.hasOwn(BUILTIN_MODELS, e.id) || Object.hasOwn(extra, e.id)) {
      warn(`MPAI_EXTRA_MODELS entry "${e.id}" skipped — key already registered`);
      continue;
    }
    const entry: ModelEntry = { id: e.id, label: e.label, contextWindow: e.contextWindow };
    if (e.local) entry.local = true;
    if (e.degradedNote !== undefined) entry.degradedNote = e.degradedNote;
    extra[e.id] = entry;
  }
  return extra;
}

export const MODELS: Record<string, ModelEntry> = {
  ...BUILTIN_MODELS,
  ...parseExtraModels(process.env.MPAI_EXTRA_MODELS, (msg) =>
    console.warn(`[models] ${msg}`),
  ),
};

export type ModelKey = string;
export const DEFAULT_MODEL: ModelKey = "opus";

export function isModelKey(v: unknown): v is ModelKey {
  return typeof v === "string" && Object.hasOwn(MODELS, v);
}

/** The additive `models` roster on the skill_roster frame — one entry per
 *  registered model, in registration order (Claude trio first). Optional
 *  fields are omitted, not nulled: old clients ignore the field entirely. */
export function modelRoster(): ModelRosterEntry[] {
  return Object.entries(MODELS).map(([key, m]) => {
    const entry: ModelRosterEntry = { key, id: m.id, label: m.label };
    if (m.local) entry.local = true;
    if (m.degradedNote !== undefined) entry.degradedNote = m.degradedNote;
    return entry;
  });
}
