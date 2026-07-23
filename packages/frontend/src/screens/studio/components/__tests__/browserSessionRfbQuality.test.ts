import { describe, expect, it, vi } from "vitest";
import {
  applyAdaptiveBrowserRfbEncoding,
  applyDenseDisplayRfbQuality,
  installBrowserRfbScaledResize,
  resolveBrowserRfbFramebufferSize,
  selectBrowserRfbRenderScale,
} from "../browserSessionRfbQuality";

describe("applyDenseDisplayRfbQuality", () => {
  it("uses noVNC's highest encoding quality for a dense viewport-only viewer", () => {
    const rfb: { qualityLevel?: number } = {};
    applyDenseDisplayRfbQuality(rfb, { devicePixelRatio: 2, viewportOnly: true });
    expect(rfb.qualityLevel).toBe(9);
  });

  it("leaves legacy and ordinary-density viewers at noVNC defaults", () => {
    const legacy: { qualityLevel?: number } = {};
    const ordinary: { qualityLevel?: number } = {};
    applyDenseDisplayRfbQuality(legacy, { devicePixelRatio: 2, viewportOnly: false });
    applyDenseDisplayRfbQuality(ordinary, { devicePixelRatio: 1, viewportOnly: true });
    expect(legacy.qualityLevel).toBeUndefined();
    expect(ordinary.qualityLevel).toBeUndefined();
  });
});

describe("HiDPI RFB geometry", () => {
  it("selects 2x only for dense displays that fit the framebuffer budget", () => {
    expect(
      selectBrowserRfbRenderScale({
        devicePixelRatio: 2,
        viewportWidth: 1920,
        viewportHeight: 1080,
      }),
    ).toBe(2);
    expect(
      selectBrowserRfbRenderScale({
        devicePixelRatio: 2,
        viewportWidth: 2560,
        viewportHeight: 1440,
      }),
    ).toBe(1);
    expect(
      selectBrowserRfbRenderScale({
        devicePixelRatio: 1,
        viewportWidth: 1280,
        viewportHeight: 720,
      }),
    ).toBe(1);
  });

  it("preserves aspect ratio while capping framebuffer pixels", () => {
    expect(
      resolveBrowserRfbFramebufferSize({
        logicalWidth: 1280,
        logicalHeight: 720,
        renderScale: 2,
        maxFramebufferPixels: 8_294_400,
      }),
    ).toEqual({ width: 2560, height: 1440, pixels: 3_686_400, capped: false });

    const capped = resolveBrowserRfbFramebufferSize({
      logicalWidth: 2560,
      logicalHeight: 1440,
      renderScale: 2,
      maxFramebufferPixels: 8_294_400,
    });
    expect(capped.capped).toBe(true);
    expect(capped.pixels).toBeLessThanOrEqual(8_294_400);
    expect(capped.width / capped.height).toBeCloseTo(16 / 9, 2);
  });

  it("multiplies noVNC remote resize requests without changing local screen geometry", () => {
    const setDesktopSize = vi.fn();
    const rfb = {
      _requestRemoteResize: undefined as (() => void) | undefined,
      _resizeSession: true,
      _resizeTimeout: null,
      _screenSize: () => ({ w: 800, h: 600 }),
      _screenFlags: 4,
      _screenID: 3,
      _sock: {},
      _supportsSetDesktopSize: true,
      _viewOnly: false,
      constructor: { messages: { setDesktopSize } },
    };
    expect(
      installBrowserRfbScaledResize(rfb, {
        renderScale: 2,
        maxFramebufferPixels: 8_294_400,
      }),
    ).toBe(true);

    rfb._requestRemoteResize?.();
    expect(setDesktopSize).toHaveBeenCalledWith(rfb._sock, 1600, 1200, 3, 4);
  });

  it("ignores noVNC resize requests while the mounted Shared viewer is hidden", () => {
    const setDesktopSize = vi.fn();
    const rfb = {
      _requestRemoteResize: undefined as (() => void) | undefined,
      _resizeSession: true,
      _resizeTimeout: null,
      _screenSize: () => ({ w: 0, h: 0 }),
      _screenFlags: 0,
      _screenID: 0,
      _sock: {},
      _supportsSetDesktopSize: true,
      _viewOnly: false,
      constructor: { messages: { setDesktopSize } },
    };
    expect(
      installBrowserRfbScaledResize(rfb, {
        renderScale: 2,
        maxFramebufferPixels: 8_294_400,
      }),
    ).toBe(true);

    rfb._requestRemoteResize?.();
    expect(setDesktopSize).not.toHaveBeenCalled();
  });

  it("trades encoding quality for compression as framebuffer load rises", () => {
    const lowLoad: { qualityLevel?: number; compressionLevel?: number } = {};
    const highLoad: { qualityLevel?: number; compressionLevel?: number } = {};
    applyAdaptiveBrowserRfbEncoding(lowLoad, {
      framebufferPixels: 1_000_000,
      maxFramebufferPixels: 8_294_400,
      renderScale: 2,
      viewportOnly: true,
    });
    applyAdaptiveBrowserRfbEncoding(highLoad, {
      framebufferPixels: 8_000_000,
      maxFramebufferPixels: 8_294_400,
      renderScale: 2,
      viewportOnly: true,
    });
    expect(lowLoad).toEqual({ qualityLevel: 9, compressionLevel: 2 });
    expect(highLoad).toEqual({ qualityLevel: 7, compressionLevel: 4 });
  });
});
