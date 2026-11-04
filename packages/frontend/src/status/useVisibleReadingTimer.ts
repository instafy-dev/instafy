import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";

/**
 * Count visible reading time, independently of callback/rerender frequency.
 * Changing resetKey starts a new message; hiding its DOM preserves its budget.
 * Real action deadlines must use an absolute clock instead of this hook.
 */
export function useVisibleReadingTimer(duration: number | undefined, onDismiss: () => void, paused = false, resetKey?: unknown) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const remainingRef = useRef(duration);
  const keyRef = useRef(resetKey);
  const firedRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [obscured, setObscured] = useState(false);
  const [outsideViewport, setOutsideViewport] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    setFocused(Boolean(node?.contains(document.activeElement)));
    setHovered(Boolean(window.matchMedia?.("(hover: hover)").matches && node?.matches(":hover")));
    if (!node) {
      setObscured(false);
      return;
    }
    // Listen at the DOM boundary as well: component primitives may filter React
    // capture props before forwarding them to their rendered element.
    const focusIn = () => setFocused(true);
    const focusOut = (event: FocusEvent) => {
      if (!node.contains(event.relatedTarget as Node | null)) setFocused(false);
    };
    const pointerIn = (event: PointerEvent) => { if (event.pointerType !== "touch") setHovered(true); };
    const pointerOut = () => setHovered(false);
    node.addEventListener("focusin", focusIn);
    node.addEventListener("focusout", focusOut);
    node.addEventListener("pointerenter", pointerIn);
    node.addEventListener("pointerleave", pointerOut);
    // Wait for the first measurement. A clipped notice receives its remaining
    // reading time after it is exposed; a taller-than-pane notice stays put.
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "function") {
      setObscured(true);
      observer = new IntersectionObserver(([entry]) => {
        if (entry) setObscured(!entry.isIntersecting || entry.intersectionRatio < 1);
      }, { threshold: [1] });
      observer.observe(node);
    } else setObscured(false);
    return () => {
      node.removeEventListener("focusin", focusIn);
      node.removeEventListener("focusout", focusOut);
      node.removeEventListener("pointerenter", pointerIn);
      node.removeEventListener("pointerleave", pointerOut);
      observer?.disconnect();
    };
  }, [node]);

  const measureViewport = useCallback(() => {
    const viewport = window.visualViewport;
    if (!node || !viewport) { setOutsideViewport(false); return; }
    // IntersectionObserver clips to layout/scroll ancestors, while a mobile
    // keyboard can shrink the visual viewport without changing those bounds.
    const rect = node.getBoundingClientRect();
    setOutsideViewport(rect.top < viewport.offsetTop || rect.left < viewport.offsetLeft
      || rect.bottom > viewport.offsetTop + viewport.height || rect.right > viewport.offsetLeft + viewport.width);
  }, [node]);
  // A render can move the portal or reposition feedback after keyboard resize
  // without resizing its node. Recheck the resulting bounds after that commit.
  useLayoutEffect(measureViewport);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!node || !viewport) return;
    viewport.addEventListener("resize", measureViewport);
    viewport.addEventListener("scroll", measureViewport);
    window.addEventListener("resize", measureViewport);
    window.addEventListener("scroll", measureViewport, true);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(measureViewport) : undefined;
    resize?.observe(node);
    return () => {
      viewport.removeEventListener("resize", measureViewport);
      viewport.removeEventListener("scroll", measureViewport);
      window.removeEventListener("resize", measureViewport);
      window.removeEventListener("scroll", measureViewport, true);
      resize?.disconnect();
    };
  }, [node, measureViewport]);

  useEffect(() => {
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      remainingRef.current = duration;
      firedRef.current = false;
    }
    // A replacement can inherit focus before its focus handler mounts. Read
    // the DOM as well as event state so it cannot restart under that focus.
    if (!node || paused || hovered || focused || node.contains(document.activeElement)
      || obscured || outsideViewport || hidden || firedRef.current || remainingRef.current === undefined) return;
    const started = Date.now();
    const timer = window.setTimeout(() => {
      remainingRef.current = 0;
      firedRef.current = true;
      dismissRef.current();
    }, Math.max(0, remainingRef.current));
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, (remainingRef.current ?? 0) - (Date.now() - started));
    };
  }, [duration, resetKey, node, paused, hovered, focused, obscured, outsideViewport, hidden]);

  const interactionProps: Pick<HTMLAttributes<HTMLDivElement>, "onPointerEnter" | "onPointerLeave" | "onFocusCapture" | "onBlurCapture"> = {
    onPointerEnter: event => { if (event.pointerType !== "touch") setHovered(true); },
    onPointerLeave: () => setHovered(false),
    onFocusCapture: () => setFocused(true),
    onBlurCapture: event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    },
  };
  const hasFocus = useCallback(() => Boolean(node?.contains(document.activeElement)), [node]);
  return { ref: setNode, interactionProps, hasFocus };
}
