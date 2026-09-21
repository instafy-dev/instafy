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

export type WorkspaceEmptyState = "hydrating" | "empty" | null;

/** With no active tab the workspace is either still hydrating the destination
 * space's conversation tabs (the provider tears every chat tab down on a
 * project switch and rebuilds them once history resolves) or genuinely empty.
 * Only the second case earns user-facing copy; the first paints a quiet frame
 * so a fresh space never flashes "Open a panel to get started." */
export function resolveWorkspaceEmptyState(input: {
  hasActiveTab: boolean;
  conversationTabsReady: boolean;
  projectAccessBlocked: boolean;
}): WorkspaceEmptyState {
  if (input.hasActiveTab || input.projectAccessBlocked) return null;
  return input.conversationTabsReady ? "empty" : "hydrating";
}

export function useStudioNavigationPosture() {
  const isLargeScreen = useStudioDesktopLayout();
  const touchLikeInput = useTouchLikeInput();

  // Both compact postures use the same header. Mouse windows also retain the
  // composer shortcut; touch keeps navigation out of the composer.
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
