import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAuth, type AuthConfig } from "multiplayer-ai-server/auth";
import type { DeviceStore } from "./hubDb.js";

/** A pairing code is valid for ten minutes (spec §10.5: short-TTL). Exported so
 *  Task 8's wiring and any client share one source of truth. */
export const PAIRING_CODE_TTL_MS = 600_000;

/** The most codes that may be outstanding at once. A DoS ceiling on in-memory
 *  pending state — the 101st concurrent request is refused (429), not queued. */
export const MAX_PENDING_PAIRINGS = 100;

/** The token's at-rest form: a device record stores THIS, never the plaintext
 *  bearer (spec §10.5). Shared with Task 8's uplink lookup so mint and verify
 *  hash identically. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Persisted machineId shape, spelled locally per the brief — the canonical
 *  source is `relayProtocol.ts:153` / `machineIdentity.ts:14`
 *  (`/^[A-Za-z0-9_-]{1,64}$/`); a private copy keeps this module from importing
 *  a relay concern just for a regex. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Unambiguous alphabet (spec §10.5): no 0/O, 1/I/L, U/V confusables, so a code
 *  read aloud or copied by hand round-trips. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

/** Bodies are read to a hard ceiling BEFORE parse (spec §10.2: limits precede
 *  work): a code or a machineId is tens of bytes, so anything past 4096 is
 *  refused as an attack, not accommodated. */
const MAX_BODY_BYTES = 4096;

/** Everything known about one code between `/pair/request` and the poll that
 *  consumes it. `token` is null until an allowlisted browser approves; once set,
 *  the next poll hands it over and deletes the entry (single-use). Pending state
 *  is in-memory ONLY — a hub restart drops it; approved devices live in HubDb. */
interface Pending {
  machineId: string;
  name: string;
  createdAt: number;
  token: string | null;
}

/** Uppercase and strip the display-only grouping dashes so `xxxx-xxxx`,
 *  `XXXXXXXX` and `xxxxxxxx` all match the stored code. */
function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.toUpperCase().replace(/-/g, "") : "";
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Reads the request body to at most `MAX_BODY_BYTES`, aborting the moment it is
 *  exceeded. Resolves `{ tooLarge: true }` for an over-limit body, `{ body }`
 *  otherwise. Never throws — a stream error resolves as an empty body, handled
 *  as a parse miss downstream. */
function readBody(req: IncomingMessage): Promise<{ body: string } | { tooLarge: true }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { body: string } | { tooLarge: true }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ tooLarge: true });
        // Drain the rest into nowhere rather than destroy the socket: an abrupt
        // teardown races the 413 we are about to send and the client sees a
        // dropped connection instead of the status. We stop BUFFERING at the
        // ceiling (chunks are no longer kept once settled), so memory is bounded
        // even though the bytes keep arriving.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ body: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => finish({ body: "" }));
  });
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pure routes for the pairing flow (spec §A2, §10.5) — NOT wired into `hub.ts`
 *  here (that is Task 8). Boolean-handler contract, identical to `authRoutes`:
 *  `false` means "not mine, keep looking", `true` means "consumed, response
 *  sent (or in flight)".
 *
 *  @param deps.auth      the hub's auth config, or undefined when auth is off —
 *                        every `/pair/*` route then 404s (pairing is meaningless
 *                        without an approver identity).
 *  @param deps.devices   the persistent device store, or null when the hub has
 *                        no record — pairing then 503s (an issued bearer must
 *                        survive a restart, so it needs a home).
 *  @param deps.onRevoked notified after a device is revoked, so a live uplink
 *                        for it can be dropped.
 *  @param deps.now       clock seam for TTL; defaults to `Date.now`. */
export function pairingRoutes(deps: {
  auth: AuthConfig | undefined;
  devices: DeviceStore | null;
  onRevoked: (machineId: string) => void;
  now?: () => number;
}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const now = deps.now ?? Date.now;
  /** In-memory only, keyed by the normalized code. */
  const pending = new Map<string, Pending>();

  /** The live entry for a code, or null — an entry older than the TTL is treated
   *  as absent AND deleted on the way past (lazy expiry, no timer, spec §10.5). */
  const live = (code: string): Pending | null => {
    const entry = pending.get(code);
    if (!entry) return null;
    if (now() - entry.createdAt > PAIRING_CODE_TTL_MS) {
      pending.delete(code);
      return null;
    }
    return entry;
  };

  /** Drops every expired entry so the pending cap counts only live codes. */
  const sweepExpired = (): void => {
    const cutoff = now() - PAIRING_CODE_TTL_MS;
    for (const [code, entry] of pending) {
      if (entry.createdAt < cutoff) pending.delete(code);
    }
  };

  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://x");
    } catch {
      return false;
    }
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (!path.startsWith("/pair/")) return false;

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // Auth off: pairing needs a browser identity to approve against, so every
    // /pair/* path 404s — the same shape authRoutes uses for its off state.
    if (!deps.auth) {
      json(404, { error: "auth is not configured" });
      return true;
    }
    // Auth on but no record: an issued bearer must outlive a restart, which an
    // in-memory-only hub cannot promise. Refuse rather than mint a bearer that
    // silently dies on the next boot.
    if (!deps.devices) {
      json(503, { error: "pairing requires a persistent hub record — set HUB_DB" });
      return true;
    }
    const cfg = deps.auth;
    const devices = deps.devices;

    const routes = new Set(["/pair/request", "/pair/approve", "/pair/poll", "/pair/revoke"]);
    if (!routes.has(path) || req.method !== "POST") {
      json(404, { error: "unknown pairing route" });
      return true;
    }

    /** Verifies the session cookie for the browser-side routes; returns the
     *  approver login, or null after having already answered 401/403. */
    const requireApprover = (): string | null => {
      const check = requireAuth(req.headers.cookie, cfg);
      if (!check.ok) {
        json(check.error === "authentication required" ? 401 : 403, { error: check.error });
        return null;
      }
      // cfg is defined here, so an ok check always carries a login; the guard is
      // for the type, not a reachable state.
      if (check.login === null) {
        json(401, { error: "authentication required" });
        return null;
      }
      return check.login;
    };

    void readBody(req).then((result) => {
      if ("tooLarge" in result) {
        json(413, { error: "request body too large" });
        return;
      }
      const parsed = parseJson(result.body);

      if (path === "/pair/request") {
        const machineId = parsed?.machineId;
        const name = parsed?.name;
        if (
          typeof machineId !== "string" ||
          !ID.test(machineId) ||
          typeof name !== "string" ||
          name.length < 1 ||
          name.length > 40
        ) {
          json(400, { error: "pair request requires machineId and name" });
          return;
        }
        sweepExpired();
        if (pending.size >= MAX_PENDING_PAIRINGS) {
          json(429, { error: "too many pending pairings" });
          return;
        }
        // Collision is astronomically unlikely (30^8), but a duplicate would
        // silently shadow a live pairing — so retry into a free slot.
        let code = generateCode();
        while (pending.has(code)) code = generateCode();
        pending.set(code, { machineId, name, createdAt: now(), token: null });
        json(200, { code });
        return;
      }

      if (path === "/pair/approve") {
        const login = requireApprover();
        if (login === null) return;
        const entry = live(normalizeCode(parsed?.code));
        if (!entry) {
          json(404, { error: "unknown or expired code" });
          return;
        }
        // Mint the opaque bearer, hand the store only its hash, and hold the
        // plaintext in the pending entry until exactly one poll retrieves it.
        const token = crypto.randomBytes(32).toString("base64url");
        devices.deviceApproved({
          machineId: entry.machineId,
          name: entry.name,
          tokenHash: hashToken(token),
          approvedBy: login,
          approvedAt: new Date(now()).toISOString(),
        });
        entry.token = token;
        json(200, { machineId: entry.machineId, name: entry.name });
        return;
      }

      if (path === "/pair/poll") {
        const code = normalizeCode(parsed?.code);
        const entry = live(code);
        if (!entry) {
          json(404, { error: "unknown or expired code" });
          return;
        }
        if (entry.token === null) {
          json(200, { status: "pending" });
          return;
        }
        // Single-use (spec §10.5): the token is delivered once, then the entry
        // is gone — a second poll is a 404 like any other unknown code.
        const token = entry.token;
        pending.delete(code);
        json(200, { token });
        return;
      }

      // path === "/pair/revoke"
      const login = requireApprover();
      if (login === null) return;
      const machineId = typeof parsed?.machineId === "string" ? parsed.machineId : "";
      if (devices.deviceRevoked(machineId)) {
        deps.onRevoked(machineId);
        json(200, { revoked: true });
        return;
      }
      json(404, { error: "unknown device" });
    }).catch(() => {
      // A throw inside the async handler — a DeviceStore call hitting a disk
      // error is the realistic case — would otherwise become an unhandled
      // rejection and leave the client's request hanging with no status. Answer
      // 500 instead, but only if nothing has been written yet: a failure after
      // the response began cannot be turned into a clean status.
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });

    return true;
  };
}
