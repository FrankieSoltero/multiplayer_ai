import { useEffect } from "react";
import { rows, moveH, moveV, yieldsArrows, type NavRect } from "./arrowNav";

/** Everything natively focusable takes part, so every screen — including ones
 *  added later — is navigable with no markup of its own. `data-nav-skip` opts
 *  an element out. */
const FOCUSABLE =
  'button:not([disabled]), select, input, a[href], [tabindex]:not([tabindex="-1"])';

function navItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.hasAttribute("data-nav-skip")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0; // skip anything collapsed or unmounted-but-present
  });
}

/**
 * Arrow keys move real DOM focus around the terminal: ←/→ within a visual row
 * (wrapping), ↑/↓ to the nearest control in the row above/below (clamping).
 *
 * Deliberately uses real focus rather than a selection index, so Tab and
 * Shift+Tab keep working untouched (v6a accessibility ruling), Enter/Space
 * activate a focused button natively with nothing bound here, screen readers
 * announce correctly, and the existing `:focus-visible` ring in terminal.css
 * applies with no new CSS.
 *
 * `enabled` is false while a live arcade run owns the keyboard — snake, tetris
 * and doodle all steer with arrows, so the listener is not even attached then.
 */
export function useArrowNav(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser/OS chords alone
      const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
      const vertical = e.key === "ArrowUp" || e.key === "ArrowDown";
      if (!horizontal && !vertical) return;

      const active = document.activeElement as HTMLElement | null;
      if (yieldsArrows(active, horizontal ? "h" : "v")) return; // typing always wins

      const els = navItems();
      if (!els.length) return;

      const rects: NavRect[] = els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const bands = rows(rects);
      const cur = active ? els.indexOf(active) : -1;
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;

      // nothing relevant focused yet → start at the first control
      const next =
        cur < 0 ? 0 : horizontal ? moveH(bands, cur, dir) : moveV(bands, rects, cur, dir);

      e.preventDefault();
      els[next]?.focus();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
