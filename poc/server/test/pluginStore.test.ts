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

  /** Audit findings M1/M6 (`docs/audit-2026-07-30.md`): every https URL was
   *  cloned, so `add_plugin` was an outbound-request primitive aimed at any
   *  host the server process can reach — and git's differentiated error text
   *  came back to the caller as an internal-network recon oracle. Fail closed:
   *  an explicit host allowlist, checked before any network or git activity. */
  it("rejects an https url whose host is not on the allowlist, without cloning", async () => {
    const rejected = [
      "https://internal.corp.example/team/plugin.git",
      "https://127.0.0.1:9000/x.git",
      "https://[::1]/x.git",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/x.git",
      // Look-alikes: a suffix, a subdomain, a path, and a userinfo prefix all
      // resolve to a host that is NOT github.com.
      "https://github.com.evil.example/x.git",
      "https://raw.githubusercontent.com/x/y",
      "https://evil.example/github.com/x.git",
      "https://github.com@evil.example/x.git",
      "https://",
    ];
    for (const url of rejected) {
      let cloned = false;
      const store = new PluginStore(root, async () => { cloned = true; });
      const result = await store.add("proj", url, "u1");
      expect(result, url).toEqual({
        ok: false,
        error: "plugin url host must be one of: github.com",
      });
      expect(cloned, url).toBe(false);
      // Nothing was created on disk for a refused url.
      expect(fs.existsSync(path.join(root, "proj"))).toBe(false);
    }
  });

  it("still clones an allowlisted host, host-matched case-insensitively", async () => {
    const store = new PluginStore(root, fakeClone(SOLTERO));
    const result = await store.add("proj", "https://GitHub.com/x/soltero-skills.git", "u1");
    expect(result.ok).toBe(true);
    expect(store.list("proj")).toHaveLength(1);
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

  it("on rename failure: cleans tmp only, verifies dest not deleted (race-safety check)", async () => {
    const projectDir = path.join(root, "proj");
    fs.mkdirSync(projectDir, { recursive: true });

    // Pre-create dest with marker file (simulating winner's plugin)
    const destPath = path.join(projectDir, "soltero-skills");
    fs.mkdirSync(destPath, { recursive: true });
    fs.writeFileSync(path.join(destPath, "marker.txt"), "winner data");

    // Create a fresh store with cleared registry to simulate TOCTOU window
    const store = new PluginStore(root, fakeClone(SOLTERO));
    // @ts-ignore
    store.registry.clear();

    // Mock the duplicate check to incorrectly pass (simulating TOCTOU race)
    const realExistSync = fs.existsSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath: any) => {
      const p = typeof filePath === "string" ? filePath : String(filePath);
      // Return false ONLY for the duplicate check call on soltero-skills
      if (p === destPath) {
        return false; // TOCTOU: check incorrectly says dest doesn't exist
      }
      return realExistSync(p);
    });

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("ENOTEMPTY: dest already exists");
    });

    const result = await store.add("proj", "https://github.com/x/soltero-skills", "u1");

    // Restore mocks immediately so assertions use real fs
    existsSpy.mockRestore();
    renameSpy.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^finalization failed: ENOTEMPTY/);

    // CRITICAL: Verify the pre-created dest still exists (we never delete it on rename failure)
    // This uses the real fs.existsSync after mock restore
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(path.join(destPath, "marker.txt"), "utf8")).toBe("winner data");

    // Verify tmp is cleaned up (no .clone- dirs remain)
    const remaining = fs.readdirSync(projectDir);
    expect(remaining.filter((f) => f.startsWith(".clone-"))).toHaveLength(0);
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
