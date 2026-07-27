import type { FormEvent } from "react";

/** Signed in with GitHub, but the login is not on the operator's allowlist.
 *  The only way out is to sign out and try another account. */
export function Denied(props: { login: string }) {
  // /auth/logout answers 204, which a plain form POST would leave the page
  // sitting on — the button would look dead. Clear the cookie, then reload so
  // the auth probe re-runs and the screen actually changes.
  const signOut = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "include" });
    } catch { /* reload anyway — a failed logout still deserves a fresh probe */ }
    window.location.reload();
  };

  return (
    <div className="authscreen">
      <div className="authhero">NOT ON THE LIST</div>
      <div className="authsub">
        YOU ARE SIGNED IN AS <b>{props.login}</b> — ASK THE OPERATOR TO ADD THAT USERNAME.
      </div>
      <form method="post" action="/auth/logout" onSubmit={signOut}>
        <button className="authbtn" type="submit">SIGN OUT</button>
      </form>
    </div>
  );
}
