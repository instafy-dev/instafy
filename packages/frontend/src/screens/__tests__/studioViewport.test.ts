import { describe, expect, it } from "vitest";
import {
  buildStudioViewportStyle,
  resolveStudioViewportHeightPx,
  shouldHideContextWhileTyping,
  shouldResetStudioDocumentScroll,
} from "../studioViewport";

describe("studioViewport", () => {
  it("makes room for the composer on a landscape phone with its software keyboard open", () => {
    expect(shouldHideContextWhileTyping({ isTouchConversation: true, keyboardOpen: true, viewportHeightPx: 143 })).toBe(true);
  });

  it.each([
    { isTouchConversation: true, keyboardOpen: false, viewportHeightPx: 143 },
    { isTouchConversation: true, keyboardOpen: true, viewportHeightPx: 413 },
    { isTouchConversation: false, keyboardOpen: true, viewportHeightPx: 143 },
    { isTouchConversation: true, keyboardOpen: true, viewportHeightPx: null },
    { isTouchConversation: true, keyboardOpen: true, viewportHeightPx: Number.NaN },
  ])("retains context outside the cramped touch-conversation case: %j", (state) => {
    expect(shouldHideContextWhileTyping(state)).toBe(false);
  });

  it("rounds valid viewport heights", () => {
    expect(resolveStudioViewportHeightPx(449.1428527832031)).toBe(449);
  });

  it("ignores missing or invalid viewport heights", () => {
    expect(resolveStudioViewportHeightPx(null)).toBeNull();
    expect(resolveStudioViewportHeightPx(undefined)).toBeNull();
    expect(resolveStudioViewportHeightPx(0)).toBeNull();
    expect(resolveStudioViewportHeightPx(Number.NaN)).toBeNull();
  });

  it("keeps both height constraints on the visual viewport variable", () => {
    expect(buildStudioViewportStyle(449)).toEqual({
      height: "var(--studio-vh, 100dvh)",
      minHeight: "var(--studio-vh, 100dvh)",
      "--studio-vh": "449px",
    });
  });

  it("detects WebKit document panning while allowing subpixel noise", () => {
    expect(shouldResetStudioDocumentScroll(0, 376)).toBe(true);
    expect(shouldResetStudioDocumentScroll(12, 0)).toBe(true);
    expect(shouldResetStudioDocumentScroll(0.25, -0.5)).toBe(false);
    expect(shouldResetStudioDocumentScroll(Number.NaN, Number.NaN)).toBe(false);
  });

  it("falls back cleanly when no viewport height is available", () => {
    expect(buildStudioViewportStyle(null)).toEqual({
      height: "var(--studio-vh, 100dvh)",
      minHeight: "var(--studio-vh, 100dvh)",
    });
  });
});
