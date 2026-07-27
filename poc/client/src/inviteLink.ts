/** Pure helpers for invite links (no component-test infra in this repo —
 *  recorded pattern, see sessionRow.ts). */

/** The link carries the token and nothing else: the server resolves project
 *  and session from it, so ids never appear in a shared URL. */
export function inviteLinkFor(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/?invite=${encodeURIComponent(token)}`;
}

export function inviteTokenFrom(search: string): string | null {
  const token = new URLSearchParams(search).get("invite");
  return token ? token : null;
}

/** Single source of truth for "N seats left" text — used by both the
 *  pre-join landing screen (which only has `remaining`) and the in-session
 *  invite panel (which has `{uses, maxUses}` via `seatsLabel`). */
export function seatsLeftLabel(remaining: number): string {
  const left = Math.max(0, remaining);
  if (left === 0) return "NO SEATS LEFT";
  return `${left} SEAT${left === 1 ? "" : "S"} LEFT`;
}

export function seatsLabel(view: { uses: number; maxUses: number }): string {
  return seatsLeftLabel(view.maxUses - view.uses);
}

export function expiryLabel(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "EXPIRED";
  if (ms < 60_000) return "EXPIRES IN <1M";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `EXPIRES IN ${minutes}M`;
  return `EXPIRES IN ${Math.floor(minutes / 60)}H`;
}
