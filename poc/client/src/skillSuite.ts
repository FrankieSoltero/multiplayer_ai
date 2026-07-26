import type { ProjectSessionInfo } from "./types";
import { notRemoved } from "./slashMatch";

export interface SuiteSkill {
  name: string;
  description: string;
  sources: { sessionId: string; driverName: string | null }[];
}

/** Party-wide skill suite: the union of every session's roster, deduped by
 *  skill name (first non-empty description wins), alphabetical. */
export function suiteFromSessions(sessions: ProjectSessionInfo[]): SuiteSkill[] {
  const byName = new Map<string, SuiteSkill>();
  for (const s of sessions) {
    for (const sk of (s.skills ?? []).filter(notRemoved)) {
      const cur = byName.get(sk.name);
      if (cur) {
        if (!cur.sources.some((src) => src.sessionId === s.id)) {
          cur.sources.push({ sessionId: s.id, driverName: s.driverName });
        }
        if (!cur.description && sk.description) cur.description = sk.description;
      } else {
        byName.set(sk.name, {
          name: sk.name,
          description: sk.description,
          sources: [{ sessionId: s.id, driverName: s.driverName }],
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
