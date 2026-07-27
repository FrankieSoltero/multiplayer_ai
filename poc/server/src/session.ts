import type { LoggedEvent, SessionEvent } from "./events.js";

export class Session {
  readonly id: string;
  private log: LoggedEvent[] = [];
  private subscribers = new Set<(e: LoggedEvent) => void>();
  private currentDriverId: string | null = null;
  private participants = new Map<string, string>();
  // Survives disconnects for the life of the process (spec §4): a founder or
  // participant who reconnects without a token must not be re-gated by
  // requireInvite just because presence_leave already removed them from
  // `participants`. Only grows through a join that was already authorized.
  private admitted = new Set<string>();

  constructor(id: string) {
    this.id = id;
  }

  append(event: SessionEvent): LoggedEvent {
    const logged: LoggedEvent = {
      ...event,
      seq: this.log.length,
      ts: new Date().toISOString(),
    };
    this.log.push(logged);
    for (const fn of this.subscribers) fn(logged);
    return logged;
  }

  eventsFrom(seq: number): LoggedEvent[] {
    return this.log.slice(seq);
  }

  subscribe(fn: (e: LoggedEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get driverId(): string | null {
    return this.currentDriverId;
  }

  get participantList(): { userId: string; name: string }[] {
    return [...this.participants.entries()].map(([userId, name]) => ({
      userId,
      name,
    }));
  }

  nameOf(userId: string): string | undefined {
    return this.participants.get(userId);
  }

  hasBeenAdmitted(userId: string): boolean {
    return this.admitted.has(userId);
  }

  join(
    userId: string,
    name: string,
    identity?: { glyph?: string; color?: string },
  ): void {
    this.participants.set(userId, name);
    this.admitted.add(userId);
    this.append({
      type: "presence_join",
      userId,
      name,
      ...(identity?.glyph ? { glyph: identity.glyph } : {}),
      ...(identity?.color ? { color: identity.color } : {}),
    });
    if (this.currentDriverId === null) this.takeWheel(userId);
  }

  /** Idempotent: a user who is not currently a participant produces no event.
   *
   *  Load-bearing, not defensive. A deliberate exit sends `leave_session` and
   *  then reloads the page, so the server sees the command AND the socket
   *  close — and the close handler also calls this. Without the guard every
   *  deliberate exit writes two `presence_leave` events into an append-only
   *  log that is replayed to late joiners, and fires the last-leaver
   *  auto-close twice. Guarding here rather than at the call site covers both
   *  callers and any future one.
   *
   *  Keyed on current membership, not on history: a user who leaves, rejoins
   *  and leaves again has genuinely departed twice.
   *
   *  Returns whether this call actually removed a participant (spec §3.2):
   *  callers that decide something on emptiness — e.g. the last-leaver
   *  auto-close — must be able to tell a real departure from a no-op on an
   *  already-departed user, or a stale repeat call can take an action that
   *  is not attributable to anyone who actually just left. */
  leave(userId: string): boolean {
    if (!this.participants.has(userId)) return false;
    this.participants.delete(userId);
    this.append({ type: "presence_leave", userId });
    if (this.currentDriverId === userId) {
      const nextDriverId = this.participants.keys().next().value;
      if (nextDriverId !== undefined) {
        this.takeWheel(nextDriverId);
      } else {
        this.currentDriverId = null;
      }
    }
    return true;
  }

  takeWheel(userId: string): void {
    this.currentDriverId = userId;
    this.append({ type: "control_change", userId });
  }

  canPrompt(userId: string): boolean {
    return this.currentDriverId === userId;
  }
}
