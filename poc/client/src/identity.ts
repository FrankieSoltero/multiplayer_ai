export const GLYPHS = ["■", "▲", "●", "✦", "◆", "♠", "★"] as const;
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

/** UUIDv4 that works in INSECURE contexts. `crypto.randomUUID` exists only on
 *  https/localhost; a hub served over plain http on a LAN IP (the
 *  multi-machine-test topology) has `crypto` without it, and calling it
 *  black-screens the whole app at mount. `getRandomValues` is available in
 *  every context, so the fallback derives a spec-shaped v4 from it. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function loadOrCreateUserId(): string {
  let id = sessionStorage.getItem("mpai-userId");
  if (!id) {
    id = randomId();
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
