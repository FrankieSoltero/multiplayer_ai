/** Rate limits, connection caps and backpressure thresholds (spec §8.10 B2).
 *
 *  PURE by construction: this module imports nothing from `hub.ts` and reads no
 *  wall clock or disk of its own — the clock is injected. That is what lets the
 *  token bucket be unit-tested deterministically with a fake clock, and what
 *  keeps the wiring in `hub.ts` the only place that decides WHICH limit guards
 *  WHICH surface. */

/** Hard ceiling on concurrent WebSocket connections (browser AND uplink). The
 *  513th is refused at the connection handler before any dispatch. */
export const MAX_SOCKETS = 512;

/** Per-IP token-bucket cap on WS upgrades, refilled over a rolling minute. */
export const UPGRADES_PER_MIN_PER_IP = 30;

/** Per-IP token-bucket cap on `/auth/*` and `/pair/*` HTTP requests per minute.
 *  `/healthz` and static assets are never counted against it. */
export const HTTP_AUTH_PER_MIN_PER_IP = 30;

/** Per-connection message allowance inside `MSG_WINDOW_MS` for a BROWSER socket;
 *  the message that trips it is a protocol-flood close. Uplinks are exempt. */
export const MSGS_PER_WINDOW = 200;

/** The window `MSGS_PER_WINDOW` is measured over, in milliseconds. */
export const MSG_WINDOW_MS = 10_000;

/** When a socket's `bufferedAmount` exceeds this at a `send`, the hub closes it
 *  rather than buffering further — a reconnect replays. Applies to browsers AND
 *  uplinks. */
export const BUFFERED_MAX_BYTES = 4_000_000;

/** The soft ceiling on distinct keys the bucket map may hold before an inline
 *  eviction sweep runs. Not exported: it is an internal memory guard, not a
 *  tunable of the rate policy. */
const MAX_BUCKET_KEYS = 10_000;

interface Bucket {
  /** Tokens available as of `last`; lazily refilled on the next `take`. */
  tokens: number;
  /** The clock value `tokens` was last reconciled at. */
  last: number;
}

/** A per-key token bucket with lazy (compute-on-read) refill and an injectable
 *  clock. No timer and no separate prune method: a bucket refills only when its
 *  key is next taken, and the map is bounded by an INLINE eviction inside
 *  `take` — when a new key pushes the map past `MAX_BUCKET_KEYS`, every entry
 *  that has refilled back to full capacity (i.e. an idle IP that is costing
 *  nothing but memory) is dropped in that same call. A dropped key is
 *  indistinguishable from one that was never seen — both start full — so
 *  eviction never changes a rate decision, only frees memory. */
export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    /** Tokens regenerated per millisecond, e.g. `N / 60_000` for N-per-minute. */
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one token for `key`. Returns `true` when a token was available
   *  (allowed) or `false` when the key is currently rate-limited. */
  take(key: string): boolean {
    const t = this.now();
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: this.capacity, last: t };
    // Lazy refill: credit the time elapsed since this key was last touched,
    // never above capacity.
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.last) * this.refillPerMs);
    bucket.last = t;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    if (existing === undefined) {
      this.buckets.set(key, bucket);
      // A NEW key just grew the map. If that pushed it past the soft cap, evict
      // the idle (full-capacity) entries in this same call — the just-inserted
      // key has spent a token, so it is not full and survives its own sweep.
      if (this.buckets.size > MAX_BUCKET_KEYS) this.evictFull(t);
    }
    return allowed;
  }

  /** Drop every key whose bucket has refilled to full capacity as of `t`.
   *  Deleting during Map iteration is well-defined in JS. */
  private evictFull(t: number): void {
    for (const [key, bucket] of this.buckets) {
      const tokens = Math.min(
        this.capacity,
        bucket.tokens + (t - bucket.last) * this.refillPerMs,
      );
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
  }
}

/** The IP a rate-limit bucket keys on. When `trustProxy` is true the first
 *  comma-separated `X-Forwarded-For` entry wins (the client the proxy saw),
 *  trimmed, falling back to `remoteAddress` when the header is absent or its
 *  first entry is empty. When `trustProxy` is false the header is IGNORED
 *  entirely — an untrusted client must not be able to pick its own bucket by
 *  forging XFF — and `remoteAddress` is used. Missing everything → `"unknown"`,
 *  so every caller still keys on a defined string. */
export function clientIp(
  remoteAddress: string | undefined,
  xForwardedFor: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && xForwardedFor !== undefined) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? "unknown";
}
