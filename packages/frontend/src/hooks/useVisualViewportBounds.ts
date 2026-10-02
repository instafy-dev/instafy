import { useLayoutEffect, useState } from "react";

function readBounds() {
  const viewport = window.visualViewport;
  return {
    top: Math.max(0, Number.isFinite(viewport?.offsetTop) ? viewport!.offsetTop : 0),
    left: Math.max(0, Number.isFinite(viewport?.offsetLeft) ? viewport!.offsetLeft : 0),
    width: typeof viewport?.width === "number" && Number.isFinite(viewport.width) && viewport.width > 0
      ? viewport.width : window.innerWidth,
    height: typeof viewport?.height === "number" && Number.isFinite(viewport.height) && viewport.height > 0
      ? viewport.height : window.innerHeight,
  };
}

/** VisualViewport reports CSS pixels already, including after pinch zoom. */
export function useVisualViewportBounds(enabled = true) {
  const [bounds, setBounds] = useState(readBounds);
  useLayoutEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    const update = () => { frame = null; setBounds(readBounds()); };
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
  }, [enabled]);
  return bounds;
}
