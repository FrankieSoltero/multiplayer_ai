import { describe, it, expect } from "vitest";
import { authStateFrom, loginUrl } from "./authState";

describe("authStateFrom", () => {
  it("is anonymous when the server reports auth disabled", () => {
    expect(authStateFrom(200, { enabled: false })).toEqual({ status: "anonymous" });
  });

  it("is signed-out on a 401", () => {
    expect(authStateFrom(401, { enabled: true })).toEqual({ status: "signed-out" });
  });

  it("is signed-in for an allowlisted login", () => {
    expect(authStateFrom(200, { enabled: true, login: "ana", allowlisted: true })).toEqual({
      status: "signed-in",
      login: "ana",
    });
  });

  it("is denied for a verified login that is not allowlisted", () => {
    expect(authStateFrom(200, { enabled: true, login: "ana", allowlisted: false })).toEqual({
      status: "denied",
      login: "ana",
    });
  });

  it("falls back to anonymous for junk, so a broken probe never locks the app", () => {
    expect(authStateFrom(200, null)).toEqual({ status: "anonymous" });
    expect(authStateFrom(200, "<html>")).toEqual({ status: "anonymous" });
    expect(authStateFrom(500, {})).toEqual({ status: "anonymous" });
  });

  it("falls back to anonymous when login has the wrong type", () => {
    expect(
      authStateFrom(200, { enabled: true, login: 123, allowlisted: true }),
    ).toEqual({ status: "anonymous" });
  });

  it("treats a non-boolean allowlisted as not allowlisted", () => {
    expect(
      authStateFrom(200, { enabled: true, login: "ana", allowlisted: "true" }),
    ).toEqual({ status: "denied", login: "ana" });
  });

  it("falls back to anonymous for an array body", () => {
    expect(authStateFrom(200, [])).toEqual({ status: "anonymous" });
  });
});

describe("loginUrl", () => {
  it("encodes the return path", () => {
    expect(loginUrl("/?invite=abc")).toBe("/auth/login?next=%2F%3Finvite%3Dabc");
  });

  it("defaults to the root", () => {
    expect(loginUrl("/")).toBe("/auth/login?next=%2F");
  });
});
