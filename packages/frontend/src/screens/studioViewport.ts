import type { CSSProperties } from "react";

const STUDIO_VIEWPORT_HEIGHT_VALUE = "var(--studio-vh, 100dvh)";

export function resolveStudioViewportHeightPx(viewportHeight: number | null | undefined): number | null {
  if (viewportHeight === null || viewportHeight === undefined || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return null;
  }
  return Math.round(viewportHeight);
}

export function shouldResetStudioDocumentScroll(scrollX: number, scrollY: number): boolean {
  return (
    (Number.isFinite(scrollX) && Math.abs(scrollX) > 0.5) ||
    (Number.isFinite(scrollY) && Math.abs(scrollY) > 0.5)
  );
}

export function buildStudioViewportStyle(viewportHeightPx: number | null): CSSProperties {
  // The Studio root also carries viewport-unit fallback utilities. Override both
  // dimensions so `min-height: 100vh` cannot outgrow the visual viewport while
  // a mobile browser's address bar or software keyboard is visible.
  if (viewportHeightPx === null) {
    return {
      height: STUDIO_VIEWPORT_HEIGHT_VALUE,
      minHeight: STUDIO_VIEWPORT_HEIGHT_VALUE,
    };
  }

  return {
    height: STUDIO_VIEWPORT_HEIGHT_VALUE,
    minHeight: STUDIO_VIEWPORT_HEIGHT_VALUE,
    ["--studio-vh" as const]: `${viewportHeightPx}px`,
  } as CSSProperties;
}
