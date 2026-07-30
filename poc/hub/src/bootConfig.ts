import os from "node:os";
import path from "node:path";

/** Where the hub's sqlite store lives (spec §3.1, §8a.2).
 *
 *  `HUB_DB` wins and is returned VERBATIM — including sqlite's ":memory:"
 *  sentinel, which must never be path-joined or resolved (that would create a
 *  file literally named ":memory:" and silently persist what the caller asked
 *  to keep in memory). Otherwise the store sits next to §8.3's machine.json
 *  under the same dotdir/override convention (owner ruling, spec §8a.2), so a
 *  single MPAI_HOME relocates identity and store together.
 *
 *  `env` is a parameter, never read from `process.env` inside: the daemon
 *  passes its real environment, tests pass a literal, and neither can leak
 *  into the other.
 */
export function hubDbPath(env: NodeJS.ProcessEnv): string {
  // Empty is treated as unset for both overrides — `HUB_DB=` in a .env yields
  // "", which is not a usable path. Same guard as machineIdentity.mpaiHome().
  if (env.HUB_DB && env.HUB_DB.length > 0) return env.HUB_DB;
  const home =
    env.MPAI_HOME && env.MPAI_HOME.length > 0
      ? env.MPAI_HOME
      : path.join(os.homedir(), ".mpai");
  return path.join(home, "hub.db");
}

/** One boot line naming the store the hub actually opened.
 *
 *  Observability only — a house logging convention, not a spec §3.1
 *  requirement — but it is the operator's only signal that a run they expect
 *  to persist is not quietly in-memory, so the three shapes stay distinct:
 *  no dbPath at all, the explicit ":memory:" sentinel, and a real file.
 */
export function storeLogLine(dbPath: string | undefined): string {
  if (dbPath === undefined) return "hub store: in-memory (no dbPath)";
  if (dbPath === ":memory:") return "hub store: in-memory";
  return `hub store: sqlite ${dbPath}`;
}
