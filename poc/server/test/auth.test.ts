import { describe, it, expect } from "vitest";
import {
  parseCookies,
  signSession,
  verifySession,
  isAllowlisted,
  SESSION_MAX_AGE_MS,
} from "../src/auth.js";

const SECRET = "test-secret-do-not-use";

describe("parseCookies", () => {
  it("parses a normal header", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("returns empty for undefined or blank", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("keeps '=' inside a value", () => {
    expect(parseCookies("t=aa.bb==")).toEqual({ t: "aa.bb==" });
  });

  it("ignores malformed segments without throwing", () => {
    expect(parseCookies("novalue; a=1")).toEqual({ a: "1" });
  });
});

describe("signSession / verifySession", () => {
  it("round-trips a login", () => {
    const cookie = signSession("ana", SECRET);
    expect(verifySession(cookie, SECRET)).toEqual({ login: "ana" });
  });

  it("rejects a tampered payload", () => {
    const cookie = signSession("ana", SECRET);
    const [, sig] = cookie.split(".");
    const forged = Buffer.from(JSON.stringify({ login: "root", iat: Date.now() }))
      .toString("base64url");
    expect(verifySession(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const cookie = signSession("ana", SECRET);
    const [payload] = cookie.split(".");
    expect(verifySession(`${payload}.deadbeef`, SECRET)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = signSession("ana", "other-secret");
    expect(verifySession(cookie, SECRET)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const issued = 1_000_000;
    const cookie = signSession("ana", SECRET, issued);
    expect(verifySession(cookie, SECRET, issued + SESSION_MAX_AGE_MS + 1)).toBeNull();
    expect(verifySession(cookie, SECRET, issued + SESSION_MAX_AGE_MS - 1)).toEqual({
      login: "ana",
    });
  });

  it("returns null for undefined, empty, and malformed values", () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession("", SECRET)).toBeNull();
    expect(verifySession("no-dot", SECRET)).toBeNull();
    expect(verifySession("!!!.!!!", SECRET)).toBeNull();
  });
});

describe("isAllowlisted", () => {
  it("matches exactly", () => {
    expect(isAllowlisted("ana", "ana,ben")).toBe(true);
  });

  it("is case-insensitive (GitHub logins are)", () => {
    expect(isAllowlisted("Ana", "ana,ben")).toBe(true);
    expect(isAllowlisted("ana", "ANA")).toBe(true);
  });

  it("tolerates whitespace around entries", () => {
    expect(isAllowlisted("ben", " ana , ben ")).toBe(true);
  });

  it("rejects a login that is not listed", () => {
    expect(isAllowlisted("mallory", "ana,ben")).toBe(false);
  });

  it("rejects everyone when the list is empty or blank", () => {
    expect(isAllowlisted("ana", "")).toBe(false);
    expect(isAllowlisted("ana", "   ")).toBe(false);
    expect(isAllowlisted("ana", ",,")).toBe(false);
  });

  it("does not match on a substring", () => {
    expect(isAllowlisted("an", "ana")).toBe(false);
  });
});
