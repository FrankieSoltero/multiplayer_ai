import type { MachineInfo, RepoDecl } from "./types";

/** One row in the MACHINES panel: a machine's repos split into DETACH targets
 *  (already attached) and ATTACH targets (candidates not yet attached). */
export type MachineRow = {
  machineId: string;
  name: string;
  online: boolean;
  attached: RepoDecl[]; // DETACH targets
  candidates: RepoDecl[]; // ATTACH targets
};

/** One row per machine, online or not — sessions outlive machines
 *  (`hubStore.ts:179-181`), so an offline machine's attached repos still
 *  name real history and its row must not disappear from under them. */
export function machineRows(machines: MachineInfo[]): MachineRow[] {
  return machines.map((machine) => ({
    machineId: machine.machineId,
    name: machine.name,
    online: machine.online,
    attached: machine.repos.filter((r) => r.attached),
    candidates: machine.repos.filter((r) => !r.attached),
  }));
}
