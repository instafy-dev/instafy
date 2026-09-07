import { type CSSProperties, useLayoutEffect, useState } from "react";

type VisibleBounds = { height: number; top: number };

function readVisibleBounds(): VisibleBounds {
  const viewport = window.visualViewport;
  const height = viewport?.height;
  const top = viewport?.offsetTop;
  // VisualViewport reports CSS pixels already; applying devicePixelRatio or
  // its pinch scale again would count the adjustment twice.
  return {
    height: Math.max(1, Math.round(typeof height === "number" && Number.isFinite(height) && height > 0
      ? height : window.innerHeight)),
    top: Math.max(0, Math.round(typeof top === "number" && Number.isFinite(top) ? top : 0)),
  };
}

/** The expanded portal cannot inherit the Studio root's keyboard-aware height. */
export function useExpandedBrowserViewport(active: boolean): CSSProperties | undefined {
  const [bounds, setBounds] = useState<VisibleBounds | null>(null);

  useLayoutEffect(() => {
    if (!active || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const next = readVisibleBounds();
      setBounds((previous) => previous?.height === next.height && previous.top === next.top ? previous : next);
    };
    const schedule = () => {
      if (frame !== null) return;
      if (typeof window.requestAnimationFrame === "function") frame = window.requestAnimationFrame(update);
      else update();
    };
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [active]);

  return active && bounds ? { height: bounds.height, top: bounds.top, bottom: "auto" } : undefined;
}
