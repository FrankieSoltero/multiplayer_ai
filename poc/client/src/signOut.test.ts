import { describe, expect, test } from "vitest";
import { signOut } from "./signOut";

/** The deps are injected rather than mocked globally: `signOut` is the one
 *  piece of the sign-out path worth testing, and it is only testable at all
 *  because fetch and reload are parameters. */
function harness(fetchImpl: (url: string, init: RequestInit) => Promise<unknown>) {
  const calls: { url: string; init: RequestInit }[] = [];
  let reloads = 0;
  return {
    calls,
    reloads: () => reloads,
    run: () =>
      signOut({
        fetch: (url, init) => {
          calls.push({ url, init });
          return fetchImpl(url, init);
        },
        reload: () => {
          reloads++;
        },
      }),
  };
}

describe("signOut", () => {
  test("posts to /auth/logout with credentials so the cookie is sent", async () => {
    const h = harness(async () => undefined);

    await h.run();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("/auth/logout");
    expect(h.calls[0].init.method).toBe("POST");
    // Without this the cookie never reaches the server and the logout is a no-op.
    expect(h.calls[0].init.credentials).toBe("include");
  });

  test("reloads after the cookie is cleared", async () => {
    const h = harness(async () => undefined);

    await h.run();

    // /auth/logout answers 204 and browsers do not navigate on 204, so without
    // an explicit reload the screen never changes and the button looks dead.
    expect(h.reloads()).toBe(1);
  });

  test("reloads even when the logout request fails", async () => {
    const h = harness(async () => {
      throw new Error("network down");
    });

    await h.run();

    // A failed logout still deserves a fresh auth probe — leaving the user on a
    // stale signed-in UI is worse than re-checking.
    expect(h.reloads()).toBe(1);
  });
});
