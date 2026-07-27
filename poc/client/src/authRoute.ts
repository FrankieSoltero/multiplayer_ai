import type { AuthState } from "./authState";
import type { Profile } from "./identity";

/** Which top-level screen the app shows. `checking` is the auth probe in
 *  flight; the rest map 1:1 to a component in App.tsx. */
export type Screen =
  | "checking"
  | "invite-signin"
  | "landing"
  | "denied"
  | "invite-landing"
  | "picker"
  | "lobby"
  | "session";

export interface RouteInput {
  /** null while the /auth/me probe is in flight. */
  auth: AuthState | null;
  inviteToken: string | null;
  inviteTarget: { projectId: string; sessionId: string } | null;
  activeSessionId: string | null;
  profile: Profile | null;
}

/** The routing precedence, as a pure function (spec §3.5).
 *
 *  Order is the whole point and the reason this is not inline JSX: an invite
 *  token no longer wins over auth state, so a signed-out invitee is asked to
 *  sign in first and a denied invitee is told why — neither reaches the invite
 *  landing, whose "PRESS START" the server would reject at the join gate.
 *
 *  With auth off every state is `anonymous`, which matches none of the auth
 *  arms and falls through to the pre-auth chain unchanged. */
export function screenFor(input: RouteInput): Screen {
  const { auth, inviteToken, inviteTarget, activeSessionId, profile } = input;

  if (auth === null) return "checking";
  if (auth.status === "signed-out") return inviteToken ? "invite-signin" : "landing";
  if (auth.status === "denied") return "denied";

  if (inviteToken && !inviteTarget) return "invite-landing";
  if (activeSessionId === null) return "picker";
  if (profile === null) return "lobby";
  return "session";
}
