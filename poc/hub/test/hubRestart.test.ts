import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RelaySocket } from "multiplayer-ai-server/relay";
import type { SessionFacts } from "multiplayer-ai-server/relayProtocol";
import { Session } from "multiplayer-ai-server/session";
import { startHub, type RunningHub } from "../src/hub.js";
import { HubDb } from "../src/hubDb.js";
import {
  browserReplay,
  collect,
  connect,
  decl,
  laptop,
  relayConnector,
  replayOnceAtLeast,
  snapshotVia,
  wait,
} from "./helpers/uplinkHarness.js";

/** The record across a hub's death, end to end (spec §3.5, §7).
 *
 *  WHY THIS FILE EXISTS, and why it is not in `hubBoot.test.ts`. That file
 *  proves `startHub` reads and writes the record it was pointed at, driving the
 *  uplink with hand-written frames. Neither it nor `hubDb.test.ts` can express
 *  the claim the product is actually sold on: a hub goes away, comes back, and
 *  the team's history is still there — including the parts that depend on the
 *  REAL laptop being on the other end. `welcome.have` is the sharpest example:
 *  the hub answers it out of the record, and only the real `relay.ts` decides
 *  what to replay from it. A hub that came back empty and a laptop that
 *  re-sends everything each produce a green suite on their own side; together
 *  they hand every browser a duplicated transcript.
 *
 *  So every scenario below runs a real `startHub` on a real port with a real
 *  SQLite file, drives it with the real `Relay` through the Task 5 harness, and
 *  reads the answers back the way a teammate's browser does. Determinism comes
 *  from polling to a deadline and from watching the laptop's own socket close,
 *  never from a sleep standing in for an assertion.
 *
 *  PURE TEST FILE. Everything it exercises is Task 4's and Task 7's; a gap
 *  found here is a defect there, not something to patch from this side. */

/** Generous, because every wait below is a poll-to-deadline: a green run
 *  finishes in a fraction of it, and a red one wants room to produce the real
 *  assertion failure instead of a timeout that names nothing. */
const TIMEOUT = 30_000;

/** The first life's events, the ones appended while the hub is down, and the
 *  whole log the record must end up holding. */
const EVENTS = ["one", "two", "three"];
const GAP = ["four", "five"];
const ALL = [...EVENTS, ...GAP];

const INTENT = "ship the record";
const REFUSAL = {
  type: "error",
  message: 'no machine is running session "auth" right now',
};

const factsFor = (intent: string): SessionFacts => ({
  id: "auth",
  participants: ["ana"],
  driverName: "ana",
  intent,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: "github.com/acme/api",
  lifecycle: "open",
});

const hubs: RunningHub[] = [];
const relays: { stop(): void }[] = [];
const dbs: HubDb[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // Relays FIRST. One left running past a FAILED assertion keeps its 40ms
  // reconnect timer alive for the rest of the file and walks into whatever port
  // the next scenario is handed — a red run would then corrupt the runs after
  // it, which is the one thing a seam net must never do.
  for (const relay of relays.splice(0)) relay.stop();
  for (const hub of hubs.splice(0)) {
    try {
      await hub.close();
    } catch {
      // A scenario may have closed this one itself; teardown is best-effort.
    }
  }
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // `HubDb.close()` is idempotent, and a hub that owned the handle has
      // already closed it. Either way there is nothing to do about a throw here.
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A record path inside a fresh temp dir — nothing exists there yet. Named
 *  `hub.db` because the lock error under test quotes the basename. */
function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubrestart-"));
  dirs.push(dir);
  return path.join(dir, "hub.db");
}

async function hubOn(opts: Parameters<typeof startHub>[0]): Promise<RunningHub> {
  const hub = await startHub(opts);
  hubs.push(hub);
  return hub;
}

/** Close now, and drop it from the teardown list so `afterEach` does not close
 *  an already-stopped server (which rejects with ERR_SERVER_NOT_RUNNING). */
async function closeNow(hub: RunningHub): Promise<void> {
  const at = hubs.indexOf(hub);
  if (at >= 0) hubs.splice(at, 1);
  await hub.close();
}

function openDb(dbPath: string, opts?: { skipLock?: boolean }): HubDb {
  const db = new HubDb(dbPath, opts);
  dbs.push(db);
  return db;
}

function own<T extends { relay: { stop(): void } }>(lap: T): T {
  relays.push(lap.relay);
  return lap;
}

/** Poll the project view until it satisfies `predicate`, then hand it back —
 *  and on give-up hand back whatever it ACTUALLY held, so the caller's
 *  assertion names the difference instead of a timeout naming nothing. */
async function snapshotUntil(
  port: number,
  type: "peek" | "watch_project",
  predicate: (snap: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 8000;
  let snap = await snapshotVia(port, type);
  while (Date.now() < deadline && !(snap && predicate(snap))) {
    await wait(25);
    snap = await snapshotVia(port, type);
  }
  return snap;
}

/** The project directory as a browser reads it. */
async function projectsSeenBy(port: number): Promise<any[]> {
  const ws = await connect(`ws://127.0.0.1:${port}/`);
  const seen: any[] = [];
  collect(ws, seen);
  ws.send(JSON.stringify({ type: "list_projects" }));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !seen.some((m) => m.type === "projects")) await wait(10);
  ws.close();
  return seen.find((m) => m.type === "projects")?.projects ?? [];
}

/** EVERYTHING the hub says back to a browser that tries to join — not just the
 *  events, because the answer under test here is a refusal, and an empty event
 *  list is exactly what a broken hub would also produce. */
async function joinAttempt(port: number, sessionId = "auth"): Promise<any[]> {
  const ws = await connect(`ws://127.0.0.1:${port}/`);
  const seen: any[] = [];
  collect(ws, seen);
  ws.send(
    JSON.stringify({ type: "join", sessionId, projectId: "default", userId: "ana", name: "ana" }),
  );
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !seen.some((m) => m.type === "project" || m.type === "error")) {
    await wait(10);
  }
  ws.close();
  return seen;
}

/** Wait for `n` events to be visible, then pause and read ONE more time.
 *  `replayOnceAtLeast` returns the instant the count is reached, so a duplicate
 *  arriving a moment later would be invisible to it — and "exactly once, no
 *  duplicates" is the claim these scenarios make. */
async function settledReplay(port: number, n: number): Promise<any[]> {
  await replayOnceAtLeast(port, n);
  await wait(200);
  return browserReplay(port);
}

/** The uplink's wire with BOTH directions recorded. `relayConnector` hands back
 *  the real socket; this wraps its `send` so the frames the laptop writes are
 *  observable, and adds a second `message` listener so the `welcome` the hub
 *  answers with is too. Neither is reachable from `Relay`'s public surface, and
 *  "carried the stored offsets" / "replayed only the gap" are claims about
 *  exactly those frames. */
function sniffedWire(url: string): {
  connect: () => RelaySocket;
  sent: any[];
  received: any[];
  sockets: WebSocket[];
} {
  const inner = relayConnector(url);
  const sent: any[] = [];
  const received: any[] = [];
  const connect = (): RelaySocket => {
    const socket = inner.connect();
    // Registered BEFORE `Relay` registers its own, which is why a `welcome`
    // showing up in `received` does not yet mean the relay has acted on it.
    // Every assertion below therefore waits on an OUTCOME, not on this array.
    inner.sockets[inner.sockets.length - 1]!.on("message", (raw) =>
      received.push(JSON.parse(raw.toString())),
    );
    return {
      ...socket,
      send: (data: string) => {
        sent.push(JSON.parse(data));
        socket.send(data);
      },
    };
  };
  return { connect, sent, received, sockets: inner.sockets };
}

/** One laptop's first life on a hub: attached, facts declared, `EVENTS`
 *  published — and every one of those confirmed DURABLE from a browser's side
 *  before the hub is allowed to die. Without that confirmation a restart
 *  scenario can pass by racing the writes instead of surviving them. */
async function firstLife(port: number): Promise<{ relay: { stop(): void } }> {
  const session = new Session("auth");
  const lap = own(laptop(port, { newRunId: () => "run-1" }));
  lap.relay.trackSession("auth", session);
  lap.relay.start();
  lap.relay.publishFacts("auth", factsFor(INTENT));
  for (const text of EVENTS) {
    lap.relay.publishEvent("auth", session.append({ type: "intent_update", text }));
  }
  expect((await replayOnceAtLeast(port, EVENTS.length)).map((e: any) => e.text)).toEqual(EVENTS);
  const live = await snapshotUntil(port, "peek", (s) =>
    s.sessions.some((x: any) => x.intent === INTENT),
  );
  expect(live.sessions.map((x: any) => x.presence)).toEqual(["online"]);
  expect(live.machines.map((m: any) => m.online)).toEqual([true]);
  return { relay: lap.relay };
}

/** What a browser reads from a hub whose record survived but whose laptop has
 *  not come back. Shared by the restart and the crash rows because it is one
 *  claim in three parts: the project and its session are all still there, the
 *  machine reads offline, and the hub REFUSES a join rather than answering it
 *  with an empty transcript. */
async function expectOfflineContinuity(port: number): Promise<void> {
  const projects = await projectsSeenBy(port);
  expect(projects.map((p: any) => p.id)).toEqual(["default"]);
  expect(projects[0].sessionCount).toBe(1);
  // The machine the record remembers, with the repo set it declared — and
  // `online: false`, because attachment is runtime state that no restart can
  // inherit (spec §3.3).
  expect(projects[0].machines).toEqual([
    { machineId: "lap-1", name: "lap", online: false, repos: [decl("github.com/acme/api")] },
  ]);

  expect(await joinAttempt(port)).toEqual([REFUSAL]);

  // Refused to JOIN, still listed to WATCH: that asymmetry is the whole payoff
  // of a hub-side record (spec §7). The facts are the laptop's own, verbatim.
  const snap = await snapshotVia(port, "watch_project");
  expect(snap.sessions).toHaveLength(1);
  expect(snap.sessions[0]).toMatchObject({
    id: "auth",
    intent: INTENT,
    presence: "offline",
    machineId: "lap-1",
    repoKey: "github.com/acme/api",
    lifecycle: "open",
    participants: ["ana"],
    driverName: "ana",
  });
  expect(snap.machines.map((m: any) => m.online)).toEqual([false]);
}

describe("the record across a hub restart", () => {
  it("boots the project, its session and its facts back out of the same file, with everything offline and unjoinable", async () => {
    const dbPath = tmpDbPath();
    const first = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    const lived = await firstLife(first.port);

    // The laptop goes FIRST and the restarted hub gets a fresh ephemeral port,
    // so no uplink can possibly re-attach: everything the reads below see came
    // out of the record and nowhere else.
    lived.relay.stop();
    await closeNow(first);
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);

    const second = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    // The restarted hub owns the record now, which is the other half of "the
    // first one really did let go".
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));

    await expectOfflineContinuity(second.port);
  }, TIMEOUT);

  it("resumes from the stored offsets: welcome.have names the run, the laptop replays only the gap, and a browser sees every event exactly once", async () => {
    // The one claim neither side's own suite can make. The hub answers `have`
    // from the record; only the real `relay.ts` decides what to replay from it.
    // A hub that came back empty and a laptop that re-sends its whole log each
    // look correct alone, and together they hand every browser the first three
    // events twice.
    const dbPath = tmpDbPath();
    const first = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    const port = first.port;

    const session = new Session("auth");
    const wire = sniffedWire(`ws://127.0.0.1:${port}/uplink`);
    const lap = own(laptop(port, { connect: wire.connect, newRunId: () => "run-1" }));
    lap.relay.trackSession("auth", session);
    lap.relay.start();
    lap.relay.publishFacts("auth", factsFor(INTENT));
    for (const text of EVENTS) {
      lap.relay.publishEvent("auth", session.append({ type: "intent_update", text }));
    }
    expect((await replayOnceAtLeast(port, EVENTS.length)).map((e: any) => e.text)).toEqual(EVENTS);
    await snapshotUntil(port, "peek", (s) => s.sessions.some((x: any) => x.intent === INTENT));

    // The hub dies. Waited for at the LAPTOP's socket rather than on a sleep,
    // because the gap events below have to be appended while the uplink is
    // genuinely down — written into a still-open socket they are not a gap at
    // all, and this test would then prove nothing about resume.
    const attached = wire.sockets[0]!;
    await closeNow(first);
    await new Promise<void>((resolve) => {
      if (attached.readyState === WebSocket.CLOSED) resolve();
      else attached.once("close", () => resolve());
    });
    await wait(20);

    wire.sent.length = 0;
    wire.received.length = 0;
    for (const text of GAP) {
      lap.relay.publishEvent("auth", session.append({ type: "intent_update", text }));
    }
    // Buffered by the relay, not written: nothing reached a socket while the
    // hub was down, so every frame counted below belongs to the reconnect.
    expect(wire.sent).toEqual([]);

    // Same address, same file, new process.
    await hubOn({ port, host: "127.0.0.1", dbPath });
    const stored = await settledReplay(port, ALL.length);

    // Straight out of the record: the run the laptop is on, and the last seq
    // the dead hub had actually committed.
    expect(wire.received.find((f) => f.t === "welcome")?.have).toEqual({
      auth: { runId: "run-1", lastSeq: EVENTS.length - 1 },
    });
    // The gap and nothing else.
    expect(
      wire.sent
        .filter((f) => f.t === "publish")
        .flatMap((f: any) => f.events.map((e: any) => e.seq)),
    ).toEqual([3, 4]);

    // And what a joining teammate reads: the whole log, once, in order.
    expect(stored.map((e: any) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(stored.map((e: any) => e.text)).toEqual(ALL);
  }, TIMEOUT);

  it("survives a crash: a second hub on the abandoned file still holds every committed event", async () => {
    // A killed hub, not a closed one — the first hub is never closed and its
    // lock is deliberately still on disk, so the second hub comes up on the
    // named crash stand-in: a `HubDb` opened with `{ skipLock: true }`, handed
    // in through `startHub`'s `db` seam. WAL is what makes "committed" survive
    // that (hubDb.ts), and nothing below the wire can demonstrate it.
    const dbPath = tmpDbPath();
    const crashed = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    await firstLife(crashed.port);

    // No close, and no relay stop: the lock is still held, by this very
    // process, exactly as a killed hub would have left it.
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));

    const crashDb = openDb(dbPath, { skipLock: true });
    const revived = await hubOn({ port: 0, host: "127.0.0.1", db: crashDb });
    // The abandoned hub is genuinely still up. If it were not, this row would
    // be the restart row wearing a different name.
    expect((await fetch(`http://127.0.0.1:${crashed.port}/healthz`)).status).toBe(200);

    await expectOfflineContinuity(revived.port);

    // Committed events all present. The owner comes back on the revived hub
    // holding an EMPTY log, so every event the browser replays below came out
    // of the record rather than off the laptop — which is also why the resumed
    // laptop publishes nothing: `welcome.have` already covers what it has.
    const back = own(laptop(revived.port, { newRunId: () => "run-1" }));
    back.relay.trackSession("auth", new Session("auth"));
    back.relay.start();

    const stored = await settledReplay(revived.port, EVENTS.length);
    expect(stored.map((e: any) => e.seq)).toEqual([0, 1, 2]);
    expect(stored.map((e: any) => e.text)).toEqual(EVENTS);
  }, TIMEOUT);

  it("refuses a second hub on a record a live hub already holds, naming the pid that holds it", async () => {
    const dbPath = tmpDbPath();
    const live = await hubOn({ port: 0, host: "127.0.0.1", dbPath });
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));

    // Rejected BEFORE anything is served, and the message names the holder —
    // an operator staring at two `mpai hub` invocations has nothing else to go
    // on. Captured rather than matched with `rejects.toThrow` so the pid can be
    // asserted exactly instead of as "some digits".
    const refusal = await startHub({ port: 0, host: "127.0.0.1", dbPath }).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(refusal?.message).toBe(
      `hub.db is in use by pid ${process.pid} — refusing to start`,
    );

    // The live hub is untouched by the refused boot: still serving, still
    // holding the record.
    expect((await fetch(`http://127.0.0.1:${live.port}/healthz`)).status).toBe(200);
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.pid));

    // Non-vacuous, permanently: the crash seam — and only the crash seam — gets
    // past that lock. Without this leg the row would pass just as well against
    // a `startHub` that refused every record it was ever handed.
    const seam = await hubOn({ port: 0, host: "127.0.0.1", db: openDb(dbPath, { skipLock: true }) });
    expect(seam.port).toBeGreaterThan(0);
    expect(await projectsSeenBy(seam.port)).toEqual([]);
  }, TIMEOUT);
});
