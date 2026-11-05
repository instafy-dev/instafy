import { useSyncExternalStore } from "react";

/** The media shell and its gesture controls must choose the same presentation. */
export const STUDIO_MEDIA_IMMERSIVE_QUERY = "(max-width: 767px), (pointer: coarse) and (max-height: 500px)";

const canMatch = () => typeof window !== "undefined" && typeof window.matchMedia === "function";
const snapshot = () => canMatch() && window.matchMedia(STUDIO_MEDIA_IMMERSIVE_QUERY).matches;
const inactiveSnapshot = () => false;
const inactiveSubscribe = () => () => {};
const subscribe = (listener: () => void) => {
  if (!canMatch()) return () => {};
  const query = window.matchMedia(STUDIO_MEDIA_IMMERSIVE_QUERY);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  query.addListener(listener);
  return () => query.removeListener(listener);
};

/** Other dialog layouts do not subscribe to media-presentation changes. */
export function useStudioMediaImmersive(enabled = true): boolean {
  return useSyncExternalStore(enabled ? subscribe : inactiveSubscribe, enabled ? snapshot : inactiveSnapshot, inactiveSnapshot);
}
