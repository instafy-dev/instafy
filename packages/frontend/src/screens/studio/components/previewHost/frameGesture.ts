import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * How long after focus moved into the frame an ask still counts as that click, in a browser without
 * `navigator.userActivation` (the same few seconds browsers give a click's activation).
 */
export const FRAME_GESTURE_MS = 5_000;

type ActivationNavigator = { userActivation?: { isActive: boolean } };

/**
 * The person just used this frame: it has the focus (a click or a key press inside a frame moves focus to it), and
 * the browser saw a click or key press in the last few seconds. A click inside a cross-origin frame activates the
 * pages that embed it too, so Studio can tell, without reading the page, that a real person just clicked in it; a
 * page's script posting on its own, or a click that landed in Studio itself, does not count.
 */
export function frameHasUserGesture({ frame, doc, nav, focusEnteredAt, now }: {
  frame: HTMLIFrameElement | null;
  doc: Document;
  nav: ActivationNavigator;
  /** When focus last moved into the frame (for browsers without `userActivation`), or null. */
  focusEnteredAt: number | null;
  now: number;
}): boolean {
  if (!frame || doc.activeElement !== frame) return false;
  if (nav.userActivation) return nav.userActivation.isActive;
  return focusEnteredAt !== null && now - focusEnteredAt < FRAME_GESTURE_MS;
}

/** {@link frameHasUserGesture} for one pane's frame, as a stable function. */
export function useFrameGesture(frame: RefObject<HTMLIFrameElement | null>): () => boolean {
  const focusEnteredAt = useRef<number | null>(null);
  useEffect(() => {
    // Focus moving into a frame blurs this window; the frame is the active element right after.
    const onBlur = () => {
      window.setTimeout(() => {
        if (frame.current && document.activeElement === frame.current) focusEnteredAt.current = Date.now();
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [frame]);
  return useCallback(() => frameHasUserGesture({
    frame: frame.current,
    doc: document,
    nav: navigator as ActivationNavigator,
    focusEnteredAt: focusEnteredAt.current,
    now: Date.now(),
  }), [frame]);
}
