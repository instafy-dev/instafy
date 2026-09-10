import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";

const NEAR_BOTTOM_PX = 120;
const REACHED_LATEST_PX = 2;
const INTENT_LIFETIME_MS = 750;

interface NewerHistoryPagingOptions {
  visitKey: string | null;
  routeKey: string;
  enabled: boolean;
  hasNewer: boolean;
  loading: boolean;
  error: string | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  isReadingReady: () => boolean;
  loadNewer: () => void | Promise<unknown>;
  onReachLatest?: () => void;
}

function isEditing(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}

/** Paging and returning to live history require fresh downward input; target
 * reveal, restoration and layout scroll events alone never authorize either. */
export function useChatNewerHistoryPaging(options: NewerHistoryPagingOptions) {
  const { visitKey, routeKey, enabled, hasNewer, loading, error, scrollContainerRef } = options;
  const canReachLatest = Boolean(options.onReachLatest);
  const generation = useMemo(() => ({ visitKey, routeKey, enabled, hasNewer, loading, error, canReachLatest }), [visitKey, routeKey, enabled, hasNewer, loading, error, canReachLatest]);
  const latest = useRef({ options, generation });
  latest.current = { options, generation };
  const completion = useRef({ visitKey, done: false });

  useLayoutEffect(() => {
    if (completion.current.visitKey !== visitKey) completion.current = { visitKey, done: false };
    const node = scrollContainerRef.current;
    if (!node || !enabled || !visitKey || (!hasNewer && !canReachLatest) || loading || error) return;
    let disposed = false;
    let pending = false;
    let failed = false;
    let armed: { top: number; until: number } | null = null;
    let touch: { id: number; y: number; used: boolean } | null = null;
    let drag: { y: number; used: boolean } | null = null;
    const reset = () => { armed = null; touch = null; drag = null; };
    const visible = () => node.clientHeight > 0 && node.ownerDocument.visibilityState !== "hidden"
      && !node.closest('[hidden], [inert], [aria-hidden="true"]');
    const ready = () => {
      const current = latest.current;
      return !disposed && current.generation === generation && enabled && Boolean(visitKey) && (hasNewer || canReachLatest)
        && !completion.current.done
        && !loading && !error && !pending && !failed && visible()
        && (window.history.state?.key ?? "default") === routeKey && current.options.isReadingReady();
    };
    const requestIfNearBottom = () => {
      if (!armed || armed.until < Date.now() || !ready()) { armed = null; return; }
      if (node.scrollHeight - node.clientHeight - node.scrollTop > (hasNewer ? NEAR_BOTTOM_PX : REACHED_LATEST_PX)) return;
      armed = null;
      if (touch) touch.used = true;
      if (drag) drag.used = true;
      if (!hasNewer) {
        // Loading the final page reset its old gesture. Only fresh input at the
        // committed end can exit, once even if routing is waiting on a drawer.
        completion.current.done = true;
        latest.current.options.onReachLatest?.();
        return;
      }
      pending = true;
      try {
        void Promise.resolve(latest.current.options.loadNewer()).then(
          () => { if (!disposed) pending = false; },
          () => { if (!disposed) { pending = false; failed = true; } },
        );
      } catch {
        pending = false;
        failed = true;
      }
    };
    const arm = () => {
      if (!ready()) { reset(); return; }
      armed = { top: node.scrollTop, until: Date.now() + INTENT_LIFETIME_MS };
      // Underfilled windows cannot emit a scroll event, but downward input still
      // expresses the same request for more history.
      requestIfNearBottom();
    };
    const onScroll = () => {
      if (!visible() || !latest.current.options.isReadingReady()) { reset(); return; }
      if (!armed || armed.until < Date.now()) { armed = null; return; }
      if (node.scrollTop <= armed.top) return;
      armed.top = node.scrollTop;
      armed.until = Date.now() + INTENT_LIFETIME_MS;
      requestIfNearBottom();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || isEditing(event.target)) return;
      if (event.deltaY <= 0 || event.deltaY <= Math.abs(event.deltaX)) { reset(); return; }
      arm();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditing(event.target)
        || event.target instanceof Element && event.target.closest('button, a[href], [role="button"]')) return;
      if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) arm();
      else reset();
    };
    const onTouchStart = (event: TouchEvent) => {
      reset();
      const point = event.touches[0];
      if (!point || event.touches.length !== 1 || isEditing(event.target) || !ready()) return;
      touch = { id: point.identifier, y: point.clientY, used: false };
    };
    const onTouchMove = (event: TouchEvent) => {
      const point = [...event.touches].find(item => item.identifier === touch?.id);
      if (!touch || !point || touch.used || event.defaultPrevented) return;
      const delta = touch.y - point.clientY;
      touch.y = point.clientY;
      if (delta > 4) arm();
      else if (delta < -4) armed = null;
    };
    const onTouchEnd = () => { touch = null; };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch" || event.target !== node || !ready()) return;
      const rect = node.getBoundingClientRect();
      const gutter = Math.max(12, node.offsetWidth - node.clientWidth);
      if (event.clientX < rect.right - gutter || event.clientX > rect.right) return;
      drag = { y: event.clientY, used: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.used || !(event.buttons & 1)) return;
      const delta = event.clientY - drag.y;
      drag.y = event.clientY;
      if (delta > 0) arm();
      else if (delta < 0) armed = null;
    };
    const onPointerEnd = (event: PointerEvent) => {
      // Touch Events own swipes and their remaining inertia. Native scrolling
      // can cancel its parallel pointer stream while the touch is still active.
      if (event.pointerType !== "touch" && drag) reset();
    };
    const onVisibilityChange = () => { if (!visible()) reset(); };
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("touchend", onTouchEnd, { passive: true });
    node.addEventListener("touchcancel", reset, { passive: true });
    node.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("resize", reset);
    window.visualViewport?.addEventListener("resize", reset);
    node.ownerDocument.addEventListener("visibilitychange", reset);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(onVisibilityChange);
    for (let element: Element | null = node; element; element = element.parentElement) {
      observer?.observe(element, { attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "class", "style"] });
    }
    return () => {
      disposed = true;
      reset();
      observer?.disconnect();
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", reset);
      node.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("resize", reset);
      window.visualViewport?.removeEventListener("resize", reset);
      node.ownerDocument.removeEventListener("visibilitychange", reset);
    };
  }, [canReachLatest, enabled, error, generation, hasNewer, loading, routeKey, scrollContainerRef, visitKey]);
}
