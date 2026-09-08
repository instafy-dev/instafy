import { useCallback, useLayoutEffect, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

export interface StudioHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/** Read only the current Router entry, not a parallel list of destinations. */
function currentRouterIndex(locationKey: string): number | null {
  const state = window.history.state as { idx?: unknown; key?: unknown } | null;
  if (!state || (state.key ?? "default") !== locationKey) return null;
  return typeof state.idx === "number" && Number.isSafeInteger(state.idx) && state.idx >= 0
    ? state.idx : null;
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
  const [knownHead, setKnownHead] = useState<number | null>(index);
  useLayoutEffect(() => {
    setKnownHead((previous) => index === null ? null : navigationType === "PUSH"
      ? index : Math.max(previous ?? index, index));
  }, [index, location.key, navigationType]);

  const canGoBack = index !== null && index > 0;
  const canGoForward = index !== null && knownHead !== null && index < knownHead;
  const move = useCallback((delta: -1 | 1) => {
    // The browser entry can change before Router publishes it. Never apply a
    // stale control's action to another entry during that hydration interval.
    if (index === null || currentRouterIndex(location.key) !== index) return;
    if (delta < 0 ? canGoBack : canGoForward) void navigate(delta);
  }, [canGoBack, canGoForward, index, location.key, navigate]);
  const goBack = useCallback(() => move(-1), [move]);
  const goForward = useCallback(() => move(1), [move]);

  return { canGoBack, canGoForward, goBack, goForward };
}
