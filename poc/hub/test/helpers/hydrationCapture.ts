import type { RepoDecl, SessionFacts } from "multiplayer-ai-server/relayProtocol";
import type {
  HubHydration,
  HubPersister,
  ProjectLifecycle,
  StoredEvent,
} from "../../src/hubStore.js";

/** An in-memory `HubPersister` that records every call and can replay the
 *  resulting state as a `HubHydration` at any moment — the record a restarted
 *  hub would boot from, without a database.
 *
 *  It is what makes the hydration-equivalence property testable on its own
 *  (this file's owner, Task 3) and it is the ORACLE Task 4's round trip checks
 *  `HubDb.load()` against. It therefore stays free of any import from
 *  `hubDb.ts`: the thing under test may never define its own expected value.
 *
 *  **Everything recorded is deep-copied on the way in.** The store hands the
 *  persister its OWN live instances (see `HubPersister`'s note in
 *  `hubStore.ts`), so retaining them would let a later store mutation reach
 *  back into the captured record — and the equivalence property would then
 *  compare the store against itself and pass no matter what hydration did.
 *
 *  Order is the record's order: projects, machines and sessions come back in
 *  FIRST-save order, members in add order, events in append (== `id`) order.
 *  That is what a rowid-ordered SQL read produces, and `HubStore` rebuilds its
 *  maps by walking these arrays, so the order is load-bearing for the
 *  `listProjects()` / `snapshot()` equivalence. */
export function captureHydration(): { persister: HubPersister; hydration(): HubHydration } {
  interface ProjectRow {
    id: string;
    name: string;
    createdBy: string | null;
    createdAt: string;
    lifecycle: ProjectLifecycle;
    /** A Set, like the store's own membership, so add/remove/re-add order
     *  matches what `listProjects()` reports on the pre-restart store. */
    members: Set<string>;
  }
  interface MachineRow {
    uplinkId: string;
    projectId: string;
    name: string;
    repos: RepoDecl[];
  }
  interface SessionRow {
    projectId: string;
    sessionId: string;
    uplinkId: string;
    facts: SessionFacts;
    lastRunId: string | null;
    lastSeq: number;
    events: StoredEvent[];
  }

  const projects = new Map<string, ProjectRow>();
  const machines = new Map<string, MachineRow>();
  const sessions = new Map<string, SessionRow>();
  // Session ids are only unique within a project (hubStore.ts's documented
  // bound), so the key must carry both, joined by a NUL that neither can
  // contain.
  const key = (projectId: string, sessionId: string) => `${projectId}\u0000${sessionId}`;

  const persister: HubPersister = {
    projectSaved(p) {
      const existing = projects.get(p.id);
      if (existing) {
        // An upsert: the row is replaced, the membership rows are not — they
        // are their own calls, exactly as in a real record.
        existing.name = p.name;
        existing.createdBy = p.createdBy;
        existing.createdAt = p.createdAt;
        existing.lifecycle = p.lifecycle;
        return;
      }
      projects.set(p.id, { ...structuredClone(p), members: new Set() });
    },
    memberAdded(projectId, userId) {
      // The store always writes the project row before any membership in it,
      // so a missing row is unreachable here; nothing is invented for one.
      projects.get(projectId)?.members.add(userId);
    },
    memberRemoved(projectId, userId) {
      projects.get(projectId)?.members.delete(userId);
    },
    machineSaved(m) {
      const existing = machines.get(m.uplinkId);
      const copy = structuredClone(m);
      if (existing) {
        // Wholesale, mirroring the store (spec §5.2) — and `Map.set` on a key
        // it already holds keeps the row's original position, so re-declaring
        // repos never reorders `machinesIn()`.
        existing.projectId = copy.projectId;
        existing.name = copy.name;
        existing.repos = copy.repos;
        return;
      }
      machines.set(m.uplinkId, copy);
    },
    sessionSaved(s) {
      const existing = sessions.get(key(s.projectId, s.sessionId));
      const copy = structuredClone(s);
      if (existing) {
        existing.uplinkId = copy.uplinkId;
        existing.facts = copy.facts;
        existing.lastRunId = copy.lastRunId;
        existing.lastSeq = copy.lastSeq;
        return;
      }
      sessions.set(key(s.projectId, s.sessionId), { ...copy, events: [] });
    },
    eventsAppended(projectId, sessionId, events, lastRunId, lastSeq, newSession) {
      const k = key(projectId, sessionId);
      let row = sessions.get(k);
      if (!row) {
        if (!newSession) {
          // Loud on purpose. The frame carries no facts, so no honest row can
          // be written for a session the record has never been told about;
          // silently dropping the events would make the capture disagree with
          // the store for reasons no assertion could explain.
          throw new Error(
            `eventsAppended for unknown session "${sessionId}" in "${projectId}" with no newSession`,
          );
        }
        row = {
          projectId,
          sessionId,
          uplinkId: newSession.uplinkId,
          facts: structuredClone(newSession.facts),
          lastRunId: null,
          lastSeq: -1,
          events: [],
        };
        sessions.set(k, row);
      }
      for (const stored of events) row.events.push(structuredClone(stored));
      row.lastRunId = lastRunId;
      row.lastSeq = lastSeq;
    },
  };

  return {
    persister,
    /** A fresh, fully detached `HubHydration` — safe to hand to a `HubStore`
     *  and keep capturing afterwards. */
    hydration(): HubHydration {
      return {
        projects: [...projects.values()].map((p) => ({
          id: p.id,
          name: p.name,
          createdBy: p.createdBy,
          createdAt: p.createdAt,
          lifecycle: p.lifecycle,
          members: [...p.members],
        })),
        machines: [...machines.values()].map((m) => structuredClone(m)),
        sessions: [...sessions.values()].map((s) => structuredClone(s)),
      };
    },
  };
}
