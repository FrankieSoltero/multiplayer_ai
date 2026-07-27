/** Clears the session cookie, then forces a fresh auth probe.
 *
 *  Both dependencies are injected so this is testable without a browser: the
 *  whole sign-out path is otherwise untestable in a project with no
 *  component-test infrastructure.
 *
 *  The reload is not optional garnish. `/auth/logout` answers 204, and browsers
 *  do not navigate on 204, so a logout without a reload clears the cookie while
 *  leaving the screen visually identical — a button that looks dead. The reload
 *  also runs when the request fails: a stale signed-in UI is worse than
 *  re-probing and finding out. */
export interface SignOutDeps {
  fetch: (url: string, init: RequestInit) => Promise<unknown>;
  reload: () => void;
}

export async function signOut(deps: SignOutDeps): Promise<void> {
  try {
    await deps.fetch("/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* fall through — reload anyway */
  }
  deps.reload();
}

/** The browser-wired default, kept beside the pure core so callers do not each
 *  re-derive it. */
export const browserSignOut = (): Promise<void> =>
  signOut({
    fetch: (url, init) => globalThis.fetch(url, init),
    reload: () => window.location.reload(),
  });
