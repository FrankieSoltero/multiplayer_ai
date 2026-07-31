import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  httpBaseOf,
  loadHubToken,
  saveHubToken,
  clearHubToken,
  pairWithHub,
} from "../src/hubPairing.js";

const tmpDirs: string[] = [];
function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpai-hubpair-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A recording fetch stub: hands back the queued response for each URL suffix
 *  in call order, and remembers every (url, init) so a test can prove a secret
 *  rode in the BODY, never the URL (spec §10.1). */
function stubFetch(
  routes: Record<string, Array<{ status: number; body?: unknown } | "reject">>,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method?: string; body?: string }>;
} {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const cursor: Record<string, number> = {};
  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const key = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const i = cursor[key] ?? 0;
    cursor[key] = i + 1;
    const queue = routes[key];
    const step = queue[Math.min(i, queue.length - 1)];
    if (step === "reject") throw new Error("ECONNREFUSED");
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("httpBaseOf", () => {
  it("maps ws:// to http:// and drops path/query to the origin", () => {
    expect(httpBaseOf("ws://hub.example:4000/uplink")).toBe("http://hub.example:4000");
  });

  it("maps wss:// to https:// and drops path/query", () => {
    expect(httpBaseOf("wss://hub.example/uplink?token=nope")).toBe("https://hub.example");
  });

  it("keeps host verbatim with no path", () => {
    expect(httpBaseOf("ws://hub.test")).toBe("http://hub.test");
  });
});

describe("hub token store", () => {
  it("round-trips a token keyed by hub url", () => {
    const home = freshHome();
    saveHubToken(home, "ws://a.test", "tok-a");
    saveHubToken(home, "ws://b.test", "tok-b");
    expect(loadHubToken(home, "ws://a.test")).toBe("tok-a");
    expect(loadHubToken(home, "ws://b.test")).toBe("tok-b");
  });

  it("writes hubTokens.json with mode 0600", () => {
    const home = freshHome();
    saveHubToken(home, "ws://a.test", "tok-a");
    const mode = fs.statSync(path.join(home, "hubTokens.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null for an unknown url and a missing file", () => {
    const home = freshHome();
    expect(loadHubToken(home, "ws://never.test")).toBeNull();
    saveHubToken(home, "ws://a.test", "tok-a");
    expect(loadHubToken(home, "ws://other.test")).toBeNull();
  });

  it("treats a malformed file as empty instead of crashing", () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, "hubTokens.json"), "{ this is not json");
    expect(loadHubToken(home, "ws://a.test")).toBeNull();
    // A save over a malformed file must still succeed (malformed -> empty).
    saveHubToken(home, "ws://a.test", "tok-a");
    expect(loadHubToken(home, "ws://a.test")).toBe("tok-a");
  });

  it("clears one url's token and leaves the others, and no-ops on a missing file", () => {
    const home = freshHome();
    expect(() => clearHubToken(home, "ws://a.test")).not.toThrow();
    saveHubToken(home, "ws://a.test", "tok-a");
    saveHubToken(home, "ws://b.test", "tok-b");
    clearHubToken(home, "ws://a.test");
    expect(loadHubToken(home, "ws://a.test")).toBeNull();
    expect(loadHubToken(home, "ws://b.test")).toBe("tok-b");
  });
});

describe("pairWithHub", () => {
  const base = { httpBase: "http://hub.test", machineId: "machine-1", name: "franks-mbp" };

  it("prints the pairing line with the code grouped 4-4, polls, and returns the issued token", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/pair/request": [{ status: 200, body: { code: "ABCD1234" } }],
      "/pair/poll": [
        { status: 200, body: { status: "pending" } },
        { status: 200, body: { token: "tok-xyz" } },
      ],
    });
    const lines: string[] = [];
    const result = await pairWithHub({
      ...base,
      fetchImpl,
      print: (l) => lines.push(l),
      pollIntervalMs: 0,
    });
    expect(result).toEqual({ ok: true, token: "tok-xyz" });
    expect(lines).toEqual([
      "pair this machine: open http://hub.test in a signed-in browser and approve code ABCD-1234",
    ]);
    // Secret discipline (spec §10.1): the code rides in the POST body, never the URL.
    const request = calls.find((c) => c.url.endsWith("/pair/request"))!;
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body!)).toEqual({ machineId: "machine-1", name: "franks-mbp" });
    const poll = calls.find((c) => c.url.endsWith("/pair/poll"))!;
    expect(poll.url).toBe("http://hub.test/pair/poll");
    expect(JSON.parse(poll.body!)).toEqual({ code: "ABCD1234" });
  });

  it("returns ok with an empty token (no pairing) when the hub answers 404 to /pair/request (auth-off)", async () => {
    const { fetchImpl } = stubFetch({ "/pair/request": [{ status: 404 }] });
    const lines: string[] = [];
    const result = await pairWithHub({ ...base, fetchImpl, print: (l) => lines.push(l) });
    expect(result).toEqual({ ok: true, token: "" });
    // An auth-off hub prints nothing about pairing.
    expect(lines).toEqual([]);
  });

  it("reports expiry when the poll answers 404 after pending", async () => {
    const { fetchImpl } = stubFetch({
      "/pair/request": [{ status: 200, body: { code: "WXYZ7890" } }],
      "/pair/poll": [{ status: 200, body: { status: "pending" } }, { status: 404 }],
    });
    const result = await pairWithHub({
      ...base,
      fetchImpl,
      print: () => {},
      pollIntervalMs: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: "pairing expired — approve the code within 10 minutes",
    });
  });

  it("reports an unreachable hub, naming the base url", async () => {
    const { fetchImpl } = stubFetch({ "/pair/request": ["reject"] });
    const result = await pairWithHub({ ...base, fetchImpl, print: () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("http://hub.test");
  });
});
