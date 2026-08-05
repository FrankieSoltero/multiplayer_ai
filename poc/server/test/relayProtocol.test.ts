import { describe, expect, test } from "vitest";
import {
  MAX_FRAME_BYTES,
  MAX_REPOS,
  OVERSIGHT_TEXT_CAP,
  RELAY_PROTOCOL_VERSION,
  clampRepoDecl,
  parseDownFrame,
  parseUpFrame,
  type RepoDecl,
} from "../src/relayProtocol.js";
import { PATH_WIRE_CAP, TOUCH_CAP, TOUCH_SENTINEL } from "../src/collisions.js";
import type { PendingGate } from "../src/pendingGate.js";

const decl = (over: Partial<RepoDecl> = {}): RepoDecl => ({
  key: "github.com/acme/api",
  label: "api",
  attached: true,
  defaultBranch: "origin/main",
  ...over,
});

/** A hello with everything valid, so each test below varies exactly one field. */
const hello = (over: Record<string, unknown> = {}) => ({
  t: "hello",
  v: RELAY_PROTOCOL_VERSION,
  uplinkId: "lap-1",
  name: "Ana's MacBook",
  projectId: "default",
  repos: [decl()],
  ...over,
});

const facts = {
  id: "auth",
  participants: ["ana"],
  driverName: "ana",
  intent: null,
  lastActivityTs: null,
  ended: false,
  pendingGate: null,
  skills: [],
  repoKey: "github.com/acme/api",
  lifecycle: "open" as const,
};

/** Deliberately carries NO `touched`: this baseline IS the v2 peer that predates
 *  the field (spec §3.3 is additive, no version bump), so every existing test
 *  above that sends it doubles as the compatibility assertion. */
const factsFrame = (over: Record<string, unknown> = {}) =>
  parseUpFrame({ t: "facts", sessionId: "auth", runId: "run-a", facts: { ...facts, ...over } });

/** The parsed `touched` of an otherwise-valid facts frame. Throws rather than
 *  returning null on rejection, so an accept-case test that starts failing says
 *  "frame rejected" instead of comparing against a silent null. */
function touchedOf(over: Record<string, unknown> = {}): string[] | null {
  const frame = factsFrame(over);
  if (frame === null || frame.t !== "facts") throw new Error("facts frame was rejected");
  return frame.facts.touched;
}

/** A facts frame carrying an otherwise-valid gate, so each test varies exactly
 *  one field of it. The baseline gate deliberately carries NO `reason`: it IS
 *  the peer that predates the field (additive, no version bump). */
const gateFrame = (over: Record<string, unknown> = {}) =>
  factsFrame({ pendingGate: { toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", ...over } });

/** The parsed `pendingGate`. Throws rather than returning null on rejection, so
 *  an accept-case test says "frame rejected" instead of comparing against null. */
function gateOf(over: Record<string, unknown> = {}): PendingGate | null {
  const frame = gateFrame(over);
  if (frame === null || frame.t !== "facts") throw new Error("facts frame was rejected");
  return frame.facts.pendingGate;
}

describe("clampRepoDecl", () => {
  // Finding 1: a laptop's real label/key/branch is unbounded upstream (a repo
  // directory name, a git remote path, a branch name), while this file's own
  // `repoList` REJECTS the whole hello on one out-of-bounds entry. Without a
  // clamp at the choke point that builds every outgoing decl, a single
  // 101-char repo directory name takes the machine off the hub with a
  // misleading "versions may not match" loop (relay.ts's 1008 log).

  test("slices an over-long label to 100 chars", () => {
    const clamped = clampRepoDecl(decl({ label: "l".repeat(150) }));
    expect(clamped.label).toBe("l".repeat(100));
    expect(parseUpFrame(hello({ repos: [clamped] }))).not.toBeNull();
  });

  test("falls back to the key when the label would be empty (root-path repo)", () => {
    const clamped = clampRepoDecl(decl({ key: "local:host:abc123456789", label: "" }));
    expect(clamped.label).toBe("local:host:abc123456789");
    expect(clamped.label.length).toBeGreaterThan(0);
    expect(parseUpFrame(hello({ repos: [clamped] }))).not.toBeNull();
  });

  test("slices an over-long key to 200 chars", () => {
    const clamped = clampRepoDecl(decl({ key: "k".repeat(250) }));
    expect(clamped.key).toBe("k".repeat(200));
    expect(parseUpFrame(hello({ repos: [clamped] }))).not.toBeNull();
  });

  test("slices an over-long defaultBranch to 100 chars, and leaves null alone", () => {
    const clamped = clampRepoDecl(decl({ defaultBranch: "b".repeat(150) }));
    expect(clamped.defaultBranch).toBe("b".repeat(100));
    expect(parseUpFrame(hello({ repos: [clamped] }))).not.toBeNull();

    const candidate = clampRepoDecl(decl({ attached: false, defaultBranch: null }));
    expect(candidate.defaultBranch).toBeNull();
  });

  test("is a no-op on an already-valid decl", () => {
    expect(clampRepoDecl(decl())).toEqual(decl());
  });
});

describe("parseUpFrame", () => {
  test("accepts a hello v2 and preserves every declared field", () => {
    const candidate = decl({
      key: "github.com/acme/web",
      label: "web",
      attached: false,
      defaultBranch: null,
    });
    const frame = parseUpFrame(hello({ repos: [decl(), candidate] }));
    expect(frame).toEqual({
      t: "hello",
      v: 2,
      uplinkId: "lap-1",
      name: "Ana's MacBook",
      projectId: "default",
      repos: [decl(), candidate],
    });
  });

  test("rejects a v1 hello — there is no compatibility shim, by design (D6)", () => {
    // The version boundary IS the compatibility story. A v1 laptop carries a
    // scalar `repoKey` and no machine name; admitting it would leave the hub
    // holding a machine record it invented, and the mismatch would only
    // surface later, somewhere with no context to explain it.
    expect(
      parseUpFrame({ t: "hello", v: 1, uplinkId: "lap-1", projectId: "default", repoKey: "k" }),
    ).toBeNull();
  });

  test("rejects a hello from a different protocol version", () => {
    // A version mismatch must fail loudly at the frame boundary rather than
    // producing a half-understood uplink that misbehaves later.
    expect(parseUpFrame(hello({ v: 99 }))).toBeNull();
  });

  test("rejects a repos list over the 100-entry cap, and accepts one exactly at it", () => {
    // A machine offering more than 100 repos is a config error, not a big
    // machine (spec §5.1) — and truncating would misrepresent it silently.
    // Both ends of the bound are asserted, or "rejects everything" passes.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => decl({ key: `github.com/acme/r${i}`, label: `r${i}` }));
    expect(parseUpFrame(hello({ repos: many(101) }))).toBeNull();
    expect(parseUpFrame(hello({ repos: many(100) }))).not.toBeNull();
  });

  test("rejects a hello whose repos is not an array", () => {
    expect(parseUpFrame(hello({ repos: "github.com/acme/api" }))).toBeNull();
    expect(parseUpFrame(hello({ repos: { key: "github.com/acme/api" } }))).toBeNull();
    expect(parseUpFrame(hello({ repos: undefined }))).toBeNull();
  });

  test("rejects a hello carrying a malformed RepoDecl", () => {
    const bad: unknown[] = [
      null,
      "github.com/acme/api",
      decl({ key: "" }),
      decl({ key: "k".repeat(201) }),
      decl({ key: 7 as unknown as string }),
      decl({ label: "" }),
      decl({ label: "l".repeat(101) }),
      decl({ attached: "yes" as unknown as boolean }),
      decl({ defaultBranch: 7 as unknown as string }),
      decl({ defaultBranch: "b".repeat(101) }),
    ];
    for (const entry of bad) {
      expect(parseUpFrame(hello({ repos: [entry] }))).toBeNull();
    }
    // Every bound is inclusive, so a decl sitting exactly on all three passes.
    expect(
      parseUpFrame(
        hello({
          repos: [decl({ key: "k".repeat(200), label: "l".repeat(100), defaultBranch: "b".repeat(100) })],
        }),
      ),
    ).not.toBeNull();
    // ...and a candidate's null defaultBranch is the ordinary case, not a fault.
    expect(parseUpFrame(hello({ repos: [decl({ attached: false, defaultBranch: null })] }))).not.toBeNull();
  });

  test("rejects a non-string machine name and truncates a long one to 40 chars", () => {
    // Identity parity with the browser's `name` (hub.ts's identify/join, 40).
    expect(parseUpFrame(hello({ name: 7 }))).toBeNull();
    expect(parseUpFrame(hello({ name: undefined }))).toBeNull();
    const frame = parseUpFrame(hello({ name: "x".repeat(60) }));
    expect(frame && "name" in frame && frame.name).toBe("x".repeat(40));
  });

  test("accepts a repos frame — the full list a machine re-declares when its set changes", () => {
    // Always the whole authoritative list, never a diff (spec §5.2): the hub
    // only ever overwrites its record wholesale, so there is no single-key
    // rewrite path a re-attach could corrupt.
    expect(parseUpFrame({ t: "repos", repos: [decl(), decl({ key: "b", label: "b" })] })).toEqual({
      t: "repos",
      repos: [decl(), decl({ key: "b", label: "b" })],
    });
    expect(parseUpFrame({ t: "repos", repos: [] })).toEqual({ t: "repos", repos: [] });
  });

  test("holds a repos frame to the same bounds as a hello's list", () => {
    expect(parseUpFrame({ t: "repos", repos: "nope" })).toBeNull();
    expect(parseUpFrame({ t: "repos", repos: [decl({ label: "" })] })).toBeNull();
    expect(
      parseUpFrame({
        t: "repos",
        repos: Array.from({ length: 101 }, (_, i) => decl({ key: `r${i}`, label: `r${i}` })),
      }),
    ).toBeNull();
  });

  test("accepts a publish carrying logged events", () => {
    const frame = parseUpFrame({
      t: "publish",
      sessionId: "auth",
      runId: "run-a",
      events: [{ type: "presence_join", userId: "ana", name: "ana", seq: 0, ts: "2026-07-27T00:00:00.000Z" }],
    });
    expect(frame?.t).toBe("publish");
    expect(frame && "events" in frame && frame.events).toHaveLength(1);
  });

  test("rejects a publish whose events are not an array", () => {
    expect(parseUpFrame({ t: "publish", sessionId: "auth", runId: "r", events: "nope" })).toBeNull();
  });

  test("accepts a facts frame", () => {
    const frame = parseUpFrame({ t: "facts", sessionId: "auth", runId: "run-a", facts });
    expect(frame?.t).toBe("facts");
  });

  // `touched` — the session's repo-relative changed paths (spec §3.3). Additive
  // and OPTIONAL on the wire: absent and null both mean "no list", which is what
  // lets a v2 peer built before the field keep validating without a version bump.
  test("normalizes an absent or null touched to null", () => {
    expect(touchedOf()).toBeNull();
    expect(touchedOf({ touched: null })).toBeNull();
  });

  test("accepts an empty and a populated touched list unchanged", () => {
    expect(touchedOf({ touched: [] })).toEqual([]);
    expect(touchedOf({ touched: ["src/a.ts", "src/b.ts"] })).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("accepts the exact length bounds — PATH_WIRE_CAP chars and TOUCH_CAP + 1 entries", () => {
    // TOUCH_CAP + 1 is the producer's own worst case: a full cap plus the
    // "…and more" sentinel. A bound of TOUCH_CAP would reject every capped
    // session's frame.
    const atCap = "d".repeat(PATH_WIRE_CAP);
    expect(touchedOf({ touched: [atCap] })).toEqual([atCap]);

    const full = [...Array.from({ length: TOUCH_CAP }, (_, i) => `f${i}.ts`), TOUCH_SENTINEL];
    expect(touchedOf({ touched: full })).toEqual(full);
  });

  test("rejects a touched that is not an array of strings", () => {
    expect(factsFrame({ touched: "src/a.ts" })).toBeNull();
    expect(factsFrame({ touched: 7 })).toBeNull();
    expect(factsFrame({ touched: {} })).toBeNull();
    expect(factsFrame({ touched: [1] })).toBeNull();
    expect(factsFrame({ touched: ["ok.ts", null] })).toBeNull();
  });

  test("rejects a touched that busts either length bound", () => {
    expect(factsFrame({ touched: ["d".repeat(PATH_WIRE_CAP + 1)] })).toBeNull();
    expect(factsFrame({ touched: Array.from({ length: TOUCH_CAP + 2 }, (_, i) => `f${i}.ts`) })).toBeNull();
  });

  // Untrusted-peer strings: these paths reach an agent's `<teammates>` block and
  // a human-read gate reason, so the validator bounds the CHARACTERS as well as
  // the length. A newline is a prompt-injection frame boundary, not a filename.
  test("rejects a touched path containing control characters", () => {
    expect(factsFrame({ touched: ["src/a.ts\ninjected: line"] })).toBeNull();
    expect(factsFrame({ touched: ["src/a.ts\rmore"] })).toBeNull();
    expect(factsFrame({ touched: ["src/a\u0000.ts"] })).toBeNull();
    expect(factsFrame({ touched: ["src/a\u001b[31m.ts"] })).toBeNull();
    expect(factsFrame({ touched: ["src/a\u007f.ts"] })).toBeNull();
    expect(factsFrame({ touched: ["ok.ts", "src/a\tb.ts"] })).toBeNull();
    // …while an ordinary non-ASCII path is not a control character.
    expect(touchedOf({ touched: ["src/café.ts", TOUCH_SENTINEL] })).toEqual([
      "src/café.ts",
      TOUCH_SENTINEL,
    ]);
  });

  // `pendingGate.reason` — spec §6b's "the gate's UI line names why", server
  // half. Additive and OPTIONAL on the wire exactly like `touched`: absent and
  // null are the same thing, so a peer that predates the field keeps validating
  // and keeps rendering the gate without a version bump.
  test("normalizes an absent or null gate reason to null", () => {
    // Byte-identical to today's gate frame apart from the optional field: the
    // ordinary gate's other fields ride through untouched.
    expect(gateOf()).toEqual({ toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", reason: null });
    expect(gateOf({ reason: null })).toEqual({
      toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z", reason: null,
    });
  });

  test("carries a gate reason to the client character for character", () => {
    expect(gateOf({ reason: "contested with session alpha" })?.reason).toBe(
      "contested with session alpha",
    );
  });

  test("accepts a gate reason at the 512-char cap and rejects one over it", () => {
    // The gate-reason cap is a SEPARATE bound from PATH_WIRE_CAP that
    // deliberately shares its number, so it is spelled out here rather than
    // imported from `collisions.ts`.
    expect(gateOf({ reason: "r".repeat(512) })?.reason).toBe("r".repeat(512));
    expect(gateFrame({ reason: "r".repeat(513) })).toBeNull();
  });

  test("rejects a gate reason that is not a string", () => {
    expect(gateFrame({ reason: 7 })).toBeNull();
    expect(gateFrame({ reason: {} })).toBeNull();
    expect(gateFrame({ reason: [] })).toBeNull();
    expect(gateFrame({ reason: true })).toBeNull();
  });

  // Untrusted-peer strings, same rule as `touched`: this string is rendered
  // verbatim in a human-read gate line, so a newline is a forged line boundary.
  test("rejects a gate reason containing control characters", () => {
    expect(gateFrame({ reason: "contested\ninjected: line" })).toBeNull();
    expect(gateFrame({ reason: "contested\rmore" })).toBeNull();
    expect(gateFrame({ reason: "contested\u0000" })).toBeNull();
    expect(gateFrame({ reason: "contested\u001b[31m" })).toBeNull();
    expect(gateFrame({ reason: "contested\u007f" })).toBeNull();
    // …while an ordinary non-ASCII reason is not a control character.
    expect(gateOf({ reason: "contested with session café" })?.reason).toBe(
      "contested with session café",
    );
  });

  test("rejects a malformed gate outright — never a partially applied frame", () => {
    // The whole facts frame is rejected, so no consumer ever sees a gate with
    // the bad field quietly stripped and the rest applied.
    expect(gateFrame({ reason: 7 })).toBeNull();
    expect(factsFrame({ pendingGate: "Bash" })).toBeNull();
    expect(factsFrame({ pendingGate: 7 })).toBeNull();
  });

  test("carries the reason on the permission_request event a publish replays", () => {
    // The EVENT is the carrier the client actually renders (Transcript's
    // `case \"permission_request\"`), so the publish path must not drop it.
    const frame = parseUpFrame({
      t: "publish",
      sessionId: "auth",
      runId: "run-a",
      events: [{
        type: "permission_request", requestId: "r1", toolName: "Write", input: {},
        reason: "contested with session alpha", seq: 0, ts: "2026-07-27T00:00:00.000Z",
      }],
    });
    const ev = frame && frame.t === "publish" ? (frame.events[0] as { reason?: string }) : null;

    expect(ev?.reason).toBe("contested with session alpha");
  });

  test("accepts a reply addressed to a channel", () => {
    const frame = parseUpFrame({ t: "reply", channelId: "c1", payload: { type: "error", message: "no" } });
    expect(frame).toEqual({ t: "reply", channelId: "c1", payload: { type: "error", message: "no" } });
  });

  test("rejects unknown frame types, non-objects and null", () => {
    expect(parseUpFrame({ t: "evict", sessionId: "auth" })).toBeNull();
    expect(parseUpFrame("hello")).toBeNull();
    expect(parseUpFrame(null)).toBeNull();
    expect(parseUpFrame([])).toBeNull();
  });

  test("rejects ids that are not slugs, so a frame can never name a path", () => {
    expect(parseUpFrame({ t: "publish", sessionId: "../etc", runId: "r", events: [] })).toBeNull();
    expect(parseUpFrame({ t: "facts", sessionId: "auth", runId: "r".repeat(200), facts })).toBeNull();
  });
});

describe("parseDownFrame", () => {
  test("accepts a welcome carrying the hub's resume offsets", () => {
    const frame = parseDownFrame({
      t: "welcome",
      v: RELAY_PROTOCOL_VERSION,
      have: { auth: { runId: "run-a", lastSeq: 41 } },
    });
    expect(frame).toEqual({ t: "welcome", v: 2, have: { auth: { runId: "run-a", lastSeq: 41 } } });
  });

  test("accepts a tunnel and keeps the payload untouched", () => {
    // The payload is the ORIGINAL client message, verbatim. The relay must not
    // interpret it — the laptop's existing handler is the only thing that does.
    const payload = { type: "prompt", text: "hi" };
    const frame = parseDownFrame({
      t: "tunnel",
      channelId: "c1",
      identity: { userId: "ana", name: "ana" },
      payload,
    });
    expect(frame && "payload" in frame && frame.payload).toEqual(payload);
  });

  test("rejects a tunnel with no identity — the laptop must never guess who sent a command", () => {
    expect(parseDownFrame({ t: "tunnel", channelId: "c1", payload: {} })).toBeNull();
  });

  test("accepts a detach, which is how a browser going away reaches the laptop", () => {
    // Without this the laptop never learns a watcher left, presence_leave
    // never fires, and the roster shows ghosts forever. A closed direct
    // socket does this implicitly; a relayed one needs it said out loud.
    expect(parseDownFrame({ t: "detach", channelId: "c1" })).toEqual({ t: "detach", channelId: "c1" });
  });

  test("rejects an up-frame shape on the down parser and vice versa", () => {
    expect(parseDownFrame({ t: "publish", sessionId: "auth", runId: "r", events: [] })).toBeNull();
    expect(parseUpFrame({ t: "tunnel", channelId: "c1", identity: { userId: "a", name: "a" }, payload: {} })).toBeNull();
  });
});

/** The hub's `contested` down-frame (spec §6a as amended by §8a ruling 6). Every
 *  field on it is UNTRUSTED text from a peer machine: the paths land in the
 *  agent's `<teammates>` block and the peer ids are interpolated into a
 *  human-read gate reason, so both are bounded here at the frame boundary. */
const contested = (over: Record<string, unknown> = {}) => ({
  t: "contested",
  sessionId: "auth",
  paths: ["src/a.ts", "src/b.ts"],
  collisions: [
    { path: "src/a.ts", sessionIds: ["auth", "s9"] },
    { path: "src/b.ts", sessionIds: ["auth", "s2"] },
  ],
  ...over,
});

describe("parseDownFrame — contested", () => {
  test("accepts an empty and a populated contested frame, parsed to the exact shape", () => {
    // Empty is the CLEAR frame (Task 7a's "frame clears" row), not a fault.
    expect(parseDownFrame(contested({ paths: [], collisions: [] }))).toEqual({
      t: "contested",
      sessionId: "auth",
      paths: [],
      collisions: [],
    });
    expect(parseDownFrame(contested())).toEqual({
      t: "contested",
      sessionId: "auth",
      paths: ["src/a.ts", "src/b.ts"],
      collisions: [
        { path: "src/a.ts", sessionIds: ["auth", "s9"] },
        { path: "src/b.ts", sessionIds: ["auth", "s2"] },
      ],
    });
  });

  test("accepts a TRUNCATED frame — paths carries the sentinel that collisions does not", () => {
    // Task 6b's `over-cap` row appends TOUCH_SENTINEL to `paths` while truncating
    // `collisions` to the RETAINED paths, so in that case `paths` is exactly one
    // element longer than the distinct path set of `collisions`. A validator
    // written from "paths IS the distinct path set of collisions" would reject
    // this legitimate frame; this row is what stops that implementation.
    const truncated = contested({
      paths: ["src/a.ts", "src/b.ts", TOUCH_SENTINEL],
      collisions: [
        { path: "src/a.ts", sessionIds: ["auth", "s9"] },
        { path: "src/b.ts", sessionIds: ["auth", "s2"] },
      ],
    });
    expect(parseDownFrame(truncated)).toEqual(truncated);

    // …and the producer's own worst case sits exactly on the cap: TOUCH_CAP real
    // paths plus the sentinel slot. A bound of TOUCH_CAP would reject it.
    const full = [...Array.from({ length: TOUCH_CAP }, (_, i) => `f${i}.ts`), TOUCH_SENTINEL];
    const capped = parseDownFrame(contested({ paths: full, collisions: [] }));
    expect(capped && "paths" in capped && capped.paths).toEqual(full);
  });

  test("carries ONLY the four wire fields — never a payload the hub tacked on", () => {
    // Thesis bound (§1.1): signal, never artifact. The frame is rebuilt from the
    // validated fields, so an extra key on the wire cannot ride into the laptop.
    const frame = parseDownFrame(contested({ transcript: "secret", prompts: ["x"] }));
    expect(frame && Object.keys(frame).sort()).toEqual(["collisions", "paths", "sessionId", "t"]);
  });

  test("rejects a contested frame whose sessionId is not a SLUG", () => {
    // The same `str(f.sessionId, SLUG)` treatment `publish` and `facts` already
    // get — no new regex, and the 40-char ceiling comes from SLUG itself.
    expect(parseDownFrame(contested({ sessionId: 7 }))).toBeNull();
    expect(parseDownFrame(contested({ sessionId: "" }))).toBeNull();
    expect(parseDownFrame(contested({ sessionId: "Alpha" }))).toBeNull();
    expect(parseDownFrame(contested({ sessionId: "a".repeat(41) }))).toBeNull();
    expect(parseDownFrame(contested({ sessionId: undefined }))).toBeNull();
    // …and exactly 40 chars, the SLUG ceiling, is accepted.
    expect(parseDownFrame(contested({ sessionId: "a".repeat(40) }))).not.toBeNull();
  });

  test("rejects a contested frame whose paths bust either bound, and accepts both bounds exactly", () => {
    expect(parseDownFrame(contested({ paths: "x" }))).toBeNull();
    expect(parseDownFrame(contested({ paths: undefined }))).toBeNull();
    expect(parseDownFrame(contested({ paths: [1] }))).toBeNull();
    expect(parseDownFrame(contested({ paths: ["d".repeat(PATH_WIRE_CAP + 1)] }))).toBeNull();
    expect(
      parseDownFrame(
        contested({ paths: Array.from({ length: TOUCH_CAP + 2 }, (_, i) => `f${i}.ts`) }),
      ),
    ).toBeNull();
    // Both bounds are inclusive, or "rejects everything" would pass this row.
    expect(
      parseDownFrame(contested({ paths: ["d".repeat(PATH_WIRE_CAP)], collisions: [] })),
    ).not.toBeNull();
  });

  test("rejects a contested frame whose collisions bust their bounds, and accepts them exactly", () => {
    const entry = { path: "src/a.ts", sessionIds: ["auth", "s9"] };
    expect(parseDownFrame(contested({ collisions: "x" }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: undefined }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: [null] }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: [{ path: "src/a.ts" }] }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: [{ sessionIds: ["s9"] }] }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: [{ path: 7, sessionIds: ["s9"] }] }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: [{ ...entry, sessionIds: [1] }] }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: [{ ...entry, sessionIds: [] }] }))).toBeNull();
    expect(parseDownFrame(contested({ collisions: [{ ...entry, sessionIds: "s9" }] }))).toBeNull();
    expect(
      parseDownFrame(
        contested({
          collisions: [{ ...entry, sessionIds: Array.from({ length: 101 }, (_, i) => `s${i}`) }],
        }),
      ),
    ).toBeNull();
    expect(
      parseDownFrame(
        contested({ collisions: [{ ...entry, path: "d".repeat(PATH_WIRE_CAP + 1) }] }),
      ),
    ).toBeNull();
    expect(
      parseDownFrame(
        contested({
          collisions: Array.from({ length: TOUCH_CAP + 2 }, (_, i) => ({
            path: `f${i}.ts`,
            sessionIds: ["s9"],
          })),
        }),
      ),
    ).toBeNull();
    // Every bound inclusive: 100 peers, a PATH_WIRE_CAP-char path, TOUCH_CAP + 1
    // entries (the producer's own worst case) all pass.
    expect(
      parseDownFrame(
        contested({
          collisions: [{ ...entry, sessionIds: Array.from({ length: 100 }, (_, i) => `s${i}`) }],
        }),
      ),
    ).not.toBeNull();
    expect(
      parseDownFrame(contested({ collisions: [{ ...entry, path: "d".repeat(PATH_WIRE_CAP) }] })),
    ).not.toBeNull();
    expect(
      parseDownFrame(
        contested({
          collisions: Array.from({ length: TOUCH_CAP + 1 }, (_, i) => ({
            path: `f${i}.ts`,
            sessionIds: ["s9"],
          })),
        }),
      ),
    ).not.toBeNull();
  });

  test("rejects a peer session id that is not a SLUG — not merely a long one", () => {
    // Peer ids are session ids of the same universe as the top-level one, and
    // Task 8b interpolates one straight into `contested with session ${id}`. An
    // implementation that bounds them only by LENGTH passes every case below and
    // must fail this row — a hostile hub would otherwise put arbitrary text,
    // newlines included, into a line a human reads on a permission card.
    const bad = [
      "Alpha",
      "a-41-character-long-session-id-aaaaaaaaaaa",
      "",
      "bad id with spaces",
      "ok\ninjected",
      "../etc",
      "s9\u0000",
    ];
    for (const id of bad) {
      expect(parseDownFrame(contested({ collisions: [{ path: "a.ts", sessionIds: [id] }] }))).toBeNull();
      // …and one bad id among good ones rejects the whole frame, never a subset.
      expect(
        parseDownFrame(contested({ collisions: [{ path: "a.ts", sessionIds: ["ok", id] }] })),
      ).toBeNull();
    }
    expect(
      parseDownFrame(
        contested({ collisions: [{ path: "a.ts", sessionIds: ["ok", "a".repeat(40)] }] }),
      ),
    ).not.toBeNull();
  });

  test("rejects control characters in a contested frame's paths", () => {
    // Same rule, same reason as the facts validator's `touched` row: these
    // strings reach the agent's prompt block and a human-read permission card,
    // so a newline is a forged line boundary, not a filename. An implementation
    // that checks only `length <= PATH_WIRE_CAP` fails this row.
    expect(parseDownFrame(contested({ paths: ["src/a.ts\ninjected: line"] }))).toBeNull();
    expect(parseDownFrame(contested({ paths: ["src/a.ts\rmore"] }))).toBeNull();
    expect(parseDownFrame(contested({ paths: ["src/a\u0000.ts"] }))).toBeNull();
    expect(parseDownFrame(contested({ paths: ["src/a\u001b[31m.ts"] }))).toBeNull();
    expect(parseDownFrame(contested({ paths: ["src/a\u007f.ts"] }))).toBeNull();
    expect(
      parseDownFrame(contested({ collisions: [{ path: "a\r.ts", sessionIds: ["s9"] }] })),
    ).toBeNull();
    expect(
      parseDownFrame(contested({ collisions: [{ path: "a\u0001.ts", sessionIds: ["s9"] }] })),
    ).toBeNull();
    expect(
      parseDownFrame(contested({ collisions: [{ path: "a\ninjected", sessionIds: ["s9"] }] })),
    ).toBeNull();
    // …while an ordinary non-ASCII path is not a control character.
    expect(
      parseDownFrame(
        contested({ paths: ["src/café.ts"], collisions: [{ path: "src/café.ts", sessionIds: ["s9"] }] }),
      ),
    ).not.toBeNull();
  });

  test("is a DOWN frame only, and does not disturb the unknown-frame path", () => {
    // A laptop built before this task ignores the frame on the unknown-frame
    // path — parseDownFrame returns null and relay.ts's onMessage returns —
    // rather than dropping the uplink, which is what lets a new frame TYPE ship
    // without a RELAY_PROTOCOL_VERSION bump. Both parsers still refuse anything
    // they do not know.
    expect(parseUpFrame(contested())).toBeNull();
    expect(parseDownFrame({ t: "evicted", sessionId: "auth" })).toBeNull();
    // The discriminator is `t`, like every other frame in both unions. A frame
    // keyed on `type` is not a contested frame — it is an unknown one, and the
    // parser must not accept it just because the rest of the shape lines up.
    expect(
      parseDownFrame({ type: "contested", sessionId: "auth", paths: [], collisions: [] }),
    ).toBeNull();
  });
});

/** The hub's `oversight_update` down-frame (Task 1). `latest.text` is the one
 *  free-text field — a model-authored team summary rendered in the browser — so
 *  it is length-bounded (control chars are NOT stripped: a multi-line narrative
 *  is the legitimate shape). Every other field is a slug/boolean/integer. */
const oversight = (over: Record<string, unknown> = {}) => ({
  t: "oversight_update",
  projectId: "default",
  enabled: true,
  latest: { text: "the team is shipping", ts: "2026-08-04T00:00:00.000Z", seq: 3 },
  ...over,
});

describe("parseDownFrame — oversight_update", () => {
  test("roundtrips an enabled frame with a summary, parsed to the exact shape", () => {
    expect(parseDownFrame(oversight())).toEqual({
      t: "oversight_update",
      projectId: "default",
      enabled: true,
      latest: { text: "the team is shipping", ts: "2026-08-04T00:00:00.000Z", seq: 3 },
    });
  });

  test("roundtrips a null-latest frame — enabled with no summary yet, and the disabled toggle", () => {
    expect(parseDownFrame(oversight({ latest: null }))).toEqual({
      t: "oversight_update",
      projectId: "default",
      enabled: true,
      latest: null,
    });
    expect(parseDownFrame(oversight({ enabled: false, latest: null }))).toEqual({
      t: "oversight_update",
      projectId: "default",
      enabled: false,
      latest: null,
    });
  });

  test("carries ONLY the four wire fields — never a payload the hub tacked on", () => {
    // Rebuilt from validated fields, like `contested`: an extra key on the wire
    // cannot ride into the laptop.
    const frame = parseDownFrame(oversight({ transcript: "secret", digest: ["x"] }));
    expect(frame && Object.keys(frame).sort()).toEqual([
      "enabled",
      "latest",
      "projectId",
      "t",
    ]);
  });

  test("accepts a summary text exactly at the 4096-char cap and rejects one over it", () => {
    const atCap = "s".repeat(OVERSIGHT_TEXT_CAP);
    const frame = parseDownFrame(oversight({ latest: { text: atCap, ts: "t", seq: 1 } }));
    expect(frame && frame.t === "oversight_update" && frame.latest?.text).toBe(atCap);
    expect(
      parseDownFrame(oversight({ latest: { text: "s".repeat(OVERSIGHT_TEXT_CAP + 1), ts: "t", seq: 1 } })),
    ).toBeNull();
  });

  test("keeps a multi-line summary intact — newlines are the narrative, not an injection", () => {
    // Unlike a path or a gate reason, the summary is model prose with one line
    // per session; control chars are its ordinary shape and must NOT be stripped
    // or rejected the way `touched`/`contested` reject them.
    const text = "The team is shipping.\nauth: wiring the gate.\nweb: styling.";
    const frame = parseDownFrame(oversight({ latest: { text, ts: "t", seq: 2 } }));
    expect(frame && frame.t === "oversight_update" && frame.latest?.text).toBe(text);
  });

  test("rejects a frame whose projectId is not a SLUG", () => {
    expect(parseDownFrame(oversight({ projectId: 7 }))).toBeNull();
    expect(parseDownFrame(oversight({ projectId: "" }))).toBeNull();
    expect(parseDownFrame(oversight({ projectId: "Bad Id" }))).toBeNull();
    expect(parseDownFrame(oversight({ projectId: undefined }))).toBeNull();
  });

  test("rejects a non-boolean enabled", () => {
    expect(parseDownFrame(oversight({ enabled: "yes" }))).toBeNull();
    expect(parseDownFrame(oversight({ enabled: 1 }))).toBeNull();
    expect(parseDownFrame(oversight({ enabled: undefined }))).toBeNull();
  });

  test("rejects a malformed latest — missing, mistyped or out-of-range fields", () => {
    expect(parseDownFrame(oversight({ latest: "summary" }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: 7 }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: [] }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { text: "x", ts: "t" } }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { text: "x", seq: 1 } }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { ts: "t", seq: 1 } }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { text: 7, ts: "t", seq: 1 } }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { text: "x", ts: 7, seq: 1 } }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { text: "x", ts: "t", seq: "1" } }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { text: "x", ts: "t", seq: 1.5 } }))).toBeNull();
    expect(parseDownFrame(oversight({ latest: { text: "x", ts: "t", seq: -1 } }))).toBeNull();
    // …and seq 0 is the ordinary floor (a seeded-but-never-summarized restore).
    expect(parseDownFrame(oversight({ latest: { text: "x", ts: "t", seq: 0 } }))).not.toBeNull();
  });

  test("is a DOWN frame only, and does not disturb the unknown-frame path", () => {
    // Additive, no RELAY_PROTOCOL_VERSION bump: a laptop built before this task
    // drops it on the unknown-frame path. The up parser never accepts it, and a
    // `type`-keyed lookalike is unknown, not an oversight_update.
    expect(parseUpFrame(oversight())).toBeNull();
    expect(
      parseDownFrame({ type: "oversight_update", projectId: "default", enabled: true, latest: null }),
    ).toBeNull();
  });
});

test("MAX_FRAME_BYTES is far below the ws default of 100MB", () => {
  // The `ws` default lets an unauthenticated peer push 100MB into JSON.parse
  // (spec §10.2). Tasks 3 and 7 apply this constant as maxPayload on both
  // sockets; pinning it here keeps the number in one place.
  expect(MAX_FRAME_BYTES).toBe(1_000_000);
});

test("RELAY_PROTOCOL_VERSION is unchanged by the additive touched field", () => {
  // `touched` is optional on the wire in both directions (spec §3.3), so a peer
  // that predates it neither sends nor needs it and a bump would strand every
  // running uplink for nothing. Pinned so adding the field cannot quietly bump it.
  expect(RELAY_PROTOCOL_VERSION).toBe(2);
});

test("RELAY_PROTOCOL_VERSION is unchanged by the additive gate reason", () => {
  // Same posture as Task 3's `touched`: `reason` is optional on the wire, so a
  // peer that ignores it still validates the frame AND still renders the gate.
  expect(RELAY_PROTOCOL_VERSION).toBe(2);
  const frame = parseUpFrame({
    t: "facts",
    sessionId: "auth",
    runId: "run-a",
    facts: { ...facts, pendingGate: { toolName: "Bash", sinceTs: "2026-07-27T10:00:00.000Z" } },
  });
  expect(frame?.t).toBe("facts");
});
