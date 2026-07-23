export type WorkspaceUrlNavigationMode = "push" | "replace" | null;

export function requestWorkspaceUrlNavigation(mode: "push" | "replace" = "push") {
  return mode;
}

export function consumeWorkspaceUrlNavigation(mode: WorkspaceUrlNavigationMode) {
  return {
    mode,
    nextMode: null as WorkspaceUrlNavigationMode,
  };
}

export function consumeWorkspaceUrlPush(mode: WorkspaceUrlNavigationMode) {
  return {
    pushed: mode === "push",
    nextMode: null as WorkspaceUrlNavigationMode,
  };
}
