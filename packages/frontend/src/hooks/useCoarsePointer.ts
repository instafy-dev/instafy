import { useEffect, useState } from "react";

// Tailwind's `pointer-coarse:` variant is `@media (pointer: coarse)`. Layout
// that flips there in CSS and needs the same answer in JS — a pixel cap that
// folds in a pointer-dependent padding, say — reads this hook so both agree.
export const COARSE_POINTER_MEDIA_QUERY = "(pointer: coarse)";

export function useCoarsePointer(): boolean {
  // matchMedia can be absent (jsdom, stripped-down webviews); fall back to
  // "fine" — the pointer the desktop density is designed for — instead of
  // throwing.
  const canMatch = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function";
  const getMatches = () =>
    canMatch() ? window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches : false;

  const [matches, setMatches] = useState<boolean>(getMatches);

  useEffect(() => {
    if (!canMatch()) {
      return;
    }
    const mediaQuery = window.matchMedia(COARSE_POINTER_MEDIA_QUERY);
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
