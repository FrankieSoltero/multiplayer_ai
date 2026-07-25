import { describe, it, expect } from "vitest";
import { Project, projectSnapshot, SLUG } from "../src/project.js";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery } from "../src/agentDriver.js";

const idleRun: RunQuery = async function* (prompts) {
  for await (const _p of prompts) {
    /* never yields; stays alive */
  }
};

function addSession(project: Project, id: string): Session {
  const session = new Session(id);
  project.sessions.set(id, { session, driver: new AgentDriver(session, idleRun), skills: [], pendingSuggests: new Map() });
  return session;
}

describe("SLUG", () => {
  it("accepts lowercase slugs and rejects traversal/uppercase/overlong ids", () => {
    expect(SLUG.test("ana-1")).toBe(true);
    expect(SLUG.test("../etc")).toBe(false);
    expect(SLUG.test("Ana")).toBe(false);
    expect(SLUG.test("a".repeat(41))).toBe(false);
    expect(SLUG.test("")).toBe(false);
  });
});

describe("projectSnapshot", () => {
  it("derives participants, driver, intent, lastActivity, ended per session", () => {
    const project = new Project("demo");
    const ana = addSession(project, "ana");
    ana.join("u1", "Ana");
    ana.append({ type: "intent_update", text: "Migrating auth" });
    addSession(project, "ben");

    const snap = projectSnapshot(project);
    expect(snap.type).toBe("project");
    expect(snap.sessions).toHaveLength(2);
    const anaSnap = snap.sessions.find((s) => s.id === "ana")!;
    expect(anaSnap.participants).toEqual(["Ana"]);
    expect(anaSnap.driverName).toBe("Ana");
    expect(anaSnap.intent).toBe("Migrating auth");
    expect(anaSnap.ended).toBe(false);
    expect(typeof anaSnap.lastActivityTs).toBe("string");
    const benSnap = snap.sessions.find((s) => s.id === "ben")!;
    expect(benSnap.intent).toBeNull();
    expect(benSnap.driverName).toBeNull();
    expect(benSnap.lastActivityTs).toBeNull();
  });
});
