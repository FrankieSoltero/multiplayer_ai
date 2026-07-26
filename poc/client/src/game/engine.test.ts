import { describe, it, expect } from "vitest";
import { settleRun } from "./engine";

describe("settleRun", () => {
  it("submits exactly once when a finished run beats the local best", () => {
    const first = settleRun({ submitted: false, localBest: 10 }, true, 20);
    expect(first.submit).toBe(true);
    expect(first.ledger).toEqual({ submitted: true, localBest: 20 });
    const again = settleRun(first.ledger, true, 20);
    expect(again.submit).toBe(false);
  });

  it("never submits an unfinished run or a non-improving score", () => {
    expect(settleRun({ submitted: false, localBest: 10 }, false, 99).submit).toBe(false);
    const worse = settleRun({ submitted: false, localBest: 10 }, true, 5);
    expect(worse.submit).toBe(false);
    expect(worse.ledger).toEqual({ submitted: true, localBest: 10 });
  });
});
