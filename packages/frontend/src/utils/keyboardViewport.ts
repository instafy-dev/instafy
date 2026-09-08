const KEYBOARD_MIN_OCCLUSION_PX = 96;

/** Geometry evidence, not focus alone: handles both layout-resizing Android and visual-only iOS. */
export function isNativeKeyboardViewportOpen({
  closedViewportHeight,
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
}: {
  closedViewportHeight: number;
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop: number;
}): boolean {
  const baselineHeight = Math.max(closedViewportHeight, layoutViewportHeight);
  if (!Number.isFinite(baselineHeight) || baselineHeight <= 0) return false;
  const visibleBottom = Math.max(0, visualViewportHeight) + Math.max(0, visualViewportOffsetTop);
  const occludedHeight = Math.max(0, baselineHeight - visibleBottom);
  return occludedHeight >= Math.max(KEYBOARD_MIN_OCCLUSION_PX, baselineHeight * 0.18);
}
