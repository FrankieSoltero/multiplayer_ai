import type { FormEvent } from "react";
import { browserSignOut } from "../signOut";

/** Signed in with GitHub, but the login is not on the operator's allowlist.
 *  The only way out is to sign out and try another account. */
export function Denied(props: { login: string }) {
  // The form is kept as a no-JS fallback; the handler layers on the fetch +
  // reload, because /auth/logout answers 204 and browsers do not navigate on
  // 204 — a plain POST would clear the cookie and leave the screen identical.
  const signOut = async (e: FormEvent) => {
    e.preventDefault();
    await browserSignOut();
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
