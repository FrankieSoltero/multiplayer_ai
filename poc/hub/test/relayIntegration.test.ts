import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  type SessionFacts,
} from "multiplayer-ai-server/relayProtocol";
import { Session } from "multiplayer-ai-server/session";
import { startHub } from "../src/hub.js";
import { decl, wait, connect, collect, relayConnector, laptop, laptopThatAnswers, browserReplay, replayOnceAtLeast, snapshotVia } from "./helpers/uplinkHarness.js";

/** The real laptop against the real hub.
 *
 *  WHY THIS FILE EXISTS. Until it did, `relay.ts` was only ever tested against
 *  a fake hub written by the relay's author and `hub.ts` only ever against a
 *  fake laptop written by the hub's author — so each side was verified against
 *  the other's *expected* behaviour. The one place they disagreed (the relay's
 *  comment claimed the hub "keys on (runId, seq)"; the hub keys on a
 *  per-session high-water mark) was a permanent, silent event-loss bug that
 *  eight task reviews and two fix rounds all passed over. Every scenario below
 *  is one neither side's unit suite can express.
 *
 *  It lives in `poc/hub/test/` because that is the only package that can see
 *  both: the hub depends on `multiplayer-ai-server` through a `file:` link, so
 *  the server's `exports` map reaches `relay` and `session` from here.
 *  `poc/server/test/` has no dependency on the hub and cannot import it.
 *
 *  It drives a real `startHub({ port: 0 })` over loopback rather than wiring
 *  `Relay` straight into a `HubStore`, because two of the three scenarios are
 *  about things that live in `hub.ts` and in the socket layer, not in the
 *  store: `maxPayload` enforcement on the uplink, and the browser plane's
 *  replay. Determinism comes from controlling the RELAY's socket callbacks
 *  (see `relayConnect`) and from polling to a deadline, never from a bare
 *  sleep standing in for an assertion.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** Poll the project view until it satisfies `predicate`, then hand it back —
 *  and on give-up hand back whatever it ACTUALLY held, so the caller's
 *  assertion names the difference instead of a timeout naming nothing. Same
 *  shape, and the same reasoning, as `replayOnceAtLeast` above. */
async function snapshotUntil(
  port: number,
  type: "peek" | "watch_project",
  predicate: (snap: any) => boolean,
  projectId = "default",
): Promise<any | undefined> {
  const deadline = Date.now() + 8000;
  let snap = await snapshotVia(port, type, projectId);
  while (Date.now() < deadline && !(snap && predicate(snap))) {
    await wait(25);
    snap = await snapshotVia(port, type, projectId);
  }
  return snap;
}

/** Wait until a collected message matches, to a deadline. Never asserts: the
 *  caller does, on the whole array, so a miss reports what did arrive. */
async function until(seen: any[], match: (m: any) => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !seen.some(match)) await wait(10);
}

/** Generous, because every assertion below is a poll-to-deadline rather than a
 *  sleep: a green run finishes in a fraction of this, and a red one wants room
 *  to produce the real assertion failure instead of a timeout that names
 *  nothing. */
const TIMEOUT = 30_000;

/** Start a hub whose teardown also stops every relay the scenario registers.
 *
 *  Not tidiness: a relay left running past a FAILED assertion keeps its 40ms
 *  reconnect timer alive for the rest of the file, reconnecting into ports the
 *  next scenario is about to be handed. A red run would then corrupt the runs
 *  after it, which is the one thing a seam net must never do. */
async function hubWithTeardown(): Promise<{
  port: number;
  own: <T extends { relay: { stop(): void } }>(lap: T) => T;
}> {
  const hub = await startHub({ port: 0, host: "127.0.0.1" });
  const relays: { stop(): void }[] = [];
  close = async () => {
    for (const relay of relays) relay.stop();
    await hub.close();
  };
  return {
    port: hub.port,
    own: (lap) => {
      relays.push(lap.relay);
      return lap;
    },
  };
}

/** Identify, join the project, and confirm both landed.
 *
 *  `join_project`, NOT `create_project`: the laptop's `hello` already
 *  `ensureProject`ed `default` — memberless, because attaching a machine is not
 *  joining a project — so a `create_project` here is refused with
 *  `already exists` and the browser never becomes a member. Every routed
 *  command below (`attach_repo`, `detach_repo`, `create_session`) gates on
 *  membership, so a fixture that got this wrong would fail with the hub's own
 *  refusal and look like the seam being broken. The empty-error assertion is
 *  what keeps that from ever being mistaken for the thing under test. */
async function joinAsAna(port: number): Promise<{ browser: WebSocket; seen: any[] }> {
  const browser = await connect(`ws://127.0.0.1:${port}/`);
  const seen: any[] = [];
  collect(browser, seen);
  browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
  browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
  // `join_project` answers by broadcasting the project directory; that is the
  // only signal it succeeded.
  await until(seen, (m) => m.type === "projects");
  expect(seen.filter((m) => m.type === "error")).toEqual([]);
  seen.length = 0;
  return { browser, seen };
}

describe("laptop ↔ hub, real Relay against a real hub", () => {
  it("loses nothing when an event is appended inside the open→welcome window of a reconnect", async () => {
    // C1, end to end. The shape: laptop and hub in sync; the uplink drops; the
    // agent keeps appending; the relay reconnects and sends `hello`; the hub
    // computes `have` from what it holds and replies `welcome` — and in the
    // round trip before that `welcome` lands, one more event is appended.
    //
    // Written straight to an open socket, that one event arrives AHEAD of the
    // replay the `welcome` is about to authorise, and `hubStore.publish`'s
    // high-water mark (`seq <= session.lastSeq`) then discards the entire
    // outage backlog as "already seen". The laptop believes it synced. Every
    // browser renders a transcript with a hole and no indication of it, and
    // the hub's stored history is wrong for every future joiner, permanently.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    const session = new Session("auth");
    let windowEvent: (() => void) | null = null;
    const { relay, wire } = laptop(hub.port, {}, {
      afterOpen: (n) => {
        // Only on the RECONNECT, and only once.
        if (n === 1) windowEvent?.();
      },
    });

    for (let i = 0; i < 5; i++) session.append({ type: "intent_update", text: `synced-${i}` });
    relay.trackSession("auth", session);
    relay.start();
    expect(await replayOnceAtLeast(hub.port, 5)).toHaveLength(5); // seq 0-4 landed

    // The uplink drops. The hub keeps the session and its five events.
    wire.sockets[0]!.close();
    await wait(20);

    // The agent keeps working through the outage: 30 more events, buffered.
    for (let i = 5; i < 35; i++) {
      relay.publishEvent("auth", session.append({ type: "intent_update", text: `outage-${i}` }));
    }

    // Armed to fire inside the reconnect's open→welcome window.
    windowEvent = () => {
      relay.publishEvent("auth", session.append({ type: "intent_update", text: "in-the-window" }));
    };

    const stored = await replayOnceAtLeast(hub.port, 36);
    relay.stop();

    // The laptop holds 36 events; so must the hub, in order, with no hole.
    expect(session.eventsFrom(0)).toHaveLength(36);
    expect(stored.map((e) => e.seq)).toEqual([...Array(36).keys()]);
    expect(stored.map((e) => e.text)).toEqual(session.eventsFrom(0).map((e: any) => e.text));
    expect(stored.at(-1).text).toBe("in-the-window");
  }, TIMEOUT);

  it("reassembles a chunked replay into exactly the laptop's log, multi-byte content included", async () => {
    // Two things at once, because they are one failure in practice. A replay
    // larger than `MAX_FRAME_BYTES` must be split, or `ws` answers 1009, the
    // relay reconnects, sees the same `have`, and re-sends the same oversized
    // frame forever — the session never syncs. And the split must be measured
    // in BYTES: this payload is emoji, so counting UTF-16 code units puts the
    // whole log under budget in ONE frame that is 1.2MB on the wire.
    //
    // The hub's real `maxPayload` is the judge here, which no relay-side unit
    // test can be.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    const session = new Session("auth");
    const emoji = "🙂".repeat(30_000); // 60_000 UTF-16 units, 120_000 bytes
    for (let i = 0; i < 10; i++) session.append({ type: "intent_update", text: `${i}${emoji}` });
    expect(Buffer.byteLength(JSON.stringify(session.eventsFrom(0)))).toBeGreaterThan(
      MAX_FRAME_BYTES,
    );

    const { relay } = laptop(hub.port);
    relay.trackSession("auth", session);
    relay.start();

    const stored = await replayOnceAtLeast(hub.port, 10);
    relay.stop();

    expect(stored.map((e) => e.seq)).toEqual([...Array(10).keys()]);
    expect(stored.map((e) => e.text)).toEqual(session.eventsFrom(0).map((e: any) => e.text));
  }, TIMEOUT);

  it("replays to a joining browser exactly what the laptop published, and reports it online", async () => {
    // The spine's whole point: one browser on the hub sees a session whose
    // agent runs on another machine. The browser never talks to the laptop —
    // the hub answers the replay and the snapshot from its own store, which is
    // what makes a watcher free.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    const session = new Session("auth");
    const { relay } = laptop(hub.port);
    relay.trackSession("auth", session);
    relay.start();
    await wait(60);

    relay.publishFacts("auth", {
      id: "auth", participants: ["ana"], driverName: "ana", intent: "ship the uplink",
      lastActivityTs: null, ended: false, pendingGate: null, skills: [],
      repoKey: "github.com/acme/api", lifecycle: "open",
    });
    for (const text of ["first", "second", "third"]) {
      relay.publishEvent("auth", session.append({ type: "intent_update", text }));
    }

    const stored = await replayOnceAtLeast(hub.port, 3);
    expect(stored.map((e) => e.text)).toEqual(["first", "second", "third"]);
    expect(stored.map((e) => e.seq)).toEqual([0, 1, 2]);

    // And the team view the laptop could never assemble on its own.
    const browser = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    await new Promise<void>((resolve, reject) => {
      browser.on("open", () => resolve());
      browser.on("error", reject);
    });
    browser.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    browser.send(JSON.stringify({ type: "peek", projectId: "default" }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.some((m) => m.type === "project")) await wait(10);
    browser.close();
    relay.stop();

    const snap = seen.find((m) => m.type === "project");
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].id).toBe("auth");
    expect(snap.sessions[0].intent).toBe("ship the uplink");
    expect(snap.sessions[0].repoKey).toBe("github.com/acme/api");
    expect(snap.sessions[0].presence).toBe("online");
  }, TIMEOUT);
});

describe("creating a session through the hub", () => {
  it("routes the create to the laptop untouched and lands the reply on the asking browser", async () => {
    // The whole point of this section: you could not create a session from the
    // hub at all. The last cross-component break in this seam survived eight
    // task reviews because no real-relay-against-real-hub harness existed.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const lap = laptopThatAnswers(hub.port);
    lap.relay.start();
    await wait(80);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(60);
    seen.length = 0;

    const create = {
      type: "create_session", projectId: "default",
      name: "billing", repoKey: "github.com/acme/api",
    };
    browser.send(JSON.stringify(create));
    await wait(150);

    expect(lap.arrived).toContainEqual(create);
    expect(seen.find((m) => m.type === "session_created")?.sessionId).toBe("billing");
    browser.close();
    lap.relay.stop();
  });

  it("does not deliver that reply to a second browser watching the same project", async () => {
    // `reply` is a narrowcast. If it fanned out, every watcher would navigate
    // into a session somebody else just created.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;
    const lap = laptopThatAnswers(hub.port);
    lap.relay.start();
    await wait(80);

    const asking = await connect(`ws://127.0.0.1:${hub.port}/`);
    const other = await connect(`ws://127.0.0.1:${hub.port}/`);
    const askingSeen: any[] = [];
    const otherSeen: any[] = [];
    collect(asking, askingSeen);
    collect(other, otherSeen);
    asking.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    asking.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    other.send(JSON.stringify({ type: "watch_project", projectId: "default" }));
    await wait(60);
    otherSeen.length = 0;

    asking.send(JSON.stringify({
      type: "create_session", projectId: "default",
      name: "billing", repoKey: "github.com/acme/api",
    }));
    await wait(150);

    expect(askingSeen.some((m) => m.type === "session_created")).toBe(true);
    expect(otherSeen.some((m) => m.type === "session_created")).toBe(false);
    asking.close();
    other.close();
    lap.relay.stop();
  });

  it("refuses a reply from a different uplink on the routed channel's id — a laptop cannot inject into another's create_session", async () => {
    // The whole reason `pendingReplyFrom` is scoped to one uplink, not any
    // uplink: a channel awaiting a create_session reply has joined no
    // session, so the ownership check (`store.ownerOf`) cannot authorize it —
    // there is no session yet to own. Without a check tying the reply to the
    // exact uplink the hub routed to, ANY attached machine that learned or
    // guessed this channelId could hand the asking browser a fabricated
    // `session_created` for a session it never created.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    // Machine A: the one the hub will actually route to, because it is the
    // one offering this repo.
    const a = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const aSeen: any[] = [];
    collect(a, aSeen);
    a.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-a", name: "lap-a",
      projectId: "default", repos: [decl("github.com/acme/api")],
    }));

    // Machine B: a live, attached uplink in the same project — just not the
    // one offering this repo, so the hub never routes this request to it.
    const b = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    b.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-b", name: "lap-b",
      projectId: "default", repos: [decl("github.com/acme/other")],
    }));
    await wait(40);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(60);
    seen.length = 0;

    browser.send(JSON.stringify({
      type: "create_session", projectId: "default",
      name: "billing", repoKey: "github.com/acme/api",
    }));
    await wait(60);

    const channelId = aSeen.find((f) => f.t === "tunnel")?.channelId;
    expect(channelId).toBeTruthy();

    // B — not the machine the hub routed to — tries to answer on A's channel.
    b.send(JSON.stringify({
      t: "reply", channelId,
      payload: { type: "session_created", sessionId: "billing" },
    }));
    await wait(60);
    expect(seen.some((m) => m.type === "session_created")).toBe(false);

    // A, the machine actually routed to, can still answer on that same
    // channel — the guard rejects the wrong uplink, not the right one.
    a.send(JSON.stringify({
      t: "reply", channelId,
      payload: { type: "session_created", sessionId: "billing" },
    }));
    await wait(60);
    expect(seen.some((m) => m.type === "session_created")).toBe(true);

    a.close();
    b.close();
    browser.close();
  });

  it("clears a stale grant when the browser joins instead — a never-answered create cannot inject into the new session", async () => {
    // Finding 1, Task 12 fix round 1: `pendingReplyFrom` is granted the
    // moment a create_session is routed and is otherwise only cleared on
    // delivery or on this socket closing. If the routed machine crashes,
    // hangs, or just never answers, and the browser gives up and `join`s a
    // DIFFERENT machine's session on the same channel, the stale grant must
    // not survive that rebinding — otherwise the originally-routed machine
    // could still push one arbitrary payload into a session it has nothing
    // to do with.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    // Machine A: routed to, but never answers.
    const a = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const aSeen: any[] = [];
    collect(a, aSeen);
    a.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-a", name: "lap-a",
      projectId: "default", repos: [decl("github.com/acme/api")],
    }));

    // Machine B: genuinely owns a session the browser will join afterward.
    const b = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    b.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-b", name: "lap-b",
      projectId: "default", repos: [decl("github.com/acme/other")],
    }));
    b.send(JSON.stringify({
      t: "facts", sessionId: "auth", runId: "run-b",
      facts: {
        id: "auth", participants: ["ana"], driverName: "ana", intent: null,
        lastActivityTs: null, ended: false, pendingGate: null, skills: [],
        repoKey: "github.com/acme/other", lifecycle: "open",
      },
    }));
    await wait(40);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(60);
    seen.length = 0;

    // Routed to A. A never answers.
    browser.send(JSON.stringify({
      type: "create_session", projectId: "default",
      name: "billing", repoKey: "github.com/acme/api",
    }));
    await wait(60);
    const channelId = aSeen.find((f) => f.t === "tunnel")?.channelId;
    expect(channelId).toBeTruthy();

    // The browser gives up and joins B's unrelated, pre-existing session
    // instead — same socket, same channel, a different machine's session.
    browser.send(JSON.stringify({
      type: "join", sessionId: "auth", projectId: "default", userId: "ana", name: "ana",
    }));
    await wait(60);
    seen.length = 0;

    // A — routed to, never answered, now stale — tries to cash in its old
    // grant on the very same channelId.
    a.send(JSON.stringify({
      t: "reply", channelId,
      payload: { type: "session_created", sessionId: "billing" },
    }));
    await wait(60);
    expect(seen).toEqual([]);

    a.close();
    b.close();
    browser.close();
  });

  it("pins a known bound: a second create on one channel supersedes the first, and the first machine's late reply is silently dropped", async () => {
    // Finding 2(b), Task 12 fix round 1. `pendingReplyFrom` is a single
    // scalar per channel, by design — concurrent create_sessions racing on
    // one browser connection are not a scenario this plan needs to support.
    // This test PINS that limitation so it stays a visible, deliberate bound
    // rather than something discovered later: firing a second create before
    // the first replies overwrites the grant, and the first machine's reply
    // — even if it eventually arrives — is dropped, not queued or merged.
    const hub = await startHub({ port: 0, host: "127.0.0.1" });
    close = hub.close;

    const a = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const aSeen: any[] = [];
    collect(a, aSeen);
    a.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-a", name: "lap-a",
      projectId: "default", repos: [decl("github.com/acme/api")],
    }));

    const b = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    b.send(JSON.stringify({
      t: "hello", v: RELAY_PROTOCOL_VERSION, uplinkId: "lap-b", name: "lap-b",
      projectId: "default", repos: [decl("github.com/acme/other")],
    }));
    await wait(40);

    const browser = await connect(`ws://127.0.0.1:${hub.port}/`);
    const seen: any[] = [];
    collect(browser, seen);
    browser.send(JSON.stringify({ type: "identify", userId: "ana", name: "ana" }));
    browser.send(JSON.stringify({ type: "join_project", projectId: "default" }));
    await wait(60);
    seen.length = 0;

    // First create, routed to A. A does not get to answer before...
    browser.send(JSON.stringify({
      type: "create_session", projectId: "default",
      name: "one", repoKey: "github.com/acme/api",
    }));
    // ...a second create on the SAME channel/socket, routed to B, overwrites
    // the grant. Both share one channelId — it belongs to the connection,
    // not to any one request.
    browser.send(JSON.stringify({
      type: "create_session", projectId: "default",
      name: "two", repoKey: "github.com/acme/other",
    }));
    await wait(60);
    const channelId = aSeen.find((f) => f.t === "tunnel")?.channelId;
    expect(channelId).toBeTruthy();

    // A's reply for the request it genuinely was routed to, arriving late.
    a.send(JSON.stringify({
      t: "reply", channelId,
      payload: { type: "session_created", sessionId: "one" },
    }));
    await wait(60);
    expect(seen.some((m) => m.type === "session_created" && m.sessionId === "one")).toBe(false);

    // B — the machine the grant now belongs to — can still answer normally.
    b.send(JSON.stringify({
      t: "reply", channelId,
      payload: { type: "session_created", sessionId: "two" },
    }));
    await wait(60);
    expect(seen.some((m) => m.type === "session_created" && m.sessionId === "two")).toBe(true);

    a.close();
    b.close();
    browser.close();
  });
});

/** Machines and repos, across the wire (spec §11's five seam scenarios).
 *
 *  Everything here is already shipped — Task 5's hello v2 and machine-directed
 *  routing, Task 6's attach/detach handlers, Task 7's reply grant, Task 8's
 *  stable machine id. What is NOT shipped is any proof that the four hold
 *  TOGETHER over a real socket, and this file's history is the argument for
 *  needing one: it found a Critical on its first scenario, twice, both times
 *  in code every unit-level review had already passed.
 *
 *  The rule each scenario below is written to: could this assertion pass for
 *  the wrong reason? Where it could, the fixture carries a second, contrary
 *  case — a candidate repo that must FLIP, a machine that must NOT be routed
 *  to — rather than a single value that any plausible bug would also produce.
 */
describe("machines and repos, across the wire", () => {
  it("carries an attach round trip: browser → hub → laptop → repos frame → snapshot", async () => {
    // Spec §11 scenario 1. Four components in one line of travel: the hub's
    // `attach_repo` route and its reply grant, the relay's tunnel plane, the
    // `repos` up-frame, and the store's wholesale replacement. Any one of them
    // dropping the ball leaves a repo the browser attached that the browser
    // cannot see, which is indistinguishable from an attach that never ran.
    const hub = await hubWithTeardown();

    // One ATTACHED repo and one CANDIDATE. `attached: false` is what makes the
    // closing assertion discriminate: `web` is already in the machine's list
    // from the first `hello` (the hub's route requires that — it refuses a key
    // the machine never advertised), so its mere PRESENCE would prove nothing.
    // Only a real attach can flip the flag.
    const repos = [
      decl("github.com/acme/api"),
      decl("github.com/acme/web", { attached: false, defaultBranch: null }),
    ];
    const lap = hub.own(
      laptopThatAnswers(hub.port, { repos: () => repos }, (msg, io) => {
        if (msg?.type !== "attach_repo") return false;
        io.send({ type: "repo_attached", repoKey: msg.repoKey });
        return true;
      }),
    );
    lap.relay.start();
    await snapshotUntil(hub.port, "peek", (s) =>
      s.machines.some((m: any) => m.machineId === "lap-1"),
    );

    const { browser, seen } = await joinAsAna(hub.port);
    const attach = {
      type: "attach_repo",
      projectId: "default",
      machineId: "lap-1",
      repoKey: "github.com/acme/web",
    };
    browser.send(JSON.stringify(attach));
    await until(seen, (m) => m.type === "repo_attached");

    // The command reached the machine through the tunnel, untouched — the hub
    // is a router here and nothing more.
    expect(lap.arrived).toContainEqual(attach);
    // ...and the machine's answer reached the browser that asked, which only
    // the single-use `pendingReplyFrom` grant can carry: this channel has
    // joined no session, so ownership cannot authorize the reply.
    expect(seen.find((m) => m.type === "repo_attached")).toEqual({
      type: "repo_attached",
      repoKey: "github.com/acme/web",
    });

    // The real daemon re-declares its full set the moment an attach lands
    // (spec §5.2); here the test IS that side of the seam.
    repos[1] = decl("github.com/acme/web");
    lap.relay.sendRepos();

    const snap = await snapshotUntil(hub.port, "watch_project", (s) =>
      s.machines[0]?.repos.some((r: any) => r.key === "github.com/acme/web" && r.attached),
    );
    expect(snap.machines[0].repos.find((r: any) => r.key === "github.com/acme/web")).toEqual({
      key: "github.com/acme/web",
      label: "web",
      attached: true,
      defaultBranch: "origin/main",
    });
    // Wholesale REPLACEMENT, not a single-key rewrite: the frame is the
    // machine's whole list, so the repo it did not mention must survive
    // unchanged rather than vanish.
    expect(snap.machines[0].repos.map((r: any) => r.key)).toEqual([
      "github.com/acme/api",
      "github.com/acme/web",
    ]);
    browser.close();
  }, TIMEOUT);

  it("carries a detach refusal end to end, in the laptop's own words", async () => {
    // Spec §11 scenario 2. The refusal text is the product: "cannot detach"
    // with no reason sends a user hunting, and the blocker list only exists on
    // the machine that holds the sessions. This pins that the exact sentence
    // survives the tunnel and the reply grant — asserted as the WHOLE message,
    // because the hub emits `{ type: "error" }` for its own refusals too and a
    // shape-only assertion would pass on one of those.
    //
    // The DECISION to refuse (§11's "past an open session") is the laptop's and
    // is pinned by Task 6's handler tests against a real session set; nothing
    // at this seam can hold an open session, because the command plane here is
    // the scenario's own. What is only provable here is the delivery.
    const hub = await hubWithTeardown();
    const REFUSAL = "cannot detach: 1 open session (auth)";
    const lap = hub.own(
      laptopThatAnswers(hub.port, {}, (msg, io) => {
        if (msg?.type !== "detach_repo") return false;
        io.send({ type: "error", message: REFUSAL });
        return true;
      }),
    );
    lap.relay.start();
    await snapshotUntil(hub.port, "peek", (s) =>
      s.machines.some((m: any) => m.machineId === "lap-1"),
    );

    const { browser, seen } = await joinAsAna(hub.port);
    const detach = {
      type: "detach_repo",
      projectId: "default",
      machineId: "lap-1",
      repoKey: "github.com/acme/api",
    };
    browser.send(JSON.stringify(detach));
    await until(seen, (m) => m.type === "error");

    // It got past the hub's own pre-tunnel refusals rather than tripping one.
    expect(lap.arrived).toContainEqual(detach);
    expect(seen.find((m) => m.type === "error")).toEqual({ type: "error", message: REFUSAL });
    browser.close();
  }, TIMEOUT);

  it("reclaims its own sessions across a relay restart, with no ownership collision", async () => {
    // Spec §11 scenario 3, the seam-level pin for debt §2.3. Before the
    // machine id was persisted, a restarted daemon came back as a STRANGER:
    // `setFacts` refused every frame for the sessions it had just been driving
    // with "already owned by another machine", the hub kept the pre-restart
    // facts forever, and the operator's only clue was one console line on a
    // machine they were not looking at. Ownership is keyed on `uplinkId`, so
    // the fix is entirely "the id is the same across restarts" — which nothing
    // below the wire can demonstrate.
    const hub = await hubWithTeardown();
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

    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const first = hub.own(laptopThatAnswers(hub.port, { newRunId: () => "run-1" }));
      first.relay.trackSession("auth", new Session("auth"));
      first.relay.start();
      first.relay.publishFacts("auth", factsFor("before the restart"));
      await snapshotUntil(hub.port, "peek", (s) =>
        s.sessions.some((x: any) => x.id === "auth" && x.presence === "online"),
      );

      // The daemon exits. Wait for the HUB to have seen it go, not for a fixed
      // number of ms: the reclaim under test is the one that happens after the
      // machine is already marked offline, which is the real-world shape.
      first.relay.stop();
      const gone = await snapshotUntil(hub.port, "peek", (s) =>
        s.sessions.every((x: any) => x.presence === "offline"),
      );
      expect(gone.sessions.map((x: any) => x.presence)).toEqual(["offline"]);

      // It comes back. SAME machineId — that is the whole point — and a fresh
      // runId, because a new process is genuinely a new run of that session.
      const second = hub.own(laptopThatAnswers(hub.port, { newRunId: () => "run-2" }));
      second.relay.trackSession("auth", new Session("auth"));
      second.relay.start();
      second.relay.publishFacts("auth", factsFor("after the restart"));
      const snap = await snapshotUntil(hub.port, "peek", (s) =>
        s.sessions.some((x: any) => x.intent === "after the restart"),
      );

      // The root cause is asserted FIRST, because it is the only thing in the
      // system that names this failure out loud. Everything below it is a
      // downstream symptom that reads like some other bug.
      expect(logged.filter((l) => l.includes("already owned by another machine"))).toEqual([]);
      // And nothing else was logged either: waiting for the offline state means
      // the hub had already reclaimed the id, so the same-machineId supersede
      // warning must not fire. A restart is not a two-daemons-fighting event.
      expect(logged).toEqual([]);
      // One row, not two: a stranger would have been refused outright, and a
      // hub that keyed ownership on the CONNECTION would have listed the
      // session twice.
      expect(snap.sessions.filter((x: any) => x.id === "auth")).toHaveLength(1);
      expect(snap.sessions[0].machineId).toBe("lap-1");
      expect(snap.sessions[0].presence).toBe("online");
      // The second facts frame was ACCEPTED rather than dropped — the only
      // observable difference between reclaiming and refusing, since a refusal
      // leaves the stale row in place looking perfectly healthy.
      expect(snap.sessions[0].intent).toBe("after the restart");
    } finally {
      // Restored on the failure path too, or every later test in this file
      // silently swallows the hub's console output.
      spy.mockRestore();
    }
  }, TIMEOUT);

  it("refuses a v1 hello at the frame boundary, and admits a v2 one on the same hub", async () => {
    // Spec §11 scenario 4. There is no compatibility shim (D6), so the ONLY
    // acceptable outcome for an old laptop is a loud refusal at the boundary.
    // The v2 leg is not decoration: without it this test would pass just as
    // well against a hub that closed every uplink it was ever handed.
    const hub = await hubWithTeardown();

    const old = new WebSocket(`ws://127.0.0.1:${hub.port}/uplink`);
    old.on("error", () => {});
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      old.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await new Promise<void>((resolve) => old.on("open", () => resolve()));
    // v1's hello, verbatim: a scalar `repoKey`, no `name`, no `repos`.
    old.send(
      JSON.stringify({ t: "hello", v: 1, uplinkId: "old", projectId: "default", repoKey: "x" }),
    );
    expect(
      await Promise.race([
        closed,
        wait(5000).then(() => ({ code: -1, reason: "the hub never closed the socket" })),
      ]),
    ).toEqual({ code: 1008, reason: "bad frame" });

    const current = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const frames: any[] = [];
    collect(current, frames);
    let currentClose: number | null = null;
    current.on("close", (code) => {
      currentClose = code;
    });
    current.send(
      JSON.stringify({
        t: "hello",
        v: RELAY_PROTOCOL_VERSION,
        uplinkId: "new",
        name: "new",
        projectId: "default",
        repos: [decl("github.com/acme/api")],
      }),
    );
    await until(frames, (f) => f.t === "welcome");
    expect(frames.find((f) => f.t === "welcome")?.v).toBe(RELAY_PROTOCOL_VERSION);
    expect(currentClose).toBeNull();
    current.close();
  }, TIMEOUT);

  it("carries the browser's repo choice to the machine it named, not the first one offering it", async () => {
    // Spec §11 scenario 5 — the blocker (d) regression, across the wire.
    // `create_session` used to DISCARD `msg.repoKey` outright; a machine with
    // two attached repos would then provision in whichever one it happened to
    // hold, and the session would look right in every list while running in
    // the wrong tree. The unit-level "which workspace provisioned" assertion
    // is Task 3's; this leg proves the WIRE carries the choice — the payload
    // arrives untouched at the machine the browser named.
    const hub = await hubWithTeardown();

    // A SECOND machine, also offering `api`, attached FIRST so it is the one
    // an unqualified first-online-match lands on. Without it this scenario
    // cannot tell machineId-directed routing from the fallback — one machine
    // is the same machine either way — and the mandated revert-and-rerun
    // (drop the machineId branch) would pass vacuously. This is exactly the
    // ambiguity spec §12.4 says `machineId` exists to resolve.
    const other = await connect(`ws://127.0.0.1:${hub.port}/uplink`);
    const otherSeen: any[] = [];
    collect(other, otherSeen);
    other.send(
      JSON.stringify({
        t: "hello",
        v: RELAY_PROTOCOL_VERSION,
        uplinkId: "lap-0",
        name: "lap-0",
        projectId: "default",
        repos: [decl("github.com/acme/api")],
      }),
    );
    await snapshotUntil(hub.port, "peek", (s) =>
      s.machines.some((m: any) => m.machineId === "lap-0"),
    );

    const lap = hub.own(
      laptopThatAnswers(hub.port, {
        repos: () => [decl("github.com/acme/api"), decl("github.com/acme/web")],
      }),
    );
    lap.relay.start();
    const both = await snapshotUntil(hub.port, "peek", (s) =>
      s.machines.some((m: any) => m.machineId === "lap-1"),
    );
    // The fixture's own precondition: machines are listed in attach order, so
    // `lap-0` really is what a machineId-blind route would pick for `api`.
    expect(both.machines.map((m: any) => m.machineId)).toEqual(["lap-0", "lap-1"]);

    const { browser, seen } = await joinAsAna(hub.port);
    const creates = () => lap.arrived.filter((m: any) => m.type === "create_session");

    const web = {
      type: "create_session",
      projectId: "default",
      name: "s1",
      repoKey: "github.com/acme/web",
      machineId: "lap-1",
    };
    browser.send(JSON.stringify(web));
    await until(seen, (m) => m.type === "session_created" && m.sessionId === "s1");
    expect(creates()).toEqual([web]);

    // The second repo on the SAME machine, whose key `lap-0` also offers. A
    // route that ignored `machineId` would hand this one to `lap-0` and this
    // machine would never hear about the session it is supposed to be running.
    const api = {
      type: "create_session",
      projectId: "default",
      name: "s2",
      repoKey: "github.com/acme/api",
      machineId: "lap-1",
    };
    browser.send(JSON.stringify(api));
    await until(seen, (m) => m.type === "session_created" && m.sessionId === "s2");
    expect(creates()).toEqual([web, api]);

    // And the other machine was never spoken to at all.
    expect(otherSeen.filter((f) => f.t === "tunnel")).toEqual([]);
    browser.close();
    other.close();
  }, TIMEOUT);
});
