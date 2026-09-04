import { describe, expect, it } from "vitest";
import {
  getHistoryPrefetchThresholdPx,
  isNativeKeyboardViewportOpen,
} from "../useChatComposerLayoutState";

describe("getHistoryPrefetchThresholdPx", () => {
  it("requests the next page half a viewport before the top", () => {
    expect(getHistoryPrefetchThresholdPx(800)).toBe(400);
    expect(getHistoryPrefetchThresholdPx(1200)).toBe(600);
  });

  it("never drops below the 48px floor on short containers", () => {
    expect(getHistoryPrefetchThresholdPx(96)).toBe(48);
    expect(getHistoryPrefetchThresholdPx(40)).toBe(48);
  });

  it("falls back to the floor when the container has no measurable height", () => {
    expect(getHistoryPrefetchThresholdPx(0)).toBe(48);
    expect(getHistoryPrefetchThresholdPx(Number.NaN)).toBe(48);
  });
});

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
