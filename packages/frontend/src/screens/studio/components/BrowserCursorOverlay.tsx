import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RuntimeBrowserSessionAction } from "../../../sdk/instafy";
import { remoteBrowserContentRect } from "./remoteBrowserSurfaceGeometry";

// The AI cursor lingers this long after its last click, then fades — so it
// doesn't sit on a stale spot after the agent scrolls or moves on.
const CURSOR_LINGER_MS = 4000;
// Fallback top-chrome height (tabstrip + omnibox) in framebuffer px, used only
// when an event didn't report the viewport size.
const FALLBACK_TOOLBAR_PX = 80;

type CursorPosition = { left: number; top: number; seq: number };

export function resolveBrowserChromeOffset(params: {
  framebufferHeight: number;
  viewportHeight: number | null;
  renderScale?: number;
}): number {
  if (params.viewportHeight !== null) {
    return Math.max(
      0,
      params.framebufferHeight - params.viewportHeight * (params.renderScale ?? 1),
    );
  }
  return FALLBACK_TOOLBAR_PX * (params.renderScale ?? 1);
}

/**
 * Draws an app-owned AI cursor + click ripple over the remote pixel surface, positioned
 * from the agent's reported click coordinates. Maps browser-viewport CSS px to
 * on-screen px through the canvas's framebuffer size and rendered scale, and
 * shifts down by the browser's top chrome (framebuffer height − viewport height)
 * so the pointer lands on the actual click target.
 */
export function BrowserCursorOverlay({
  containerRef,
  latestClick,
  renderScale = 1,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  latestClick: RuntimeBrowserSessionAction | null;
  renderScale?: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CursorPosition | null>(null);
  const [active, setActive] = useState(false);

  const recompute = useCallback(() => {
    const root = rootRef.current;
    const surface =
      containerRef.current?.querySelector<HTMLCanvasElement | HTMLVideoElement>(
        "canvas, video",
      ) ?? null;
    if (
      !root ||
      !surface ||
      !latestClick ||
      latestClick.x === null ||
      latestClick.y === null
    ) {
      return;
    }
    const framebufferWidth =
      surface instanceof HTMLCanvasElement ? surface.width : surface.videoWidth;
    const framebufferHeight =
      surface instanceof HTMLCanvasElement ? surface.height : surface.videoHeight;
    const surfaceRect = remoteBrowserContentRect(surface);
    if (
      !framebufferWidth ||
      !framebufferHeight ||
      !surfaceRect
    ) {
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const scaleX = surfaceRect.width / framebufferWidth;
    const scaleY = surfaceRect.height / framebufferHeight;
    const offsetX = surfaceRect.left - rootRect.left;
    const offsetY = surfaceRect.top - rootRect.top;
    const effectiveRenderScale =
      latestClick.viewportW && latestClick.viewportW > 0
        ? framebufferWidth / latestClick.viewportW
        : renderScale;
    const toolbarPx = resolveBrowserChromeOffset({
      framebufferHeight,
      viewportHeight: latestClick.viewportH,
      renderScale: effectiveRenderScale,
    });
    // Action events are reported in Chromium CSS pixels; the VNC framebuffer
    // uses physical pixels in HiDPI mode.
    const framebufferX = latestClick.x * effectiveRenderScale;
    const framebufferY = toolbarPx + latestClick.y * effectiveRenderScale;
    setPosition({
      left: offsetX + framebufferX * scaleX,
      top: offsetY + framebufferY * scaleY,
      seq: latestClick.seq,
    });
  }, [containerRef, latestClick, renderScale]);

  // Reposition when a new click arrives, and keep the cursor visible briefly.
  useLayoutEffect(() => {
    if (!latestClick || latestClick.x === null || latestClick.y === null) {
      setActive(false);
      return;
    }
    recompute();
    setActive(true);
    const timer = window.setTimeout(() => setActive(false), CURSOR_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [latestClick, recompute]);

  // Keep the cursor mapped as the view changes: the canvas rescales on panel
  // resize, and in native (mobile) mode the container pans/scrolls the 1280x720
  // framebuffer — scrolling moves the canvas rect without resizing it, so a
  // scroll listener is needed in addition to the ResizeObserver.
  useEffect(() => {
    const container = containerRef.current;
    const surface =
      container?.querySelector<HTMLCanvasElement | HTMLVideoElement>("canvas, video") ??
      null;
    if (!container || !surface) {
      return;
    }
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => recompute()) : null;
    observer?.observe(surface);
    const mutationObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => recompute())
        : null;
    mutationObserver?.observe(container, {
      attributes: true,
      attributeFilter: [
        "data-remote-content-width",
        "data-remote-content-height",
        "height",
        "width",
      ],
      childList: true,
      subtree: true,
    });
    container?.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    // Capture scrolls from any ancestor as well (docked layout can scroll).
    window.addEventListener("scroll", recompute, { passive: true, capture: true });
    return () => {
      observer?.disconnect();
      mutationObserver?.disconnect();
      container?.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, { capture: true } as EventListenerOptions);
    };
  }, [containerRef, recompute, latestClick]);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      data-testid="browser-cursor-overlay"
      aria-hidden="true"
    >
      {position && active ? (
        <div
          className="absolute transition-[left,top] duration-300 ease-out"
          data-testid="browser-cursor"
          style={{ left: position.left, top: position.top }}
        >
          {/* ripple replays on each new click via the keyed remount */}
          <span
            key={position.seq}
            className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/40 motion-safe:animate-ping"
            style={{ width: 22, height: 22 }}
          />
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            className="relative -translate-x-[3px] -translate-y-[2px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
          >
            <path
              d="M4 2.5 L4 15.5 L7.7 12.2 L10.1 17.4 L12.3 16.3 L9.9 11.2 L14.6 11.2 Z"
              fill="#ffffff"
              stroke="#0f172a"
              stroke-width="1.1"
              stroke-linejoin="round"
            />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
