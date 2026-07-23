const MIN_INLINE_DOCKED_BROWSER_VIEWPORT_HEIGHT = 620;
const COMPACT_BROWSER_CHROME_MAX_WIDTH = 720;

export function shouldUseCompactBrowserChrome({
  containerWidth,
  compactViewport,
}: {
  containerWidth: number | null;
  compactViewport: boolean;
}): boolean {
  // Browser chrome often lives in a split panel while the application viewport
  // remains wide. Prefer the measured panel width so the address field keeps
  // useful space in that layout, and use the viewport posture only until the
  // panel has been measured.
  return containerWidth === null
    ? compactViewport
    : containerWidth <= COMPACT_BROWSER_CHROME_MAX_WIDTH;
}

export function shouldForceDockedBrowserFullscreen({
  fillContainer,
  isOpen,
  presentation,
  smallViewport,
  viewportHeight,
}: {
  fillContainer: boolean;
  isOpen: boolean;
  presentation: "modal" | "docked";
  smallViewport: boolean;
  viewportHeight: number;
}): boolean {
  if (presentation !== "docked" || !isOpen || fillContainer) {
    return false;
  }
  return smallViewport || viewportHeight < MIN_INLINE_DOCKED_BROWSER_VIEWPORT_HEIGHT;
}

export function shouldRenderBrowserSessionFullscreen({
  forceViewportFullscreen,
  fullscreen,
  transportActive,
}: {
  forceViewportFullscreen: boolean;
  fullscreen: boolean;
  transportActive: boolean;
}): boolean {
  return transportActive && (fullscreen || forceViewportFullscreen);
}

export function shouldShowBrowserSessionPageStrip({
  browserHidden,
  browserOpen,
  hasPages,
  pendingNewBrowser,
  smallViewport,
}: {
  browserHidden: boolean;
  browserOpen: boolean;
  hasPages: boolean;
  pendingNewBrowser: boolean;
  smallViewport: boolean;
}): boolean {
  if (!browserHidden && !browserOpen) {
    return false;
  }

  if (browserOpen && smallViewport && !pendingNewBrowser) {
    return false;
  }

  return hasPages || pendingNewBrowser || browserHidden;
}

export function shouldShowBrowserSessionPageStripInComposer({
  browserModeActive,
  pendingNewBrowser,
  showPageStrip,
}: {
  browserModeActive: boolean;
  pendingNewBrowser: boolean;
  showPageStrip: boolean;
}): boolean {
  return showPageStrip && (!browserModeActive || pendingNewBrowser);
}

export function getVisualViewportBottomInset({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
}: {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop?: number;
}): number {
  return Math.max(0, Math.ceil(layoutViewportHeight - (visualViewportHeight + (visualViewportOffsetTop ?? 0))));
}

export function getChatScrollObstructionPaddingPx({
  scrollContainerBottom,
  composerOverlayTop,
  visualViewportHeight,
  visualViewportOffsetTop,
}: {
  scrollContainerBottom: number;
  composerOverlayTop: number;
  visualViewportHeight: number | null;
  visualViewportOffsetTop: number | null;
}): number {
  // Bottom padding for the chat scroller is measured to the NEAREST
  // obstruction below it: the composer overlay, or the visible viewport
  // bottom when the software keyboard shrinks only the visual viewport
  // (mobile Safari; Android Chrome in resizes-visual mode). The Studio root
  // is separately shrunk to the visual viewport height, so summing a
  // keyboard inset on top of the composer overlap would count the keyboard
  // twice on exactly those browsers; taking the minimum keeps the two
  // compensations from stacking while still covering surfaces whose layout
  // does not shrink with the keyboard.
  const visibleBottom =
    visualViewportHeight !== null && Number.isFinite(visualViewportHeight)
      ? visualViewportHeight + (visualViewportOffsetTop ?? 0)
      : Number.POSITIVE_INFINITY;
  const obstructionTop = Math.min(composerOverlayTop, visibleBottom);
  return Math.max(0, Math.ceil(scrollContainerBottom - obstructionTop));
}

export function shouldPinChatMessagesToBottom(options: {
  hasMoreHistory: boolean;
  smallViewport: boolean;
}): boolean {
  // Chat currently always pins to the bottom; the signature keeps the inputs
  // the decision needs if unpinned states come back.
  void options;
  return true;
}
