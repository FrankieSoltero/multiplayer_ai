import { describe, expect, it } from "vitest";
import { choiceValue, chooseRepo, parseChoiceValue, repoChoices, repoLabels } from "./repoChoices";
import type { MachineInfo, RepoDecl } from "./types";

const repo = (key: string, label: string, over: Partial<RepoDecl> = {}): RepoDecl => ({
  key, label, attached: true, defaultBranch: "main", ...over,
});

const machine = (machineId: string, name: string, repos: RepoDecl[], online = true): MachineInfo => ({
  machineId, name, repos, online,
});

describe("repoChoices", () => {
  it("yields one choice per attached repo on a machine", () => {
    const choices = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api"), repo("acme/web", "web")]),
    ]);
    expect(choices.map((c) => c.repoKey)).toEqual(["acme/api", "acme/web"]);
    expect(choices.every((c) => c.machineId === "m1")).toBe(true);
  });

  it("labels a choice as '<repo label> — <machine name>'", () => {
    const choices = repoChoices([machine("m1", "franks-mbp", [repo("acme/api", "api")])]);
    expect(choices[0].label).toBe("api — franks-mbp");
  });

  it("carries the repo's default branch so the base ref can prefill from it", () => {
    const choices = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api", { defaultBranch: "trunk" })]),
    ]);
    expect(choices[0].defaultBranch).toBe("trunk");
  });

  it("excludes candidates that are not attached", () => {
    // A candidate can be ATTACHed, but it serves no session until it is —
    // offering it in the create form would promise a refusal.
    const choices = repoChoices([
      machine("m1", "franks-mbp", [
        repo("acme/api", "api"),
        repo("acme/web", "web", { attached: false, defaultBranch: null }),
      ]),
    ]);
    expect(choices.map((c) => c.repoKey)).toEqual(["acme/api"]);
  });

  it("excludes offline machines entirely", () => {
    const choices = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api")], false),
      machine("m2", "build-box", [repo("acme/web", "web")]),
    ]);
    expect(choices.map((c) => c.machineId)).toEqual(["m2"]);
  });

  it("keeps machine order across machines", () => {
    const choices = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api")]),
      machine("m2", "build-box", [repo("acme/api", "api"), repo("acme/web", "web")]),
    ]);
    expect(choices.map((c) => `${c.machineId}:${c.repoKey}`)).toEqual([
      "m1:acme/api", "m2:acme/api", "m2:acme/web",
    ]);
  });

  it("returns nothing when no machine is online", () => {
    expect(repoChoices([machine("m1", "franks-mbp", [repo("acme/api", "api")], false)])).toEqual([]);
  });
});

describe("chooseRepo", () => {
  const choices = repoChoices([
    machine("m1", "franks-mbp", [repo("acme/api", "api")]),
    machine("m2", "build-box", [repo("acme/web", "web")]),
  ]);

  it("keeps an explicit pick across a snapshot refresh", () => {
    const picked = { machineId: "m2", repoKey: "acme/web" };
    // A fresh snapshot rebuilds the choice objects; identity must not matter.
    const refreshed = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api")]),
      machine("m2", "build-box", [repo("acme/web", "web")]),
    ]);
    expect(chooseRepo(refreshed, picked)?.repoKey).toBe("acme/web");
  });

  it("falls back to the first choice when the picked machine goes offline", () => {
    const survivors = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api")]),
      machine("m2", "build-box", [repo("acme/web", "web")], false),
    ]);
    expect(chooseRepo(survivors, { machineId: "m2", repoKey: "acme/web" })?.machineId).toBe("m1");
  });

  it("falls back to the first choice when nothing is picked", () => {
    expect(chooseRepo(choices, null)?.machineId).toBe("m1");
  });

  it("distinguishes the same repo key on two machines", () => {
    const both = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api")]),
      machine("m2", "build-box", [repo("acme/api", "api")]),
    ]);
    expect(chooseRepo(both, { machineId: "m2", repoKey: "acme/api" })?.machineId).toBe("m2");
  });

  it("returns null when there is nothing to choose", () => {
    expect(chooseRepo([], { machineId: "m1", repoKey: "acme/api" })).toBeNull();
    expect(chooseRepo([], null)).toBeNull();
  });
});

describe("choiceValue / parseChoiceValue", () => {
  it("round-trips a repo key that itself contains colons", () => {
    // `local:<host>:<digest>` is the no-remote key shape; splitting the option
    // value on every colon would truncate it to "local".
    const value = choiceValue({ machineId: "m1", repoKey: "local:franks-mbp:abc123def456" });
    expect(value).toBe("m1:local:franks-mbp:abc123def456");
    expect(parseChoiceValue(value)).toEqual({
      machineId: "m1", repoKey: "local:franks-mbp:abc123def456",
    });
  });

  it("round-trips every choice a machine offers", () => {
    const choices = repoChoices([
      machine("m1", "franks-mbp", [repo("acme/api", "api"), repo("local:mbp:99", "web")]),
    ]);
    for (const c of choices) {
      expect(parseChoiceValue(choiceValue(c))).toEqual({
        machineId: c.machineId, repoKey: c.repoKey,
      });
    }
  });

  it("reads nothing out of a value that is not a pair", () => {
    expect(parseChoiceValue("")).toBeNull();
    expect(parseChoiceValue("m1")).toBeNull();
    expect(parseChoiceValue("m1:")).toBeNull();
    expect(parseChoiceValue(":acme/api")).toBeNull();
  });
});

describe("repoLabels", () => {
  it("maps every key a machine offers, attached or not, to its label", () => {
    const labels = repoLabels([
      machine("m1", "franks-mbp", [
        repo("acme/api", "api"),
        repo("acme/web", "web", { attached: false, defaultBranch: null }),
      ]),
    ]);
    expect(labels.get("acme/api")).toBe("api");
    expect(labels.get("acme/web")).toBe("web");
  });

  it("includes repos from offline machines — a session's repo still has a name", () => {
    const labels = repoLabels([machine("m1", "franks-mbp", [repo("acme/api", "api")], false)]);
    expect(labels.get("acme/api")).toBe("api");
  });

  it("has no entry for a key no machine offers", () => {
    expect(repoLabels([machine("m1", "franks-mbp", [repo("acme/api", "api")])]).has("gone")).toBe(false);
  });

  it("disambiguates two distinct keys that share a label", () => {
    const labels = repoLabels([
      machine("m1", "franks-mbp", [repo("acme/api", "api")]),
      machine("m2", "build-box", [repo("other/api", "api")]),
    ]);
    const values = [...labels.values()];
    expect(new Set(values).size).toBe(2);
    expect(labels.get("acme/api")).toContain("api");
    expect(labels.get("acme/api")).toContain("acme");
    expect(labels.get("other/api")).toContain("other");
  });

  it("disambiguates keys that share a long prefix", () => {
    // `local:` keys differ only in the trailing digest, so a fixed-length
    // prefix would print the same suffix twice and disambiguate nothing.
    const labels = repoLabels([
      machine("m1", "franks-mbp", [
        repo("local:franks-mbp:aaaaaaaaaaaa", "api"),
        repo("local:franks-mbp:bbbbbbbbbbbb", "api"),
      ]),
    ]);
    expect(new Set(labels.values()).size).toBe(2);
  });

  it("leaves a label alone when the same key is offered by two machines", () => {
    // Same key = same repo, so there is nothing to disambiguate.
    const labels = repoLabels([
      machine("m1", "franks-mbp", [repo("acme/api", "api")]),
      machine("m2", "build-box", [repo("acme/api", "api")]),
    ]);
    expect(labels.get("acme/api")).toBe("api");
  });
});
