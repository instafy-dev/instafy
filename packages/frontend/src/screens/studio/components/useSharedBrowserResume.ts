import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getStudioVisitKey } from "../../../navigation/studioVisit";
import { parseSharedBrowserResumeTarget, replaceSharedBrowserResumeRuntime } from "./sharedBrowserResume";

export function useSharedBrowserResumeSearchReplacement() {
  const location = useLocation();
  const navigate = useNavigate();
  const index = window.history.state?.idx;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useCallback((search: string) => {
    // Session resolution is asynchronous. It may canonicalize only the exact
    // still-visible visit, including before Router renders a newer navigation.
    if (!mounted.current || search === location.search ||
        (window.history.state?.key ?? "default") !== location.key || window.history.state?.idx !== index ||
        window.location.pathname !== location.pathname || window.location.search !== location.search ||
        window.location.hash !== location.hash) return;
    const state = location.state && typeof location.state === "object" && !Array.isArray(location.state)
      ? location.state : {};
    void navigate({ pathname: location.pathname, search, hash: location.hash }, {
      replace: true,
      state: { ...state, instafyVisitKey: getStudioVisitKey(location) },
    });
  }, [index, location, navigate]);
}

export function useSharedBrowserResume(options: {
  search: string;
  projectId: string | null;
  userId: string | null;
  ready: boolean;
  onResume: (runtimeId: string) => void;
  onReplaceSearch: (search: string) => void;
}) {
  const { search, projectId, userId, ready, onResume, onReplaceSearch } = options;
  const target = useMemo(() => parseSharedBrowserResumeTarget(search), [search]);
  const handled = useRef<string | null>(null);
  const acknowledgedNavigation = useRef<string | null>(null);
  const runtimeId = target?.projectId === projectId ? target.runtimeId : null;
  const identity = runtimeId && userId ? `${userId}:${projectId}:${runtimeId}` : null;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    if (!identity) { handled.current = null; acknowledgedNavigation.current = null; return; }
    if (acknowledgedNavigation.current === identity) {
      // Updating our own locator records the active choice; it must not reopen
      // or expand a browser the user has since closed.
      handled.current = identity;
      acknowledgedNavigation.current = null;
      return;
    }
    if (identity !== handled.current) acknowledgedNavigation.current = null;
    if (!ready || !runtimeId || handled.current === identity) return;
    handled.current = identity;
    onResume(runtimeId);
  }, [identity, onResume, ready, runtimeId]);
  const acknowledgeRuntimeResolved = useCallback((resolvedRuntimeId: string | null) => {
    if (!identity || identityRef.current !== identity || !projectId || !resolvedRuntimeId) return;
    const nextSearch = replaceSharedBrowserResumeRuntime(search, projectId, resolvedRuntimeId);
    if (!nextSearch) return;
    const nextTarget = parseSharedBrowserResumeTarget(nextSearch)!;
    acknowledgedNavigation.current = `${userId}:${projectId}:${nextTarget.runtimeId}`;
    onReplaceSearch(nextSearch);
  }, [identity, onReplaceSearch, projectId, search, userId]);
  return { runtimeId, acknowledgeRuntimeResolved };
}
