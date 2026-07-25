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

describe("Steering lock", () => {
  it("makes the first joiner the driver and logs presence + control events", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    expect(s.driverId).toBe("u1");
    const types = s.eventsFrom(0).map((e) => e.type);
    expect(types).toEqual(["presence_join", "control_change"]);
  });

  it("does not change the driver when a second user joins", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.join("u2", "Ben");
    expect(s.driverId).toBe("u1");
  });

  it("transfers the wheel on takeWheel and gates canPrompt on the driver", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.join("u2", "Ben");
    expect(s.canPrompt("u2")).toBe(false);
    s.takeWheel("u2");
    expect(s.driverId).toBe("u2");
    expect(s.canPrompt("u2")).toBe(true);
    expect(s.canPrompt("u1")).toBe(false);
  });

  it("clears the driver when the driver leaves and logs presence_leave", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.leave("u1");
    expect(s.driverId).toBeNull();
    const last = s.eventsFrom(0).at(-1);
    expect(last?.type).toBe("presence_leave");
  });

  it("hands the wheel to a remaining participant when the driver leaves", () => {
    const s = new Session("s1");
    s.join("u1", "Ana");
    s.join("u2", "Ben");
    s.leave("u1");
    expect(s.driverId).toBe("u2");
    const last = s.eventsFrom(0).at(-1);
    expect(last).toMatchObject({ type: "control_change", userId: "u2" });
  });

  it("presence_join carries optional glyph and color", () => {
    const session = new Session("s");
    session.join("u1", "ana", { glyph: "▲", color: "#61afef" });
    const ev = session.eventsFrom(0).find((e) => e.type === "presence_join");
    expect(ev).toMatchObject({ userId: "u1", name: "ana", glyph: "▲", color: "#61afef" });
  });
});
