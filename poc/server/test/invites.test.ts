import { describe, expect, it } from "vitest";
import { DEFAULT_INVITE_MAX_USES, InviteStore } from "../src/invites.js";

const mintArgs = {
  projectId: "default",
  sessionId: "alpha",
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
    expect(store.listFor("alpha")[0].uses).toBe(0);
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

  it("reports revocation and only for the owning session", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    expect(store.revoke(inv.id, "other")).toBe(false);
    expect(store.revoke(inv.id, "alpha")).toBe(true);
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite revoked" });
  });

  it("counts seats by distinct user and rejects when full", () => {
    const store = new InviteStore({ maxUses: 2 });
    const inv = store.mint(mintArgs);
    expect(store.redeem(inv.token, "u2", "alpha")).toMatchObject({ ok: true });
    expect(store.redeem(inv.token, "u2", "alpha")).toMatchObject({ ok: true });
    expect(store.listFor("alpha")[0].uses).toBe(1);
    expect(store.redeem(inv.token, "u3", "alpha")).toMatchObject({ ok: true });
    expect(store.redeem(inv.token, "u4", "alpha")).toEqual({ ok: false, error: "invite is full" });
    expect(store.redeem(inv.token, "u2", "alpha")).toMatchObject({ ok: true });
  });

  it("refuses to redeem an invite against a different session", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    expect(store.redeem(inv.token, "u2", "beta")).toEqual({ ok: false, error: "invite not found" });
  });

  it("lists only live invites for the session, soonest expiry first", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const first = store.mint(mintArgs);
    now = 1_050;
    const second = store.mint(mintArgs);
    const other = store.mint({ ...mintArgs, sessionId: "beta" });
    const list = store.listFor("alpha");
    expect(list.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(list.map((i) => i.token)).toContain(first.token);
    expect(list.some((i) => i.id === other.id)).toBe(false);
    store.revoke(first.id, "alpha");
    expect(store.listFor("alpha").map((i) => i.id)).toEqual([second.id]);
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
    expect(store.revoke("nonexistent", "alpha")).toBe(false);
  });

  it("when invite is both revoked and expired, peek reports revoked first", () => {
    let now = 1_000;
    const store = new InviteStore({ ttlMs: 100, now: () => now });
    const inv = store.mint(mintArgs);
    store.revoke(inv.id, "alpha");
    now = 1_200; // past expiry
    expect(store.peek(inv.token)).toEqual({ ok: false, error: "invite revoked" });
  });

  it("revoked invite with wrong session returns invite not found", () => {
    const store = new InviteStore();
    const inv = store.mint(mintArgs);
    store.revoke(inv.id, "alpha");
    // Trying to redeem with a different session should NOT leak "revoked" state
    expect(store.redeem(inv.token, "u2", "beta")).toEqual({ ok: false, error: "invite not found" });
  });

  it("full invite with wrong session returns invite not found", () => {
    const store = new InviteStore({ maxUses: 1 });
    const inv = store.mint(mintArgs);
    // Redeem the only seat in session alpha
    store.redeem(inv.token, "u2", "alpha");
    // Now it's full, but try to redeem from a different session
    expect(store.redeem(inv.token, "u3", "beta")).toEqual({ ok: false, error: "invite not found" });
  });

  it("full invite still appears in listFor with zero seats left", () => {
    const store = new InviteStore({ maxUses: 1 });
    const inv = store.mint(mintArgs);
    store.redeem(inv.token, "u2", "alpha");
    // Should still be listed even though it's full
    const list = store.listFor("alpha");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(inv.id);
    expect(list[0].uses).toBe(1);
    expect(list[0].maxUses).toBe(1);
  });

  it("revoke succeeds on a full invite", () => {
    const store = new InviteStore({ maxUses: 1 });
    const inv = store.mint(mintArgs);
    store.redeem(inv.token, "u2", "alpha");
    // Should be able to revoke a full invite
    expect(store.revoke(inv.id, "alpha")).toBe(true);
    // And it should disappear from the list after revoke
    expect(store.listFor("alpha")).toHaveLength(0);
  });
});
