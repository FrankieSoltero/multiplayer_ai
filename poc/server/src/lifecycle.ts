import type { LoggedEvent } from "./events.js";

export type Lifecycle = "open" | "closed";

/** Has someone deliberately ended this session (spec §3.4)?
 *
 *  Distinct from `ended`, which means the agent PROCESS died, and from
 *  `presence`, which means the owning machine is unreachable. Today those
 *  three render identically; splitting them is the point of v7a.
 *
 *  Closing is one-way: reopening would need its own event and its own
 *  decision about what happens to the dead agent process.
 *
 *  Closing stops NEW work from being started (see the guards in server.ts);
 *  it does not interrupt a run already in flight — that is `task_stop`. A
 *  row labelled `closed` can still be streaming assistant output. */
export function lifecycleOf(events: LoggedEvent[]): Lifecycle {
  for (const ev of events) {
    if (ev.type === "session_closed") return "closed";
  }
  return "open";
}
