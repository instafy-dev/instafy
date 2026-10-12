import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";

// Whether the example window shows the conversation and its resource side by
// side. The studio splits when the panel is at least 1024px wide
// (ConversationWorkspaceViews.tsx canSplit). The window is 1104px wide from a
// 1184px viewport (the landing's 74rem content), and with the studio's
// collapsed 64px rail its workspace is then 1038px: a real split. Narrower
// windows show one view at a time, as the studio does.
// Written in rem, as the window's own 74rem breakpoints are
// (landingStudioChrome.ts, LandingHero.tsx), so the split and the window's
// fit always switch together, whatever the browser's default font size.
export const LANDING_SPLIT_QUERY = "(min-width: 74rem)";

/** "single" forces one view at every width (the dev panel's review switch). */
export type LandingLayoutOverride = "single" | null;

const listeners = new Set<() => void>();
let override: LandingLayoutOverride = readOverrideParam();

function readOverrideParam(): LandingLayoutOverride {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("deck-layout") === "single" ? "single" : null;
  } catch {
    return null;
  }
}

/** Dev builds only (the Cub playground): show one view at every width, or the studio's own rule again. */
export function setLandingLayoutOverride(next: LandingLayoutOverride): void {
  if (!import.meta.env.DEV || next === override) return;
  override = next;
  listeners.forEach((listener) => listener());
}

export function getLandingLayoutOverride(): LandingLayoutOverride {
  return override;
}

export function subscribeLandingLayoutOverride(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function subscribeSplit(listener: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(LANDING_SPLIT_QUERY);
  query.addEventListener?.("change", listener);
  return () => query.removeEventListener?.("change", listener);
}

function readSplit(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(LANDING_SPLIT_QUERY).matches;
}

/** The window shows the conversation and its resource side by side. */
export function useLandingSplit(): boolean {
  const wide = useSyncExternalStore(subscribeSplit, readSplit, () => false);
  const forced = useSyncExternalStore(subscribeLandingLayoutOverride, getLandingLayoutOverride, () => null);
  return wide && forced !== "single";
}

/**
 * The CSS variable the window's split height reads (landingStudioChrome.ts
 * FRAME): the window's top in the document, in px.
 */
export const LANDING_DECK_TOP_VAR = "--landing-deck-top";

/**
 * Keeps LANDING_DECK_TOP_VAR on the window equal to its top in the document,
 * so from 1184px the window fits the first view: its height is the viewport
 * less that top and a 16px margin, between 19rem and its full 47rem. The top
 * does not depend on the window's own height, so this settles at once; it is
 * measured before the first paint and again when the page above it reflows
 * (a resize, a web font swapping in). The height is fixed for a viewport, so
 * no beat or scenario ever changes it.
 */
export function useLandingDeckFit(frameRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof window === "undefined") return;
    let last = "";
    const update = () => {
      const top = `${Math.round(frame.getBoundingClientRect().top + window.scrollY)}px`;
      if (top === last) return;
      last = top;
      frame.style.setProperty(LANDING_DECK_TOP_VAR, top);
    };
    update();
    window.addEventListener("resize", update);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", update);
    let observer: ResizeObserver | null = null;
    // Whatever lies above the window in the hero (the copy, the chips) moves it.
    const above = frame.closest("[data-landing-deck-host]")?.previousElementSibling ?? null;
    if (above && typeof ResizeObserver === "function") {
      observer = new ResizeObserver(update);
      observer.observe(above);
    }
    return () => {
      window.removeEventListener("resize", update);
      fonts?.removeEventListener?.("loadingdone", update);
      observer?.disconnect();
    };
  }, [frameRef]);
}
