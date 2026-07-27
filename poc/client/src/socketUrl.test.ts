import { describe, it, expect } from "vitest";
import { socketUrlFor } from "./socketUrl";

describe("socketUrlFor", () => {
  it("uses wss: for an https: page", () => {
    expect(socketUrlFor("https:", "mpai.example.com")).toBe("wss://mpai.example.com");
  });

  it("uses ws: for an http: page", () => {
    expect(socketUrlFor("http:", "localhost:3001")).toBe("ws://localhost:3001");
  });

  it("preserves an explicit port", () => {
    expect(socketUrlFor("https:", "mpai.example.com:8443")).toBe("wss://mpai.example.com:8443");
  });

  // Anything that is not https: is treated as insecure. Hardcoding wss: would
  // break the plain-HTTP single-port path the demo recipes and mpai CLI use.
  it("falls back to ws: for an unexpected protocol", () => {
    expect(socketUrlFor("file:", "localhost:3001")).toBe("ws://localhost:3001");
  });
});
