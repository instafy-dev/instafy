import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { UNSTABLE_ToastQueue } from "react-aria-components";
import type { StatusToast } from "./StatusProvider";
import { subscribeToastClearance, toastArea, toastClearanceBottom } from "./toastClearance";

/** Track only while feedback is visible, including passive confirmations. */
export function useToastPlacement(queue: UNSTABLE_ToastQueue<StatusToast>, confirmationVisible = false): CSSProperties {
  const subscribe = useCallback((onChange: () => void) => queue.subscribe(onChange), [queue]);
  const queued = useSyncExternalStore(subscribe, () => queue.visibleToasts.length > 0, () => false);
  const showing = queued || confirmationVisible;
  const [position, setPosition] = useState({
    clearance: 0, viewportTop: 0, viewportBottom: 0, aboveWindowBottom: false, areaLeft: null as number | null, areaWidth: 0,
  });
  useLayoutEffect(() => {
    if (!showing) return;
    const measure = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const area = toastArea();
      const next = {
        clearance: toastClearanceBottom(),
        viewportTop,
        viewportBottom,
        aboveWindowBottom: viewportBottom < window.innerHeight - 1,
        areaLeft: area?.left ?? null,
        areaWidth: area?.width ?? 0,
      };
      setPosition(previous => previous.clearance === next.clearance && previous.viewportTop === next.viewportTop
        && previous.viewportBottom === next.viewportBottom && previous.aboveWindowBottom === next.aboveWindowBottom
        && previous.areaLeft === next.areaLeft && previous.areaWidth === next.areaWidth ? previous : next);
    };
    measure();
    const unsubscribe = subscribeToastClearance(measure);
    const viewport = window.visualViewport;
    window.addEventListener("resize", measure);
    // Scrolling an ancestor can move a registered bar without resizing it.
    window.addEventListener("scroll", measure, true);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      unsubscribe();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [showing]);
  const belowHeader = `calc(3.75rem + var(--instafy-safe-area-inset-top, 0px) + ${position.viewportTop}px)`;
  const preferredTop = position.clearance > 0 ? `max(${belowHeader}, ${position.clearance + 8}px)` : belowHeader;
  const bottom = position.viewportBottom > 0 ? `${position.viewportBottom}px` : "100dvh";
  // A keyboard (or a panned/zoomed viewport) can put the visible bottom above
  // the device edge. Its safe-area inset is already outside that visible area.
  const bottomGap = position.aboveWindowBottom ? "0.5rem" : "max(0.5rem, var(--instafy-safe-area-inset-bottom, 0px))";
  const bottomEdge = `calc(${bottom} - ${bottomGap})`;
  // In landscape with the keyboard open, chrome can consume the entire visual
  // viewport. Prefer staying below it, but reserve room for a readable, scrollable
  // notice instead of collapsing the region to zero height behind the keyboard.
  // Five rem of readable content, plus the region's focus/shadow padding.
  const top = `max(calc(${position.viewportTop}px + max(0.5rem, var(--instafy-safe-area-inset-top, 0px))), min(${preferredTop}, calc(${bottomEdge} - 5.5rem)))`;
  return {
    top,
    maxHeight: `max(0px, calc(${bottomEdge} - ${top}))`,
    // Over Studio's workspace, never over the navigation beside it.
    ...(position.areaLeft !== null ? { left: `${position.areaLeft}px`, right: "auto", width: `${position.areaWidth}px` } : {}),
  };
}
