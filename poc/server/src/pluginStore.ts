import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { SkillInfo } from "./events.js";

const execFileAsync = promisify(execFile);
const NAME_RE = /^[a-z0-9-]{1,40}$/;

export interface PluginInfo {
  name: string;
  url: string;
  /** Namespaced "plugin:skill", matching the SDK's canonical plugin-skill names. */
  skills: SkillInfo[];
  addedBy: string;
}

export type CloneFn = (url: string, dest: string) => Promise<void>;

/** argv, never a shell — the URL cannot inject. `--` stops flag parsing. */
const gitClone: CloneFn = async (url, dest) => {
  await execFileAsync("git", ["clone", "--depth", "1", "--", url, dest], {
    timeout: 120_000,
  });
};

export type AddResult =
  | { ok: true; plugin: PluginInfo }
  | { ok: false; error: string };

const OFF_ERROR = "plugin import is off — set AGENT_PLUGINS_ROOT on the server";

/**
 * Project-scoped plugin registry backed by disk: clones live at
 * `<root>/<projectId>/<name>/` with a sibling `<name>.meta.json` carrying
 * `{url, addedBy}` so a boot rescan loses nothing. No database — the
 * directory tree IS the registry; the in-memory map is just a cache.
 */
export class PluginStore {
  private registry = new Map<string, Map<string, PluginInfo>>();

  constructor(
    private root: string | undefined,
    private clone: CloneFn = gitClone,
  ) {
    if (root) this.rescan();
  }

  get enabled(): boolean {
    return this.root !== undefined;
  }

  list(projectId: string): PluginInfo[] {
    return [...(this.registry.get(projectId)?.values() ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  paths(projectId: string): string[] {
    if (!this.root) return [];
    return this.list(projectId).map((p) => path.join(this.root!, projectId, p.name));
  }

  skillsFor(projectId: string): SkillInfo[] {
    return this.list(projectId).flatMap((p) => p.skills);
  }

  async add(projectId: string, url: string, addedBy: string): Promise<AddResult> {
    if (!this.root) return { ok: false, error: OFF_ERROR };
    if (!url.startsWith("https://"))
      return { ok: false, error: "plugin url must be https://" };
    const projectDir = path.join(this.root, projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    const tmp = path.join(projectDir, `.clone-${randomUUID()}`);
    try {
      await this.clone(url, tmp);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `clone failed: ${msg}` };
    }
    const name = deriveName(tmp, url);
    const skills = scanSkills(tmp, name);
    if (skills.length === 0 && !fs.existsSync(path.join(tmp, ".claude-plugin", "plugin.json"))) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return {
        ok: false,
        error: "not a plugin — needs .claude-plugin/plugin.json or skills/*/SKILL.md",
      };
    }
    if (!NAME_RE.test(name)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, error: `invalid plugin name "${name}"` };
    }
    const dest = path.join(projectDir, name);
    if (this.registry.get(projectId)?.has(name) || fs.existsSync(dest)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, error: `plugin "${name}" already registered` };
    }
    fs.renameSync(tmp, dest);
    const plugin: PluginInfo = { name, url, skills, addedBy };
    fs.writeFileSync(
      path.join(projectDir, `${name}.meta.json`),
      JSON.stringify({ url, addedBy }),
    );
    if (!this.registry.has(projectId)) this.registry.set(projectId, new Map());
    this.registry.get(projectId)!.set(name, plugin);
    return { ok: true, plugin };
  }

  remove(projectId: string, name: string): { ok: true } | { ok: false; error: string } {
    const plugin = this.registry.get(projectId)?.get(name);
    if (!plugin || !this.root) return { ok: false, error: `unknown plugin "${name}"` };
    this.registry.get(projectId)!.delete(name);
    const projectDir = path.join(this.root, projectId);
    fs.rmSync(path.join(projectDir, name), { recursive: true, force: true });
    fs.rmSync(path.join(projectDir, `${name}.meta.json`), { force: true });
    return { ok: true };
  }

  private rescan(): void {
    if (!this.root || !fs.existsSync(this.root)) return;
    for (const projectId of fs.readdirSync(this.root)) {
      const projectDir = path.join(this.root, projectId);
      if (!fs.statSync(projectDir).isDirectory()) continue;
      const map = new Map<string, PluginInfo>();
      for (const name of fs.readdirSync(projectDir)) {
        const dir = path.join(projectDir, name);
        if (name.startsWith(".") || !fs.statSync(dir).isDirectory()) continue;
        let url = "";
        let addedBy = "unknown";
        try {
          const meta = JSON.parse(
            fs.readFileSync(path.join(projectDir, `${name}.meta.json`), "utf8"),
          );
          if (typeof meta.url === "string") url = meta.url;
          if (typeof meta.addedBy === "string") addedBy = meta.addedBy;
        } catch {
          // meta missing/corrupt: keep the plugin, degrade the metadata
        }
        map.set(name, { name, url, skills: scanSkills(dir, name), addedBy });
      }
      if (map.size > 0) this.registry.set(projectId, map);
    }
  }
}

/** plugin.json `name`, else url basename minus `.git`; sanitized to slug. */
function deriveName(dir: string, url: string): string {
  let raw = "";
  try {
    const json = JSON.parse(
      fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    if (typeof json.name === "string") raw = json.name;
  } catch {
    // fall through to url-derived name
  }
  if (!raw) raw = (url.split("/").pop() ?? "").replace(/\.git$/, "");
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** skills/<dir>/SKILL.md frontmatter → namespaced SkillInfo, sorted by name. */
function scanSkills(dir: string, pluginName: string): SkillInfo[] {
  const skillsDir = path.join(dir, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, entry, "SKILL.md");
    try {
      const raw = fs.readFileSync(file, "utf8");
      const name = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry;
      const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim().slice(0, 200) ?? "";
      out.push({ name: `${pluginName}:${name}`, description });
    } catch {
      continue; // not a skill dir
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
