import { describe, expect, it } from "vitest";
import { expiryLabel, inviteLinkFor, inviteTokenFrom, seatsLabel, seatsLeftLabel } from "./inviteLink";

describe("inviteTokenFrom", () => {
  it("reads the invite param", () => {
    expect(inviteTokenFrom("?invite=abc123")).toBe("abc123");
    expect(inviteTokenFrom("?session=alpha&invite=abc123")).toBe("abc123");
  });
  it("returns null when absent or empty", () => {
    expect(inviteTokenFrom("")).toBeNull();
    expect(inviteTokenFrom("?session=alpha")).toBeNull();
    expect(inviteTokenFrom("?invite=")).toBeNull();
  });
});

describe("inviteLinkFor", () => {
  it("builds a link carrying only the token", () => {
    expect(inviteLinkFor("tok", "http://localhost:3001")).toBe("http://localhost:3001/?invite=tok");
  });
  it("tolerates a trailing slash on the origin", () => {
    expect(inviteLinkFor("tok", "http://localhost:3001/")).toBe("http://localhost:3001/?invite=tok");
  });
});

describe("seatsLabel", () => {
  it("reports remaining seats", () => {
    expect(seatsLabel({ uses: 0, maxUses: 10 })).toBe("10 SEATS LEFT");
    expect(seatsLabel({ uses: 9, maxUses: 10 })).toBe("1 SEAT LEFT");
    expect(seatsLabel({ uses: 10, maxUses: 10 })).toBe("NO SEATS LEFT");
  });
});

describe("seatsLeftLabel", () => {
  it("reports the single source of truth text for 0, 1, many, and negative", () => {
    expect(seatsLeftLabel(0)).toBe("NO SEATS LEFT");
    expect(seatsLeftLabel(1)).toBe("1 SEAT LEFT");
    expect(seatsLeftLabel(2)).toBe("2 SEATS LEFT");
    expect(seatsLeftLabel(-3)).toBe("NO SEATS LEFT");
  });
});

describe("expiryLabel", () => {
  const now = 1_000_000;
  it("reports hours then minutes", () => {
    expect(expiryLabel(now + 5 * 3600_000, now)).toBe("EXPIRES IN 5H");
    expect(expiryLabel(now + 3600_000, now)).toBe("EXPIRES IN 1H");
    expect(expiryLabel(now + 59 * 60_000, now)).toBe("EXPIRES IN 59M");
    expect(expiryLabel(now + 60_000, now)).toBe("EXPIRES IN 1M");
  });
  it("collapses the past and the last minute", () => {
    expect(expiryLabel(now, now)).toBe("EXPIRED");
    expect(expiryLabel(now - 1, now)).toBe("EXPIRED");
    expect(expiryLabel(now + 59_000, now)).toBe("EXPIRES IN <1M");
  });
});
