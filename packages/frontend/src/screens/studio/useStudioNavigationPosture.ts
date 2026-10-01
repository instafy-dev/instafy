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
 * so a fresh space never flashes "Open a panel to get started." A failed
 * history fetch never resolves the scope, so it counts as empty rather than
 * leaving the quiet frame up with nothing to wait for. */
export function resolveWorkspaceEmptyState(input: {
  hasActiveTab: boolean;
  conversationTabsReady: boolean;
  historyError: boolean;
  projectAccessBlocked: boolean;
}): WorkspaceEmptyState {
  if (input.hasActiveTab || input.projectAccessBlocked) return null;
  return input.conversationTabsReady || input.historyError ? "empty" : "hydrating";
}

/** A chat route that is still hydrating is about to open one of the space's
 * chats, so the compact header names a chat and the frame may say it is
 * loading them. Another route waiting with no tab (a settings link while the
 * space's access is checked) is not waiting on chats and stays neutral. */
export function isWorkspaceLoadingChats(emptyState: WorkspaceEmptyState, routedPanel: string): boolean {
  return emptyState === "hydrating" && routedPanel === "chat";
}

export type TopbarLocation = Exclude<LeftDrawerPanel, "workspaces"> | "chat";

/** What the compact header names in place of the active tab: the drawer laid
 * over the workspace, else a chat that is still loading. The drawer wins, so
 * opening Files mid-switch says "Files", not "Chat". The Spaces drawer is
 * never laid over the workspace and names nothing. */
export function resolveTopbarLocation(input: {
  drawerOverlay: LeftDrawerPanel | null;
  loadingChats: boolean;
}): TopbarLocation | null {
  if (input.drawerOverlay && input.drawerOverlay !== "workspaces") return input.drawerOverlay;
  return input.loadingChats ? "chat" : null;
}

export function useStudioNavigationPosture() {
  const isLargeScreen = useStudioDesktopLayout();
  const touchLikeInput = useTouchLikeInput();

  // Compact touch chats return to the Chats overview from the composer.
  // Fine-pointer windows retain their existing navigation drawer shortcut.
  const showComposerNavigationButton = !isLargeScreen;
  const showTouchBottomDock = touchLikeInput && !isLargeScreen;
  // This is layout eligibility, not dock visibility: only overview surfaces
  // render it. Conversations use the existing single-row composer instead.
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
