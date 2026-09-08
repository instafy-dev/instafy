import { useTouchLikeInput } from "../../hooks/useTouchLikeInput";
import { useStudioDesktopLayout } from "./useStudioDesktopLayout";
import type { WorkspaceTabState } from "../../workspace/workspaceTabFactories";
import type { LeftDrawerPanel } from "../useStudioLayoutChromeState";

export type MobileOverviewSection = "home" | "chat" | "projects";

/** Only section overviews own a bottom destination bar. A conversation (even
 * an empty one), editor or settings detail keeps its content/composer space. */
export function resolveMobileOverviewSection(
  activeTab: WorkspaceTabState | null,
  leftDrawer: LeftDrawerPanel | null,
): MobileOverviewSection | null {
  if (leftDrawer) return leftDrawer === "history" ? "chat" : null;
  if (activeTab?.kind !== "panel") return null;
  return activeTab.panel === "home" || activeTab.panel === "projects" ? activeTab.panel : null;
}

export function useStudioNavigationPosture() {
  const isLargeScreen = useStudioDesktopLayout();
  const touchLikeInput = useTouchLikeInput();

  // Preserve the existing compact mouse-window control. Touch layouts use
  // the focused header and keep navigation out of the composer.
  const showComposerNavigationButton = !isLargeScreen && !touchLikeInput;
  const showTouchBottomDock = touchLikeInput && !isLargeScreen;
  // This is layout eligibility, not dock visibility: only overview surfaces
  // render it. Conversations use their header and keep the composer unchanged.
  const showComposerHomeButton = false;
  const showTopbarHomeButton = false;

  return {
    isLargeScreen,
    touchLikeInput,
    showComposerNavigationButton,
    showTouchBottomDock,
    showComposerHomeButton,
    showTopbarHomeButton,
  };
}
