import { describe, expect, test } from "vitest";
import { normalizeRemote, localRepoKey, repoKeyFor } from "../src/repoKey.js";

describe("normalizeRemote", () => {
  test("collapses the three forms of the same GitHub repo to one key", () => {
    expect(normalizeRemote("git@github.com:acme/api.git")).toBe("github.com/acme/api");
    expect(normalizeRemote("https://github.com/acme/api")).toBe("github.com/acme/api");
    expect(normalizeRemote("https://github.com/acme/api.git")).toBe("github.com/acme/api");
  });

  test("strips embedded credentials so a token never reaches the key", () => {
    expect(normalizeRemote("https://user:ghp_secret@github.com/acme/api.git")).toBe(
      "github.com/acme/api",
    );
  });

  test("lowercases the host but preserves path case", () => {
    // GitHub paths are case-insensitive in practice but not canonicalised by
    // git; lowercasing them would merge genuinely distinct repos on
    // case-sensitive hosts.
    expect(normalizeRemote("https://GitHub.COM/Acme/API.git")).toBe("github.com/Acme/API");
  });

  test("strips ports, ssh:// scheme, and trailing slashes", () => {
    expect(normalizeRemote("ssh://git@git.example.com:2222/acme/api.git")).toBe(
      "git.example.com/acme/api",
    );
    expect(normalizeRemote("https://github.com/acme/api/")).toBe("github.com/acme/api");
  });

  test("returns null for things that are not remote URLs", () => {
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("   ")).toBeNull();
    expect(normalizeRemote("file:///Users/me/code/api")).toBeNull();
    expect(normalizeRemote("/Users/me/code/api")).toBeNull();
    expect(normalizeRemote("https://github.com")).toBeNull();
  });
});

describe("localRepoKey", () => {
  test("is stable for one path and different for another", () => {
    const a = localRepoKey("laptop", "/Users/me/code/api");
    expect(a).toBe(localRepoKey("laptop", "/Users/me/code/api"));
    expect(a).not.toBe(localRepoKey("laptop", "/Users/me/code/web"));
  });

  test("differs across machines so two laptops never falsely match", () => {
    expect(localRepoKey("laptop-a", "/src/api")).not.toBe(localRepoKey("laptop-b", "/src/api"));
  });

  test("is prefixed local: so the wire never confuses it with a real remote", () => {
    expect(localRepoKey("laptop", "/src/api").startsWith("local:")).toBe(true);
  });

  test("does not leak the absolute path", () => {
    expect(localRepoKey("laptop", "/Users/secret-name/code/api")).not.toContain("secret-name");
  });
});

describe("repoKeyFor", () => {
  const ctx = { hostname: "laptop", repoRoot: "/src/api" };

  test("prefers the normalized remote when there is one", () => {
    expect(repoKeyFor("git@github.com:acme/api.git", ctx)).toBe("github.com/acme/api");
  });

  test("falls back to a machine-local key when there is no remote", () => {
    expect(repoKeyFor(null, ctx)).toBe(localRepoKey("laptop", "/src/api"));
  });

  test("falls back when the remote is unrecognisable rather than guessing", () => {
    expect(repoKeyFor("not-a-url", ctx)).toBe(localRepoKey("laptop", "/src/api"));
  });
});
