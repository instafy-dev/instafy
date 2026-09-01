import { useEffect, useState } from "react";

type BreakpointKey = "sm" | "md" | "lg" | "xl" | "2xl";

const BREAKPOINT_VALUES: Record<BreakpointKey, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536
};

export function useBreakpoint(minBreakpoint: BreakpointKey): boolean {
  const minWidth = BREAKPOINT_VALUES[minBreakpoint];
  // matchMedia can be absent (jsdom, stripped-down webviews); fall back to
  // "not matched" — the mobile-first presentation — instead of throwing.
  const canMatch = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function";
  const getMatches = () =>
    canMatch() ? window.matchMedia(`(min-width: ${minWidth}px)`).matches : false;

  const [matches, setMatches] = useState<boolean>(getMatches);

  useEffect(() => {
    if (!canMatch()) {
      return;
    }
    const mediaQuery = window.matchMedia(`(min-width: ${minWidth}px)`);
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setMatches(event.matches);
    };

    handleChange(mediaQuery);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [minWidth]);

  return matches;
}
