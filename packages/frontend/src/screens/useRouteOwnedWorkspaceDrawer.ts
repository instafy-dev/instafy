import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { StudioHistory } from "../navigation/useStudioHistory";
import { getStudioVisitKey } from "../navigation/studioVisit";
import { useNativeBackButtonAction } from "../native/useNativeBackButtonAction";

/** A desktop workspace drawer URL can also be displayed on mobile. It is an
 * existing destination, not a history-owned mobile sidebar/drill-in entry. */
export function useRouteOwnedWorkspaceDrawer({
  enabled,
  history,
}: {
  enabled: boolean;
  history: Pick<StudioHistory, "canGoBack" | "goBack">;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const index = window.history.state?.idx;
  const active = enabled && new URLSearchParams(location.search).get("workspaceTab") === "workspaces";
  const latest = useRef({ active, location, index });
  latest.current = { active, location, index };
  const mounted = useRef(false);
  const dismissedEntry = useRef<string | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const dismiss = useCallback(() => {
    const current = latest.current;
    if (!mounted.current || !active || !current.active ||
        current.location.key !== location.key || current.index !== index ||
        (window.history.state?.key ?? "default") !== location.key ||
        window.history.state?.idx !== index ||
        window.location.pathname !== location.pathname ||
        window.location.search !== location.search || window.location.hash !== location.hash) return;
    // Native Back and a close press may arrive before Router publishes a POP.
    // Only one dismissal may act on this exact entry.
    const entry = JSON.stringify([location.key, index, location.pathname, location.search, location.hash]);
    if (dismissedEntry.current === entry) return;
    dismissedEntry.current = entry;
    if (history.canGoBack) {
      history.goBack();
      return;
    }
    const params = new URLSearchParams(location.search);
    params.delete("workspaceTab");
    const state = location.state && typeof location.state === "object" && !Array.isArray(location.state)
      ? location.state : {};
    void navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, {
      replace: true,
      state: { ...state, instafyVisitKey: getStudioVisitKey(location) },
    });
  }, [active, history, index, location, navigate]);

  // A later visit (including Forward to this same entry) can be dismissed
  // again, while resize alone never writes or adds a history entry.
  useLayoutEffect(() => { dismissedEntry.current = null; }, [active, location.key]);
  useNativeBackButtonAction(active, dismiss, 10);
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, dismiss]);

  return { dismiss };
}
