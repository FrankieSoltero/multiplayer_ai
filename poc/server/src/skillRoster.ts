import fs from "node:fs";
import path from "node:path";
import type { SkillInfo } from "./events.js";

/**
 * Build the session's skill roster from the AGENT_SKILLS allowlist names.
 * Descriptions are best-effort: read from the agent worktree's checked-in
 * `.claude/skills/<name>/SKILL.md` frontmatter (that is where the SDK loads
 * project skills from — see agentDriver.ts `skills` option). `plugin:name`
 * entries and unreadable files fall back to an empty description; the roster
 * exists so the client can autocomplete, not as documentation.
 */
export function loadSkillRoster(
  workdir: string | undefined,
  names: string[],
): SkillInfo[] {
  return names.map((name) => ({
    name,
    description: readDescription(workdir, name),
  }));
}

function readDescription(workdir: string | undefined, name: string): string {
  if (!workdir || name.includes(":")) return "";
  try {
    const raw = fs.readFileSync(
      path.join(workdir, ".claude", "skills", name, "SKILL.md"),
      "utf8",
    );
    const match = raw.match(/^description:\s*(.+)$/m);
    return match ? match[1].trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}
