import { useLayoutEffect, useRef } from "react";
import { useVisualViewportBounds } from "../../hooks/useVisualViewportBounds";
import { readStudioSafeAreaInsets } from "../../utils/floatingSurfacePosition";

const EDITABLE = "input, textarea, select";

/** Login keeps the document as its only scroll owner, including above a software keyboard. */
export function useLoginViewport(enabled: boolean, step: string, error: string | null) {
  const pageRef = useRef<HTMLDivElement>(null);
  const lastFieldRef = useRef<HTMLElement | null>(null);
  const bounds = useVisualViewportBounds(enabled);
  const compact = bounds.height <= 560;
  // Visual-only keyboard resizing leaves the document viewport tall. Add real
  // scroll range below the page so even its last field/action can be revealed.
  const obscuredHeight = Math.max(0, window.innerHeight - bounds.height);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!enabled || !page) return;
    let frame: number | null = null;
    const reveal = () => {
      frame = null;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !page.contains(active)) return;
      const previous = lastFieldRef.current;
      const field = active.matches(EDITABLE) ? active
        : previous && page.contains(previous) && previous.closest("form") === active.closest("form") ? previous : null;
      if (!field) return;
      lastFieldRef.current = field;
      const rect = field.getBoundingClientRect();
      if (rect.height <= 0) return;
      const insets = readStudioSafeAreaInsets();
      const top = bounds.top + insets.top + 12;
      const bottom = bounds.top + bounds.height - insets.bottom - 12;
      const form = field.closest("form");
      const submit = form?.querySelector<HTMLElement>('button[type="submit"]')?.getBoundingClientRect();
      const notice = form?.querySelector<HTMLElement>('[role="alert"]')?.getBoundingClientRect();
      let first = rect.top;
      let last = rect.bottom;
      // Prefer the whole task when it fits; in very short landscape viewports,
      // keep the focused field visible and let the rest scroll normally.
      if (submit && submit.bottom - first <= bottom - top) last = Math.max(last, submit.bottom);
      if (notice && last - Math.min(first, notice.top) <= bottom - top) first = Math.min(first, notice.top);
      const delta = first < top || rect.height > bottom - top
        ? first - top : last > bottom ? last - bottom : 0;
      if (delta) window.scrollBy(0, delta);
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (typeof window.requestAnimationFrame === "function") frame = window.requestAnimationFrame(reveal);
      else reveal();
    };
    reveal();
    page.addEventListener("focusin", schedule);
    return () => {
      page.removeEventListener("focusin", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [bounds.height, bounds.width, bounds.top, bounds.left, enabled, step, error]);

  return { pageRef, compact, visibleHeight: bounds.height, obscuredHeight };
}
