import { describe, it, expect } from "vitest";
import { isAutoApprovedBash } from "../src/permissions.js";

describe("isAutoApprovedBash", () => {
  it("approves exact allowlisted commands", () => {
    expect(isAutoApprovedBash("git status")).toBe(true);
    expect(isAutoApprovedBash("git log")).toBe(true);
    expect(isAutoApprovedBash("npm test")).toBe(true);
  });

  it("approves allowlisted prefixes followed by arguments", () => {
    expect(isAutoApprovedBash("npx vitest run")).toBe(true);
    expect(isAutoApprovedBash("npx tsc --noEmit")).toBe(true);
    expect(isAutoApprovedBash("git diff --stat HEAD~1")).toBe(true);
  });

  it("rejects prefix look-alikes without a word boundary", () => {
    expect(isAutoApprovedBash("git logger")).toBe(false);
    expect(isAutoApprovedBash("npm testx")).toBe(false);
  });

  it("rejects everything else", () => {
    expect(isAutoApprovedBash("rm -rf /")).toBe(false);
    expect(isAutoApprovedBash("npm install left-pad")).toBe(false);
    expect(isAutoApprovedBash("")).toBe(false);
  });
});
