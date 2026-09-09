import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

type VisibleBounds = { top: number; bottom: number };

function readVisibleBounds(): VisibleBounds {
  const viewport = window.visualViewport;
  const top = Math.max(0, Number.isFinite(viewport?.offsetTop) ? viewport!.offsetTop : 0);
  const height = viewport?.height;
  // VisualViewport already reports CSS pixels, including after pinch zoom.
  return { top, bottom: top + (typeof height === "number" && Number.isFinite(height) && height > 0
    ? height : window.innerHeight) };
}

/** Keep drawer controls visible without shrinking its edge-to-edge painted surface. */
export function useMobileSidebarViewport() {
  const controlsRef = useRef<HTMLDivElement>(null);
  const paddedScrollportRef = useRef<HTMLElement | null>(null);
  const [bounds, setBounds] = useState<VisibleBounds | null>(null);

  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      // Also commit on focus changes with unchanged bounds, so reveal/cleanup
      // runs after the controls' latest viewport style has reached the DOM.
      setBounds(readVisibleBounds());
    };
    const schedule = () => {
      if (frame !== null) return;
      if (typeof window.requestAnimationFrame === "function") frame = window.requestAnimationFrame(update);
      else update();
    };
    update();
    controls.addEventListener("focusin", schedule);
    controls.addEventListener("focusout", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    // Removing a focused input need not dispatch focusout in WebKit. Also
    // recheck after filtering rows changes the focused search's scroll range.
    const observer = new MutationObserver(schedule);
    observer.observe(controls, { childList: true, subtree: true });
    return () => {
      controls.removeEventListener("focusin", schedule);
      controls.removeEventListener("focusout", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      paddedScrollportRef.current?.style.removeProperty("--sidebar-focused-search-space");
      paddedScrollportRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const controls = controlsRef.current;
    const focused = document.activeElement;
    const scrollport = focused instanceof HTMLInputElement && focused.type === "search" && controls?.contains(focused)
      ? focused.closest<HTMLElement>("[data-sidebar-scrollport]") : null;
    if (paddedScrollportRef.current !== scrollport) {
      paddedScrollportRef.current?.style.removeProperty("--sidebar-focused-search-space");
      paddedScrollportRef.current = null;
    }
    if (!scrollport || !(focused instanceof HTMLInputElement) || !controls?.contains(scrollport)) return;
    const portBounds = scrollport.getBoundingClientRect();
    const fieldBounds = focused.getBoundingClientRect();
    if (portBounds.height <= 0 || fieldBounds.height <= 0) return;
    // A filtered search may be the final row. Give it enough real scroll range
    // to sit centrally, clear of floating native keyboard controls, without
    // guessing their OS-specific dimensions or reading/changing the field value.
    scrollport.style.setProperty("--sidebar-focused-search-space", `${Math.max(0, (portBounds.height - fieldBounds.height) / 2)}px`);
    paddedScrollportRef.current = scrollport;
    const delta = fieldBounds.top + fieldBounds.height / 2 - (portBounds.top + portBounds.height / 2);
    scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
  }, [bounds]);

  const top = bounds ? `max(0px, calc(${bounds.top}px - var(--instafy-safe-area-inset-top)))` : undefined;
  const style: CSSProperties | undefined = bounds ? {
    top,
    // The parent's content box already excludes the normal bottom safe area.
    // Intersect it with the visible viewport, preserving safe-area padding and
    // any nonzero visual offset while the backdrop continues to cover the screen.
    height: `max(0px, calc(min(100%, calc(${bounds.bottom}px - var(--instafy-safe-area-inset-top))) - ${top}))`,
  } : undefined;
  return { controlsRef, style };
}
