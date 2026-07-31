import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { readStoredTheme, THEME_KEY, useTheme, type Theme } from "./theme";

/** This repo has no DOM test environment (docs/tech-debt.md): no jsdom, no
 *  happy-dom, no testing-library. Hooks are exercised the house way — through a
 *  minimal runtime installed on React's internals (same H_KEY seam as
 *  App.test.tsx / Transcript.test.tsx). `useTheme` performs its side effects in
 *  `useEffect`, so — unlike the static-render tests elsewhere — this harness
 *  actually RUNS the collected effects after each render (that is the commit
 *  phase the attribute write and storage write live in), and `useState` setters
 *  trigger a synchronous re-render + re-commit so `setTheme` really flips. */
const H_KEY = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";

function renderHook<T>(hook: () => T): { result: () => T } {
  const internals = (React as unknown as Record<string, { H: unknown }>)[H_KEY];
  const prevH = internals.H;
  const hooks: unknown[] = [];
  let i = 0;
  let value: T;
  const runtime = {
    useRef: (v: unknown) => {
      const k = i++;
      if (hooks[k] === undefined) hooks[k] = { current: v };
      return hooks[k];
    },
    useState: (init: unknown) => {
      const k = i++;
      if (!(k in hooks)) hooks[k] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (nv: unknown) => {
        hooks[k] = typeof nv === "function" ? (nv as (p: unknown) => unknown)(hooks[k]) : nv;
        render();
      };
      return [hooks[k], set];
    },
    useEffect: (fn: () => void) => {
      effects.push(fn);
    },
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useContext: () => undefined,
  };
  let effects: Array<() => void> = [];
  function render() {
    i = 0;
    effects = [];
    internals.H = runtime;
    try {
      value = hook();
    } finally {
      internals.H = prevH;
    }
    // Commit phase: run the effects the render queued.
    effects.forEach((e) => e());
  }
  render();
  return { result: () => value };
}

/** Install fresh `localStorage` + `document` globals for one test. */
function install(opts: { stored?: string | null; getThrows?: boolean; setThrows?: boolean } = {}) {
  const map = new Map<string, string>();
  if (opts.stored != null) map.set(THEME_KEY, opts.stored);
  const setCalls: Array<[string, string]> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = {
    getItem: (k: string) => {
      if (opts.getThrows) throw new DOMException("blocked", "SecurityError");
      return map.has(k) ? map.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (opts.setThrows) throw new DOMException("quota", "QuotaExceededError");
      setCalls.push([k, v]);
      map.set(k, v);
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const dataset: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = { documentElement: { dataset } };
  return { dataset, setCalls, map };
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).document;
});

describe("theme — hook + pure reader", () => {
  it("T1-default: no stored key → arcade, data-theme=arcade", () => {
    const env = install({ stored: null });
    const { result } = renderHook(() => useTheme());
    expect(result().theme).toBe("arcade");
    expect(env.dataset.theme).toBe("arcade");
  });

  it("T1-invalid-stored: unknown value falls back to arcade silently", () => {
    const env = install({ stored: "neon" });
    const { result } = renderHook(() => useTheme());
    expect(result().theme).toBe("arcade");
    expect(env.dataset.theme).toBe("arcade");
  });

  it("T1-stored-clean: key clean → theme clean, attribute clean", () => {
    const env = install({ stored: "clean" });
    const { result } = renderHook(() => useTheme());
    expect(result().theme).toBe("clean");
    expect(env.dataset.theme).toBe("clean");
  });

  it("T1-setTheme: state flips, attribute updates, key persisted", () => {
    const env = install({ stored: null });
    const { result } = renderHook(() => useTheme());
    expect(result().theme).toBe("arcade");

    result().setTheme("clean");

    expect(result().theme).toBe("clean");
    expect(env.dataset.theme).toBe("clean");
    expect(env.map.get(THEME_KEY)).toBe("clean");
    expect(env.setCalls).toContainEqual([THEME_KEY, "clean"]);
  });

  it("T1-storage-read-throws: guarded read → no crash, arcade, attribute set", () => {
    const env = install({ getThrows: true });
    let result!: () => ReturnType<typeof useTheme>;
    expect(() => {
      result = renderHook(() => useTheme()).result;
    }).not.toThrow();
    expect(result().theme).toBe("arcade");
    expect(env.dataset.theme).toBe("arcade");
  });

  it("T1-storage-write-fails: guarded write → no crash, state + attribute still update", () => {
    const env = install({ stored: null, setThrows: true });
    const { result } = renderHook(() => useTheme());
    // Mount effect already tried (and swallowed) a failing setItem.
    expect(() => result().setTheme("clean")).not.toThrow();
    expect(result().theme).toBe("clean");
    expect(env.dataset.theme).toBe("clean");
    // Nothing persisted: preference degrades to in-session only.
    expect(env.map.has(THEME_KEY)).toBe(false);
  });

  it("T1-pure-helper: readStoredTheme maps only clean to clean", () => {
    const cases: Array<[string | null, Theme]> = [
      [null, "arcade"],
      ["clean", "clean"],
      ["ARCADE", "arcade"],
      ["", "arcade"],
    ];
    for (const [input, expected] of cases) {
      expect(readStoredTheme(input)).toBe(expected);
    }
  });
});
