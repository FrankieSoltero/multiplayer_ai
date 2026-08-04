/** Pure helpers for invite links (no component-test infra in this repo —
 *  recorded pattern, see sessionRow.ts). */

/** The link carries the project AND the token (plan 2026-08-01-project-invites
 *  §1.5): invites are project-scoped, and the `project` param is what routes
 *  the invitee to the right project screen after the accept strips the token —
 *  and what survives in the OAuth `next` when the token rides sessionStorage
 *  instead (§1.7, see INVITE_STASH_KEY). */
export function inviteLinkFor(token: string, origin: string, projectId: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/?project=${encodeURIComponent(projectId)}&invite=${encodeURIComponent(token)}`;
}

export function inviteTokenFrom(search: string): string | null {
  const token = new URLSearchParams(search).get("invite");
  return token ? token : null;
}

/** The origin invite links are built against. Empty where there is no
 *  `window`: this repo's static render tests (react-dom/server under node —
 *  docs/tech-debt.md) render the project screen, and the INVITE section must
 *  render there origin-less rather than crash the seam. */
export function linkOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** sessionStorage key the invite token rides across the OAuth round trip
 *  (tech-debt §1.2, first half): the invite sign-in screen stashes the token
 *  here and strips `invite` from the `next` URL, so the token never sits in a
 *  login link's query string or the state cookie. App reads it back ONCE on
 *  return (read-then-remove) — a stale stash must not outlive the load it
 *  restored. */
export const INVITE_STASH_KEY = "mpai-invite";

/** The `next` handed to loginUrl: the current address MINUS the invite token,
 *  which rides sessionStorage instead (see INVITE_STASH_KEY). `project`
 *  survives on purpose — if the stash is lost (a different tab or browser),
 *  the returning invitee still lands on the right project, never on a wrong
 *  join. */
export function loginNextFrom(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("invite");
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

/** Single source of truth for "N seats left" text — used by both the
 *  pre-join landing screen (which only has `remaining`) and the project
 *  screen's invite panel (which has `{uses, maxUses}` via `seatsLabel`). */
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
