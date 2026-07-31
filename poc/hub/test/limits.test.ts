import { describe, expect, it } from "vitest";
import {
  TokenBucket,
  clientIp,
  MAX_SOCKETS,
  UPGRADES_PER_MIN_PER_IP,
  HTTP_AUTH_PER_MIN_PER_IP,
  MSGS_PER_WINDOW,
  MSG_WINDOW_MS,
  BUFFERED_MAX_BYTES,
} from "../src/limits.js";

/** Reach into the private per-key map so eviction — which frees memory rather
 *  than changing an answer — can be asserted at all. White-box only: `buckets`
 *  is an implementation detail, never an export. */
const mapSize = (bucket: TokenBucket): number =>
  (bucket as unknown as { buckets: Map<string, unknown> }).buckets.size;

describe("limits — exported constants (spec B2, exact values)", () => {
  it("carries the exact caps the spec fixes", () => {
    expect(MAX_SOCKETS).toBe(512);
    expect(UPGRADES_PER_MIN_PER_IP).toBe(30);
    expect(HTTP_AUTH_PER_MIN_PER_IP).toBe(30);
    expect(MSGS_PER_WINDOW).toBe(200);
    expect(MSG_WINDOW_MS).toBe(10_000);
    expect(BUFFERED_MAX_BYTES).toBe(4_000_000);
  });
});

describe("TokenBucket — lazy refill with an injected clock (spec B2)", () => {
  it("allows up to capacity, then refuses while empty", () => {
    let t = 0;
    const bucket = new TokenBucket(3, 1, () => t); // 1 token/ms, clock frozen
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(false); // capacity spent, clock has not moved
  });

  it("refills over elapsed time, capped at capacity", () => {
    let t = 0;
    const bucket = new TokenBucket(2, 1, () => t); // 1 token/ms
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(false);
    t = 1; // one token back
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(false);
    t = 10_000; // long idle refills only to capacity, never above
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(false);
  });

  it("keys are independent — one IP draining does not touch another", () => {
    let t = 0;
    const bucket = new TokenBucket(1, 1, () => t);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(false); // a is empty
    expect(bucket.take("b")).toBe(true); // b is untouched
  });

  it("defaults the clock to Date.now when none is injected", () => {
    const bucket = new TokenBucket(1, 1);
    expect(bucket.take("ip")).toBe(true);
    expect(bucket.take("ip")).toBe(false);
  });

  it("evicts full-capacity buckets inline once the map exceeds 10_000 keys", () => {
    let t = 0;
    const bucket = new TokenBucket(1, 1, () => t); // full again 1ms after any use
    for (let i = 0; i < 10_000; i += 1) bucket.take(`k${i}`); // 10_000 keys, each now empty
    expect(mapSize(bucket)).toBe(10_000);

    t = 1000; // every existing bucket has refilled to full capacity
    expect(bucket.take("overflow")).toBe(true); // the 10_001st key triggers the sweep
    // The 10_000 full keys are dropped in this very take(); only "overflow"
    // (just spent, so not full) survives.
    expect(mapSize(bucket)).toBe(1);
  });

  it("leaves non-full buckets in place during the eviction sweep", () => {
    let t = 0;
    const bucket = new TokenBucket(1, 1, () => t);
    for (let i = 0; i < 10_000; i += 1) bucket.take(`k${i}`); // all empty, none full
    // Clock never advances: every bucket is still at 0 tokens, so the sweep
    // finds nothing to drop and the map is allowed to grow past the soft cap.
    bucket.take("overflow");
    expect(mapSize(bucket)).toBe(10_001);
  });
});

describe("clientIp — proxy-trusted derivation (spec B2)", () => {
  it("trustProxy true: takes the first XFF entry, trimmed", () => {
    expect(clientIp("10.0.0.1", "203.0.113.7, 70.1.2.3", true)).toBe("203.0.113.7");
    expect(clientIp("10.0.0.1", "  203.0.113.7  ", true)).toBe("203.0.113.7");
  });

  it("trustProxy true but no XFF: falls back to remoteAddress", () => {
    expect(clientIp("10.0.0.1", undefined, true)).toBe("10.0.0.1");
  });

  it("trustProxy true with an empty XFF entry: falls back to remoteAddress", () => {
    expect(clientIp("10.0.0.1", "  , 70.1.2.3", true)).toBe("10.0.0.1");
  });

  it("trustProxy false: ignores XFF entirely, uses remoteAddress", () => {
    // An untrusted client must not be able to choose its own rate-limit bucket.
    expect(clientIp("10.0.0.1", "203.0.113.7", false)).toBe("10.0.0.1");
  });

  it("no remoteAddress and no usable XFF: reports \"unknown\"", () => {
    expect(clientIp(undefined, undefined, false)).toBe("unknown");
    expect(clientIp(undefined, undefined, true)).toBe("unknown");
  });
});
