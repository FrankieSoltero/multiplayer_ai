import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkillRoster } from "../src/skillRoster.js";

describe("loadSkillRoster", () => {
  it("reads the frontmatter description from the worktree's SKILL.md, best-effort", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
    const dir = path.join(workdir, ".claude", "skills", "auth-migration-guide");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: auth-migration-guide\ndescription: Guide for migrating the auth stack\n---\n\n# body\n",
    );
    const roster = loadSkillRoster(workdir, ["auth-migration-guide", "missing-skill", "plugin:remote-skill"]);
    expect(roster).toEqual([
      { name: "auth-migration-guide", description: "Guide for migrating the auth stack" },
      { name: "missing-skill", description: "" },
      { name: "plugin:remote-skill", description: "" },
    ]);
  });

  it("returns empty descriptions with no workdir and [] for no names", () => {
    expect(loadSkillRoster(undefined, ["a"])).toEqual([{ name: "a", description: "" }]);
    expect(loadSkillRoster("/nope", [])).toEqual([]);
  });
});
