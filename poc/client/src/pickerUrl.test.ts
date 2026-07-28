import { describe, expect, it, test } from "vitest";
import { activeProjectIdFrom, entranceUrl, pickerUrlFrom, sessionUrlFrom } from "./pickerUrl";

describe("pickerUrlFrom", () => {
  test("drops the session so the app routes to the picker", () => {
    expect(pickerUrlFrom("?session=ana")).toBe("");
  });

  test("keeps a non-default project", () => {
    expect(pickerUrlFrom("?session=ana&project=api")).toBe("project=api");
  });

  // The regression: while `default` was stripped, leaving a session in the
  // default project produced "" — which App.tsx reads as no project at all, so
  // LEAVE dropped you at the hub entrance instead of the project screen.
  test("carries project=default too, so leaving lands on the project screen", () => {
    expect(pickerUrlFrom("?session=ana&project=default")).toBe("project=default");
  });

  test("drops the invite token so an invite link does not pull you straight back in", () => {
    expect(pickerUrlFrom("?session=ana&invite=tok123")).toBe("");
  });

  test("drops a screen param so you land on the picker, not a sub-screen", () => {
    expect(pickerUrlFrom("?session=ana&screen=skills")).toBe("");
  });

  test("tolerates a leading question mark being absent", () => {
    expect(pickerUrlFrom("session=ana&project=api")).toBe("project=api");
  });

  test("tolerates an empty query string", () => {
    expect(pickerUrlFrom("")).toBe("");
  });
});

describe("sessionUrlFrom", () => {
  it("writes project=default explicitly, so JOIN ▸ opens the session", () => {
    // Omitting it here is what made every session in `default` unreachable:
    // the resulting URL named no project and routed back to the entrance.
    // Asserted on the URL text, not on activeProjectIdFrom — the legacy
    // fallback there would paper over an omission and hide the regression.
    expect(new URLSearchParams(sessionUrlFrom("", "ana", "default")).get("project")).toBe(
      "default",
    );
    expect(activeProjectIdFrom(sessionUrlFrom("", "ana", "default"))).toBe("default");
  });

  it("writes a non-default project too", () => {
    expect(new URLSearchParams(sessionUrlFrom("", "ana", "api")).get("project")).toBe("api");
  });

  it("overwrites a stale project and session rather than appending", () => {
    const url = sessionUrlFrom("?session=old&project=api", "ana", "default");
    expect(new URLSearchParams(url).getAll("project")).toEqual(["default"]);
    expect(new URLSearchParams(url).getAll("session")).toEqual(["ana"]);
  });
});

describe("activeProjectIdFrom", () => {
  it("resolves a legacy ?session= link with no project to `default`", () => {
    // Every bookmark and shared link predating the entrance looks like this.
    // Resolving it to null routed it to the entrance — the link was dead.
    expect(activeProjectIdFrom("?session=ana")).toBe("default");
  });

  it("returns null for a URL naming neither — the only request for the entrance", () => {
    expect(activeProjectIdFrom("")).toBe(null);
    expect(activeProjectIdFrom("?screen=skills")).toBe(null);
  });

  it("returns null for a bare ?session= with an empty value", () => {
    // An empty session id is not evidence of somewhere to be.
    expect(activeProjectIdFrom("?session=")).toBe(null);
  });

  it("prefers an explicit project over the fallback", () => {
    expect(activeProjectIdFrom("?session=ana&project=api")).toBe("api");
    expect(activeProjectIdFrom("?project=api")).toBe("api");
  });

  it("round-trips a default-project session URL back to the same project", () => {
    // JOIN ▸ in `default` builds ?session=ana&project=default; leaving strips
    // the session; both ends must still name `default`, or the trip lands on
    // the entrance at one end or the other.
    const joined = "?session=ana&project=default";
    expect(activeProjectIdFrom(joined)).toBe("default");
    const left = pickerUrlFrom(joined);
    expect(activeProjectIdFrom(left)).toBe("default");
  });
});

describe("entranceUrl", () => {
  it("drops every parameter — the entrance is the hub root", () => {
    expect(entranceUrl()).toBe("");
  });
});
