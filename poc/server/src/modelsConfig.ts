/** Persisted per-machine model registry (spec §2.1) + credential detection and
 *  default-model fallback (spec §2.4), with the §2.5 hardening guards enforced
 *  at registration.
 *
 *  The store is `$MPAI_HOME/models.json` — a JSON array of ModelEntry, each
 *  keyed on load by its `id` (persisted elements carry no separate `key`
 *  field). The exported mutable `MODELS` record (models.ts) is MUTATED IN PLACE
 *  here — never reassigned — so every `import { MODELS }` keeps a live view.
 *
 *  Load order & precedence: builtins → models.json → MPAI_EXTRA_MODELS. All
 *  validation warns-and-skips; operator config must never crash boot. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mpaiHome } from "./machineIdentity.js";
import {
  BUILTIN_MODELS,
  MODELS,
  parseExtraModels,
  DEFAULT_MODEL,
  type ModelEntry,
  type ModelKey,
} from "./models.js";

/** A registry entry plus its wire key and built-in flag — the shape the
 *  models panel / list_models surface consumes. */
export interface ManagedModelEntry extends ModelEntry {
  key: string;
  builtin?: true;
}

const NO_CREDS_NOTE = "no Anthropic credentials — set ANTHROPIC_API_KEY or add a local model";

/** Env var names the daemon itself relies on — `apiKeyEnv` may never name one,
 *  or a member could forward a real secret to a hostile endpoint (spec §2.5.1). */
const RESERVED_API_KEY_ENVS = new Set([
  "ANTHROPIC_API_KEY",
  "SESSION_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_ALLOWLIST",
]);

/** Ids that would corrupt a plain-object registry key or shadow prototype members. */
const RESERVED_MODEL_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** Config-injection charsets (spec §2.5.2) — every value interpolated into the
 *  generated LiteLLM YAML is charset-validated at registration. */
const ID_CHARSET = /^[a-z0-9][a-z0-9._-]*$/i;
const PROVIDER_MODEL_CHARSET = /^[A-Za-z0-9._:\/-]+$/;
const API_KEY_ENV_FORMAT = /^[A-Z][A-Z0-9_]*$/;

const PROVIDERS = new Set(["anthropic", "ollama", "openai-compatible"]);

/** Routed = talks to a non-Anthropic backend through the managed proxy. */
export function isRouted(entry: ModelEntry): boolean {
  return entry.provider === "ollama" || entry.provider === "openai-compatible";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

type ValidationResult = { ok: true; entry: ModelEntry } | { ok: false; error: string };

function coreValid(raw: unknown): raw is ModelEntry {
  const e = raw as Partial<ModelEntry> | null;
  return (
    !!e &&
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.label === "string" &&
    typeof e.contextWindow === "number" &&
    Number.isFinite(e.contextWindow)
  );
}

/** Full field + hardening validation shared by the file-load and register
 *  paths. `existingIds` is the set of already-routed ids the entry's id must
 *  not collide with (route-hijack guard, spec §2.5.3). Returns the exact skip
 *  string on failure; both loadModelsFile (warn) and registerModel (error)
 *  surface it verbatim. Does NOT check key/shadow collisions — those are the
 *  caller's concern (they carry caller-specific messages). */
function validateEntry(raw: unknown, existingIds: Set<string>): ValidationResult {
  if (!coreValid(raw)) {
    return { ok: false, error: "model entry needs string id, string label, numeric contextWindow" };
  }
  const e = raw as ModelEntry & Record<string, unknown>;
  const skip = (suffix: string): ValidationResult => ({
    ok: false,
    error: `entry "${e.id}" skipped — ${suffix}`,
  });

  if (e.local !== undefined && typeof e.local !== "boolean") return skip("local must be a boolean");
  if (e.degradedNote !== undefined && typeof e.degradedNote !== "string") {
    return skip("degradedNote must be a string");
  }
  if (RESERVED_MODEL_IDS.has(e.id)) return skip("reserved id");
  if (!ID_CHARSET.test(e.id)) return skip("id has invalid characters");
  if (e.provider !== undefined && !PROVIDERS.has(e.provider as string)) {
    return skip(`unknown provider "${String(e.provider)}"`);
  }
  if (e.providerModel !== undefined) {
    if (typeof e.providerModel !== "string" || !PROVIDER_MODEL_CHARSET.test(e.providerModel)) {
      return skip("providerModel has invalid characters");
    }
  }
  if (e.baseUrl !== undefined) {
    if (typeof e.baseUrl !== "string" || /\s/.test(e.baseUrl) || !isHttpUrl(e.baseUrl)) {
      return skip("baseUrl must be a valid http(s) URL");
    }
  }
  if (e.apiKeyEnv !== undefined) {
    if (typeof e.apiKeyEnv !== "string" || e.apiKeyEnv.length === 0) {
      return skip("apiKeyEnv must be a non-empty string");
    }
    if (!API_KEY_ENV_FORMAT.test(e.apiKeyEnv)) return skip("apiKeyEnv must be an uppercase env var name");
    if (RESERVED_API_KEY_ENVS.has(e.apiKeyEnv)) return skip("apiKeyEnv names a reserved variable");
  }
  if (isRouted(e)) {
    if (e.baseUrl === undefined) return skip(`provider "${e.provider}" requires baseUrl`);
    if (e.providerModel === undefined) return skip(`provider "${e.provider}" requires providerModel`);
  }
  if (existingIds.has(e.id)) return skip("id already routed");

  // Normalize: copy only known fields, omit undefined (persisted shape).
  const entry: ModelEntry = { id: e.id, label: e.label, contextWindow: e.contextWindow };
  if (e.provider !== undefined) entry.provider = e.provider;
  if (e.baseUrl !== undefined) entry.baseUrl = e.baseUrl;
  if (e.providerModel !== undefined) entry.providerModel = e.providerModel;
  if (e.apiKeyEnv !== undefined) entry.apiKeyEnv = e.apiKeyEnv;
  if (e.local !== undefined) entry.local = e.local;
  if (e.degradedNote !== undefined) entry.degradedNote = e.degradedNote;
  return { ok: true, entry };
}

/** Parse + validate `$MPAI_HOME/models.json`. Returns a Record keyed by each
 *  entry's id. Missing file → empty (normal). Corrupt/non-array → warn + empty.
 *  Per-entry validation warns-and-skips; shadowing a built-in KEY (e.g. `opus`)
 *  is "key already registered", an id equal to a built-in claude-* id is
 *  "id already routed". Never throws. */
export function loadModelsFile(
  filePath: string,
  warn: (message: string) => void,
): Record<string, ModelEntry> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    warn(`models.json could not be read — ignoring (${errMessage(err)})`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`models.json is not valid JSON — ignoring (${errMessage(err)})`);
    return {};
  }
  if (!Array.isArray(parsed)) {
    warn("models.json must be a JSON array — ignoring");
    return {};
  }
  const result: Record<string, ModelEntry> = {};
  const builtinKeys = new Set(Object.keys(BUILTIN_MODELS));
  const builtinIds = new Set(Object.values(BUILTIN_MODELS).map((m) => m.id));
  for (const raw of parsed) {
    const v = validateEntry(raw, builtinIds);
    if (!v.ok) {
      warn(v.error);
      continue;
    }
    const e = v.entry;
    // Shadowing a built-in key, or a duplicate earlier file entry (key === id):
    if (builtinKeys.has(e.id) || Object.hasOwn(result, e.id)) {
      warn(`entry "${e.id}" skipped — key already registered`);
      continue;
    }
    result[e.id] = e;
  }
  return result;
}

/** The non-builtin registry entries, keyed by their wire key (=== id). This is
 *  exactly the persisted set. */
function nonBuiltinEntries(): Record<string, ModelEntry> {
  const out: Record<string, ModelEntry> = {};
  for (const [key, entry] of Object.entries(MODELS)) {
    if (!Object.hasOwn(BUILTIN_MODELS, key)) out[key] = entry;
  }
  return out;
}

/** Atomically persist the non-builtin set to `filePath` as a JSON array of
 *  ModelEntry (no `key` field). Before the rename, the existing file — if any —
 *  is copied to `<filePath>.bak` (single-level backup, spec §2.5.5), so an
 *  accidental remove is recoverable exactly one operation back. */
export function persistModelsFile(
  filePath: string,
  entries: Record<string, ModelEntry>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(Object.values(entries), null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

/** Best-effort, advisory credential detection (spec §2.4): a non-empty
 *  `ANTHROPIC_API_KEY`, else a Claude CLI credentials file on disk under
 *  `CLAUDE_CONFIG_DIR ?? ~/.claude`. `exists` is injected for testability. */
export function hasAnthropicCredentials(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): boolean {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0) return true;
  const dir =
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
      ? env.CLAUDE_CONFIG_DIR
      : path.join(os.homedir(), ".claude");
  return exists(path.join(dir, ".credentials.json"));
}

/** Rebuild MODELS in place: builtins (credential-annotated) → models.json →
 *  MPAI_EXTRA_MODELS. Called at module load with process.env; re-callable in
 *  tests with an injected env. */
export function initRegistry(env: NodeJS.ProcessEnv, warn: (message: string) => void): void {
  for (const key of Object.keys(MODELS)) delete MODELS[key];

  const creds = hasAnthropicCredentials(env, fs.existsSync);
  for (const [key, entry] of Object.entries(BUILTIN_MODELS)) {
    const copy: ModelEntry = { ...entry };
    if (!creds) copy.degradedNote = NO_CREDS_NOTE;
    MODELS[key] = copy;
  }

  const fileEntries = loadModelsFile(path.join(mpaiHome(env), "models.json"), warn);
  for (const [key, entry] of Object.entries(fileEntries)) {
    // loadModelsFile already rejected built-in-key shadows, claude-id routes,
    // and intra-file dups, so these land cleanly.
    MODELS[key] = entry;
  }

  const extra = parseExtraModels(env.MPAI_EXTRA_MODELS, warn);
  const existingIds = new Set(Object.values(MODELS).map((m) => m.id));
  for (const [key, entry] of Object.entries(extra)) {
    if (Object.hasOwn(MODELS, key)) {
      warn(`entry "${key}" skipped — key already registered`);
      continue;
    }
    if (existingIds.has(entry.id)) {
      warn(`entry "${entry.id}" skipped — id already routed`);
      continue;
    }
    MODELS[key] = entry;
    existingIds.add(entry.id);
  }
}

/** Every registry entry as a ManagedModelEntry, in registration order
 *  (built-ins first, `builtin: true`; then models.json; then env extras). */
export function managedModels(): ManagedModelEntry[] {
  const builtinKeys = new Set(Object.keys(BUILTIN_MODELS));
  return Object.entries(MODELS).map(([key, m]) => {
    const entry: ManagedModelEntry = { ...m, key };
    if (builtinKeys.has(key)) entry.builtin = true;
    return entry;
  });
}

/** Validate → mutate MODELS → persist, atomically. On a persist failure the
 *  in-memory mutation is rolled back so memory and disk never disagree. */
export function registerModel(
  entry: ModelEntry,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; error: string } {
  if (!coreValid(entry)) {
    return { ok: false, error: "model entry needs string id, string label, numeric contextWindow" };
  }
  if (Object.hasOwn(MODELS, entry.id)) {
    return { ok: false, error: `model "${entry.id}" already registered` };
  }
  const existingIds = new Set(Object.values(MODELS).map((m) => m.id));
  const v = validateEntry(entry, existingIds);
  if (!v.ok) return { ok: false, error: v.error };

  MODELS[entry.id] = v.entry;
  try {
    persistModelsFile(path.join(mpaiHome(env), "models.json"), nonBuiltinEntries());
  } catch (err) {
    delete MODELS[entry.id];
    return { ok: false, error: `failed to write models.json: ${errMessage(err)}` };
  }
  return { ok: true };
}

/** Remove a non-builtin entry and persist. Built-ins refuse; unknown keys
 *  refuse. On a persist failure the removal is rolled back. */
export function unregisterModel(
  key: string,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; error: string } {
  if (Object.hasOwn(BUILTIN_MODELS, key)) {
    return { ok: false, error: "cannot remove a built-in model" };
  }
  if (!Object.hasOwn(MODELS, key)) {
    return { ok: false, error: `unknown model "${key}"` };
  }
  const removed = MODELS[key];
  delete MODELS[key];
  try {
    persistModelsFile(path.join(mpaiHome(env), "models.json"), nonBuiltinEntries());
  } catch (err) {
    MODELS[key] = removed;
    return { ok: false, error: `failed to write models.json: ${errMessage(err)}` };
  }
  return { ok: true };
}

/** The effective initial model key for a new session (spec §2.4). With
 *  credentials, `"opus"`. Without, the first routed/local model in registration
 *  order, else `"opus"` (the annotation carries the honesty). */
export function resolveDefaultModel(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): ModelKey {
  if (hasAnthropicCredentials(env, exists)) return DEFAULT_MODEL;
  const routed = managedModels().find((m) => isRouted(m));
  return routed ? routed.key : DEFAULT_MODEL;
}
