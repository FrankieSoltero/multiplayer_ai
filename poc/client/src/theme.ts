import { useEffect, useState } from "react";

/** The two presentation looks. `"arcade"` is the default everywhere. */
export type Theme = "arcade" | "clean";

/** localStorage key for the client-local theme preference (constraint 6). */
export const THEME_KEY = "mpai-theme";

/** Pure: only the exact string `"clean"` selects the clean theme. Anything
 *  else — `null`, an unknown value, an empty string — falls back to `"arcade"`
 *  silently, so a stale or hand-edited value can never surprise the UI. */
export function readStoredTheme(raw: string | null): Theme {
  return raw === "clean" ? "clean" : "arcade";
}

/** Read the stored preference, guarding the `getItem` itself: localStorage
 *  access throws SecurityError in blocked-storage sandboxes, and a throwing
 *  read must yield the silent default, never a crash (constraint 6). */
function initialTheme(): Theme {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(THEME_KEY);
  } catch {
    raw = null;
  }
  return readStoredTheme(raw);
}

/** Owns the client-local theme: the guarded initial read, mirroring the value
 *  onto `document.documentElement.dataset.theme` for CSS to key off, and
 *  persisting it. The attribute is written FIRST and unconditionally, then the
 *  `setItem` is wrapped in try/catch — so when a write fails (private mode /
 *  quota) the preference still applies in-session and only degrades to
 *  not-persisted (constraint 6). */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Write blocked (private mode / quota): in-session only, no crash.
    }
  }, [theme]);

  return { theme, setTheme };
}
