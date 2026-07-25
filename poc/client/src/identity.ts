export const GLYPHS = ["■", "▲", "●", "✦", "◆", "♠"] as const;
export const IDENTITY_COLORS = [
  "#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2",
] as const;

export interface Profile {
  name: string;
  glyph: string;
  color: string;
}

export function hashIdentity(userId: string): { glyph: string; color: string } {
  let h = 0;
  for (const ch of userId) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return {
    glyph: GLYPHS[h % GLYPHS.length],
    color: IDENTITY_COLORS[(h >>> 1) % IDENTITY_COLORS.length],
  };
}

export function loadOrCreateUserId(): string {
  let id = sessionStorage.getItem("mpai-userId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mpai-userId", id);
  }
  return id;
}

export function loadProfile(): Profile | null {
  const raw = sessionStorage.getItem("mpai-profile");
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p.name === "string" && typeof p.glyph === "string" && typeof p.color === "string") return p;
  } catch { /* fall through */ }
  return null;
}

export function saveProfile(p: Profile): void {
  sessionStorage.setItem("mpai-profile", JSON.stringify(p));
}
