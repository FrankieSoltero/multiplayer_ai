import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODELS, type ModelEntry } from "../src/models.js";
import {
  loadModelsFile,
  persistModelsFile,
  initRegistry,
  registerModel,
  unregisterModel,
  managedModels,
  isRouted,
  hasAnthropicCredentials,
  resolveDefaultModel,
  type ManagedModelEntry,
} from "../src/modelsConfig.js";

/** Task 2 (spec §2.1 persisted config + §2.4 credential detection / default
 *  fallback): $MPAI_HOME/models.json is the per-machine registry store, layered
 *  builtins → models.json → MPAI_EXTRA_MODELS, with the warn-and-skip contract
 *  extended to the new provider/baseUrl/providerModel/apiKeyEnv fields and the
 *  §2.5 hardening guards. */

const NO_CREDS_NOTE = "no Anthropic credentials — set ANTHROPIC_API_KEY or add a local model";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mpai-t2-"));
}

function credEnv(home: string): NodeJS.ProcessEnv {
  return { ANTHROPIC_API_KEY: "sk-test", MPAI_HOME: home } as NodeJS.ProcessEnv;
}

const never = () => false;

// Every test starts from a clean, credential-present, empty-store registry so
// the shared MODELS object is deterministic regardless of ambient env.
let baseHome: string;
beforeEach(() => {
  baseHome = tmpHome();
  initRegistry(credEnv(baseHome), () => {});
});
afterEach(() => {
  initRegistry(credEnv(tmpHome()), () => {});
});

describe("isRouted — routed = ollama or openai-compatible", () => {
  it("is true for ollama and openai-compatible, false otherwise", () => {
    expect(isRouted({ id: "a", label: "A", contextWindow: 1, provider: "ollama" })).toBe(true);
    expect(
      isRouted({ id: "b", label: "B", contextWindow: 1, provider: "openai-compatible" }),
    ).toBe(true);
    expect(isRouted({ id: "c", label: "C", contextWindow: 1, provider: "anthropic" })).toBe(false);
    expect(isRouted({ id: "d", label: "D", contextWindow: 1 })).toBe(false);
  });
});

describe("loadModelsFile — parse + validate the on-disk array", () => {
  it("a missing file registers nothing and never warns", () => {
    const warn = vi.fn();
    expect(loadModelsFile(path.join(tmpHome(), "models.json"), warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("a valid array loads entries keyed by id", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: "qwen3.6-27b",
          label: "QWEN3.6 27B (LOCAL)",
          contextWindow: 32768,
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          providerModel: "qwen3.6:27b",
          local: true,
        },
      ]),
    );
    const warn = vi.fn();
    expect(loadModelsFile(file, warn)).toEqual({
      "qwen3.6-27b": {
        id: "qwen3.6-27b",
        label: "QWEN3.6 27B (LOCAL)",
        contextWindow: 32768,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        providerModel: "qwen3.6:27b",
        local: true,
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("invalid JSON warns exactly once and loads nothing — never a boot crash", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(file, "{not json");
    const warn = vi.fn();
    expect(loadModelsFile(file, warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    // The module-load wrapper prepends "[models] "; the raw message is un-prefixed
    // (same convention as parseExtraModels).
    expect(warn.mock.calls[0][0]).toMatch(/^models\.json is not valid JSON — ignoring \(.+\)$/);
  });

  it("a non-array warns and loads nothing", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(file, JSON.stringify({ id: "x" }));
    const warn = vi.fn();
    expect(loadModelsFile(file, warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/must be a JSON array/);
  });

  it("routed entry missing baseUrl warns and is skipped", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(
      file,
      JSON.stringify([{ id: "q", label: "Q", contextWindow: 1, provider: "ollama", providerModel: "q:1" }]),
    );
    const warn = vi.fn();
    expect(loadModelsFile(file, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith('entry "q" skipped — provider "ollama" requires baseUrl');
  });

  it("routed entry missing providerModel warns and is skipped", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "q", label: "Q", contextWindow: 1, provider: "ollama", baseUrl: "http://127.0.0.1:11434" },
      ]),
    );
    const warn = vi.fn();
    expect(loadModelsFile(file, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith('entry "q" skipped — provider "ollama" requires providerModel');
  });

  it("shadowing a built-in KEY (id opus) warns and is skipped", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "opus", label: "IMPOSTOR", contextWindow: 1 }]));
    const warn = vi.fn();
    expect(loadModelsFile(file, warn)).toEqual({});
    expect(warn.mock.calls.some((c) => /key already registered/.test(String(c[0])))).toBe(true);
  });

  it("an id equal to a built-in claude-* id is rejected as id-already-routed", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "claude-opus-5", label: "HIJACK", contextWindow: 1 }]));
    const warn = vi.fn();
    expect(loadModelsFile(file, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith('entry "claude-opus-5" skipped — id already routed');
  });
});

describe("initRegistry — layered load: builtins → models.json → MPAI_EXTRA_MODELS", () => {
  it("models.json wins over MPAI_EXTRA_MODELS for the same id (env warn-and-skipped)", () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify([{ id: "shared", label: "FROM FILE", contextWindow: 10 }]),
    );
    const warn = vi.fn();
    initRegistry(
      {
        ANTHROPIC_API_KEY: "sk-test",
        MPAI_HOME: home,
        MPAI_EXTRA_MODELS: JSON.stringify([{ id: "shared", label: "FROM ENV", contextWindow: 20 }]),
      } as NodeJS.ProcessEnv,
      warn,
    );
    expect(MODELS.shared.label).toBe("FROM FILE");
    expect(warn.mock.calls.some((c) => /key already registered/.test(String(c[0])))).toBe(true);
  });

  it("a models.json entry shadowing built-in key opus is skipped; the built-in stands", () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify([{ id: "opus", label: "IMPOSTOR", contextWindow: 1 }]),
    );
    initRegistry(credEnv(home), () => {});
    expect(MODELS.opus).toEqual({ id: "claude-opus-5", label: "opus 5", contextWindow: 1000000 });
  });

  it("an MPAI_EXTRA_MODELS entry whose id equals a built-in claude id is id-already-routed", () => {
    const warn = vi.fn();
    initRegistry(
      {
        ANTHROPIC_API_KEY: "sk-test",
        MPAI_HOME: tmpHome(),
        MPAI_EXTRA_MODELS: JSON.stringify([{ id: "claude-opus-5", label: "HIJACK", contextWindow: 1 }]),
      } as NodeJS.ProcessEnv,
      warn,
    );
    expect(Object.hasOwn(MODELS, "claude-opus-5")).toBe(false);
    expect(warn).toHaveBeenCalledWith('entry "claude-opus-5" skipped — id already routed');
  });

  it("a corrupt models.json warns [models]-prefixed and treats the store as empty", () => {
    const home = tmpHome();
    const file = path.join(home, "models.json");
    fs.writeFileSync(file, "{not json");
    const messages: string[] = [];
    initRegistry(credEnv(home), (m) => messages.push(`[models] ${m}`));
    expect(
      messages.some((m) => /^\[models\] models\.json is not valid JSON — ignoring \(.+\)$/.test(m)),
    ).toBe(true);
    // File not rewritten by a failed load.
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
    expect(managedModels().every((m) => m.builtin)).toBe(true);
  });
});

describe("credential detection — hasAnthropicCredentials", () => {
  it("a non-empty ANTHROPIC_API_KEY is credentials", () => {
    expect(hasAnthropicCredentials({ ANTHROPIC_API_KEY: "sk-x" } as NodeJS.ProcessEnv, never)).toBe(true);
  });

  it("an empty ANTHROPIC_API_KEY is not credentials", () => {
    expect(hasAnthropicCredentials({ ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv, never)).toBe(false);
  });

  it("falls back to ~/.claude/.credentials.json on disk", () => {
    const target = path.join(os.homedir(), ".claude", ".credentials.json");
    expect(
      hasAnthropicCredentials({} as NodeJS.ProcessEnv, (p) => p === target),
    ).toBe(true);
  });

  it("respects CLAUDE_CONFIG_DIR for the credentials file location", () => {
    const target = path.join("/custom/cfg", ".credentials.json");
    expect(
      hasAnthropicCredentials(
        { CLAUDE_CONFIG_DIR: "/custom/cfg" } as NodeJS.ProcessEnv,
        (p) => p === target,
      ),
    ).toBe(true);
  });

  it("no env key and no CLI file is no credentials", () => {
    expect(hasAnthropicCredentials({} as NodeJS.ProcessEnv, never)).toBe(false);
  });
});

describe("credential annotation of the Claude built-ins", () => {
  it("no creds → the four built-ins carry the degradedNote", () => {
    // CLAUDE_CONFIG_DIR at an empty dir so initRegistry's real fs.existsSync
    // finds no CLI credentials file regardless of the host machine.
    initRegistry(
      { MPAI_HOME: tmpHome(), CLAUDE_CONFIG_DIR: tmpHome() } as NodeJS.ProcessEnv,
      () => {},
    );
    for (const key of ["opus", "sonnet", "haiku", "fable"]) {
      expect(MODELS[key].degradedNote).toBe(NO_CREDS_NOTE);
    }
  });

  it("creds present → no degradedNote on built-ins", () => {
    initRegistry(credEnv(tmpHome()), () => {});
    for (const key of ["opus", "sonnet", "haiku", "fable"]) {
      expect("degradedNote" in MODELS[key]).toBe(false);
    }
  });
});

describe("resolveDefaultModel — key-less fallback (spec §2.4)", () => {
  it("returns 'opus' when credentials are present", () => {
    initRegistry(credEnv(tmpHome()), () => {});
    expect(resolveDefaultModel(credEnv(baseHome), never)).toBe("opus");
  });

  it("no creds, one routed entry → that entry's key", () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify([
        {
          id: "q",
          label: "Q",
          contextWindow: 1,
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          providerModel: "q:1",
        },
      ]),
    );
    initRegistry({ MPAI_HOME: home } as NodeJS.ProcessEnv, () => {});
    expect(resolveDefaultModel({ MPAI_HOME: home } as NodeJS.ProcessEnv, never)).toBe("q");
  });

  it("no creds, multiple routed entries → first routed in registration order", () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify([
        { id: "first", label: "1", contextWindow: 1, provider: "ollama", baseUrl: "http://127.0.0.1:11434", providerModel: "a:1" },
        { id: "second", label: "2", contextWindow: 1, provider: "ollama", baseUrl: "http://127.0.0.1:11434", providerModel: "b:1" },
      ]),
    );
    initRegistry({ MPAI_HOME: home } as NodeJS.ProcessEnv, () => {});
    expect(resolveDefaultModel({ MPAI_HOME: home } as NodeJS.ProcessEnv, never)).toBe("first");
  });

  it("no creds, no routed entries → 'opus' (annotation carries the honesty)", () => {
    initRegistry({ MPAI_HOME: tmpHome() } as NodeJS.ProcessEnv, () => {});
    expect(resolveDefaultModel({ MPAI_HOME: baseHome } as NodeJS.ProcessEnv, never)).toBe("opus");
  });
});

describe("managedModels — registration order, builtin flag", () => {
  it("built-ins first (builtin:true), then registered extras, each with its key", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const res = registerModel(
      {
        id: "q",
        label: "Q",
        contextWindow: 1,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        providerModel: "q:1",
      },
      credEnv(home),
    );
    expect(res.ok).toBe(true);
    const managed = managedModels();
    expect(managed.slice(0, 4).map((m) => m.key)).toEqual(["opus", "sonnet", "haiku", "fable"]);
    expect(managed.slice(0, 4).every((m) => m.builtin === true)).toBe(true);
    const q = managed.find((m) => m.key === "q") as ManagedModelEntry;
    expect(q).toMatchObject({ key: "q", id: "q", provider: "ollama" });
    expect("builtin" in q).toBe(false);
  });
});

describe("persistModelsFile — atomic write + single-level backup", () => {
  it("writes a JSON array of entry values with no key field", () => {
    const file = path.join(tmpHome(), "models.json");
    persistModelsFile(file, { q: { id: "q", label: "Q", contextWindow: 1 } });
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed).toEqual([{ id: "q", label: "Q", contextWindow: 1 }]);
    expect("key" in parsed[0]).toBe(false);
    // No stray temp file left behind (tmp + rename).
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("backs the previous file up to <path>.bak before overwriting", () => {
    const file = path.join(tmpHome(), "models.json");
    fs.writeFileSync(file, "PREVIOUS");
    persistModelsFile(file, { q: { id: "q", label: "Q", contextWindow: 1 } });
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe("PREVIOUS");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([{ id: "q", label: "Q", contextWindow: 1 }]);
  });

  it("does not create a .bak when there was no existing file", () => {
    const file = path.join(tmpHome(), "models.json");
    persistModelsFile(file, {});
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([]);
  });
});

describe("registerModel — validate → mutate → persist", () => {
  it("a valid ollama entry registers, mutates MODELS, and persists the full non-builtin set", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const entry: ModelEntry = {
      id: "q",
      label: "Q",
      contextWindow: 1,
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      providerModel: "q:1",
    };
    expect(registerModel(entry, credEnv(home))).toEqual({ ok: true });
    expect(MODELS.q).toMatchObject({ id: "q", provider: "ollama" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, "models.json"), "utf8"));
    expect(onDisk).toEqual([entry]);
  });

  it("a missing core field is rejected with the core-validation error; nothing persisted", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const res = registerModel({ id: "q", contextWindow: 1 } as unknown as ModelEntry, credEnv(home));
    expect(res).toEqual({
      ok: false,
      error: "model entry needs string id, string label, numeric contextWindow",
    });
    expect(fs.existsSync(path.join(home, "models.json"))).toBe(false);
  });

  it("collision with a built-in key is rejected", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(
      registerModel({ id: "opus", label: "X", contextWindow: 1 }, credEnv(home)),
    ).toEqual({ ok: false, error: 'model "opus" already registered' });
  });

  it("collision with an already-registered extra is rejected", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const entry: ModelEntry = {
      id: "q",
      label: "Q",
      contextWindow: 1,
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      providerModel: "q:1",
    };
    expect(registerModel(entry, credEnv(home)).ok).toBe(true);
    expect(registerModel(entry, credEnv(home))).toEqual({
      ok: false,
      error: 'model "q" already registered',
    });
  });

  it("a routed entry missing baseUrl is rejected with the exact skip string", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(
      registerModel(
        { id: "q", label: "Q", contextWindow: 1, provider: "ollama", providerModel: "q:1" },
        credEnv(home),
      ),
    ).toEqual({ ok: false, error: 'entry "q" skipped — provider "ollama" requires baseUrl' });
  });

  it("a routed entry missing providerModel is rejected with the exact skip string", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(
      registerModel(
        { id: "q", label: "Q", contextWindow: 1, provider: "ollama", baseUrl: "http://127.0.0.1:11434" },
        credEnv(home),
      ),
    ).toEqual({ ok: false, error: 'entry "q" skipped — provider "ollama" requires providerModel' });
  });

  it("an openai-compatible entry MAY omit apiKeyEnv (keyless endpoints)", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(
      registerModel(
        {
          id: "kless",
          label: "K",
          contextWindow: 1,
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:8000",
          providerModel: "gpt-x",
        },
        credEnv(home),
      ),
    ).toEqual({ ok: true });
  });

  it("apiKeyEnv guards run in order: empty/type → format → reserved", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const base = {
      label: "K",
      contextWindow: 1,
      provider: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:8000",
      providerModel: "gpt-x",
    };
    expect(
      registerModel({ ...base, id: "e1", apiKeyEnv: "" }, credEnv(home)),
    ).toEqual({ ok: false, error: 'entry "e1" skipped — apiKeyEnv must be a non-empty string' });
    expect(
      registerModel(
        { ...base, id: "e2", apiKeyEnv: 5 as unknown as string },
        credEnv(home),
      ),
    ).toEqual({ ok: false, error: 'entry "e2" skipped — apiKeyEnv must be a non-empty string' });
    expect(
      registerModel({ ...base, id: "e3", apiKeyEnv: "lower_case" }, credEnv(home)),
    ).toEqual({ ok: false, error: 'entry "e3" skipped — apiKeyEnv must be an uppercase env var name' });
    expect(
      registerModel({ ...base, id: "e4", apiKeyEnv: "ANTHROPIC_API_KEY" }, credEnv(home)),
    ).toEqual({ ok: false, error: 'entry "e4" skipped — apiKeyEnv names a reserved variable' });
  });

  it("rejects every daemon-reserved apiKeyEnv name", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    const base = {
      label: "K",
      contextWindow: 1,
      provider: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:8000",
      providerModel: "gpt-x",
    };
    for (const name of ["SESSION_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_ALLOWLIST"]) {
      expect(
        registerModel({ ...base, id: `r-${name}`, apiKeyEnv: name }, credEnv(home)),
      ).toEqual({ ok: false, error: `entry "r-${name}" skipped — apiKeyEnv names a reserved variable` });
    }
  });

  it("a valid uppercase non-reserved apiKeyEnv is accepted", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(
      registerModel(
        {
          id: "ok",
          label: "K",
          contextWindow: 1,
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:8000",
          providerModel: "gpt-x",
          apiKeyEnv: "TOGETHER_API_KEY",
        },
        credEnv(home),
      ),
    ).toEqual({ ok: true });
  });

  it("config-injection charset guards: id, providerModel, baseUrl", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(
      registerModel({ id: "bad id", label: "Q", contextWindow: 1 }, credEnv(home)),
    ).toEqual({ ok: false, error: 'entry "bad id" skipped — id has invalid characters' });
    expect(
      registerModel(
        {
          id: "q",
          label: "Q",
          contextWindow: 1,
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          providerModel: "bad model!",
        },
        credEnv(home),
      ),
    ).toEqual({ ok: false, error: 'entry "q" skipped — providerModel has invalid characters' });
    expect(
      registerModel(
        {
          id: "q",
          label: "Q",
          contextWindow: 1,
          provider: "ollama",
          baseUrl: "ftp://nope",
          providerModel: "q:1",
        },
        credEnv(home),
      ),
    ).toEqual({ ok: false, error: 'entry "q" skipped — baseUrl must be a valid http(s) URL' });
    expect(
      registerModel(
        {
          id: "q",
          label: "Q",
          contextWindow: 1,
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434\n evil",
          providerModel: "q:1",
        },
        credEnv(home),
      ),
    ).toEqual({ ok: false, error: 'entry "q" skipped — baseUrl must be a valid http(s) URL' });
  });

  it("route-hijack guard: an id equal to a built-in claude id is rejected", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(
      registerModel({ id: "claude-opus-5", label: "HIJACK", contextWindow: 1 }, credEnv(home)),
    ).toEqual({ ok: false, error: 'entry "claude-opus-5" skipped — id already routed' });
  });

  it("persist failure rolls the in-memory mutation back", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    // MPAI_HOME resolves under a path whose component is a FILE → write throws.
    const blocker = path.join(home, "blocker");
    fs.writeFileSync(blocker, "x");
    const badEnv = { ANTHROPIC_API_KEY: "sk-test", MPAI_HOME: blocker } as NodeJS.ProcessEnv;
    const entry: ModelEntry = {
      id: "q",
      label: "Q",
      contextWindow: 1,
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      providerModel: "q:1",
    };
    const res = registerModel(entry, badEnv);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/^failed to write models\.json: /);
    expect(Object.hasOwn(MODELS, "q")).toBe(false);
  });
});

describe("unregisterModel", () => {
  it("refuses to remove a built-in", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(unregisterModel("opus", credEnv(home))).toEqual({
      ok: false,
      error: "cannot remove a built-in model",
    });
  });

  it("refuses an unknown key", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    expect(unregisterModel("nope", credEnv(home))).toEqual({
      ok: false,
      error: 'unknown model "nope"',
    });
  });

  it("removes a registered extra, persists the shrunk set, backs up the prior file", () => {
    const home = tmpHome();
    initRegistry(credEnv(home), () => {});
    registerModel(
      {
        id: "q",
        label: "Q",
        contextWindow: 1,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        providerModel: "q:1",
      },
      credEnv(home),
    );
    expect(unregisterModel("q", credEnv(home))).toEqual({ ok: true });
    expect(Object.hasOwn(MODELS, "q")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, "models.json"), "utf8"))).toEqual([]);
    // Single-level backup holds the pre-removal file for recovery.
    expect(fs.existsSync(path.join(home, "models.json.bak"))).toBe(true);
  });
});
