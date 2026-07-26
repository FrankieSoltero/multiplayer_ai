import { describe, it, expect } from "vitest";
import { matchSkills, moveHighlight, notRemoved } from "./slashMatch";

const sk = (name: string, description = "") => ({ name, description });

describe("matchSkills", () => {
  const roster = [
    sk("review", "review a PR"),
    sk("code-review:code-review", "plugin review"),
    sk("soltero-skills:agent-handoff", "resume packet"),
    sk("init", "init CLAUDE.md"),
  ];

  it("substring-matches namespaced names — /handoff finds the soltero skill", () => {
    expect(matchSkills("handoff", roster)).toEqual([sk("soltero-skills:agent-handoff", "resume packet")]);
  });

  it("is case-insensitive both ways", () => {
    expect(matchSkills("HANDoff", roster)).toHaveLength(1);
    expect(matchSkills("agent", [sk("Soltero:AGENT-x")])).toHaveLength(1);
  });

  it("ranks prefix matches before substring matches, keeping roster order within each group", () => {
    expect(matchSkills("review", roster).map((s) => s.name)).toEqual([
      "review",              // prefix
      "code-review:code-review", // substring, original order preserved
    ]);
  });

  it("returns the full list for an empty token", () => {
    expect(matchSkills("", roster)).toEqual(roster);
  });

  it("returns [] when nothing matches", () => {
    expect(matchSkills("zzz", roster)).toEqual([]);
  });
});

describe("moveHighlight", () => {
  it("steps down and wraps past the end", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
  });

  it("steps up and wraps past the start", () => {
    expect(moveHighlight(1, -1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });

  it("returns 0 for empty and single-item lists", () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
    expect(moveHighlight(0, -1, 0)).toBe(0);
    expect(moveHighlight(0, 1, 1)).toBe(0);
  });
});

describe("notRemoved", () => {
  it("keeps normal entries, including empty descriptions", () => {
    expect(notRemoved(sk("review", "review a PR"))).toBe(true);
    expect(notRemoved(sk("bare"))).toBe(true);
  });

  it("drops entries whose description marks them removed, even with leading whitespace", () => {
    expect(notRemoved(sk("agents", "(removed)…"))).toBe(false);
    expect(notRemoved(sk("agents", "  (removed in v2)"))).toBe(false);
  });
});
