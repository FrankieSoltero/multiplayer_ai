/** The query string that routes back to the session picker.
 *
 *  Allow-list, not a delete-list: `project` is the only param worth carrying
 *  out of a session, so everything else is dropped by construction. A
 *  delete-list would silently carry any param added later — `invite` in
 *  particular would pull you straight back into the session you just left.
 *
 *  `project=default` is omitted to match `joinSession` (SessionPicker.tsx),
 *  which only sets the param when it is not the default. */
export function pickerUrlFrom(search: string): string {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  const project = current.get("project");
  if (project !== null && project !== "default") next.set("project", project);
  return next.toString();
}

/** The entrance is the hub root: no session, no project, no invite. Returning
 *  the empty string rather than building from `search` is deliberate — the
 *  entrance must never inherit a stale `project` or `invite` param, which
 *  would bounce the user straight back into what they just left. */
export function entranceUrl(): string {
  return "";
}
