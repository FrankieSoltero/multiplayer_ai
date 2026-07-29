/** The query string that routes back to the session picker.
 *
 *  Allow-list, not a delete-list: `project` is the only param worth carrying
 *  out of a session, so everything else is dropped by construction. A
 *  delete-list would silently carry any param added later — `invite` in
 *  particular would pull you straight back into the session you just left.
 *
 *  Every project is carried, `default` included, matching `joinSession`
 *  (SessionPicker.tsx). Dropping `default` returned the bare empty string,
 *  which the router reads as "no project" — so leaving a session in `default`
 *  landed on the hub entrance instead of that project's screen. */
export function pickerUrlFrom(search: string): string {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  const project = current.get("project");
  if (project !== null) next.set("project", project);
  return next.toString();
}

/** The query string that opens a session, built from the current one.
 *
 *  Both params are ALWAYS set, `default` included. Omitting `project` for the
 *  default project produced a `?session=X` URL that named no project, which
 *  routed straight back to the hub entrance — so in `default` no session could
 *  be opened from the UI and creating one never landed you in it (spec §4.3).
 *  Unlike `pickerUrlFrom` this preserves the rest of the query: you are going
 *  deeper into the same context, not leaving it. */
export function sessionUrlFrom(search: string, sessionId: string, projectId: string): string {
  const params = new URLSearchParams(search);
  params.set("session", sessionId);
  params.set("project", projectId);
  return params.toString();
}

/** Which project a URL is asking for, or null for the hub entrance.
 *
 *  The `default` fallback is conditional on purpose. Applied to every URL it
 *  made the project a hidden parameter nobody could see and the entrance
 *  unreachable; applied to none of them, a `?session=X` link with no `project`
 *  — every bookmark and shared link predating the entrance — resolved to no
 *  project and routed to the entrance instead of the session. A session id is
 *  evidence of somewhere to be, and `default` is the project those links have
 *  always meant (it is the CLI's default `--project` and the hub's fallback on
 *  `join`). Only a URL naming neither is a request for the entrance. */
export function activeProjectIdFrom(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.get("project") ?? (params.get("session") ? "default" : null);
}

/** The entrance is the hub root: no session, no project, no invite. Returning
 *  the empty string rather than building from `search` is deliberate — the
 *  entrance must never inherit a stale `project` or `invite` param, which
 *  would bounce the user straight back into what they just left.
 *
 *  Since `pickerUrlFrom` stopped dropping `project=default`, this is the only
 *  builder that yields the empty query — reaching the entrance is now always
 *  something the user asked for, never a side effect of leaving a session. */
export function entranceUrl(): string {
  return "";
}
