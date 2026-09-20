import { useCallback, useLayoutEffect, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

export interface StudioHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/** Read only the browser's Router entry, not a parallel list of destinations.
 * Undefined means a valid entry awaiting Router; null means invalid state. */
function currentRouterIndex(locationKey: string): number | null | undefined {
  const state = window.history.state as { idx?: unknown; key?: unknown } | null;
  if (!state || typeof state.idx !== "number" || !Number.isSafeInteger(state.idx) || state.idx < 0) return null;
  return (state.key ?? "default") === locationKey ? state.idx : undefined;
}

/** Keep the owner mounted across conditional controls/sheets. A reload or owner
 * remount cannot discover forward history without navigating it, so Forward
 * stays disabled until this owner has visited the later entry. This hook only
 * navigates Studio's Router history; it does not intercept platform keys. */
export function useStudioHistory(): StudioHistory {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const index = currentRouterIndex(location.key);
  const [knownHistory, setKnownHistory] = useState({ index: index ?? null, head: index ?? null });
  useLayoutEffect(() => {
    // Context updates can render before Router publishes the browser's new
    // entry. Keep the last resolved presentation during that interval; it is
    // not a direct entry with no history. Actions still reject stale entries.
    if (index == null) return;
    setKnownHistory((previous) => {
      const head = navigationType === "PUSH" ? index : Math.max(previous.head ?? index, index);
      return previous.index === index && previous.head === head ? previous : { index, head };
    });
  }, [index, location.key, navigationType]);

  const displayedIndex = index === undefined ? knownHistory.index : index;
  const canGoBack = displayedIndex !== null && displayedIndex > 0;
  const canGoForward = displayedIndex !== null && knownHistory.head !== null && displayedIndex < knownHistory.head;
  const move = useCallback((delta: -1 | 1) => {
    // The browser entry can change before Router publishes it. Never apply a
    // stale control's action to another entry during that hydration interval.
    if (index == null || currentRouterIndex(location.key) !== index) return;
    if (delta < 0 ? canGoBack : canGoForward) void navigate(delta);
  }, [canGoBack, canGoForward, index, location.key, navigate]);
  const goBack = useCallback(() => move(-1), [move]);
  const goForward = useCallback(() => move(1), [move]);

  return { canGoBack, canGoForward, goBack, goForward };
}
