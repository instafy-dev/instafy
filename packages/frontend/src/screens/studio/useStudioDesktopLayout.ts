import { useEffect, useState } from "react";

export const STUDIO_DESKTOP_LAYOUT_MIN_WIDTH_PX = 900;

export function useStudioDesktopLayout(): boolean {
  const getMatches = () =>
    typeof window !== "undefined"
      ? window.matchMedia(`(min-width: ${STUDIO_DESKTOP_LAYOUT_MIN_WIDTH_PX}px)`).matches
      : false;

  const [matches, setMatches] = useState<boolean>(getMatches);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(`(min-width: ${STUDIO_DESKTOP_LAYOUT_MIN_WIDTH_PX}px)`);
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
  }, []);

  return matches;
}
