/** Pure formatters for the workflows screen (component-test infra doesn't
 *  exist in this repo; established pattern). */

export function statusGlyph(status: string): string {
  if (status === "running") return "▶";
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "stopped") return "⛔";
  return "◌";
}

export function fmtTokens(n?: number): string {
  if (n === undefined) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtDuration(ms?: number): string {
  if (ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function usageLine(t: {
  tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string;
}): string {
  const parts = [`${fmtTokens(t.tokens)} tok`, `${t.toolUses ?? 0} tools`, fmtDuration(t.durationMs)];
  if (t.lastTool) parts.push(t.lastTool);
  return parts.join(" · ");
}
