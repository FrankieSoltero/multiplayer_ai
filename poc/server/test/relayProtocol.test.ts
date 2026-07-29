import { describe, expect, test } from "vitest";
import {
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseDownFrame,
  parseUpFrame,
  type RepoDecl,
} from "../src/relayProtocol.js";

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

test("MAX_FRAME_BYTES is far below the ws default of 100MB", () => {
  // The `ws` default lets an unauthenticated peer push 100MB into JSON.parse
  // (spec §10.2). Tasks 3 and 7 apply this constant as maxPayload on both
  // sockets; pinning it here keeps the number in one place.
  expect(MAX_FRAME_BYTES).toBe(1_000_000);
});
