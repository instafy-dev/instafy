import type { LeftDrawerPanel } from "./useStudioLayoutChromeState";

export type FilesPanelMobileView = "tree" | "viewer";

interface ResolveStudioFilesMobileViewChangeParams {
  isLargeScreen: boolean;
  leftDrawer: LeftDrawerPanel | null;
  preferredView: FilesPanelMobileView;
  requestedView: FilesPanelMobileView;
}

interface StudioFilesMobileViewChange {
  preferredView: FilesPanelMobileView;
  shouldCloseExplorer: boolean;
}

interface ResolveStudioFilesMobileViewParams {
  isLargeScreen: boolean;
  leftDrawer: LeftDrawerPanel | null;
  preferredView: FilesPanelMobileView;
}

export function resolvePreferredFilesMobileViewForExplorerOpen({
  isLargeScreen,
  preferredView,
}: {
  isLargeScreen: boolean;
  preferredView: FilesPanelMobileView;
}): FilesPanelMobileView {
  return isLargeScreen ? preferredView : "viewer";
}

export function resolveStudioFilesMobileView({
  isLargeScreen,
  leftDrawer,
  preferredView,
}: ResolveStudioFilesMobileViewParams): FilesPanelMobileView {
  if (!isLargeScreen && leftDrawer === "files") {
    return "tree";
  }
  return preferredView;
}

export function resolveStudioFilesMobileViewChange({
  isLargeScreen,
  leftDrawer,
  preferredView,
  requestedView,
}: ResolveStudioFilesMobileViewChangeParams): StudioFilesMobileViewChange {
  if (isLargeScreen) {
    return { preferredView, shouldCloseExplorer: false };
  }
  if (requestedView === "tree") {
    return {
      preferredView: leftDrawer === "files" ? preferredView : "tree",
      shouldCloseExplorer: false,
    };
  }
  return {
    preferredView: "viewer",
    shouldCloseExplorer: leftDrawer === "files",
  };
}
