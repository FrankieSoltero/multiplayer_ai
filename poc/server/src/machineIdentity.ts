import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MachineIdentity {
  machineId: string;
  name: string;
  roots: string[];
}

/** Same shape `relayProtocol.ts`'s ID regex admits, so a persisted id can
 *  never fail the hello parse. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function mpaiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MPAI_HOME && env.MPAI_HOME.length > 0
    ? env.MPAI_HOME
    : path.join(os.homedir(), ".mpai");
}

/** Read (or first-run mint) the persisted machine identity (spec §3).
 *
 *  Throws — never regenerates — on a corrupt file: a fresh machineId would
 *  orphan every session the hub attributes to the old one. Written atomically
 *  (temp + rename) so a crashed first run cannot half-write identity. */
export function loadMachineIdentity(dir: string): MachineIdentity {
  const file = path.join(dir, "machine.json");
  if (!fs.existsSync(file)) {
    const fresh = { machineId: randomUUID(), name: os.hostname() };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `machine.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(fresh, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ...fresh, roots: [] };
  }
  const fail = (): never => {
    throw new Error(
      `corrupt machine identity at ${file} — fix or delete it by hand; ` +
        `regenerating the id would orphan this machine's sessions on the hub`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fail();
  }
  const obj =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (!obj) return fail();
  const machineId =
    typeof obj.machineId === "string" && ID.test(obj.machineId) ? obj.machineId : null;
  const name =
    typeof obj.name === "string" && obj.name.length > 0 ? obj.name.slice(0, 40) : null;
  if (!machineId || !name) return fail();
  const roots = Array.isArray(obj.roots)
    ? obj.roots.filter((r): r is string => typeof r === "string")
    : [];
  return { machineId, name, roots };
}
