import { describe, expect, it } from "vitest";
import {
  getChatScrollObstructionPaddingPx,
  getVisualViewportBottomInset,
  shouldForceDockedBrowserFullscreen,
  shouldPinChatMessagesToBottom,
  shouldRenderBrowserSessionFullscreen,
  shouldShowBrowserSessionPageStrip,
  shouldShowBrowserSessionPageStripInComposer,
  shouldUseCompactBrowserChrome,
} from "../browserSessionLayout";

describe("browserSessionLayout", () => {
  it("compacts browser chrome from its split-panel width", () => {
    expect(
      shouldUseCompactBrowserChrome({
        containerWidth: 620,
        compactViewport: false,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactBrowserChrome({
        containerWidth: 721,
        compactViewport: true,
      }),
    ).toBe(false);
  });

  it("uses viewport posture only until browser panel width is measured", () => {
    expect(
      shouldUseCompactBrowserChrome({
        containerWidth: null,
        compactViewport: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactBrowserChrome({
        containerWidth: null,
        compactViewport: false,
      }),
    ).toBe(false);
  });

  it("keeps fill-container browser surfaces inline on narrow and short viewports", () => {
    expect(
      shouldForceDockedBrowserFullscreen({
        fillContainer: true,
        isOpen: true,
        presentation: "docked",
        smallViewport: true,
        viewportHeight: 390,
      }),
    ).toBe(false);
  });

  it("preserves fullscreen fallback for legacy docked browser cards", () => {
    expect(
      shouldForceDockedBrowserFullscreen({
        fillContainer: false,
        isOpen: true,
        presentation: "docked",
        smallViewport: false,
        viewportHeight: 390,
      }),
    ).toBe(true);
  });

  it("never renders fullscreen for an inactive browser transport", () => {
    expect(
      shouldRenderBrowserSessionFullscreen({
        forceViewportFullscreen: false,
        fullscreen: true,
        transportActive: false,
      }),
    ).toBe(false);
    expect(
      shouldRenderBrowserSessionFullscreen({
        forceViewportFullscreen: true,
        fullscreen: false,
        transportActive: false,
      }),
    ).toBe(false);
  });

  it("still renders requested fullscreen for the active browser transport", () => {
    expect(
      shouldRenderBrowserSessionFullscreen({
        forceViewportFullscreen: false,
        fullscreen: true,
        transportActive: true,
      }),
    ).toBe(true);
  });

  it("keeps the page strip visible for hidden mobile browser sessions", () => {
    expect(
      shouldShowBrowserSessionPageStrip({
        browserHidden: true,
        browserOpen: false,
        hasPages: false,
        pendingNewBrowser: false,
        smallViewport: true,
      }),
    ).toBe(true);
  });

  it("hides the page strip while the mobile browser card is open", () => {
    expect(
      shouldShowBrowserSessionPageStrip({
        browserHidden: false,
        browserOpen: true,
        hasPages: true,
        pendingNewBrowser: false,
        smallViewport: true,
      }),
    ).toBe(false);
  });

  it("keeps pending new-site context visible in an open mobile browser", () => {
    expect(
      shouldShowBrowserSessionPageStrip({
        browserHidden: false,
        browserOpen: true,
        hasPages: false,
        pendingNewBrowser: true,
        smallViewport: true,
      }),
    ).toBe(true);
  });

  it("keeps the page strip visible for open desktop browser sessions with live pages", () => {
    expect(
      shouldShowBrowserSessionPageStrip({
        browserHidden: false,
        browserOpen: true,
        hasPages: true,
        pendingNewBrowser: false,
        smallViewport: false,
      }),
    ).toBe(true);
  });

  it("removes the redundant page strip while the Browser tab is active", () => {
    expect(
      shouldShowBrowserSessionPageStripInComposer({
        browserModeActive: true,
        pendingNewBrowser: false,
        showPageStrip: true,
      }),
    ).toBe(false);
  });

  it("keeps pending-new-page context visible until the browser has a target", () => {
    expect(
      shouldShowBrowserSessionPageStripInComposer({
        browserModeActive: true,
        pendingNewBrowser: true,
        showPageStrip: true,
      }),
    ).toBe(true);
  });

  it("keeps bottom-pinning short chats on mobile when history is fully loaded", () => {
    expect(
      shouldPinChatMessagesToBottom({
        hasMoreHistory: false,
        smallViewport: true,
      }),
    ).toBe(true);
  });

  it("keeps bottom-pinning when older history is still available", () => {
    expect(
      shouldPinChatMessagesToBottom({
        hasMoreHistory: true,
        smallViewport: true,
      }),
    ).toBe(true);
  });

  it("keeps bottom-pinning on larger viewports when history is fully loaded", () => {
    expect(
      shouldPinChatMessagesToBottom({
        hasMoreHistory: false,
        smallViewport: false,
      }),
    ).toBe(true);
  });

  it("derives the keyboard occlusion inset from the visual viewport", () => {
    expect(
      getVisualViewportBottomInset({
        layoutViewportHeight: 844,
        visualViewportHeight: 560,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(284);
  });

  it("does not add an inset when the layout viewport already resized", () => {
    expect(
      getVisualViewportBottomInset({
        layoutViewportHeight: 560,
        visualViewportHeight: 560,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(0);
  });

  describe("getChatScrollObstructionPaddingPx", () => {
    it("pads to the composer overlay when it is the nearest obstruction", () => {
      // Chromium resizes-content: layout shrinks with the keyboard, so the
      // overlay sits above the visible bottom and wins the min().
      expect(
        getChatScrollObstructionPaddingPx({
          scrollContainerBottom: 560,
          composerOverlayTop: 470,
          visualViewportHeight: 560,
          visualViewportOffsetTop: 0,
        }),
      ).toBe(90);
    });

    it("does not stack the keyboard inset on top of a shrunk Studio root", () => {
      // Mobile Safari with the keyboard open: the root is already shrunk to
      // the 560px visual viewport, so the 284px keyboard must not be added
      // again on top of the composer overlap.
      expect(
        getChatScrollObstructionPaddingPx({
          scrollContainerBottom: 560,
          composerOverlayTop: 470,
          visualViewportHeight: 560,
          visualViewportOffsetTop: 0,
        }),
      ).toBe(90);
    });

    it("pads to the visible bottom when layout does not shrink with the keyboard", () => {
      // A surface whose layout still spans the 844px viewport while the
      // keyboard occludes everything below 560px: the visible bottom is the
      // nearest obstruction, covering content behind the keyboard.
      expect(
        getChatScrollObstructionPaddingPx({
          scrollContainerBottom: 844,
          composerOverlayTop: 754,
          visualViewportHeight: 560,
          visualViewportOffsetTop: 0,
        }),
      ).toBe(284);
    });

    it("accounts for a panned visual viewport via offsetTop", () => {
      expect(
        getChatScrollObstructionPaddingPx({
          scrollContainerBottom: 844,
          composerOverlayTop: 754,
          visualViewportHeight: 560,
          visualViewportOffsetTop: 100,
        }),
      ).toBe(184);
    });

    it("falls back to the overlay overlap without a visual viewport", () => {
      expect(
        getChatScrollObstructionPaddingPx({
          scrollContainerBottom: 560,
          composerOverlayTop: 470,
          visualViewportHeight: null,
          visualViewportOffsetTop: null,
        }),
      ).toBe(90);
    });

    it("clamps to zero when nothing extends past the obstruction", () => {
      expect(
        getChatScrollObstructionPaddingPx({
          scrollContainerBottom: 400,
          composerOverlayTop: 470,
          visualViewportHeight: 560,
          visualViewportOffsetTop: 0,
        }),
      ).toBe(0);
    });
  });
});
