import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type SyntheticEvent } from "react";
import { fitImageTransform, imageContainsPoint, imageScaleBounds, panImageBy, pinchImageTransform, resizeImageTransform, validImageSize, zoomImageAt,
  type ImagePoint, type ImageSize, type ImageViewportTransform } from "./chatImageViewportMath";

type Model = { image: ImageSize; viewport: ImageSize; transform: ImageViewportTransform };
type Contact = ImagePoint & { type: string };
type Drag = { id: number; start: ImagePoint; previous: ImagePoint; blank: boolean; moved: boolean; swipe: boolean; locked: boolean };
type Pinch = { distance: number; point: ImagePoint; transform: ImageViewportTransform };
const emptySize = { width: 0, height: 0 };
const initialModel = (): Model => ({ image: emptySize, viewport: emptySize, transform: { x: 0, y: 0, scale: 1, mode: "overview", hasPanned: false } });
const distance = (a: ImagePoint, b: ImagePoint) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: ImagePoint, b: ImagePoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const pageIsZoomed = () => typeof window !== "undefined" && (window.visualViewport?.scale ?? 1) > 1.01;
const TOUCH_DOUBLE_TAP_MS = 300;
const POINTER_SINGLE_TAP_MS = 500;

/** Local image coordinates never modify the browser page or the attachment. */
export function useChatImageViewport({ immersive, onDismiss, onImageTap }: {
  immersive: boolean;
  onDismiss: () => void;
  /** A deliberate single image tap, after excluding double-tap zoom and gestures. */
  onImageTap?: () => void;
}) {
  const [canvas, viewportRef] = useState<HTMLDivElement | null>(null);
  const [model, setModel] = useState(initialModel);
  const current = useRef(model);
  const options = useRef({ immersive, onDismiss, onImageTap });
  options.current = { immersive, onDismiss, onImageTap };
  const contacts = useRef(new Map<number, Contact>());
  const blockedPointers = useRef(new Set<number>());
  const drag = useRef<Drag | null>(null);
  const pinch = useRef<Pinch | null>(null);
  const suppressClick = useRef(false);
  const pointerClickExpected = useRef(false);
  const multiTouch = useRef(false);
  const lastTap = useRef<{ point: ImagePoint; time: number } | null>(null);
  const pendingTap = useRef<number | null>(null);
  const lastPointerType = useRef<string | null>(null);
  const [isInteracting, setInteracting] = useState(false);
  const [dismissOffset, setDismissOffset] = useState(0);
  const [pageZoomed, setPageZoomed] = useState(pageIsZoomed);

  const publish = useCallback((next: Model) => { current.current = next; setModel(next); }, []);
  const readyNow = () => validImageSize(current.current.image) && validImageSize(current.current.viewport);
  const localPoint = (clientX: number, clientY: number): ImagePoint => {
    const rect = canvas?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const clearPendingTap = useCallback(() => {
    if (pendingTap.current !== null) window.clearTimeout(pendingTap.current);
    pendingTap.current = null;
  }, []);
  const cancelTapSequence = useCallback(() => {
    clearPendingTap();
    lastTap.current = null;
  }, [clearPendingTap]);
  const queueImageTap = (delay: number) => {
    clearPendingTap();
    if (!options.current.onImageTap) return;
    pendingTap.current = window.setTimeout(() => {
      pendingTap.current = null;
      lastTap.current = null;
      pointerClickExpected.current = false;
      if (!pageIsZoomed() && contacts.current.size === 0 && blockedPointers.current.size === 0) options.current.onImageTap?.();
    }, delay);
  };
  const cancelInteraction = useCallback(() => {
    cancelTapSequence();
    pointerClickExpected.current = false;
    for (const id of contacts.current.keys()) blockedPointers.current.add(id);
    contacts.current.clear();
    drag.current = null;
    pinch.current = null;
    multiTouch.current = true;
    suppressClick.current = true;
    setInteracting(false);
    setDismissOffset(0);
  }, [cancelTapSequence]);

  useLayoutEffect(() => {
    const finishCancelledPointer = (event: globalThis.PointerEvent) => blockedPointers.current.delete(event.pointerId);
    window.addEventListener("pointerup", finishCancelledPointer);
    window.addEventListener("pointercancel", finishCancelledPointer);
    window.addEventListener("keydown", cancelTapSequence);
    return () => {
      cancelTapSequence();
      window.removeEventListener("pointerup", finishCancelledPointer);
      window.removeEventListener("pointercancel", finishCancelledPointer);
      window.removeEventListener("keydown", cancelTapSequence);
    };
  }, [cancelTapSequence]);

  useLayoutEffect(() => {
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const next = { width: rect.width, height: rect.height };
      const before = current.current;
      setPageZoomed(pageIsZoomed());
      if (!validImageSize(next) || (next.width === before.viewport.width && next.height === before.viewport.height)) return;
      cancelInteraction();
      publish({ ...before, viewport: next, transform: validImageSize(before.image)
        ? resizeImageTransform(before.transform, before.image, before.viewport, next) : before.transform });
    };
    const cancelAndMeasure = () => { cancelInteraction(); measure(); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", cancelAndMeasure);
    window.visualViewport?.addEventListener("resize", cancelAndMeasure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", cancelAndMeasure);
      window.visualViewport?.removeEventListener("resize", cancelAndMeasure);
    };
  }, [canvas, cancelInteraction, publish]);

  // React's wheel listener is passive. Cancel browser zoom only on this local
  // image canvas, leaving browser accessibility zoom elsewhere untouched.
  useLayoutEffect(() => {
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      cancelTapSequence();
      const value = current.current;
      if (!validImageSize(value.image) || !validImageSize(value.viewport) || pageIsZoomed()) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? value.viewport.height : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const factor = Math.exp(-Math.max(-500, Math.min(500, dy)) * 0.005);
        publish({ ...value, transform: zoomImageAt(value.transform, value.transform.scale * factor,
          { x: event.clientX - rect.left, y: event.clientY - rect.top }, value.image, value.viewport) });
      } else if (value.transform.mode !== "overview") {
        event.preventDefault();
        publish({ ...value, transform: panImageBy(value.transform, { x: -dx, y: -dy }, value.image, value.viewport) });
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [canvas, cancelTapSequence, publish]);

  const fit = (mode: "overview" | "width") => {
    if (!readyNow()) return;
    cancelInteraction();
    const value = current.current;
    publish({ ...value, transform: fitImageTransform(mode, value.image, value.viewport) });
  };
  const zoom = (scale: number, point?: ImagePoint) => {
    cancelTapSequence();
    if (!readyNow()) return;
    const value = current.current;
    publish({ ...value, transform: zoomImageAt(value.transform, scale,
      point ?? { x: value.viewport.width / 2, y: value.viewport.height / 2 }, value.image, value.viewport) });
  };
  const toggleZoom = (point: ImagePoint) => {
    if (!readyNow()) return;
    const value = current.current;
    if (value.transform.mode !== "overview" || options.current.immersive) {
      // The tap sequence has finished. Keep its pending compatibility click
      // marked as pointer input rather than treating it as assistive activation.
      publish({ ...value, transform: fitImageTransform(value.transform.mode !== "overview" ? "overview" : "width", value.image, value.viewport) });
    } else {
      zoom(Math.max(1, imageScaleBounds(value.image, value.viewport).min * 2), point);
    }
  };
  const beginPinch = () => {
    cancelTapSequence();
    const [a, b] = [...contacts.current.values()];
    if (!a || !b) return;
    pinch.current = { distance: Math.max(1, distance(a, b)), point: midpoint(a, b), transform: current.current.transform };
    drag.current = null;
    multiTouch.current = true;
    suppressClick.current = true;
    setDismissOffset(0);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    lastPointerType.current = event.pointerType;
    // A second press may become a double tap, drag or pinch. Do not reveal
    // controls while that decision is still in progress.
    clearPendingTap();
    pointerClickExpected.current = true;
    if (event.pointerType !== "touch") lastTap.current = null;
    if (!readyNow() || pageIsZoomed() || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (blockedPointers.current.size > 0) {
      blockedPointers.current.add(event.pointerId);
      suppressClick.current = true;
      return;
    }
    const firstContact = contacts.current.size === 0;
    if (firstContact) {
      suppressClick.current = false;
      multiTouch.current = false;
    }
    const point = localPoint(event.clientX, event.clientY);
    const blank = !imageContainsPoint(point, current.current.transform, current.current.image);
    // Safari/WebViews may retain focus on a toolbar control after an image
    // press. Move it to the inspection region without scrolling or a keyboard.
    if (firstContact && !blank) event.currentTarget.focus({ preventScroll: true });
    contacts.current.set(event.pointerId, { ...point, type: event.pointerType });
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* A cancelled native pointer may already be gone. */ }
    setInteracting(true);
    if (contacts.current.size > 1) { beginPinch(); return; }
    drag.current = { id: event.pointerId, start: point, previous: point,
      blank,
      moved: false, swipe: options.current.immersive && current.current.transform.mode === "overview" && event.pointerType === "touch", locked: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!contacts.current.has(event.pointerId)) return;
    if (pageIsZoomed()) { cancelInteraction(); return; }
    const point = localPoint(event.clientX, event.clientY);
    contacts.current.set(event.pointerId, { ...point, type: event.pointerType });
    const value = current.current;
    if (contacts.current.size >= 2 && pinch.current) {
      const [a, b] = [...contacts.current.values()];
      const start = pinch.current;
      const center = midpoint(a, b);
      publish({ ...value, transform: pinchImageTransform(start.transform, start.transform.scale * distance(a, b) / start.distance,
        start.point, center, value.image, value.viewport) });
      return;
    }
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const delta = { x: point.x - start.start.x, y: point.y - start.start.y };
    if (distance(point, start.start) >= 8) { start.moved = true; suppressClick.current = true; cancelTapSequence(); }
    if (value.transform.mode !== "overview") {
      publish({ ...value, transform: panImageBy(value.transform, { x: point.x - start.previous.x, y: point.y - start.previous.y }, value.image, value.viewport) });
    } else if (start.swipe && !multiTouch.current && start.moved) {
      if (!start.locked) {
        if (delta.y <= 0 || delta.y <= Math.abs(delta.x) * 1.25) start.swipe = false;
        else start.locked = true;
      }
      if (start.swipe && start.locked) setDismissOffset(Math.max(0, delta.y));
    }
    start.previous = point;
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!contacts.current.has(event.pointerId)) return;
    const point = localPoint(event.clientX, event.clientY);
    const start = drag.current;
    contacts.current.delete(event.pointerId);
    if (contacts.current.size >= 2) { beginPinch(); return; }
    if (contacts.current.size === 1) {
      const [id, remaining] = [...contacts.current.entries()][0];
      pinch.current = null;
      drag.current = { id, start: remaining, previous: remaining, blank: false, moved: true, swipe: false, locked: false };
      return;
    }
    drag.current = null;
    pinch.current = null;
    setInteracting(false);
    setDismissOffset(0);
    if (!start || multiTouch.current || pageIsZoomed()) { suppressClick.current = true; pointerClickExpected.current = false; cancelTapSequence(); return; }
    const dx = point.x - start.start.x;
    const dy = point.y - start.start.y;
    const moved = start.moved || distance(point, start.start) >= 8;
    if (moved) pointerClickExpected.current = false;
    if (moved || start.blank) cancelTapSequence();
    // Capture retargets the compatibility click to the canvas. Its origin,
    // rather than that click target, decides whether this was a blank tap.
    suppressClick.current ||= moved || !start.blank;
    if (options.current.immersive && current.current.transform.mode === "overview" && start.swipe && start.locked && dy >= 80 && dy > Math.abs(dx) * 1.25) {
      options.current.onDismiss();
    } else if (!moved && !start.blank && event.pointerType === "touch") {
      const previous = lastTap.current;
      const time = Date.now();
      if (previous && time - previous.time <= TOUCH_DOUBLE_TAP_MS && distance(previous.point, point) <= 24) {
        suppressClick.current = true;
        cancelTapSequence();
        toggleZoom(point);
      } else {
        lastTap.current = { point, time };
        queueImageTap(TOUCH_DOUBLE_TAP_MS);
      }
    } else if (!moved && !start.blank) {
      lastTap.current = null;
      queueImageTap(POINTER_SINGLE_TAP_MS);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || !readyNow() || pageIsZoomed()) return;
    const key = event.key;
    if (!["+", "=", "-", "0", "1", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
    event.preventDefault();
    if (key === "0") fit("overview");
    else if (key === "1") zoom(1);
    else if (key === "+" || key === "=") zoom(current.current.transform.scale * 1.5);
    else if (key === "-") zoom(current.current.transform.scale / 1.5);
    else {
      const value = current.current;
      const amount = event.shiftKey ? 160 : 48;
      publish({ ...value, transform: panImageBy(value.transform, { x: key === "ArrowLeft" ? amount : key === "ArrowRight" ? -amount : 0,
        y: key === "ArrowUp" ? amount : key === "ArrowDown" ? -amount : 0 }, value.image, value.viewport) });
    }
  };

  const bounds = imageScaleBounds(model.image, model.viewport);
  const ready = validImageSize(model.image) && validImageSize(model.viewport);
  const imageStyle: CSSProperties = {
    position: "absolute", left: 0, top: 0, width: model.image.width || undefined, height: model.image.height || undefined,
    maxWidth: "none", maxHeight: "none", transformOrigin: "0 0",
    transform: `translate(${model.transform.x}px, ${model.transform.y + dismissOffset}px) scale(${model.transform.scale})`,
    opacity: dismissOffset > 0 ? Math.max(0.45, 1 - dismissOffset / 500) : 1,
    visibility: ready ? "visible" : "hidden",
  };
  return {
    viewportRef,
    onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => {
      const image = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
      if (!validImageSize(image)) return;
      cancelInteraction();
      const value = current.current;
      publish({ ...value, image, transform: fitImageTransform("overview", image, value.viewport) });
    },
    handlers: {
      onPointerDown, onPointerMove, onPointerUp,
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => { cancelInteraction(); blockedPointers.current.delete(event.pointerId); },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => { if (contacts.current.has(event.pointerId)) cancelInteraction(); },
      onClick: (event: MouseEvent<HTMLDivElement>) => {
        const pointerClick = pointerClickExpected.current;
        pointerClickExpected.current = false;
        // Assistive activation may deliver only a zero-detail image click,
        // without a pointer sequence. Pointer compatibility clicks are handled
        // by pointer-up instead, including when capture retargets them.
        if (!pointerClick && event.detail === 0 && event.target instanceof HTMLImageElement && readyNow()
          && !pageIsZoomed() && contacts.current.size === 0 && blockedPointers.current.size === 0) {
          cancelTapSequence();
          options.current.onImageTap?.();
          return;
        }
        if (event.target === event.currentTarget && options.current.immersive && current.current.transform.mode === "overview"
          && !imageContainsPoint(localPoint(event.clientX, event.clientY), current.current.transform, current.current.image)
          && !pageIsZoomed() && !suppressClick.current && contacts.current.size === 0 && blockedPointers.current.size === 0) options.current.onDismiss();
      },
      onDoubleClick: (event: MouseEvent<HTMLDivElement>) => {
        // Touch double-tap belongs to pointer-up. Browsers may send a later
        // compatibility dblclick with a longer threshold; leave pending
        // single taps intact rather than zooming or cancelling them twice.
        if (lastPointerType.current === "touch") return;
        cancelTapSequence();
        if (pageIsZoomed()) return;
        event.preventDefault();
        toggleZoom(localPoint(event.clientX, event.clientY));
      },
      onKeyDown,
    },
    ready, imageStyle, mode: model.transform.mode, scale: model.transform.scale, zoomPercent: Math.round(model.transform.scale * 100),
    isOverview: model.transform.mode === "overview", isInteracting, dismissOffset, pageZoomed,
    canZoomIn: ready && model.transform.scale < bounds.max * (1 - 1e-6),
    canZoomOut: ready && model.transform.scale > bounds.min * (1 + 1e-6),
    fitOverview: () => fit("overview"), fitWidth: () => fit("width"), actualSize: () => zoom(1),
    zoomIn: () => zoom(current.current.transform.scale * 1.5), zoomOut: () => zoom(current.current.transform.scale / 1.5),
  };
}
