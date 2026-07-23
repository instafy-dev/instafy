import { describe, expect, it } from "vitest";
import { isNativeKeyboardViewportOpen } from "../useChatComposerLayoutState";

describe("isNativeKeyboardViewportOpen", () => {
  it("does not mistake a focused editor for an open Android keyboard", () => {
    expect(
      isNativeKeyboardViewportOpen({
        closedViewportHeight: 780,
        layoutViewportHeight: 780,
        visualViewportHeight: 780,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(false);
  });

  it("detects a resized Android viewport while the IME is visible", () => {
    expect(
      isNativeKeyboardViewportOpen({
        closedViewportHeight: 780,
        layoutViewportHeight: 420,
        visualViewportHeight: 420,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(true);
  });

  it("ignores the normal iOS status-bar difference", () => {
    expect(
      isNativeKeyboardViewportOpen({
        closedViewportHeight: 762,
        layoutViewportHeight: 762,
        visualViewportHeight: 762,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(false);
  });

  it("uses the closed app window instead of the full display in split screen", () => {
    expect(
      isNativeKeyboardViewportOpen({
        closedViewportHeight: 500,
        layoutViewportHeight: 500,
        visualViewportHeight: 500,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(false);
  });
});
