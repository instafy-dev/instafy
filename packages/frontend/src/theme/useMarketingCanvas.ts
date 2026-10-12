import { useEffect } from "react";

export const MARKETING_CANVAS_CLASS = "marketing-canvas";

// Mounted pages that asked for the paper canvas. Counted, so a route change
// between two marketing pages (or a StrictMode remount) never drops the class
// while one of them is still on screen.
let holders = 0;

/**
 * Paints the document (html and body) in the marketing paper canvas while the
 * calling page is mounted, so overscroll and rubber-band areas match the page
 * instead of flashing the app's white body. See tailwind.css.
 */
export function useMarketingCanvas(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    holders += 1;
    document.documentElement.classList.add(MARKETING_CANVAS_CLASS);
    return () => {
      holders = Math.max(0, holders - 1);
      if (holders === 0) document.documentElement.classList.remove(MARKETING_CANVAS_CLASS);
    };
  }, [enabled]);
}
