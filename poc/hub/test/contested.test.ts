import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TOUCH_CAP, TOUCH_SENTINEL } from "multiplayer-ai-server/collisions";
import type { ContestedFrame } from "multiplayer-ai-server/relay";
import { RELAY_PROTOCOL_VERSION, type SessionFacts } from "multiplayer-ai-server/relayProtocol";
import { Session } from "multiplayer-ai-server/session";
import { startHub, type RunningHub } from "../src/hub.js";
import { collect, connect, decl, laptop, snapshotVia, wait } from "./helpers/uplinkHarness.js";

/** The hub's `contested` producer (spec §6a as amended by §8a ruling 6): on
 *  every throttled project push the hub intersects its sessions' `touched` sets
 *  and tells each OWNING laptop what its own session is contesting, with whom.
 *
 *  WHY THIS FILE RUNS REAL HUBS AND REAL UPLINKS. Only the hub sees every
 *  laptop, so this frame is the only way a hub-attached laptop can name a peer
 *  it cannot see — which makes "was it actually written down the owning uplink,
 *  and did it survive the wire contract" the whole claim. Every scenario below
 *  therefore starts a real `startHub` on a real port and drives it with the
 *  real `Relay` through the uplink harness, so each frame asserted on has been
 *  through `parseDownFrame` and landed in the harness's `onContested` sink —
 *  the stand-in for `server.ts`'s own consumer. A producer that emitted a shape
 *  the validator rejects would deliver nothing here, and the row would fail.
 *
 *  Determinism comes from polling to a deadline and from proving a PUSH ran
 *  (a browser can see the new intent) before asserting that no frame followed
 *  it — never from a sleep standing in for an assertion. */

const TIMEOUT = 30_000;
const REPO = "github.com/acme/api";
const SHARED = "src/shared.ts";

const hubs: RunningHub[] = [];
const relays: { stop(): void }[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  // Relays FIRST, for the reason `hubRestart.test.ts` gives: one left running
  // past a failed assertion keeps its 40ms reconnect timer alive and walks into
  // whatever port the next scenario is handed.
  for (const relay of relays.splice(0)) relay.stop();
  for (const socket of sockets.splice(0)) socket.close();
  for (const hub of hubs.splice(0)) {
    try {
      await hub.close();
    } catch {
      // A scenario may have closed this one itself; teardown is best-effort.
    }
  }
});

async function hubOn(): Promise<RunningHub> {
  const hub = await startHub({ port: 0, host: "127.0.0.1" });
  hubs.push(hub);
  return hub;
}

const factsFor = (
  id: string,
  touched: string[] | null,
  over: Partial<SessionFacts> = {},
): SessionFacts => ({
  id,
  participants: ["ana"],
  driverName: "ana",
  intent: null,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: REPO,
  touched,
  lifecycle: "open",
  ...over,
});

/** One attached laptop owning one session with a declared `touched` set — the
 *  precondition of every row here. The relay is registered for teardown before
 *  it is started, so a failing assertion can never leave one reconnecting. */
function attach(
  port: number,
  opts: { uplinkId: string; sessionId: string; touched: string[]; facts?: Partial<SessionFacts> },
) {
  const lap = laptop(port, { uplinkId: opts.uplinkId, newRunId: () => `run-${opts.uplinkId}` });
  relays.push(lap.relay);
  const session = new Session(opts.sessionId);
  lap.relay.trackSession(opts.sessionId, session);
  lap.relay.start();
  lap.relay.publishFacts(opts.sessionId, factsFor(opts.sessionId, opts.touched, opts.facts));
  return { ...lap, session };
}

/** Poll a live value until it satisfies `ok`, then hand back whatever it
 *  ACTUALLY held — so the caller's own assertion names the difference rather
 *  than a timeout naming nothing. */
async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = read();
  while (Date.now() < deadline && !ok(value)) {
    await wait(20);
    value = read();
  }
  return value;
}

async function snapshotUntil(port: number, ok: (snap: any) => boolean): Promise<any> {
  const deadline = Date.now() + 8000;
  let snap = await snapshotVia(port, "peek");
  while (Date.now() < deadline && !(snap && ok(snap))) {
    await wait(25);
    snap = await snapshotVia(port, "peek");
  }
  return snap;
}

const sessionIn = (snap: any, sessionId: string) =>
  snap?.sessions?.find((s: any) => s.id === sessionId);

/** Re-declare the same `touched` under a new intent and wait until a browser
 *  can SEE it. That sighting is proof a `pushProject` ran with the collision
 *  set unchanged — which is what every "and no frame followed" assertion below
 *  needs, and what a bare sleep could never establish. */
async function pushWithoutChangingCollisions(
  port: number,
  lap: { relay: { publishFacts: (id: string, facts: SessionFacts) => void } },
  sessionId: string,
  touched: string[],
  mark: string,
): Promise<void> {
  lap.relay.publishFacts(sessionId, factsFor(sessionId, touched, { intent: mark }));
  const snap = await snapshotUntil(port, (s) => sessionIn(s, sessionId)?.intent === mark);
  expect(sessionIn(snap, sessionId)?.intent).toBe(mark);
}

/** Two laptops, two sessions, one shared path — the state most rows start in,
 *  asserted whole so no row below has to re-establish it. */
async function twoContestingLaptops(port: number) {
  const lapA = attach(port, {
    uplinkId: "lap-1",
    sessionId: "auth",
    touched: ["src/auth.ts", SHARED],
  });
  const lapB = attach(port, {
    uplinkId: "lap-2",
    sessionId: "billing",
    touched: [SHARED, "src/billing.ts"],
  });
  await until(() => lapA.contested.length && lapB.contested.length, (n) => n > 0);
  return { lapA, lapB };
}

const expectedFrame = (sessionId: string): ContestedFrame => ({
  t: "contested",
  sessionId,
  paths: [SHARED],
  collisions: [{ path: SHARED, sessionIds: ["auth", "billing"] }],
});

/** The CLEAR signal: an empty frame. Shared by the two rows that assert one,
 *  so neither can drift into asserting a different shape of "nothing". */
const cleared = (sessionId: string): ContestedFrame => ({
  t: "contested",
  sessionId,
  paths: [],
  collisions: [],
});

describe("the hub's contested producer", () => {
  it("tells each owning laptop which of ITS session's paths another machine is also touching", async () => {
    const hub = await hubOn();
    const { lapA, lapB } = await twoContestingLaptops(hub.port);

    // Each laptop learns about its OWN session — never the peer's — and the
    // peer id is carried per path, because naming who you are contesting with
    // is the whole point of a frame only the hub can produce (spec §6).
    expect(lapA.contested).toEqual([expectedFrame("auth")]);
    expect(lapB.contested).toEqual([expectedFrame("billing")]);
    // `src/auth.ts` and `src/billing.ts` are touched by exactly one session
    // each, so neither is contested and neither travels.
    expect(lapA.contested[0]!.paths).toEqual([SHARED]);
  }, TIMEOUT);

  it("does not repeat the frame while the collision set is unchanged", async () => {
    const hub = await hubOn();
    const { lapA, lapB } = await twoContestingLaptops(hub.port);
    expect(lapA.contested).toHaveLength(1);

    // Two further pushes, each PROVEN to have run by a browser reading the new
    // intent back — and the collision set identical across both.
    await pushWithoutChangingCollisions(hub.port, lapA, "auth", ["src/auth.ts", SHARED], "second");
    await pushWithoutChangingCollisions(hub.port, lapA, "auth", ["src/auth.ts", SHARED], "third");

    expect(lapA.contested).toEqual([expectedFrame("auth")]);
    expect(lapB.contested).toEqual([expectedFrame("billing")]);
  }, TIMEOUT);

  it("clears with empty paths and collisions, exactly once, when the overlap goes away", async () => {
    const hub = await hubOn();
    const { lapA, lapB } = await twoContestingLaptops(hub.port);

    // The overlap disappears from ONE side, which clears it for BOTH.
    lapA.relay.publishFacts("auth", factsFor("auth", ["src/auth.ts"]));
    await until(() => Math.min(lapA.contested.length, lapB.contested.length), (n) => n > 1);

    expect(lapA.contested).toEqual([expectedFrame("auth"), cleared("auth")]);
    expect(lapB.contested).toEqual([expectedFrame("billing"), cleared("billing")]);

    // ONCE: a producer that re-sent the empty frame on every push would turn a
    // quiet project into a once-a-second frame storm down every uplink.
    await pushWithoutChangingCollisions(hub.port, lapA, "auth", ["src/auth.ts"], "after-clear");
    await pushWithoutChangingCollisions(hub.port, lapA, "auth", ["src/auth.ts"], "after-clear-2");
    expect(lapA.contested).toHaveLength(2);
    expect(lapB.contested).toHaveLength(2);
  }, TIMEOUT);

  it("truncates an over-cap contested set after the sort, marks it with the sentinel, and keeps collisions to the retained paths", async () => {
    const hub = await hubOn();
    // Zero-padded so code-unit order is the obvious order, and one MORE than
    // the cap so the truncation is a real one rather than an off-by-one that a
    // cap-sized set would also satisfy.
    const paths = Array.from(
      { length: TOUCH_CAP + 1 },
      (_, i) => `src/f${String(i).padStart(4, "0")}.ts`,
    );
    const lapA = attach(hub.port, { uplinkId: "lap-1", sessionId: "auth", touched: [...paths] });
    attach(hub.port, { uplinkId: "lap-2", sessionId: "billing", touched: [...paths] });

    const frames = await until(() => lapA.contested, (f) => f.length > 0);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    // The producer's promise, and the widest frame the validator admits: a full
    // cap plus the "…and more" sentinel (relayProtocol's `pathList`). That it
    // arrived AT ALL is the proof it stayed inside that bound.
    expect(frame.paths).toHaveLength(TOUCH_CAP + 1);
    expect(frame.paths.slice(0, TOUCH_CAP)).toEqual(paths.slice(0, TOUCH_CAP));
    expect(frame.paths[TOUCH_CAP]).toBe(TOUCH_SENTINEL);
    // Truncated AFTER the sort, so the dropped path is the last one in order —
    // not whichever one a Map happened to yield last.
    expect(frame.paths).not.toContain(paths[TOUCH_CAP]);
    expect(frame.collisions).toHaveLength(TOUCH_CAP);
    expect(frame.collisions.map((c) => c.path)).toEqual(paths.slice(0, TOUCH_CAP));
    expect(frame.collisions[0]).toEqual({ path: paths[0], sessionIds: ["auth", "billing"] });
  }, TIMEOUT);

  it("sends nothing to a laptop whose uplink is offline, and errors on nothing", async () => {
    const hub = await hubOn();
    // `billing` declares its paths and then goes away. Its session — and its
    // `touched` — stay in the hub, which is the whole point of a hub, so it
    // still collides with whatever arrives next.
    const lapB = attach(hub.port, {
      uplinkId: "lap-2",
      sessionId: "billing",
      touched: [SHARED, "src/billing.ts"],
    });
    await snapshotUntil(hub.port, (s) => sessionIn(s, "billing"));
    lapB.relay.stop();
    await snapshotUntil(hub.port, (s) => sessionIn(s, "billing")?.presence === "offline");

    const lapA = attach(hub.port, {
      uplinkId: "lap-1",
      sessionId: "auth",
      touched: ["src/auth.ts", SHARED],
    });
    const frames = await until(() => lapA.contested, (f) => f.length > 0);

    // The online laptop is told everything, including the offline peer's id:
    // an offline session's claim on a file has not gone anywhere.
    expect(frames).toEqual([expectedFrame("auth")]);
    // And the offline one is skipped rather than crashing the push that carried
    // its peer's frame — asserted from the other side too, because a hub that
    // threw here would take every browser and every uplink down with it.
    expect(lapB.contested).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${hub.port}/healthz`)).status).toBe(200);
  }, TIMEOUT);

  it("re-sends the identical frame after its laptop reconnects, and only to that laptop", async () => {
    const hub = await hubOn();
    const { lapA, lapB } = await twoContestingLaptops(hub.port);

    // The collision set never changes across this whole row. An implementation
    // that only compares by value therefore sends nothing after the reconnect
    // and leaves the laptop — which lost its own `entry.contestedFrame` with
    // the process — with no hub-sourced contested state at all.
    lapA.relay.stop();
    await snapshotUntil(hub.port, (s) => sessionIn(s, "auth")?.presence === "offline");
    lapA.relay.start();
    await snapshotUntil(hub.port, (s) => sessionIn(s, "auth")?.presence === "online");

    const frames = await until(() => lapA.contested, (f) => f.length > 1);
    expect(frames).toEqual([expectedFrame("auth"), expectedFrame("auth")]);
    // Scoped to the uplink that left: `billing` never dropped its connection,
    // so purging its change-detection state too would be a frame storm on
    // every unrelated laptop each time one machine reconnects.
    expect(lapB.contested).toEqual([expectedFrame("billing")]);
  }, TIMEOUT);

  it("delivers the clear a laptop missed while its uplink was down, exactly once", async () => {
    const hub = await hubOn();
    const { lapA, lapB } = await twoContestingLaptops(hub.port);

    lapA.relay.stop();
    await snapshotUntil(hub.port, (s) => sessionIn(s, "auth")?.presence === "offline");

    // The overlap goes away WHILE `auth`'s uplink is down: `billing` stops
    // touching the shared file. `lap-2` is online and is told; `lap-1` cannot
    // be told anything at all, and the hub writes nothing down for it.
    lapB.relay.publishFacts(
      "billing",
      factsFor("billing", ["src/billing.ts"], { intent: "cleared-while-down" }),
    );
    await snapshotUntil(hub.port, (s) => sessionIn(s, "billing")?.intent === "cleared-while-down");
    await until(() => lapB.contested.length, (n) => n > 1);
    expect(lapB.contested).toEqual([expectedFrame("billing"), cleared("billing")]);
    expect(lapA.contested).toEqual([expectedFrame("auth")]);

    lapA.relay.start();
    await snapshotUntil(hub.port, (s) => sessionIn(s, "auth")?.presence === "online");

    // The clear this laptop never received. A purge that merely FORGETS the
    // last frame cannot deliver it: the producer's "never contested and still
    // not" shortcut then reads the forgotten session as never-contested and
    // swallows the empty frame forever, leaving the laptop rendering a
    // collision that ended while it was away.
    const frames = await until(() => lapA.contested, (f) => f.length > 1);
    expect(frames).toEqual([expectedFrame("auth"), cleared("auth")]);

    // ONCE, like every other clear — the reconnect buys one unconditional
    // frame, not a permanent exemption from change detection.
    await pushWithoutChangingCollisions(
      hub.port,
      lapA,
      "auth",
      ["src/auth.ts", SHARED],
      "after-reconnect-clear",
    );
    await pushWithoutChangingCollisions(
      hub.port,
      lapA,
      "auth",
      ["src/auth.ts", SHARED],
      "after-reconnect-clear-2",
    );
    expect(lapA.contested).toHaveLength(2);
  }, TIMEOUT);

  it("re-sends after a re-registration that supersedes a live socket, without waiting for the old one to close", async () => {
    const hub = await hubOn();
    const { lapA } = await twoContestingLaptops(hub.port);

    // A second `hello` under the same uplinkId, with the first socket still
    // OPEN — the hub's supersede path (hub.ts's hello handler). The old
    // socket's late close is guarded out and never reaches the disconnect
    // hook, so this row can only pass if the re-registration hook purges on
    // its own.
    const replacement = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    sockets.push(replacement);
    const seen: any[] = [];
    collect(replacement, seen);
    replacement.send(
      JSON.stringify({
        t: "hello",
        v: RELAY_PROTOCOL_VERSION,
        uplinkId: "lap-1",
        name: "lap",
        projectId: "default",
        repos: [decl(REPO)],
      }),
    );

    const frames = await until(
      () => seen.filter((f) => f.t === "contested"),
      (f) => f.length > 0,
    );
    expect(frames).toEqual([expectedFrame("auth")]);
    // Down the NEW socket, not the superseded one.
    expect(lapA.contested).toEqual([expectedFrame("auth")]);
  }, TIMEOUT);

  it("carries a session id, paths and peer session ids — and nothing else about the work", async () => {
    const hub = await hubOn();
    const secret = "TOPSECRET";
    const lapA = attach(hub.port, {
      uplinkId: "lap-1",
      sessionId: "auth",
      touched: ["src/auth.ts", SHARED],
      facts: {
        intent: `${secret}-intent`,
        participants: [`${secret}-ana`],
        driverName: `${secret}-ana`,
      },
    });
    lapA.relay.publishEvent(
      "auth",
      lapA.session.append({ type: "intent_update", text: `${secret}-transcript` }),
    );
    attach(hub.port, { uplinkId: "lap-2", sessionId: "billing", touched: [SHARED] });

    const frames = await until(() => lapA.contested, (f) => f.length > 0);
    expect(frames).toHaveLength(1);
    // The thesis bound (spec §1.1), asserted as an ALLOW-LIST of keys rather
    // than a search for known-bad strings: a field added later that carried
    // prompts would slip past a substring check but not past this.
    expect(Object.keys(frames[0]!).sort()).toEqual(["collisions", "paths", "sessionId", "t"]);
    // And the substring check as well, because the allow-list says nothing
    // about what got stuffed INTO an allowed field.
    expect(JSON.stringify(frames)).not.toContain(secret);
  }, TIMEOUT);
});
