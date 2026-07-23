export const DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS = 8_294_400;
export const MAX_BROWSER_RFB_RENDER_SCALE = 2;

type BrowserSessionRfbEncodingTarget = {
  compressionLevel?: number;
  qualityLevel?: number;
};

type BrowserSessionRfbResizeInternals = BrowserSessionRfbEncodingTarget & {
  _requestRemoteResize?: () => void;
  _resizeSession?: boolean;
  _resizeTimeout?: number | null;
  _screenSize?: () => { w: number; h: number };
  _screenFlags?: number;
  _screenID?: number;
  _sock?: unknown;
  _supportsSetDesktopSize?: boolean;
  _viewOnly?: boolean;
};

type BrowserSessionRfbRuntimeConstructor = {
  messages?: {
    setDesktopSize?: (
      socket: unknown,
      width: number,
      height: number,
      screenId: number,
      screenFlags: number,
    ) => void;
  };
};

export type BrowserRfbFramebufferSize = {
  width: number;
  height: number;
  pixels: number;
  capped: boolean;
};

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function selectBrowserRfbRenderScale({
  devicePixelRatio,
  viewportWidth,
  viewportHeight,
  maxFramebufferPixels = DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS,
}: {
  devicePixelRatio: number;
  viewportWidth: number;
  viewportHeight: number;
  maxFramebufferPixels?: number;
}): 1 | 2 {
  const dpr = positiveFinite(devicePixelRatio, 1);
  if (dpr < 1.5) {
    return 1;
  }
  const width = Math.ceil(positiveFinite(viewportWidth, 1280));
  const height = Math.ceil(positiveFinite(viewportHeight, 720));
  const pixelBudget = Math.floor(
    positiveFinite(maxFramebufferPixels, DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS),
  );
  return width * height * MAX_BROWSER_RFB_RENDER_SCALE ** 2 <= pixelBudget ? 2 : 1;
}

export function resolveBrowserRfbFramebufferSize({
  logicalWidth,
  logicalHeight,
  renderScale,
  maxFramebufferPixels,
}: {
  logicalWidth: number;
  logicalHeight: number;
  renderScale: number;
  maxFramebufferPixels: number;
}): BrowserRfbFramebufferSize {
  const width = positiveFinite(logicalWidth, 1);
  const height = positiveFinite(logicalHeight, 1);
  const scale = Math.min(
    MAX_BROWSER_RFB_RENDER_SCALE,
    Math.max(1, positiveFinite(renderScale, 1)),
  );
  const pixelBudget = Math.max(1, Math.floor(positiveFinite(maxFramebufferPixels, 1)));
  const desiredWidth = Math.max(1, Math.round(width * scale));
  const desiredHeight = Math.max(1, Math.round(height * scale));
  const desiredPixels = desiredWidth * desiredHeight;
  if (desiredPixels <= pixelBudget) {
    return {
      width: desiredWidth,
      height: desiredHeight,
      pixels: desiredPixels,
      capped: false,
    };
  }

  const budgetScale = Math.sqrt(pixelBudget / desiredPixels);
  const cappedWidth = Math.max(1, Math.floor(desiredWidth * budgetScale));
  const cappedHeight = Math.max(1, Math.floor(desiredHeight * budgetScale));
  return {
    width: cappedWidth,
    height: cappedHeight,
    pixels: cappedWidth * cappedHeight,
    capped: true,
  };
}

/**
 * noVNC 1.5 requests SetDesktopSize in local CSS pixels. Replace that one
 * internal hook so TigerVNC receives physical pixels while all of noVNC's
 * display/input scaling remains intact. Display.absX/absY then maps local
 * pointer coordinates back through the canvas scale to framebuffer pixels.
 */
export function installBrowserRfbScaledResize(
  rfb: BrowserSessionRfbResizeInternals | null,
  {
    renderScale,
    maxFramebufferPixels,
  }: {
    renderScale: number;
    maxFramebufferPixels: number;
  },
): boolean {
  if (!rfb) {
    return false;
  }
  const runtimeConstructor = (rfb as unknown as { constructor?: BrowserSessionRfbRuntimeConstructor })
    .constructor;
  const setDesktopSize = runtimeConstructor?.messages?.setDesktopSize;
  if (typeof setDesktopSize !== "function" || typeof rfb._screenSize !== "function") {
    return false;
  }

  rfb._requestRemoteResize = () => {
    if (rfb._resizeTimeout !== null && rfb._resizeTimeout !== undefined) {
      window.clearTimeout(rfb._resizeTimeout);
    }
    rfb._resizeTimeout = null;
    if (!rfb._resizeSession || rfb._viewOnly || !rfb._supportsSetDesktopSize) {
      return;
    }
    const logicalSize = rfb._screenSize?.();
    if (!logicalSize || logicalSize.w < 1 || logicalSize.h < 1) {
      return;
    }
    const framebuffer = resolveBrowserRfbFramebufferSize({
      logicalWidth: logicalSize.w,
      logicalHeight: logicalSize.h,
      renderScale,
      maxFramebufferPixels,
    });
    setDesktopSize(
      rfb._sock,
      framebuffer.width,
      framebuffer.height,
      rfb._screenID ?? 0,
      rfb._screenFlags ?? 0,
    );
  };
  return true;
}

export function applyAdaptiveBrowserRfbEncoding(
  rfb: BrowserSessionRfbEncodingTarget | null,
  {
    framebufferPixels,
    maxFramebufferPixels,
    renderScale,
    viewportOnly,
  }: {
    framebufferPixels: number;
    maxFramebufferPixels: number;
    renderScale: number;
    viewportOnly: boolean;
  },
): void {
  if (!rfb || !viewportOnly) {
    return;
  }
  const utilization =
    positiveFinite(framebufferPixels, 1) /
    positiveFinite(maxFramebufferPixels, DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS);
  const dense = renderScale >= 1.5;
  if (utilization >= 0.8) {
    rfb.qualityLevel = dense ? 7 : 6;
    rfb.compressionLevel = 4;
  } else if (utilization >= 0.45) {
    rfb.qualityLevel = dense ? 8 : 7;
    rfb.compressionLevel = 3;
  } else {
    rfb.qualityLevel = dense ? 9 : 8;
    rfb.compressionLevel = 2;
  }
}

// Kept as the narrow compatibility entry point for callers/tests that only
// need encoding quality. New code should use applyAdaptiveBrowserRfbEncoding.
export function applyDenseDisplayRfbQuality(
  rfb: BrowserSessionRfbEncodingTarget | null,
  {
    devicePixelRatio,
    viewportOnly,
  }: {
    devicePixelRatio: number;
    viewportOnly: boolean;
  },
): void {
  if (!rfb || !viewportOnly || devicePixelRatio < 1.5) {
    return;
  }
  rfb.qualityLevel = 9;
}
