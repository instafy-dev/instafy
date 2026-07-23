import { describe, expect, it } from "vitest";
import {
  buildStudioViewportStyle,
  resolveStudioViewportHeightPx,
  shouldResetStudioDocumentScroll,
} from "../studioViewport";

describe("studioViewport", () => {
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
