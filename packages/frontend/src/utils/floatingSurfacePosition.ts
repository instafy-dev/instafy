export type SafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type FloatingSurfacePositionInput = {
  clientX: number;
  clientY: number;
  surfaceWidth: number;
  surfaceHeight: number;
  padding: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportOffsetLeft?: number;
  viewportOffsetTop?: number;
  safeAreaInsets?: Partial<SafeAreaInsets>;
};

export type FloatingSurfacePlacement = {
  x: number;
  y: number;
  maxHeight: number;
};

const ZERO_SAFE_AREA_INSETS: SafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

const SAFE_AREA_PROPERTY_BY_SIDE = {
  top: "--instafy-safe-area-inset-top",
  right: "--instafy-safe-area-inset-right",
  bottom: "--instafy-safe-area-inset-bottom",
  left: "--instafy-safe-area-inset-left",
} as const;

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function parseCssPixelLength(value: string): number | null {
  const match = value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))px$/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

export function resolveFloatingSurfacePosition({
  clientX,
  clientY,
  surfaceWidth,
  surfaceHeight,
  padding,
  viewportWidth,
  viewportHeight,
  viewportOffsetLeft = 0,
  viewportOffsetTop = 0,
  safeAreaInsets = ZERO_SAFE_AREA_INSETS,
}: FloatingSurfacePositionInput): FloatingSurfacePlacement {
  const offsetLeft = Number.isFinite(viewportOffsetLeft) ? viewportOffsetLeft : 0;
  const offsetTop = Number.isFinite(viewportOffsetTop) ? viewportOffsetTop : 0;
  const insetTop = finiteNonNegative(safeAreaInsets.top);
  const insetRight = finiteNonNegative(safeAreaInsets.right);
  const insetBottom = finiteNonNegative(safeAreaInsets.bottom);
  const insetLeft = finiteNonNegative(safeAreaInsets.left);
  const resolvedPadding = finiteNonNegative(padding);
  const resolvedWidth = finiteNonNegative(surfaceWidth);
  const resolvedHeight = finiteNonNegative(surfaceHeight);
  const usableLeft = offsetLeft + insetLeft;
  const usableTop = offsetTop + insetTop;
  const usableRight = offsetLeft + finiteNonNegative(viewportWidth) - insetRight;
  const usableBottom = offsetTop + finiteNonNegative(viewportHeight) - insetBottom;
  const minX = usableLeft + resolvedPadding;
  const minY = usableTop + resolvedPadding;
  const maxX = Math.max(minX, usableRight - resolvedWidth - resolvedPadding);
  const maxY = Math.max(minY, usableBottom - resolvedHeight - resolvedPadding);

  const x = Math.min(Math.max(clientX, minX), maxX);
  const y = Math.min(Math.max(clientY, minY), maxY);
  return {
    x,
    y,
    maxHeight: Math.max(0, usableBottom - y - resolvedPadding),
  };
}

export function readStudioSafeAreaInsets(documentRef: Document = document): SafeAreaInsets {
  const view = documentRef.defaultView;
  const root = documentRef.documentElement;
  if (!view || !root) {
    return { ...ZERO_SAFE_AREA_INSETS };
  }

  const rootStyle = view.getComputedStyle(root);
  const direct = Object.fromEntries(
    Object.entries(SAFE_AREA_PROPERTY_BY_SIDE).map(([side, property]) => [
      side,
      parseCssPixelLength(rootStyle.getPropertyValue(property)),
    ]),
  ) as Record<keyof SafeAreaInsets, number | null>;

  if (Object.values(direct).every((value) => value !== null)) {
    return direct as SafeAreaInsets;
  }

  const probe = documentRef.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    boxSizing: "border-box",
    height: "0",
    left: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    visibility: "hidden",
    width: "0",
    paddingTop: `var(${SAFE_AREA_PROPERTY_BY_SIDE.top}, 0px)`,
    paddingRight: `var(${SAFE_AREA_PROPERTY_BY_SIDE.right}, 0px)`,
    paddingBottom: `var(${SAFE_AREA_PROPERTY_BY_SIDE.bottom}, 0px)`,
    paddingLeft: `var(${SAFE_AREA_PROPERTY_BY_SIDE.left}, 0px)`,
  });
  (documentRef.body ?? root).appendChild(probe);
  const probeStyle = view.getComputedStyle(probe);
  const measured: SafeAreaInsets = {
    top: direct.top ?? parseCssPixelLength(probeStyle.paddingTop) ?? 0,
    right: direct.right ?? parseCssPixelLength(probeStyle.paddingRight) ?? 0,
    bottom: direct.bottom ?? parseCssPixelLength(probeStyle.paddingBottom) ?? 0,
    left: direct.left ?? parseCssPixelLength(probeStyle.paddingLeft) ?? 0,
  };
  probe.remove();
  return measured;
}

export function clampFloatingSurfacePositionToStudioViewport({
  clientX,
  clientY,
  surfaceWidth,
  surfaceHeight,
  padding,
}: Pick<
  FloatingSurfacePositionInput,
  "clientX" | "clientY" | "surfaceWidth" | "surfaceHeight" | "padding"
>): FloatingSurfacePlacement {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { x: clientX, y: clientY, maxHeight: surfaceHeight };
  }

  const visualViewport = window.visualViewport;
  return resolveFloatingSurfacePosition({
    clientX,
    clientY,
    surfaceWidth,
    surfaceHeight,
    padding,
    viewportWidth: visualViewport?.width ?? window.innerWidth,
    viewportHeight: visualViewport?.height ?? window.innerHeight,
    viewportOffsetLeft: visualViewport?.offsetLeft ?? 0,
    viewportOffsetTop: visualViewport?.offsetTop ?? 0,
    safeAreaInsets: readStudioSafeAreaInsets(document),
  });
}

export function addFloatingSurfaceViewportChangeListener(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const visualViewport = window.visualViewport;
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  window.addEventListener("scroll", onChange, { passive: true });
  visualViewport?.addEventListener("resize", onChange);
  visualViewport?.addEventListener("scroll", onChange);

  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
    window.removeEventListener("scroll", onChange);
    visualViewport?.removeEventListener("resize", onChange);
    visualViewport?.removeEventListener("scroll", onChange);
  };
}
