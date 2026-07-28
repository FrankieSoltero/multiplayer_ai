import { describe, expect, test } from "vitest";
import { pickerUrlFrom } from "./pickerUrl";

describe("pickerUrlFrom", () => {
  test("drops the session so the app routes to the picker", () => {
    expect(pickerUrlFrom("?session=ana")).toBe("");
  });

  test("keeps a non-default project", () => {
    expect(pickerUrlFrom("?session=ana&project=api")).toBe("project=api");
  });

  test("drops project=default, matching how joinSession omits it", () => {
    expect(pickerUrlFrom("?session=ana&project=default")).toBe("");
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
