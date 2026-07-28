import { describe, expect, test } from "vitest";
import { parseClientCommand, shouldSubmitOverMenu } from "./clientCommands";

describe("parseClientCommand", () => {
  test("recognises /exit", () => {
    expect(parseClientCommand("/exit")).toEqual({ type: "exit" });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseClientCommand("  /exit  ")).toEqual({ type: "exit" });
  });

  test("is case-insensitive, because the prompt bar does not shout", () => {
    expect(parseClientCommand("/EXIT")).toEqual({ type: "exit" });
    expect(parseClientCommand("/Exit")).toEqual({ type: "exit" });
  });

  test("does not match a longer name that merely starts with exit", () => {
    // /exits must reach the skill router, not be swallowed as a client command.
    expect(parseClientCommand("/exits")).toBeNull();
    expect(parseClientCommand("/exit-plan")).toBeNull();
  });

  test("does not match a prefix of it", () => {
    expect(parseClientCommand("/ex")).toBeNull();
  });

  test("requires the leading slash", () => {
    expect(parseClientCommand("exit")).toBeNull();
  });

  test("ignores prose that merely contains the word", () => {
    expect(parseClientCommand("how do I exit this session?")).toBeNull();
    expect(parseClientCommand("please run /exit for me")).toBeNull();
  });

  test("takes no arguments — /exit now is the whole command", () => {
    expect(parseClientCommand("/exit now")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseClientCommand("")).toBeNull();
    expect(parseClientCommand("   ")).toBeNull();
  });
});

describe("shouldSubmitOverMenu", () => {
  test("/exit submits rather than accepting the highlighted skill", () => {
    expect(shouldSubmitOverMenu("/exit")).toBe(true);
  });

  test("/exits and /exit-plan still accept from the menu normally", () => {
    expect(shouldSubmitOverMenu("/exits")).toBe(false);
    expect(shouldSubmitOverMenu("/exit-plan")).toBe(false);
  });

  test("a non-command like /ski still accepts from the menu", () => {
    expect(shouldSubmitOverMenu("/ski")).toBe(false);
  });

  test("agrees with parseClientCommand for whitespace and case", () => {
    expect(shouldSubmitOverMenu("  /EXIT  ")).toBe(true);
  });
});
