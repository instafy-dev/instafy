export type ImageSize = { width: number; height: number };
export type ImagePoint = { x: number; y: number };
export type ImageViewportMode = "overview" | "width" | "manual";
export type ImageViewportTransform = ImagePoint & { scale: number; mode: ImageViewportMode; hasPanned: boolean };

export function validImageSize(size: ImageSize): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function imageScaleBounds(image: ImageSize, viewport: ImageSize) {
  if (!validImageSize(image) || !validImageSize(viewport)) return { min: 1, max: 4, width: 1 };
  const min = Math.min(1, viewport.width / image.width, viewport.height / image.height);
  // Source-pixel zoom remains reachable even for very tall images. Tiny source
  // images stop at 32x; this is local display scaling, never an image allocation.
  const max = Math.max(4, min * 8, Math.min(32, viewport.width / image.width));
  return { min, max, width: clamp(viewport.width / image.width, min, max) };
}

export function boundImageTransform(transform: ImageViewportTransform, image: ImageSize, viewport: ImageSize): ImageViewportTransform {
  if (!validImageSize(image) || !validImageSize(viewport)) return { ...transform, scale: 1, x: 0, y: 0 };
  const bounds = imageScaleBounds(image, viewport);
  const scale = clamp(Number.isFinite(transform.scale) ? transform.scale : bounds.min, bounds.min, bounds.max);
  const axis = (position: number, source: number, available: number) => source * scale <= available
    ? (available - source * scale) / 2
    : clamp(Number.isFinite(position) ? position : 0, available - source * scale, 0);
  return { ...transform, scale, x: axis(transform.x, image.width, viewport.width), y: axis(transform.y, image.height, viewport.height) };
}

export function fitImageTransform(mode: "overview" | "width", image: ImageSize, viewport: ImageSize): ImageViewportTransform {
  const bounds = imageScaleBounds(image, viewport);
  const scale = mode === "overview" ? bounds.min : bounds.width;
  return boundImageTransform({ mode, scale, x: (viewport.width - image.width * scale) / 2,
    y: mode === "width" ? 0 : (viewport.height - image.height * scale) / 2, hasPanned: false }, image, viewport);
}

export function zoomImageAt(transform: ImageViewportTransform, scale: number, point: ImagePoint, image: ImageSize, viewport: ImageSize): ImageViewportTransform {
  const bounds = imageScaleBounds(image, viewport);
  const nextScale = clamp(Number.isFinite(scale) ? scale : transform.scale, bounds.min, bounds.max);
  if (nextScale <= bounds.min * (1 + 1e-6)) return fitImageTransform("overview", image, viewport);
  const ratio = nextScale / transform.scale;
  return boundImageTransform({ ...transform, mode: "manual", scale: nextScale,
    x: point.x - (point.x - transform.x) * ratio, y: point.y - (point.y - transform.y) * ratio, hasPanned: true }, image, viewport);
}

export function panImageBy(transform: ImageViewportTransform, delta: ImagePoint, image: ImageSize, viewport: ImageSize): ImageViewportTransform {
  const result = boundImageTransform({ ...transform, x: transform.x + delta.x, y: transform.y + delta.y }, image, viewport);
  return { ...result, hasPanned: transform.hasPanned || result.x !== transform.x || result.y !== transform.y };
}

export function resizeImageTransform(transform: ImageViewportTransform, image: ImageSize, previous: ImageSize, next: ImageSize): ImageViewportTransform {
  if (transform.mode === "overview" || !validImageSize(previous)) return fitImageTransform("overview", image, next);
  if (transform.mode === "width" && !transform.hasPanned) return fitImageTransform("width", image, next);
  const center = { x: (previous.width / 2 - transform.x) / transform.scale, y: (previous.height / 2 - transform.y) / transform.scale };
  const scale = transform.mode === "width" ? imageScaleBounds(image, next).width : transform.scale;
  return boundImageTransform({ ...transform, scale, x: next.width / 2 - center.x * scale, y: next.height / 2 - center.y * scale }, image, next);
}

export function imageContainsPoint(point: ImagePoint, transform: ImageViewportTransform, image: ImageSize): boolean {
  return validImageSize(image) && point.x >= transform.x && point.y >= transform.y
    && point.x <= transform.x + image.width * transform.scale && point.y <= transform.y + image.height * transform.scale;
}

/** Scale and the moving midpoint are one operation; clamp their final result once. */
export function pinchImageTransform(transform: ImageViewportTransform, scale: number, from: ImagePoint, to: ImagePoint, image: ImageSize, viewport: ImageSize): ImageViewportTransform {
  const bounds = imageScaleBounds(image, viewport);
  const nextScale = clamp(scale, bounds.min, bounds.max);
  if (nextScale <= bounds.min * (1 + 1e-6)) return fitImageTransform("overview", image, viewport);
  return boundImageTransform({ ...transform, mode: "manual", hasPanned: true, scale: nextScale,
    x: to.x - (from.x - transform.x) / transform.scale * nextScale,
    y: to.y - (from.y - transform.y) / transform.scale * nextScale }, image, viewport);
}
