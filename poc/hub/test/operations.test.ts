import { afterEach, describe, expect, it, vi } from "vitest";
import { startHub, type RunningHub } from "../src/hub.js";
import { HubDb } from "../src/hubDb.js";
import { HubStore } from "../src/hubStore.js";
import type { LoggedEvent } from "multiplayer-ai-server/events";

/** Every DB and hub this file opens, torn down after each test so a failing
 *  assertion never strands an open handle or a listening port. */
const openDbs: HubDb[] = [];
let closeHub: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHub?.();
  closeHub = undefined;
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // Best-effort: the hub's close() may already have closed a seam db.
    }
  }
  vi.restoreAllMocks();
});

function memDb(): HubDb {
  const db = new HubDb(":memory:");
  openDbs.push(db);
  return db;
}

async function hubOn(opts: Parameters<typeof startHub>[0]): Promise<RunningHub> {
  const hub = await startHub(opts);
  closeHub = hub.close;
  return hub;
}

/** A monotonic ISO timestamp `s` seconds past a fixed epoch — lexicographic
 *  order equals chronological order, which is exactly what the prune relies on. */
const isoAt = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

/** One `LoggedEvent` at seq `s`, timestamped `isoAt(s)`. */
const eventAt = (s: number): LoggedEvent =>
  ({ type: "user_message", seq: s, ts: isoAt(s), userId: "ana", text: "x" }) as unknown as LoggedEvent;

/** Attaches one machine and publishes `count` events (seq 0..count-1) into one
 *  session, so the record holds ids 1..count with monotonically increasing ts. */
function seedSession(db: HubDb, count: number): HubStore {
  const store = new HubStore(db);
  store.attach("lap-1", "acme", "lap-1", [], isoAt(0));
  store.publish(
    "lap-1",
    "auth",
    "run-a",
    Array.from({ length: count }, (_, i) => eventAt(i)),
  );
  return store;
}

describe("retention — id continuity after a prune (THE TRAP, spec B1)", () => {
  it("a publish after a prune gets max-stored-id + 1, never events.length + 1", () => {
    const db = memDb();
    seedSession(db, 100); // ids 1..100, seqs 0..99, lastSeq 99

    // Prune ids 1..50 (seqs 0..49): their ts is strictly < isoAt(50).
    expect(db.pruneEventsBefore(isoAt(50))).toBe(50);

    // A restarted hub hydrates from the pruned record. `nextEventId` must seed
    // from the max SURVIVING id (100) + 1, not the surviving COUNT (50) + 1.
    const restarted = new HubStore(db, db.load());
    const accepted = restarted.publish("lap-1", "auth", "run-a", [eventAt(100)]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.id).toBe(101); // NOT 51 — 51 would collide with a survivor
  });

  it("the new id is durable — no PRIMARY KEY collision reaches the persister", () => {
    const db = memDb();
    seedSession(db, 100);
    db.pruneEventsBefore(isoAt(50));

    const restarted = new HubStore(db, db.load());
    // If nextEventId regressed to 51, `eventsAppended` would INSERT id 51 over a
    // surviving row and the persister would THROW — a fatal crash-loop. It must
    // not.
    expect(() => restarted.publish("lap-1", "auth", "run-a", [eventAt(100)])).not.toThrow();
    // And the write really landed: reloading shows id 101 among the survivors.
    const ids = db.load().sessions[0]?.events.map((e) => e.id);
    expect(ids?.[ids.length - 1]).toBe(101);
  });

  it("replay after a prune returns only surviving events, with no error", () => {
    const db = memDb();
    seedSession(db, 100);
    db.pruneEventsBefore(isoAt(50));

    const restarted = new HubStore(db, db.load());
    const replay = restarted.eventsFor("acme", "auth", 0);
    expect(replay.map((e) => e.id)).toEqual(Array.from({ length: 50 }, (_, i) => 51 + i));
  });

  it("resume offsets are unchanged by a prune — no re-send storm (keyed on run/seq)", () => {
    const db = memDb();
    const before = seedSession(db, 100).resumeOffsets("lap-1");
    expect(before).toEqual({ auth: { runId: "run-a", lastSeq: 99 } });

    db.pruneEventsBefore(isoAt(50));
    const restarted = new HubStore(db, db.load());
    expect(restarted.resumeOffsets("lap-1")).toEqual(before);
  });

  it("a fresh session with no prune still numbers events from 1", () => {
    const db = memDb();
    const store = seedSession(db, 3);
    expect(store.eventsFor("acme", "auth", 0).map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe("retention — boot-time prune wiring (spec B1)", () => {
  const NOW = Date.UTC(2026, 6, 20, 0, 0, 0); // 2026-07-20T00:00:00Z

  /** Seeds two OLD events (ids 1,2) and one RECENT event (id 3) so a
   *  30-day cutoff prunes exactly the two old ones. */
  function seedForBoot(db: HubDb): void {
    const store = new HubStore(db);
    store.attach("lap-1", "acme", "lap-1", [], "2026-06-01T00:00:00.000Z");
    store.publish("lap-1", "auth", "run-a", [
      { type: "user_message", seq: 0, ts: "2026-06-01T00:00:00.000Z", userId: "ana", text: "x" },
      { type: "user_message", seq: 1, ts: "2026-06-05T00:00:00.000Z", userId: "ana", text: "x" },
      { type: "user_message", seq: 2, ts: "2026-07-15T00:00:00.000Z", userId: "ana", text: "x" },
    ] as unknown as LoggedEvent[]);
  }

  it("opt-in OFF (retentionDays undefined) never prunes — the record is kept forever", async () => {
    const db = memDb();
    seedForBoot(db);
    const pruneSpy = vi.spyOn(db, "pruneEventsBefore");

    await hubOn({ port: 0, host: "127.0.0.1", db });

    expect(pruneSpy).not.toHaveBeenCalled();
    expect(db.load().sessions[0]?.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("prunes rows older than the cutoff at boot, keeping newer ones", async () => {
    const db = memDb();
    seedForBoot(db);

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    // cutoff = NOW - 30d = 2026-06-20; ids 1,2 (June 1 & 5) go, id 3 (Jul 15) stays.
    expect(db.load().sessions[0]?.events.map((e) => e.id)).toEqual([3]);
  });

  it("runs the prune BEFORE load() so memory hydrates from the already-pruned record", async () => {
    const db = memDb();
    seedForBoot(db);
    const pruneSpy = vi.spyOn(db, "pruneEventsBefore");
    const loadSpy = vi.spyOn(db, "load");

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    expect(pruneSpy).toHaveBeenCalledTimes(1);
    expect(pruneSpy.mock.invocationCallOrder[0]).toBeLessThan(loadSpy.mock.invocationCallOrder[0]!);
  });

  it("computes the cutoff as now() - days*86_400_000, ISO-formatted", async () => {
    const db = memDb();
    seedForBoot(db);
    const pruneSpy = vi.spyOn(db, "pruneEventsBefore");

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    expect(pruneSpy).toHaveBeenCalledWith(new Date(NOW - 30 * 86_400_000).toISOString());
  });

  it("prints one boot log line naming the rows pruned and the window", async () => {
    const db = memDb();
    seedForBoot(db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 30, now: () => NOW });

    expect(logSpy).toHaveBeenCalledWith("retention: pruned 2 event row(s) older than 30d");
  });

  it("still prints the boot log line when 0 rows were pruned", async () => {
    const db = memDb();
    seedForBoot(db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // A 1000-day window is older than anything seeded, so nothing is pruned.
    await hubOn({ port: 0, host: "127.0.0.1", db, retentionDays: 1000, now: () => NOW });

    expect(logSpy).toHaveBeenCalledWith("retention: pruned 0 event row(s) older than 1000d");
  });
});
