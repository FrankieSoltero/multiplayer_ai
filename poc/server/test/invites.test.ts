import { describe, expect, it } from "vitest";
import { DEFAULT_INVITE_MAX_USES, InviteStore } from "../src/invites.js";

const mintArgs = {
  projectId: "default",
  createdBy: "u1",
  createdByName: "ana",
};

describe("InviteStore", () => {
  it("mints a 32-char token and a distinct 8-char id", () => {
    const store = new InviteStore();
    const a = store.mint(mintArgs);
    const b = store.mint(mintArgs);
    expect(a.token).toHaveLength(32);
    expect(a.id).toHaveLength(8);
    expect(a.token).not.toBe(a.id);
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });

  it("peeks a live invite without consuming a seat", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    const res = store.peek(inv.token);
    expect(res).toMatchObject({ ok: true });
    expect(store.listFor("default")[0].uses).toBe(0);
  });

  it("rejects unknown, non-string, and wrong-length tokens as not found", () => {
    const store = new InviteStore();
    expect(store.peek("x".repeat(32))).toEqual({ ok: false, error: "invite not found" });
    expect(store.peek("short")).toEqual({ ok: false, error: "invite not found" });
    expect(store.peek(undefined)).toEqual({ ok: false, error: "invite not found" });
  });

  it("reports expiry at the boundary", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const inv = store.mint(mintArgs);
    now = 1_099;
    expect(store.peek(inv.token)).toMatchObject({ ok: true });
    now = 1_100;
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite expired" });
  });

  it("reports revocation and only for the owning project", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    expect(store.revoke(inv.id, "other-project")).toBe(false);
    expect(store.revoke(inv.id, "default")).toBe(true);
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite revoked" });
  });

  it("listFor is project-scoped: another project's invites are invisible", () => {
    const store = new InviteStore();
    const victim = store.mint(mintArgs); // projectId: "default"
    const attackerOwn = store.mint({ ...mintArgs, projectId: "evil" });
    // The attacker's project sees only its own invite, never the victim's.
    expect(store.listFor("evil").map((i) => i.id)).toEqual([attackerOwn.id]);
    expect(store.listFor("default").map((i) => i.id)).toEqual([victim.id]);
  });

  it("revoke is project-scoped: a cross-project attempt fails and leaves the invite live", () => {
    const store = new InviteStore();
    const victim = store.mint(mintArgs); // projectId: "default"
    expect(store.revoke(victim.id, "evil")).toBe(false);
    expect(store.peek(victim.token)).toMatchObject({ ok: true });
    expect(store.revoke(victim.id, "default")).toBe(true);
    expect(store.peek(victim.token)).toEqual({ ok: false, error: "invite revoked" });
  });

  it("counts seats by distinct user and rejects when full", () => {
    const store = new InviteStore({ maxUses: 2 });
    const inv = store.mint(mintArgs);
    expect(store.redeem(inv.token, "u2", "default")).toMatchObject({ ok: true });
    expect(store.redeem(inv.token, "u2", "default")).toMatchObject({ ok: true });
    expect(store.listFor("default")[0].uses).toBe(1);
    expect(store.redeem(inv.token, "u3", "default")).toMatchObject({ ok: true });
    expect(store.redeem(inv.token, "u4", "default")).toEqual({ ok: false, error: "invite is full" });
    expect(store.redeem(inv.token, "u2", "default")).toMatchObject({ ok: true });
  });

  it("refuses to redeem an invite against a different project", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs); // projectId: "default"
    expect(store.redeem(inv.token, "u2", "other-project")).toEqual({
      ok: false,
      error: "invite not found",
    });
    // Sanity: the correct project still redeems.
    expect(store.redeem(inv.token, "u2", "default")).toMatchObject({ ok: true });
  });

  it("lists only live invites for the project, soonest expiry first", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const first = store.mint(mintArgs);
    now = 1_050;
    const second = store.mint(mintArgs);
    const other = store.mint({ ...mintArgs, projectId: "other" });
    const list = store.listFor("default");
    expect(list.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(list.map((i) => i.token)).toContain(first.token);
    expect(list.some((i) => i.id === other.id)).toBe(false);
    // The view carries the project it was minted for.
    expect(list[0].projectId).toBe("default");
    store.revoke(first.id, "default");
    expect(store.listFor("default").map((i) => i.id)).toEqual([second.id]);
  });

  it("prunes only well after expiry, so the reason stays reportable", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const inv = store.mint(mintArgs);
    now = 1_200;
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite expired" });
    now = 1_100 + 60 * 60 * 1000 + 1;
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite not found" });
  });

  it("defaults to a 10-seat cap", () => {
    const store = new InviteStore();
    expect(store.mint(mintArgs).maxUses).toBe(DEFAULT_INVITE_MAX_USES);
    expect(DEFAULT_INVITE_MAX_USES).toBe(10);
  });

  it("revoke returns false for a nonexistent id", () => {
    const store = new InviteStore();
    expect(store.revoke("nonexistent", "default")).toBe(false);
  });

  it("when invite is both revoked and expired, peek reports revoked first", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const inv = store.mint(mintArgs);
    store.revoke(inv.id, "default");
    now = 1_200; // past expiry
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite revoked" });
  });

  it("revoked invite with wrong project returns invite not found", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    store.revoke(inv.id, "default");
    // Trying to redeem against a different project must NOT leak "revoked" state
    expect(store.redeem(inv.token, "u2", "other-project")).toEqual({ ok: false, error: "invite not found" });
  });

  it("full invite with wrong project returns invite not found", () => {
    const store = new InviteStore({ maxUses: 1 });
    const inv = store.mint(mintArgs);
    // Redeem the only seat in project "default"
    store.redeem(inv.token, "u2", "default");
    // Now it's full, but a redeem against a different project must not leak that
    expect(store.redeem(inv.token, "u3", "other-project")).toEqual({ ok: false, error: "invite not found" });
  });

  it("full invite still appears in listFor with zero seats left", () => {
    const store = new InviteStore({ maxUses: 1 });
    const inv = store.mint(mintArgs);
    store.redeem(inv.token, "u2", "default");
    // Should still be listed even though it's full
    const list = store.listFor("default");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(inv.id);
    expect(list[0].uses).toBe(1);
    expect(list[0].maxUses).toBe(1);
  });

  it("revoke succeeds on a full invite", () => {
    const store = new InviteStore({ maxUses: 1 });
    const inv = store.mint(mintArgs);
    store.redeem(inv.token, "u2", "default");
    // Should be able to revoke a full invite
    expect(store.revoke(inv.id, "default")).toBe(true);
    // And it should disappear from the list after revoke
    expect(store.listFor("default")).toHaveLength(0);
  });
});
