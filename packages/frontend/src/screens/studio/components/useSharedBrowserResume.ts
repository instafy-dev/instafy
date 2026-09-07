import { useCallback, useEffect, useMemo, useRef } from "react";
import { parseSharedBrowserResumeTarget, replaceSharedBrowserResumeRuntime } from "./sharedBrowserResume";

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
