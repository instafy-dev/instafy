import { useCallback, type MutableRefObject } from "react";
import type { StudioPanel } from "../screens/studio/types";
import type { ConversationState } from "../conversations/ConversationsProvider";
import type { WorkspaceTabState } from "./workspaceTabFactories";
import type {
  PersistedWorkspaceGitReviewState,
  PersistedWorkspaceTabsState,
} from "./workspaceTabPersistence";
import { useWorkspaceTabMutationController } from "./useWorkspaceTabMutationController";
import { useWorkspaceTabOpeners } from "./useWorkspaceTabOpeners";
import { useWorkspaceTabUrlIntents } from "./useWorkspaceTabUrlIntents";

interface UseWorkspaceTabControllerArgs {
  activeConversationId: string | null;
  conversations: ConversationState[];
  createConversation: (options?: { title?: string; select?: boolean }) => ConversationState;
  selectConversation: (conversationId: string) => void;
  markConversationRead: (conversationId: string) => void;
  setActiveFile: (fileId: string | null) => void;
  setActivePanel: (panel: StudioPanel) => void;
  workspaceProjectId: string | null;
  tabsRef: MutableRefObject<WorkspaceTabState[]>;
  activeTabIdRef: MutableRefObject<string | null>;
  activeConversationIdRef: MutableRefObject<string | null>;
  suppressPanelSyncRef: MutableRefObject<StudioPanel | null>;
  urlNavigationModeRef: MutableRefObject<"push" | "replace" | null>;
  persistedStateRef: MutableRefObject<PersistedWorkspaceTabsState | null>;
  persistedGitReviewStateRef: MutableRefObject<PersistedWorkspaceGitReviewState | null>;
  setTabs: (tabs: WorkspaceTabState[]) => void;
  setActiveTabId: (tabId: string | null) => void;
}

export function useWorkspaceTabController({
  activeConversationId,
  conversations,
  createConversation,
  selectConversation,
  markConversationRead,
  setActiveFile,
  setActivePanel,
  workspaceProjectId,
  tabsRef,
  activeTabIdRef,
  activeConversationIdRef,
  suppressPanelSyncRef,
  urlNavigationModeRef,
  persistedStateRef,
  persistedGitReviewStateRef,
  setTabs,
  setActiveTabId,
}: UseWorkspaceTabControllerArgs) {
  const commitTabs = useCallback(
    (nextTabs: WorkspaceTabState[]) => {
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    },
    [setTabs, tabsRef],
  );

  const {
    setActiveTabInternal,
    ensureTabForPanel,
    focusTab,
    closeTab,
    moveTab,
    setTabDirty,
    setPanelTabMeta,
    resetTabs,
  } = useWorkspaceTabMutationController({
    activeConversationId,
    selectConversation,
    markConversationRead,
    setActiveFile,
    setActivePanel,
    workspaceProjectId,
    tabsRef,
    activeTabIdRef,
    activeConversationIdRef,
    suppressPanelSyncRef,
    urlNavigationModeRef,
    persistedStateRef,
    commitTabs,
    setActiveTabId,
  });

  const {
    openConversationTab,
    openJobThreadTab,
    openPanelTab,
    openFileTab,
    openGitDiffTab,
    openGitReviewTab,
    restoreGitReviewTab,
    openExplorerTab,
  } = useWorkspaceTabOpeners({
    activeConversationId,
    conversations,
    createConversation,
    workspaceProjectId,
    tabsRef,
    activeTabIdRef,
    persistedGitReviewStateRef,
    commitTabs,
    setActiveTabInternal,
    ensureTabForPanel,
  });

  const {
    requestUrlNavigation,
    peekUrlNavigation,
    consumeUrlNavigation,
    requestUrlPush,
    consumeUrlPush,
  } = useWorkspaceTabUrlIntents({ urlNavigationModeRef });

  return {
    setActiveTabInternal,
    ensureTabForPanel,
    openConversationTab,
    openJobThreadTab,
    openPanelTab,
    openFileTab,
    openGitDiffTab,
    openGitReviewTab,
    restoreGitReviewTab,
    openExplorerTab,
    focusTab,
    closeTab,
    moveTab,
    setTabDirty,
    setPanelTabMeta,
    resetTabs,
    requestUrlNavigation,
    peekUrlNavigation,
    consumeUrlNavigation,
    requestUrlPush,
    consumeUrlPush,
  };
}
