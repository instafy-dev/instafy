// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  addFloatingSurfaceViewportChangeListener,
  resolveFloatingSurfacePosition,
} from "../floatingSurfacePosition";

describe("resolveFloatingSurfacePosition", () => {
  it("keeps a landscape menu inside the right safe area", () => {
    const position = resolveFloatingSurfacePosition({
      clientX: 760,
      clientY: 80,
      surfaceWidth: 256,
      surfaceHeight: 200,
      padding: 12,
      viewportWidth: 780,
      viewportHeight: 375,
      safeAreaInsets: { right: 48 },
    });

    expect(position).toEqual({ x: 464, y: 80, maxHeight: 283 });
    expect(position.x + 256).toBeLessThanOrEqual(780 - 48 - 12);
  });

  it("honors left and top safe areas", () => {
    expect(
      resolveFloatingSurfacePosition({
        clientX: 0,
        clientY: 0,
        surfaceWidth: 240,
        surfaceHeight: 200,
        padding: 12,
        viewportWidth: 812,
        viewportHeight: 375,
        safeAreaInsets: { left: 50, top: 8 },
      }),
    ).toEqual({ x: 62, y: 20, maxHeight: 343 });
  });

  it("includes visual viewport offsets in both bounds", () => {
    const position = resolveFloatingSurfacePosition({
      clientX: 900,
      clientY: 700,
      surfaceWidth: 240,
      surfaceHeight: 200,
      padding: 12,
      viewportWidth: 600,
      viewportHeight: 400,
      viewportOffsetLeft: 20,
      viewportOffsetTop: 100,
      safeAreaInsets: { right: 30, bottom: 20 },
    });

    expect(position).toEqual({ x: 338, y: 268, maxHeight: 200 });
  });

  it("pins oversized surfaces to the padded usable origin", () => {
    expect(
      resolveFloatingSurfacePosition({
        clientX: 400,
        clientY: 400,
        surfaceWidth: 500,
        surfaceHeight: 500,
        padding: 12,
        viewportWidth: 320,
        viewportHeight: 300,
        safeAreaInsets: { left: 20, top: 10, right: 20, bottom: 10 },
      }),
    ).toEqual({ x: 32, y: 22, maxHeight: 256 });
  });

  it("can dismiss an open surface when viewport geometry changes", () => {
    const onChange = vi.fn();
    const removeListener = addFloatingSurfaceViewportChangeListener(onChange);

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
    expect(onChange).toHaveBeenCalledTimes(2);

    removeListener();
    window.dispatchEvent(new Event("resize"));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
