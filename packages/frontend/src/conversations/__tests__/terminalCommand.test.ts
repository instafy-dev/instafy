import { describe, expect, it } from "vitest";
import { parseTerminalCommandRequest } from "../terminalCommand";

describe("parseTerminalCommandRequest", () => {
  it("parses /terminal commands", () => {
    expect(parseTerminalCommandRequest("/terminal ls -la")).toEqual({
      prefix: "terminal",
      command: "ls -la",
    });
  });

  it("parses /term commands", () => {
    expect(parseTerminalCommandRequest("/term pnpm dev")).toEqual({
      prefix: "term",
      command: "pnpm dev",
    });
  });

  it("returns null for non-terminal messages", () => {
    expect(parseTerminalCommandRequest("hello")).toBeNull();
  });
});
