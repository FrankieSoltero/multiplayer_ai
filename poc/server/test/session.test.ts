import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import type { LoggedEvent } from "../src/events.js";

describe("Session event log", () => {
  it("appends events with monotonic sequence numbers and timestamps", () => {
    const s = new Session("s1");
    const a = s.append({ type: "user_message", userId: "u1", text: "hi" });
    const b = s.append({ type: "agent_text_delta", text: "hello" });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(typeof a.ts).toBe("string");
  });

  it("replays events from a given sequence number", () => {
    const s = new Session("s1");
    s.append({ type: "agent_text_delta", text: "one" });
    s.append({ type: "agent_text_delta", text: "two" });
    s.append({ type: "agent_text_delta", text: "three" });
    const replay = s.eventsFrom(1);
    expect(replay.map((e) => e.seq)).toEqual([1, 2]);
    expect(s.eventsFrom(0)).toHaveLength(3);
  });

  it("notifies subscribers of new events and stops after unsubscribe", () => {
    const s = new Session("s1");
    const received: LoggedEvent[] = [];
    const unsubscribe = s.subscribe((e) => received.push(e));
    s.append({ type: "agent_text_delta", text: "one" });
    unsubscribe();
    s.append({ type: "agent_text_delta", text: "two" });
    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(0);
  });
});
