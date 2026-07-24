import type { LoggedEvent, SessionEvent } from "./events.js";

export class Session {
  readonly id: string;
  private log: LoggedEvent[] = [];
  private subscribers = new Set<(e: LoggedEvent) => void>();

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
}
