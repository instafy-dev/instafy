import { Capacitor } from "@capacitor/core";
import { useLayoutEffect, useState } from "react";
import { isNativeKeyboardViewportOpen } from "../utils/keyboardViewport";
import { resolveStudioViewportHeightPx, shouldResetStudioDocumentScroll } from "./studioViewport";

/**
 * How long a `keyboardWillShow` height stands in for geometry. The iPhone app's
 * keyboard plugin (`resize: "native"`) shrinks the web view only after the
 * keyboard's own animation and another 0.2 s, so the web view catches up well
 * within this; after it, measured geometry decides alone, even if the web view
 * never resized.
 */
export const NATIVE_KEYBOARD_LEAD_MS = 1200;

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

function runsInIosApp(): boolean {
  try {
    return Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
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
    // The height the iPhone keyboard announced as it started to open, until
    // the web view's own resize, which the plugin delays, has caught up.
    let announcedKeyboard: { height: number; at: number } | null = null;
    let announcedKeyboardExpiry: ReturnType<typeof setTimeout> | null = null;

    const applyViewport = () => {
      frameId = null;
      // Preserve Studio's existing WKWebView page-pan correction. The document
      // is overflow-locked; the transcript/drawers own their own scroll positions.
      if (shouldResetStudioDocumentScroll(window.scrollX, window.scrollY)) window.scrollTo(0, 0);
      let height = viewport?.height ?? window.innerHeight;
      if (!trackKeyboard) keyboardOpen = false;
      else {
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
          const closedBaseline = closedHeights.get(key);
          if (
            announcedKeyboard !== null && closedBaseline !== undefined &&
            Date.now() - announcedKeyboard.at < NATIVE_KEYBOARD_LEAD_MS
          ) {
            // Take the room the keyboard is about to cover now, not when the
            // web view shrinks. A keyboard that grows moves the Studio at once;
            // one that shrinks waits for the web view, so nothing is cut off.
            const announcedHeight = closedBaseline - offsetTop - announcedKeyboard.height;
            if (announcedHeight > 0 && announcedHeight < height) height = announcedHeight;
          }
          const visibleHeight = Math.max(window.innerHeight, height + offsetTop);
          const closedHeight = closedBaseline ?? visibleHeight;
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
      const viewportHeightPx = resolveStudioViewportHeightPx(height);
      setState(previous => previous.viewportHeightPx === viewportHeightPx && previous.keyboardOpen === keyboardOpen
        ? previous : { viewportHeightPx, keyboardOpen });
    };
    const schedule = () => {
      if (frameId !== null) return;
      frameId = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(applyViewport) : (applyViewport(), null);
    };
    const clearAnnouncedKeyboardExpiry = () => {
      if (announcedKeyboardExpiry !== null) clearTimeout(announcedKeyboardExpiry);
      announcedKeyboardExpiry = null;
    };
    // @capacitor/keyboard sends these as window events from the iPhone app,
    // `keyboardWillShow` with the keyboard's height, as the keyboard starts to move.
    const onKeyboardWillShow = (event: Event) => {
      const height = Number((event as Event & { keyboardHeight?: unknown }).keyboardHeight);
      announcedKeyboard = Number.isFinite(height) && height > 0 ? { height, at: Date.now() } : null;
      clearAnnouncedKeyboardExpiry();
      if (announcedKeyboard !== null) {
        announcedKeyboardExpiry = setTimeout(() => {
          announcedKeyboardExpiry = null;
          schedule();
        }, NATIVE_KEYBOARD_LEAD_MS);
      }
      schedule();
    };
    const onKeyboardWillHide = () => {
      announcedKeyboard = null;
      clearAnnouncedKeyboardExpiry();
      schedule();
    };
    const followsAnnouncedKeyboard = trackKeyboard && runsInIosApp();
    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    if (followsAnnouncedKeyboard) {
      window.addEventListener("keyboardWillShow", onKeyboardWillShow);
      window.addEventListener("keyboardWillHide", onKeyboardWillHide);
    }
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
      window.removeEventListener("scroll", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("keyboardWillShow", onKeyboardWillShow);
      window.removeEventListener("keyboardWillHide", onKeyboardWillHide);
      clearAnnouncedKeyboardExpiry();
      if (frameId !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frameId);
    };
  }, [trackKeyboard]);

  return { viewportHeightPx: state.viewportHeightPx, keyboardOpen: trackKeyboard && state.keyboardOpen };
}
