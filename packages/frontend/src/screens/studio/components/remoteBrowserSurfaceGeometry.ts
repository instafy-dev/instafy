export type RemoteBrowserSurface = HTMLCanvasElement | HTMLVideoElement | HTMLImageElement;

export type RemoteBrowserContentRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

type RectBounds = Pick<DOMRect, "left" | "top" | "width" | "height">;
type ContentSize = { width: number; height: number };

const REMOTE_CONTENT_WIDTH_ATTRIBUTE = "data-remote-content-width";
const REMOTE_CONTENT_HEIGHT_ATTRIBUTE = "data-remote-content-height";

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function contentSizeFromAttributes(surface: RemoteBrowserSurface): ContentSize | null {
  const width = Number(surface.getAttribute(REMOTE_CONTENT_WIDTH_ATTRIBUTE));
  const height = Number(surface.getAttribute(REMOTE_CONTENT_HEIGHT_ATTRIBUTE));
  return positiveFinite(width) && positiveFinite(height) ? { width, height } : null;
}

function intrinsicContentSize(surface: RemoteBrowserSurface): ContentSize | null {
  const width =
    surface instanceof HTMLCanvasElement ? surface.width : surface instanceof HTMLImageElement ? surface.naturalWidth : surface.videoWidth;
  const height =
    surface instanceof HTMLCanvasElement ? surface.height : surface instanceof HTMLImageElement ? surface.naturalHeight : surface.videoHeight;
  return positiveFinite(width) && positiveFinite(height) ? { width, height } : null;
}

/**
 * Record the authoritative remote page dimensions on a rendered surface.
 * Canvas and video intrinsic dimensions normally carry the same aspect ratio,
 * but the explicit value is available before the next decoded frame and avoids
 * transient cursor/input jumps while the controlling viewport is resized.
 */
export function setRemoteBrowserSurfaceContentSize(
  surface: RemoteBrowserSurface,
  width: number,
  height: number,
): void {
  if (!positiveFinite(width) || !positiveFinite(height)) {
    surface.removeAttribute(REMOTE_CONTENT_WIDTH_ATTRIBUTE);
    surface.removeAttribute(REMOTE_CONTENT_HEIGHT_ATTRIBUTE);
    return;
  }
  surface.setAttribute(REMOTE_CONTENT_WIDTH_ATTRIBUTE, String(width));
  surface.setAttribute(REMOTE_CONTENT_HEIGHT_ATTRIBUTE, String(height));
}

/** Fit a remote viewport inside a local surface using CSS `object-fit: contain` geometry. */
export function fitRemoteBrowserContentRect(
  bounds: RectBounds,
  content: ContentSize,
): RemoteBrowserContentRect | null {
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !positiveFinite(bounds.width) ||
    !positiveFinite(bounds.height) ||
    !positiveFinite(content.width) ||
    !positiveFinite(content.height)
  ) {
    return null;
  }

  const scale = Math.min(bounds.width / content.width, bounds.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/**
 * Return the actual painted page rect, excluding neutral `object-fit` gutters.
 * Recorded decoded-frame dimensions win over intrinsic media dimensions so a
 * canvas resize and its observer-visible geometry change remain atomic.
 */
export function remoteBrowserContentRect(
  surface: RemoteBrowserSurface,
): RemoteBrowserContentRect | null {
  const bounds = surface.getBoundingClientRect();
  const authoritativeContent = contentSizeFromAttributes(surface);
  const usesContainFit =
    authoritativeContent !== null ||
    surface.classList.contains("object-contain") ||
    surface.style.objectFit === "contain";
  if (!usesContainFit) {
    return fitRemoteBrowserContentRect(bounds, {
      width: bounds.width,
      height: bounds.height,
    });
  }
  const content = authoritativeContent ?? intrinsicContentSize(surface);
  return content ? fitRemoteBrowserContentRect(bounds, content) : null;
}

/**
 * Map a client point to normalized remote-page coordinates. Gutters and invalid
 * media geometry return null, so callers cannot clamp an off-page event onto a
 * live edge pixel.
 */
export function normalizedRemoteBrowserPoint(
  surface: RemoteBrowserSurface,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return null;
  }
  const rect = remoteBrowserContentRect(surface);
  if (
    !rect ||
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }
  return {
    x: Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1),
    y: Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1),
  };
}
