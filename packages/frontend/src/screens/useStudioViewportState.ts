import { useLayoutEffect, useState } from "react";
import { isNativeKeyboardViewportOpen } from "../utils/keyboardViewport";
import { resolveStudioViewportHeightPx, shouldResetStudioDocumentScroll } from "./studioViewport";

function hasFocusedTextEditor(): boolean {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active instanceof HTMLInputElement) {
    return !active.disabled && !active.readOnly &&
      ["text", "search", "email", "url", "tel", "password", "number"].includes(active.type);
  }
  if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
  return active instanceof HTMLElement && active.isContentEditable;
}

/** One Studio viewport subscription; observing a keyboard never focuses, blurs, or remounts an editor. */
export function useStudioViewportState({ trackKeyboard }: { trackKeyboard: boolean }) {
  const [state, setState] = useState<{ viewportHeightPx: number | null; keyboardOpen: boolean }>({
    viewportHeightPx: null, keyboardOpen: false,
  });

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    let frameId: number | null = null;
    let keyboardOpen = false;
    const closedHeights = new Map<string, number>();
    const awaitingRestoration = new Set<string>();
    const viewport = window.visualViewport;

    const applyViewport = () => {
      frameId = null;
      // Preserve Studio's existing WKWebView page-pan correction. The document
      // is overflow-locked; the transcript/drawers own their own scroll positions.
      if (shouldResetStudioDocumentScroll(window.scrollX, window.scrollY)) window.scrollTo(0, 0);
      const viewportHeightPx = resolveStudioViewportHeightPx(viewport?.height ?? window.innerHeight);
      if (!trackKeyboard) keyboardOpen = false;
      else {
        const height = viewport?.height ?? window.innerHeight;
        const offsetTop = Number.isFinite(viewport?.offsetTop) ? Math.max(0, viewport!.offsetTop) : 0;
        const scale = viewport?.scale ?? 1;
        const valid = Number.isFinite(height) && height > 0 && Number.isFinite(window.innerHeight) && window.innerHeight > 0;
        // Pinch zoom can shrink the visible rectangle with no keyboard. Do not
        // change a closed baseline from zoomed geometry or mistake it for IME.
        if (!valid || !Number.isFinite(scale) || Math.abs(scale - 1) > 0.01) keyboardOpen = false;
        else {
          // Never infer orientation from innerHeight: Android IME resize can
          // make a portrait viewport wider than it is tall. Width changes also
          // isolate split-screen/window resizing from a previous keyboard baseline.
          const orientation = window.screen.orientation;
          const key = `${Math.round(window.innerWidth)}:${orientation?.type ?? ""}:${orientation?.angle ?? ""}`;
          const visibleHeight = Math.max(window.innerHeight, height + offsetTop);
          const closedHeight = closedHeights.get(key) ?? visibleHeight;
          const focused = hasFocusedTextEditor();
          const occluded = isNativeKeyboardViewportOpen({
            closedViewportHeight: closedHeight,
            layoutViewportHeight: window.innerHeight,
            visualViewportHeight: height,
            visualViewportOffsetTop: offsetTop,
          });
          // Blur can precede the keyboard's closing animation. Keep the existing
          // state until geometry restores, but never open based on shrink alone.
          keyboardOpen = occluded && (focused || keyboardOpen);
          if (focused) awaitingRestoration.add(key);
          // IME animation arrives in many individually small resize steps.
          // Freeze the pre-focus baseline throughout shrinking/closing; lowering
          // it on each sub-threshold frame would hide the total keyboard change.
          closedHeights.set(key, awaitingRestoration.has(key)
            ? Math.max(closedHeight, visibleHeight) : visibleHeight);
          if (!focused && height + offsetTop >= closedHeight - 1) awaitingRestoration.delete(key);
        }
      }
      setState(previous => previous.viewportHeightPx === viewportHeightPx && previous.keyboardOpen === keyboardOpen
        ? previous : { viewportHeightPx, keyboardOpen });
    };
    const schedule = () => {
      if (frameId !== null) return;
      frameId = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(applyViewport) : (applyViewport(), null);
    };
    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
      window.removeEventListener("scroll", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      if (frameId !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frameId);
    };
  }, [trackKeyboard]);

  return { viewportHeightPx: state.viewportHeightPx, keyboardOpen: trackKeyboard && state.keyboardOpen };
}
