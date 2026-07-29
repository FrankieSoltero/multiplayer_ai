import { describe, expect, it } from "vitest";
import { machineRows } from "./machineRows";
import type { MachineInfo, RepoDecl } from "./types";

const repo = (key: string, label: string, over: Partial<RepoDecl> = {}): RepoDecl => ({
  key, label, attached: true, defaultBranch: "main", ...over,
});

const machine = (machineId: string, name: string, repos: RepoDecl[], online = true): MachineInfo => ({
  machineId, name, repos, online,
});

describe("machineRows", () => {
  it("splits a machine's repos into attached (DETACH targets) and candidates (ATTACH targets)", () => {
    const rows = machineRows([
      machine("m1", "franks-mbp", [
        repo("acme/api", "api"),
        repo("acme/web", "web", { attached: false, defaultBranch: null }),
      ]),
    ]);
    expect(rows).toEqual([
      {
        machineId: "m1",
        name: "franks-mbp",
        online: true,
        attached: [repo("acme/api", "api")],
        candidates: [repo("acme/web", "web", { attached: false, defaultBranch: null })],
      },
    ]);
  });

  it("keeps an offline machine's row — sessions outlive machines, so hiding it would orphan its rows", () => {
    const rows = machineRows([
      machine("m1", "franks-mbp", [repo("acme/api", "api")], false),
    ]);
    expect(rows).toEqual([
      {
        machineId: "m1",
        name: "franks-mbp",
        online: false,
        attached: [repo("acme/api", "api")],
        candidates: [],
      },
    ]);
  });

  it("returns [] for no machines", () => {
    expect(machineRows([])).toEqual([]);
  });
});
