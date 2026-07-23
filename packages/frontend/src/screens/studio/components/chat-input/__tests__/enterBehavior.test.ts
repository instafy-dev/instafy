import { describe, expect, it } from "vitest";
import { shouldSendMessageOnEnter } from "../enterBehavior";

describe("shouldSendMessageOnEnter", () => {
  it("returns true for single-line input", () => {
    expect(shouldSendMessageOnEnter("hello")).toBe(true);
    expect(shouldSendMessageOnEnter("/terminal pwd")).toBe(true);
  });

  it("returns true for a trailing newline artifact", () => {
    expect(shouldSendMessageOnEnter("/terminal pwd\n")).toBe(true);
    expect(shouldSendMessageOnEnter("/terminal pwd\r\n")).toBe(true);
    expect(shouldSendMessageOnEnter("/terminal pwd\n   ")).toBe(true);
    expect(shouldSendMessageOnEnter("/terminal pwd\n\t")).toBe(true);
    expect(shouldSendMessageOnEnter("\n/terminal pwd")).toBe(true);
    expect(shouldSendMessageOnEnter("\n\n/terminal pwd\n")).toBe(true);
  });

  it("returns false for multi-line input", () => {
    expect(shouldSendMessageOnEnter("line one\nline two")).toBe(false);
    expect(shouldSendMessageOnEnter("line one\r\nline two")).toBe(false);
  });
});
