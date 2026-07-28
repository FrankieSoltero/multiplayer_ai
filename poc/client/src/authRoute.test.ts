import { describe, it, expect } from "vitest";
import { screenFor, selfIdFor, type RouteInput } from "./authRoute";

/** A fully-resolved signed-in user with a session and a profile: the "nothing
 *  special is happening" row. Each test overrides only what it is about. */
const base: RouteInput = {
  auth: { status: "signed-in", login: "ana" },
  inviteToken: null,
  inviteTarget: null,
  activeSessionId: "s1",
  activeProjectId: "acme",
  profile: { name: "ana", glyph: "@", color: "#0f0" },
};

const route = (over: Partial<RouteInput>) => screenFor({ ...base, ...over });

describe("screenFor — spec §3.5 routing precedence", () => {
  it("shows the probe screen until auth resolves, whatever else is set", () => {
    expect(route({ auth: null })).toBe("checking");
    expect(route({ auth: null, inviteToken: "tok", activeSessionId: null, profile: null })).toBe(
      "checking",
    );
  });

  // §3.5 row 1 — the ordering that matters most. Before A2a the invite token
  // won, which would send a signed-out invitee to InviteLanding, where PRESS
  // START connects a socket the server's join gate rejects.
  it("sends a signed-out invitee to the invite sign-in screen, not the invite landing", () => {
    expect(route({ auth: { status: "signed-out" }, inviteToken: "tok" })).toBe("invite-signin");
  });

  // §3.5 row 2
  it("sends a signed-out visitor with no invite to the landing page", () => {
    expect(route({ auth: { status: "signed-out" }, inviteToken: null })).toBe("landing");
  });

  // §3.5 row 3 — the second ordering that matters: denied outranks the invite.
  it("shows denied to a verified-but-unlisted user even when they hold an invite", () => {
    expect(route({ auth: { status: "denied", login: "mal" }, inviteToken: "tok" })).toBe("denied");
    expect(route({ auth: { status: "denied", login: "mal" } })).toBe("denied");
  });

  // §3.5 row 4
  it("sends a signed-in invitee to the invite landing", () => {
    expect(route({ inviteToken: "tok", inviteTarget: null })).toBe("invite-landing");
  });

  it("leaves the invite landing once the invite has been accepted", () => {
    expect(
      route({ inviteToken: "tok", inviteTarget: { projectId: "p", sessionId: "s1" } }),
    ).toBe("session");
  });

  // §3.5 row 5 — everything below the auth arms is the pre-A2a chain.
  it("falls through to picker, lobby, then session", () => {
    expect(route({ activeSessionId: null })).toBe("picker");
    expect(route({ profile: null })).toBe("lobby");
    expect(route({})).toBe("session");
  });

  // §3.5: "when auth is disabled the first three branches are unreachable and
  // the existing order applies unchanged" — an anonymous invitee still lands
  // on the old InviteLanding, so dev-with-vite behaves exactly as before.
  it("keeps the pre-auth order for anonymous users", () => {
    expect(route({ auth: { status: "anonymous" }, inviteToken: "tok" })).toBe("invite-landing");
    expect(route({ auth: { status: "anonymous" }, activeSessionId: null })).toBe("picker");
    expect(route({ auth: { status: "anonymous" }, profile: null })).toBe("lobby");
    expect(route({ auth: { status: "anonymous" } })).toBe("session");
  });
});

/** C1. `isDriver` is `derived.driverId === userId`, and derived.driverId comes
 *  from control_change.userId — which, with auth on, the server sets to the
 *  verified GitHub login. A client comparing against its local sessionStorage
 *  UUID can never match, so the driver's own browser shows "watching" and the
 *  permission gate has no approve/deny control at all. These cases pin the
 *  mapping so that regression cannot come back silently. */
describe("selfIdFor", () => {
  const LOCAL = "9f3c-4b1a-local-uuid";

  it("uses the verified GitHub login when signed in", () => {
    expect(selfIdFor({ status: "signed-in", login: "ana" }, LOCAL)).toBe("ana");
  });

  it("uses the local id when auth is off (anonymous)", () => {
    expect(selfIdFor({ status: "anonymous" }, LOCAL)).toBe(LOCAL);
  });

  it("uses the local id while the auth probe is still in flight", () => {
    expect(selfIdFor(null, LOCAL)).toBe(LOCAL);
  });

  // Neither state can reach the session screen, so this is a definition
  // rather than a behaviour — asserted so it is a decision, not an accident.
  it("uses the local id when signed out or denied", () => {
    expect(selfIdFor({ status: "signed-out" }, LOCAL)).toBe(LOCAL);
    expect(selfIdFor({ status: "denied", login: "mallory" }, LOCAL)).toBe(LOCAL);
  });

  it("makes a signed-in driver match the server-authored driverId", () => {
    // What the wire actually carries once the server overwrites the claim
    // at the join gate: control_change.userId is the verified login.
    const driverIdFromControlChange: string = "ana";
    const selfId = selfIdFor({ status: "signed-in", login: "ana" }, LOCAL);
    // This is exactly App.tsx's `isDriver = derived.driverId === userId`.
    expect(driverIdFromControlChange === selfId).toBe(true);
    // And the pre-fix comparison, for contrast: the local UUID never matched,
    // which is what made the permission gate unanswerable.
    expect(driverIdFromControlChange === LOCAL).toBe(false);
  });
});

describe("entrance route", () => {
  it("shows the entrance when no project and no session are selected", () => {
    const route = screenFor({
      auth: { status: "off" } as any,
      inviteToken: null,
      inviteTarget: null,
      activeSessionId: null,
      activeProjectId: null,
      profile: { name: "ana" } as any,
    } as any);
    expect(route).toBe("entrance");
  });

  it("still shows the project screen when a project is selected", () => {
    const route = screenFor({
      auth: { status: "off" } as any,
      inviteToken: null,
      inviteTarget: null,
      activeSessionId: null,
      activeProjectId: "acme",
      profile: { name: "ana" } as any,
    } as any);
    expect(route).toBe("picker");
  });
});
