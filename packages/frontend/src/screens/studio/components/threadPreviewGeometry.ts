export function resolveThreadPreviewSafeInsetPx(params: {
  rootLeftPx: number;
  containerLeftPx?: number;
  minViewportInsetPx?: number;
  minContainerInsetPx?: number;
  headerOverflowPx?: number;
}): number {
  const rootLeftPx = Number.isFinite(params.rootLeftPx) ? params.rootLeftPx : Number.POSITIVE_INFINITY;
  const containerLeftPx =
    typeof params.containerLeftPx === "number" && Number.isFinite(params.containerLeftPx) ? params.containerLeftPx : 0;
  const minViewportInsetPx =
    typeof params.minViewportInsetPx === "number" && Number.isFinite(params.minViewportInsetPx)
      ? params.minViewportInsetPx
      : 20;
  const minContainerInsetPx =
    typeof params.minContainerInsetPx === "number" && Number.isFinite(params.minContainerInsetPx)
      ? params.minContainerInsetPx
      : 20;
  const headerOverflowPx =
    typeof params.headerOverflowPx === "number" && Number.isFinite(params.headerOverflowPx)
      ? params.headerOverflowPx
      : 28;
  const minimumVisibleLeftPx = Math.max(minViewportInsetPx, containerLeftPx + minContainerInsetPx);

  return Math.max(0, Math.ceil(minimumVisibleLeftPx + headerOverflowPx - rootLeftPx));
}
