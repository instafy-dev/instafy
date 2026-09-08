import { useCallback, useRef, type MutableRefObject } from "react";
import {
  consumeWorkspaceUrlNavigation,
  consumeWorkspaceUrlPush,
  requestWorkspaceUrlNavigation,
  type WorkspaceUrlNavigationMode,
} from "./workspaceTabUrlIntents";

interface UseWorkspaceTabUrlIntentsArgs {
  urlNavigationModeRef: MutableRefObject<WorkspaceUrlNavigationMode>;
}

export function useWorkspaceTabUrlIntents({
  urlNavigationModeRef,
}: UseWorkspaceTabUrlIntentsArgs) {
  const sourceEntryRef = useRef<unknown>(undefined);
  const requestUrlNavigation = useCallback(
    (mode: "push" | "replace" = "push") => {
      urlNavigationModeRef.current = requestWorkspaceUrlNavigation(mode);
      sourceEntryRef.current = typeof window === "undefined" ? undefined : window.history.state?.key;
    },
    [urlNavigationModeRef],
  );

  const peekUrlNavigation = useCallback(() => {
    // Legacy tab mutations can request a URL commit. That request only owns
    // its source entry: a direct link or Back/Forward supersedes it immediately,
    // even before React Router publishes the new location.
    if (typeof window !== "undefined" && sourceEntryRef.current !== window.history.state?.key) {
      urlNavigationModeRef.current = null;
    }
    return urlNavigationModeRef.current;
  }, [urlNavigationModeRef]);

  const consumeUrlNavigation = useCallback(() => {
    const { mode, nextMode } = consumeWorkspaceUrlNavigation(peekUrlNavigation());
    urlNavigationModeRef.current = nextMode;
    return mode;
  }, [peekUrlNavigation, urlNavigationModeRef]);

  const requestUrlPush = useCallback(() => {
    requestUrlNavigation("push");
  }, [requestUrlNavigation]);

  const consumeUrlPush = useCallback(() => {
    const { pushed, nextMode } = consumeWorkspaceUrlPush(peekUrlNavigation());
    urlNavigationModeRef.current = nextMode;
    return pushed;
  }, [peekUrlNavigation, urlNavigationModeRef]);

  return {
    requestUrlNavigation,
    peekUrlNavigation,
    consumeUrlNavigation,
    requestUrlPush,
    consumeUrlPush,
  };
}
