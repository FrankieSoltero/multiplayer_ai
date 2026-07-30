import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hubDbPath, storeLogLine } from "../src/bootConfig.js";

describe("hubDbPath", () => {
  it("returns HUB_DB verbatim when it is set", () => {
    // Verbatim, not normalized: the operator's path is the path. A join or a
    // resolve here would silently rewrite a relative HUB_DB against whatever
    // cwd the daemon happened to boot from.
    expect(hubDbPath({ HUB_DB: "/x/y.db" } as NodeJS.ProcessEnv)).toBe("/x/y.db");
  });

  it("passes the :memory: sentinel through instead of treating it as a path", () => {
    // The trap this pins: ":memory:" is sqlite's in-memory sentinel, and any
    // path handling (join, resolve, dirname+mkdir) would turn it into a file
    // named ":memory:" on disk — a store that looks fine and persists nothing
    // where the caller asked for no persistence at all.
    expect(hubDbPath({ HUB_DB: ":memory:" } as NodeJS.ProcessEnv)).toBe(":memory:");
  });

  it("puts hub.db under MPAI_HOME when HUB_DB is unset", () => {
    expect(hubDbPath({ MPAI_HOME: "/custom" } as NodeJS.ProcessEnv)).toBe("/custom/hub.db");
  });

  it("falls back to the ~/.mpai dotdir when neither is set", () => {
    // Same dotdir/override convention as §8.3's machine.json (spec §8a.2), so
    // one MPAI_HOME moves identity and store together.
    expect(hubDbPath({} as NodeJS.ProcessEnv)).toBe(
      path.join(os.homedir(), ".mpai", "hub.db"),
    );
  });

  it("prefers HUB_DB over MPAI_HOME when both are set", () => {
    expect(
      hubDbPath({ HUB_DB: "/x/y.db", MPAI_HOME: "/custom" } as NodeJS.ProcessEnv),
    ).toBe("/x/y.db");
  });

  it("treats an empty override as unset rather than as a path", () => {
    // `HUB_DB=` / `MPAI_HOME=` in a .env or a shell export yields "", which is
    // not a usable path: returning it verbatim would hand sqlite "" and
    // joining it would resolve hub.db against the process cwd. Same guard
    // machineIdentity.mpaiHome() uses (`env.MPAI_HOME.length > 0`).
    const home = path.join(os.homedir(), ".mpai", "hub.db");
    expect(hubDbPath({ HUB_DB: "" } as NodeJS.ProcessEnv)).toBe(home);
    expect(hubDbPath({ MPAI_HOME: "" } as NodeJS.ProcessEnv)).toBe(home);
    expect(hubDbPath({ HUB_DB: "", MPAI_HOME: "/custom" } as NodeJS.ProcessEnv)).toBe(
      "/custom/hub.db",
    );
  });

  it("reads only the env it is given, never process.env", () => {
    // The function is pure so tests and the daemon can disagree about the
    // environment. A process.env read inside would make {} return the
    // developer's real HUB_DB and pass this suite by accident.
    const saved = { HUB_DB: process.env.HUB_DB, MPAI_HOME: process.env.MPAI_HOME };
    process.env.HUB_DB = "/leaked/from/process.db";
    process.env.MPAI_HOME = "/leaked";
    try {
      expect(hubDbPath({} as NodeJS.ProcessEnv)).toBe(
        path.join(os.homedir(), ".mpai", "hub.db"),
      );
      expect(hubDbPath({ MPAI_HOME: "/custom" } as NodeJS.ProcessEnv)).toBe(
        "/custom/hub.db",
      );
    } finally {
      if (saved.HUB_DB === undefined) delete process.env.HUB_DB;
      else process.env.HUB_DB = saved.HUB_DB;
      if (saved.MPAI_HOME === undefined) delete process.env.MPAI_HOME;
      else process.env.MPAI_HOME = saved.MPAI_HOME;
    }
  });
});

describe("storeLogLine", () => {
  // Boot observability only (plan-level house convention, not a spec §3.1
  // requirement) — but the strings are asserted character-exact, because the
  // whole point of the line is that an operator can tell a persisted store
  // from an in-memory one at a glance.
  it("names the no-dbPath case as in-memory", () => {
    expect(storeLogLine(undefined)).toBe("hub store: in-memory (no dbPath)");
  });

  it("distinguishes the :memory: sentinel from the no-dbPath case", () => {
    expect(storeLogLine(":memory:")).toBe("hub store: in-memory");
  });

  it("reports the sqlite file path when one is configured", () => {
    expect(storeLogLine("/x/y.db")).toBe("hub store: sqlite /x/y.db");
    expect(storeLogLine("/custom/hub.db")).toBe("hub store: sqlite /custom/hub.db");
  });
});
