import { describe, it, expect, vi } from "vitest";
import { Project, projectSnapshot, SLUG } from "../src/project.js";
import { Session } from "../src/session.js";
import { AgentDriver, type RunQuery } from "../src/agentDriver.js";

const idleRun: RunQuery = async function* (prompts) {
  for await (const _p of prompts) {
    /* never yields; stays alive */
  }
};

function addSession(
  project: Project,
  id: string,
  skills: { name: string; description: string }[] = [],
): Session {
  const session = new Session(id);
  project.sessions.set(id, { session, driver: new AgentDriver(session, idleRun), skills, pendingSuggests: new Map() });
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

  it("includes each session's skill roster in the snapshot", () => {
    const project = new Project("demo");
    addSession(project, "ana", [{ name: "auth-migration-guide", description: "Migrate cookie auth to JWT." }]);
    addSession(project, "ben");
    const snap = projectSnapshot(project);
    expect(snap.sessions.find((s) => s.id === "ana")!.skills).toEqual([
      { name: "auth-migration-guide", description: "Migrate cookie auth to JWT." },
    ]);
    expect(snap.sessions.find((s) => s.id === "ben")!.skills).toEqual([]);
  });
});

describe("arcade records", () => {
  it("keeps the best score per game across sessions and survives the holder leaving", () => {
    const project = new Project("demo");
    const ana = addSession(project, "ana");
    ana.join("u1", "Ana", { glyph: "▲", color: "#ff0000" });
    ana.append({ type: "game_score", userId: "u1", game: "dino", score: 120 });
    const ben = addSession(project, "ben");
    ben.join("u2", "Ben");
    ben.append({ type: "game_score", userId: "u2", game: "dino", score: 90 });
    ben.append({ type: "game_score", userId: "u2", game: "snake", score: 40 });
    ana.leave("u1"); // record must outlive the holder's presence

    const snap = projectSnapshot(project);
    expect(snap.arcade).toHaveLength(2);
    const dino = snap.arcade.find((r) => r.game === "dino")!;
    expect(dino).toMatchObject({ score: 120, userId: "u1", name: "Ana", glyph: "▲", color: "#ff0000" });
    const snake = snap.arcade.find((r) => r.game === "snake")!;
    expect(snake).toMatchObject({ score: 40, userId: "u2", name: "Ben" });
    expect(snake.glyph).toBeUndefined(); // no glyph sent — client falls back
  });

  it("skips malformed game_score events instead of crashing", () => {
    const project = new Project("demo");
    const ana = addSession(project, "ana");
    ana.join("u1", "Ana");
    ana.append({ type: "game_score", userId: "u1", game: "dino", score: 2.5 } as never);
    ana.append({ type: "game_score", userId: "u1", game: "dino", score: -5 } as never);
    expect(projectSnapshot(project).arcade).toEqual([]);
  });

  it("breaks ties chronologically across sessions, not by iteration order", () => {
    vi.useFakeTimers();
    try {
      const project = new Project("demo");
      const ana = addSession(project, "ana");
      ana.join("u1", "Ana");

      // Ana scores 100 at timestamp 1000
      vi.setSystemTime(1000);
      ana.append({ type: "game_score", userId: "u1", game: "dino", score: 100 });

      // Later session Ben created, but scores 100 (tie) at timestamp 500 (earlier)
      vi.setSystemTime(500);
      const ben = addSession(project, "ben");
      ben.join("u2", "Ben");
      ben.append({ type: "game_score", userId: "u2", game: "dino", score: 100 });

      const snap = projectSnapshot(project);
      const dino = snap.arcade.find((r) => r.game === "dino")!;
      // Ben's score has earlier timestamp (500 < 1000), so Ben should win the tie
      expect(dino).toMatchObject({ userId: "u2", name: "Ben", score: 100 });
    } finally {
      vi.useRealTimers();
    }
  });
});
