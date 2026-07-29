import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMachineIdentity, mpaiHome } from "../src/machineIdentity.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mpai-id-"));

describe("loadMachineIdentity", () => {
  it("mints an identity on first run and persists it", () => {
    const dir = tmp();
    const first = loadMachineIdentity(dir);
    expect(first.machineId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(first.name).toBe(os.hostname());
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "machine.json"), "utf8"));
    expect(onDisk.machineId).toBe(first.machineId);
  });

  it("returns the SAME id on a second load — identity survives restarts", () => {
    const dir = tmp();
    const first = loadMachineIdentity(dir);
    expect(loadMachineIdentity(dir).machineId).toBe(first.machineId);
  });

  it("throws on a corrupt file rather than regenerating", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "machine.json"), "{not json");
    expect(() => loadMachineIdentity(dir)).toThrow(/machine identity/);
    // The corrupt file must still be there — no silent overwrite.
    expect(fs.readFileSync(path.join(dir, "machine.json"), "utf8")).toBe("{not json");
  });

  it("throws on a parseable file missing machineId", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "machine.json"), JSON.stringify({ name: "x" }));
    expect(() => loadMachineIdentity(dir)).toThrow(/machine identity/);
  });

  it("reads optional roots, dropping non-strings", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "machine.json"),
      JSON.stringify({ machineId: "m-1", name: "frank", roots: ["/a", 7, "/b"] }),
    );
    expect(loadMachineIdentity(dir).roots).toEqual(["/a", "/b"]);
  });
});

describe("mpaiHome", () => {
  it("prefers MPAI_HOME and falls back to ~/.mpai", () => {
    expect(mpaiHome({ MPAI_HOME: "/custom" } as NodeJS.ProcessEnv)).toBe("/custom");
    expect(mpaiHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), ".mpai"));
  });
});
