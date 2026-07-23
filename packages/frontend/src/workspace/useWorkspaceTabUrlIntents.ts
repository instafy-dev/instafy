import { useCallback, type MutableRefObject } from "react";
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
  const requestUrlNavigation = useCallback(
    (mode: "push" | "replace" = "push") => {
      urlNavigationModeRef.current = requestWorkspaceUrlNavigation(mode);
    },
    [urlNavigationModeRef],
  );

  const peekUrlNavigation = useCallback(() => {
    return urlNavigationModeRef.current;
  }, [urlNavigationModeRef]);

  const consumeUrlNavigation = useCallback(() => {
    const { mode, nextMode } = consumeWorkspaceUrlNavigation(urlNavigationModeRef.current);
    urlNavigationModeRef.current = nextMode;
    return mode;
  }, [urlNavigationModeRef]);

  const requestUrlPush = useCallback(() => {
    requestUrlNavigation("push");
  }, [requestUrlNavigation]);

  const consumeUrlPush = useCallback(() => {
    const { pushed, nextMode } = consumeWorkspaceUrlPush(urlNavigationModeRef.current);
    urlNavigationModeRef.current = nextMode;
    return pushed;
  }, [urlNavigationModeRef]);

  return {
    requestUrlNavigation,
    peekUrlNavigation,
    consumeUrlNavigation,
    requestUrlPush,
    consumeUrlPush,
  };
}
