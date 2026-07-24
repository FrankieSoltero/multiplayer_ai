import type { LoggedEvent, SessionEvent } from "./events.js";

export class Session {
  readonly id: string;
  private log: LoggedEvent[] = [];
  private subscribers = new Set<(e: LoggedEvent) => void>();
  private currentDriverId: string | null = null;
  private participants = new Map<string, string>();

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

  join(userId: string, name: string): void {
    this.participants.set(userId, name);
    this.append({ type: "presence_join", userId, name });
    if (this.currentDriverId === null) this.takeWheel(userId);
  }

  leave(userId: string): void {
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
  }

  takeWheel(userId: string): void {
    this.currentDriverId = userId;
    this.append({ type: "control_change", userId });
  }

  canPrompt(userId: string): boolean {
    return this.currentDriverId === userId;
  }
}
