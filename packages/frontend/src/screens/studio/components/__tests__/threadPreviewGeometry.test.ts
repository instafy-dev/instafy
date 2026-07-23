import { describe, expect, it } from "vitest";
import { resolveThreadPreviewSafeInsetPx } from "../threadPreviewGeometry";

describe("threadPreviewGeometry", () => {
  it("does not add inset when the row already has enough room for the header overhang", () => {
    expect(resolveThreadPreviewSafeInsetPx({ rootLeftPx: 124, containerLeftPx: 0 })).toBe(0);
  });

  it("adds just enough inset to keep the avatar header inside a narrow pane", () => {
    expect(resolveThreadPreviewSafeInsetPx({ rootLeftPx: 16, containerLeftPx: 0 })).toBe(32);
  });

  it("uses the minimum viewport inset target when the row is flush to the edge", () => {
    expect(resolveThreadPreviewSafeInsetPx({ rootLeftPx: 0, containerLeftPx: 0 })).toBe(48);
  });

  it("keeps the avatar clear of an open left drawer", () => {
    expect(resolveThreadPreviewSafeInsetPx({ rootLeftPx: 432, containerLeftPx: 416 })).toBe(32);
  });
});
