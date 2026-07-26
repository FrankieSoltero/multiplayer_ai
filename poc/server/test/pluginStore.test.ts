import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginStore, type CloneFn } from "../src/pluginStore.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Fake clone: writes a plugin skeleton instead of touching the network. */
function fakeClone(files: Record<string, string>): CloneFn {
  return async (_url, dest) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dest, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  };
}

const SOLTERO = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "soltero-skills" }),
  "skills/agent-handoff/SKILL.md":
    "---\nname: agent-handoff\ndescription: living resume packets\n---\nbody",
  "skills/capture-lesson/SKILL.md":
    "---\nname: capture-lesson\ndescription: record lessons\n---\nbody",
};

describe("PluginStore.add", () => {
  it("clones, validates, namespaces skills, and registers", async () => {
    const store = new PluginStore(root, fakeClone(SOLTERO));
    const result = await store.add("proj", "https://github.com/x/soltero-skills.git", "u1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.name).toBe("soltero-skills");
    expect(result.plugin.addedBy).toBe("u1");
    expect(result.plugin.skills).toEqual([
      { name: "soltero-skills:agent-handoff", description: "living resume packets" },
      { name: "soltero-skills:capture-lesson", description: "record lessons" },
    ]);
    expect(store.list("proj")).toHaveLength(1);
    expect(store.paths("proj")).toEqual([path.join(root, "proj", "soltero-skills")]);
    expect(store.skillsFor("proj")).toHaveLength(2);
    expect(fs.existsSync(path.join(root, "proj", "soltero-skills", "skills"))).toBe(true);
  });

  it("rejects non-https urls without cloning", async () => {
    let cloned = false;
    const store = new PluginStore(root, async () => { cloned = true; });
    const result = await store.add("proj", "git@github.com:x/y.git", "u1");
    expect(result).toEqual({ ok: false, error: "plugin url must be https://" });
    expect(cloned).toBe(false);
  });

  it("rejects a clone that is not a plugin and removes the clone dir", async () => {
    const store = new PluginStore(root, fakeClone({ "README.md": "just a repo" }));
    const result = await store.add("proj", "https://github.com/x/notaplugin", "u1");
    expect(result).toEqual({
      ok: false,
      error: "not a plugin — needs .claude-plugin/plugin.json or skills/*/SKILL.md",
    });
    expect(fs.readdirSync(path.join(root, "proj"))).toEqual([]);
  });

  it("derives and sanitizes the name from the url when plugin.json is absent", async () => {
    const store = new PluginStore(
      root,
      fakeClone({ "skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\n" }),
    );
    const result = await store.add("proj", "https://github.com/x/My_Skills.git", "u1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.name).toBe("my-skills");
  });

  it("rejects duplicate names and cleans up the second clone", async () => {
    const store = new PluginStore(root, fakeClone(SOLTERO));
    await store.add("proj", "https://github.com/x/soltero-skills", "u1");
    const dup = await store.add("proj", "https://github.com/fork/soltero-skills", "u2");
    expect(dup).toEqual({ ok: false, error: 'plugin "soltero-skills" already registered' });
    expect(store.list("proj")).toHaveLength(1);
    // only the plugin dir + its meta file remain
    expect(fs.readdirSync(path.join(root, "proj")).sort()).toEqual([
      "soltero-skills",
      "soltero-skills.meta.json",
    ]);
  });

  it("reports a failed clone as an error", async () => {
    const store = new PluginStore(root, async () => { throw new Error("boom"); });
    const result = await store.add("proj", "https://github.com/x/y", "u1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^clone failed: /);
  });

  it("is disabled without a root", async () => {
    const store = new PluginStore(undefined);
    expect(store.enabled).toBe(false);
    const result = await store.add("proj", "https://github.com/x/y", "u1");
    expect(result).toEqual({
      ok: false,
      error: "plugin import is off — set AGENT_PLUGINS_ROOT on the server",
    });
    expect(store.list("proj")).toEqual([]);
    expect(store.paths("proj")).toEqual([]);
  });

  it("handles finalization failure (rename/meta-write) and cleans up", async () => {
    const store = new PluginStore(root, fakeClone(SOLTERO));
    const projectDir = path.join(root, "proj");
    fs.mkdirSync(projectDir, { recursive: true });

    // Mock renameSync to throw an error simulating a race/permissions issue
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("ENOTEMPTY");
    });

    const result = await store.add("proj", "https://github.com/x/soltero-skills", "u1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^finalization failed: /);

    // Verify tmp dirs are cleaned up (only meta files or dest attempt should be gone)
    const remaining = fs.readdirSync(projectDir);
    expect(remaining.every((f) => !f.startsWith(".clone-"))).toBe(true);

    renameSpy.mockRestore();
  });
});

describe("PluginStore.remove", () => {
  it("removes the registration, dir, and meta file", async () => {
    const store = new PluginStore(root, fakeClone(SOLTERO));
    await store.add("proj", "https://github.com/x/soltero-skills", "u1");
    expect(store.remove("proj", "soltero-skills")).toEqual({ ok: true });
    expect(store.list("proj")).toEqual([]);
    expect(fs.readdirSync(path.join(root, "proj"))).toEqual([]);
  });

  it("errors on an unknown name", () => {
    const store = new PluginStore(root, fakeClone(SOLTERO));
    expect(store.remove("proj", "nope")).toEqual({
      ok: false,
      error: 'unknown plugin "nope"',
    });
  });
});

describe("PluginStore boot rescan", () => {
  it("rebuilds the registry from disk, including addedBy from meta files", async () => {
    const first = new PluginStore(root, fakeClone(SOLTERO));
    await first.add("proj", "https://github.com/x/soltero-skills", "u1");
    const reborn = new PluginStore(root); // default clone fn, never called
    expect(reborn.list("proj")).toHaveLength(1);
    expect(reborn.list("proj")[0].name).toBe("soltero-skills");
    expect(reborn.list("proj")[0].addedBy).toBe("u1");
    expect(reborn.skillsFor("proj")).toHaveLength(2);
  });
});
