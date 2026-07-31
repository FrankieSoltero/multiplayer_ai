import fs from "node:fs";
import path from "node:path";

/** The HTTP origin that answers a `ws(s)://` hub's pairing routes. Pairing is a
 *  plain HTTP exchange (POST /pair/request, POST /pair/poll); the uplink itself
 *  is the WebSocket. `ws://` → `http://`, `wss://` → `https://`, host and port
 *  verbatim, any path/query dropped to the bare origin — the routes are mounted
 *  at the origin, not under the uplink path. */
export function httpBaseOf(hubUrl: string): string {
  // `URL.origin` already strips path/query and preserves host:port. The scheme
  // swap is a prefix rewrite: `wss` → `https`, `ws` → `http` (order matters —
  // test `^ws` after the `s` is folded in by replacing only the leading `ws`).
  const origin = new URL(hubUrl).origin;
  return origin.replace(/^ws/, "http");
}

const STORE_FILE = "hubTokens.json";

/** Read the token map, tolerating everything: a missing file, unreadable file,
 *  non-JSON, or a JSON value that is not a string→string object all collapse to
 *  an empty map. A corrupt token file must never crash a launch — the worst it
 *  can do is force a re-pair, which is recoverable; a thrown error on startup is
 *  not. */
function readStore(home: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, STORE_FILE), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Atomic, 0600 write of the whole token map. Temp-then-rename mirrors
 *  `machineIdentity.ts` so a crash mid-write cannot leave a half-written store,
 *  and `mode: 0o600` keeps a bearer readable only by its owner (least
 *  privilege — the file is a credential). `renameSync` preserves the temp
 *  file's mode, so the destination lands 0600 on first creation and on every
 *  rewrite. */
function writeStore(home: string, store: Record<string, string>): void {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, STORE_FILE);
  const tmp = path.join(home, `${STORE_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadHubToken(home: string, hubUrl: string): string | null {
  return readStore(home)[hubUrl] ?? null;
}

export function saveHubToken(home: string, hubUrl: string, token: string): void {
  const store = readStore(home);
  store[hubUrl] = token;
  writeStore(home, store);
}

export function clearHubToken(home: string, hubUrl: string): void {
  const store = readStore(home);
  if (!(hubUrl in store)) return; // nothing to clear, and no file to create
  delete store[hubUrl];
  writeStore(home, store);
}

/** Display a pairing code grouped 4-4 (`ABCD1234` → `ABCD-1234`). A person is
 *  reading it off one screen and typing/approving it on another; the group makes
 *  an 8-char code legible without an eye-slip. Idempotent for an
 *  already-grouped code, and a leave-alone for any non-8-char code the hub might
 *  send. */
function groupCode(code: string): string {
  const bare = code.replace(/[^A-Za-z0-9]/g, "");
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : code;
}

const PAIR_POLL_INTERVAL_MS = 2000;

/** How the hub answers `POST /pair/request`. */
interface PairRequestBody {
  code?: unknown;
}
/** How the hub answers `POST /pair/poll`. */
interface PairPollBody {
  status?: unknown;
  token?: unknown;
}

export interface PairDeps {
  /** The hub's HTTP origin (`httpBaseOf(hubUrl)`). */
  httpBase: string;
  machineId: string;
  name: string;
  /** Injected so tests never touch the network (same seam as `auth.ts`'s
   *  `exchangeCode`). Falls back to the global `fetch`. */
  fetchImpl?: typeof fetch;
  print: (line: string) => void;
  /** Defaults to 2000ms (spec: "polls every 2s"); set to 0 in tests. */
  pollIntervalMs?: number;
}

/** Drive the pairing handshake against a hub (spec A2/A3).
 *
 *  - Auth-off hub → `POST /pair/request` answers 404 → `{ ok: true, token: "" }`.
 *    An empty token means "proceed with a bare uplink" (Task 8 accepts it), so
 *    the dev flow stays zero-config.
 *  - Auth-on hub → 200 `{ code }` → print the pairing instruction, then poll
 *    `POST /pair/poll` every `pollIntervalMs` until the hub returns a token
 *    (`{ ok: true, token }`) or 404s the code (expired).
 *
 *  Secrets travel in POST bodies, never URLs (spec §10.1): the machine id/name
 *  in `/pair/request`, the code in `/pair/poll`. */
export async function pairWithHub(
  deps: PairDeps,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollInterval = deps.pollIntervalMs ?? PAIR_POLL_INTERVAL_MS;
  const post = (route: string, body: unknown) =>
    fetchImpl(`${deps.httpBase}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let requestRes: Response;
  try {
    requestRes = await post("/pair/request", { machineId: deps.machineId, name: deps.name });
  } catch (err) {
    return { ok: false, error: unreachable(deps.httpBase, err) };
  }
  // Auth-off hub: no pairing surface. Proceed with no token (Task 8).
  if (requestRes.status === 404) return { ok: true, token: "" };
  if (requestRes.status !== 200) {
    return { ok: false, error: `hub at ${deps.httpBase} refused the pairing request (${requestRes.status})` };
  }
  let code: string;
  try {
    const body = (await requestRes.json()) as PairRequestBody;
    if (typeof body.code !== "string" || body.code.length === 0) throw new Error("no code");
    code = body.code;
  } catch {
    return { ok: false, error: `hub at ${deps.httpBase} sent no pairing code` };
  }

  deps.print(
    `pair this machine: open ${deps.httpBase} in a signed-in browser and approve code ${groupCode(code)}`,
  );

  // Poll until the code is approved (token) or the hub expires it (404). The
  // hub owns the TTL (spec §10.5) and signals expiry with a 404, so the loop
  // trusts that signal rather than racing its own clock.
  for (;;) {
    let pollRes: Response;
    try {
      pollRes = await post("/pair/poll", { code });
    } catch (err) {
      return { ok: false, error: unreachable(deps.httpBase, err) };
    }
    if (pollRes.status === 404) {
      return { ok: false, error: "pairing expired — approve the code within 10 minutes" };
    }
    if (pollRes.status !== 200) {
      return { ok: false, error: `hub at ${deps.httpBase} failed the pairing poll (${pollRes.status})` };
    }
    let body: PairPollBody;
    try {
      body = (await pollRes.json()) as PairPollBody;
    } catch {
      return { ok: false, error: `hub at ${deps.httpBase} sent a malformed pairing poll response` };
    }
    if (typeof body.token === "string" && body.token.length > 0) {
      return { ok: true, token: body.token };
    }
    // Anything else (including `{ status: "pending" }`) means keep waiting.
    await sleep(pollInterval);
  }
}

function unreachable(httpBase: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `cannot reach hub at ${httpBase} — ${reason}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
