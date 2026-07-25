export const MODELS = {
  opus: { id: "claude-opus-4-8", label: "opus 4.8" },
  sonnet: { id: "claude-sonnet-5", label: "sonnet 5" },
  haiku: { id: "claude-haiku-4-5-20251001", label: "haiku 4.5" },
} as const;

export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelKey = "opus";

export function isModelKey(v: unknown): v is ModelKey {
  return typeof v === "string" && Object.hasOwn(MODELS, v);
}
